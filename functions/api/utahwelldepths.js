/**
 * Cloudflare Pages Function — /api/utahwelldepths?lat=..&lon=..&radius=3000
 *
 * Actual well depths near a point in Utah.
 *
 * Utah's ArcGIS well-log layer carries only an index: WIN, owner, location and a
 * link. The numbers live one hop away, on a plain GET page:
 *
 *   https://waterrights.utah.gov/wellinfo/welldrilling/wlbrowse.asp?WIN=<win>
 *
 * That page renders four tables — Activity, Well Features, Water Level Records
 * and Water Quality Records — with total bore depth, finished well depth,
 * casing diameter, drilling method, the drilling company, and any measured
 * static water levels. So the shape of this endpoint is:
 *
 *   1. spatial query the ArcGIS layer for WINs near the point
 *   2. fetch wlbrowse for the nearest N in parallel
 *   3. parse, drop monitoring bores, report the median
 *
 * Monitoring bores matter here. Near Cedar City the nearest logs are 2-inch
 * environmental piezometers 15–40 ft deep. Including them would report a median
 * depth roughly a tenth of what a water well actually costs, so they are
 * classified out rather than averaged in.
 *
 * ?debug=<win> returns the raw HTML for one well so the parse can be checked
 * against real output rather than assumed. Placed before the coordinate check
 * so it stays reachable when everything else is failing.
 */

const LOGS = "https://services.arcgis.com/ZzrwjTRez6FJiOq4/arcgis/rest/services/Utah_Well_Logs/FeatureServer/0/query";
const WLBROWSE = "https://waterrights.utah.gov/wellinfo/welldrilling/wlbrowse.asp?WIN=";

const TIMEOUT_MS = 8000;
const MAX_WELLS = 14;               // subrequest budget, and enough for a median
const CACHE_SECONDS = 60 * 60 * 24 * 30;   // filed logs do not change
const SCHEMA = "v1";

const json = (b, s = 200, cacheable = false) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": cacheable ? `public, max-age=${CACHE_SECONDS}` : "no-store"
    }
  });

const median = a => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/* ---------- HTML parsing -------------------------------------------------
   Driven by header text, not cell position: find the table whose header row
   mentions the column we want, then read that column by index. Utah's markup
   is hand-written ASP and the column order has no guarantee of stability.     */

const stripTags = h => h.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ")
  .replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();

/* Each table on the page is laid out the same way:
     row 0  spacer
     row 1  a single cell naming the table  ("Activity", "Well Features", …)
     row 2  spacer
     row 3  the column headers
     row 4+ data, or one wide cell saying "No … records found"
   Keying off the banner is far safer than guessing by column text: "Drilling
   Method" and "Total Bore Depth" would otherwise make Well Features answer to
   a search for the water-level table's "method" and "depth" columns. */
function tables(html) {
  return (html.match(/<table[\s\S]*?<\/table>/gi) || []).map(t => {
    const rows = (t.match(/<tr[\s\S]*?<\/tr>/gi) || []).map(r =>
      (r.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(stripTags)
    ).filter(r => r.length);
    const bannerRow = rows.find(r => r.length === 1 && r[0]);
    return { banner: bannerRow ? bannerRow[0] : null, rows };
  }).filter(t => t.rows.length);
}

// Return { idx, rows } for the table with this banner. idx maps a lowercase
// header phrase to its column number; rows are the data rows only.
function section(all, bannerName) {
  const tbl = all.find(t => t.banner &&
    t.banner.toLowerCase().includes(bannerName.toLowerCase()));
  if (!tbl) return null;

  // The header row is the first row with several cells — anything narrower is
  // a spacer or the banner itself.
  const hi = tbl.rows.findIndex(r => r.length >= 3);
  if (hi < 0) return null;

  const head = tbl.rows[hi].map(c => c.toLowerCase().replace(/\s+/g, " ").trim());
  const idx = p => head.findIndex(c => c.includes(p));

  // "No water level records found" arrives as a single wide cell; drop anything
  // that does not have the full set of columns.
  const rows = tbl.rows.slice(hi + 1).filter(r => r.length >= head.length - 1 && r.length >= 3);
  return { idx, rows, head };
}

const cell = (row, i) => (i >= 0 && i < row.length) ? row[i] : null;

const num = v => {
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return isFinite(n) ? n : null;
};

function parseWell(html, win) {
  const all = tables(html);

  // A WIN can have several activity rows (drilled, then deepened, then a pump
  // change). Prefer the row whose WIN column matches; fall back to the first.
  const pick = s => s.rows.find(r => r.some(c => c.trim() === String(win))) || s.rows[0] || null;

  let boreDepth = null, wellDepth = null, casingDia = null, intake = null,
      method = null, geologic = false;
  const feat = section(all, "Well Features");
  if (feat) {
    const row = pick(feat);
    if (row) {
      boreDepth = num(cell(row, feat.idx("total bore")));
      wellDepth = num(cell(row, feat.idx("finished well")));
      casingDia = num(cell(row, feat.idx("finished casing")));
      intake    = num(cell(row, feat.idx("well intake")));
      method    = cell(row, feat.idx("drilling method")) || null;
      geologic  = /yes/i.test(cell(row, feat.idx("geologic")) || "");
    }
  }

  let driller = null, activity = null, drilled = null;
  const act = section(all, "Activity");
  if (act) {
    const row = pick(act);
    if (row) {
      driller  = (cell(row, act.idx("company")) || "").trim() || null;
      activity = (cell(row, act.idx("activity type")) || "").trim() || null;
      drilled  = (cell(row, act.idx("begin date")) || "").trim() || null;
    }
  }

  // Static water level: the shallowest reading marked static, else the median
  // of all readings. A pumping level is drawdown, not the water table.
  let waterLevel = null;
  const wl = section(all, "Water Level");
  if (wl) {
    const di = wl.idx("depth"), si = wl.idx("status");
    // Floor of 5 ft: a filed static level below that is a column misread, not a
    // water table. Seen in practice on pre-1994 records.
    const readings = wl.rows.map(r => ({
      depth: num(cell(r, di)),
      status: (cell(r, si) || "").toLowerCase()
    })).filter(x => x.depth != null && x.depth >= 5 && x.depth < 5000);
    const statics = readings.filter(x => x.status.includes("static")).map(x => x.depth);
    waterLevel = statics.length ? median(statics) : median(readings.map(x => x.depth));
  }

  return {
    wellIntakeDepth: intake,
    win,
    boreDepth: boreDepth && boreDepth > 0 ? boreDepth : null,
    wellDepth: wellDepth && wellDepth > 0 ? wellDepth : null,
    casingDiameterIn: casingDia && casingDia > 0 ? casingDia : null,
    staticWaterLevel: waterLevel,
    drillingMethod: method,
    driller,
    activity,
    drilled,
    geologicLog: geologic
  };
}

/* ---------- non-production classification ---------------------------------
   Not all of these are monitoring wells. Around Cedar City the nearby logs are
   a mix of 2-inch municipal piezometers and 150–200 ft closed-loop geothermal
   bores drilled by heat-pump contractors. Neither produces water, so both are
   excluded from the depth median — but calling a geothermal bore a "monitoring
   well" in the UI would be wrong, so the reason is carried through.

   The M-suffix pattern matches the one in /api/waterrights, so the two
   endpoints agree on what counts as a real well.                              */
const GEO_DRILLER = /geo\s*energy|geothermal|heat\s*pump|geo[- ]?exchange/i;

function classify(w, wrchex) {
  const mSuffix = /\d{6}M\d{2}$/.test(String(wrchex || ""));
  const narrow = w.casingDiameterIn != null && w.casingDiameterIn > 0 && w.casingDiameterIn <= 2.5;
  const geo = GEO_DRILLER.test(String(w.driller || "")) ||
              /heat exchange|closed loop/i.test(String(w.activity || ""));

  if (geo) return { nonProduction: true, kind: "geothermal" };
  if (narrow) return { nonProduction: true, kind: "monitoring" };
  if (mSuffix) return { nonProduction: true, kind: "non-production" };
  return { nonProduction: false, kind: "water supply" };
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);

  // Raw HTML for one well, so the parse can be verified against real output.
  const dbg = url.searchParams.get("debug");
  if (dbg) {
    try {
      const r = await fetch(WLBROWSE + encodeURIComponent(dbg));
      const html = await r.text();
      return json({
        ok: r.ok, debug: true, win: dbg, httpStatus: r.status,
        parsed: parseWell(html, dbg),
        sections: tables(html).map(t => {
          const hi = t.rows.findIndex(r => r.length >= 3);
          return {
            banner: t.banner,
            head: hi >= 0 ? t.rows[hi] : null,
            rows: hi >= 0 ? t.rows.slice(hi + 1) : t.rows
          };
        }),
        htmlLength: html.length
      });
    } catch (e) {
      return json({ ok: false, debug: true, error: String(e.message || e) });
    }
  }

  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));
  const radius = Math.min(Math.max(parseInt(url.searchParams.get("radius") || "3000", 10) || 3000, 200), 8047);

  if (!isFinite(lat) || !isFinite(lon)) return json({ ok: false, error: "lat and lon are required" }, 400);
  if (lat < 36.9 || lat > 42.1 || lon < -114.1 || lon > -108.9) {
    return json({ ok: false, outsideUtah: true, error: "That point is outside Utah." }, 400);
  }

  const key = `https://utdepth-cache/${SCHEMA}/${lat.toFixed(4)},${lon.toFixed(4)}/${radius}`;
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return json({ ...(await hit.json()), cached: true }, 200, true);

  // 1. WINs near the point.
  const q = new URL(LOGS);
  Object.entries({
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    distance: String(radius),
    units: "esriSRUnit_Meter",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "WIN,WRCHEX,Latitude,Longitude,Location,Owner,Log_Type",
    returnGeometry: "false",
    resultRecordCount: "200",
    f: "json"
  }).forEach(([k, v]) => q.searchParams.set(k, v));

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let rows;
  try {
    const r = await fetch(q.toString(), { signal: ctl.signal });
    if (!r.ok) throw new Error("well log service returned " + r.status);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || "query failed");
    rows = (j.features || []).map(f => f.attributes);
  } catch (e) {
    clearTimeout(t);
    return json({ ok: false, upstreamFailed: true,
      error: "Utah well log index unavailable: " + (e.message || e) });
  }
  clearTimeout(t);

  const R = 3958.7613, rad = d => d * Math.PI / 180;
  const miles = (la, lo) => {
    const dLat = rad(la - lat), dLon = rad(lo - lon);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat)) * Math.cos(rad(la)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  };

  const index = rows.map(a => ({
    win: a.WIN,
    wrchex: (a.WRCHEX || "").trim(),
    owner: (a.Owner || "").trim() || null,
    legal: (a.Location || "").trim() || null,
    logType: (a.Log_Type || "").trim() || null,
    miles: (isFinite(+a.Latitude) && isFinite(+a.Longitude))
      ? +miles(+a.Latitude, +a.Longitude).toFixed(2) : null
  })).filter(w => w.win != null)
    .sort((a, b) => (a.miles ?? 99) - (b.miles ?? 99));

  const indexedCount = index.length;
  const targets = index.slice(0, MAX_WELLS);

  // 2. Fetch the log pages in parallel. One failure must not sink the batch.
  const ctl2 = new AbortController();
  const t2 = setTimeout(() => ctl2.abort(), TIMEOUT_MS);
  const fetched = await Promise.all(targets.map(async w => {
    try {
      const r = await fetch(WLBROWSE + w.win, { signal: ctl2.signal });
      if (!r.ok) return { ...w, fetchFailed: true };
      return { ...w, ...parseWell(await r.text(), w.win) };
    } catch (_) {
      return { ...w, fetchFailed: true };
    }
  }));
  clearTimeout(t2);

  const parsed = fetched.filter(w => !w.fetchFailed);
  const classified = parsed.map(w => ({ ...w, ...classify(w, w.wrchex) }));

  const supply = classified.filter(w => !w.nonProduction);
  const depths = supply.map(w => w.wellDepth ?? w.boreDepth).filter(v => v != null && v > 20);
  const levels = supply.map(w => w.staticWaterLevel).filter(v => v != null && v > 0);

  const payload = {
    ok: true,
    scope: { lat, lon, radiusMiles: +(radius / 1609.34).toFixed(2) },
    indexedCount,
    inspected: parsed.length,
    nonProductionCount: classified.filter(w => w.nonProduction).length,
    geothermalCount: classified.filter(w => w.kind === "geothermal").length,
    monitoringCount: classified.filter(w => w.kind === "monitoring").length,
    supplyWellCount: supply.length,
    // Depth may be absent even when supply wells exist: Utah only computerised
    // well logs from 1991, so older wells are indexed without their numbers.
    supplyWellsMissingDepth: supply.filter(w => (w.wellDepth ?? w.boreDepth) == null).length,
    medianDepthFt: median(depths),
    minDepthFt: depths.length ? Math.min(...depths) : null,
    maxDepthFt: depths.length ? Math.max(...depths) : null,
    depthSampleSize: depths.length,
    medianStaticWaterLevelFt: median(levels),
    waterLevelSampleSize: levels.length,
    wells: classified.map(w => ({
      win: w.win, waterRight: w.wrchex || null, owner: w.owner, legal: w.legal,
      miles: w.miles, depthFt: w.wellDepth ?? w.boreDepth,
      boreDepthFt: w.boreDepth, casingDiameterIn: w.casingDiameterIn,
      staticWaterLevelFt: w.staticWaterLevel, drillingMethod: w.drillingMethod,
      driller: w.driller, activity: w.activity, drilled: w.drilled,
      geologicLog: w.geologicLog, kind: w.kind, nonProduction: w.nonProduction,
      link: WLBROWSE + w.win
    })),
    caveats: [
      "Depth is what the driller filed for nearby wells, not a prediction for your parcel — " +
      "depth to water can change sharply across a single section.",
      "Monitoring piezometers and closed-loop geothermal bores are excluded from the median. " +
      "They are drilled for heat or observation, not water, and would drag the figure far too low.",
      "Utah computerised well logs in 1991. Older wells appear in the index without depth, so a " +
      "small sample here means the records are thin, not that the wells are shallow.",
      "Only the " + MAX_WELLS + " nearest logs are read, so a wider area may contain deeper wells.",
      "A well log proves a well was drilled. It does not prove you may drill one — in Utah that " +
      "requires an approved water right."
    ],
    source: {
      dataset: "Well Drilling Database (well logs)",
      publisher: "Utah Division of Water Rights",
      service: "https://waterrights.utah.gov/wellinfo/welldrilling/wlbrowse.asp"
    },
    cached: false
  };

  const res = json(payload, 200, true);
  // Only cache a response that actually carries numbers — a null-depth answer
  // cached for 30 days would outlive several deploys.
  if (payload.medianDepthFt != null || payload.indexedCount === 0) {
    await cache.put(key, res.clone());
  }
  return res;
}
