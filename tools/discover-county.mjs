#!/usr/bin/env node
/**
 * discover-county.mjs — draft a parcel adapter for a county ArcGIS server.
 *
 *   node tools/discover-county.mjs <arcgis-rest-root> [countyName]
 *
 * Examples:
 *   node tools/discover-county.mjs https://gis.yavapaiaz.gov/arcgis/rest/services Yavapai
 *   node tools/discover-county.mjs https://mcgis.mohave.gov/arcgis/rest/services Mohave
 *
 * Walks the REST directory, finds layers that look like parcels, inspects their
 * fields, and prints a draft config block for functions/api/parcel.js — plus a
 * list of what it could not find, which is the part you have to solve by hand.
 *
 * Read the output before pasting it. Field-name guessing is a heuristic, not
 * a guarantee, and counties label things inconsistently.
 */

const TIMEOUT_MS = 20000;

// Field-name patterns, best guess first.
const PATTERNS = {
  apn:      [/^PARLABEL$/i, /^APN$/i, /^PARCEL(_?ID|_?NUM|NUMBER)?$/i, /^PIN$/i, /^TAXPIN$/i, /^PARNUMASR$/i, /PARCEL/i],
  address:  [/^SITUS_?ADD/i, /^SITE_?ADDRESS$/i, /^SITUS/i, /^PHYSICAL_?ADDR/i, /^ADDRESS$/i, /ADDRESS/i],
  acres:    [/^ACRE(S|_DEED|AGE)?$/i, /^PARCEL_?SIZE$/i, /^GIS_?ACRES$/i, /ACRE/i],
  owner:    [/^OWNER$/i, /^OWNER_?NAME$/i, /^NAME$/i, /OWNER/i],
  landValue:[/^LANDVALUE$/i, /^LAND_?VAL/i, /^FCV_?LAND/i],
  impValue: [/^IMPVALUE$/i, /^IMP_?VAL/i, /^IMPROVEMENT/i, /^BLDG_?VAL/i],
  use:      [/^PROPUSE$/i, /^USE_?CODE$/i, /^USE_?DESC/i, /^PROPCODE$/i, /^SUBNAME$/i],
  zoning:   [/^ZONING$/i, /^ZONE$/i, /ZONING/i],
  lat:      [/^LATITUDE$/i, /^LAT$/i, /^CENTROID_?Y$/i, /^POINT_?Y$/i],
  lon:      [/^LONGITUDE$/i, /^LON(G)?$/i, /^CENTROID_?X$/i, /^POINT_?X$/i]
};

const PARCEL_LAYER = /parcel|tax\s*parcel|property|cadastral/i;
const BUILDING_LAYER = /building|structure|footprint/i;
const SKIP_LAYER = /hook|dimension|lot number|annotation|label|line|point of|block/i;

async function get(url) {
  const u = url + (url.includes("?") ? "&" : "?") + "f=json";
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(u, { signal: ctl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || "service error");
    return j;
  } finally { clearTimeout(t); }
}

function pick(fields, patterns) {
  const names = fields.map(f => f.name);
  for (const p of patterns) {
    const hit = names.find(n => p.test(n));
    if (hit) return hit;
  }
  return null;
}

async function collectServices(root) {
  const out = [];
  const seen = new Set();
  // ArcGIS reports service.name already qualified with its folder, so the URL
  // is always root + "/" + name + "/" + type regardless of which folder we
  // happened to read it from.
  async function walk(path, depth) {
    if (depth > 3 || seen.has(path)) return;
    seen.add(path);
    let dir;
    try { dir = await get(path); } catch (e) {
      if (depth === 0) throw new Error(`Could not read ${path} — ${e.message}`);
      return;
    }
    for (const f of dir.folders || []) await walk(`${root}/${f}`, depth + 1);
    for (const s of dir.services || []) {
      if (s.type === "MapServer" || s.type === "FeatureServer") {
        out.push(`${root}/${s.name}/${s.type}`);
      }
    }
  }
  await walk(root, 0);
  return [...new Set(out)];
}

async function main() {
  const root = (process.argv[2] || "").replace(/\/+$/, "");
  const county = process.argv[3] || "Unknown";
  if (!root) {
    console.error("usage: node tools/discover-county.mjs <arcgis-rest-root> [countyName]");
    process.exit(1);
  }

  console.log(`\nScanning ${root} …\n`);
  const services = await collectServices(root);
  if (!services.length) {
    console.error("No MapServer/FeatureServer endpoints found. Check the root URL — it should end in /rest/services");
    process.exit(1);
  }

  const parcelCandidates = [], buildingCandidates = [];

  for (const svc of services) {
    let meta;
    try { meta = await get(svc); } catch { continue; }
    for (const lyr of meta.layers || []) {
      const target = SKIP_LAYER.test(lyr.name) ? null
        : PARCEL_LAYER.test(lyr.name) ? parcelCandidates
        : BUILDING_LAYER.test(lyr.name) ? buildingCandidates
        : null;
      if (!target) continue;
      let det;
      try { det = await get(`${svc}/${lyr.id}`); } catch { continue; }
      const fields = det.fields || [];
      if (!fields.length && target === parcelCandidates) continue;
      target.push({
        url: `${svc}/${lyr.id}/query`,
        name: lyr.name,
        count: fields.length,
        fields,
        maxRecords: det.maxRecordCount
      });
    }
  }

  if (!parcelCandidates.length) {
    console.error("Found services but no parcel-like layer with readable fields.");
    console.error("Layers seen were either restricted or named unusually. Inspect manually:\n");
    services.slice(0, 20).forEach(s => console.error("  " + s));
    process.exit(1);
  }

  // Richest field list usually means the assessor-joined layer.
  parcelCandidates.sort((a, b) => b.count - a.count);
  const best = parcelCandidates[0];
  const f = best.fields;

  const g = Object.fromEntries(Object.entries(PATTERNS).map(([k, p]) => [k, pick(f, p)]));
  const hasPoint = g.lat && g.lon;

  console.log(`Parcel layer:   ${best.name}  (${best.count} fields, max ${best.maxRecords})`);
  console.log(`                ${best.url}\n`);
  console.log("Field mapping guessed:");
  Object.entries(g).forEach(([k, v]) => console.log(`  ${k.padEnd(10)} ${v || "— NOT FOUND"}`));

  const missing = Object.entries(g).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) console.log(`\n⚠  Unmapped: ${missing.join(", ")}`);
  if (!hasPoint) console.log("⚠  No coordinate columns — adapter will use needsGeometry (bounding-box centre).");

  const outFields = [g.apn, g.address, g.acres, g.owner, g.use, g.zoning, g.landValue, g.impValue, g.lat, g.lon]
    .filter(Boolean).join(",");

  const nb = buildingCandidates[0];
  console.log(`\nNeighbour signal: ${g.impValue ? "assessor improvement values" : nb ? "building footprints — " + nb.name : "NONE FOUND (add manually)"}`);

  const key = county.toLowerCase().replace(/[^a-z]/g, "");
  const cfg = `
  ${key}: {
    name: "${county}",
    url: "${best.url}",
    apnField: "${g.apn || "TODO"}",${g.apn === "PARLABEL" ? '\n    apnAltField: "PARNUMASR",' : ""}
    addrField: "${g.address || "TODO"}",
    fields: "${outFields}",${hasPoint ? "" : "\n    needsGeometry: true,"}
${hasPoint ? `    point: a => ({ lat: parseFloat(a.${g.lat}), lon: parseFloat(a.${g.lon}) }),\n` : ""}    map: a => ({
      apn: a.${g.apn || "TODO"},
      address: (a.${g.address || "TODO"} || "").trim() || null,
      owner: ${g.owner ? `a.${g.owner} || null` : "null"},
      acres: ${g.acres ? `a.${g.acres} != null && +a.${g.acres} > 0 ? +a.${g.acres} : null` : "null"},
      use: ${g.use ? `a.${g.use} || null` : "null"},
      zoning: ${g.zoning ? `a.${g.zoning} || null` : "null"},
      landValue: ${g.landValue ? `a.${g.landValue} != null ? Math.round(+a.${g.landValue}) : null` : "null"},
      improvementValue: ${g.impValue ? `a.${g.impValue} != null ? Math.round(+a.${g.impValue}) : null` : "null"},
      improved: ${g.impValue ? `+a.${g.impValue} > 0` : "null"}
    }),
    neighbours: ${g.impValue ? `{
      kind: "improved_parcels",
      url: "${best.url}",
      fields: "${g.apn},${g.impValue}",
      count: rows => ({
        total: rows.length,
        hits: rows.filter(r => +r.${g.impValue} > 0).length,
        label: "parcels within half a mile have improvements"
      })
    }` : nb ? `{
      kind: "buildings",
      url: "${nb.url}",
      fields: "OBJECTID",
      count: rows => ({
        total: null,
        hits: rows.length,
        label: "buildings mapped within half a mile"
      })
    }` : "null"}
  },`;

  console.log("\n" + "─".repeat(72));
  console.log("Draft config — review, then paste into COUNTIES in functions/api/parcel.js:");
  console.log("─".repeat(72));
  console.log(cfg);

  console.log("Before you trust it:");
  console.log("  1. Check the APN field actually holds hyphenated numbers, not internal IDs.");
  console.log("  2. Run one real parcel through /api/parcel and confirm lat/lon land in the right county.");
  console.log("  3. If needsGeometry is set, sanity-check the centroid on a map.\n");

  if (parcelCandidates.length > 1) {
    console.log("Other parcel-like layers found, in case the pick is wrong:");
    parcelCandidates.slice(1, 6).forEach(c => console.log(`  ${c.name} (${c.count} fields) — ${c.url}`));
    console.log("");
  }
}

main().catch(e => { console.error("Failed:", e.message || e); process.exit(1); });
