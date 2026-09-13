/**
 * Are the pipes still open?
 *
 *   node tools/health-check.mjs
 *   node tools/health-check.mjs --json     # machine-readable, for cron/CI
 *
 * The data this app reads barely changes — a well drilled in 1954 at 474 ft is
 * still 474 ft. What changes without warning is ACCESS. Yavapai did not alter
 * their data; they altered a firewall rule, and every Yavapai lookup began
 * failing silently as "No parcel found. Check the number." An access failure
 * dressed as a finding about someone's land.
 *
 * So this checks reachability and shape, not truth. Each probe asserts something
 * that should hold for years, and fails loudly when it does not.
 *
 * Deliberately dependency-free: Node's built-in fetch, no packages, no keys.
 * Runs in about five seconds and costs nothing.
 *
 * EXPECTED FAILURES ARE FIRST-CLASS. Yavapai is expected to return 403. If that
 * ever stops being true, the check reports it as news — because it means the
 * county assessor adapter could be switched back on and Yavapai users would get
 * zoning and assessed value again.
 */

const UA = "BuildOffGrid/1.0 (+https://buildoffgrid.ogprep.com; health check; contact via site)";
const JSON_OUT = process.argv.includes("--json");
const TIMEOUT_MS = 20000;

/* Reference points, chosen because they are well-evidenced and unlikely to
   change. Apache is the parcel every test in the project has used. */
const APACHE = { lat: 34.506, lon: -109.380 };
const ADWR = "https://services.arcgis.com/C34zQ7veRS0V1t04/ArcGIS/rest/services/";
const UTAH = "https://services.arcgis.com/ZzrwjTRez6FJiOq4/arcgis/rest/services/";

const esri = (base, params) => {
  const u = new URL(base);
  Object.entries({ f: "json", ...params }).forEach(([k, v]) => u.searchParams.set(k, v));
  return u.toString();
};

/* A point-radius query, the shape most of these services are asked for. */
const near = (base, { lat, lon }, metres, extra = {}) => esri(base, {
  geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", inSR: "4326",
  distance: String(metres), units: "esriSRUnit_Meter",
  spatialRel: "esriSpatialRelIntersects", ...extra
});

async function get(url, { expectStatus } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": UA } });
    const ms = Date.now() - started;
    if (expectStatus && r.status === expectStatus) return { ok: true, ms, status: r.status };
    if (!r.ok) return { ok: false, ms, status: r.status, why: "HTTP " + r.status };
    const body = await r.json();
    if (body.error) return { ok: false, ms, why: body.error.message || "service error" };
    return { ok: true, ms, body };
  } catch (e) {
    return { ok: false, ms: Date.now() - started,
             why: e.name === "AbortError" ? `timed out after ${TIMEOUT_MS / 1000}s` : String(e.message || e) };
  } finally { clearTimeout(t); }
}

/* Each probe: what it guards, and what "still fine" looks like. */
const PROBES = [
  {
    name: "ADWR well registry (Wells55)",
    guards: "/api/wells — every depth and cost figure in Arizona",
    async run() {
      const r = await get(near(ADWR + "Well_Registry_2024/FeatureServer/0/query",
        APACHE, 3220, { returnCountOnly: "true" }));
      if (!r.ok) return r;
      const n = r.body.count;
      // 322 when this was written. A large drop means a filter changed upstream.
      return { ...r, ok: n >= 200, detail: `${n} wells within 2 miles`,
               why: n >= 200 ? null : `only ${n} wells — expected 200+` };
    }
  },
  {
    name: "AZGeo statewide parcels",
    guards: "/api/apn and /api/identify — parcel search in all 15 counties",
    async run() {
      const r = await get(esri("https://azgeo.az.gov/arcgis/rest/services/TerraSystems/AZParcel_Cache/MapServer/0/query", {
        geometry: `${APACHE.lon},${APACHE.lat}`, geometryType: "esriGeometryPoint",
        inSR: "4326", outFields: "AZ_APN,Source", returnGeometry: "false"
      }));
      if (!r.ok) return r;
      const f = (r.body.features || [])[0];
      const src = f && f.attributes.Source;
      return { ...r, ok: !!f, detail: f ? `${f.attributes.AZ_APN} · ${src}` : "no parcel returned",
               why: f ? null : "point query returned nothing" };
    }
  },
  {
    name: "ADWR community water systems",
    guards: "/api/waterservice — whether a main already reaches the parcel",
    async run() {
      // Kingman Municipal Water. A city utility should not vanish.
      const r = await get(esri(ADWR + "CWS_Service_Area/FeatureServer/0/query", {
        geometry: "-114.053,35.189", geometryType: "esriGeometryPoint", inSR: "4326",
        outFields: "CWS_NAME", returnGeometry: "false"
      }));
      if (!r.ok) return r;
      const nm = ((r.body.features || [])[0] || {}).attributes?.CWS_NAME;
      return { ...r, ok: !!nm, detail: nm || "none", why: nm ? null : "Kingman returned no system" };
    }
  },
  {
    name: "ADWR AMA / INA boundaries",
    guards: "the exempt-well claim — the one legal gate in Arizona",
    async run() {
      // Phoenix AMA. Asserting a KNOWN-INSIDE point, because a null here would
      // otherwise look identical to a broken service.
      const r = await get(esri(ADWR + "AMA_INA_2024/FeatureServer/0/query", {
        geometry: "-112.074,33.448", geometryType: "esriGeometryPoint", inSR: "4326",
        outFields: "*", returnGeometry: "false"
      }));
      if (!r.ok) return r;
      const n = (r.body.features || []).length;
      return { ...r, ok: n > 0, detail: n ? "Phoenix point falls inside an AMA" : "no AMA at Phoenix",
               why: n ? null : "Phoenix should be inside the Phoenix AMA — layer may have moved" };
    }
  },
  {
    name: "Utah points of diversion",
    guards: "/api/waterrights and /api/waterright — the whole Utah product",
    async run() {
      // Cedar Valley, where the Spring Creek work was done.
      const r = await get(near(UTAH + "Utah_Points_of_Diversion/FeatureServer/0/query",
        { lat: 37.657, lon: -113.165 }, 8047, { returnCountOnly: "true" }));
      if (!r.ok) return r;
      const n = r.body.count;
      return { ...r, ok: n > 0, detail: `${n} points of diversion within 5 miles`,
               why: n > 0 ? null : "no rights found in Cedar Valley — unlikely" };
    }
  },
  {
    name: "Utah well logs",
    guards: "/api/utahwelldepths — the only Utah depth source",
    async run() {
      const r = await get(near(UTAH + "Utah_Well_Logs/FeatureServer/0/query",
        { lat: 37.657, lon: -113.165 }, 8047, { returnCountOnly: "true" }));
      if (!r.ok) return r;
      return { ...r, ok: r.body.count > 0, detail: `${r.body.count} logs within 5 miles`,
               why: r.body.count > 0 ? null : "no well logs returned" };
    }
  },
  {
    name: "Utah statewide parcels (Iron County)",
    guards: "/api/parcel and /api/identify for all 29 Utah counties",
    async run() {
      const r = await get(esri("https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/Parcels_Iron/FeatureServer/0/query", {
        geometry: "-113.16471,37.65743", geometryType: "esriGeometryPoint", inSR: "4326",
        outFields: "PARCEL_ID", returnGeometry: "false"
      }));
      if (!r.ok) return r;
      const f = (r.body.features || [])[0];
      return { ...r, ok: !!f, detail: f ? f.attributes.PARCEL_ID : "no parcel",
               why: f ? null : "Kevin's Cedar City parcel did not resolve" };
    }
  },
  {
    name: "Mohave County assessor",
    guards: "the only remaining rich-tier county — zoning and assessed value",
    async run() {
      const r = await get(esri("https://mcgis.mohave.gov/arcgis/rest/services/Mohave/MapServer/38/query", {
        where: "1=1", outFields: "PARCEL", returnGeometry: "false", resultRecordCount: "1"
      }));
      if (!r.ok) return { ...r, why: (r.why || "") + " — if this is a 403 they are blocking us like Yavapai" };
      return { ...r, ok: (r.body.features || []).length > 0, detail: "responds" };
    }
  },
  {
    name: "Yavapai County GIS (expected to refuse)",
    guards: "news, not health — if this passes, zoning can come back",
    expectFailure: true,
    async run() {
      const r = await get(esri("https://gis.yavapaiaz.gov/arcgis/rest/services/Districts/FeatureServer/15/query", {
        where: "PARNUMASR='11508070A'", outFields: "PARLABEL", returnGeometry: "false"
      }));
      if (r.ok) {
        return { ok: true, ms: r.ms, news: true,
                 detail: "Yavapai ANSWERED — they may have unblocked us. Try putting Yavapai back in RICH_COUNTIES." };
      }
      return { ok: true, ms: r.ms, detail: `still refusing (${r.why}) — expected` };
    }
  },
  {
    name: "USDA SSURGO soil",
    guards: "/api/soil — septic suitability",
    async run() {
      const r = await get("https://sdmdataaccess.nrcs.usda.gov/Tabular/post.rest");
      // A GET on a POST endpoint is not a real query; we are only asking whether
      // the host is alive and speaking. Anything other than a transport error
      // means USDA is up.
      return { ok: r.status !== undefined || r.ok, ms: r.ms,
               detail: r.status ? `host responding (HTTP ${r.status})` : "host responding",
               why: r.status === undefined && !r.ok ? r.why : null };
    }
  },
  {
    name: "Open-Meteo rainfall archive",
    guards: "/api/rain — catchment sizing",
    async run() {
      const r = await get("https://archive-api.open-meteo.com/v1/archive?latitude=34.5&longitude=-109.4" +
        "&start_date=2024-01-01&end_date=2024-01-31&daily=precipitation_sum&timezone=UTC");
      if (!r.ok) return r;
      const days = ((r.body.daily || {}).precipitation_sum || []).length;
      return { ...r, ok: days > 0, detail: `${days} days returned`,
               why: days > 0 ? null : "no precipitation series" };
    }
  },
  {
    name: "Wells55 copy used by the driller panel",
    guards: "/api/drillers — NOTE: a static third-party upload, not ADWR's own",
    async run() {
      const r = await get(esri("https://services1.arcgis.com/Ezk9fcjSUkeadg6u/arcgis/rest/services/Wells_55/FeatureServer/0/query", {
        where: "1=1", returnCountOnly: "true"
      }));
      if (!r.ok) return { ...r, why: (r.why || "") + " — this is an unowned snapshot; move drillers to ADWR's registry" };
      return { ...r, ok: r.body.count > 0, detail: `${r.body.count} records (frozen copy)` };
    }
  }
];

/* ------------------------------------------------------------------------- */

const results = [];
for (const p of PROBES) {
  let r;
  try { r = await p.run(); }
  catch (e) { r = { ok: false, why: "probe threw: " + (e.message || e) }; }
  results.push({ name: p.name, guards: p.guards, ...r });
}

if (JSON_OUT) {
  const failed = results.filter(r => !r.ok);
  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(),
    passed: results.length - failed.length,
    failed: failed.length,
    news: results.filter(r => r.news).map(r => r.name),
    results: results.map(({ name, ok, ms, detail, why, news }) => ({ name, ok, ms, detail, why, news }))
  }, null, 2));
  process.exit(failed.length ? 1 : 0);
}

console.log("\nBuild Off Grid — data source health\n" + "".padEnd(66, "-"));
for (const r of results) {
  const mark = r.news ? "NEWS" : r.ok ? " ok " : "FAIL";
  console.log(`[${mark}] ${r.name}`);
  console.log(`        ${r.guards}`);
  if (r.detail) console.log(`        ${r.detail}${r.ms ? `  (${r.ms}ms)` : ""}`);
  if (!r.ok && r.why) console.log(`        ${r.why}`);
}
const failed = results.filter(r => !r.ok);
const news = results.filter(r => r.news);
console.log("".padEnd(66, "-"));
console.log(`${results.length - failed.length} of ${results.length} sources reachable.`);
if (news.length) console.log(`\n${news.length} thing(s) CHANGED and are worth acting on — see NEWS above.`);
if (failed.length) {
  console.log("\nFailures are usually access, not data. Before assuming the source is gone,");
  console.log("check whether the service was renamed or whether we are being refused by IP.");
  process.exit(1);
}
