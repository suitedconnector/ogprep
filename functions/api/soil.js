/**
 * Cloudflare Pages Function — /api/soil?lat=..&lon=..[&poly=lon lat,lon lat,...]
 *
 * Proxies USDA-NRCS Soil Data Access (SSURGO) to get the septic suitability
 * rating for a point or a parcel. Exists for two reasons:
 *   1. SDA sends no CORS headers, so the browser cannot call it directly.
 *   2. SDA is slow and occasionally times out. Responses are cached at the
 *      edge for 30 days — soil survey data changes roughly annually.
 *
 * A soil map unit is a mixture: "Tours clay loam" may be 94% Tours and 6%
 * other soils that rate differently, and a parcel can straddle two or three
 * map units. So besides the headline rating this returns a breakdown of every
 * component, minor ones included, in every map unit the parcel touches, and
 * how much of the parcel each map unit covers.
 *
 * `poly` is the parcel's outer ring as "lon lat" pairs. Without it, or if the
 * polygon query fails, the lookup falls back to the point and says so in
 * `scope`.
 *
 * Returns:
 *   { ok, scope, rating, class, mapunit, components[], breakdown, profile,
 *     reasons[], source, cached }
 *   rating: "not_limited" | "somewhat_limited" | "very_limited" | "unknown"
 *   scope: "parcel" | "point"
 *   components: major components only, as before (headline inputs)
 *   breakdown: { mapunits[], overall } — see buildBreakdown()
 */

/* Identify ourselves to the agencies we query. A Worker's fetch sends no
   User-Agent by default, and at least one Arizona county GIS answers an
   anonymous request with 403 — a failure that reads as "no data" rather than
   "you were refused". It also gives an administrator someone to contact if we
   are ever a nuisance. */
const UA = "BuildOffGrid/1.0 (+https://buildoffgrid.ogprep.com; contact via site)";
const SDA = "https://sdmdataaccess.nrcs.usda.gov/Tabular/post.rest";
const RULE = "ENG - Septic Tank Absorption Fields";
const CACHE_SECONDS = 60 * 60 * 24 * 30;   // 30 days
const MAX_VERTICES = 400;

/**
 * Bump when the response shape changes so cached entries are abandoned rather
 * than served stale for another month.
 * v2 — added the profile block (drainage, Ksat, restrictive layer).
 * v3 — every component (minor too), map-unit breakdown, optional parcel polygon.
 */
const SCHEMA = "v3";

function classify(text) {
  const t = (text || "").toLowerCase();
  if (t.includes("not limited")) return "not_limited";
  if (t.includes("somewhat")) return "somewhat_limited";
  if (t.includes("very limited")) return "very_limited";
  return "unknown";
}

// Worst rating wins — if any major component is very limited, plan for it.
const SEVERITY = { unknown: 0, not_limited: 1, somewhat_limited: 2, very_limited: 3 };

async function sdaQuery(sql, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(SDA, {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql, format: "JSON" }),
      signal: controller.signal
    });
    if (!r.ok) throw new Error("SDA returned " + r.status);
    const j = await r.json();
    return j.Table || [];
  } finally {
    clearTimeout(timer);
  }
}

/* "lon lat,lon lat,..." → closed WKT polygon, or null if it is not a usable
   ring. Every value is parsed as a number before it reaches the SQL text. */
function parsePoly(raw) {
  if (!raw) return null;
  const pts = raw.split(",").map(p => p.trim().split(/\s+/).map(Number));
  if (pts.length < 3 || pts.length > MAX_VERTICES) return null;
  for (const [x, y] of pts) {
    if (!isFinite(x) || !isFinite(y) || x < -180 || x > 180 || y < -90 || y > 90) return null;
  }
  const [fx, fy] = pts[0], [lx, ly] = pts[pts.length - 1];
  if (fx !== lx || fy !== ly) pts.push([fx, fy]);
  if (pts.length < 4) return null;
  return `POLYGON((${pts.map(([x, y]) => `${x} ${y}`).join(",")}))`;
}

// Small string hash so a polygon can be part of the cache key.
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

const mukeysIn = wkt =>
  `SELECT * FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('${wkt}')`;

/* Every component of every map unit the shape touches, with its own septic
   rating. Minor components often carry no rating; they come back null. */
const componentsSql = wkt => `
  SELECT mu.mukey, mu.muname, co.compname, co.comppct_r, co.majcompflag,
         (SELECT TOP 1 ci.interphrc FROM cointerp AS ci
            WHERE ci.cokey = co.cokey AND ci.mrulename = '${RULE}' AND ci.rulename = '${RULE}') AS septic
  FROM mapunit AS mu
  INNER JOIN component AS co ON co.mukey = mu.mukey
  WHERE mu.mukey IN (${mukeysIn(wkt)})
  ORDER BY mu.mukey, co.comppct_r DESC`;

/* How much of the parcel each map unit covers. Planar area in degrees² is
   fine for a ratio over a parcel-sized shape. */
const areaSql = wkt => {
  const g = `geometry::STGeomFromText('${wkt}', 4326).MakeValid()`;
  return `
    SELECT mukey, SUM(mupolygongeo.STIntersection(${g}).STArea()) AS a
    FROM mupolygon
    WHERE mupolygongeo.STIntersects(${g}) = 1
    GROUP BY mukey`;
};

const EMPTY_SHARES = () => ({ very_limited: 0, somewhat_limited: 0, not_limited: 0, not_rated: 0 });

/**
 * mapunits: [{ mukey, name, areaPct, shares, components: [{ name, percent,
 *   major, rating, class }] }], largest area first.
 *   shares: percent of the map unit by rating; not_rated is components with
 *   no septic rating (often minor inclusions such as rock outcrop).
 * overall: the same shares across the whole parcel, weighted by area, or null
 *   when the area split is unknown.
 */
function buildBreakdown(rows, areas) {
  const byKey = new Map();
  for (const r of rows) {
    const key = String(r[0]);
    if (!byKey.has(key)) byKey.set(key, { mukey: key, name: r[1], areaPct: null, shares: EMPTY_SHARES(), components: [] });
    const rating = r[5] ? classify(r[5]) : "not_rated";
    const pct = +r[3] || 0;
    const mu = byKey.get(key);
    mu.components.push({ name: r[2], percent: pct || null, major: r[4] === "Yes", rating, class: r[5] || null });
    mu.shares[rating === "unknown" ? "not_rated" : rating] += pct;
  }
  const mapunits = [...byKey.values()];

  if (mapunits.length === 1) mapunits[0].areaPct = 100;
  else if (areas) {
    const total = mapunits.reduce((s, m) => s + (areas.get(m.mukey) || 0), 0);
    if (total > 0) for (const m of mapunits) m.areaPct = Math.round(1000 * (areas.get(m.mukey) || 0) / total) / 10;
  }
  mapunits.sort((a, b) => (b.areaPct ?? -1) - (a.areaPct ?? -1));

  let overall = null;
  if (mapunits.every(m => m.areaPct != null)) {
    overall = EMPTY_SHARES();
    for (const m of mapunits) for (const k in overall) overall[k] += m.shares[k] * m.areaPct / 100;
    // Round so the parts still add up to the same whole: largest remainders
    // take the leftover points, so 70.8 + 24.5 + 4.7 shows as 71 + 24 + 5.
    const keys = Object.keys(overall);
    const target = Math.round(keys.reduce((s, k) => s + overall[k], 0));
    const floors = Object.fromEntries(keys.map(k => [k, Math.floor(overall[k])]));
    let left = target - keys.reduce((s, k) => s + floors[k], 0);
    for (const k of [...keys].sort((a, b) => (overall[b] % 1) - (overall[a] % 1))) {
      if (left <= 0) break;
      floors[k]++; left--;
    }
    overall = floors;
  }
  return { mapunits, overall };
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));
  const polyRaw = url.searchParams.get("poly");

  const bad = (msg, code = 400) =>
    new Response(JSON.stringify({ ok: false, error: msg }), {
      status: code,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });

  if (!isFinite(lat) || !isFinite(lon)) return bad("lat and lon are required");
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return bad("coordinates out of range");
  const polyWkt = parsePoly(polyRaw);
  if (polyRaw && !polyWkt) return bad("poly must be 3 to " + MAX_VERTICES + " 'lon lat' pairs");

  // Round to ~100 m so nearby point lookups share a cache entry; a parcel
  // lookup is keyed by its shape.
  const key = `https://soil-cache/${SCHEMA}/${lat.toFixed(3)},${lon.toFixed(3)}` +
              (polyWkt ? `/p${hash(polyWkt)}` : "");
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) {
    const body = await hit.json();
    return new Response(JSON.stringify({ ...body, cached: true }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }

  const pointWkt = `point(${lon} ${lat})`;
  let scope = polyWkt ? "parcel" : "point";
  let wkt = polyWkt || pointWkt;

  let rows;
  try {
    rows = await sdaQuery(componentsSql(wkt), 20000);
  } catch (e) {
    if (!polyWkt) return bad("Soil Data Access unavailable: " + (e.message || e), 502);
    rows = null;
  }
  // A polygon SDA rejects, or one that touches no survey, falls back to the point.
  if (polyWkt && (!rows || !rows.length)) {
    scope = "point"; wkt = pointWkt;
    try {
      rows = await sdaQuery(componentsSql(wkt), 20000);
    } catch (e) {
      return bad("Soil Data Access unavailable: " + (e.message || e), 502);
    }
  }

  if (!rows.length) {
    const miss = {
      ok: true, scope, rating: "unknown", class: null, components: [], breakdown: null, reasons: [],
      note: "No SSURGO survey coverage at this point. Some remote parcels are unmapped.",
      source: SOURCE
    };
    return new Response(JSON.stringify(miss), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }

  // How much of the parcel each map unit covers. Best-effort: without it the
  // per-map-unit breakdown still stands, only the parcel-wide figure is lost.
  let areas = null;
  const distinct = new Set(rows.map(r => String(r[0])));
  if (scope === "parcel" && distinct.size > 1) {
    try {
      const a = await sdaQuery(areaSql(wkt), 15000);
      areas = new Map(a.map(r => [String(r[0]), +r[1] || 0]));
    } catch (_) { areas = null; }
  }

  const breakdown = buildBreakdown(rows, areas);

  // Headline: worst rating among the major components of every map unit.
  const components = [];
  let worst = "unknown";
  for (const mu of breakdown.mapunits) {
    for (const c of mu.components) {
      if (!c.major || !c.class) continue;
      components.push({ name: c.name, percent: c.percent, class: c.class, mapunit: mu.name });
      if (SEVERITY[c.rating] > SEVERITY[worst]) worst = c.rating;
    }
  }
  const lead = breakdown.mapunits[0];
  const leadMajor = lead.components.find(c => c.major && c.class);

  // Soil profile detail at the point. Best-effort: if this query fails or
  // times out we still return the rating, which is the part the cost model
  // depends on.
  let profile = null;
  try {
    const detailSql = `
      SELECT TOP 3 co.compname, co.comppct_r, co.drainagecl, co.hydgrp, co.slope_r,
             co.taxorder, co.taxclname,
             (SELECT TOP 1 cr.reskind FROM corestrictions AS cr
                WHERE cr.cokey = co.cokey ORDER BY cr.resdept_r) AS reskind,
             (SELECT TOP 1 cr.resdept_r FROM corestrictions AS cr
                WHERE cr.cokey = co.cokey ORDER BY cr.resdept_r) AS resdepth,
             (SELECT TOP 1 ch.ksat_r FROM chorizon AS ch
                WHERE ch.cokey = co.cokey AND ch.hzdept_r <= 50 ORDER BY ch.hzdept_r DESC) AS ksat,
             (SELECT TOP 1 ch.hzdepb_r FROM chorizon AS ch
                WHERE ch.cokey = co.cokey ORDER BY ch.hzdepb_r DESC) AS profiledepth
      FROM mapunit AS mu
      INNER JOIN component AS co ON co.mukey = mu.mukey
      WHERE mu.mukey IN (${mukeysIn(pointWkt)})
        AND co.majcompflag = 'Yes'
      ORDER BY co.comppct_r DESC`;
    const d = await sdaQuery(detailSql, 15000);
    if (d.length) {
      const seen = new Set();
      profile = d.map(r => {
        const ksat = parseFloat(r[9]);
        return {
          name: r[0],
          percent: +r[1] || null,
          drainage: r[2] || null,
          hydgroup: r[3] || null,
          slope: r[4] != null ? +r[4] : null,
          order: r[5] || null,
          taxclass: r[6] || null,
          restriction: r[7] || null,
          restrictionDepthIn: r[8] != null ? Math.round(+r[8] / 2.54) : null,
          ksat: isFinite(ksat) ? ksat : null,
          // Ksat (µm/s) → approximate percolation rate in minutes per inch.
          percMinPerInch: isFinite(ksat) && ksat > 0 ? Math.round(25400 / (ksat * 60)) : null,
          profileDepthIn: r[10] != null ? Math.round(+r[10] / 2.54) : null
        };
      }).filter(c => {
        const k = c.name + "|" + c.percent;
        if (seen.has(k)) return false;
        seen.add(k); return true;
      });
    }
  } catch (_) { profile = null; }

  // Only ask for the "why" when there is something to explain.
  let reasons = [];
  if (worst === "somewhat_limited" || worst === "very_limited") {
    const why = `
      SELECT DISTINCT TOP 8 ci.rulename, ci.interphrc
      FROM mapunit AS mu
      INNER JOIN component AS co ON co.mukey = mu.mukey
      INNER JOIN cointerp AS ci ON ci.cokey = co.cokey
      WHERE mu.mukey IN (${mukeysIn(wkt)})
        AND ci.mrulename = '${RULE}'
        AND ci.rulename <> '${RULE}'
        AND co.majcompflag = 'Yes'
        AND ci.interphr > 0`;
    try {
      const sub = await sdaQuery(why, 15000);
      reasons = sub.map(r => String(r[0]).replace(/^ENG\s*-\s*/, "").trim());
      reasons = [...new Set(reasons)];
    } catch (_) {
      reasons = [];   // non-fatal; the headline rating still stands
    }
  }

  const payload = {
    ok: true,
    scope,
    rating: worst,
    class: leadMajor ? leadMajor.class : null,
    mapunit: lead.name,
    components,
    breakdown,
    profile,
    reasons,
    source: SOURCE,
    cached: false
  };

  const res = new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": `public, max-age=${CACHE_SECONDS}`
    }
  });
  await cache.put(key, res.clone());
  return res;
}

const SOURCE = {
  dataset: "Soil Survey Geographic Database (SSURGO)",
  interpretation: "ENG - Septic Tank Absorption Fields",
  publisher: "Soil Survey Staff, Natural Resources Conservation Service, United States Department of Agriculture",
  service: "Soil Data Access — https://sdmdataaccess.nrcs.usda.gov",
  citation: "Soil Survey Staff, Natural Resources Conservation Service, United States Department of Agriculture. Soil Survey Geographic (SSURGO) Database. Available online at https://sdmdataaccess.sc.egov.usda.gov."
};
