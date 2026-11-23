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
    // The districts-by-parcel layer. Same parcel geometry as Parcels/MapServer/0
    // but pre-joined to fire, flood, sanitary and water district assignments —
    // the pass/fail factors a dollar figure can't express.
    url: "https://gis.yavapaiaz.gov/arcgis/rest/services/Districts/FeatureServer/15/query",
    apnField: "PARLABEL",
    apnAltField: "PARNUMASR",
    addrField: "SITUS_ADD_DOR",
    fields: "PARLABEL,PARNUMASR,SITUS_ADD_DOR,ACRE_DEED,ACRE_CALC,ZONING,NAME,SUBNAME," +
            "FIREDIST,SANDIST,WATRDIST,FLD_ZONE,In_Flood,UrbRur,INC_MUNI,PostalCommunity",
    // No coordinate columns — derive a point from the polygon's bounding box.
    needsGeometry: true,
    map: a => ({
      apn: a.PARLABEL || a.PARNUMASR,
      address: (a.SITUS_ADD_DOR || "").trim() || null,
      owner: a.NAME || null,
      acres: (a.ACRE_DEED != null && +a.ACRE_DEED > 0) ? +a.ACRE_DEED
           : (a.ACRE_CALC != null && +a.ACRE_CALC > 0) ? +a.ACRE_CALC : null,
      use: a.SUBNAME || null,
      zoning: a.ZONING || null,
      landValue: null,
      improvementValue: null,
      improved: null,          // unknown from this layer
      districts: {
        fire: clean(a.FIREDIST),
        sanitary: clean(a.SANDIST),
        water: clean(a.WATRDIST),
        floodZone: clean(a.FLD_ZONE),
        inFlood: a.In_Flood != null ? String(a.In_Flood) : null,
        setting: clean(a.UrbRur),
        municipality: clean(a.INC_MUNI),
        community: clean(a.PostalCommunity)
      }
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

/* ---------------------------------------------------------------------------
   Utah — all 29 counties from one pattern.

   Arizona needs a bespoke adapter per county because each assessor runs their
   own GIS with its own field names. Utah does not: a 2005 statute (HB113)
   requires UGRC to assemble a statewide parcel layer, so every county is
   published on one ArcGIS org with an identical schema. That turns 29 adapters
   into one loop.

   The trade-off is depth of attributes. The statute deliberately excludes the
   fields counties sell — no owner name, no assessed value — so this gives
   location, address, acreage and ownership class, and nothing more. That is
   still enough to do the only job the app needs an APN for: turn a parcel
   number into a point.

   Service names strip spaces: Box Elder -> Parcels_BoxElder.
--------------------------------------------------------------------------- */
const UT_ROOT = "https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/";

const UT_COUNTY_NAMES = ["Beaver","Box Elder","Cache","Carbon","Daggett","Davis","Duchesne",
  "Emery","Garfield","Grand","Iron","Juab","Kane","Millard","Morgan","Piute","Rich","Salt Lake",
  "San Juan","Sanpete","Sevier","Summit","Tooele","Uintah","Utah","Wasatch","Washington",
  "Wayne","Weber"];

// Shape__Area is web-mercator square metres, so it overstates area by roughly
// 1/cos²(latitude) — about 60% at Utah's latitudes. Correcting it beats
// publishing an acreage that is visibly wrong on a parcel someone owns.
function acresFromMercator(area, lat) {
  if (!(area > 0) || !isFinite(lat)) return null;
  const k = Math.cos(lat * Math.PI / 180);
  return +((area * k * k) / 4046.8564224).toFixed(2);
}

for (const name of UT_COUNTY_NAMES) {
  COUNTIES[name.toLowerCase()] = {
    name,
    state: "UT",
    url: UT_ROOT + "Parcels_" + name.replace(/\s+/g, "") + "/FeatureServer/0/query",
    apnField: "PARCEL_ID",
    apnAltField: "ACCOUNT_NUM",
    addrField: "PARCEL_ADD",
    fields: "PARCEL_ID,PARCEL_ADD,PARCEL_CITY,PARCEL_ZIP,OWN_TYPE,RECORDER," +
            "CoParcel_URL,ACCOUNT_NUM,ParcelYear,Shape__Area",
    needsGeometry: true,
    map: (a, feat) => {
      const c = feat && feat.centroid;
      return {
        apn: a.PARCEL_ID,
        address: [clean(a.PARCEL_ADD), clean(a.PARCEL_CITY), clean(a.PARCEL_ZIP)]
                   .filter(Boolean).join(", ") || null,
        // The statute excludes owner name — counties sell that.
        owner: null,
        acres: acresFromMercator(+a.Shape__Area, c ? +c.y : NaN),
        use: null,
        zoning: null,
        landValue: null,
        improvementValue: null,
        improved: null,
        ownershipType: clean(a.OWN_TYPE),      // Private / Federal / State / Tribal
        accountNumber: clean(a.ACCOUNT_NUM),
        parcelYear: clean(a.ParcelYear),
        recorderPhone: clean(a.RECORDER),
        countyParcelSite: clean(a.CoParcel_URL),
        note: "Utah's statewide layer carries boundary, address and ownership class only. " +
              "Owner name and assessed value stay with the county recorder."
      };
    }
  };
}

// Assessors use a variety of placeholders for "no value".
const clean = v => {
  const s = String(v == null ? "" : v).trim();
  if (!s || /^(none|n\/?a|null|unknown|0)$/i.test(s)) return null;
  return s;
};

/**
 * Only cache responses that are actually useful. A 200 carrying null
 * coordinates is a failed lookup wearing a success code — caching it for a week
 * means a deploy can't fix it, which is exactly the trap this hit once already.
 */
const json = (body, status = 200) => {
  const useful = status === 200 && (body.multiple || (body.ok && body.lat != null && body.lon != null));
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": useful ? `public, max-age=${CACHE_SECONDS}` : "no-store"
    }
  });
};

/* Identify ourselves. Yavapai's GIS returns 403 to a request with no
   User-Agent — a Worker's fetch sends none by default — which surfaced as
   "no parcel found in Yavapai County" for parcels that plainly exist. An
   anonymous request also gives an administrator no way to contact us if we
   are being a nuisance, which is reason enough on its own. */
const UA = "BuildOffGrid/1.0 (+https://buildoffgrid.ogprep.com; parcel lookup; contact via site)";

async function esri(base, params) {
  const u = new URL(base);
  Object.entries({ f: "json", returnGeometry: "false", ...params })
    .forEach(([k, v]) => u.searchParams.set(k, v));
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(u.toString(), {
      signal: ctl.signal,
      headers: { "User-Agent": UA, "Accept": "application/json" }
    });
    if (!r.ok) throw new Error("GIS returned " + r.status);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || "GIS query failed");
    return j.features || [];
  } finally { clearTimeout(t); }
}

/**
 * Centre point of any esri geometry. Counties publish parcels as polygons,
 * points or occasionally polylines — Yavapai's districts layer is points —
 * so handle all of them rather than assuming rings.
 */
function bboxCentre(geom) {
  if (!geom) return null;

  // Point geometry: already a coordinate.
  if (isFinite(geom.x) && isFinite(geom.y)) {
    return { lon: +geom.x, lat: +geom.y };
  }

  const vertexSets = geom.rings || geom.paths || (geom.points ? [geom.points] : null);
  if (!vertexSets || !vertexSets.length) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const set of vertexSets) for (const v of set) {
    const x = +v[0], y = +v[1];
    if (!isFinite(x) || !isFinite(y)) continue;
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
  // Utah's service computes a true centroid server-side. A bounding-box centre
  // can land outside an L-shaped or crescent parcel; a real centroid does not.
  if (cfg.state === "UT") { params.returnCentroid = "true"; params.outSR = "4326"; }
  return esri(cfg.url, params);
}

function pointOf(cfg, feat) {
  if (cfg.point) {
    const p = cfg.point(feat.attributes);
    return (isFinite(p.lat) && isFinite(p.lon)) ? p : null;
  }
  if (feat.centroid && isFinite(feat.centroid.x) && isFinite(feat.centroid.y)) {
    return { lon: +feat.centroid.x, lat: +feat.centroid.y };
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

  /**
   * County selection.
   *
   * Arizona APNs share a book-map-parcel shape across counties, so the same
   * number can exist in several of them. Searching every county for an APN
   * therefore returns whichever county answers first — confidently, and
   * possibly wrongly. If the caller names a county we honour it strictly:
   * either we have an adapter for it, or we say so.
   */
  let keys;
  if (wantCounty) {
    if (!COUNTIES[wantCounty]) {
      return json({
        ok: false,
        unsupportedCounty: true,
        requested: wantCounty,
        error: `Parcel lookup isn't available for that county yet — only ` +
               `${Object.values(COUNTIES).map(c => c.name).join(" and ")}. ` +
               `Use coordinates instead: well and soil data work anywhere in Arizona.`,
        supported: Object.values(COUNTIES).map(c => c.name)
      }, 400);
    }
    keys = [wantCounty];
  } else if (hasPoint) {
    // Geometry disambiguates, so trying every county is safe here.
    keys = Object.keys(COUNTIES);
  } else {
    keys = Object.keys(COUNTIES);
  }

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
              const m = cfg.map(r.attributes, r);
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
      const base = cfg.map(feat.attributes, feat);

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

      /* The boundary itself, when the county publishes polygons. Seeing your
         parcel outlined against the wells around it is worth more than any
         distance figure — and we already paid for this geometry to compute the
         centroid, then threw it away. Rings only; simplified to keep the
         payload sane on parcels with thousands of vertices. */
      const rings = feat.geometry && feat.geometry.rings
        ? feat.geometry.rings.map(r => {
            const step = Math.max(1, Math.ceil(r.length / 200));
            const out = r.filter((_, i) => i % step === 0).map(v => [+v[1], +v[0]]);  // [lat,lon]
            const first = r[0], last = out[out.length - 1];
            if (last[0] !== +first[1] || last[1] !== +first[0]) out.push([+first[1], +first[0]]);
            return out;
          })
        : null;

      return json({
        ok: true, county: cfg.name, ...base,
        lat: pt ? pt.lat : null, lon: pt ? pt.lon : null,
        boundary: rings,
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
