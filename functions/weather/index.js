// Cloudflare Function: functions/weather/index.js
// Proxies Open-Meteo geocoding + forecast (free, no API key).
// POST body: { location: "Wauconda, IL" } OR { lat, lon }, plus optional { date: "2026-07-26" }

export async function onRequestPost(context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  try {
    const body = await context.request.json();
    let { lat, lon, location, date } = body;

    // Geocode the location string if no coords provided
    if ((lat == null || lon == null) && location) {
      const q = encodeURIComponent(location.split(',')[0].trim());
      const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${q}&count=1&language=en&format=json`);
      const geo = await geoRes.json();
      if (geo && geo.results && geo.results.length) {
        lat = geo.results[0].latitude;
        lon = geo.results[0].longitude;
      } else {
        return new Response(JSON.stringify({ error: 'Location not found', location }), { headers, status: 200 });
      }
    }

    if (lat == null || lon == null) {
      return new Response(JSON.stringify({ error: 'No location or coordinates provided' }), { headers, status: 200 });
    }

    // Daily forecast — Open-Meteo gives ~16 days out
    const params = new URLSearchParams({
      latitude: lat,
      longitude: lon,
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,sunrise',
      temperature_unit: 'fahrenheit',
      wind_speed_unit: 'mph',
      precipitation_unit: 'inch',
      timezone: 'auto',
      forecast_days: 16
    });

    const wxRes = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    const wx = await wxRes.json();

    // If a specific date was requested, extract just that day
    let dayForecast = null;
    if (date && wx.daily && Array.isArray(wx.daily.time)) {
      const idx = wx.daily.time.indexOf(date);
      if (idx !== -1) {
        dayForecast = {
          date,
          weatherCode: wx.daily.weather_code[idx],
          tempMax: wx.daily.temperature_2m_max[idx],
          tempMin: wx.daily.temperature_2m_min[idx],
          feelsMax: wx.daily.apparent_temperature_max[idx],
          precipProb: wx.daily.precipitation_probability_max[idx],
          windMax: wx.daily.wind_speed_10m_max[idx],
          windGust: wx.daily.wind_gusts_10m_max[idx],
          sunrise: wx.daily.sunrise ? wx.daily.sunrise[idx] : null
        };
      }
    }

    return new Response(JSON.stringify({
      lat, lon,
      inRange: !!dayForecast,
      forecast: dayForecast,
      raw: date ? undefined : wx.daily // only return full range if no specific date
    }), { headers, status: 200 });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { headers, status: 200 });
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

