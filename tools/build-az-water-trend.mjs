/**
 * Build the Arizona water table trend grid.
 *
 *   node tools/build-az-water-trend.mjs
 *
 * Writes data/az-water-trend.json — for each ~2.8 mile cell, the median depth
 * to water in wells drilled before 1995 against those drilled since 2005, and
 * the difference.
 *
 * Why this matters more than depth alone: a well is a thirty-year purchase. A
 * parcel where water sits at 120 ft today but has fallen 200 ft since 1990 is
 * a different proposition from one that has been stable since the war, and no
 * listing, county record or state tool puts those side by side.
 *
 * Statewide the trend is stark — median depth to water roughly doubled between
 * the late 1970s and the 2020s. But that aggregate is confounded: later wells
 * may simply be in worse country. Comparing wells drilled in the SAME cell in
 * different eras controls for geography, which is what this does.
 *
 * Honest limits, carried through to the UI:
 *  - Still not a controlled measurement. Well purpose and construction changed
 *    over fifty years, and deeper wells may reflect ambition as much as decline.
 *  - Static water level is recorded at the time of drilling, so this is a
 *    comparison of snapshots decades apart, not a monitored time series.
 *  - Cells need at least MIN_ERA wells in each era or they are omitted.
 *
 * Input: the ADWR Wells55 full export CSV. Point INPUT at wherever it lives.
 */

import { createReadStream } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import proj4 from "proj4";

const INPUT = process.argv[2] ||
  new URL("../data/AZ_Well_Registry_2024.csv", import.meta.url).pathname;
const OUT = new URL("../data/az-water-trend.json", import.meta.url);

const CELL = 0.04;        // ~2.8 miles. Trend needs more samples than a median.
const OLD_MAX = 1994;     // "before" era ends
const NEW_MIN = 2005;     // "after" era begins — a decade gap sharpens the signal
const MIN_ERA = 4;        // wells required in EACH era, or the cell is dropped

// ADWR publishes UTM Zone 12N (NAD83).
proj4.defs("EPSG:26912",
  "+proj=utm +zone=12 +datum=NAD83 +units=m +no_defs");
const toWGS = c => proj4("EPSG:26912", "EPSG:4326", c);

const YEAR = /\b(19\d{2}|20[0-2]\d)\b/;

const median = a => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), i = s.length >> 1;
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
};

/* Minimal CSV line splitter — the export quotes owner names containing commas. */
function split(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const cells = new Map();
let rows = 0, used = 0;

const rl = createInterface({ input: createReadStream(INPUT), crlfDelay: Infinity });
let head = null, idx = {};

for await (const line of rl) {
  if (!head) {
    head = split(line).map(h => h.replace(/^﻿/, "").trim());
    ["Well Depth", "Water Level", "Installed", "UTM X Meters", "UTM Y Meters"]
      .forEach(k => { idx[k] = head.indexOf(k); });
    if (Object.values(idx).some(v => v < 0)) {
      console.error("Unexpected columns. Found:", head.slice(0, 60).join(" | "));
      process.exit(1);
    }
    continue;
  }
  rows++;
  const f = split(line);

  const depth = parseFloat(f[idx["Well Depth"]] || "0");
  if (!(depth > 20 && depth < 5000)) continue;

  const m = YEAR.exec(f[idx["Installed"]] || "");
  if (!m) continue;
  const year = +m[1];

  const x = parseFloat(f[idx["UTM X Meters"]]), y = parseFloat(f[idx["UTM Y Meters"]]);
  if (!(x > 200000 && x < 800000 && y > 3400000 && y < 4200000)) continue;
  const [lon, lat] = toWGS([x, y]);
  if (!(lat >= 31 && lat <= 37.1 && lon >= -115 && lon <= -108.9)) continue;

  const key = `${Math.round(lat / CELL)},${Math.round(lon / CELL)}`;
  let c = cells.get(key);
  if (!c) cells.set(key, c = { oD: [], nD: [], oW: [], nW: [] });

  const wl = parseFloat(f[idx["Water Level"]] || "0");
  const hasWl = wl > 0 && wl < 3000;

  if (year <= OLD_MAX)      { c.oD.push(depth); if (hasWl) c.oW.push(wl); }
  else if (year >= NEW_MIN) { c.nD.push(depth); if (hasWl) c.nW.push(wl); }
  used++;
}

const out = [];
for (const [key, c] of cells) {
  const haveW = c.oW.length >= MIN_ERA && c.nW.length >= MIN_ERA;
  const haveD = c.oD.length >= MIN_ERA && c.nD.length >= MIN_ERA;
  if (!haveW && !haveD) continue;

  const [a, b] = key.split(",").map(Number);
  const oW = haveW ? Math.round(median(c.oW)) : null;
  const nW = haveW ? Math.round(median(c.nW)) : null;
  const oD = haveD ? Math.round(median(c.oD)) : null;
  const nD = haveD ? Math.round(median(c.nD)) : null;

  out.push([
    +(a * CELL).toFixed(3), +(b * CELL).toFixed(3),
    oW, nW, haveW ? nW - oW : null,          // depth to water: before, after, change
    oD, nD, haveD ? nD - oD : null,          // well depth: before, after, change
    c.oW.length + c.oD.length, c.nW.length + c.nD.length
  ]);
}
out.sort((p, q) => (q[4] ?? -9999) - (p[4] ?? -9999));

const changes = out.map(r => r[4]).filter(v => v != null);
const falling = changes.filter(v => v > 0).length;

await mkdir(dirname(fileURLToPath(OUT)), { recursive: true });
await writeFile(OUT, JSON.stringify({
  _meta: {
    source: "ADWR Wells55 / AZ Well Registry (full export)",
    built: new Date().toISOString().slice(0, 10),
    cellDegrees: CELL, minWellsPerEra: MIN_ERA,
    eras: { before: `≤${OLD_MAX}`, after: `≥${NEW_MIN}` },
    wellsConsidered: used, cells: out.length,
    fields: ["lat","lon","waterBefore","waterAfter","waterChange",
             "depthBefore","depthAfter","depthChange","wellsBefore","wellsAfter"],
    caveat: "Static water level is recorded when a well is drilled, so this compares " +
            "snapshots decades apart rather than a monitored series. Same-cell comparison " +
            "controls for geography but not for changes in well purpose or construction."
  },
  cells: out
}));

console.log(`Read ${rows.toLocaleString()} rows, used ${used.toLocaleString()}.`);
console.log(`Wrote ${out.length.toLocaleString()} comparable cells to data/az-water-trend.json`);
console.log(`  ${falling.toLocaleString()} of ${changes.length.toLocaleString()} ` +
            `(${Math.round(100 * falling / changes.length)}%) show water getting deeper`);
console.log(`  median change ${median(changes).toFixed(1)} ft`);
