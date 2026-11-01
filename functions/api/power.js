/**
 * Cloudflare Pages Function — /api/power?lat=..&lon=..
 *
 * Two facts about electric service at a point, both from US-government data
 * that is republished on ArcGIS Online:
 *
 *   1. Which utilities' retail territories cover the point.
 *   2. The nearest MAPPED high-voltage line, with distance, voltage and owner.
 *
 * Read this before trusting the second one. The line layer is the HIFLD
 * "Electric Power Transmission Lines" dataset, which holds lines of 69 kV and
 * up. It does not contain the 12–34 kV distribution lines a landowner actually
 * connects to, so "nearest mapped line" is NOT the distance a power extension
 * would run and must never be turned into a cost. What it does tell you is
 * whether the grid is nearby at all, and who owns the nearest piece of it.
 *
 * HIFLD Open was shut down on 26 August 2025. The copies below are snapshots
 * (lines: 1 December 2021) and will not update, so the response says so.
 */

/* Identify ourselves to the agencies we query. A Worker's fetch sends no
   User-Agent by default, and at least one Arizona county GIS answers an
   anonymous request with 403 — a failure that reads as "no data" rather than
   "you were refused". It also gives an administrator someone to contact if we
   are ever a nuisance. */
const UA = "BuildOffGrid/1.0 (+https://buildoffgrid.ogprep.com; contact via site)";

const LINES = "https://services2.arcgis.com/wdQEqhSQSuYA89VW/ArcGIS/rest/services/ElectricTransLines12012021/FeatureServer/0/query";
const TERRITORIES = "https://services6.arcgis.com/BAJNi3EgCdtQ1BCG/arcgis/rest/services/Electric_Retail_Service_Territories/FeatureServer/0/query";

// Widen the search only when the narrower one finds nothing: a dense area can
// hold thousands of line segments inside 64 km.
const RADII_M = [8000, 24000, 64000];
const TIMEOUT_MS = 20000;
const CACHE_SECONDS = 60 * 60 * 24 * 30;   // both layers are frozen snapshots

/** Bump when the response shape changes so cached entries are abandoned. */
const SCHEMA = "v2";   // v2: utilities ordered by likelihood of being the retail provider

const json = (body, status = 200, cacheable = false) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": cacheable ? `public, max-age=${CACHE_SECONDS}` : "no-store"
    }
  });

async function arcgis(base, params) {
  const u = new URL(base);
  Object.entries({ f: "json", ...params }).forEach(([k, v]) => u.searchParams.set(k, v));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(u.toString(), { signal: ctl.signal, headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error("service returned " + r.status);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || "query failed");
    return j;
  } finally {
    clearTimeout(timer);
  }
}

/* Distance in metres from the point to a segment, on a local flat projection.
   Accurate to well under 1% across the tens of kilometres searched here. */
function segmentMetres(lat, lon, a, b) {
  const kx = Math.cos(lat * Math.PI / 180) * 111320, ky = 110574;
  const ax = (a[0] - lon) * kx, ay = (a[1] - lat) * ky;
  const bx = (b[0] - lon) * kx, by = (b[1] - lat) * ky;
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

async function nearestLine(lat, lon) {
  for (const radius of RADII_M) {
    const j = await arcgis(LINES, {
      geometry: `${lon},${lat}`,
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      outSR: "4326",
      distance: String(radius),
      units: "esriSRUnit_Meter",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "VOLTAGE,OWNER,STATUS",
      returnGeometry: "true",
      geometryPrecision: "5",
      resultRecordCount: "2000"
    });
    let best = null;
    for (const f of j.features || []) {
      for (const path of (f.geometry && f.geometry.paths) || []) {
        for (let i = 0; i < path.length - 1; i++) {
          const d = segmentMetres(lat, lon, path[i], path[i + 1]);
          if (!best || d < best.metres) best = { metres: d, attrs: f.attributes || {} };
        }
      }
    }
    if (best) {
      const kv = +best.attrs.VOLTAGE;
      const clean = s => (s && !/^NOT AVAILABLE$/i.test(s)) ? String(s) : null;
      return {
        miles: +(best.metres / 1609.34).toFixed(1),
        // The layer stores -999999 where the voltage is unknown.
        kv: kv > 0 ? kv : null,
        owner: clean(best.attrs.OWNER),
        status: clean(best.attrs.STATUS),
        searchedKm: radius / 1000
      };
    }
  }
  return null;
}

async function territories(lat, lon) {
  const j = await arcgis(TERRITORIES, {
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "NAME,TYPE,TELEPHONE,WEBSITE",
    returnGeometry: "false"
  });
  const clean = s => (s && !/^NOT AVAILABLE$/i.test(s)) ? String(s) : null;
  const rows = (j.features || []).map(f => {
    const a = f.attributes || {};
    const type = clean(a.TYPE);
    return {
      name: a.NAME,
      type,
      phone: clean(a.TELEPHONE),
      website: clean(a.WEBSITE),
      // Federal power marketers (WAPA, BIA projects) wholesale to utilities;
      // they are not who a landowner calls for a hook-up.
      wholesale: /FEDERAL/i.test(type || "")
    };
  });
  /* A rough ordering only, and the UI makes no claim that the first name is the
     provider. The layer's TYPE field is often blank (Duncan Valley Electric
     Cooperative has none), so type cannot identify the retail utility. Around
     Phoenix it returns a dozen overlapping irrigation and electrical districts
     alongside APS. Federal wholesalers go last; the rest are shown as a set. */
  const rank = u =>
    u.wholesale ? 3
    : /INVESTOR|COOPERATIVE|MUNICIPAL/i.test(u.type || "") && !/IRR|DRAIN|WATER (C|CON)/i.test(u.name || "") ? 0
    : /IRR|DRAIN|WATER|DIST/i.test(u.name || "") ? 2
    : 1;
  rows.sort((x, y) => rank(x) - rank(y));
  return rows;
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));
  if (!isFinite(lat) || !isFinite(lon)) return json({ ok: false, error: "lat and lon are required" }, 400);
  // The same two boxes the rest of the app uses. Arizona reaches -114.82 (Yuma,
  // Bullhead City) while Utah's western edge is -114.05; an earlier single box
  // with Utah's -114.1 limit rejected all of western Arizona, including the
  // Mohave demo parcel.
  const inAZ = lat >= 31 && lat <= 37.1 && lon >= -115 && lon <= -108.9;
  const inUT = lat >= 36.9 && lat <= 42.1 && lon >= -114.1 && lon <= -108.9;
  if (!inAZ && !inUT) {
    return json({ ok: false, outsideCoverage: true, error: "That point is outside Arizona and Utah." }, 400);
  }

  const key = `https://power-cache/${SCHEMA}/${lat.toFixed(4)},${lon.toFixed(4)}`;
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return json({ ...(await hit.json()), cached: true }, 200, true);

  // The two layers are independent, so one failing should not hide the other.
  const [lineRes, terrRes] = await Promise.allSettled([nearestLine(lat, lon), territories(lat, lon)]);
  if (lineRes.status === "rejected" && terrRes.status === "rejected") {
    return json({ ok: false, upstreamFailed: true,
      error: "Power data unavailable: " + (lineRes.reason && lineRes.reason.message || "upstream error") }, 502);
  }

  const utilities = terrRes.status === "fulfilled" ? terrRes.value : null;
  const payload = {
    ok: true,
    nearestLine: lineRes.status === "fulfilled" ? lineRes.value : null,
    lineLookupFailed: lineRes.status === "rejected",
    utilities,
    utilitiesLookupFailed: terrRes.status === "rejected",
    // Overlapping territories (irrigation and electrical districts, tribal
    // utilities) around cities make a long list; the caller can say so.
    overlapping: !!utilities && utilities.filter(u => !u.wholesale).length > 3,
    caveats: [
      "Lines are mapped at 69 kV and above only. The distribution lines a landowner connects to are not in any public dataset, so this distance is not the length of a power extension.",
      "Both layers are frozen snapshots of the retired HIFLD dataset (lines: December 2021). New lines and territory changes since then are missing.",
      "Territory boundaries are approximate. Confirm service with the utility before relying on it."
    ],
    source: {
      lines: "HIFLD Electric Power Transmission Lines, snapshot 1 December 2021 (US DHS / GeoPlatform)",
      territories: "HIFLD Electric Retail Service Territories (US DHS), republished on ArcGIS Online"
    },
    cached: false
  };

  // Do not cache a half-answer: a transient failure would stick for 30 days.
  if (payload.lineLookupFailed || payload.utilitiesLookupFailed) return json(payload, 200, false);
  const res = json(payload, 200, true);
  await cache.put(key, res.clone());
  return res;
}
