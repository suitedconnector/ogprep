/**
 * Which Arizona counties actually feed the AZGeo statewide parcel layer?
 *
 *   node tools/check-az-county-coverage.mjs
 *
 * The layer has a `Source` field naming the contributing county, but it is not
 * indexed, so `returnDistinctValues` on it times out — same wall we hit trying
 * to search by APN. The spatial index is the only fast path, so this asks a
 * small envelope over each county seat and reports what comes back.
 *
 * Point queries give false negatives when the point lands on a road or an
 * unparcelled sliver, so this uses a small box and takes whatever Source
 * values appear inside it.
 *
 * This matters for two reasons:
 *  - It tells us whether the crawl will actually cover all 15 counties, or
 *    whether some assessors never contributed and need their own adapter.
 *  - Coconino wanted a licence agreement and a fee for their own GIS download.
 *    If their parcels are in this open layer, that requirement does not reach
 *    what we build from here.
 */

const SERVICE =
  "https://azgeo.az.gov/arcgis/rest/services/TerraSystems/AZParcel_Cache/MapServer/0/query";

const UA = "BuildOffGrid/1.0 (+https://buildoffgrid.ogprep.com; coverage check; contact via site)";
const PAD = 0.02;          // ~1.4 miles around the seat
const DELAY_MS = 300;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// County seats. Deliberately the built-up centre, where parcels certainly exist.
const SEATS = [
  ["Apache",      34.506,  -109.380, "St. Johns"],
  ["Cochise",     31.448,  -109.928, "Bisbee"],
  ["Coconino",    35.198,  -111.651, "Flagstaff"],
  ["Gila",        33.394,  -110.786, "Globe"],
  ["Graham",      32.834,  -109.708, "Safford"],
  ["Greenlee",    33.050,  -109.296, "Clifton"],
  ["La Paz",      34.150,  -114.289, "Parker"],
  ["Maricopa",    33.448,  -112.074, "Phoenix"],
  ["Mohave",      35.189,  -114.053, "Kingman"],
  ["Navajo",      34.902,  -110.158, "Holbrook"],
  ["Pima",        32.222,  -110.974, "Tucson"],
  ["Pinal",       33.032,  -111.387, "Florence"],
  ["Santa Cruz",  31.340,  -110.934, "Nogales"],
  ["Yavapai",     34.540,  -112.468, "Prescott"],
  ["Yuma",        32.692,  -114.628, "Yuma"]
];

async function probe(lat, lon) {
  const p = new URLSearchParams({
    geometry: `${(lon - PAD).toFixed(4)},${(lat - PAD).toFixed(4)},` +
              `${(lon + PAD).toFixed(4)},${(lat + PAD).toFixed(4)}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "AZ_APN,Source",
    returnGeometry: "false",
    resultRecordCount: "50",
    f: "json"
  });

  const t = Date.now();
  const r = await fetch(`${SERVICE}?${p}`, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "query failed");

  const feats = j.features || [];
  const sources = new Set();
  for (const f of feats) {
    const s = String(f.attributes.Source || "").trim();
    if (s) sources.add(s);
  }
  return {
    ms: Date.now() - t,
    n: feats.length,
    sources: [...sources],
    sampleApn: feats.length ? String(feats[0].attributes.AZ_APN || "").trim() : null
  };
}

console.log("AZGeo statewide parcel layer — county coverage\n");
console.log("County        Seat          Parcels  Source reported        Sample APN");
console.log("".padEnd(78, "-"));

const missing = [], present = [];

for (const [county, lat, lon, seat] of SEATS) {
  let line;
  try {
    const r = await probe(lat, lon);
    if (!r.n) {
      missing.push(county);
      line = `${county.padEnd(13)} ${seat.padEnd(13)} ${"0".padStart(7)}  ` +
             `(nothing returned — check by hand)`;
    } else {
      present.push(county);
      // Flag when the Source value disagrees with the county we probed; that
      // would mean the seat sits near a line, or the field is inconsistent.
      const src = r.sources.join(", ");
      const odd = r.sources.some(s => !s.toLowerCase().startsWith(county.toLowerCase()));
      line = `${county.padEnd(13)} ${seat.padEnd(13)} ${String(r.n).padStart(7)}  ` +
             `${src.padEnd(22)} ${r.sampleApn || ""}${odd ? "  <- check" : ""}`;
    }
  } catch (e) {
    line = `${county.padEnd(13)} ${seat.padEnd(13)} ${"err".padStart(7)}  ${e.message}`;
  }
  console.log(line);
  await sleep(DELAY_MS);
}

console.log("".padEnd(78, "-"));
console.log(`${present.length} of ${SEATS.length} counties returned parcels.`);

if (missing.length) {
  console.log(`\nNo parcels at the seat for: ${missing.join(", ")}.`);
  console.log("That is not proof of absence — the envelope may have missed, or the");
  console.log("county may publish under a different Source string. Worth a manual");
  console.log("look before assuming those counties need their own adapter.");
} else {
  console.log("\nEvery county contributes. The spatial crawl will cover the whole state,");
  console.log("and no county licence is involved in anything built from this layer.");
}
