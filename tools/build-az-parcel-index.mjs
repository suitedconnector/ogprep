/**
 * Build a searchable index of every Arizona parcel.
 *
 *   node tools/build-az-parcel-index.mjs          # crawl (resumable)
 *   node tools/build-az-parcel-index.mjs --shard  # write the lookup files
 *
 * Why this exists: Arizona has no statewide parcel search. Each county assessor
 * runs its own GIS, and only Mohave and Yavapai have adapters. AZGeo publishes
 * a statewide aggregation — but its only indexes are OBJECTID and geometry, so
 * `AZ_APN = '...'` is a full table scan that times out past 12 seconds. Even
 * `where=1=1` ordered by OBJECTID times out, so it cannot be paged out by ID.
 *
 * What DOES work is the spatial index: an envelope query returns 1,000 features
 * in about 350ms. So this walks Arizona geographically instead — a quadtree
 * that subdivides wherever a cell hits the record cap, which is mostly Phoenix
 * and Tucson. Rural Arizona, which is the market, is sparse and cheap to crawl.
 *
 * Output per parcel: APN, centroid, ACREAGE, county, address. The service
 * publishes no centroid and no dependable area, so both are computed here from
 * the rings — which we are downloading anyway, making acreage free.
 *
 * Licensing note: this reads only the open AZGeo endpoint. No county licence is
 * signed and no fee-bearing product is downloaded, which keeps the resulting
 * index free of the redistribution terms that county GIS files carry.
 *
 * Politeness: one request at a time with a delay between. This is a shared
 * state server and we already learned that lesson on Utah's well logs. The
 * crawl is resumable, so it can be stopped and restarted freely.
 */

import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SERVICE =
  "https://azgeo.az.gov/arcgis/rest/services/TerraSystems/AZParcel_Cache/MapServer/0/query";

const OUT_DIR   = new URL("../data/az-parcels/", import.meta.url);
const RAW       = new URL("../data/az-parcels/raw.jsonl", import.meta.url);
const STATE     = new URL("../data/az-parcels/crawl-state.json", import.meta.url);

// Arizona, generously bounded.
const BOX = { s: 31.30, n: 37.05, w: -114.85, e: -109.00 };

const START_CELL = 0.25;    // degrees — coarse first pass, subdivided as needed
const MIN_CELL   = 0.004;   // ~450m. Below this we accept truncation and log it.
const PAGE       = 1000;    // the layer's maxRecordCount
const DELAY_MS   = 250;     // between requests
const RETRIES    = 3;

const UA = "BuildOffGrid/1.0 (+https://buildoffgrid.ogprep.com; parcel index; contact via site)";
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* One envelope query. Returns features plus whether the cap was hit. */
async function fetchCell(b) {
  const p = new URLSearchParams({
    geometry: `${b.w},${b.s},${b.e},${b.n}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326", outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "AZ_APN,AZ_Address,Source,Shape_Area",
    returnGeometry: "true", geometryPrecision: "6",
    resultRecordCount: String(PAGE), f: "json"
  });

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const r = await fetch(`${SERVICE}?${p}`, { headers: { "User-Agent": UA } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || "query failed");
      return { feats: j.features || [], capped: !!j.exceededTransferLimit };
    } catch (e) {
      if (attempt === RETRIES) throw e;
      process.stdout.write(` retry`);
      await sleep(1200 * (attempt + 1));
    }
  }
}

/* ---- geometry ------------------------------------------------------------
   The layer supports neither returnCentroid nor a trustworthy acreage field,
   so both are derived here from rings we are already paying to download.

   On Shape_Area: the layer reports sourceSpatialReference 26912 (UTM 12N,
   metres) but publishes its extent in 102100 (web mercator), which would
   overstate area by 1/cos²(lat) — about 49% here. Resolved against APN
   20103087: read as metres it gives 11,492 acres against our measured
   11,487.7, a ratio of 1.0004, so it is metres. We measure anyway, because the
   rings are already downloaded for the centroid and measuring on the sphere
   avoids the UTM scale factor, which grows west of zone 12 across Mohave, La
   Paz and Yuma — exactly the counties this product cares about. The ratio is
   still sampled and reported at the end, now as a regression check.

   Area is by the spherical-excess formula on the authalic sphere. Well under
   0.1% error at parcel scale, which is far tighter than the boundaries
   themselves are surveyed. Rings come back closed and ArcGIS winds outer rings
   clockwise and holes counter-clockwise, so signed areas summed across rings
   net the holes out automatically. */

/* The authalic radius — the sphere with the same surface area as the WGS84
   ellipsoid. Most implementations of this formula (Turf among them) use the
   equatorial radius 6378137 instead, which inflates every area by 0.22%.
   That is small, but it is a bias rather than noise: it would push every
   parcel in the state the same direction, so it is worth not having. */
const R_EARTH = 6371007.181;
const rad = d => d * Math.PI / 180;
const M2_PER_ACRE = 4046.8564224;

/* ArcGIS repeats the first vertex to close a ring; drop it before wrapping. */
function openRing(r) {
  const n = r.length;
  return (n > 1 && r[0][0] === r[n - 1][0] && r[0][1] === r[n - 1][1]) ? r.slice(0, n - 1) : r;
}

/* Signed geodesic area in square metres. Sign carries ring orientation. */
function ringAreaM2(ring) {
  const n = ring.length;
  if (n < 3) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const p1 = ring[i], p2 = ring[(i + 1) % n], p3 = ring[(i + 2) % n];
    total += (rad(p3[0]) - rad(p1[0])) * Math.sin(rad(p2[1]));
  }
  return (total * R_EARTH * R_EARTH) / 2;
}

/* Planar area-weighted centroid of one ring. Degrees in, [lat, lon] out. */
function ringCentroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % n];
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-14) {          // degenerate sliver — fall back to the vertex mean
    const sx = ring.reduce((s, v) => s + v[0], 0), sy = ring.reduce((s, v) => s + v[1], 0);
    return [+(sy / ring.length).toFixed(6), +(sx / ring.length).toFixed(6)];
  }
  a *= 0.5;
  return [+(cy / (6 * a)).toFixed(6), +(cx / (6 * a)).toFixed(6)];
}

/* One pass over the rings: acreage net of holes, centroid of the largest part. */
function measure(geom) {
  if (!geom || !geom.rings || !geom.rings.length) return null;

  let signedTotal = 0, best = null, bestAbs = -1;
  for (const raw of geom.rings) {
    const ring = openRing(raw);
    if (ring.length < 3) continue;
    const a = ringAreaM2(ring);
    signedTotal += a;
    if (Math.abs(a) > bestAbs) { bestAbs = Math.abs(a); best = ring; }
  }
  if (!best) return null;

  const m2 = Math.abs(signedTotal);
  return {
    centroid: ringCentroid(best),
    // Two decimals below an acre, three above nothing — small lots need the resolution.
    acres: m2 > 0 ? +(m2 / M2_PER_ACRE).toFixed(3) : null,
    m2
  };
}

async function loadState() {
  if (!existsSync(fileURLToPath(STATE))) return { done: [], parcels: 0, truncated: [] };
  try { return JSON.parse(await readFile(STATE, "utf8")); }
  catch { return { done: [], parcels: 0, truncated: [] }; }
}

const ratios = [];   // Shape_Area ÷ our geodesic area, sampled for the report below

async function crawl() {
  await mkdir(dirname(fileURLToPath(RAW)), { recursive: true });
  const state = await loadState();
  const done = new Set(state.done);
  let parcels = state.parcels, requests = 0, started = Date.now();

  // Seed the queue with the coarse grid, skipping anything already crawled.
  const queue = [];
  for (let s = BOX.s; s < BOX.n; s += START_CELL)
    for (let w = BOX.w; w < BOX.e; w += START_CELL)
      queue.push({ s: +s.toFixed(4), n: +Math.min(s + START_CELL, BOX.n).toFixed(4),
                   w: +w.toFixed(4), e: +Math.min(w + START_CELL, BOX.e).toFixed(4) });

  console.log(`Arizona parcel crawl — ${queue.length} coarse cells, ${done.size} already done.`);
  console.log("Resumable: stop with Ctrl-C and re-run to continue.\n");

  const seen = new Set();   // parcels straddling a cell edge come back twice

  while (queue.length) {
    const b = queue.pop();
    const key = `${b.s},${b.w},${b.n},${b.e}`;
    if (done.has(key)) continue;

    let res;
    try { res = await fetchCell(b); }
    catch (e) {
      console.log(`\n  ! ${key} failed: ${e.message} — leaving for a later run`);
      continue;
    }
    requests++;

    if (res.capped) {
      const dy = (b.n - b.s) / 2, dx = (b.e - b.w) / 2;
      if (dy > MIN_CELL) {
        // Too many parcels here; split into quarters and try again.
        for (const [s, w] of [[b.s, b.w], [b.s + dy, b.w], [b.s, b.w + dx], [b.s + dy, b.w + dx]])
          queue.push({ s: +s.toFixed(4), n: +(s + dy).toFixed(4),
                       w: +w.toFixed(4), e: +(w + dx).toFixed(4) });
        continue;
      }
      // Already at the floor — record the gap rather than pretending it is complete.
      state.truncated.push(key);
    }

    const lines = [];
    for (const f of res.feats) {
      const apn = String(f.attributes.AZ_APN || "").trim();
      if (!apn || seen.has(apn)) continue;
      const m = measure(f.geometry);
      if (!m) continue;
      seen.add(apn);

      // Sample how the layer's own Shape_Area compares, so we can say afterwards
      // whether that field was metres or web mercator. Diagnostic only.
      const sa = Number(f.attributes.Shape_Area);
      if (ratios.length < 2000 && isFinite(sa) && sa > 0 && m.m2 > 0) ratios.push(sa / m.m2);

      lines.push(JSON.stringify({
        apn,
        lat: m.centroid[0], lon: m.centroid[1],
        acres: m.acres,
        county: String(f.attributes.Source || "").replace(/\s*County$/i, "").trim() || null,
        addr: (f.attributes.AZ_Address || "").trim() || null
      }));
    }
    if (lines.length) { await appendFile(RAW, lines.join("\n") + "\n"); parcels += lines.length; }

    done.add(key);
    if (requests % 20 === 0) {
      state.done = [...done]; state.parcels = parcels;
      await writeFile(STATE, JSON.stringify(state));
      const mins = ((Date.now() - started) / 60000).toFixed(1);
      process.stdout.write(`\r  ${parcels.toLocaleString()} parcels · ${requests} requests · ` +
                           `${queue.length} cells queued · ${mins} min`);
    }
    await sleep(DELAY_MS);
  }

  state.done = [...done]; state.parcels = parcels;
  await writeFile(STATE, JSON.stringify(state));
  console.log(`\n\nDone. ${parcels.toLocaleString()} parcels in ${requests} requests.`);

  if (ratios.length) {
    const s = [...ratios].sort((a, b) => a - b);
    const r = s[s.length >> 1];
    console.log(`  Shape_Area ÷ geodesic area, median of ${s.length}: ${r.toFixed(4)}`);
    console.log(r > 1.3
      ? "    → the layer's Shape_Area is web mercator and overstates acreage. Ignore it; ours is right."
      : r > 0.95 && r < 1.05
        ? "    → Shape_Area agrees with ours, so it was metres after all. Good cross-check."
        : "    → neither metres nor web mercator. Worth a look before trusting either number.");
  }

  if (state.truncated.length)
    console.log(`  ${state.truncated.length} cells hit the record cap at minimum size — ` +
                `some parcels there are missing.`);
  console.log(`Next: node tools/build-az-parcel-index.mjs --shard`);
}

/* Split into per-prefix files so a lookup fetches ~100KB, not 100MB.
   Static files on Pages — no database, no query cost. */
async function shard() {
  const text = await readFile(RAW, "utf8");
  const buckets = new Map();
  const acreage = [];
  let n = 0;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const key = r.apn.replace(/[^0-9A-Za-z]/g, "").toUpperCase().slice(0, 3) || "___";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push([r.apn, r.lat, r.lon, r.acres ?? null, r.county, r.addr]);
    if (r.acres > 0) acreage.push(r.acres);
    n++;
  }

  await mkdir(fileURLToPath(new URL("./shards/", OUT_DIR)), { recursive: true });
  for (const [key, rows] of buckets) {
    await writeFile(new URL(`./shards/${key}.json`, OUT_DIR),
      JSON.stringify({ prefix: key, fields: ["apn","lat","lon","acres","county","address"], rows }));
  }

  const sorted = acreage.sort((a, b) => a - b);
  const pick = p => sorted.length ? sorted[Math.floor(sorted.length * p)] : null;

  await writeFile(new URL("./index.json", OUT_DIR), JSON.stringify({
    built: new Date().toISOString().slice(0, 10),
    source: "AZGeo statewide parcel cache (TerraSystems/AZParcel_Cache)",
    note: "Crawled spatially because the layer indexes only geometry. Centroids and acreage " +
          "are computed here from the parcel rings — the service offers neither.",
    parcels: n, withAcreage: sorted.length, shards: [...buckets.keys()].sort(),
    acres: { p10: pick(0.10), median: pick(0.50), p90: pick(0.90), max: sorted[sorted.length - 1] ?? null },
    caveat: "Acreage is the mapped geometry, which is the assessor's drawing and not a survey. " +
            "It will disagree with a deed or a plat, sometimes materially on old rural splits. " +
            "Ownership and valuation are not in this layer and stay with the counties."
  }));

  console.log(`Sharded ${n.toLocaleString()} parcels into ${buckets.size} files.`);
  if (sorted.length)
    console.log(`  Acreage on ${sorted.length.toLocaleString()}: ` +
                `median ${pick(0.50)}, p10 ${pick(0.10)}, p90 ${pick(0.90)}.`);
}

if (process.argv.includes("--shard")) await shard();
else await crawl();
