// Cloudflare Function: functions/widget/index.js
// Serves the home-screen widget's data: the snapshot BRB Training saves to KV ('brb_widget')
// each time its home page refreshes. GET only, read-only.
//
// The site sits behind Cloudflare Access, so the widget authenticates with an Access SERVICE TOKEN
// (headers CF-Access-Client-Id / CF-Access-Client-Secret). Access checks those before this runs.

const CF_ACCOUNT_ID = '23846f97f2d5dde9557f21aabbc3f3e9';
const KV_NAMESPACE_ID = 'ce44f82dceff46a6bd16563a2f3a3b1c';
const BASE = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}`;

const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

export async function onRequestGet(context) {
  try {
    const token = context.env.CF_API_TOKEN;
    if (!token) return new Response(JSON.stringify({ error: 'CF_API_TOKEN not set' }), { status: 500, headers });
    const r = await fetch(`${BASE}/values/brb_widget`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 404) return new Response(JSON.stringify({ error: 'No widget data yet — open BRB Training once to publish it.' }), { status: 404, headers });
    if (!r.ok) return new Response(JSON.stringify({ error: 'KV read failed', status: r.status }), { status: 502, headers });
    return new Response(await r.text(), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
}
