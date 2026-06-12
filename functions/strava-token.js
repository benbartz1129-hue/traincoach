export async function onRequestPost(context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  try {
    const { code, refresh_token, grant_type } = await context.request.json();

    const clientId = context.env.STRAVA_CLIENT_ID ? parseInt(context.env.STRAVA_CLIENT_ID) : 256087;
    const clientSecret = context.env.STRAVA_CLIENT_SECRET || 'Yf3771eff46d075aa8fc86e6585f948395c564555';

    const body = { client_id: clientId, client_secret: clientSecret, grant_type };
    if (grant_type === 'authorization_code') body.code = code;
    if (grant_type === 'refresh_token') body.refresh_token = refresh_token;

    const r = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await r.json();
    return new Response(JSON.stringify(data), { headers: corsHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    }
  });
}
