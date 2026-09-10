/**
 * Cloudflare Pages Function — /api/apn?county=Apache&apn=203-34-019V
 *
 * Find an Arizona parcel by its number, in any of the 15 counties.
 *
 * The history matters, because it nearly cost a five-hour crawl.
 *
 * AZGeo's statewide parcel layer indexes only OBJECTID and geometry. A bare
 * `AZ_APN = '...'` is a full table scan across ~3.5M rows and times out past
 * 12 seconds, and `where=1=1` ordered by OBJECTID times out too, so the layer
 * cannot be paged out by ID either. The conclusion drawn from that was that
 * typed APN search needed the whole state crawled to static files first.
 *
 * That conclusion was wrong, and the fix is asking the user which county.
 * Pairing the APN predicate with a county-sized envelope lets the spatial
 * index cut the candidate set first, and the attribute scan then runs over one
 * county instead of the state. Measured against the live service: Apache
 * returns immediately, and so does Maricopa at roughly 1.5M parcels — the
 * worst case in Arizona. No crawl, no shards, no stale copy of the state to
 * maintain.
 *
 * Utah is not handled here. Its statewide layer does index PARCEL_ID, so
 * /api/parcel already searches all 29 counties directly.
 */

import { measure } from "./_geom.js";

/* Identify ourselves to the agencies we query. A Worker's fetch sends no
   User-Agent by default, and at least one Arizona county GIS answers an
   anonymous request with 403 — a failure that reads as "no data" rather than
   "you were refused". It also gives an administrator someone to contact if we
   are ever a nuisance. */
const UA = "BuildOffGrid/1.0 (+https://buildoffgrid.ogprep.com; contact via site)";
const AZ_PARCELS =
  "https://azgeo.az.gov/arcgis/rest/services/TerraSystems/AZParcel_Cache/MapServer/0/query";

const TIMEOUT_MS = 12000;          // the scan is the slow part; give it room
const CACHE_SECONDS = 60 * 60 * 24 * 30;
const SCHEMA = "v1";
const MAX_MATCHES = 25;

/* County envelopes, deliberately generous — a box that spills into a neighbour
   costs nothing, because every result is checked against the Source field
   before it is returned. Being too tight would silently lose edge parcels,
   which is the failure we cannot detect. */
const COUNTY_BOX = {
  "apache":     { s: 33.30, n: 37.05, w: -110.05, e: -109.00 },
  "cochise":    { s: 31.28, n: 32.48, w: -110.50, e: -109.00 },
  "coconino":   { s: 34.20, n: 37.05, w: -112.95, e: -110.70 },
  "gila":       { s: 33.05, n: 34.35, w: -111.75, e: -110.25 },
  "graham":     { s: 32.38, n: 33.60, w: -110.50, e: -109.15 },
  "greenlee":   { s: 32.38, n: 33.85, w: -109.55, e: -108.95 },
  "la paz":     { s: 33.00, n: 34.37, w: -114.85, e: -113.00 },
  "maricopa":   { s: 32.45, n: 34.10, w: -113.40, e: -110.98 },
  "mohave":     { s: 34.20, n: 37.05, w: -114.90, e: -112.75 },
  "navajo":     { s: 33.70, n: 37.05, w: -110.80, e: -109.94 },
  "pima":       { s: 31.28, n: 32.57, w: -113.40, e: -110.37 },
  "pinal":      { s: 32.38, n: 33.70, w: -112.25, e: -110.39 },
  "santa cruz": { s: 31.28, n: 31.83, w: -111.42, e: -110.40 },
  "yavapai":    { s: 33.90, n: 35.35, w: -113.40, e: -111.67 },
  "yuma":       { s: 31.98, n: 33.68, w: -114.87, e: -113.28 }
};

const COUNTY_NAMES = {
  "apache": "Apache", "cochise": "Cochise", "coconino": "Coconino", "gila": "Gila",
  "graham": "Graham", "greenlee": "Greenlee", "la paz": "La Paz", "maricopa": "Maricopa",
  "mohave": "Mohave", "navajo": "Navajo", "pima": "Pima", "pinal": "Pinal",
  "santa cruz": "Santa Cruz", "yavapai": "Yavapai", "yuma": "Yuma"
};

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

/* Counties print APNs with dashes, dots and spaces; the layer stores them bare.
   Stripping to [A-Z0-9] also means the value can never break out of the quoted
   SQL string below, so no escaping question arises. */
const normApn = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/* Not every row in this layer is a parcel. The coverage check turned up "NAP"
   sitting in AZ_APN in Pinal — road right-of-way, water, and similar slivers get
   placeholder values rather than numbers. Two reasons to catch them: a prefix
   search must not match junk, and a placeholder returned as a result would look
   like a real parcel with a strange number. Also rejects all-zero and
   single-repeated-digit numbers, which counties use the same way. */
const PLACEHOLDER = /^(NAP|ROW|ROWS|NONE|NA|N|UNK|UNKNOWN|TBD|NOPARCEL|WATER|RIVER|RR)$/;
const isPlaceholderApn = a => {
  const s = normApn(a);
  return !s || s.length < 4 || PLACEHOLDER.test(s) || /^(\d)\1*$/.test(s);
};

/* Render back into the dashed form Arizona assessors print, when it fits the
   common 8-digit-plus-optional-letter shape. */
function prettyApn(raw) {
  const s = normApn(raw);
  if (/^\d{8}[A-Z]?$/.test(s)) return s.slice(0, 3) + "-" + s.slice(3, 5) + "-" + s.slice(5);
  return s;
}

async function esri(params, signal) {
  const q = new URL(AZ_PARCELS);
  Object.entries({ f: "json", ...params }).forEach(([k, v]) => q.searchParams.set(k, v));
  const r = await fetch(q.toString(), { signal, headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("service returned " + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "query failed");
  return j.features || [];
}

async function search(where, box, signal) {
  return esri({
    where,
    geometry: `${box.w},${box.s},${box.e},${box.n}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326", outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "AZ_APN,AZ_Address,AZ_PlaceName,Source",
    returnGeometry: "true", geometryPrecision: "6",
    resultRecordCount: String(MAX_MATCHES)
  }, signal);
}

function shape(f, county) {
  const a = f.attributes;
  const m = measure(f.geometry);
  return {
    state: "AZ",
    county,
    apn: prettyApn(a.AZ_APN),
    apnRaw: clean(a.AZ_APN),
    address: clean(a.AZ_Address),
    place: clean(a.AZ_PlaceName),
    acres: m.acres,
    acresSource: m.acres != null ? "measured from mapped boundary" : null,
    centroid: m.centroid,
    boundary: m.boundary
  };
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const countyKey = (url.searchParams.get("county") || "").trim().toLowerCase()
    .replace(/\s*county$/, "").replace(/\s+/g, " ");
  const apn = normApn(url.searchParams.get("apn"));

  if (!countyKey || !apn) {
    return json({ ok: false, error: "county and apn are both required." }, 400);
  }
  const box = COUNTY_BOX[countyKey];
  if (!box) {
    return json({ ok: false, error: `Unknown county "${countyKey}".`,
      counties: Object.values(COUNTY_NAMES) }, 400);
  }
  if (isPlaceholderApn(apn)) {
    return json({ ok: false, error:
      `"${url.searchParams.get("apn")}" is not a parcel number. Some rows in the state layer ` +
      `carry placeholders like NAP for road right-of-way and similar slivers; searching for ` +
      `one would return those rather than a parcel.` }, 400);
  }
  const county = COUNTY_NAMES[countyKey];

  const key = `https://apn/${SCHEMA}/${countyKey}/${apn}`;
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return json({ ...(await hit.json()), cached: true }, 200, true);

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let feats = [], exact = true, err = null;

  try {
    feats = await search(`AZ_APN='${apn}'`, box, ctl.signal);

    // Nothing exact? Many counties suffix condo and split parcels off a shared
    // base number, and a listing often prints only the base. Widen once.
    if (!feats.length && apn.length >= 6) {
      feats = await search(`AZ_APN LIKE '${apn}%'`, box, ctl.signal);
      exact = false;
    }
  } catch (e) {
    err = String(e.message || e);
  }
  clearTimeout(t);

  if (err) {
    return json({ ok: false, upstreamFailed: true, county, apn,
      error: "Parcel lookup failed: " + err }, 200);
  }

  // The envelope is generous on purpose, so drop anything the layer attributes
  // to a different county rather than quietly returning a neighbour's parcel.
  const inCounty = feats.filter(f =>
    String(f.attributes.Source || "").toLowerCase().startsWith(countyKey) &&
    !isPlaceholderApn(f.attributes.AZ_APN));

  if (!inCounty.length) {
    return json({ ok: false, notFound: true, county, apn: prettyApn(apn),
      error: `No parcel numbered ${prettyApn(apn)} in ${county} County. ` +
             `Check the county — assessors reuse number patterns across the state — ` +
             `and note this layer carries only what the assessor has digitised.` }, 200);
  }

  const matches = inCounty.map(f => shape(f, county));
  const payload = {
    ok: true, county, query: prettyApn(apn), exact,
    count: matches.length,
    parcel: matches[0],
    matches,
    truncated: matches.length >= MAX_MATCHES,
    source: {
      dataset: "AZGeo statewide parcel cache",
      publisher: "Arizona State Land Department / county assessors",
      note: "Searched within the county envelope so the spatial index can narrow before " +
            "the parcel number is matched. Acreage is measured from the mapped boundary — " +
            "the assessor's drawing, not a survey — and will disagree with the deed, " +
            "sometimes materially on older rural splits. Ownership and valuation are not " +
            "in this layer and stay with the county."
    },
    cached: false
  };

  const res = json(payload, 200, true);
  await cache.put(key, res.clone());
  return res;
}
