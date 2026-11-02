// Cloudflare Function: functions/garmin/index.js
// Reads YOUR OWN data from Garmin's official Personal API (read-only).
// Needs the encrypted Cloudflare Pages variable GARMIN_API_KEY (Settings → Variables and Secrets).
//
// POST body: { action: 'status' }                       → checks the key works (gets an access token)
//            { action: 'discover' }                     → returns the API's endpoint list (from Garmin's OpenAPI spec)
//            { action: 'probe', path, query }           → GET one Personal API endpoint, returns status + body
//
// The key never leaves this function. Only GET requests to personal.connectapi.garmin.com are allowed.

const API_HOST = 'https://personal.connectapi.garmin.com';
const TOKEN_URL = API_HOST + '/personalapitoken-service/personal-api/personal-api-key/token';
const DOCS_PAGE = 'https://developer.garmin.com/gc-developer-program/personal/swagger-docs/';

// Access tokens last 24h and there are no refresh tokens. Garmin limits how many tokens can be minted
// (HTTP 429 after ~100), and Cloudflare may start a fresh copy of this function for every request — so
// the token is cached in KV (shared by every copy) as well as in memory, and only re-minted near expiry.
let cachedToken = null;   // { token, expiresAt }
let envRef = null;
const CF_ACCOUNT_ID = '23846f97f2d5dde9557f21aabbc3f3e9';
const KV_NAMESPACE_ID = 'ce44f82dceff46a6bd16563a2f3a3b1c';
const KV_TOKEN_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/garmin_access_token`;
async function kvTokenGet(env) {
  if (!env.CF_API_TOKEN) return null;
  try { const r = await fetch(KV_TOKEN_URL, { headers: { Authorization: 'Bearer ' + env.CF_API_TOKEN } }); if (!r.ok) return null; const j = await r.json(); return j && j.token ? j : null; } catch (e) { return null; }
}
async function kvTokenPut(env, val) {
  if (!env.CF_API_TOKEN) return;
  try { await fetch(KV_TOKEN_URL + '?expiration_ttl=' + Math.max(60, Math.floor((val.expiresAt - Date.now()) / 1000)), { method: 'PUT', headers: { Authorization: 'Bearer ' + env.CF_API_TOKEN, 'Content-Type': 'text/plain' }, body: JSON.stringify(val) }); } catch (e) {}
}
let keyInfo = null;       // { length, trimmed } — reported on failures (never the key itself)

const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

// Paths observed in other Personal API clients (used only if Garmin's spec can't be found)
const KNOWN_ENDPOINTS = [
  { path: '/hrv-service/hrv/{date}', summary: 'HRV for a night', params: ['date*:path:string'], fields: [] },
  { path: '/sleep-service/sleep/dailySleep', summary: 'Daily sleep', params: ['date:query:string'], fields: [] },
  { path: '/weight-service/weight/range/{startDate}/{endDate}', summary: 'Weight range', params: ['startDate*:path:string', 'endDate*:path:string'], fields: [] },
  { path: '/activitylist-service/activities/search/activities', summary: 'Activity search', params: ['limit:query:int'], fields: [] },
];
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers });

async function getToken(env, force) {
  const fresh = t => t && t.expiresAt - Date.now() > 60 * 60 * 1000;
  if (!force && fresh(cachedToken)) return cachedToken.token;
  if (!force) { const kv = await kvTokenGet(env); if (fresh(kv)) { cachedToken = { ...kv, raw: kv.raw || ['cached'] }; return kv.token; } }
  const rawKey = env.GARMIN_API_KEY;
  if (!rawKey) throw new Error('GARMIN_API_KEY is not set in Cloudflare');
  // Pasted secrets often carry a stray space/newline or quotes — strip them
  const key = String(rawKey).trim().replace(/^["']|["']$/g, '').replace(/^ApiKey\s+/i, '');
  keyInfo = { length: key.length, trimmed: key !== rawKey };
  // The token comes back as plain text, so don't demand JSON (Garmin answers 406 if we do)
  const call = () => fetch(TOKEN_URL, { method: 'POST', headers: { 'Authorization': 'ApiKey ' + key, 'Accept': '*/*' } });
  let r = await call();
  if (r.status >= 500) { await new Promise(z => setTimeout(z, 1500)); r = await call(); }   // one retry on server/edge errors
  const text = await r.text();
  if (!r.ok) {
    const err = new Error('Token request failed (HTTP ' + r.status + '): ' + text.slice(0, 300));
    err.status = r.status; err.cfRay = r.headers.get('cf-ray'); err.server = r.headers.get('server');
    try { const j = JSON.parse(text); if (j.retryInSeconds) err.retryIn = j.retryInSeconds; } catch (e) {}
    throw err;
  }
  // Accept either JSON ({access_token,...}), a JSON string ("eyJ..."), or the raw token text
  let data = {}; try { data = JSON.parse(text); } catch (e) { data = { access_token: text.trim() }; }
  if (typeof data === 'string') data = { access_token: data };
  const token = (data.access_token || data.accessToken || data.token || '').trim();
  if (!token) throw new Error('Token response had no access token. Fields: ' + Object.keys(data).join(', '));
  const ttl = Number(data.expires_in || data.expiresIn || 86400);
  cachedToken = { token, expiresAt: Date.now() + ttl * 1000, raw: Object.keys(data).concat(['len ' + token.length]) };
  await kvTokenPut(env, { token, expiresAt: cachedToken.expiresAt, raw: cachedToken.raw });
  return token;
}

// Find Garmin's OpenAPI spec: try the docs page (and the assets it references), then common spec paths on the API host.
async function findSpec(token) {
  const tried = [];
  const tryUrl = async (url, auth) => {
    tried.push(url);
    try {
      const r = await fetch(url, { headers: auth ? { Authorization: 'Bearer ' + token, Accept: 'application/json' } : { Accept: 'application/json,text/html,*/*' } });
      if (!r.ok) return null;
      const t = await r.text();
      try { const j = JSON.parse(t); if (j && (j.paths || j.openapi || j.swagger)) return j; } catch (e) {}
      return t;   // HTML/other — caller may scan it for links
    } catch (e) { return null; }
  };
  const isSpec = x => x && typeof x === 'object' && x.paths;

  // 1. Docs page and anything it links that looks like a spec (json/yaml) or Gatsby page data
  const html = await tryUrl(DOCS_PAGE, false);
  if (typeof html === 'string') {
    const links = new Set();
    (html.match(/["'(]([^"'()\s]+?\.(?:json|ya?ml))["')]/gi) || []).forEach(m => links.add(m.slice(1, -1)));
    links.add('/page-data/gc-developer-program/personal/swagger-docs/page-data.json');
    for (const l of links) {
      const url = l.startsWith('http') ? l : new URL(l, DOCS_PAGE).toString();
      const s = await tryUrl(url, false);
      if (isSpec(s)) return { spec: s, from: url, tried };
      // page-data may embed the spec as a string or object somewhere inside
      if (s && typeof s === 'object') {
        const found = deepFindSpec(s);
        if (found) return { spec: found, from: url + ' (embedded)', tried };
      }
    }
  }
  // 2. Conventional spec locations on the API host
  for (const p of ['/v3/api-docs', '/openapi.json', '/swagger.json', '/api-docs', '/v2/api-docs', '/swagger/v1/swagger.json']) {
    const s = await tryUrl(API_HOST + p, true);
    if (isSpec(s)) return { spec: s, from: API_HOST + p, tried };
  }
  return { spec: null, tried };
}

function deepFindSpec(obj, depth = 0) {
  if (!obj || depth > 8) return null;
  if (typeof obj === 'string' && obj.length > 200 && obj.includes('"paths"')) { try { const j = JSON.parse(obj); if (j.paths) return j; } catch (e) {} }
  if (typeof obj === 'object') {
    if (obj.paths && (obj.openapi || obj.swagger)) return obj;
    for (const k of Object.keys(obj)) { const f = deepFindSpec(obj[k], depth + 1); if (f) return f; }
  }
  return null;
}

// Compact endpoint list: GET paths with parameter names/types and the response schema's top-level fields
function summarizeSpec(spec) {
  const out = [];
  const resolve = ref => ref && ref.startsWith('#/') ? ref.slice(2).split('/').reduce((o, k) => o && o[k], spec) : null;
  for (const [path, ops] of Object.entries(spec.paths || {})) {
    const op = ops.get; if (!op) continue;
    const params = [...(ops.parameters || []), ...(op.parameters || [])].map(p => p.$ref ? resolve(p.$ref) : p).filter(Boolean)
      .map(p => `${p.name}${p.required ? '*' : ''}:${p.in}:${(p.schema && (p.schema.format || p.schema.type)) || p.type || ''}`);
    let fields = [];
    try {
      const resp = (op.responses || {})['200'] || {};
      let sch = resp.content ? (resp.content['application/json'] || Object.values(resp.content)[0] || {}).schema : resp.schema;
      if (sch && sch.$ref) sch = resolve(sch.$ref);
      if (sch && sch.type === 'array' && sch.items) sch = sch.items.$ref ? resolve(sch.items.$ref) : sch.items;
      if (sch && sch.properties) fields = Object.keys(sch.properties).slice(0, 40);
    } catch (e) {}
    out.push({ path, summary: (op.summary || op.operationId || '').slice(0, 80), params, fields });
  }
  return out;
}

// ── Daily wellness for the morning log ──────────────────────────────────────
// Returns one compact record per morning: { date, hrv, hrvStatus, hrvBaseline, sleepHrs, sleepScore, rhr, weightKg }
// Dates are the morning a night ENDS on (Garmin's calendarDate), matching the app's morning log.
async function gget(token, path) {
  const url = API_HOST + path;
  let r = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
  if (r.status === 401 && envRef) { token = await getToken(envRef, true); r = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } }); }
  if (r.status === 406) r = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: '*/*' } });
  if (!r.ok) return { status: r.status, data: null };
  try { return { status: r.status, data: JSON.parse(await r.text()) }; } catch (e) { return { status: r.status, data: null }; }
}
function deepFind(obj, re, depth = 0) {           // first numeric value whose key matches re
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  for (const [k, v] of Object.entries(obj)) if (re.test(k) && typeof v === 'number' && v > 0) return v;
  for (const v of Object.values(obj)) { const f = deepFind(v, re, depth + 1); if (f != null) return f; }
  return null;
}
function addDays(ds, n) { const d = new Date(ds + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
// Candidate resting-HR endpoints (the Personal API's exact one isn't documented publicly yet)
const RHR_CANDIDATES = [
  d => '/usersummary-service/usersummary/daily?calendarDate=' + d,
  d => '/wellness-service/wellness/dailyHeartRate?date=' + d,
];
// Garmin limits TOTAL API requests (~100 per window), so ranges are fetched in as few calls as
// possible: HRV/sleep/steps have range endpoints (≤28 days per call). Which endpoints work is
// remembered in KV ("garmin_caps") so dead ones aren't retried. Per-day fallback is capped at 3 days.
const KV_CAPS_URL = KV_TOKEN_URL.replace('garmin_access_token', 'garmin_caps');
async function capsGet(env) { if (!env.CF_API_TOKEN) return {}; try { const r = await fetch(KV_CAPS_URL, { headers: { Authorization: 'Bearer ' + env.CF_API_TOKEN } }); return r.ok ? await r.json() : {}; } catch (e) { return {}; } }
async function capsPut(env, caps) { if (!env.CF_API_TOKEN) return; try { await fetch(KV_CAPS_URL, { method: 'PUT', headers: { Authorization: 'Bearer ' + env.CF_API_TOKEN, 'Content-Type': 'text/plain' }, body: JSON.stringify(caps) }); } catch (e) {} }
function chunks(start, end, size = 28) { const out = []; for (let s = start; s <= end; s = addDays(s, size)) { const e = addDays(s, size - 1) < end ? addDays(s, size - 1) : end; out.push([s, e]); } return out; }
const rows = d => Array.isArray(d) ? d : d ? (d.hrvSummaries || d.individualStats || d.values || d.dailySleepDTOList || d.allDayHeartRate || []) : [];

async function dailyWellness(token, endDate, days, env) {
  const startDate = addDays(endDate, -(days - 1));
  const caps = await capsGet(env); let capsChanged = false;
  const recs = {}; const rec = d => recs[d] || (recs[d] = { date: d });
  const notes = { requests: 0, rateLimited: false };
  const get = async path => { notes.requests++; const r = await gget(token, path); if (r.status === 429) notes.rateLimited = true; return r; };
  const tryRange = async (key, pathFor, parse) => {
    if (caps[key] === false) return false;
    let worked = false;
    for (const [s, e] of chunks(startDate, endDate)) {
      const r = await get(pathFor(s, e));
      if (r.status === 429) return worked;
      if (!r.data) { if (!worked && [400, 404, 405].includes(r.status)) { caps[key] = false; capsChanged = true; } return worked; }
      parse(r.data); worked = true;
    }
    if (caps[key] !== true) { caps[key] = true; capsChanged = true; }
    return worked;
  };
  // HRV (range)
  const hrvOk = await tryRange('hrvRange', (s, e) => `/hrv-service/hrv/daily/${s}/${e}`, data => rows(data).forEach(x => {
    const d = x.calendarDate; if (!d || !x.lastNightAvg) return;
    Object.assign(rec(d), { hrv: x.lastNightAvg, hrvStatus: x.status || null, hrvBaseline: x.baseline ? [x.baseline.balancedLow, x.baseline.balancedUpper] : undefined });
  }));
  // Sleep (range)
  const sleepOk = await tryRange('sleepRange', (s, e) => `/sleep-service/stats/sleep/daily/${s}/${e}`, data => rows(data).forEach(x => {
    const d = x.calendarDate; const v = x.values || x; const secs = v.totalSleepTimeInSeconds ?? v.sleepTimeSeconds ?? v.totalSleepSeconds;
    if (!d || !secs) return;
    rec(d).sleepHrs = Math.round(secs / 360) / 10;
    const sc = v.sleepScore ?? (v.sleepScores && v.sleepScores.overall && v.sleepScores.overall.value); if (sc) rec(d).sleepScore = sc;
    const rhr = v.restingHeartRate; if (rhr) rec(d).rhr = rhr;
  }));
  // Resting HR (range)
  await tryRange('rhrRange', (s, e) => `/usersummary-service/stats/heartRate/daily/${s}/${e}`, data => rows(data).forEach(x => {
    const d = x.calendarDate; const v = x.values || x; const rhr = v.restingHR ?? v.restingHeartRate; if (d && rhr) rec(d).rhr = rhr;
  }));
  // Fallback: per-day for the most recent mornings only (keeps the request count small)
  if (!notes.rateLimited) {
    for (let i = 0; i < Math.min(days, 3); i++) {
      const d = addDays(endDate, -i);
      if (!hrvOk && !(recs[d] && recs[d].hrv)) {
        const h = await get('/hrv-service/hrv/' + d); const hs = h.data && h.data.hrvSummary;
        if (hs && hs.lastNightAvg) Object.assign(rec(d), { hrv: hs.lastNightAvg, hrvStatus: hs.status || null, hrvBaseline: hs.baseline ? [hs.baseline.balancedLow, hs.baseline.balancedUpper] : undefined });
        if (h.status === 429) break;
      }
      if (!sleepOk && !(recs[d] && recs[d].sleepHrs)) {
        const sl = await get('/sleep-service/sleep/dailySleep?date=' + d);
        if (sl.data && sl.data.sleepTimeSeconds) {
          rec(d).sleepHrs = Math.round(sl.data.sleepTimeSeconds / 360) / 10;
          const sc = sl.data.sleepScores && sl.data.sleepScores.overall; if (sc && sc.value) rec(d).sleepScore = sc.value;
          const rhr = deepFind(sl.data, /^restingHeartRate$/i); if (rhr && !rec(d).rhr) rec(d).rhr = rhr;
        }
        if (sl.status === 429) break;
      }
    }
  }
  // Weight: one range call
  if (!notes.rateLimited) {
    const w = await get(`/weight-service/weight/range/${startDate}/${endDate}`);
    ((w.data && w.data.dailyWeightSummaries) || []).forEach(x => {
      const d = x.summaryDate || x.calendarDate; const g = x.latestWeight ? x.latestWeight.weight : x.weight;
      if (d && g) rec(d).weightKg = Math.round(g / 100) / 10;
    });
  }
  if (capsChanged) await capsPut(env, caps);
  notes.caps = caps;
  return { days: Object.values(recs).sort((a, b) => b.date.localeCompare(a.date)), notes };
}

// Which Garmin hosts can this function reach at all? (Diagnoses edge/TLS errors like 526.)
async function netCheck() {
  const targets = [
    ['personal API host', 'https://personal.connectapi.garmin.com/'],
    ['token endpoint (GET)', TOKEN_URL],
    ['main Connect API host', 'https://connectapi.garmin.com/'],
    ['developer site', 'https://developer.garmin.com/'],
  ];
  const out = [];
  for (const [label, url] of targets) {
    try {
      const r = await fetch(url, { method: 'GET', redirect: 'manual' });
      out.push({ label, url, status: r.status, server: r.headers.get('server'), cfRay: r.headers.get('cf-ray') });
    } catch (e) { out.push({ label, url, error: e.message }); }
  }
  return out;
}

export async function onRequestPost(context) {
  envRef = context.env;
  try {
    const body = await context.request.json().catch(() => ({}));
    const action = body.action || 'status';

    if (action === 'status') {
      let token;
      try { token = await getToken(context.env, false); }
      catch (e) { return json({ ok: false, error: e.message, status: e.status, retryIn: e.retryIn, cfRay: e.cfRay, server: e.server, key: keyInfo, net: [401, 403, 429].includes(e.status) ? null : await netCheck() }); }
      return json({ ok: true, tokenOk: !!token, tokenFields: cachedToken.raw, expiresAt: new Date(cachedToken.expiresAt).toISOString() });
    }

    if (action === 'discover') {
      const token = await getToken(context.env);
      const { spec, from, tried } = await findSpec(token);
      // Fall back to endpoint paths known to work from other Personal API clients
      if (!spec) return json({ ok: true, from: 'fallback list (spec not found: ' + tried.length + ' places tried)', version: null, endpoints: KNOWN_ENDPOINTS });
      return json({ ok: true, from, title: spec.info && spec.info.title, version: spec.info && spec.info.version,
        servers: spec.servers || spec.basePath || null, endpoints: summarizeSpec(spec) });
    }

    if (action === 'daily') {
      const token = await getToken(context.env);
      const days = Math.max(1, Math.min(56, Number(body.days) || 3));          // range endpoints: ≤2 calls per sport for 56 days
      const endDate = /^\d{4}-\d{2}-\d{2}$/.test(body.endDate || '') ? body.endDate : new Date().toISOString().slice(0, 10);
      const res = await dailyWellness(token, endDate, days, context.env);
      if (res.notes.rateLimited && !res.days.length) return json({ ok: false, status: 429, error: 'Garmin rate limit (HTTP 429) — try again later', notes: res.notes });
      return json({ ok: true, ...res });
    }

    if (action === 'steps') {
      // Daily step totals for a date range (Garmin allows ≤28 days per request → chunked)
      const token = await getToken(context.env);
      const ok = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
      const end = ok(body.end) ? body.end : new Date().toISOString().slice(0, 10);
      let start = ok(body.start) ? body.start : addDays(end, -27);
      if (start < addDays(end, -364)) start = addDays(end, -364);               // ≤ 1 year per call (13 requests)
      const days = [], statuses = [];
      for (let s = start; s <= end; s = addDays(s, 28)) {
        const e = addDays(s, 27) < end ? addDays(s, 27) : end;
        const r = await gget(token, `/usersummary-service/stats/steps/daily/${s}/${e}`);
        statuses.push(r.status);
        if (r.status === 429) break;
        const list = Array.isArray(r.data) ? r.data : (r.data && (r.data.values || r.data.dailySteps)) || [];
        list.forEach(x => {
          const d = x.calendarDate || x.date; const v = x.totalSteps ?? x.steps ?? (x.values && x.values.totalSteps);
          if (d && v != null) days.push({ date: d, steps: Math.round(v) });
        });
      }
      return json({ ok: days.length > 0 || statuses.every(st => st === 200), days, statuses, ...(statuses.includes(429) ? { status: 429, error: 'Garmin rate limit (HTTP 429)' } : {}) });
    }

    if (action === 'probe') {
      const path = String(body.path || '');
      // Only relative API paths — no host switching, no traversal
      if (!/^\/[A-Za-z0-9/_\-.]*$/.test(path) || path.includes('..') || path.includes('//')) return json({ ok: false, error: 'Bad path' }, 400);
      const qs = new URLSearchParams();
      Object.entries(body.query || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, String(v)); });
      const token = await getToken(context.env);
      const url = API_HOST + path + (qs.toString() ? '?' + qs : '');
      let r = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
      if (r.status === 406) r = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: '*/*' } });
      const text = await r.text();
      let data = null; try { data = JSON.parse(text); } catch (e) {}
      return json({ ok: r.ok, status: r.status, url: path + (qs.toString() ? '?' + qs : ''), data, text: data ? undefined : text.slice(0, 2000) });
    }

    return json({ ok: false, error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ ok: false, error: e.message, status: e.status, retryIn: e.retryIn });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
}
