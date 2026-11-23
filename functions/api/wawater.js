/**
 * Cloudflare Pages Function — /api/wawater?lat=..&lon=..[&poly=lon lat,...]
 *
 * Washington water, before wells:
 *   1. Is the parcel inside a public water system's service area? (WA DOH)
 *      If so, a connection may make the well question moot.
 *   2. Water rights near the parcel, from Ecology's places of use: counts by
 *      phase within a mile, and the documents whose place of use covers the
 *      parcel.
 *
 * Claims are filings under the 1967 claims registration act, not confirmed
 * rights, and are counted separately so the page can label them "Claim only".
 * A water system's certificate covering an area is the system's right, not
 * the parcel's. Person names are never returned; organisations are.
 */
import { arcQuery, polyFromParam, circle, json } from "./_wa.js";

const DOH = "https://services8.arcgis.com/rGGrs6HCnw87OFOT/arcgis/rest/services/Drinking_Water_Service_Areas/FeatureServer/0";
const WR = "https://services.arcgis.com/6lCKYNJLvwTXqrmp/arcgis/rest/services/WR/FeatureServer";
const MILE_M = 1609.344;
const CACHE_SECONDS = 60 * 60 * 24 * 7;
const SCHEMA = "v1";

const CLAIM = /^claim/i;
const CERT = /certificate/i;
const PERMIT = /^permit/i;

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));
  if (!isFinite(lat) || !isFinite(lon)) return json({ ok: false, error: "lat and lon are required" }, 400);
  const polyRaw = url.searchParams.get("poly");
  const poly = polyFromParam(polyRaw);

  const key = `https://wawater-cache/${SCHEMA}/${lat.toFixed(5)},${lon.toFixed(5)}/${polyRaw ? polyRaw.length + ":" + polyRaw.slice(0, 60) : "p"}`;
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return json({ ...(await hit.json()), cached: true }, 200, CACHE_SECONDS);

  const area = poly || circle(lat, lon, 30);
  const onArea = { geometry: area, geometryType: "esriGeometryPolygon", inSR: 4326, spatialRel: "esriSpatialRelIntersects" };
  const nearMile = { geometry: { x: lon, y: lat, spatialReference: { wkid: 4326 } }, geometryType: "esriGeometryPoint",
    inSR: 4326, spatialRel: "esriSpatialRelIntersects", distance: MILE_M, units: "esriSRUnit_Meter" };

  /* 1. Public water systems */
  let systems = null, systemsError = null;
  try {
    const j = await arcQuery(DOH, { ...onArea, returnGeometry: false,
      outFields: "WS_Name,WS_ID,WS_Grp,WS_Type,ServiceAreaType,Contact_Phone,WS_City,WS_Status,Total_Conn,DataSourceDate" });
    systems = j.features.map(f => f.attributes).filter(a => !/inactive/i.test(a.WS_Status || "")).map(a => ({
      name: a.WS_Name, id: a.WS_ID, group: a.WS_Grp, type: a.WS_Type, areaType: a.ServiceAreaType,
      phone: a.Contact_Phone || null, city: a.WS_City || null, connections: a.Total_Conn ?? null,
      sourceDate: a.DataSourceDate ? new Date(a.DataSourceDate).toISOString().slice(0, 10) : null
    }));
  } catch (e) { systemsError = String(e.message || e); }

  /* 2. Water rights */
  let rights = null, rightsError = null;
  try {
    const [on, mile] = await Promise.all([
      arcQuery(WR + "/6", { ...onArea, outFields: "WR_DOC_ID", returnGeometry: false }),
      arcQuery(WR + "/6", { ...nearMile, outFields: "WR_DOC_ID", returnGeometry: false })
    ]);
    const ids = [...new Set(mile.features.map(f => f.attributes.WR_DOC_ID))];
    const onIds = new Set(on.features.map(f => f.attributes.WR_DOC_ID));
    const docs = new Map();
    const batches = [];
    for (let i = 0; i < ids.length; i += 150) batches.push(ids.slice(i, i + 150));
    const results = await Promise.all(batches.map(b => arcQuery(WR + "/10", {
      where: `WR_Doc_ID IN (${b.join(",")})`, returnGeometry: false,
      outFields: "WR_Doc_ID,WaRecPhaseTypeCode,WaRecProcessStatusTypeCode,WaRecRCWClassTypeCode,WaRecPrimaryNumber," +
                 "PriorityDate,PurposeOfUseTypeCodes,InstantaneousQuantity,InstantaneousUnitCode,AnnualVolumeQuantity," +
                 "PersonLastOrOrganizationNM,PersonFirstNM"
    })));
    for (const r of results) for (const f of r.features) {
      const a = f.attributes;
      if (!docs.has(a.WR_Doc_ID)) docs.set(a.WR_Doc_ID, a);
    }
    const all = [...docs.values()];
    const active = all.filter(a => !/cancel|withdraw|reject|denied/i.test(a.WaRecProcessStatusTypeCode || ""));
    const count = re => active.filter(a => re.test(a.WaRecPhaseTypeCode || "")).length;
    rights = {
      radiusMiles: 1,
      total: active.length,
      claims: count(CLAIM),
      certificates: count(CERT),
      permits: count(PERMIT),
      other: active.length - count(CLAIM) - count(CERT) - count(PERMIT),
      groundwater: active.filter(a => /ground/i.test(a.WaRecRCWClassTypeCode || "")).length,
      surface: active.filter(a => /surface/i.test(a.WaRecRCWClassTypeCode || "")).length,
      covering: all.filter(a => onIds.has(a.WR_Doc_ID)).map(a => ({
        number: a.WaRecPrimaryNumber, phase: a.WaRecPhaseTypeCode, status: a.WaRecProcessStatusTypeCode,
        source: a.WaRecRCWClassTypeCode, purpose: String(a.PurposeOfUseTypeCodes || "").trim() || null,
        priority: a.PriorityDate ? new Date(a.PriorityDate).toISOString().slice(0, 10) : null,
        cfs: a.InstantaneousUnitCode && /cfs/i.test(a.InstantaneousUnitCode) ? a.InstantaneousQuantity : null,
        gpm: a.InstantaneousUnitCode && /gpm/i.test(a.InstantaneousUnitCode) ? a.InstantaneousQuantity : null,
        acreFeet: a.AnnualVolumeQuantity ?? null,
        // Organisations only. A person's name never leaves this Function.
        holder: a.PersonFirstNM ? null : (a.PersonLastOrOrganizationNM || null),
        claim: CLAIM.test(a.WaRecPhaseTypeCode || "")
      }))
    };
  } catch (e) { rightsError = String(e.message || e); }

  if (!systems && !rights) {
    return json({ ok: false, error: "Washington water services unavailable: " + (systemsError || rightsError) }, 502);
  }
  const payload = {
    ok: true, scope: poly ? "parcel" : "point",
    systems, systemsError, rights, rightsError,
    source: {
      systems: { dataset: "Drinking Water Service Areas", publisher: "Washington State Department of Health", service: DOH },
      rights: { dataset: "Water Rights places of use and tracking system", publisher: "Washington State Department of Ecology", service: WR }
    },
    cached: false
  };
  const res = json(payload, 200, CACHE_SECONDS);
  if (systems && rights) await cache.put(key, res.clone());
  return res;
}
