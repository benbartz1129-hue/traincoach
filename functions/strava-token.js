export async function onRequestPost(context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  try {
    const body = await context.request.json();
    
    const params = new URLSearchParams();
    params.append('client_id', '256087');
    params.append('client_secret', context.env.STRAVA_CLIENT_SECRET || 'MISSING');
    params.append('grant_type', body.grant_type);
    if (body.code) params.append('code', body.code);
    if (body.refresh_token) params.append('refresh_token', body.refresh_token);

    const r = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });

    const text = await r.text();
    return new Response(text, { status: r.status, headers });
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
