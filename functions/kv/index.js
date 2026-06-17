const CF_ACCOUNT_ID = '23846f97f2d5dde9557f21aabbc3f3e9';
const KV_NAMESPACE_ID = 'ce44f82dceff46a6bd16563a2f3a3b1c';
const BASE = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}`;

async function kvGet(key, token) {
  const r = await fetch(`${BASE}/values/${key}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}

async function kvPut(key, value, token) {
  await fetch(`${BASE}/values/${key}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: JSON.stringify(value)
  });
}

export async function onRequestPost(context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  try {
    const { action, key, value } = await context.request.json();
    const CF_API_TOKEN = context.env.CF_API_TOKEN;
    if (!CF_API_TOKEN) return new Response(JSON.stringify({ error: 'CF_API_TOKEN not set' }), { status: 500, headers });

    if (action === 'set') {
      await kvPut(key, value, CF_API_TOKEN);
      return new Response(JSON.stringify({ ok: true }), { headers });
    }

    if (action === 'getAll') {
      const keys = ['brb_races', 'brb_training_plan', 'brb_weight_log'];
      const results = {};
      await Promise.all(keys.map(async k => { results[k] = await kvGet(k, CF_API_TOKEN); }));
      return new Response(JSON.stringify(results), { headers });
    }

    // Merge new Strava activities with stored archive
    if (action === 'mergeActivities') {
      const newActs = value; // latest 100 from Strava
      const stored = await kvGet('brb_activity_archive', CF_API_TOKEN) || [];

      // Build map of existing by id
      const map = {};
      stored.forEach(a => { map[a.id] = a; });
      newActs.forEach(a => { map[a.id] = a; }); // new overwrite old (in case of edits)

      const merged = Object.values(map)
        .sort((a,b) => new Date(b.start_date_local) - new Date(a.start_date_local));

      await kvPut('brb_activity_archive', merged, CF_API_TOKEN);
      return new Response(JSON.stringify({ ok: true, total: merged.length }), { headers });
    }

    if (action === 'getActivities') {
      const archive = await kvGet('brb_activity_archive', CF_API_TOKEN) || [];
      return new Response(JSON.stringify({ activities: archive }), { headers });
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
