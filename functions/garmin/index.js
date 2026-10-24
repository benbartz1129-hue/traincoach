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

// Access tokens last 24h and there are no refresh tokens — cache per isolate and re-mint when close to expiry.
let cachedToken = null;   // { token, expiresAt }
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
  if (!force && cachedToken && cachedToken.expiresAt - Date.now() > 60 * 60 * 1000) return cachedToken.token;
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
    throw err;
  }
  // Accept either JSON ({access_token,...}), a JSON string ("eyJ..."), or the raw token text
  let data = {}; try { data = JSON.parse(text); } catch (e) { data = { access_token: text.trim() }; }
  if (typeof data === 'string') data = { access_token: data };
  const token = (data.access_token || data.accessToken || data.token || '').trim();
  if (!token) throw new Error('Token response had no access token. Fields: ' + Object.keys(data).join(', '));
  const ttl = Number(data.expires_in || data.expiresIn || 86400);
  cachedToken = { token, expiresAt: Date.now() + ttl * 1000, raw: Object.keys(data).concat(['len ' + token.length]) };
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
  try {
    const body = await context.request.json().catch(() => ({}));
    const action = body.action || 'status';

    if (action === 'status') {
      let token;
      try { token = await getToken(context.env, true); }
      catch (e) { return json({ ok: false, error: e.message, status: e.status, cfRay: e.cfRay, server: e.server, key: keyInfo, net: e.status === 401 || e.status === 403 ? null : await netCheck() }); }
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
    return json({ ok: false, error: e.message });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
}
