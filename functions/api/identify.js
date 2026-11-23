/**
 * Cloudflare Pages Function — /api/identify?lat=..&lon=..
 *
 * What parcel is this point in?
 *
 * Arizona has no per-county adapter for most of the state — each assessor runs
 * their own GIS and we only speak Mohave and Yavapai. But AZGeo publishes a
 * statewide aggregation of county assessor parcels with APN, address and the
 * contributing county.
 *
 * The catch: that layer indexes only OBJECTID and geometry. An APN lookup is a
 * full table scan — measured at over 12 seconds and failing — so typed parcel
 * search is not viable against it. A SPATIAL query uses the geometry index and
 * returns in 60–130ms. So this endpoint answers "what is here", not "where is
 * this APN", and that is the direction the map picker needs anyway.
 *
 * Utah is served by its own statewide layer, which does index attributes, so
 * this covers both states through different services.
 */

const AZ_PARCELS =
  "https://azgeo.az.gov/arcgis/rest/services/TerraSystems/AZParcel_Cache/MapServer/0/query";
const UT_ROOT =
  "https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/";

const TIMEOUT_MS = 8000;
const CACHE_SECONDS = 60 * 60 * 24 * 30;
const SCHEMA = "v2";   // v2 adds acreage, centroid and boundary to the Arizona branch

const UT_COUNTIES = ["Beaver","Box Elder","Cache","Carbon","Daggett","Davis","Duchesne",
  "Emery","Garfield","Grand","Iron","Juab","Kane","Millard","Morgan","Piute","Rich","Salt Lake",
  "San Juan","Sanpete","Sevier","Summit","Tooele","Uintah","Utah","Wasatch","Washington",
  "Wayne","Weber"];

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

/* Arizona stores APNs without punctuation. County formats differ, so rather
   than guess at a canonical form, hand back both what the layer holds and a
   dashed rendering for the common 8-digit-plus-suffix pattern. */
function prettyApn(raw) {
  const s = String(raw || "").trim().toUpperCase();
  if (/^\d{8}[A-Z]?$/.test(s)) return s.slice(0,3) + "-" + s.slice(3,5) + "-" + s.slice(5);
  return s;
}

/* Acreage, centroid and a drawable boundary, measured from the parcel rings.
   Shared with /api/apn so the two cannot drift apart. See _geom.js for why we
   measure instead of reading the layer’s own area field. */
import { measure } from "./_geom.js";

/* Identify ourselves to the agencies we query. A Worker's fetch sends no
   User-Agent by default, and at least one Arizona county GIS answers an
   anonymous request with 403 — a failure that reads as "no data" rather than
   "you were refused". It also gives an administrator someone to contact if we
   are ever a nuisance. */
const UA = "BuildOffGrid/1.0 (+https://buildoffgrid.ogprep.com; contact via site)";
async function esri(url, params, signal) {
  const q = new URL(url);
  Object.entries({ f: "json", ...params }).forEach(([k, v]) => q.searchParams.set(k, v));
  const r = await fetch(q.toString(), { signal, headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("service returned " + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "query failed");
  return j.features || [];
}

/* Utah's per-county services need to be asked one at a time, so narrow by the
   county the caller already knows before trying anything. */
async function utahParcel(lat, lon, county, signal) {
  const names = county && UT_COUNTIES.includes(county) ? [county] : UT_COUNTIES;
  for (const name of names) {
    try {
      const feats = await esri(UT_ROOT + "Parcels_" + name.replace(/\s+/g, "") + "/FeatureServer/0/query", {
        geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", inSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        outFields: "PARCEL_ID,PARCEL_ADD,PARCEL_CITY,OWN_TYPE,RECORDER,CoParcel_URL,Shape__Area",
        returnGeometry: "true", returnCentroid: "true", outSR: "4326", resultRecordCount: "1"
      }, signal);
      if (!feats.length) continue;
      const a = feats[0].attributes, c = feats[0].centroid;
      // Measure the rings rather than trusting Shape__Area. Utah's is web
      // mercator and needs a 1/cos²(lat) correction; measuring sidesteps the
      // question and gives Arizona and Utah one method between them.
      const m = measure(feats[0].geometry);
      return {
        state: "UT", county: name,
        apn: clean(a.PARCEL_ID),
        address: [clean(a.PARCEL_ADD), clean(a.PARCEL_CITY)].filter(Boolean).join(", ") || null,
        acres: m.acres,
        acresSource: m.acres != null ? "measured from mapped boundary" : null,
        ownershipType: clean(a.OWN_TYPE),
        recorderPhone: clean(a.RECORDER),
        countySite: clean(a.CoParcel_URL),
        centroid: m.centroid || (c ? { lat: +(+c.y).toFixed(6), lon: +(+c.x).toFixed(6) } : null),
        boundary: m.boundary
      };
    } catch (_) { /* try the next county */ }
  }
  return null;
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));
  const county = (url.searchParams.get("county") || "").trim();

  if (!isFinite(lat) || !isFinite(lon)) {
    return json({ ok: false, error: "lat and lon are required" }, 400);
  }

  const inAZ = lat >= 31 && lat <= 37.1 && lon >= -115 && lon <= -108.9;
  const inUT = lat >= 36.9 && lat <= 42.1 && lon >= -114.1 && lon <= -108.9;
  if (!inAZ && !inUT) {
    return json({ ok: false, outsideCoverage: true,
      error: "That point is outside Arizona and Utah." }, 200);
  }

  const key = `https://identify/${SCHEMA}/${lat.toFixed(5)},${lon.toFixed(5)}/${county}`;
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return json({ ...(await hit.json()), cached: true }, 200, true);

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let parcel = null, err = null;

  try {
    if (inUT) parcel = await utahParcel(lat, lon, county, ctl.signal);

    if (!parcel && inAZ) {
      const feats = await esri(AZ_PARCELS, {
        geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", inSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        outFields: "AZ_APN,AZ_Address,AZ_PlaceName,Source",
        returnGeometry: "true", geometryPrecision: "6", outSR: "4326",
        resultRecordCount: "1"
      }, ctl.signal);
      if (feats.length) {
        const a = feats[0].attributes;
        const m = measure(feats[0].geometry);
        parcel = {
          state: "AZ",
          county: String(a.Source || "").replace(/\s*County$/i, "").trim() || null,
          apn: prettyApn(a.AZ_APN),
          apnRaw: clean(a.AZ_APN),
          address: clean(a.AZ_Address),
          place: clean(a.AZ_PlaceName),
          // Measured from the mapped boundary — the layer publishes no area we can trust.
          acres: m.acres,
          acresSource: m.acres != null ? "measured from mapped boundary" : null,
          centroid: m.centroid,
          boundary: m.boundary
          // Ownership and valuation are not in this layer.
        };
      }
    }
  } catch (e) {
    err = String(e.message || e);
  }
  clearTimeout(t);

  if (!parcel) {
    return json({ ok: false, notFound: true, lat, lon,
      error: err
        ? "Parcel lookup failed: " + err
        : "No mapped parcel at that point. It may be federal or state trust land, a road " +
          "right-of-way, or simply outside what the county has digitised.",
      upstreamFailed: !!err }, 200);
  }

  const payload = {
    ok: true, lat, lon, ...parcel,
    source: parcel.state === "AZ"
      ? { dataset: "AZGeo statewide parcel cache", publisher: "Arizona State Land Department / county assessors",
          note: "Aggregated from county assessors. The layer carries only parcel number and address, so " +
                "acreage here is measured from the mapped boundary — the assessor's drawing, not a survey. " +
                "Expect it to disagree with the deed, sometimes materially on older rural splits. " +
                "Ownership and valuation stay with the county." }
      : { dataset: parcel.county + " County parcels", publisher: "UGRC / county recorder",
          note: "Statewide layer required by HB113 (2005). Owner name and assessed value are excluded by statute." },
    cached: false
  };

  const res = json(payload, 200, true);
  await cache.put(key, res.clone());
  return res;
}
