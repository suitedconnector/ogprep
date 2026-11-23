#!/usr/bin/env node
/**
 * Washington test-parcel report.
 *
 *   node tools/wa-parcel-report.mjs
 *
 * Pulls every candidate Washington source for one parcel — 281 Stewart Road,
 * Stevenson (Skamania County) — and writes:
 *   docs/wa-test-parcel-stewart-rd.md            the report
 *   docs/WA/Skamania/stewart-rd-landslides.geojson  parcel + mapped landslides
 *   docs/WA/Skamania/stewart-rd-landslides.svg      the same, as a picture
 *   docs/WA/Skamania/stewart-rd-pull.json           key values, compared on the next run
 *
 * Nothing here is wired into the app. The point is to see, on one parcel,
 * which sources answer from a script, what they say, and whether it matches
 * what a third party (Buildability.us) reported. Every query URL goes in the
 * report so a pull can be repeated and checked by hand.
 *
 * Owner and person names are never written out. County and Ecology layers
 * carry them; the report needs parcel IDs, addresses and organisations only.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_MD = join(ROOT, "docs/wa-test-parcel-stewart-rd.md");
const OUT_DIR = join(ROOT, "docs/WA/Skamania");
const OUT_GEOJSON = join(OUT_DIR, "stewart-rd-landslides.geojson");
const OUT_SVG = join(OUT_DIR, "stewart-rd-landslides.svg");
const OUT_SNAP = join(OUT_DIR, "stewart-rd-pull.json");   // key values, for the repeat check

const ADDRESS = "281 Stewart Road, Stevenson, WA 98648";
const SITUS_LIKE = "281 STEWART%";
const FIPS = "059";                 // Skamania
const MILE_M = 1609.344;
const LANDSLIDE_TRIGGER_M = 30.48;  // SCC 19.07: within 100 ft of a mapped landslide

/* Ecology's servers answer an anonymous script with 403; a browser-like
   User-Agent with a contact line is accepted. */
const UA = "Mozilla/5.0 (compatible; CostToLivable/1.0; +https://buildoffgrid.ogprep.com)";

const SRC = {
  census: "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress",
  parcels: "https://services.arcgis.com/jsIt88o09Q0r1j8h/arcgis/rest/services/Current_Parcels/FeatureServer/0",
  county: "https://services3.arcgis.com/uKh72TYBlxpm42Cm/arcgis/rest/services",
  sda: "https://sdmdataaccess.nrcs.usda.gov/Tabular/post.rest",
  dem: "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer",
  wr: "https://services.arcgis.com/6lCKYNJLvwTXqrmp/arcgis/rest/services/WR/FeatureServer",
  doh: "https://services8.arcgis.com/rGGrs6HCnw87OFOT/arcgis/rest/services/Drinking_Water_Service_Areas/FeatureServer/0",
  plss: "https://gis.blm.gov/arcgis/rest/services/Cadastral/BLM_Natl_PLSS_CadNSDI/MapServer/3",
  power: "https://services6.arcgis.com/BAJNi3EgCdtQ1BCG/arcgis/rest/services/Electric_Retail_Service_Territories/FeatureServer/0"
};

const today = new Date().toISOString().slice(0, 10);
const log = (...a) => console.error(...a);

/* ---------- HTTP helpers ---------- */

function qs(params) {
  return new URLSearchParams(Object.entries(params).map(([k, v]) =>
    [k, typeof v === "object" ? JSON.stringify(v) : String(v)])).toString();
}

async function getJson(url, { method = "GET", body, timeout = 60000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, {
      method, body, signal: ctl.signal,
      headers: { "User-Agent": UA, ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) }
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
    const j = JSON.parse(text);
    if (j.error) throw new Error(`service error: ${JSON.stringify(j.error).slice(0, 200)}`);
    return j;
  } finally { clearTimeout(t); }
}

/* ArcGIS query. Long geometries go by POST; the logged URL drops the
   geometry so the report stays readable, and says so. */
async function arcQuery(layerUrl, params, label) {
  const p = { f: "json", ...params };
  const url = `${layerUrl}/query`;
  const shown = { ...p };
  if (shown.geometry && JSON.stringify(shown.geometry).length > 120) shown.geometry = "<parcel polygon>";
  if (shown.objectIds) shown.objectIds = `<${String(shown.objectIds).split(",").length} ids>`;
  if (shown.where && shown.where.length > 160) shown.where = shown.where.replace(/IN \(([^)]*)\)/, (_, l) => `IN (<${l.split(",").length} ids>)`);
  queries.push({ label, url: `${url}?${qs(shown)}` });
  return getJson(url, { method: "POST", body: qs(p) });
}

async function sda(sql, label) {
  queries.push({ label, url: `${SRC.sda} (POST) ${sql.replace(/\s+/g, " ").trim().slice(0, 160)}…` });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 60000);
  try {
    const r = await fetch(SRC.sda, {
      method: "POST", signal: ctl.signal,
      headers: { "User-Agent": UA, "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql, format: "JSON" })
    });
    if (!r.ok) throw new Error("SDA HTTP " + r.status + ": " + (await r.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200));
    return (await r.json()).Table || [];
  } finally { clearTimeout(t); }
}

const queries = [];   // every request, for the report's appendix

/* ---------- geometry helpers ---------- */

const M_PER_DEG_LAT = 111320;
function ringAreaM2(ring) {
  const lat0 = ring[0][1] * Math.PI / 180, kx = M_PER_DEG_LAT * Math.cos(lat0);
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length];
    a += (x0 * kx) * (y1 * M_PER_DEG_LAT) - (x1 * kx) * (y0 * M_PER_DEG_LAT);
  }
  return Math.abs(a / 2);
}
function centroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length];
    const f = x0 * y1 - x1 * y0; a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  a /= 2;
  return [cx / (6 * a), cy / (6 * a)];
}
function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo));
}
const degToGrade = d => Math.tan(d * Math.PI / 180) * 100;
const gradeToDeg = g => Math.atan(g / 100) * 180 / Math.PI;

/* Run one section; a failure is recorded, not fatal. */
const results = {};
async function step(key, fn) {
  log("…", key);
  try { results[key] = { ok: true, ...(await fn()) }; }
  catch (e) { results[key] = { ok: false, error: String(e.message || e) }; log("  failed:", e.message); }
}

/* ---------- 1. Geocode ---------- */

await step("geocode", async () => {
  const url = `${SRC.census}?${qs({ address: ADDRESS, benchmark: "Public_AR_Current", format: "json" })}`;
  queries.push({ label: "Census geocoder", url });
  const j = await getJson(url);
  const m = j.result && j.result.addressMatches || [];
  return { matches: m.length, first: m[0] ? { lat: m[0].coordinates.y, lon: m[0].coordinates.x, matched: m[0].matchedAddress } : null };
});

/* ---------- 2. Parcel (WA statewide, then county) ---------- */

let parcel = null;   // { id, ring:[[lon,lat]...], esri, centroid:[lon,lat], acres, attrs }
await step("parcel", async () => {
  const j = await arcQuery(SRC.parcels, {
    where: `FIPS_NR='${FIPS}' AND SITUS_ADDRESS LIKE '${SITUS_LIKE}'`,
    outFields: "PARCEL_ID_NR,ORIG_PARCEL_ID,SITUS_ADDRESS,SITUS_CITY_NM,LANDUSE_CD,VALUE_LAND,VALUE_BLDG,DATA_LINK",
    returnGeometry: true, outSR: 4326
  }, "WA statewide parcels — address search");
  if (!j.features.length) throw new Error("no parcel matched the address");
  const f = j.features[0];
  const rings = f.geometry.rings;
  const outer = rings.reduce((a, b) => ringAreaM2(b) > ringAreaM2(a) ? b : a);
  const m2 = rings.reduce((s, r) => s + ringAreaM2(r), 0);
  parcel = {
    id: f.attributes.PARCEL_ID_NR, ring: outer,
    esri: { rings, spatialReference: { wkid: 4326 } },
    centroid: centroid(outer), acres: m2 / 4046.8564224, attrs: f.attributes
  };
  return { matches: j.features.length, ...parcel, esri: undefined };
});
if (!parcel) { log("No parcel; cannot continue."); process.exit(1); }
const [CLON, CLAT] = parcel.centroid;
const geomParams = { geometry: parcel.esri, geometryType: "esriGeometryPolygon", inSR: 4326, spatialRel: "esriSpatialRelIntersects" };
const near = (metres) => ({ geometry: { x: CLON, y: CLAT, spatialReference: { wkid: 4326 } }, geometryType: "esriGeometryPoint",
  inSR: 4326, spatialRel: "esriSpatialRelIntersects", distance: metres, units: "esriSRUnit_Meter" });

await step("countyParcel", async () => {
  const j = await arcQuery(`${SRC.county}/Parcel/FeatureServer/0`, {
    ...geomParams, outFields: "PARCEL_ID,Situs,LegalDesc,DeedAcres,GIS_Acre,PropClass,SubdivName,Assess_URL", returnGeometry: false
  }, "Skamania parcel layer — same parcel");
  // The county layer touches neighbours along shared edges; keep the one whose ID matches.
  const want = String(parcel.id).replace(/\D/g, "").replace(/^059/, "");
  const hit = j.features.map(f => f.attributes).find(a => String(a.PARCEL_ID).replace(/\D/g, "").includes(want.slice(0, 12)))
           || j.features[0] && j.features[0].attributes;
  return { record: hit || null, candidates: j.features.length };
});

/* ---------- 3. Neighbours ---------- */

await step("neighbors", async () => {
  const fields = "PARCEL_ID,Situs,PropClass,GIS_Acre";
  const touch = await arcQuery(`${SRC.county}/Parcel/FeatureServer/0`, { ...geomParams, outFields: fields, returnGeometry: false },
    "Skamania parcels touching the test parcel");
  const within = await arcQuery(`${SRC.county}/Parcel/FeatureServer/0`,
    { ...geomParams, distance: 25, units: "esriSRUnit_Meter", outFields: fields, returnGeometry: false },
    "Skamania parcels within 25 m");
  const self = results.countyParcel.ok && results.countyParcel.record ? results.countyParcel.record.PARCEL_ID : null;
  const touchIds = new Set(touch.features.map(f => f.attributes.PARCEL_ID));
  const list = within.features.map(f => f.attributes).filter(a => a.PARCEL_ID !== self)
    .map(a => ({ id: a.PARCEL_ID, situs: a.Situs || null, propClass: a.PropClass || null,
                 acres: a.GIS_Acre != null ? +(+a.GIS_Acre).toFixed(2) : null, touching: touchIds.has(a.PARCEL_ID) }));
  list.sort((a, b) => (b.touching - a.touching) || String(a.id).localeCompare(String(b.id)));
  return { list };
});

/* ---------- 4. Soil (SDA, every component, every map unit on the parcel) ---------- */

await step("soil", async () => {
  const ring = [...parcel.ring];
  if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) ring.push(ring[0]);
  const wkt = `POLYGON((${ring.map(([x, y]) => `${x} ${y}`).join(",")}))`;
  const RULE = "ENG - Septic Tank Absorption Fields";
  const rows = await sda(`
    SELECT mu.mukey, mu.muname, mu.musym, co.compname, co.comppct_r, co.majcompflag,
           co.slope_l, co.slope_r, co.slope_h, co.drainagecl,
           (SELECT TOP 1 ci.interphrc FROM cointerp ci WHERE ci.cokey = co.cokey
              AND ci.mrulename = '${RULE}' AND ci.rulename = '${RULE}') AS septic,
           (SELECT TOP 1 tg.texdesc FROM chorizon ch
              INNER JOIN chtexturegrp tg ON tg.chkey = ch.chkey AND tg.rvindicator = 'Yes'
              WHERE ch.cokey = co.cokey ORDER BY ch.hzdept_r) AS h1,
           (SELECT TOP 1 ch.claytotal_r FROM chorizon ch WHERE ch.cokey = co.cokey ORDER BY ch.hzdept_r) AS clay
    FROM mapunit mu INNER JOIN component co ON co.mukey = mu.mukey
    WHERE mu.mukey IN (SELECT * FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('${wkt}'))
    ORDER BY mu.mukey, co.comppct_r DESC`, "SDA — every component of every map unit on the parcel");
  const reasons = await sda(`
    SELECT DISTINCT ci.rulename, ci.interphr
    FROM component co INNER JOIN cointerp ci ON ci.cokey = co.cokey
    WHERE co.mukey IN (SELECT * FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('${wkt}'))
      AND ci.mrulename = '${RULE}' AND ci.rulename <> '${RULE}' AND ci.interphr > 0`,
    "SDA — septic limiting features");
  const comps = rows.map(r => ({ mukey: r[0], mapunit: r[1], musym: r[2], name: r[3], pct: +r[4] || 0, major: r[5] === "Yes",
    slope: [r[6], r[7], r[8]].map(v => v == null ? null : +v), drainage: r[9], septic: r[10], surfaceTexture: r[11], surfaceClayPct: r[12] == null ? null : +r[12] }));
  const veryLimitedPct = comps.filter(c => /very limited/i.test(c.septic || "")).reduce((s, c) => s + c.pct, 0);
  return { comps, mapunits: [...new Set(comps.map(c => c.mukey))].length, veryLimitedPct,
           reasons: reasons.map(r => ({ rule: String(r[0]).replace(/^ENG\s*-\s*/, ""), score: +r[1] })).sort((a, b) => b.score - a.score) };
});

/* ---------- 5. Slope (USGS 3DEP) ---------- */

await step("slope", async () => {
  const sampleUrl = `${SRC.dem}/getSamples`;
  const sp = { geometry: { x: CLON, y: CLAT, spatialReference: { wkid: 4326 } }, geometryType: "esriGeometryPoint",
               returnFirstValueOnly: true, outFields: "*", f: "json" };
  queries.push({ label: "3DEP elevation sample at centroid", url: `${sampleUrl}?${qs(sp)}` });
  const s = await getJson(sampleUrl, { method: "POST", body: qs(sp) });
  const sample = s.samples && s.samples[0] || null;

  const histUrl = `${SRC.dem}/computeStatisticsHistograms`;
  const runs = [];
  for (const px of [1, 10]) {
    const hp = {
      geometry: parcel.esri, geometryType: "esriGeometryPolygon",
      renderingRule: { rasterFunction: "Slope Degrees" },
      pixelSize: { x: px, y: px, spatialReference: { wkid: 3857 } }, f: "json"
    };
    queries.push({ label: `3DEP slope histogram, ${px} m pixel`, url: `${histUrl}?${qs({ ...hp, geometry: "<parcel polygon>" })}` });
    const h = await getJson(histUrl, { method: "POST", body: qs(hp) });
    const st = h.statistics && h.statistics[0], hist = h.histograms && h.histograms[0];
    let over15 = null, over30 = null;
    if (hist) {
      const n = hist.counts.reduce((a, b) => a + b, 0), w = (hist.max - hist.min) / hist.size;
      const share = deg => {
        let c = 0;
        hist.counts.forEach((k, i) => { const lo = hist.min + i * w, hi = lo + w;
          if (lo >= deg) c += k; else if (hi > deg) c += k * (hi - deg) / w; });
        return Math.round(100 * c / n);
      };
      over15 = share(gradeToDeg(15)); over30 = share(gradeToDeg(30));
    }
    runs.push({ pixel: px, min: st && st.min, max: st && st.max, mean: st && +(+st.mean).toFixed(1), over15, over30 });
  }
  return { sample: sample ? { elevation: +(+sample.value).toFixed(1), rasterId: sample.rasterId,
                              name: sample.attributes && (sample.attributes.Name || sample.attributes.ProductName) || null } : null,
           runs };
});

/* ---------- 6. Water service area (WA DOH) ---------- */

await step("waterService", async () => {
  const j = await arcQuery(SRC.doh, { ...geomParams,
    outFields: "WS_Name,WS_ID,WS_Grp,WS_Type,ServiceAreaType,Contact_Phone,WS_City,WS_Status,Total_Conn,DataSourceDate,UpdateDateTime",
    returnGeometry: false }, "WA DOH drinking water service areas");
  return { systems: j.features.map(f => f.attributes) };
});

/* ---------- 7. Water rights (Ecology) ---------- */

const PHASE_LABEL = { CL: "Claim", CE: "Certificate", PE: "Permit", AP: "New application", CH: "Change", CP: "Change" };
await step("waterRights", async () => {
  const pou = `${SRC.wr}/6`;
  const onParcel = await arcQuery(pou, { ...geomParams, outFields: "WR_DOC_ID,WR_Doc_Type_CD", returnGeometry: false },
    "Ecology places of use covering the parcel");
  const mile = await arcQuery(pou, { ...near(MILE_M), outFields: "WR_DOC_ID,WR_Doc_Type_CD", returnGeometry: false },
    "Ecology places of use within 1 mile");
  const ids = [...new Set(mile.features.map(f => f.attributes.WR_DOC_ID))];
  const docs = new Map();
  for (let i = 0; i < ids.length; i += 150) {
    const part = ids.slice(i, i + 150);
    const t = await arcQuery(`${SRC.wr}/10`, {
      where: `WR_Doc_ID IN (${part.join(",")})`,
      outFields: "WR_Doc_ID,WaRecPhaseTypeCode,WaRecProcessStatusTypeCode,WaRecRCWClassTypeCode,WaRecPrimaryNumber,PriorityDate,PurposeOfUseTypeCodes,InstantaneousQuantity,InstantaneousUnitCode,AnnualVolumeQuantity,PersonLastOrOrganizationNM,PersonFirstNM,PartyRoleTypeCode",
      returnGeometry: false
    }, `Ecology water-right records (batch ${i / 150 + 1})`);
    for (const f of t.features) {
      const a = f.attributes;
      if (!docs.has(a.WR_Doc_ID)) docs.set(a.WR_Doc_ID, a);
    }
  }
  const all = [...docs.values()];
  const count = key => all.reduce((m, a) => (m[a[key] || "(blank)"] = (m[a[key] || "(blank)"] || 0) + 1, m), {});
  const parcelIds = new Set(onParcel.features.map(f => f.attributes.WR_DOC_ID));
  const covering = all.filter(a => parcelIds.has(a.WR_Doc_ID)).map(a => ({
    number: a.WaRecPrimaryNumber, phase: a.WaRecPhaseTypeCode, status: a.WaRecProcessStatusTypeCode,
    source: a.WaRecRCWClassTypeCode, purpose: String(a.PurposeOfUseTypeCodes || "").trim(),
    priority: a.PriorityDate ? new Date(a.PriorityDate).toISOString().slice(0, 10) : null,
    qi: a.InstantaneousQuantity != null ? `${a.InstantaneousQuantity} ${a.InstantaneousUnitCode || ""}`.trim() : null,
    qa: a.AnnualVolumeQuantity,
    // Organisations only. A person's name never goes in the report.
    holder: a.PersonFirstNM ? "(individual — not shown)" : (a.PersonLastOrOrganizationNM || null)
  }));
  return { withinMile: all.length, byPhase: count("WaRecPhaseTypeCode"), byStatus: count("WaRecProcessStatusTypeCode"),
           bySource: count("WaRecRCWClassTypeCode"), covering, coveringCount: parcelIds.size };
});

/* ---------- 8. Well reports (Ecology) + PLSS ---------- */

await step("plss", async () => {
  const j = await arcQuery(SRC.plss, { geometry: { x: CLON, y: CLAT, spatialReference: { wkid: 4326 } }, geometryType: "esriGeometryPoint",
    inSR: 4326, spatialRel: "esriSpatialRelIntersects", outFields: "TWNSHPNO,TWNSHPDIR,RANGENO,RANGEDIR,FRSTDIVNO,QQSEC", returnGeometry: false },
    "BLM PLSS quarter-quarter at the parcel centroid");
  const a = j.features[0] && j.features[0].attributes;
  if (!a) throw new Error("no PLSS cell");
  return { twp: +a.TWNSHPNO, twpDir: a.TWNSHPDIR, rng: +a.RANGENO, rngDir: a.RANGEDIR, sec: +a.FRSTDIVNO, qq: a.QQSEC };
});

await step("wells", async () => {
  const layer = `${SRC.wr}/9`;
  // resultOffset paging stops early on this layer; fetch IDs, then batches.
  const idq = await arcQuery(layer, { ...near(MILE_M), returnIdsOnly: true }, "Ecology well reports within 1 mile (IDs)");
  const ids = idq.objectIds || [];
  const rows = [];
  for (let i = 0; i < ids.length; i += 200) {
    const j = await arcQuery(layer, { objectIds: ids.slice(i, i + 200).join(","),
      outFields: "OBJECTID,WellProjectType,WellSubType,CompletedDepth,StaticWaterLvl,FlowRateGPM,WorkCompletionDate,TownshipNr,RangeNr,SectionNr,Qtr,QtrQtr,LatitudeDecimalQuantity,FileName",
      returnGeometry: true, outSR: 4326 }, `Ecology well reports (batch ${i / 200 + 1})`);
    rows.push(...j.features.map(f => ({ ...f.attributes, x: f.geometry && f.geometry.x, y: f.geometry && f.geometry.y })));
  }
  const water = rows.filter(r => r.WellProjectType === "Water");
  const depths = water.map(r => +r.CompletedDepth).filter(v => v > 0).sort((a, b) => a - b);
  const swl = water.map(r => +r.StaticWaterLvl).filter(v => v > 0).sort((a, b) => a - b);
  const locs = new Set(rows.map(r => r.x != null ? `${r.x.toFixed(5)},${r.y.toFixed(5)}` : "none"));
  const ownLatLon = rows.filter(r => r.LatitudeDecimalQuantity).length;
  const P = results.plss.ok ? results.plss : null;
  const inQQ = P ? rows.filter(r => +r.SectionNr === P.sec && +r.TownshipNr === P.twp && +r.RangeNr === P.rng &&
                                   `${r.QtrQtr || ""}${r.Qtr || ""}` === P.qq) : [];
  const byType = rows.reduce((m, r) => { const k = `${r.WellProjectType || "(blank)"} / ${r.WellSubType || "(blank)"}`; m[k] = (m[k] || 0) + 1; return m; }, {});
  return {
    total: rows.length, distinctLocations: locs.size, ownLatLon, byType,
    water: { n: water.length, withDepth: depths.length, min: depths[0] ?? null, p25: pct(depths, .25), median: pct(depths, .5),
             p75: pct(depths, .75), max: depths.at(-1) ?? null, swlN: swl.length, swlMedian: pct(swl, .5),
             flowN: water.filter(r => +r.FlowRateGPM > 0).length },
    inQQ: inQQ.map(r => ({ type: r.WellProjectType, sub: r.WellSubType, depth: r.CompletedDepth,
                           year: r.WorkCompletionDate ? new Date(r.WorkCompletionDate).getUTCFullYear() : null, file: r.FileName }))
  };
});

/* ---------- 9. County layers: landslides, zoning, city, urban area ---------- */

const landslideFeatures = [];
await step("landslides", async () => {
  const out = {};
  for (const [key, path, fields] of [
    ["deposits", "Landslide_Deposit/FeatureServer/21", "LANDSLIDE_ID,LS_NAME,MATERIAL,MOVEMENT,CONFIDENCE,RELATIVE_AGE,FIELD_VERIFIED"],
    ["scarps", "Scarps_and_Flanks/FeatureServer/3", "LANDSLIDE_ID,SCARP_FLANK_ID"],
    ["recent", "Recent_Landslides/FeatureServer/1", "*"]
  ]) {
    const on = await arcQuery(`${SRC.county}/${path}`, { ...geomParams, outFields: fields, returnGeometry: false },
      `Skamania ${key} intersecting the parcel`);
    const trig = await arcQuery(`${SRC.county}/${path}`,
      { ...geomParams, distance: LANDSLIDE_TRIGGER_M, units: "esriSRUnit_Meter", outFields: fields,
        returnGeometry: key !== "recent", outSR: 4326, geometryPrecision: 6 },
      `Skamania ${key} within 100 ft of the parcel (SCC 19.07 trigger)`);
    const onIds = new Set(on.features.map(f => JSON.stringify(f.attributes)));
    out[key] = trig.features.map(f => ({ ...f.attributes, onParcel: onIds.has(JSON.stringify(
      Object.fromEntries(Object.keys(on.features[0] ? on.features[0].attributes : f.attributes).map(k => [k, f.attributes[k]])))) }));
    if (key !== "recent") for (const f of trig.features) landslideFeatures.push({ kind: key, attrs: f.attributes, rings: f.geometry.rings });
  }
  const study = await arcQuery(`${SRC.county}/Study_Areas/FeatureServer/12`, { ...geomParams, outFields: "CITATION_CODE,YR_PUBLISHED,CITATION,URL", returnGeometry: false },
    "Skamania landslide study areas covering the parcel");
  out.study = study.features.map(f => f.attributes);
  return out;
});

await step("planning", async () => {
  const z = await arcQuery(`${SRC.county}/Zoning_Designation/FeatureServer/0`, { ...geomParams, outFields: "Zoning,ZoneCode,ZoneDesc,CompPlan,Zoning_URL", returnGeometry: false }, "Skamania zoning");
  const c = await arcQuery(`${SRC.county}/CityLimits/FeatureServer/0`, { ...geomParams, outFields: "CITY_NAME", returnGeometry: false }, "Skamania city limits");
  const u = await arcQuery(`${SRC.county}/Urban_Areas/FeatureServer/0`, { ...geomParams, outFields: "Name,Acres", returnGeometry: false }, "Skamania urban areas");
  return { zoning: z.features.map(f => f.attributes), city: c.features.map(f => f.attributes), urban: u.features.map(f => f.attributes) };
});

/* ---------- 10. Electric territory (the layer /api/power already uses) ---------- */

await step("power", async () => {
  const j = await arcQuery(SRC.power, { geometry: { x: CLON, y: CLAT, spatialReference: { wkid: 4326 } }, geometryType: "esriGeometryPoint",
    inSR: 4326, spatialRel: "esriSpatialRelIntersects", outFields: "NAME,TYPE", returnGeometry: false },
    "Electric retail service territories (layer used by /api/power)");
  return { territories: j.features.map(f => f.attributes) };
});

/* ---------- Map: GeoJSON + SVG ---------- */

const close = r => (r[0][0] === r.at(-1)[0] && r[0][1] === r.at(-1)[1]) ? r : [...r, r[0]];
const geojson = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { name: `Parcel ${parcel.id}`, kind: "parcel", stroke: "#111111", "stroke-width": 3, "fill-opacity": 0 },
      geometry: { type: "Polygon", coordinates: [close(parcel.ring)] } },
    ...landslideFeatures.map(f => ({
      type: "Feature",
      properties: { kind: f.kind === "deposits" ? "landslide deposit" : "scarp or flank",
        name: f.attrs.LS_NAME || (f.attrs.LANDSLIDE_ID != null ? `Landslide #${f.attrs.LANDSLIDE_ID}` : null), ...f.attrs,
        fill: f.kind === "deposits" ? "#d9822b" : "#a83232", "fill-opacity": f.kind === "deposits" ? 0.3 : 0.5,
        stroke: f.kind === "deposits" ? "#d9822b" : "#a83232" },
      geometry: { type: "Polygon", coordinates: f.rings.map(close) }
    }))
  ]
};

function svgMap() {
  const W = 640, H = 520, PAD_M = 250;
  const lat0 = CLAT * Math.PI / 180, kx = M_PER_DEG_LAT * Math.cos(lat0);
  const xs = parcel.ring.map(p => p[0]), ys = parcel.ring.map(p => p[1]);
  const minX = Math.min(...xs) - PAD_M / kx, maxX = Math.max(...xs) + PAD_M / kx;
  const minY = Math.min(...ys) - PAD_M / M_PER_DEG_LAT, maxY = Math.max(...ys) + PAD_M / M_PER_DEG_LAT;
  const s = Math.min(W / ((maxX - minX) * kx), H / ((maxY - minY) * M_PER_DEG_LAT));
  const px = ([x, y]) => [((x - minX) * kx * s).toFixed(1), (H - (y - minY) * M_PER_DEG_LAT * s).toFixed(1)];
  const path = rings => rings.map(r => "M" + r.map(p => px(p).join(",")).join("L") + "Z").join("");
  const scaleM = 100, scalePx = scaleM * s;
  const label = f => f.attrs.LS_NAME || (f.attrs.LANDSLIDE_ID != null ? `Landslide #${f.attrs.LANDSLIDE_ID}` : "Landslide");
  // Largest first, so a small slide inside a big one is drawn on top.
  const deps = landslideFeatures.filter(f => f.kind === "deposits")
    .sort((a, b) => b.rings.reduce((s, r) => s + ringAreaM2(r), 0) - a.rings.reduce((s, r) => s + ringAreaM2(r), 0));
  const COLORS = ["#d9822b", "#4f8fbf", "#8c6bb1", "#5a9e6f", "#c9a227"];
  const colour = i => COLORS[i % COLORS.length];
  const ROW = 18, legendTop = H + 22, legendRows = 2 + deps.length;
  const totalH = legendTop + legendRows * ROW + 44;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${totalH}" font-family="system-ui, sans-serif" font-size="12">
  <defs><clipPath id="c"><rect width="${W}" height="${H}"/></clipPath></defs>
  <rect width="${W}" height="${totalH}" fill="#ffffff"/>
  <rect width="${W}" height="${H}" fill="#f4f1ea"/>
  <g clip-path="url(#c)">
    ${deps.map((f, i) => `<path d="${path(f.rings)}" fill="${colour(i)}" fill-opacity="0.25" stroke="${colour(i)}" stroke-width="1.6" fill-rule="evenodd"><title>${label(f)}</title></path>`).join("\n    ")}
    ${landslideFeatures.filter(f => f.kind === "scarps").map(f => `<path d="${path(f.rings)}" fill="#a83232" fill-opacity="0.55" stroke="#a83232" stroke-width="1"/>`).join("\n    ")}
    <path d="${path([parcel.ring])}" fill="none" stroke="#111" stroke-width="3"/>
  </g>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="none" stroke="#999"/>
  <g transform="translate(16,${H - 20})"><rect width="${scalePx.toFixed(1)}" height="6" fill="#333"/><text y="-6">${scaleM} m</text></g>
  <text x="${W - 16}" y="22" text-anchor="end" font-weight="700">N ↑</text>
  <g transform="translate(16,${legendTop})">
    <rect width="14" height="10" fill="none" stroke="#111" stroke-width="2"/><text x="22" y="10">Parcel ${parcel.id} (281 Stewart Rd)</text>
    ${deps.map((f, i) => `<g transform="translate(0,${(i + 1) * ROW})"><rect width="14" height="10" fill="${colour(i)}" fill-opacity="0.35" stroke="${colour(i)}" stroke-width="1.6"/><text x="22" y="10">${label(f)} — mapped landslide deposit, ${String(f.attrs.RELATIVE_AGE || "age unknown").toLowerCase()}</text></g>`).join("\n    ")}
    <g transform="translate(0,${(deps.length + 1) * ROW})"><rect width="14" height="10" fill="#a83232" fill-opacity="0.55"/><text x="22" y="10">Scarp or flank</text></g>
    <text y="${(deps.length + 2) * ROW + 10}" fill="#555">WA DNR landslide inventory, as hosted by Skamania County GIS. Pulled ${today}.</text>
    <text y="${(deps.length + 2) * ROW + 26}" fill="#555">Mapped estimate, not a site survey.</text>
  </g>
</svg>
`;
}

/* ---------- Repeat check ----------
   Key values per layer go to a small JSON beside the report. On the next run
   they are compared, so "Repeatable" in the pass bar says what actually
   happened rather than what we hope. */
const R0 = results;
const snap = {
  parcel: R0.parcel.ok ? [parcel.id, parcel.acres.toFixed(3)] : null,
  soil: R0.soil.ok ? R0.soil.comps.map(c => [c.mukey, c.name, c.pct, c.septic]) : null,
  slope: R0.slope.ok ? R0.slope.runs.map(r => [r.pixel, r.mean, r.max, r.over15, r.over30]) : null,
  waterService: R0.waterService.ok ? R0.waterService.systems.map(s => s.WS_ID).sort() : null,
  waterRights: R0.waterRights.ok ? [R0.waterRights.withinMile, R0.waterRights.coveringCount] : null,
  wells: R0.wells.ok ? [R0.wells.total, R0.wells.water.n, R0.wells.water.median] : null,
  landslides: R0.landslides.ok ? R0.landslides.deposits.map(d => d.LANDSLIDE_ID).sort() : null,
  planning: R0.planning.ok ? [R0.planning.zoning.map(z => z.ZoneCode), R0.planning.city.length, R0.planning.urban.map(u => u.Name)] : null,
  power: R0.power.ok ? R0.power.territories.map(t => t.NAME).sort() : null
};
const prev = existsSync(OUT_SNAP) ? JSON.parse(readFileSync(OUT_SNAP, "utf8")) : null;
const repeat = key => {
  if (!snap[key]) return "Failed this run";
  if (!prev || !prev.values || prev.values[key] == null) return "First run — re-run to check";
  return JSON.stringify(prev.values[key]) === JSON.stringify(snap[key])
    ? `Yes — matched ${prev.date} run` : `**No — differs from ${prev.date} run**`;
};

/* ---------- Report ---------- */

const R = results;
const yes = b => b ? "Yes" : "No";
const fmt = v => v == null ? "—" : String(v);
const esc = s => String(s == null ? "" : s).replace(/\|/g, "\\|");
const L = [];
const p = (...a) => L.push(...a);

p(`# Washington test parcel: 281 Stewart Rd, Stevenson (Skamania County)`, ``,
  `Generated by \`tools/wa-parcel-report.mjs\` on **${today}**. Every number below comes from a live query; the query list is at the end. ` +
  `Re-run the script to repeat the pull. Nothing in this report is wired into the app yet; a layer goes into the app only if it passes the bar below.`, ``,
  `**Labels used:** Record · Mapped estimate · Claim only — not a confirmed right · Nearby, not this parcel · Not assessed yet — ask [office].`, ``);

/* Summary */
const soil = R.soil.ok ? R.soil : null, slope = R.slope.ok ? R.slope : null;
const best = slope && (slope.runs.find(r => r.pixel === 1) || slope.runs[0]);
const ls = R.landslides.ok ? R.landslides : null;
const depOn = ls ? ls.deposits.filter(d => d.onParcel) : [], depNear = ls ? ls.deposits.filter(d => !d.onParcel) : [];
p(`## Summary`, ``,
  `| Need | Finding | Label |`, `|---|---|---|`,
  `| Parcel | ${parcel.id}, about ${parcel.acres.toFixed(2)} ac (measured from the mapped boundary) | Mapped estimate |`,
  soil ? `| Septic soil | ${soil.veryLimitedPct}% of the soil on the parcel rates **very limited** for a septic absorption field | Mapped estimate |` : `| Septic soil | lookup failed | — |`,
  best ? `| Slope | mean ${best.mean}°, max ${fmt(best.max)}° (${Math.round(degToGrade(best.mean))}% grade mean); ${best.over30}% of the parcel steeper than 30% grade | Mapped estimate |` : `| Slope | lookup failed | — |`,
  ls ? `| Landslides | ${depOn.length} mapped landslide deposit(s) on the parcel, ${depNear.length} more within 100 ft. **SCC 19.07 requires a geotechnical letter.** | Mapped estimate |` : `| Landslides | lookup failed | — |`,
  R.waterService.ok ? `| Water | ${R.waterService.systems.length ? `Inside **${esc(R.waterService.systems.map(s => s.WS_Name).join(", "))}** service area — ask about a connection` : "Outside every mapped public water system"} | Mapped estimate |` : `| Water | lookup failed | — |`,
  R.power.ok ? `| Power | ${esc(R.power.territories.map(t => t.NAME).join("; "))} | Mapped estimate |` : `| Power | lookup failed | — |`,
  R.planning.ok ? `| Zoning | ${esc(R.planning.zoning.map(z => `${z.Zoning || z.ZoneCode} (${z.ZoneDesc || ""}${z.CompPlan ? ", comp plan " + z.CompPlan : ""})`).join("; "))}; city limits: ${R.planning.city.length ? esc(R.planning.city.map(c => c.CITY_NAME).join(", ")) : "outside"}; urban area: ${R.planning.urban.length ? esc(R.planning.urban.map(u => u.Name).join(", ")) : "none"} | Mapped estimate |` : `| Zoning | lookup failed | — |`,
  ``);

/* Buildability comparison */
p(`## Check against Buildability.us`, ``,
  `Internal validation only. These figures never appear in the app.`, ``,
  `| Their claim | Our pull | Verdict |`, `|---|---|---|`);
if (best) {
  const meanGrade = degToGrade(best.mean);
  p(`| 27.5° slope | mean ${best.mean}° (≈${Math.round(meanGrade)}% grade), max ${fmt(best.max)}° over the parcel | ${Math.abs(best.mean - 27.5) < 3 ? "Agrees" : "Contradicted as degrees"}${Math.abs(meanGrade - 27.5) < 4 ? "; matches if 27.5 is percent grade" : ""} |`);
}
if (soil) {
  p(`| Septic "very limited" | ${soil.veryLimitedPct}% very limited; reasons: ${esc(soil.reasons.slice(0, 3).map(r => r.rule).join(", "))} | ${soil.veryLimitedPct >= 50 ? "Agrees" : "Partly"} |`);
  const major = soil.comps.find(c => c.major);
  p(`| Clay soil | surface ${esc(major && major.surfaceTexture || "?")}, ${fmt(major && major.surfaceClayPct)}% clay; map unit "${esc(major && major.mapunit)}" | ${major && /^c$|^clay$/i.test(major.surfaceTexture || "") ? "Agrees" : "Partly: clay loam, not clay"} |`);
}
p(``);

/* Pass bar */
const passRow = (layer, access, terms, repeat, hand) => `| ${layer} | ${access} | ${terms} | ${repeat} | ${hand} |`;
p(`## Pass bar per layer`, ``,
  `A layer goes into the app only when all four hold: machine access; terms allow public reuse; the pull repeats; one value checked by hand against the agency's own viewer.`, ``,
  `| Layer | Machine access | Terms allow reuse | Repeatable | Hand-checked |`, `|---|---|---|---|---|`,
  passRow("WA statewide parcels (WaTech)", yes(R.parcel.ok), "Yes — informational use, not survey", repeat("parcel"), "**To do**"),
  passRow("USDA SDA soil", yes(R.soil.ok), "Open item — banner wording, email NRCS", repeat("soil"), "**To do** (Web Soil Survey)"),
  passRow("USGS 3DEP slope", yes(R.slope.ok), "Yes — federal, public domain", repeat("slope"), "**To do**"),
  passRow("Ecology water rights", yes(R.waterRights.ok), "Yes — public information, as-is", repeat("waterRights"), "**To do** (WRTS)"),
  passRow("Ecology well reports", yes(R.wells.ok), "Yes — public information, as-is", repeat("wells"), "**To do** (Well Report Viewer)"),
  passRow("WA DOH water service areas", yes(R.waterService.ok), "To confirm", repeat("waterService"), "**To do**"),
  passRow("Skamania landslides, zoning, city, urban", yes(R.landslides.ok && R.planning.ok), "County GIS, attribution required", repeat("landslides"), "**To do** (county map / DNR portal)"),
  passRow("Electric territory (existing /api/power layer)", yes(R.power.ok), "Third-party HIFLD copy", repeat("power"), "**To do** (PUD service map)"),
  passRow("WA DNR lidar download", "No — zip only, 403 to scripts", "No terms page found", "—", "—"),
  passRow("Census geocoder for this address", R.geocode.ok && R.geocode.matches ? "Yes" : "**No match** — fall back to parcel address search", "Yes", "—", "—"),
  ``);

/* Sections */
p(`## Parcel`, ``);
if (R.parcel.ok) {
  const a = parcel.attrs;
  p(`- **Statewide parcel ID:** ${parcel.id} · situs: ${esc(a.SITUS_ADDRESS)}${a.SITUS_CITY_NM ? ", " + esc(a.SITUS_CITY_NM) : ""}`,
    `- **Area:** ${parcel.acres.toFixed(3)} ac, measured from the mapped boundary (assessor's drawing, not a survey).`,
    `- **Land use code:** ${fmt(a.LANDUSE_CD)} · land value $${fmt(a.VALUE_LAND)} · building value $${fmt(a.VALUE_BLDG)}`,
    `- **Centroid:** ${CLAT.toFixed(5)}, ${CLON.toFixed(5)}`);
  if (R.countyParcel.ok && R.countyParcel.record) {
    const c = R.countyParcel.record;
    p(`- **County record:** ${esc(c.PARCEL_ID)} · ${esc(c.LegalDesc)} · deed acres ${fmt(c.DeedAcres)} · GIS acres ${fmt(c.GIS_Acre)}`);
  }
  p(`- **Geocoding:** Census geocoder returned ${R.geocode.ok ? R.geocode.matches : "an error"} match(es) for "${ADDRESS}". ` +
    `The parcel was found by searching the statewide layer's situs address instead.`);
} else p(`Lookup failed: ${R.parcel.error}`);
p(``);

p(`## Soil and septic — Mapped estimate`, ``);
if (soil) {
  p(`USDA NRCS Soil Data Access, interpretation "ENG - Septic Tank Absorption Fields". ${soil.mapunits} map unit(s) touch the parcel. Every component, minor ones included:`, ``,
    `| Map unit | Component | Share | Major | Slope low/rep/high % | Drainage | Surface texture (clay %) | Septic rating |`, `|---|---|---|---|---|---|---|---|`,
    ...soil.comps.map(c => `| ${esc(c.musym)} ${esc(c.mapunit)} | ${esc(c.name)} | ${c.pct}% | ${c.major ? "Yes" : "No"} | ${c.slope.map(fmt).join(" / ")} | ${esc(fmt(c.drainage))} | ${esc(fmt(c.surfaceTexture))} (${fmt(c.surfaceClayPct)}) | ${esc(c.septic || "Not rated")} |`),
    ``, `Limiting features: ${soil.reasons.map(r => `${r.rule} (${r.score})`).join("; ") || "none listed"}.`, ``);
} else p(`Lookup failed: ${R.soil.error}`, ``);

p(`## Slope — Mapped estimate`, ``);
if (slope) {
  p(`USGS 3DEP elevation, "Slope Degrees" over the parcel polygon. The service returns whole-degree bins. ` +
    (slope.sample ? `At the centroid it served raster ${slope.sample.rasterId}${slope.sample.name ? ` (${esc(slope.sample.name)})` : ""}, elevation ${slope.sample.elevation} m. ` : "") +
    `Where 1 m lidar has a gap, the service falls back to ~10 m data, so a "1 m" request can still be 10 m underneath.`, ``,
    `| Pixel requested | Mean | Max | Area over 15% grade | Area over 30% grade |`, `|---|---|---|---|---|`,
    ...slope.runs.map(r => `| ${r.pixel} m | ${r.mean}° (${Math.round(degToGrade(r.mean))}%) | ${fmt(r.max)}° (${r.max != null ? Math.round(degToGrade(r.max)) : "—"}%) | ${fmt(r.over15)}% | ${fmt(r.over30)}% |`),
    ``, `Soil-survey slope for comparison: ${soil ? soil.comps.filter(c => c.major).map(c => `${c.name} ${c.slope.map(fmt).join("–")}%`).join("; ") : "—"} (a range for the whole map unit, not this lot).`, ``);
} else p(`Lookup failed: ${R.slope.error}`, ``);

p(`## Geologic hazards — Mapped estimate`, ``,
  `![Parcel and mapped landslides](WA/Skamania/stewart-rd-landslides.svg)`, ``,
  `Interactive version: [stewart-rd-landslides.geojson](WA/Skamania/stewart-rd-landslides.geojson) (GitHub renders it as a map).`, ``);
if (ls) {
  p(`Source: WA DNR landslide inventory as re-hosted by Skamania County GIS (\`Landslide_Deposit\`, \`Scarps_and_Flanks\`, \`Recent_Landslides\`). ` +
    `SCC 19.07 requires a geotechnical letter for regulated work in, or within 100 ft of, a mapped landslide hazard area, and a full report if the letter cannot clear it.`, ``,
    `| Landslide | Name | Material / movement | Confidence | Age | Field verified | On parcel |`, `|---|---|---|---|---|---|---|`,
    ...ls.deposits.map(d => `| ${fmt(d.LANDSLIDE_ID)} | ${esc(fmt(d.LS_NAME))} | ${esc(fmt(d.MATERIAL))} / ${esc(fmt(d.MOVEMENT))} | ${esc(fmt(d.CONFIDENCE))} | ${esc(fmt(d.RELATIVE_AGE))} | ${esc(fmt(d.FIELD_VERIFIED))} | ${d.onParcel ? "Yes" : "Within 100 ft"} |`),
    ``, `Scarps or flanks within 100 ft: ${ls.scarps.length}. Recent landslides within 100 ft: ${ls.recent.length}.`,
    `Detailed mapping covering the parcel: ${ls.study.map(s => `${esc(String(s.CITATION || s.CITATION_CODE || "").trim())} (${fmt(s.YR_PUBLISHED)})`).join("; ") || "none listed"}.`, ``,
    `What the app would say: "Mapped landslide here — Skamania County requires a geotechnical letter before building. Get 2–3 fixed-fee quotes." No dollar figure until quotes are collected.`, ``);
} else p(`Lookup failed: ${R.landslides.error}`, ``);

p(`## Water`, ``, `### Public water system — Mapped estimate`, ``);
if (R.waterService.ok) {
  if (R.waterService.systems.length) p(...R.waterService.systems.map(s =>
    `- **${esc(s.WS_Name)}** (WS_ID ${s.WS_ID}, Group ${esc(s.WS_Grp)}, ${esc(s.ServiceAreaType || "")}, status ${esc(s.WS_Status || "")}, ${fmt(s.Total_Conn)} connections). Contact ${esc(s.Contact_Phone || "—")}. Source date ${s.DataSourceDate ? new Date(s.DataSourceDate).toISOString().slice(0, 10) : "—"}.`));
  else p(`- Outside every mapped public water system. Wells come first for this parcel.`);
  p(``);
} else p(`Lookup failed: ${R.waterService.error}`, ``);

p(`### Water rights — Claim only / Nearby, not this parcel`, ``);
if (R.waterRights.ok) {
  const w = R.waterRights;
  const phases = Object.entries(w.byPhase).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)} ${v}`).join(" · ");
  p(`Ecology water-right documents with a place of use within 1 mile: **${w.withinMile}**. By phase: ${phases}. ` +
    `By source class: ${Object.entries(w.bySource).map(([k, v]) => `${esc(k)} ${v}`).join(" · ")}. ` +
    `Claims are filings under the 1967 claims registration act, not confirmed rights; the app labels them "Claim only — not a confirmed right".`, ``);
  if (w.covering.length) {
    p(`Documents whose place of use covers this parcel (${w.coveringCount}). A water system's right covering an area is not a right owned by the parcel:`, ``,
      `| Number | Phase | Status | Source | Purpose | Priority | Quantity | Holder |`, `|---|---|---|---|---|---|---|---|`,
      ...w.covering.map(c => `| ${esc(c.number)} | ${esc(c.phase)} | ${esc(c.status)} | ${esc(c.source)} | ${esc(c.purpose)} | ${fmt(c.priority)} | ${esc(fmt(c.qi))}${c.qa ? `, ${c.qa} af/yr` : ""} | ${esc(fmt(c.holder))} |`), ``);
  }
} else p(`Lookup failed: ${R.waterRights.error}`, ``);

p(`### Well reports — Nearby, not this parcel`, ``);
if (R.wells.ok) {
  const w = R.wells, P = R.plss.ok ? R.plss : null;
  p(`Ecology well reports within 1 mile: **${w.total}** records plotted at only **${w.distinctLocations}** distinct points; ${w.ownLatLon} carry their own latitude/longitude. ` +
    `Most are placed at the centre of a ~40-acre quarter-quarter section, so per-well distances would be false precision. Locations approximate to about ¼ mile.`, ``,
    `Water wells: ${w.water.n} (${w.water.withDepth} with a depth). Depth: min ${fmt(w.water.min)} · 25th pct ${fmt(w.water.p25)} · **median ${fmt(w.water.median)}** · 75th pct ${fmt(w.water.p75)} · max ${fmt(w.water.max)} ft. ` +
    `Static water level reported on ${w.water.swlN} (median ${fmt(w.water.swlMedian)} ft). Flow rate reported on ${w.water.flowN}.`, ``,
    `By record type: ${Object.entries(w.byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)} ${v}`).join(" · ")}.`, ``);
  if (P) p(`The parcel centroid falls in **${P.qq} of Sec ${P.sec}, T${P.twp}${P.twpDir} R${P.rng}${P.rngDir}** (BLM PLSS). ` +
    (w.inQQ.length ? `Reports filed in this parcel's quarter-quarter (${w.inQQ.length}) — "filed in this parcel's quarter-section", not "on this parcel":` : `No well reports are filed in this quarter-quarter.`), ``);
  if (w.inQQ.length) p(`| Type | Subtype | Depth ft | Year | File |`, `|---|---|---|---|---|`,
    ...w.inQQ.map(r => `| ${esc(fmt(r.type))} | ${esc(fmt(r.sub))} | ${fmt(r.depth)} | ${fmt(r.year)} | ${esc(fmt(r.file))} |`), ``);
} else p(`Lookup failed: ${R.wells.error}`, ``);

p(`## Power — Mapped estimate`, ``);
if (R.power.ok) p(`Territories at the centroid (the layer \`/api/power\` already uses): ${esc(R.power.territories.map(t => `${t.NAME}${t.TYPE && t.TYPE !== "NOT AVAILABLE" ? ` (${t.TYPE})` : ""}`).join("; ")) || "none"}. ` +
  `Open item: check against the PUD's own service map. A federal marketer (BPA) sells wholesale and is not who you call for a hook-up.`, ``);
else p(`Lookup failed: ${R.power.error}`, ``);

p(`## County fees — Record`, ``,
  `From the Skamania County Building / Environmental Health fee schedule ([PDF in this repo](WA/Skamania/Building_EH%20Fee%20Schedule%202023.pdf), dated 2023 — check current). Shown as separate lines, never totalled.`, ``,
  `| Step | Fee |`, `|---|---|`,
  `| Soil and Site Evaluation (by the county) | $335 |`,
  `| Concurrency review of a designer's soil and site evaluation | $245 |`,
  `| Winter evaluation (weekly visits, three months) | $650 |`,
  `| Septic design review and permit, under 1,000 gal/day | $195 |`,
  `| Waiver (required for permit release) | $105 |`,
  `| Late record drawing (as-built) | $100 |`,
  `| Water Adequacy Verification, self-sampled — individual or shared well, or spring only | $265 |`, ``,
  `The schedule lists no fee for records requests. A parcel connecting to a Group A system such as Stevenson Water likely needs no WAV (inferred from the schedule wording, not confirmed).`, ``);

p(`## Neighbor records — Not assessed yet — ask Skamania County Environmental Health`, ``,
  `Parcels next to the test parcel (Skamania parcel layer; owner names deliberately left out):`, ``);
if (R.neighbors.ok) p(`| Parcel | Address | Property class | Acres | Relation |`, `|---|---|---|---|---|`,
  ...R.neighbors.list.map(n => `| ${esc(n.id)} | ${esc(fmt(n.situs))} | ${esc(fmt(n.propClass))} | ${fmt(n.acres)} | ${n.touching ? "Touching" : "Within 25 m"} |`), ``);
else p(`Lookup failed: ${R.neighbors.error}`, ``);
p(`What to request for each, by parcel number and address:`, ``,
  `- septic permits`, `- site evaluations and soil logs`, `- as-built (record) drawings`, `- Water Adequacy Verification records`, ``,
  `How to request, confirmed on the county's own pages: the Environmental Health Division (under Community Development) asks for septic records by email to the Permit Center, ` +
  `\`permitcenter@skamaniacounty.gov\`, with "Septic Records Request" in the subject and the parcel number and/or address. Other county records go through the county's GovQA public records portal. ` +
  `Nothing is searchable online. Fees and turnaround are not stated. That neighbours' records can be requested is inferred from the Public Records Act, not stated by the county.`, ``);

p(`## Open items`, ``,
  `- Hand-check one value per layer against the agency's own viewer (pass bar column above).`,
  `- Email NRCS about the "official Government business" banner on Soil Data Access.`,
  `- Check the electric territory against Skamania PUD's service map.`,
  `- Confirm SCC 19.07 current text, and whether "mapped" means the DNR inventory, with Skamania Community Development.`,
  `- Septic records fee and turnaround.`,
  `- No scriptable 1 m lidar where the 3DEP 1 m tile has a gap; WA DNR's lidar is zip-download only.`,
  `- Geotech letter/report cost: no public source. Collect 3–5 fixed-fee quotes before showing any figure.`, ``);

p(`## Queries run`, ``, ...queries.map(q => `- ${esc(q.label)}: \`${q.url.replace(/`/g, "'")}\``), ``);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_MD, L.join("\n"));
writeFileSync(OUT_GEOJSON, JSON.stringify(geojson));
writeFileSync(OUT_SVG, svgMap());
writeFileSync(OUT_SNAP, JSON.stringify({ date: today, values: snap }, null, 1) + "\n");
log(`\nWrote ${OUT_MD}\n      ${OUT_GEOJSON}\n      ${OUT_SVG}\n      ${OUT_SNAP}`);
const failed = Object.entries(results).filter(([, v]) => !v.ok).map(([k, v]) => `${k}: ${v.error}`);
if (failed.length) { log("\nFailed sections:\n  " + failed.join("\n  ")); process.exitCode = 2; }
