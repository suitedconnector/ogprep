/**
 * Cloudflare Pages Function — /api/hazards?county=..&lat=..&lon=..[&poly=lon lat,...]
 *
 * Geologic hazards and planning layers, where a county publishes them in a
 * form a script can read. Statewide DNR geology services need a token, so
 * this works county by county; a county without an entry answers
 * { supported: false } and the page says "Not assessed yet — ask county
 * planning".
 *
 * Skamania re-hosts the WA DNR landslide inventory and its own zoning, city
 * limits and urban areas. SCC 19.07 requires a geotechnical letter for work
 * in, or within 100 ft of, a mapped landslide hazard area, so deposits are
 * reported both on the parcel and within 100 ft.
 */
import { arcQuery, polyFromParam, circle, json, countyByKey } from "./_wa.js";

const CACHE_SECONDS = 60 * 60 * 24 * 7;
const SCHEMA = "v1";
const TRIGGER_M = 30.48;   // 100 ft

const SKAMANIA = "https://services3.arcgis.com/uKh72TYBlxpm42Cm/arcgis/rest/services";
const COUNTIES = {
  Skamania: {
    landslides: {
      deposits: `${SKAMANIA}/Landslide_Deposit/FeatureServer/21`,
      scarps: `${SKAMANIA}/Scarps_and_Flanks/FeatureServer/3`,
      recent: `${SKAMANIA}/Recent_Landslides/FeatureServer/1`,
      rule: {
        code: "SCC 19.07",
        url: "https://codepublishing.com/WA/SkamaniaCounty/html/SkamaniaCounty19/SkamaniaCounty1907.html",
        text: "Skamania County requires a geotechnical letter for regulated work in, or within 100 ft of, a " +
              "mapped landslide hazard area, and a full geotechnical report if the letter cannot clear it."
      },
      source: "WA DNR landslide inventory, as hosted by Skamania County GIS"
    },
    zoning: `${SKAMANIA}/Zoning_Designation/FeatureServer/0`,
    city: `${SKAMANIA}/CityLimits/FeatureServer/0`,
    urban: `${SKAMANIA}/Urban_Areas/FeatureServer/0`,
    planning: { office: "Skamania County Community Development", phone: "(509) 427-3900" }
  }
};

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));
  if (!isFinite(lat) || !isFinite(lon)) return json({ ok: false, error: "lat and lon are required" }, 400);
  const c = countyByKey(url.searchParams.get("county") || "");
  const cfg = c && COUNTIES[c[0]];
  if (!cfg) return json({ ok: true, supported: false, county: c ? c[0] : null }, 200, 3600);

  const polyRaw = url.searchParams.get("poly");
  const poly = polyFromParam(polyRaw);
  const key = `https://hazards-cache/${SCHEMA}/${c[0]}/${lat.toFixed(5)},${lon.toFixed(5)}/${polyRaw ? polyRaw.length + ":" + polyRaw.slice(0, 60) : "p"}`;
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return json({ ...(await hit.json()), cached: true }, 200, CACHE_SECONDS);

  const area = poly || circle(lat, lon, 30);
  const on = { geometry: area, geometryType: "esriGeometryPolygon", inSR: 4326, spatialRel: "esriSpatialRelIntersects", returnGeometry: false };
  const near = { ...on, distance: TRIGGER_M, units: "esriSRUnit_Meter" };

  try {
    const L = cfg.landslides;
    const DEP = "LANDSLIDE_ID,LS_NAME,MATERIAL,MOVEMENT,CONFIDENCE,RELATIVE_AGE,FIELD_VERIFIED";
    const [depOn, depNear, scarps, recent, zoning, city, urban] = await Promise.all([
      arcQuery(L.deposits, { ...on, outFields: "LANDSLIDE_ID" }),
      arcQuery(L.deposits, { ...near, outFields: DEP }),
      arcQuery(L.scarps, { ...near, outFields: "LANDSLIDE_ID" }),
      arcQuery(L.recent, { ...near, outFields: "*" }),
      arcQuery(cfg.zoning, { ...on, outFields: "Zoning,ZoneCode,ZoneDesc,CompPlan,Zoning_URL" }),
      arcQuery(cfg.city, { ...on, outFields: "CITY_NAME" }),
      arcQuery(cfg.urban, { ...on, outFields: "Name" })
    ]);
    const onIds = new Set(depOn.features.map(f => f.attributes.LANDSLIDE_ID));
    const deposits = depNear.features.map(f => f.attributes).map(a => ({
      id: a.LANDSLIDE_ID, name: a.LS_NAME || null, material: a.MATERIAL || null, movement: a.MOVEMENT || null,
      confidence: a.CONFIDENCE || null, age: a.RELATIVE_AGE || null, fieldVerified: a.FIELD_VERIFIED || null,
      onParcel: onIds.has(a.LANDSLIDE_ID)
    }));
    const payload = {
      ok: true, supported: true, county: c[0], scope: poly ? "parcel" : "point",
      landslides: {
        deposits, scarps: scarps.features.length, recent: recent.features.length,
        triggered: deposits.length > 0 || scarps.features.length > 0 || recent.features.length > 0,
        rule: L.rule, source: L.source
      },
      zoning: zoning.features.map(f => f.attributes).map(z => ({
        code: z.ZoneCode || z.Zoning || null, name: z.ZoneDesc || z.Zoning || null, compPlan: z.CompPlan || null, url: z.Zoning_URL || null })),
      cityLimits: city.features.map(f => f.attributes.CITY_NAME).filter(Boolean),
      urbanArea: urban.features.map(f => f.attributes.Name).filter(Boolean),
      planning: cfg.planning,
      cached: false
    };
    const res = json(payload, 200, CACHE_SECONDS);
    await cache.put(key, res.clone());
    return res;
  } catch (e) {
    return json({ ok: false, supported: true, county: c[0], error: "County hazard layers unavailable: " + (e.message || e) }, 502);
  }
}
