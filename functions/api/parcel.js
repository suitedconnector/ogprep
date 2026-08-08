/**
 * Cloudflare Pages Function — parcel lookup
 *
 *   /api/parcel?apn=306-32-007J&county=mohave
 *   /api/parcel?address=5413%20W%20Brook%20Dr&county=mohave
 *   /api/parcel?lat=35.2140&lon=-114.2230           (point → parcel, county auto-detected)
 *
 * Returns the parcel's coordinates plus context, including how developed the
 * surrounding area is. On rural land with no municipal sewer, a developed
 * neighbouring parcel means somebody obtained a septic permit and a water
 * source there — observed evidence rather than a modelled interpretation.
 *
 * Each Arizona county runs its own GIS with its own schema, so counties are
 * added as adapters below.
 */

const NEIGHBOUR_RADIUS_M = 805;   // half a mile
const TIMEOUT_MS = 15000;
const CACHE_SECONDS = 60 * 60 * 24 * 7;

const COUNTIES = {
  mohave: {
    name: "Mohave",
    url: "https://mcgis.mohave.gov/arcgis/rest/services/Mohave/MapServer/38/query",
    apnField: "PARCEL",
    addrField: "SITE_ADDRESS",
    fields: "PARCEL,SITE_ADDRESS,PARCEL_SIZE,IMPVALUE,LANDVALUE,PROPUSE,OWNER,LATITUDE,LONGITUDE",
    // Assessor publishes a point per parcel — no geometry maths needed.
    point: a => ({ lat: parseFloat(a.LATITUDE), lon: parseFloat(a.LONGITUDE) }),
    map: a => ({
      apn: a.PARCEL,
      address: (a.SITE_ADDRESS || "").trim() || null,
      owner: a.OWNER || null,
      acres: a.PARCEL_SIZE != null ? +a.PARCEL_SIZE : null,
      use: a.PROPUSE || null,
      zoning: null,
      landValue: a.LANDVALUE != null ? Math.round(+a.LANDVALUE) : null,
      improvementValue: a.IMPVALUE != null ? Math.round(+a.IMPVALUE) : null,
      improved: +a.IMPVALUE > 0
    }),
    // Development density from assessor improvement values.
    neighbours: {
      kind: "improved_parcels",
      url: "https://mcgis.mohave.gov/arcgis/rest/services/Mohave/MapServer/38/query",
      fields: "PARCEL,IMPVALUE",
      count: rows => ({
        total: rows.length,
        hits: rows.filter(r => +r.IMPVALUE > 0).length,
        label: "parcels within half a mile have improvements"
      })
    }
  },

  yavapai: {
    name: "Yavapai",
    url: "https://gis.yavapaiaz.gov/arcgis/rest/services/Parcels/MapServer/0/query",
    apnField: "PARLABEL",
    apnAltField: "PARNUMASR",
    addrField: "SITUS_ADD_DOR",
    fields: "PARLABEL,PARNUMASR,SITUS_ADD_DOR,ACRE_DEED,ZONING,NAME,SUBNAME",
    // No coordinate columns — derive a point from the polygon's bounding box.
    needsGeometry: true,
    map: a => ({
      apn: a.PARLABEL || a.PARNUMASR,
      address: (a.SITUS_ADD_DOR || "").trim() || null,
      owner: a.NAME || null,
      acres: a.ACRE_DEED != null && +a.ACRE_DEED > 0 ? +a.ACRE_DEED : null,
      use: a.SUBNAME || null,
      zoning: a.ZONING || null,
      landValue: null,
      improvementValue: null,
      improved: null           // unknown from this layer
    }),
    // Yavapai publishes building footprints — a more direct development signal
    // than assessed value.
    neighbours: {
      kind: "buildings",
      url: "https://gis.yavapaiaz.gov/ArcGIS/rest/services/Property/MapServer/5/query",
      fields: "OBJECTID",
      count: rows => ({
        total: null,
        hits: rows.length,
        label: "buildings mapped within half a mile"
      })
    }
  }
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": status === 200 ? `public, max-age=${CACHE_SECONDS}` : "no-store"
    }
  });

async function esri(base, params) {
  const u = new URL(base);
  Object.entries({ f: "json", returnGeometry: "false", ...params })
    .forEach(([k, v]) => u.searchParams.set(k, v));
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(u.toString(), { signal: ctl.signal });
    if (!r.ok) throw new Error("GIS returned " + r.status);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || "GIS query failed");
    return j.features || [];
  } finally { clearTimeout(t); }
}

// Bounding-box centre of an esri polygon. Good enough to seed a radius search.
function bboxCentre(geom) {
  if (!geom || !geom.rings || !geom.rings.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of geom.rings) for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (!isFinite(minX)) return null;
  return { lon: (minX + maxX) / 2, lat: (minY + maxY) / 2 };
}

function normaliseApn(raw) {
  const s = String(raw || "").trim().toUpperCase();
  const bare = s.replace(/[^0-9A-Z]/g, "");
  if (/^\d{8}[A-Z]?$/.test(bare)) {
    return bare.slice(0, 3) + "-" + bare.slice(3, 5) + "-" + bare.slice(5);
  }
  return s;
}
const bareApn = raw => String(raw || "").toUpperCase().replace(/[^0-9A-Z]/g, "");

async function fetchParcel(cfg, where) {
  const params = { where, outFields: cfg.fields, resultRecordCount: 12 };
  if (cfg.needsGeometry) { params.returnGeometry = "true"; params.outSR = "4326"; }
  return esri(cfg.url, params);
}

function pointOf(cfg, feat) {
  if (cfg.point) {
    const p = cfg.point(feat.attributes);
    return (isFinite(p.lat) && isFinite(p.lon)) ? p : null;
  }
  return bboxCentre(feat.geometry);
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const rawApn = url.searchParams.get("apn");
  const rawAddr = url.searchParams.get("address");
  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));
  const wantCounty = (url.searchParams.get("county") || "").toLowerCase();

  const hasPoint = isFinite(lat) && isFinite(lon);
  if (!rawApn && !rawAddr && !hasPoint) {
    return json({ ok: false, error: "Provide apn, address, or lat and lon." }, 400);
  }

  // Which counties to try. With a point we can search all of them.
  let keys;
  if (wantCounty && COUNTIES[wantCounty]) keys = [wantCounty];
  else if (hasPoint) keys = Object.keys(COUNTIES);
  else keys = Object.keys(COUNTIES);

  const errors = [];

  for (const key of keys) {
    const cfg = COUNTIES[key];
    try {
      let feat = null;

      if (hasPoint) {
        const params = {
          geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", inSR: "4326",
          spatialRel: "esriSpatialRelIntersects", outFields: cfg.fields, resultRecordCount: 1
        };
        if (cfg.needsGeometry) { params.returnGeometry = "true"; params.outSR = "4326"; }
        feat = (await esri(cfg.url, params))[0] || null;

      } else if (rawAddr) {
        const term = String(rawAddr).trim().toUpperCase().replace(/'/g, "''");
        const rows = await fetchParcel(cfg, `UPPER(${cfg.addrField}) LIKE '%${term}%'`);
        const withAddr = rows.filter(r => (r.attributes[cfg.addrField] || "").trim());
        if (withAddr.length > 1) {
          return json({
            ok: true, multiple: true, county: cfg.name,
            matches: withAddr.slice(0, 12).map(r => {
              const m = cfg.map(r.attributes);
              return { apn: m.apn, address: m.address, acres: m.acres, improved: m.improved };
            })
          });
        }
        feat = withAddr[0] || null;

      } else {
        const apn = normaliseApn(rawApn);
        const esc = apn.replace(/'/g, "''");
        let rows = await fetchParcel(cfg, `${cfg.apnField}='${esc}'`);
        if (!rows.length && cfg.apnAltField) {
          rows = await fetchParcel(cfg, `${cfg.apnAltField}='${bareApn(rawApn)}'`);
        }
        if (!rows.length) rows = await fetchParcel(cfg, `${cfg.apnField} LIKE '${esc}%'`);
        feat = rows[0] || null;
      }

      if (!feat) continue;

      const pt = pointOf(cfg, feat);
      const base = cfg.map(feat.attributes);

      let neighbours = null;
      if (pt && cfg.neighbours) {
        try {
          const rows = await esri(cfg.neighbours.url, {
            geometry: `${pt.lon},${pt.lat}`, geometryType: "esriGeometryPoint", inSR: "4326",
            distance: String(NEIGHBOUR_RADIUS_M), units: "esriSRUnit_Meter",
            spatialRel: "esriSpatialRelIntersects",
            outFields: cfg.neighbours.fields, resultRecordCount: 500
          });
          const c = cfg.neighbours.count(rows.map(r => r.attributes));
          neighbours = {
            kind: cfg.neighbours.kind, radiusMiles: 0.5,
            total: c.total, hits: c.hits, label: c.label,
            share: c.total ? Math.round((c.hits / c.total) * 100) : null
          };
        } catch (_) { neighbours = null; }
      }

      return json({
        ok: true, county: cfg.name, ...base,
        lat: pt ? pt.lat : null, lon: pt ? pt.lon : null,
        neighbours,
        source: {
          dataset: `${cfg.name} County parcel data`,
          publisher: `${cfg.name} County Assessor / GIS`,
          service: cfg.url.replace(/\/query$/, "")
        }
      });
    } catch (e) {
      errors.push(`${cfg.name}: ${e.message || e}`);
    }
  }

  return json({
    ok: false, notFound: true,
    error: rawAddr
      ? `No parcel with a matching address in ${keys.map(k => COUNTIES[k].name).join(" or ")} County. ` +
        `Many rural parcels have no assessor address — try the parcel number.`
      : `No parcel found in ${keys.map(k => COUNTIES[k].name).join(" or ")} County. ` +
        `Check the number, or use coordinates.`,
    supported: Object.values(COUNTIES).map(c => c.name),
    detail: errors.length ? errors : undefined
  }, 404);
}
