/**
 * Build the Utah water rights grid.
 *
 *   node tools/build-utah-rights-grid.mjs
 *
 * Writes data/ut-rights-grid.json — one row per ~2.8-mile cell, holding how
 * many live water rights sit inside it, how many of those are domestic, how
 * many are wells, and the median priority year.
 *
 * Why this and not depth: Utah publishes no bulk well-depth data (that needs
 * the WELLDB export, gated behind Technical Services on 801-538-7240). What it
 * does publish in bulk is every point of diversion — and in a closed-basin
 * state permission, not cost, is the binding constraint. "Where can you still
 * get a domestic water right" is both the more useful map and the one the
 * available data can actually support.
 *
 * Run time is a couple of minutes; ~142 paginated requests against Esri-hosted
 * ArcGIS Online, which is built for exactly this. Re-run whenever you want it
 * refreshed — the Division rebuilds the layer nightly.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SERVICE =
  "https://services.arcgis.com/ZzrwjTRez6FJiOq4/arcgis/rest/services/Utah_Points_of_Diversion/FeatureServer/0/query";

const CELL = 0.04;          // degrees, ~2.8 miles. A regional question.
const PAGE = 2000;          // the layer's maxRecordCount
const MIN_RIGHTS = 2;       // below this a cell is a single filing, not a pattern

const OUT = new URL("../data/ut-rights-grid.json", import.meta.url);

// Approved or Perfected only. Lapsed, forfeited and rejected rights tell you
// nothing about what is obtainable now.
const WHERE = "SUMMARY_ST IN ('A','P')";

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function page(offset) {
  const p = new URLSearchParams({
    where: WHERE,
    outFields: "USES,SUMMARY_ST,PRIORITY,TYPE",
    returnGeometry: "true", outSR: "4326", f: "json",
    resultOffset: String(offset), resultRecordCount: String(PAGE),
    orderByFields: "OBJECTID"
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(`${SERVICE}?${p}`, {
        headers: { "User-Agent": "BuildOffGrid/1.0 (+https://buildoffgrid.ogprep.com)" }
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || "query failed");
      return j.features || [];
    } catch (e) {
      if (attempt === 3) throw e;
      process.stdout.write(` retry(${e.message})`);
      await sleep(800 * (attempt + 1));
    }
  }
}

const median = a => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), i = s.length >> 1;
  return s.length % 2 ? s[i] : Math.round((s[i - 1] + s[i]) / 2);
};

/* Cedar Valley's regulation schedule shuts rights off by priority date, junior
   first. A priority year is therefore a countdown, and worth carrying. */
const PHASES = [
  [1957, 2035], [1954, 2050], [1951, 2060], [1935, 2070], [1934, 2080]
];
const phaseFor = y => {
  if (y == null) return null;
  for (const [through, when] of PHASES) if (y > through) return when;
  return null;   // senior to July 1934 — survives the published schedule
};

const cells = new Map();
let offset = 0, total = 0;

console.log("Fetching Utah points of diversion…");
for (;;) {
  const feats = await page(offset);
  if (!feats.length) break;

  for (const f of feats) {
    const g = f.geometry, a = f.attributes;
    if (!g || !isFinite(g.x) || !isFinite(g.y)) continue;

    const key = `${Math.round(g.y / CELL)},${Math.round(g.x / CELL)}`;
    let c = cells.get(key);
    if (!c) cells.set(key, c = { n: 0, dom: 0, ug: 0, yrs: [] });

    c.n++;
    if (String(a.USES || "").toUpperCase().includes("D")) c.dom++;
    if (String(a.TYPE || "").toUpperCase().includes("UNDERGROUND")) c.ug++;
    const y = parseInt(String(a.PRIORITY || "").slice(0, 4), 10);
    if (y > 1800 && y < 2100 && c.yrs.length < 500) c.yrs.push(y);
  }

  offset += feats.length; total += feats.length;
  if (total % 20000 === 0) process.stdout.write(`\r  ${total.toLocaleString()} rights…`);
  if (feats.length < PAGE) break;
}
console.log(`\r  ${total.toLocaleString()} live rights across ${cells.size.toLocaleString()} raw cells.`);

const rows = [];
for (const [key, c] of cells) {
  // Keep any cell with a domestic right even if it is the only filing — the
  // presence of one is the signal, and dropping it would hide the answer.
  if (c.n < MIN_RIGHTS && c.dom === 0) continue;
  const [a, b] = key.split(",").map(Number);
  const med = median(c.yrs);
  rows.push([
    +(a * CELL).toFixed(3), +(b * CELL).toFixed(3),
    c.n, c.dom, c.ug, med, phaseFor(med)
  ]);
}
rows.sort((x, y) => y[3] - x[3]);

const payload = {
  _meta: {
    source: "Water Right Points of Diversion (WRPOD)",
    publisher: "Utah Division of Water Rights",
    note: "Approved and perfected rights only. Rebuilt nightly upstream; " +
          "re-run this script to refresh.",
    built: new Date().toISOString().slice(0, 10),
    cellDegrees: CELL, minRightsPerCell: MIN_RIGHTS,
    rightsUsed: total, cells: rows.length,
    fields: ["lat","lon","rights","domestic","underground","medianPriorityYear","regulatedFrom"],
    caveat: "A diversion point near a parcel does not prove the right conveys with that land — " +
            "Utah water rights are separate property and can be sold away from the ground."
  },
  cells: rows
};

await mkdir(dirname(fileURLToPath(OUT)), { recursive: true });
await writeFile(OUT, JSON.stringify(payload));
const noDom = rows.filter(r => r[3] === 0).length;
console.log(`Wrote ${rows.length.toLocaleString()} cells to data/ut-rights-grid.json`);
console.log(`  ${rows.reduce((a, r) => a + r[3], 0).toLocaleString()} domestic rights`);
console.log(`  ${noDom.toLocaleString()} cells have live rights but NO domestic right`);
