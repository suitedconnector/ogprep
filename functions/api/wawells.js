/**
 * Cloudflare Pages Function — /api/wawells?lat=..&lon=..
 *
 * Ecology well reports within a mile, summarised. Most Washington well
 * reports are plotted at the centre of a ~40-acre quarter-quarter section, so
 * per-well distances would be false precision: the page gets counts and a
 * depth distribution, and the reports filed in the parcel's own
 * quarter-quarter (from the BLM survey grid) as "filed in this parcel's
 * quarter-section", never "on this parcel".
 *
 * Owner names and well addresses are in the layer and never leave here.
 */
import { arcQuery, json } from "./_wa.js";

const WELLS = "https://services.arcgis.com/6lCKYNJLvwTXqrmp/arcgis/rest/services/WR/FeatureServer/9";
const PLSS = "https://gis.blm.gov/arcgis/rest/services/Cadastral/BLM_Natl_PLSS_CadNSDI/MapServer/3";
const MILE_M = 1609.344;
const MAX_IDS = 2000;
const CACHE_SECONDS = 60 * 60 * 24 * 7;
const SCHEMA = "v1";

function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo));
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));
  if (!isFinite(lat) || !isFinite(lon)) return json({ ok: false, error: "lat and lon are required" }, 400);

  const key = `https://wawells-cache/${SCHEMA}/${lat.toFixed(4)},${lon.toFixed(4)}`;
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return json({ ...(await hit.json()), cached: true }, 200, CACHE_SECONDS);

  const pt = { x: lon, y: lat, spatialReference: { wkid: 4326 } };
  try {
    const [idq, plss] = await Promise.all([
      arcQuery(WELLS, { geometry: pt, geometryType: "esriGeometryPoint", inSR: 4326, spatialRel: "esriSpatialRelIntersects",
        distance: MILE_M, units: "esriSRUnit_Meter", returnIdsOnly: true }, { timeout: 15000 }),
      arcQuery(PLSS, { geometry: pt, geometryType: "esriGeometryPoint", inSR: 4326, spatialRel: "esriSpatialRelIntersects",
        outFields: "TWNSHPNO,TWNSHPDIR,RANGENO,RANGEDIR,FRSTDIVNO,QQSEC", returnGeometry: false }).catch(() => null)
    ]);
    const ids = (idq.objectIds || []).slice(0, MAX_IDS);
    const batches = [];
    for (let i = 0; i < ids.length; i += 200) batches.push(ids.slice(i, i + 200));
    // resultOffset paging stops early on this layer, so fetch by ID.
    const pages = await Promise.all(batches.map(b => arcQuery(WELLS, { objectIds: b.join(","), returnGeometry: true, outSR: 4326,
      outFields: "WellProjectType,WellSubType,CompletedDepth,StaticWaterLvl,FlowRateGPM,WorkCompletionDate," +
                 "TownshipNr,RangeNr,SectionNr,Qtr,QtrQtr,FileName" }, { timeout: 15000 })));
    const rows = pages.flatMap(p => p.features.map(f => ({ ...f.attributes, x: f.geometry && f.geometry.x, y: f.geometry && f.geometry.y })));

    const water = rows.filter(r => r.WellProjectType === "Water");
    const depths = water.map(r => +r.CompletedDepth).filter(v => v > 0).sort((a, b) => a - b);
    const swl = water.map(r => +r.StaticWaterLvl).filter(v => v > 0).sort((a, b) => a - b);
    const points = new Set(rows.filter(r => r.x != null).map(r => r.x.toFixed(5) + "," + r.y.toFixed(5)));

    const a = plss && plss.features[0] && plss.features[0].attributes;
    const qq = a ? { twp: +a.TWNSHPNO, twpDir: a.TWNSHPDIR, rng: +a.RANGENO, rngDir: a.RANGEDIR, sec: +a.FRSTDIVNO, qq: a.QQSEC } : null;
    const inQQ = qq ? rows.filter(r => +r.SectionNr === qq.sec && +r.TownshipNr === qq.twp && +r.RangeNr === qq.rng &&
                                      `${r.QtrQtr || ""}${r.Qtr || ""}` === qq.qq) : [];

    const payload = {
      ok: true, radiusMiles: 1,
      total: rows.length, truncated: (idq.objectIds || []).length > MAX_IDS,
      distinctPoints: points.size,
      water: {
        count: water.length, withDepth: depths.length,
        minFt: depths[0] ?? null, p25Ft: pct(depths, .25), medianFt: pct(depths, .5), p75Ft: pct(depths, .75),
        maxFt: depths.at(-1) ?? null,
        waterLevelCount: swl.length, medianWaterLevelFt: pct(swl, .5),
        flowCount: water.filter(r => +r.FlowRateGPM > 0).length
      },
      quarterQuarter: qq,
      inQuarterQuarter: inQQ.map(r => ({
        type: r.WellProjectType || null, subtype: r.WellSubType || null,
        depthFt: r.CompletedDepth != null ? Math.round(+r.CompletedDepth) : null,
        year: r.WorkCompletionDate ? new Date(r.WorkCompletionDate).getUTCFullYear() : null,
        file: r.FileName || null
      })),
      note: "Most reports are plotted at the centre of a ~40-acre quarter-quarter section, so locations are " +
            "approximate to about a quarter mile.",
      source: { dataset: "Well Reports", publisher: "Washington State Department of Ecology", service: WELLS,
                grid: "BLM National PLSS (CadNSDI)" },
      cached: false
    };
    const res = json(payload, 200, CACHE_SECONDS);
    await cache.put(key, res.clone());
    return res;
  } catch (e) {
    return json({ ok: false, error: "Ecology well reports unavailable: " + (e.message || e) }, 502);
  }
}
