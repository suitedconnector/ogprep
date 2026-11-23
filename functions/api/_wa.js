/**
 * Washington helpers shared by the WA Functions (identify, parcel, slope,
 * wawater, wawells, hazards).
 *
 * Parcels come from the statewide "Current Parcels" layer WaTech assembles
 * from all 39 county assessors. Unlike Arizona's statewide layer, its
 * attribute fields answer a query quickly once the county narrows it, so one
 * layer covers point, parcel-number and address search everywhere.
 *
 * Verified against 281 Stewart Rd, Stevenson on 2026-11-23; see
 * docs/wa-test-parcel-stewart-rd.md.
 */
import { measure } from "./_geom.js";

export const WA_PARCELS =
  "https://services.arcgis.com/jsIt88o09Q0r1j8h/arcgis/rest/services/Current_Parcels/FeatureServer/0";

/* Ecology's and some county servers answer an anonymous script with 403; a
   browser-like User-Agent with a contact line is accepted. */
export const UA = "Mozilla/5.0 (compatible; CostToLivable/1.0; +https://buildoffgrid.ogprep.com)";

export const inWA = (lat, lon) => lat >= 45.5 && lat <= 49.05 && lon >= -124.85 && lon <= -116.9;

/* [name, FIPS]. The layer's COUNTY_NM field is inconsistent (mostly the FIPS
   number without padding, a few names, and Asotin's FIPS_NR is null), so a
   county filter matches either field. */
export const WA_COUNTIES = [
  ["Adams","001"],["Asotin","003"],["Benton","005"],["Chelan","007"],["Clallam","009"],["Clark","011"],
  ["Columbia","013"],["Cowlitz","015"],["Douglas","017"],["Ferry","019"],["Franklin","021"],["Garfield","023"],
  ["Grant","025"],["Grays Harbor","027"],["Island","029"],["Jefferson","031"],["King","033"],["Kitsap","035"],
  ["Kittitas","037"],["Klickitat","039"],["Lewis","041"],["Lincoln","043"],["Mason","045"],["Okanogan","047"],
  ["Pacific","049"],["Pend Oreille","051"],["Pierce","053"],["San Juan","055"],["Skagit","057"],["Skamania","059"],
  ["Snohomish","061"],["Spokane","063"],["Stevens","065"],["Thurston","067"],["Wahkiakum","069"],
  ["Walla Walla","071"],["Whatcom","073"],["Whitman","075"],["Yakima","077"]
];
const key = s => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
export const countyByKey = k => WA_COUNTIES.find(([n]) => key(n) === key(k)) || null;
export const countyByFips = f => WA_COUNTIES.find(([, x]) => x === String(f || "").padStart(3, "0")) || null;

function countyWhere([name, fips]) {
  const nm = [String(+fips), name, name.replace(/\s+/g, "")].map(v => `'${v.replace(/'/g, "''")}'`).join(",");
  return `(FIPS_NR='${fips}' OR COUNTY_NM IN (${nm}))`;
}

export async function getJson(url, { body, timeout = 12000, signal } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  if (signal) signal.addEventListener("abort", () => ctl.abort());
  try {
    const r = await fetch(url, {
      method: body ? "POST" : "GET", body, signal: ctl.signal,
      headers: { "User-Agent": UA, ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) }
    });
    if (!r.ok) throw new Error("service returned " + r.status);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || "query failed");
    return j;
  } finally { clearTimeout(t); }
}

/* ArcGIS query by POST, so a parcel polygon fits. Objects are JSON-encoded. */
export async function arcQuery(layerUrl, params, opts) {
  const body = new URLSearchParams(Object.entries({ f: "json", ...params })
    .map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)])).toString();
  return getJson(layerUrl + "/query", { ...opts, body });
}

/* "lat lon" pairs in [[lat,lon],...] (the app's boundary format) or the poly
   query string "lon lat,lon lat,..." → esri polygon in 4326. */
export function polyFromParam(raw, max = 400) {
  if (!raw) return null;
  const pts = raw.split(",").map(p => p.trim().split(/\s+/).map(Number));
  if (pts.length < 3 || pts.length > max) return null;
  for (const [x, y] of pts) if (!isFinite(x) || !isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90) return null;
  const ring = pts.slice();
  if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) ring.push(ring[0]);
  return { rings: [ring], spatialReference: { wkid: 4326 } };
}

/* A circle of `metres` around a point, as an esri polygon. Used when no
   parcel outline is known; callers label the result "around this point". */
export function circle(lat, lon, metres = 100, n = 32) {
  const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 111320;
  const ring = [];
  for (let i = 0; i <= n; i++) {
    const a = 2 * Math.PI * i / n;
    ring.push([+(lon + metres * Math.cos(a) / kx).toFixed(7), +(lat + metres * Math.sin(a) / ky).toFixed(7)]);
  }
  return { rings: [ring], spatialReference: { wkid: 4326 } };
}

const clean = v => {
  const s = String(v == null ? "" : v).trim();
  return (!s || /^(none|n\/?a|null|unknown|0)$/i.test(s)) ? null : s;
};

/* One statewide parcel feature → the shape the app already reads for Utah. */
function toParcel(f) {
  const a = f.attributes;
  const c = countyByFips(a.FIPS_NR) || WA_COUNTIES.find(([n, x]) => String(+x) === String(a.COUNTY_NM) ||
                                                        key(n) === key(a.COUNTY_NM));
  const m = measure(f.geometry);
  return {
    state: "WA",
    county: c ? c[0] : null,
    apn: clean(a.ORIG_PARCEL_ID) || clean(a.PARCEL_ID_NR),
    statewideId: clean(a.PARCEL_ID_NR),
    address: [clean(a.SITUS_ADDRESS), clean(a.SITUS_CITY_NM)].filter(Boolean).join(", ") || null,
    acres: m.acres,
    acresSource: m.acres != null ? "measured from mapped boundary" : null,
    centroid: m.centroid,
    boundary: m.boundary,
    landUseCode: clean(a.LANDUSE_CD),
    countySite: clean(a.DATA_LINK)
  };
}

const PARCEL_FIELDS = "FIPS_NR,COUNTY_NM,PARCEL_ID_NR,ORIG_PARCEL_ID,SITUS_ADDRESS,SITUS_CITY_NM,LANDUSE_CD,DATA_LINK";

export async function parcelAtPoint(lat, lon, signal) {
  const j = await arcQuery(WA_PARCELS, {
    geometry: { x: lon, y: lat, spatialReference: { wkid: 4326 } }, geometryType: "esriGeometryPoint",
    inSR: 4326, spatialRel: "esriSpatialRelIntersects", outFields: PARCEL_FIELDS,
    returnGeometry: true, outSR: 4326, geometryPrecision: 6, resultRecordCount: 1
  }, { signal });
  return j.features.length ? toParcel(j.features[0]) : null;
}

/* Parcel number within one county. People type the county's own number
   (ORIG_PARCEL_ID) with or without punctuation; the statewide ID prefixes it
   with the FIPS code. Try exact, then digits-only, then prefix. */
export async function parcelsByApn(county, raw, signal) {
  const c = countyByKey(county); if (!c) return { unsupported: true };
  const t = String(raw || "").trim().toUpperCase().replace(/'/g, "''");
  const digits = t.replace(/[^0-9A-Z]/g, "");
  const tries = [
    `ORIG_PARCEL_ID='${t}' OR PARCEL_ID_NR='${t}'`,
    `ORIG_PARCEL_ID='${digits}' OR PARCEL_ID_NR='${c[1]}-${digits}'`,
    `ORIG_PARCEL_ID LIKE '${digits}%'`
  ];
  for (const w of tries) {
    const j = await arcQuery(WA_PARCELS, { where: `${countyWhere(c)} AND (${w})`, outFields: PARCEL_FIELDS,
      returnGeometry: true, outSR: 4326, geometryPrecision: 6, resultRecordCount: 12 }, { signal });
    if (j.features.length) return { county: c[0], parcels: j.features.map(toParcel) };
  }
  return { county: c[0], parcels: [] };
}

export async function parcelsByAddress(county, raw, signal) {
  const c = countyByKey(county); if (!c) return { unsupported: true };
  const t = String(raw || "").trim().toUpperCase().replace(/\s+/g, " ").replace(/'/g, "''")
    // The layer abbreviates street types; meet it halfway.
    .replace(/\bROAD\b/g, "RD").replace(/\bSTREET\b/g, "ST").replace(/\bAVENUE\b/g, "AVE")
    .replace(/\bDRIVE\b/g, "DR").replace(/\bLANE\b/g, "LN").replace(/\bPLACE\b/g, "PL")
    .replace(/\bHIGHWAY\b/g, "HWY").replace(/,.*$/, "");
  const j = await arcQuery(WA_PARCELS, { where: `${countyWhere(c)} AND UPPER(SITUS_ADDRESS) LIKE '${t}%'`,
    outFields: PARCEL_FIELDS, returnGeometry: true, outSR: 4326, geometryPrecision: 6, resultRecordCount: 12 }, { signal });
  return { county: c[0], parcels: j.features.map(toParcel) };
}

export const WA_PARCEL_SOURCE = {
  dataset: "Washington Current Parcels (statewide)",
  publisher: "WaTech / Washington county assessors",
  service: WA_PARCELS,
  note: "Assembled from county assessors for informational use, not survey. Acreage is measured from " +
        "the mapped boundary. Owner names are not shown here."
};

export const json = (b, s = 200, maxAge = 0) => new Response(JSON.stringify(b), {
  status: s,
  headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*",
             "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store" }
});
