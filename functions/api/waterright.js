/**
 * Cloudflare Pages Function — /api/waterright?wr=73-2832
 *
 * Check a single Utah water right by number.
 *
 * The marketplaces list rights; none of them tell a buyer whether the right is
 * any good. This does: whether it is live, which policy area it sits in, when
 * the regulation schedule shuts it off, whether it covers domestic use at all,
 * and how much water it actually carries.
 *
 * Deliberately built around a number the buyer pastes in rather than scraped
 * listings — it works with every exchange, breaks when none of them change
 * their markup, and stays clear of anyone's terms of service.
 */

/* Identify ourselves to the agencies we query. A Worker's fetch sends no
   User-Agent by default, and at least one Arizona county GIS answers an
   anonymous request with 403 — a failure that reads as "no data" rather than
   "you were refused". It also gives an administrator someone to contact if we
   are ever a nuisance. */
const UA = "BuildOffGrid/1.0 (+https://buildoffgrid.ogprep.com; contact via site)";
const WRPOD = "https://services.arcgis.com/ZzrwjTRez6FJiOq4/arcgis/rest/services/Utah_Points_of_Diversion/FeatureServer/0/query";
const TIMEOUT_MS = 8000;
const CACHE_SECONDS = 60 * 60 * 24;      // rebuilt nightly upstream
const SCHEMA = "v1";

const STATUS = { A:"Approved", P:"Perfected", T:"Terminated", U:"Unapproved" };
const USES = { D:"Domestic", I:"Irrigation", M:"Municipal", S:"Stock", P:"Power", X:"Mining" };
const LIVE = new Set(["A","P"]);

/* Cedar City Valley regulation schedule, from the groundwater management plan
   adopted 11 January 2021. Rights are shut off junior-first, so a priority
   date is a countdown rather than a footnote. Applies to Area 73 only —
   other basins have their own plans or none. */
const CEDAR_PHASES = [
  { through: 1957, target: 2035 },
  { through: 1954, target: 2050 },
  { through: 1951, target: 2060 },
  { through: 1935, target: 2070 },
  { through: 1934, target: 2080 }
];

// Division use standards, for translating acre-feet into something usable.
const AF_HOUSE = 0.45, AF_ANIMAL = 0.028, AF_IRR_ACRE = 4.0;
const GAL_PER_AF = 325851;

const json = (b, s = 200, cacheable = false) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": cacheable ? `public, max-age=${CACHE_SECONDS}` : "no-store"
    }
  });

const decodeUses = s =>
  String(s || "").toUpperCase().split("").map(c => USES[c]).filter(Boolean);

const priorityYear = p => {
  const y = parseInt(String(p || "").slice(0, 4), 10);
  return (y > 1800 && y < 2100) ? y : null;
};

function cedarPhase(year) {
  if (year == null) return null;
  for (const p of CEDAR_PHASES) if (year > p.through) return p.target;
  return null;   // senior to July 1934 — outlasts the published schedule
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const raw = (url.searchParams.get("wr") || "").trim();

  // Accept "73-2832", "73 2832", "a51074", "2673001M00" — people paste what
  // the listing showed them, not what the database expects.
  const wr = raw.toUpperCase().replace(/\s+/g, "").replace(/^WR/, "");
  if (!wr) return json({ ok: false, error: "Provide a water right number, e.g. 73-2832" }, 400);
  if (!/^[A-Z0-9-]{3,20}$/.test(wr)) {
    return json({ ok: false, error: "That doesn't look like a Utah water right number." }, 400);
  }

  const key = `https://wrlookup/${SCHEMA}/${wr}`;
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return json({ ...(await hit.json()), cached: true }, 200, true);

  const q = new URL(WRPOD);
  Object.entries({
    where: `WRNUM='${wr.replace(/'/g, "''")}'`,
    outFields: "WRNUM,TYPE,SUMMARY_ST,STATUS,TYPE_OF_RIGHT,PRIORITY,USES,CFS,ACFT,OWNER,LOCATION,SOURCE,WIN,WebLink",
    returnGeometry: "true", outSR: "4326", resultRecordCount: "50", f: "json"
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

  if (!feats.length) {
    return json({ ok: false, notFound: true, wr,
      error: `No water right numbered ${wr} in the Division's points-of-diversion layer. ` +
             `It may be a surface right filed before 1903, a groundwater right before 1935, ` +
             `or simply mistyped — check it directly on the Division's site.`,
      checkAt: `https://www.waterrights.utah.gov/search/?q=${encodeURIComponent(wr)}` }, 200);
  }

  // A right can have several points of diversion; they share status and
  // priority, so summarise from the first and list the locations.
  const a = feats[0].attributes;
  const st = String(a.SUMMARY_ST || "").toUpperCase();
  const year = priorityYear(a.PRIORITY);
  const uses = decodeUses(a.USES);
  const acft = a.ACFT != null && +a.ACFT > 0 ? +a.ACFT : null;
  const area = (wr.match(/^(\d+)-/) || [])[1] || null;
  const inCedar = area === "73";
  const phase = inCedar ? cedarPhase(year) : null;

  // What this volume would actually support, by the Division's own standards.
  const supports = acft == null ? null : {
    housesIndoorOnly: +(acft / AF_HOUSE).toFixed(1),
    // A house, two animals and an eighth-acre of garden — the Division's own
    // Cedar City Valley worked example, which comes to about 1.0 af.
    typicalHomesteads: +(acft / (AF_HOUSE + 2 * AF_ANIMAL + 0.125 * AF_IRR_ACRE)).toFixed(1),
    irrigatedAcres: +(acft / AF_IRR_ACRE).toFixed(2),
    gallonsPerYear: Math.round(acft * GAL_PER_AF)
  };

  const flags = [];
  if (!LIVE.has(st)) {
    flags.push({ level: "bad", text:
      `Status is ${STATUS[st] || a.STATUS || "not live"}. This right is not currently usable — ` +
      `do not pay for it without understanding why.` });
  }
  if (!uses.includes("Domestic")) {
    flags.push({ level: "bad", text:
      `Not approved for domestic use${uses.length ? " — it covers " + uses.join(", ").toLowerCase() : ""}. ` +
      `A right without domestic use cannot supply a house until the State Engineer approves a ` +
      `change in nature of use, and that approval is not guaranteed.` });
  }
  if (phase) {
    flags.push({ level: year > 1957 ? "bad" : "warn", text:
      `Priority ${year} is junior in Cedar City Valley. Under the 2021 groundwater management plan ` +
      `this right is scheduled to be regulated off in ${phase}.` });
  } else if (inCedar && year) {
    flags.push({ level: "good", text:
      `Priority ${year} is senior to the entire published regulation schedule in Cedar City Valley — ` +
      `it outlasts every phase through 2080.` });
  }
  if (/abandon/i.test(String(a.TYPE || "")) || /abandon/i.test(String(a.SOURCE || ""))) {
    flags.push({ level: "warn", text:
      `The point of diversion is an abandoned well. The right can still be valid, but seven years ` +
      `of non-use makes a right subject to forfeiture — ask when water was last beneficially used, ` +
      `and whether a non-use application is on file.` });
  }
  if (acft == null) {
    flags.push({ level: "warn", text:
      `No acre-foot quantity in the record, so the volume cannot be checked here. Ask the seller ` +
      `what the sole-supply quantity is — a right shared across a use group may deliver far less ` +
      `than its face amount.` });
  }

  const payload = {
    ok: true,
    wr: a.WRNUM,
    policyArea: area,
    inCriticalManagementArea: inCedar,
    live: LIVE.has(st),
    status: STATUS[st] || null,
    detailStatus: a.STATUS || null,
    type: a.TYPE || null,
    source: a.SOURCE || null,
    rightType: a.TYPE_OF_RIGHT || null,
    priorityYear: year,
    priorityRaw: a.PRIORITY || null,
    regulatedFrom: phase,
    uses,
    coversDomestic: uses.includes("Domestic"),
    acreFeet: acft,
    cfs: a.CFS != null && +a.CFS > 0 ? +a.CFS : null,
    supports,
    owner: a.OWNER || null,
    wellId: a.WIN != null ? String(a.WIN) : null,
    wellLog: a.WIN ? `https://waterrights.utah.gov/wellinfo/welldrilling/wlbrowse.asp?WIN=${a.WIN}` : null,
    diversionPoints: feats.map(f => ({
      legal: f.attributes.LOCATION || null,
      lat: f.geometry ? f.geometry.y : null,
      lon: f.geometry ? f.geometry.x : null
    })),
    flags,
    officialRecord: a.WebLink || `https://www.waterrights.utah.gov/search/?q=${encodeURIComponent(wr)}`,
    caveats: [
      "Ownership shown here is the Division's record, which is an indication rather than title. " +
      "The county recorder is the office of record — if the seller is not shown as owner, title " +
      "work is needed before the right can pass to you.",
      "A right must be movable to your place of use. Buying outside your policy area, or a use " +
      "the State Engineer will not approve changing, buys you nothing.",
      "This reads the public record. It is not legal advice, and the Division itself recommends " +
      "professional help if you are unsure."
    ],
    source_dataset: {
      dataset: "Water Right Points of Diversion (WRPOD)",
      publisher: "Utah Division of Water Rights"
    },
    cached: false
  };

  const res = json(payload, 200, true);
  await cache.put(key, res.clone());
  return res;
}
