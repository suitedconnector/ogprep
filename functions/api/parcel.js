/**
 * Cloudflare Pages Function — /api/parcel?apn=306-32-007J
 *                             /api/parcel?lat=..&lon=..   (reverse: point → parcel)
 *
 * Looks up an Arizona parcel and returns its coordinates plus context:
 *   - the parcel itself (size, use, land and improvement value)
 *   - how many neighbouring parcels within a half mile are improved
 *
 * That neighbour count is the useful signal. On rural land with no municipal
 * sewer, an improved parcel means somebody obtained a septic permit and a water
 * source at that spot. It is observed evidence, not a modelled interpretation.
 *
 * Currently Mohave County only — each Arizona county runs its own GIS with its
 * own schema. Add counties to COUNTIES below as they are mapped.
 */

const COUNTIES = {
  mohave: {
    name: "Mohave",
    url: "https://mcgis.mohave.gov/arcgis/rest/services/Mohave/MapServer/38/query",
    apnField: "PARCEL",
    fields: "PARCEL,SITE_ADDRESS,PARCEL_SIZE,IMPVALUE,LANDVALUE,PROPUSE,OWNER,LATITUDE,LONGITUDE",
    // APNs look like 306-32-007J
    apnPattern: /^\d{3}-\d{2}-\d{3}[A-Z]?$/i
  }
};

const NEIGHBOUR_RADIUS_M = 805;   // half a mile
const TIMEOUT_MS = 15000;
const CACHE_SECONDS = 60 * 60 * 24 * 7;   // parcel data changes slowly

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": status === 200 ? `public, max-age=${CACHE_SECONDS}` : "no-store"
    }
  });

async function esriQuery(base, params) {
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
    return (j.features || []).map(f => f.attributes);
  } finally {
    clearTimeout(t);
  }
}

function normaliseApn(raw) {
  const s = String(raw || "").trim().toUpperCase();
  // Accept 30632007J or 306 32 007J and re-hyphenate.
  const bare = s.replace(/[^0-9A-Z]/g, "");
  if (/^\d{8}[A-Z]?$/.test(bare)) {
    return bare.slice(0, 3) + "-" + bare.slice(3, 5) + "-" + bare.slice(5);
  }
  return s;
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const rawApn = url.searchParams.get("apn");
  const rawAddr = url.searchParams.get("address");
  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));
  const countyKey = (url.searchParams.get("county") || "mohave").toLowerCase();

  const cfg = COUNTIES[countyKey];
  if (!cfg) {
    return json({
      ok: false,
      error: `Parcel lookup is not available for that county yet. Supported: ${Object.keys(COUNTIES).join(", ")}.`,
      supported: Object.keys(COUNTIES)
    }, 400);
  }

  if (!rawApn && !rawAddr && !(isFinite(lat) && isFinite(lon))) {
    return json({ ok: false, error: "Provide apn, address, or lat and lon." }, 400);
  }

  try {
    let parcel = null;

    if (rawAddr) {
      // Match on the assessor's site address. Rural parcels often have none,
      // so an empty result here is common and not an error worth alarming over.
      const term = String(rawAddr).trim().toUpperCase().replace(/'/g, "''");
      const rows = await esriQuery(cfg.url, {
        where: `UPPER(SITE_ADDRESS) LIKE '%${term}%'`,
        outFields: cfg.fields,
        resultRecordCount: 12
      });
      const withAddr = rows.filter(r => (r.SITE_ADDRESS || "").trim());
      if (!withAddr.length) {
        return json({
          ok: false, notFound: true,
          error: `No parcel in ${cfg.name} County with an address matching “${rawAddr}”. ` +
                 `Many rural parcels have no assessor address — try the parcel number instead.`
        }, 404);
      }
      if (withAddr.length > 1) {
        return json({
          ok: true, multiple: true, county: cfg.name,
          matches: withAddr.slice(0, 12).map(r => ({
            apn: r.PARCEL,
            address: (r.SITE_ADDRESS || "").trim(),
            acres: r.PARCEL_SIZE != null ? +r.PARCEL_SIZE : null,
            improved: +r.IMPVALUE > 0
          }))
        });
      }
      parcel = withAddr[0];
    } else if (rawApn) {
      const apn = normaliseApn(rawApn);
      let rows = await esriQuery(cfg.url, {
        where: `${cfg.apnField}='${apn.replace(/'/g, "''")}'`,
        outFields: cfg.fields,
        resultRecordCount: 5
      });
      // Fall back to a prefix match — people drop trailing letters.
      if (!rows.length) {
        rows = await esriQuery(cfg.url, {
          where: `${cfg.apnField} LIKE '${apn.replace(/'/g, "''")}%'`,
          outFields: cfg.fields,
          resultRecordCount: 5
        });
      }
      if (!rows.length) {
        return json({
          ok: false, notFound: true,
          error: `No parcel matching ${apn} in ${cfg.name} County. Check the APN, or use coordinates instead.`
        }, 404);
      }
      parcel = rows[0];
    } else {
      const rows = await esriQuery(cfg.url, {
        geometry: `${lon},${lat}`,
        geometryType: "esriGeometryPoint",
        inSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        outFields: cfg.fields,
        resultRecordCount: 1
      });
      if (!rows.length) {
        return json({ ok: false, notFound: true, error: "No parcel found at that point." }, 404);
      }
      parcel = rows[0];
    }

    const plat = parseFloat(parcel.LATITUDE);
    const plon = parseFloat(parcel.LONGITUDE);
    const hasPoint = isFinite(plat) && isFinite(plon);

    // Neighbour development density around the parcel centroid.
    let neighbours = null;
    if (hasPoint) {
      try {
        const near = await esriQuery(cfg.url, {
          geometry: `${plon},${plat}`,
          geometryType: "esriGeometryPoint",
          inSR: "4326",
          distance: String(NEIGHBOUR_RADIUS_M),
          units: "esriSRUnit_Meter",
          spatialRel: "esriSpatialRelIntersects",
          outFields: "PARCEL,IMPVALUE,PARCEL_SIZE",
          resultRecordCount: 400
        });
        const usable = near.filter(p => p.PARCEL !== parcel.PARCEL);
        const improved = usable.filter(p => +p.IMPVALUE > 0);
        neighbours = {
          radiusMiles: 0.5,
          total: usable.length,
          improved: improved.length,
          share: usable.length ? Math.round((improved.length / usable.length) * 100) : null
        };
      } catch (_) { neighbours = null; }
    }

    return json({
      ok: true,
      county: cfg.name,
      apn: parcel.PARCEL,
      address: parcel.SITE_ADDRESS || null,
      owner: parcel.OWNER || null,
      acres: parcel.PARCEL_SIZE != null ? +parcel.PARCEL_SIZE : null,
      use: parcel.PROPUSE || null,
      landValue: parcel.LANDVALUE != null ? Math.round(+parcel.LANDVALUE) : null,
      improvementValue: parcel.IMPVALUE != null ? Math.round(+parcel.IMPVALUE) : null,
      improved: +parcel.IMPVALUE > 0,
      lat: hasPoint ? plat : null,
      lon: hasPoint ? plon : null,
      neighbours,
      source: {
        dataset: `${cfg.name} County Tax Parcel data`,
        publisher: `${cfg.name} County Assessor / GIS`,
        service: cfg.url.replace(/\/query$/, "")
      }
    });
  } catch (e) {
    return json({ ok: false, error: "Parcel service unavailable: " + (e.message || e) }, 502);
  }
}
