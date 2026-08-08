/**
 * Cloudflare Pages Function — /api/soil?lat=..&lon=..
 *
 * Proxies USDA-NRCS Soil Data Access (SSURGO) to get the septic suitability
 * rating for a point. Exists for two reasons:
 *   1. SDA sends no CORS headers, so the browser cannot call it directly.
 *   2. SDA is slow and occasionally times out. Responses are cached at the
 *      edge for 30 days — soil survey data changes roughly annually.
 *
 * Returns:
 *   { ok, rating, class, components[], reasons[], source, cached }
 *   rating: "not_limited" | "somewhat_limited" | "very_limited" | "unknown"
 */

const SDA = "https://sdmdataaccess.nrcs.usda.gov/Tabular/post.rest";
const RULE = "ENG - Septic Tank Absorption Fields";
const CACHE_SECONDS = 60 * 60 * 24 * 30;   // 30 days

function classify(text) {
  const t = (text || "").toLowerCase();
  if (t.includes("not limited")) return "not_limited";
  if (t.includes("somewhat")) return "somewhat_limited";
  if (t.includes("very limited")) return "very_limited";
  return "unknown";
}

// Worst rating wins — if any major component is very limited, plan for it.
const SEVERITY = { unknown: 0, not_limited: 1, somewhat_limited: 2, very_limited: 3 };

async function sdaQuery(sql, signal) {
  const r = await fetch(SDA, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql, format: "JSON" }),
    signal
  });
  if (!r.ok) throw new Error("SDA returned " + r.status);
  const j = await r.json();
  return j.Table || [];
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));

  const bad = (msg, code = 400) =>
    new Response(JSON.stringify({ ok: false, error: msg }), {
      status: code,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });

  if (!isFinite(lat) || !isFinite(lon)) return bad("lat and lon are required");
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return bad("coordinates out of range");

  // Round to ~100 m so nearby lookups share a cache entry.
  const key = `https://soil-cache/${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) {
    const body = await hit.json();
    return new Response(JSON.stringify({ ...body, cached: true }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }

  const point = `point(${lon} ${lat})`;
  const headline = `
    SELECT TOP 10 co.compname, co.comppct_r, ci.interphrc, mu.muname
    FROM mapunit AS mu
    INNER JOIN component AS co ON co.mukey = mu.mukey
    INNER JOIN cointerp AS ci ON ci.cokey = co.cokey
    WHERE mu.mukey IN (SELECT * FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('${point}'))
      AND ci.mrulename = '${RULE}'
      AND ci.rulename  = '${RULE}'
      AND co.majcompflag = 'Yes'`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  let rows;
  try {
    rows = await sdaQuery(headline, controller.signal);
  } catch (e) {
    clearTimeout(timer);
    return bad("Soil Data Access unavailable: " + (e.message || e), 502);
  }
  clearTimeout(timer);

  if (!rows.length) {
    const miss = {
      ok: true, rating: "unknown", class: null, components: [], reasons: [],
      note: "No SSURGO survey coverage at this point. Some remote parcels are unmapped.",
      source: SOURCE
    };
    return new Response(JSON.stringify(miss), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }

  const components = rows.map(r => ({
    name: r[0], percent: +r[1] || null, class: r[2], mapunit: r[3]
  }));
  let worst = "unknown";
  for (const c of components) {
    const g = classify(c.class);
    if (SEVERITY[g] > SEVERITY[worst]) worst = g;
  }

  // Soil profile detail. Best-effort: if this query fails or times out we still
  // return the rating, which is the part the cost model depends on.
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
      WHERE mu.mukey IN (SELECT * FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('${point}'))
        AND co.majcompflag = 'Yes'
      ORDER BY co.comppct_r DESC`;
    const c3 = new AbortController();
    const t3 = setTimeout(() => c3.abort(), 15000);
    const d = await sdaQuery(detailSql, c3.signal);
    clearTimeout(t3);
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
      WHERE mu.mukey IN (SELECT * FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('${point}'))
        AND ci.mrulename = '${RULE}'
        AND ci.rulename <> '${RULE}'
        AND co.majcompflag = 'Yes'
        AND ci.interphr > 0`;
    try {
      const c2 = new AbortController();
      const t2 = setTimeout(() => c2.abort(), 15000);
      const sub = await sdaQuery(why, c2.signal);
      clearTimeout(t2);
      reasons = sub.map(r => String(r[0]).replace(/^ENG\s*-\s*/, "").trim());
      reasons = [...new Set(reasons)];
    } catch (_) {
      reasons = [];   // non-fatal; the headline rating still stands
    }
  }

  const payload = {
    ok: true,
    rating: worst,
    class: components[0] ? components[0].class : null,
    mapunit: components[0] ? components[0].mapunit : null,
    components,
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
