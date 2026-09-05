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
  const r = await fetch(`${BASE}/values/${key}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: JSON.stringify(value)
  });
  const result = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, result };
}

// Strip activity down to only the fields the app actually uses — keeps KV value small
function slimActivity(a) {
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    distance: a.distance,
    moving_time: a.moving_time,
    total_elevation_gain: a.total_elevation_gain,
    start_date_local: a.start_date_local,
    calories: a.calories || null,
    kudos_count: a.kudos_count || 0,
    average_speed: a.average_speed || null,
    gear_id: a.gear_id || null
  };
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
      const putResult = await kvPut(key, value, CF_API_TOKEN);
      return new Response(JSON.stringify({ ok: putResult.ok, detail: putResult.result }), { headers });
    }

    if (action === 'getAll') {
      const keys = ['brb_races', 'brb_training_plan', 'brb_weight_log', 'brb_activity_notes', 'brb_wellness_log', 'brb_swim_drills', 'brb_race_checklists', 'brb_garage'];
      const results = {};
      await Promise.all(keys.map(async k => { results[k] = await kvGet(k, CF_API_TOKEN); }));
      return new Response(JSON.stringify(results), { headers });
    }

    if (action === 'mergeActivities') {
      const newActs = (value || []).map(slimActivity);
      const stored = (await kvGet('brb_activity_archive', CF_API_TOKEN)) || [];
      // Respect the deleted blocklist so removed activities never come back on sync
      const deleted = (await kvGet('brb_deleted_activities', CF_API_TOKEN)) || [];
      const deletedSet = {};
      deleted.forEach(id => { deletedSet[String(id)] = true; });

      const map = {};
      stored.forEach(a => { if (!deletedSet[String(a.id)]) map[a.id] = a; });
      newActs.forEach(a => { if (!deletedSet[String(a.id)]) map[a.id] = a; });

      const merged = Object.values(map)
        .sort((a,b) => new Date(b.start_date_local) - new Date(a.start_date_local));

      const sizeBytes = JSON.stringify(merged).length;
      const putResult = await kvPut('brb_activity_archive', merged, CF_API_TOKEN);

      return new Response(JSON.stringify({
        ok: putResult.ok,
        total: merged.length,
        sizeKB: Math.round(sizeBytes / 1024),
        putStatus: putResult.status,
        putDetail: putResult.result
      }), { headers });
    }

    if (action === 'getDeleted') {
      const deleted = (await kvGet('brb_deleted_activities', CF_API_TOKEN)) || [];
      return new Response(JSON.stringify({ deleted, count: deleted.length }), { headers });
    }

    if (action === 'clearDeleted') {
      await kvPut('brb_deleted_activities', [], CF_API_TOKEN);
      return new Response(JSON.stringify({ ok: true, cleared: true }), { headers });
    }

    if (action === 'deleteActivity') {
      const delId = String(value);
      const stored = (await kvGet('brb_activity_archive', CF_API_TOKEN)) || [];
      const filtered = stored.filter(a => String(a.id) !== delId);
      await kvPut('brb_activity_archive', filtered, CF_API_TOKEN);
      // Remember the deletion so a future sync won't re-add it
      const deleted = (await kvGet('brb_deleted_activities', CF_API_TOKEN)) || [];
      if (!deleted.map(String).includes(delId)) deleted.push(delId);
      await kvPut('brb_deleted_activities', deleted, CF_API_TOKEN);
      return new Response(JSON.stringify({ ok: true, total: filtered.length, deletedId: delId }), { headers });
    }

    if (action === 'getActivities') {
      const archive = await kvGet('brb_activity_archive', CF_API_TOKEN) || [];
      return new Response(JSON.stringify({ activities: archive, count: archive.length }), { headers });
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, stack: e.stack }), { status: 500, headers });
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
