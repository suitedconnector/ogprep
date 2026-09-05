/**
 * Cloudflare Pages Function — /api/utahwelllogs?lat=..&lon=..&radius=1609
 *
 * Well logs filed near a point in Utah, from the Division of Water Rights.
 *
 * A deliberate difference from the Arizona endpoint: Utah publishes an index of
 * *where the paperwork is*, not the parsed numbers. The layer carries a well ID,
 * water right number, owner, location and a LINK to the scanned document — but
 * no depth, water level or yield. Those live inside the PDF.
 *
 * So this cannot tell you how deep to drill. What it can do is put the filed
 * logs for a parcel in front of you with one click each, which is the diligence
 * you would otherwise do by hunting through a state search form.
 */

const LOGS = "https://services.arcgis.com/ZzrwjTRez6FJiOq4/arcgis/rest/services/Utah_Well_Logs/FeatureServer/0/query";
const TIMEOUT_MS = 8000;
const CACHE_SECONDS = 60 * 60 * 24 * 7;
const SCHEMA = "v1";

const json = (b, s = 200, cacheable = false) =>
  new Response(JSON.stringify(b), {
    status: s,
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
  const radius = Math.min(Math.max(parseInt(url.searchParams.get("radius") || "1609", 10) || 1609, 100), 8047);

  if (!isFinite(lat) || !isFinite(lon)) return json({ ok: false, error: "lat and lon are required" }, 400);
  if (lat < 36.9 || lat > 42.1 || lon < -114.1 || lon > -108.9) {
    return json({ ok: false, outsideUtah: true, error: "That point is outside Utah." }, 400);
  }

  const key = `https://utahlogs-cache/${SCHEMA}/${lat.toFixed(4)},${lon.toFixed(4)}/${radius}`;
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return json({ ...(await hit.json()), cached: true }, 200, true);

  const q = new URL(LOGS);
  Object.entries({
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    distance: String(radius),
    units: "esriSRUnit_Meter",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "WIN,WRCHEX,LINK,Geol_Log,Latitude,Longitude,Location,Owner,Log_Type",
    returnGeometry: "false",
    resultRecordCount: "200",
    f: "json"
  }).forEach(([k, v]) => q.searchParams.set(k, v));

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let rows;
  try {
    const r = await fetch(q.toString(), { signal: ctl.signal });
    if (!r.ok) throw new Error("well log service returned " + r.status);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || "query failed");
    rows = (j.features || []).map(f => f.attributes);
  } catch (e) {
    clearTimeout(t);
    return json({ ok: false, upstreamFailed: true,
      error: "Utah well log service unavailable: " + (e.message || e) });
  }
  clearTimeout(t);

  const R = 3958.7613, rad = d => d * Math.PI / 180;
  const miles = (la, lo) => {
    const dLat = rad(la - lat), dLon = rad(lo - lon);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat)) * Math.cos(rad(la)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  };

  const logs = rows.map(a => {
    const la = parseFloat(a.Latitude), lo = parseFloat(a.Longitude);
    return {
      wellId: a.WIN != null ? String(a.WIN) : null,
      waterRight: (a.WRCHEX || "").trim() || null,
      owner: (a.Owner || "").trim() || null,
      logType: (a.Log_Type || "").trim() || null,
      // Geol_Log 1 means a UGS geologic log — richer than a driller's log.
      geologic: +a.Geol_Log === 1,
      legal: (a.Location || "").trim() || null,
      link: (a.LINK || "").trim() || null,
      miles: (isFinite(la) && isFinite(lo)) ? +miles(la, lo).toFixed(2) : null
    };
  }).filter(l => l.link)
    .sort((a, b) => (a.miles ?? 99) - (b.miles ?? 99));

  const payload = {
    ok: true,
    scope: { lat, lon, radiusMiles: +(radius / 1609.34).toFixed(2) },
    found: logs.length,
    geologicCount: logs.filter(l => l.geologic).length,
    logs: logs.slice(0, 25),
    note: "Utah publishes the filed log documents rather than parsed values. Depth, water level and " +
          "yield are inside each PDF — open the nearest few to read them.",
    source: {
      dataset: "Utah Well Logs",
      publisher: "Utah Division of Water Rights",
      service: LOGS.replace(/\/query$/, "")
    },
    cached: false
  };

  const res = json(payload, 200, true);
  await cache.put(key, res.clone());
  return res;
}
