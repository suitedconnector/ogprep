/**
 * Cloudflare Pages Function — /api/wells?lat=..&lon=..&radius=3220
 *
 * Proxies ADWR's Groundwater Site Inventory. Exists because the browser cannot
 * reliably call that service cross-origin, and because caching keeps a slow or
 * flaky upstream from breaking the page.
 *
 * Returns depth statistics plus the individual well records, so the caller can
 * show its working rather than just a number.
 */

/* Identify ourselves to the agencies we query. A Worker's fetch sends no
   User-Agent by default, and at least one Arizona county GIS answers an
   anonymous request with 403 — a failure that reads as "no data" rather than
   "you were refused". It also gives an administrator someone to contact if we
   are ever a nuisance. */
const UA = "BuildOffGrid/1.0 (+https://buildoffgrid.ogprep.com; contact via site)";
const GWSI = "https://services.arcgis.com/C34zQ7veRS0V1t04/arcgis/rest/services/GWSI_Sites_2024/FeatureServer/0/query";
const TIMEOUT_MS = 20000;
const CACHE_SECONDS = 60 * 60 * 24 * 30;   // well records change slowly

/**
 * Bump this whenever the response shape changes. Cached entries are keyed by
 * it, so old payloads are abandoned rather than served for another month.
 * v2 — added lat/lon/miles per well for the map.
 */
const SCHEMA = "v3";   // v3 adds stats.med — the real median depth, not the mean

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const sdev = a => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map(v => (v - m) * (v - m))));
};
// Great-circle distance in miles.
function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.7613;
  const rad = d => d * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const median = a => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
};

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
  const radius = Math.min(Math.max(parseInt(url.searchParams.get("radius") || "3220", 10) || 3220, 200), 16093);

  if (!isFinite(lat) || !isFinite(lon)) return json({ ok: false, error: "lat and lon are required" }, 400);
  if (lat < 31 || lat > 37.1 || lon < -115 || lon > -108.9) {
    return json({ ok: false, outsideArizona: true, error: "That point is outside Arizona. ADWR well records only cover Arizona." }, 400);
  }

  const key = `https://wells-cache/${SCHEMA}/${lat.toFixed(4)},${lon.toFixed(4)}/${radius}`;
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) {
    const body = await hit.json();
    return json({ ...body, cached: true }, 200, true);
  }

  const q = new URL(GWSI);
  Object.entries({
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    distance: String(radius),
    units: "esriSRUnit_Meter",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "SITE_ID,WELL_DEPTH,WL_DTW,DRILL_DATE_TEXT,WATER_USE,DD_LAT,DD_LONG",
    returnGeometry: "false",
    resultRecordCount: "400",
    f: "json"
  }).forEach(([k, v]) => q.searchParams.set(k, v));

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let recs;
  try {
    const r = await fetch(q.toString(), { signal: ctl.signal, headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error("ADWR returned " + r.status);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || "ADWR query failed");
    recs = (j.features || []).map(f => f.attributes);
  } catch (e) {
    clearTimeout(timer);
    return json({ ok: false, error: "ADWR groundwater service unavailable: " + (e.message || e) }, 502);
  }
  clearTimeout(timer);

  const depths = recs.map(a => +a.WELL_DEPTH).filter(v => v > 0);
  const dtw = recs.map(a => +a.WL_DTW).filter(v => v > 0);

  const payload = {
    ok: true,
    radiusMeters: radius,
    radiusMiles: +(radius / 1609.34).toFixed(radius < 1000 ? 1 : 0),
    found: recs.length,
    withDepth: depths.length,
    stats: depths.length ? {
      avg: mean(depths),
      // The median was missing, so the UI was labelling the MEAN as a median and
      // comparing it against the county's real median. One deep outlier — these
      // sets run to 1,500 ft — drags a mean well above typical ground, which
      // makes a cheap area look expensive. Both are returned now; the median is
      // the planning number and the mean is only useful next to sd.
      med: median(depths),
      sd: sdev(depths),
      min: Math.min(...depths),
      max: Math.max(...depths),
      medianDepthToWater: median(dtw)
    } : null,
    wells: recs
      .filter(a => +a.WELL_DEPTH > 0)
      .sort((a, b) => b.WELL_DEPTH - a.WELL_DEPTH)
      .slice(0, 60)
      .map(a => {
        const wlat = parseFloat(a.DD_LAT), wlon = parseFloat(a.DD_LONG);
        const hasPt = isFinite(wlat) && isFinite(wlon);
        return {
          use: a.WATER_USE || null,
          drilled: (a.DRILL_DATE_TEXT || "").slice(0, 4) || null,
          depth: +a.WELL_DEPTH,
          depthToWater: +a.WL_DTW > 0 ? +a.WL_DTW : null,
          lat: hasPt ? wlat : null,
          lon: hasPt ? wlon : null,
          // Straight-line distance from the search point, in miles.
          miles: hasPt ? +(haversineMiles(lat, lon, wlat, wlon).toFixed(2)) : null
        };
      }),
    source: {
      dataset: "Groundwater Site Inventory (GWSI)",
      publisher: "Arizona Department of Water Resources",
      service: GWSI.replace(/\/query$/, "")
    },
    cached: false
  };

  const res = json(payload, 200, true);
  await cache.put(key, res.clone());
  return res;
}
