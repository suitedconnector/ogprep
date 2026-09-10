/**
 * Cloudflare Pages Function — /api/waterrights?lat=..&lon=..&radius=805
 *
 * Utah water rights near a point, from the Division of Water Rights' Points of
 * Diversion layer (WRPOD) — rebuilt nightly from their operating database.
 *
 * Why this matters more in Utah than Arizona: Utah requires an approved water
 * right to drill. In a closed basin like Cedar Valley (Iron County) the State
 * Engineer isn't issuing new appropriations, so a parcel either has access to
 * an existing right or it doesn't. A point of diversion on or beside a parcel
 * is the strongest public signal that water is obtainable there.
 *
 * IMPORTANT: a diversion point near a parcel does NOT prove the right conveys
 * with that land. Water rights are separate property in Utah and can be sold
 * away from the ground they once served. This is a screening filter that
 * produces candidates for title work, not an answer.
 */

/* Identify ourselves to the agencies we query. A Worker's fetch sends no
   User-Agent by default, and at least one Arizona county GIS answers an
   anonymous request with 403 — a failure that reads as "no data" rather than
   "you were refused". It also gives an administrator someone to contact if we
   are ever a nuisance. */
const UA = "BuildOffGrid/1.0 (+https://buildoffgrid.ogprep.com; contact via site)";
const WRPOD = "https://services.arcgis.com/ZzrwjTRez6FJiOq4/arcgis/rest/services/Utah_Points_of_Diversion/FeatureServer/0/query";
// Short deliberately: if the upstream hangs, Cloudflare kills the Worker and
// serves its own 502 before our catch can return anything readable. Better to
// give up early and say what happened.
const TIMEOUT_MS = 8000;
const CACHE_SECONDS = 60 * 60 * 24 * 7;   // rebuilt nightly upstream
const SCHEMA = "v4";   // v4 — case-insensitive types, monitoring wells separated

// Codes from the WRPOD metadata, spelled out for the reader.
const STATUS = { A:"Approved", P:"Perfected", T:"Terminated", U:"Unapproved" };
const USES = { D:"Domestic", I:"Irrigation", M:"Municipal", S:"Stock", P:"Power", X:"Mining" };

// Which rights actually mean something for a buyer.
const LIVE = new Set(["A","P"]);
const DEAD_STATUS = new Set(["LAP","FORF","REJ","WD","TERM","DIS","INV","EXP"]);

const json = (b, s = 200, cacheable = false) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": cacheable ? `public, max-age=${CACHE_SECONDS}` : "no-store"
    }
  });

function decodeUses(s) {
  return String(s || "").toUpperCase().split("").map(c => USES[c]).filter(Boolean);
}

function priorityYear(p) {
  const s = String(p || "");
  const y = parseInt(s.slice(0, 4), 10);
  return (y > 1800 && y < 2100) ? y : null;
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));
  const radius = Math.min(Math.max(parseInt(url.searchParams.get("radius") || "805", 10) || 805, 100), 8047);

  // ?probe=1 checks the upstream service is reachable and reports its layer
  // metadata, without running a spatial query. Use it when the endpoint 502s.
  if (url.searchParams.get("probe")) {
    const ctl0 = new AbortController();
    const t0 = setTimeout(() => ctl0.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(WRPOD.replace(/\/query$/, "") + "?f=json", { signal: ctl0.signal, headers: { "User-Agent": UA } });
      const txt = await r.text();
      clearTimeout(t0);
      let parsed = null;
      try { parsed = JSON.parse(txt); } catch (_) {}
      return json({
        ok: r.ok && !!parsed && !parsed.error,
        probe: true,
        httpStatus: r.status,
        service: WRPOD.replace(/\/query$/, ""),
        layerName: parsed ? parsed.name : null,
        geometryType: parsed ? parsed.geometryType : null,
        fieldCount: parsed && parsed.fields ? parsed.fields.length : null,
        fields: parsed && parsed.fields ? parsed.fields.map(f => f.name) : null,
        upstreamError: parsed && parsed.error ? parsed.error : null,
        rawHead: parsed ? null : txt.slice(0, 300)
      });
    } catch (e) {
      clearTimeout(t0);
      return json({ ok: false, probe: true, service: WRPOD.replace(/\/query$/, ""),
        upstreamFailed: true,
        error: "Could not reach the service: " + (e.message || e) });
    }
  }


  if (!isFinite(lat) || !isFinite(lon)) return json({ ok: false, error: "lat and lon are required" }, 400);
  // Rough Utah envelope — this layer is Utah only.
  if (lat < 36.9 || lat > 42.1 || lon < -114.1 || lon > -108.9) {
    return json({ ok: false, outsideUtah: true,
      error: "That point is outside Utah. This layer covers Utah water rights only." }, 400);
  }

  const key = `https://wr-cache/${SCHEMA}/${lat.toFixed(4)},${lon.toFixed(4)}/${radius}`;
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return json({ ...(await hit.json()), cached: true }, 200, true);

  const q = new URL(WRPOD);
  Object.entries({
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    distance: String(radius),
    units: "esriSRUnit_Meter",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "WRNUM,TYPE,SUMMARY_ST,TYPE_OF_RIGHT,STATUS,PRIORITY,USES,CFS,ACFT,LOCATION,WIN,OWNER,SOURCE,WebLink",
    returnGeometry: "true",
    outSR: "4326",
    resultRecordCount: "200",
    f: "json"
  }).forEach(([k, v]) => q.searchParams.set(k, v));

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let feats;
  try {
    const r = await fetch(q.toString(), { signal: ctl.signal, headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error("WRPOD returned " + r.status);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || "query failed");
    feats = j.features || [];
  } catch (e) {
    clearTimeout(t);
    return json({ ok: false, upstreamFailed: true,
      error: "Utah water rights service unavailable: " + (e.message || e) });
  }
  clearTimeout(t);

  const R = 3958.7613, rad = d => d * Math.PI / 180;
  const miles = (la, lo) => {
    const dLat = rad(la - lat), dLon = rad(lo - lon);
    const a = Math.sin(dLat/2)**2 + Math.cos(rad(lat))*Math.cos(rad(la))*Math.sin(dLon/2)**2;
    return 2 * R * Math.asin(Math.sqrt(a));
  };

  const rights = feats.map(f => {
    const a = f.attributes, g = f.geometry || {};
    const st = String(a.SUMMARY_ST || "").toUpperCase();
    return {
      waterRight: a.WRNUM || null,
      type: a.TYPE || null,                       // UNDERGROUND, SPRING, SURFACE…
      status: STATUS[st] || a.STATUS || null,
      statusCode: st || null,
      detailStatus: a.STATUS || null,
      rightType: a.TYPE_OF_RIGHT || null,
      priorityYear: priorityYear(a.PRIORITY),
      uses: decodeUses(a.USES),
      cfs: a.CFS != null && +a.CFS > 0 ? +a.CFS : null,
      acreFeet: a.ACFT != null && +a.ACFT > 0 ? +a.ACFT : null,
      owner: a.OWNER || null,
      source: a.SOURCE || null,
      wellId: a.WIN != null ? String(a.WIN) : null,
      legal: a.LOCATION || null,
      link: a.WebLink || a.WEBLINK || null,
      miles: (isFinite(g.y) && isFinite(g.x)) ? +miles(g.y, g.x).toFixed(2) : null,
      // "Live" means approved or perfected and not lapsed/forfeited/rejected.
      live: LIVE.has(st) && !DEAD_STATUS.has(String(a.STATUS || "").toUpperCase()),
      // Environmental monitoring bores — commonly fuel-station remediation.
      // They carry a water right number but supply nothing, so they are counted
      // separately rather than inflating the useful totals.
      monitoring: /non-?production/i.test(String(a.SOURCE || "")) ||
                  /\d{2}\d{4}M\d{2}$/.test(String(a.WRNUM || ""))
    };
  }).sort((a, b) => (b.live - a.live) || ((a.miles ?? 99) - (b.miles ?? 99)));

  // TYPE and SOURCE come back title-case despite the metadata documenting them
  // in caps, so compare case-insensitively.
  const isType = (r, t) => String(r.type || "").toUpperCase().includes(t);

  const live = rights.filter(r => r.live && !r.monitoring);
  const domestic = live.filter(r => r.uses.includes("Domestic"));
  const wells = live.filter(r => isType(r, "UNDERGROUND"));
  const springs = live.filter(r => isType(r, "SPRING"));
  const surface = live.filter(r => isType(r, "SURFACE"));
  const monitoring = rights.filter(r => r.monitoring);

  const payload = {
    ok: true,
    scope: { lat, lon, radiusMiles: +(radius / 1609.34).toFixed(2) },
    found: rights.length,
    liveCount: live.length,
    domesticCount: domestic.length,
    undergroundCount: wells.length,
    springCount: springs.length,
    surfaceCount: surface.length,
    monitoringCount: monitoring.length,
    rights: live.slice(0, 40),
    monitoringWells: monitoring.slice(0, 10),
    caveats: [
      "A diversion point near a parcel does not prove the right conveys with that land — " +
      "Utah water rights are separate property and can be sold away from the ground.",
      "Surface diversions filed before 1903 and groundwater before 1935 may not appear at all.",
      "Point-to-point filings (usually stock watering) are shown as one point inside a wider area.",
      "Locations are computed from section-corner offsets and are not survey grade."
    ],
    source: {
      dataset: "Water Right Points of Diversion (WRPOD)",
      publisher: "Utah Division of Water Rights",
      note: "Rebuilt nightly from the Division's operating database.",
      service: WRPOD.replace(/\/query$/, "")
    },
    cached: false
  };

  const res = json(payload, 200, true);
  await cache.put(key, res.clone());
  return res;
}
