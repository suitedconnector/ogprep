/**
 * Cloudflare Pages Function — /api/slope?lat=..&lon=..[&poly=lon lat,lon lat,...]
 *
 * Slope across a parcel from USGS 3DEP elevation: mean, max, and the share of
 * the parcel steeper than 15% and 30% grade. Without a parcel outline it
 * measures a 100 m circle around the point and says so (scope: "around").
 *
 * 3DEP serves 1 m lidar where it exists and silently falls back to ~10 m
 * (1/3 arc-second) where it does not, including holes inside lidar tiles. The
 * raster actually served at the point is reported so the page can say which
 * one it was: 10 m data can miss a short steep bank.
 *
 * The service returns whole-degree histogram bins; shares are interpolated
 * within a bin. Federal data, public domain.
 */
import { getJson, polyFromParam, circle, json } from "./_wa.js";

const DEM = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer";
const CACHE_SECONDS = 60 * 60 * 24 * 30;
const SCHEMA = "v1";
const gradeToDeg = g => Math.atan(g / 100) * 180 / Math.PI;
const degToGrade = d => Math.round(Math.tan(d * Math.PI / 180) * 100);

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));
  if (!isFinite(lat) || !isFinite(lon)) return json({ ok: false, error: "lat and lon are required" }, 400);
  const polyRaw = url.searchParams.get("poly");
  const poly = polyFromParam(polyRaw);
  if (polyRaw && !poly) return json({ ok: false, error: "poly must be 3 to 400 'lon lat' pairs" }, 400);

  const key = `https://slope-cache/${SCHEMA}/${lat.toFixed(5)},${lon.toFixed(5)}/${polyRaw ? polyRaw.length + ":" + polyRaw.slice(0, 60) + polyRaw.slice(-60) : "c"}`;
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return json({ ...(await hit.json()), cached: true }, 200, CACHE_SECONDS);

  const geom = poly || circle(lat, lon, 100);
  try {
    const hp = new URLSearchParams({
      geometry: JSON.stringify(geom), geometryType: "esriGeometryPolygon",
      renderingRule: JSON.stringify({ rasterFunction: "Slope Degrees" }),
      pixelSize: JSON.stringify({ x: 1, y: 1, spatialReference: { wkid: 3857 } }), f: "json"
    }).toString();
    const sp = new URLSearchParams({
      geometry: JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }),
      geometryType: "esriGeometryPoint", returnFirstValueOnly: "true", outFields: "*", f: "json"
    }).toString();
    // The USGS service throws an occasional 502 that clears on a second try.
    const histogram = () => getJson(DEM + "/computeStatisticsHistograms", { body: hp, timeout: 20000 });
    const [h, s] = await Promise.all([
      histogram().catch(() => new Promise(r => setTimeout(r, 800)).then(histogram)),
      getJson(DEM + "/getSamples", { body: sp, timeout: 15000 }).catch(() => null)
    ]);
    const st = h.statistics && h.statistics[0], hist = h.histograms && h.histograms[0];
    if (!st || !hist) throw new Error("no elevation statistics for this area");

    const n = hist.counts.reduce((a, b) => a + b, 0), w = (hist.max - hist.min) / hist.size;
    const share = deg => {
      let c = 0;
      hist.counts.forEach((k, i) => {
        const lo = hist.min + i * w, hi = lo + w;
        if (lo >= deg) c += k; else if (hi > deg) c += k * (hi - deg) / w;
      });
      return Math.round(100 * c / n);
    };

    const sample = s && s.samples && s.samples[0];
    const rasterName = sample && sample.attributes && (sample.attributes.Name || sample.attributes.ProductName) || null;
    // Seamless 1/3 arc-second tiles are named like "n46w122"; anything else is
    // a lidar project (1 m).
    const coarse = !rasterName || /^n\d{2}w\d{3}$/i.test(String(rasterName));

    const meanDeg = +(+st.mean).toFixed(1), maxDeg = Math.round(+st.max);
    const payload = {
      ok: true,
      scope: poly ? "parcel" : "around",
      meanDeg, meanGrade: degToGrade(meanDeg),
      maxDeg, maxGrade: degToGrade(maxDeg),
      over15: share(gradeToDeg(15)),
      over30: share(gradeToDeg(30)),
      resolution: coarse ? "about 10 m" : "1 m lidar",
      raster: rasterName,
      elevationM: sample ? +(+sample.value).toFixed(1) : null,
      note: (coarse
        ? "Measured from about 10 m elevation data, the best USGS serves here; it can miss a short steep bank. "
        : "Measured from 1 m lidar elevation. ") +
        "A mapped estimate, not a survey.",
      source: { dataset: "USGS 3D Elevation Program (3DEP)", publisher: "U.S. Geological Survey", service: DEM },
      cached: false
    };
    const res = json(payload, 200, CACHE_SECONDS);
    await cache.put(key, res.clone());
    return res;
  } catch (e) {
    return json({ ok: false, error: "Elevation service unavailable: " + (e.message || e) }, 502);
  }
}
