export async function onRequestPost(context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  try {
    const { action, key, value } = await context.request.json();
    const kv = context.env.BRB_KV;

    if (!kv) {
      return new Response(JSON.stringify({ error: 'KV namespace not bound' }), { status: 500, headers });
    }

    if (action === 'get') {
      const val = await kv.get(key);
      return new Response(JSON.stringify({ key, value: val ? JSON.parse(val) : null }), { headers });
    }

    if (action === 'set') {
      await kv.put(key, JSON.stringify(value));
      return new Response(JSON.stringify({ ok: true }), { headers });
    }

    if (action === 'getAll') {
      const keys = ['brb_races', 'brb_training_plan', 'brb_weight_log'];
      const results = {};
      await Promise.all(keys.map(async k => {
        const v = await kv.get(k);
        results[k] = v ? JSON.parse(v) : null;
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
