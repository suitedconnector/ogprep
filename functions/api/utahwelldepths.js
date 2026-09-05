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

function tables(html) {
  return (html.match(/<table[\s\S]*?<\/table>/gi) || []).map(t => {
    const rows = (t.match(/<tr[\s\S]*?<\/tr>/gi) || []).map(r =>
      (r.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(stripTags)
    ).filter(r => r.length);
    return rows;
  }).filter(r => r.length);
}

// Find a table containing a header row with all the given phrases, and return
// { rows, header, idx } where idx maps phrase -> column number.
function findTable(all, phrases) {
  for (const rows of all) {
    for (let i = 0; i < Math.min(rows.length, 3); i++) {
      const head = rows[i].map(c => c.toLowerCase().replace(/\s+/g, " "));
      const idx = {};
      const ok = phrases.every(p => {
        const j = head.findIndex(c => c.includes(p));
        if (j < 0) return false;
        idx[p] = j;
        return true;
      });
      if (ok) return { rows: rows.slice(i + 1), idx };
    }
  }
  return null;
}

const num = v => {
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return isFinite(n) ? n : null;
};

function parseWell(html, win) {
  const all = tables(html);

  const feat = findTable(all, ["total bore", "finished well"]);
  let boreDepth = null, wellDepth = null, casingDia = null, method = null, geologic = false;
  if (feat) {
    const row = feat.rows.find(r => r.join(" ").includes(String(win))) || feat.rows[0];
    if (row) {
      boreDepth = num(row[feat.idx["total bore"]]);
      wellDepth = num(row[feat.idx["finished well"]]);
      const di = findTable(all, ["total bore", "finished casing"]);
      if (di) casingDia = num(row[di.idx["finished casing"]]);
      const mi = findTable(all, ["drilling method"]);
      if (mi) method = row[mi.idx["drilling method"]] || null;
      geologic = /yes/i.test(row[row.length - 1] || "");
    }
  }

  const act = findTable(all, ["drilling", "activity"]);
  let driller = null, activity = null, drilled = null;
  if (act) {
    const row = act.rows.find(r => r.join(" ").includes(String(win))) || act.rows[0];
    if (row) {
      const flat = row.join(" | ");
      const d = flat.match(/(\d{2}\/\d{2}\/\d{4})/);
      drilled = d ? d[1] : null;
      // Company is the longest cell that isn't the WIN, a date or a short code.
      const cand = row.filter(c => c && !/^\d+$/.test(c) && !/^\d{2}\/\d{2}\/\d{4}$/.test(c));
      driller = cand.sort((a, b) => b.length - a.length)[0] || null;
      activity = cand.find(c => /^(new|repair|deepen|replace|clean|abandon)/i.test(c)) || null;
      if (driller && driller === activity) driller = null;
    }
  }

  const wl = findTable(all, ["depth", "method"]);
  let waterLevel = null;
  if (wl) {
    const depths = wl.rows
      .map(r => num(r[wl.idx["depth"]]))
      .filter(v => v != null && v > 0 && v < 3000);
    waterLevel = median(depths);
  }

  return {
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

/* ---------- monitoring-bore classification -------------------------------
   Two independent signals, either is enough. The WRNUM pattern matches the one
   already used by /api/waterrights so both endpoints agree on what counts.     */
const isMonitoring = (w, wrchex) =>
  /\d{6}M\d{2}$/.test(String(wrchex || "")) ||
  (w.casingDiameterIn != null && w.casingDiameterIn > 0 && w.casingDiameterIn <= 2.5);

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
        tableShapes: tables(html).map(t => t.slice(0, 2)),
        htmlLength: html.length,
        html: html.slice(0, 6000)
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
  const classified = parsed.map(w => ({ ...w, monitoring: isMonitoring(w, w.wrchex) }));

  const supply = classified.filter(w => !w.monitoring);
  const depths = supply.map(w => w.wellDepth ?? w.boreDepth).filter(v => v != null && v > 20);
  const levels = supply.map(w => w.staticWaterLevel).filter(v => v != null && v > 0);

  const payload = {
    ok: true,
    scope: { lat, lon, radiusMiles: +(radius / 1609.34).toFixed(2) },
    indexedCount,
    inspected: parsed.length,
    monitoringCount: classified.filter(w => w.monitoring).length,
    supplyWellCount: supply.length,
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
      geologicLog: w.geologicLog, monitoring: w.monitoring,
      link: WLBROWSE + w.win
    })),
    caveats: [
      "Depth is what the driller filed for nearby wells, not a prediction for your parcel — " +
      "depth to water can change sharply across a single section.",
      "Two-inch and smaller bores are treated as monitoring or environmental wells and excluded " +
      "from the median, because they are not drilled for water supply.",
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
