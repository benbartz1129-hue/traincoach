// Uses Cloudflare KV REST API directly - no binding needed
const CF_ACCOUNT_ID = '23846f97f2d5dde9557f21aabbc3f3e9';
const KV_NAMESPACE_ID = 'ce44f82dceff46a6bd16563a2f3a3b1c';
const BASE = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}`;

export async function onRequestPost(context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  try {
    const { action, key, value } = await context.request.json();
    const CF_API_TOKEN = context.env.CF_API_TOKEN;

    if (!CF_API_TOKEN) {
      return new Response(JSON.stringify({ error: 'CF_API_TOKEN not set' }), { status: 500, headers });
    }

    const authHeaders = {
      'Authorization': `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'application/json'
    };

    if (action === 'set') {
      await fetch(`${BASE}/values/${key}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'text/plain' },
        body: JSON.stringify(value)
      });
      return new Response(JSON.stringify({ ok: true }), { headers });
    }

    if (action === 'getAll') {
      const keys = ['brb_races', 'brb_training_plan', 'brb_weight_log'];
      const results = {};
      await Promise.all(keys.map(async k => {
        const r = await fetch(`${BASE}/values/${k}`, {
          headers: { 'Authorization': `Bearer ${CF_API_TOKEN}` }
        });
        if (r.ok) {
          try { results[k] = await r.json(); }
          catch { results[k] = null; }
        } else {
          results[k] = null;
        }
      }));
      return new Response(JSON.stringify(results), { headers });
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
