/**
 * Cloudflare Pages Function — /api/wells?lat=..&lon=..&radius=3220
 *
 * Reads ADWR's Well Registry (the "Wells55" programme) for wells near a point.
 *
 * WHY THIS CHANGED, because it matters and is easy to get wrong again:
 *
 * Arizona keeps two well datasets and they are not interchangeable.
 *
 *   GWSI  — the Groundwater Site Inventory. Sites ADWR physically visits to
 *           measure water levels. ADWR's own description: "Permission to access
 *           and measure wells is entirely voluntary for the well owners. As
 *           such, the dataset does not represent all wells in the state and
 *           there may be large areas with sparse data coverage."
 *
 *   Wells55 — the drilling registry. Every well filed with the state, with the
 *           depth, water level, casing, tested yield and driller licence taken
 *           from the completion report.
 *
 * This endpoint used to read GWSI. At a test point near St Johns that returned
 * 19 wells; the registry returns 322 at the same point and radius. We were
 * computing "what will a well cost here" from a seventeenth of the evidence,
 * and from a population selected for being monitored rather than for being
 * someone's household well.
 *
 * It also explains the Wikieup discrepancy that sat unresolved in the project
 * notes — the depth finder and the driller panel were not contradicting each
 * other, they were counting different wells.
 *
 * The registry additionally carries things GWSI does not: tested yield in gpm,
 * the driller's licence number, per-well AMA status, and a flag for whether a
 * drill log was filed.
 */

/* Identify ourselves to the agencies we query. A Worker's fetch sends no
   User-Agent by default, and at least one Arizona county GIS answers an
   anonymous request with 403 — a failure that reads as "no data" rather than
   "you were refused". It also gives an administrator someone to contact if we
   are ever a nuisance. */
const UA = "BuildOffGrid/1.0 (+https://buildoffgrid.ogprep.com; contact via site)";
const WELLS55 = "https://services.arcgis.com/C34zQ7veRS0V1t04/ArcGIS/rest/services/Well_Registry_2024/FeatureServer/0/query";
const TIMEOUT_MS = 20000;
const CACHE_SECONDS = 60 * 60 * 24 * 30;   // well records change slowly

/**
 * Bump this whenever the response shape changes. Cached entries are keyed by
 * it, so old payloads are abandoned rather than served for another month.
 * v2 — added lat/lon/miles per well for the map.
 */
const SCHEMA = "v4";   // v4 switches GWSI -> Wells55 registry; adds yield, registry id, AMA

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

  const q = new URL(WELLS55);
  Object.entries({
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    // The registry stores UTM 12N and carries no lat/lon columns, so the point
    // has to come from the geometry rather than from an attribute.
    outSR: "4326",
    distance: String(radius),
    units: "esriSRUnit_Meter",
    spatialRel: "esriSpatialRelIntersects",
    outFields: [
      "REGISTRY_ID",      // the 55-number, and the key to the filed record
      "WELL_DEPTH",
      "WATER_LEVEL",      // depth to water reported at drilling
      "INSTALLED",
      "WATER_USE",        // DOMESTIC, IRRIGATION, STOCK...
      "SITE_USE",         // WATER PRODUCTION vs monitoring, exploration, etc.
      "WELL_TYPE_GROUP",  // EXEMPT = the 35 gpm domestic class
      "WELL_CANCELLED",
      "TESTEDRATE",       // yield in gpm — GWSI has nothing like this
      "CASING_DIAMETER",
      "DLIC_NUM",         // driller licence, for the driller panel
      "DRILL_LOG",        // "X" when a log was actually filed
      "AMA"
    ].join(","),
    returnGeometry: "true",
    geometryPrecision: "6",
    resultRecordCount: "1200",
    f: "json"
  }).forEach(([k, v]) => q.searchParams.set(k, v));

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let recs, dedupedFrom = 0;
  try {
    const r = await fetch(q.toString(), { signal: ctl.signal, headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error("ADWR returned " + r.status);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || "ADWR query failed");
    /* Keep the point with the attributes — the registry has no DD_LAT column.
       Drop cancelled registrations and anything that is not a water-production
       well: the registry also holds monitoring, exploration and injection
       holes, and averaging those into "what will my household well cost" is
       the same error as counting geothermal bores in Utah. */
    recs = (j.features || [])
      .filter(f => {
        const a = f.attributes || {};
        if (String(a.WELL_CANCELLED || "").toUpperCase() === "Y") return false;
        const use = String(a.SITE_USE || "").toUpperCase();
        return !use || use.includes("WATER PRODUCTION");
      })
      .map(f => ({ ...f.attributes, _x: f.geometry ? f.geometry.x : null,
                                    _y: f.geometry ? f.geometry.y : null }));

    /* One physical well can hold several registrations — a deepening, a
       replacement or a re-filing each get their own 55-number at the same spot.
       Left alone they inflate the sample and drag the median toward whichever
       well happened to be filed twice. Collapse on position plus depth, and
       keep the richest filing: the one that actually reports a water level and
       a date. Same fix as the Utah dedup by WIN. */
    const byWell = new Map();
    const score = a => (+a.WATER_LEVEL > 0 ? 4 : 0) + (a.INSTALLED ? 2 : 0) +
                       (+a.TESTEDRATE > 0 ? 1 : 0);
    for (const a of recs) {
      const key = [
        a._x == null ? "?" : a._x.toFixed(5),
        a._y == null ? "?" : a._y.toFixed(5),
        a.WELL_DEPTH == null ? "?" : a.WELL_DEPTH
      ].join("|");
      const prev = byWell.get(key);
      if (!prev) { byWell.set(key, a); continue; }
      // Keep the fuller record, but carry across any field the winner lacks.
      const keep = score(a) > score(prev) ? a : prev;
      const other = keep === a ? prev : a;
      for (const k of ["WATER_LEVEL", "INSTALLED", "TESTEDRATE", "REGISTRY_ID",
                       "DLIC_NUM", "WATER_USE", "DRILL_LOG"]) {
        if ((keep[k] == null || keep[k] === "") && other[k] != null) keep[k] = other[k];
      }
      byWell.set(key, keep);
    }
    const before = recs.length;
    recs = [...byWell.values()];
    dedupedFrom = before;
  } catch (e) {
    clearTimeout(timer);
    return json({ ok: false, error: "ADWR groundwater service unavailable: " + (e.message || e) }, 502);
  }
  clearTimeout(timer);

  const depths = recs.map(a => +a.WELL_DEPTH).filter(v => v > 0);
  const dtw    = recs.map(a => +a.WATER_LEVEL).filter(v => v > 0);
  const yields = recs.map(a => +a.TESTEDRATE).filter(v => v > 0);

  const payload = {
    ok: true,
    radiusMeters: radius,
    radiusMiles: +(radius / 1609.34).toFixed(radius < 1000 ? 1 : 0),
    found: recs.length,
    // How many rows collapsed, so the caller can say "19 filings, 14 wells"
    // rather than silently reporting a smaller number than the registry shows.
    registrations: dedupedFrom || recs.length,
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
      medianDepthToWater: median(dtw),
      // Yield is new — the registry records what the well actually tested at.
      // A 100 ft well at 3 gpm is a different purchase from one at 25 gpm, and
      // until now the app could not tell the difference in either state.
      withYield: yields.length,
      medianYieldGpm: median(yields)
    } : null,

    // Exempt wells are the 35 gpm domestic class. Reporting how many of the
    // nearby wells are household wells tells a buyer whether this is ground
    // people actually live on, or a farm basin with a few big irrigation bores.
    exemptCount: recs.filter(a =>
      String(a.WELL_TYPE_GROUP || "").toUpperCase() === "EXEMPT").length,
    // Per-well AMA status, straight from the registry rather than inferred.
    ama: (recs.find(a => a.AMA && !/NOT WITHIN ANY/i.test(a.AMA)) || {}).AMA || null,

    wells: recs
      .filter(a => +a.WELL_DEPTH > 0)
      .sort((a, b) => b.WELL_DEPTH - a.WELL_DEPTH)
      .slice(0, 60)
      .map(a => {
        // outSR=4326 puts lon in x and lat in y.
        const wlon = a._x, wlat = a._y;
        const hasPt = isFinite(wlat) && isFinite(wlon);
        const yr = a.INSTALLED ? new Date(a.INSTALLED).getUTCFullYear() : null;
        return {
          use: a.WATER_USE || null,
          drilled: (yr && yr > 1850 && yr < 2100) ? String(yr) : null,
          depth: +a.WELL_DEPTH,
          depthToWater: +a.WATER_LEVEL > 0 ? +a.WATER_LEVEL : null,
          yieldGpm: +a.TESTEDRATE > 0 ? +a.TESTEDRATE : null,
          exempt: String(a.WELL_TYPE_GROUP || "").toUpperCase() === "EXEMPT",
          // The filed record. "X" means a drill log exists to go and read.
          registryId: a.REGISTRY_ID || null,
          hasLog: String(a.DRILL_LOG || "").toUpperCase() === "X",
          drillerLicence: a.DLIC_NUM || null,
          lat: hasPt ? wlat : null,
          lon: hasPt ? wlon : null,
          // Straight-line distance from the search point, in miles.
          miles: hasPt ? +(haversineMiles(lat, lon, wlat, wlon).toFixed(2)) : null
        };
      }),
    source: {
      dataset: "Well Registry (Wells55)",
      publisher: "Arizona Department of Water Resources",
      note: "Every well filed with the state, with depth, water level, tested yield " +
            "and casing taken from the driller's completion report. Cancelled " +
            "registrations and non-production holes are excluded.",
      service: WELLS55.replace(/\/query$/, "")
    },
    cached: false
  };

  const res = json(payload, 200, true);
  await cache.put(key, res.clone());
  return res;
}
