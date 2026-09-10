/**
 * Cloudflare Pages Function — /api/waterservice?lat=..&lon=..
 *
 * Three questions a rural buyer cannot answer from a listing, all from ADWR's
 * statewide layers:
 *
 *   1. Is this parcel inside a community water system's service area?
 *      If yes, the well question may be moot — you buy a connection instead.
 *   2. If not, how far is the nearest one, and who is it?
 *      Distance to a boundary is not a promise of service, but it is the
 *      difference between "ask them" and "do not bother".
 *   3. Is it inside an AMA or INA?
 *      This is the one genuinely dispositive groundwater gate in Arizona, and
 *      the app previously asserted "exempt well allowed" everywhere, which is
 *      not true inside an Active Management Area.
 *
 * Why it matters here: Golden Valley contains both. Golden Valley Improvement
 * District #1 is active and serves about 4,150 people, yet a point in the
 * densest part of the valley — 48 wells, 46 of them domestic — falls outside
 * every mapped service area. Same place name, opposite answer. A buyer cannot
 * tell which they are looking at, and neither can a county-level tool.
 *
 * Honest limits, carried into the response:
 *  - ADWR refreshes these boundaries roughly every five years and builds them
 *    partly from what the systems themselves report, so a boundary is evidence,
 *    not a guarantee. Only the utility can confirm a connection.
 *  - Being inside a CCN (a franchise territory) means a company is entitled to
 *    serve there. It does not mean a main is in the ground.
 */

const ROOT = "https://services.arcgis.com/C34zQ7veRS0V1t04/ArcGIS/rest/services/";
const CWS  = ROOT + "CWS_Service_Area/FeatureServer/0/query";
const CCN  = ROOT + "CCN_2024/FeatureServer/0/query";
const AMA  = ROOT + "AMA_INA_2024/FeatureServer/0/query";

const TIMEOUT_MS = 9000;
const CACHE_SECONDS = 60 * 60 * 24 * 60;   // boundaries move on a multi-year cycle
const SCHEMA = "v1";
const NEAR_METRES = 16093;                 // look 10 miles for the nearest system

const json = (b, s = 200, cacheable = false) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": cacheable ? `public, max-age=${CACHE_SECONDS}` : "no-store"
    }
  });

const clean = v => {
  const s = String(v == null ? "" : v).trim();
  return (!s || /^(none|n\/?a|null|unknown)$/i.test(s)) ? null : s;
};

/* Title-case the shouted names these layers store. Acronyms are an explicit
   list rather than a length rule — "CO" is a company, not an acronym, and a
   length rule turns it into "CO" while turning "Az" into nonsense. */
const KEEP_UPPER = new Set(["llc","lc","hoa","poa","usa","az","us","mhp","rv","cws","adeq",
                            "ii","iii","iv","mud","pud"]);
const nameCase = s => {
  const t = clean(s);
  if (!t) return null;
  return t.toLowerCase()
    .replace(/\b[a-z]+\b/g, w =>
      KEEP_UPPER.has(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))
    .replace(/\bImp\b/g, "Improvement")
    .replace(/\bDist\b/g, "District")
    .replace(/\bUtils?\b/g, "Utilities")
    .replace(/\bDept\b/g, "Department");
};

async function esri(url, params, signal) {
  const q = new URL(url);
  Object.entries({ f: "json", ...params }).forEach(([k, v]) => q.searchParams.set(k, v));
  const r = await fetch(q.toString(), { signal });
  if (!r.ok) throw new Error("service returned " + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "query failed");
  return j.features || [];
}

const atPoint = (url, fields, lat, lon, signal, withGeom = false) =>
  esri(url, {
    geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: fields,
    // Generalised hard when we do want it: the point is to show the reader
    // roughly where the line runs, not to reproduce the utility's survey.
    ...(withGeom
      ? { returnGeometry: "true", outSR: "4326",
          maxAllowableOffset: "0.002", geometryPrecision: "5" }
      : { returnGeometry: "false" }),
    resultRecordCount: "5"
  }, signal);

/* Esri rings [x,y] → Leaflet [lat,lon], thinned again so a large system's
   boundary does not arrive as ten thousand points. */
const toBoundary = geom => {
  if (!geom || !Array.isArray(geom.rings)) return null;
  return geom.rings.map(r => {
    const step = Math.max(1, Math.ceil(r.length / 400));
    return r.filter((_, i) => i % step === 0).map(v => [+v[1], +v[0]]);
  });
};

/* Great-circle distance in miles. Rings come back in 4326. */
const MI = 3958.8;
const rad = d => d * Math.PI / 180;
function haversineMi(aLat, aLon, bLat, bLon) {
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * MI * Math.asin(Math.sqrt(h));
}

/* Nearest mapped service area within NEAR_METRES, with a rough distance to its
   edge. Geometry is generalised hard before transfer — we want "about two
   miles", not a survey, and these polygons can carry thousands of vertices. */
async function nearestSystem(lat, lon, signal) {
  const feats = await esri(CWS, {
    geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", inSR: "4326",
    outSR: "4326", spatialRel: "esriSpatialRelIntersects",
    distance: String(NEAR_METRES), units: "esriSRUnit_Meter",
    outFields: "CWS_NAME,OWNER_NAME,PHONE,POPULATION,STATUS,COUNTY",
    returnGeometry: "true", maxAllowableOffset: "0.002", geometryPrecision: "5",
    resultRecordCount: "12"
  }, signal);

  let best = null;
  for (const f of feats) {
    const rings = (f.geometry && f.geometry.rings) || [];
    let d = Infinity;
    for (const ring of rings) for (const [x, y] of ring) {
      const m = haversineMi(lat, lon, y, x);
      if (m < d) d = m;
    }
    if (d < (best ? best.miles : Infinity)) {
      const a = f.attributes;
      best = {
        name: nameCase(a.CWS_NAME),
        owner: nameCase(a.OWNER_NAME),
        phone: clean(a.PHONE),
        population: a.POPULATION > 0 ? Math.round(a.POPULATION) : null,
        active: String(a.STATUS || "").toUpperCase() === "A",
        miles: +d.toFixed(1),
        boundary: toBoundary(f.geometry)
      };
    }
  }
  return best;
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));
  if (!isFinite(lat) || !isFinite(lon)) {
    return json({ ok: false, error: "lat and lon are required" }, 400);
  }
  if (!(lat >= 31 && lat <= 37.1 && lon >= -115 && lon <= -108.9)) {
    return json({ ok: false, outsideCoverage: true,
      error: "These layers cover Arizona only." }, 200);
  }

  const key = `https://waterservice/${SCHEMA}/${lat.toFixed(4)},${lon.toFixed(4)}`;
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return json({ ...(await hit.json()), cached: true }, 200, true);

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);

  let served = null, ccn = null, ama = null, nearest = null, err = null;
  try {
    const [cwsF, ccnF, amaF] = await Promise.all([
      atPoint(CWS, "CWS_NAME,OWNER_NAME,PHONE,POPULATION,STATUS,COUNTY,ADEQ_ID", lat, lon, ctl.signal, true),
      atPoint(CCN, "*", lat, lon, ctl.signal).catch(() => []),
      atPoint(AMA, "*", lat, lon, ctl.signal).catch(() => [])
    ]);

    if (cwsF.length) {
      const a = cwsF[0].attributes;
      served = {
        name: nameCase(a.CWS_NAME),
        owner: nameCase(a.OWNER_NAME),
        phone: clean(a.PHONE),
        population: a.POPULATION > 0 ? Math.round(a.POPULATION) : null,
        active: String(a.STATUS || "").toUpperCase() === "A",
        systemId: clean(a.ADEQ_ID),
        boundary: toBoundary(cwsF[0].geometry)
      };
    } else {
      nearest = await nearestSystem(lat, lon, ctl.signal).catch(() => null);
    }

    // Field names vary between ADWR layers; take whatever reads as a name.
    const pick = (attrs, re) => {
      for (const [k, v] of Object.entries(attrs || {}))
        if (re.test(k) && clean(v)) return clean(v);
      return null;
    };
    if (ccnF.length) ccn = { holder: nameCase(pick(ccnF[0].attributes, /name|company|utility|holder/i)) };
    if (amaF.length) {
      const a = amaF[0].attributes;
      const nm = pick(a, /name|ama|ina/i);
      ama = { name: nameCase(nm), type: /INA/i.test(String(nm || "")) ? "INA" : "AMA" };
    }
  } catch (e) {
    err = String(e.message || e);
  }
  clearTimeout(t);

  if (err && !served && !nearest && !ama) {
    return json({ ok: false, upstreamFailed: true,
      error: "ADWR service-area lookup failed: " + err }, 200);
  }

  const payload = {
    ok: true, lat, lon,
    served, nearest, ccn, ama,
    // The app previously claimed "exempt well allowed" everywhere in Arizona.
    // Outside an AMA that is broadly right; inside one it is not, and this is
    // the flag that should gate that copy.
    exemptWellLikely: !ama,
    note: served
      ? "This point falls inside a mapped community water system. That may make a well "
      + "unnecessary — but a boundary is not a connection. Ask the system what a hookup "
      + "costs here and whether capacity is available."
      : nearest
        ? "No mapped service area at this point. The nearest is about " + nearest.miles
        + " miles away, which is worth one phone call before assuming you must drill."
        : "No mapped community water system within 10 miles. Plan on a well, hauling, or "
        + "catchment.",
    source: {
      dataset: "ADWR CWS Service Areas, CCN franchise areas, AMA/INA boundaries",
      publisher: "Arizona Department of Water Resources",
      caveat: "ADWR rebuilds service-area boundaries on roughly a five-year cycle and relies "
        + "in part on what each system reports about itself, so treat a boundary as evidence "
        + "rather than proof. A CCN means a company is entitled to serve an area — not that a "
        + "main is in the ground."
    },
    cached: false
  };

  const res = json(payload, 200, true);
  await cache.put(key, res.clone());
  return res;
}
