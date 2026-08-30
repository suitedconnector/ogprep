/**
 * Cloudflare Pages Function — /api/rain?lat=..&lon=..
 *
 * Average annual precipitation for a point, from Open-Meteo's historical
 * archive (free, no API key). Used to size rainwater catchment as a third
 * answer to "how do I get water here", alongside drilling and hauling.
 *
 * Returns inches per year plus the driest and wettest years in the window,
 * because catchment sizing should be built on a dry year, not an average.
 *
 * If the upstream is unavailable this returns ok:false and the caller falls
 * back to a user-entered figure — the feature must not depend on it.
 */

const ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
const YEARS = 10;
const TIMEOUT_MS = 15000;
const CACHE_SECONDS = 60 * 60 * 24 * 90;   // climate normals move slowly
const SCHEMA = "v1";

const json = (body, status = 200, cacheable = false) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": cacheable ? `public, max-age=${CACHE_SECONDS}` : "no-store"
    }
  });

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));
  if (!isFinite(lat) || !isFinite(lon)) return json({ ok: false, error: "lat and lon are required" }, 400);

  const key = `https://rain-cache/${SCHEMA}/${lat.toFixed(2)},${lon.toFixed(2)}`;
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return json({ ...(await hit.json()), cached: true }, 200, true);

  // Whole calendar years, ending with the last complete one.
  const end = new Date();
  const lastYear = end.getUTCFullYear() - 1;
  const startDate = `${lastYear - YEARS + 1}-01-01`;
  const endDate = `${lastYear}-12-31`;

  const q = new URL(ARCHIVE);
  Object.entries({
    latitude: lat, longitude: lon,
    start_date: startDate, end_date: endDate,
    daily: "precipitation_sum",
    precipitation_unit: "inch",
    timezone: "auto"
  }).forEach(([k, v]) => q.searchParams.set(k, v));

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let daily;
  try {
    const r = await fetch(q.toString(), { signal: ctl.signal });
    if (!r.ok) throw new Error("archive returned " + r.status);
    const j = await r.json();
    if (j.error) throw new Error(j.reason || "archive error");
    daily = j.daily;
    if (!daily || !Array.isArray(daily.time) || !Array.isArray(daily.precipitation_sum)) {
      throw new Error("unexpected response shape");
    }
  } catch (e) {
    clearTimeout(timer);
    return json({ ok: false, error: "Precipitation service unavailable: " + (e.message || e) }, 502);
  }
  clearTimeout(timer);

  // Sum by calendar year, ignoring nulls.
  const byYear = new Map();
  for (let i = 0; i < daily.time.length; i++) {
    const v = daily.precipitation_sum[i];
    if (v == null || !isFinite(v)) continue;
    const y = String(daily.time[i]).slice(0, 4);
    byYear.set(y, (byYear.get(y) || 0) + v);
  }
  const totals = [...byYear.entries()].map(([year, inches]) => ({ year, inches: +inches.toFixed(2) }));
  if (totals.length < 3) {
    return json({ ok: false, error: "Not enough precipitation history for this point." }, 502);
  }

  const values = totals.map(t => t.inches);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const driest = totals.reduce((a, b) => (b.inches < a.inches ? b : a));
  const wettest = totals.reduce((a, b) => (b.inches > a.inches ? b : a));

  const payload = {
    ok: true,
    annualInches: +avg.toFixed(1),
    driest, wettest,
    years: totals.length,
    window: `${startDate.slice(0, 4)}–${endDate.slice(0, 4)}`,
    byYear: totals,
    source: {
      dataset: "Historical reanalysis precipitation",
      publisher: "Open-Meteo",
      service: ARCHIVE,
      note: "Modelled reanalysis, roughly 9 km resolution — a planning figure, not a gauge reading."
    },
    cached: false
  };

  const res = json(payload, 200, true);
  await cache.put(key, res.clone());
  return res;
}
