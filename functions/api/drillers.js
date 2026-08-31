/**
 * Cloudflare Pages Function — /api/drillers?lat=..&lon=..&radius=8047
 *                             /api/drillers?county=MOHAVE
 *
 * Which well drillers have actually worked in an area, built from the wells
 * they filed. Every Arizona well record carries the driller's licence number
 * (DLIC_NUM), so grouping by it produces a directory nobody has to maintain —
 * it is the drilling record itself, not a listings page.
 *
 * For each driller: wells on record nearby, their median and deepest, and the
 * span of years they have been filing. That answers the question a buyer
 * actually has — "who drills around here, and how deep do their wells go" —
 * and it is the supply side of any lead-gen model.
 *
 * NAMES is ADWR's licensed-driller list (retrieved 2026-08-30), keyed by the
 * same licence number the well registry records. ADWR publishes no email
 * addresses, so contact is by phone.
 */

const WELLS55 = "https://services1.arcgis.com/Ezk9fcjSUkeadg6u/arcgis/rest/services/Wells_55/FeatureServer/0/query";
const TIMEOUT_MS = 20000;
const CACHE_SECONDS = 60 * 60 * 24 * 30;
const SCHEMA = "v2";   // v2 — flattened name/city/phone, licensed flag

/** ADWR licensed well drillers, licence number → company. 168 active licences. */
const NAMES = {
  "4": { name: "ODOM'S,  INC.", city: "Buckeye, AZ", phone: "(623) 386-3618" },
  "7": { name: "LAYNE CHRISTENSEN COMPANY", city: "Chandler, AZ", phone: "(480) 416-0035" },
  "10": { name: "SHELTON'S WELL SERVICE", city: "Goodyear, AZ", phone: "(602) 757-5002" },
  "12": { name: "A TO Z DRILLING & PUMP SERVICE, LLC", city: "Taylor, AZ", phone: "(928) 358-0324" },
  "13": { name: "ALLEN PUMP COMPANY, INC.", city: "Thatcher, AZ", phone: "(928) 428-3273" },
  "14": { name: "ALLEN'S WELL SERVICE, LLC", city: "Elfrida, AZ", phone: "(520) 642-3775" },
  "25": { name: "B-J DRILLING COMPANY, INC.", city: "Huachuca City, AZ", phone: "(520) 623-1010" },
  "41": { name: "COPPERSTATE DRILLING & SUPPLY, INC.", city: "Snowflake, AZ", phone: "(928) 536-4447" },
  "70": { name: "INGLE WELL & PUMP, LLC", city: "Pearce, AZ", phone: "(520) 824-3574" },
  "73": { name: "JENSEN DRILLING COMPANY", city: "Eugene, OR", phone: "(541) 726-7435" },
  "77": { name: "JOHN HOOVER WELL SERVICE & REPAIR", city: "Casa Grande, AZ", phone: "(520) 518-0012" },
  "78": { name: "YELLOW JACKET DRILLING SERVICES, LLC", city: "Phoenix, AZ", phone: "(602) 453-3252" },
  "83": { name: "BOART LONGYEAR COMPANY", city: "Glendale, AZ", phone: "(623) 889-7523" },
  "91": { name: "MCGEE WELL DRILLING & PUMP SERVICE, LLC", city: "Chino Valley, AZ", phone: "(928) 636-4576" },
  "99": { name: "MYERS DRILLING COMPANY", city: "Vail, AZ", phone: "(520) 762-9438" },
  "133": { name: "TANNER WELL SERVICE, LLC", city: "Sierra Vista, AZ", phone: "(520) 378-1606" },
  "137": { name: "TITAN DRILLING, LLC", city: "Benson, AZ", phone: "(520) 603-1161" },
  "141": { name: "UNIVERSAL DRILLING, INC.", city: "Wickenburg, AZ", phone: "(928) 684-2886" },
  "151": { name: "YUMA PUMP & DRILLING COMPANY", city: "Yuma, AZ", phone: "(928) 341-1446" },
  "181": { name: "UNITED DRILLING, INC.", city: "Albuquerque, NM", phone: "(505) 232-7730" },
  "185": { name: "ZIM INDUSTRIES, INC. DBA BAKERSFIELD WELL & PUMP CO", city: "Fresno, CA", phone: "(559) 834-1551" },
  "191": { name: "GREGG DRILLING LLC", city: "Signal Hill, CA", phone: "(562) 427-6899" },
  "195": { name: "SIMMONS DRILLING, INC.", city: "Cottonwood, AZ", phone: "(928) 646-0371" },
  "197": { name: "BOTA COMPANY", city: "Florence, AZ", phone: "(520) 868-5289" },
  "200": { name: "SOUTHLAND WELL DRILLING", city: "Tonopah, AZ", phone: "(623) 386-3550" },
  "205": { name: "HARRIS EXPLORATION DRILLING & ASSOCIATES, INC.", city: "Fallon, NV", phone: "(760) 822-7886" },
  "215": { name: "WEBER WATER RESOURCES, LLC", city: "Mesa, AZ", phone: "(480) 961-1141" },
  "226": { name: "CASCADE DRILLING, LP", city: "Peoria, AZ", phone: "(623) 935-0124" },
  "230": { name: "GODBE DRILLING, LLC", city: "Montrose, CO", phone: "(970) 209-1164" },
  "238": { name: "U.S. GEOLOGICAL SURVEY - LAS VEGAS", city: "Las Vegas, NV", phone: "(720) 272-6676" },
  "239": { name: "DRILL-TECH, INC.", city: "Chino Valley, AZ", phone: "(928) 636-8006" },
  "244": { name: "SHUCK DRILLING COMPANY, LLC", city: "Yuma, AZ", phone: "(928) 726-5153" },
  "251": { name: "SALISBURY & ASSOCIATES, INC.", city: "Spokane, WA", phone: "(509) 935-0720" },
  "255": { name: "CLUFF DRILLING & PUMP, INC.", city: "Fredonia, AZ", phone: "(928) 640-7656" },
  "272": { name: "WEBER DRILLING, INC.", city: "Benson, AZ", phone: "(520) 720-4800" },
  "283": { name: "WAY'S DRILLING, INC.", city: "Morristown, AZ", phone: "(602) 397-3745" },
  "298": { name: "SALT RIVER PROJECT DBA S.R.P.", city: "Phoenix, AZ", phone: "(602) 809-0695" },
  "314": { name: "STEWART BROS DRILLING CO DBA SBQ2 LLC", city: "Milan, NM", phone: "(505) 287-2986" },
  "331": { name: "C.E.T., INC.", city: "Prescott, AZ", phone: "(928) 925-0533" },
  "341": { name: "VALLEY WELL DRILLING", city: "Topock, AZ", phone: "(928) 768-7111" },
  "350": { name: "K. D. HUEY COMPANY, LLC", city: "Capitan, NM", phone: "575-354-2246" },
  "360": { name: "ARIZONA BEEMAN DRILLING DBA MOREX INVESTMENTS LLC", city: "Gold Canyon, AZ", phone: "(480) 983-2542" },
  "363": { name: "TORRENT RESOURCES, INC.", city: "Phoenix, AZ", phone: "(602) 268-0785" },
  "367": { name: "U.S. BUREAU OF RECLAMATION - YUMA", city: "Yuma, AZ", phone: "(928) 503-3072" },
  "368": { name: "BALOW'S WINDMILL, PUMP SERVICE & WELL DRILLING, LLC", city: "Skull Valley, AZ", phone: "(928) 442-3240" },
  "374": { name: "Q MOUNTAIN DRILLING", city: "Bouse, AZ", phone: "(928) 851-2537" },
  "377": { name: "NAPCO DRILLING DBA NORTHERN ARIZONA PUMP, INC.", city: "Cornville, AZ", phone: "(928) 634-4978" },
  "394": { name: "KM DRILLING, INC.", city: "Camp Verde, AZ", phone: "(928) 567-3633" },
  "400": { name: "KAUFMAN CORP DBA BROWN DRILLING", city: "Kingman, AZ", phone: "(928) 757-1920" },
  "453": { name: "H. E. BEEMAN WELL DRILLING DBA WYATT DRILLING, INC.", city: "Show Low, AZ", phone: "(928) 537-1031" },
  "461": { name: "LEON ROSS DRILLING & PUMP SERVICE", city: "Roosevelt, UT", phone: "(435) 722-4469" },
  "480": { name: "WELLTON-MOHAWK IRRIGATION AND DRAINAGE DISTRICT", city: "Wellton, AZ", phone: "(928) 785-3351" },
  "497": { name: "DOUBLE F CONTRACTING, INC.", city: "Cochise, AZ", phone: "(520) 507-2481" },
  "498": { name: "GEOMECHANICS SOUTHWEST, INC.", city: "Tucson, AZ", phone: "(520) 889-7787" },
  "505": { name: "BARBIE  DRILLING, INC.", city: "Williams, AZ", phone: "(928) 699-1080" },
  "530": { name: "DEL RIO DRILLING & PUMP, INC.", city: "Chino Valley, AZ", phone: "(928) 636-4272" },
  "550": { name: "BRINER DRILLING, INC.", city: "Kingman, AZ", phone: "(928) 757-3434" },
  "562": { name: "K. P. VENTURES WELL DRILLING & PUMP CO., LLC", city: "Cottonwood, AZ", phone: "(928) 639-1709" },
  "572": { name: "BEEMAN PUMP COMPANY, INC.", city: "Apache Junction, AZ", phone: "(480) 983-1104" },
  "577": { name: "BEAVER DAM DRILLING & CONSTRUCTION, LLC", city: "Littlefield, AZ", phone: "(928) 347-5589" },
  "583": { name: "NIELSEN WELL DRILLING & SERVICE, LLC", city: "St. Johns, AZ", phone: "(928) 337-4553" },
  "587": { name: "NELSON DRILLING", city: "Tucson, AZ", phone: "(520) 682-8592" },
  "608": { name: "LORIMOR ENTERPRISES, INC. DBA RAINBOW DRILLING", city: "Glendale, AZ", phone: null },
  "619": { name: "ARIZONA PRESTON DRILLING, LLC", city: "Mesa, AZ", phone: "(480) 984-4747" },
  "621": { name: "AZCA DRILLING & PUMP, INC.", city: "Ehrenberg, AZ", phone: "(928) 923-9118" },
  "628": { name: "CRUX SUBSURFACE, INC.", city: "Spokane Valley, WA", phone: "(509) 892-9409" },
  "635": { name: "BERTRAM DRILLING, INC.", city: "Billings, MT", phone: "(406) 259-2532" },
  "641": { name: "DESERT ENGINE & PUMP, LLC", city: "Goodyear, AZ", phone: "(602) 757-5002" },
  "643": { name: "SKYTECH DRILLING", city: "Phoenix, AZ", phone: "(623) 580-4984" },
  "644": { name: "NICKLAUS ENGINEERING, INC.", city: "Yuma, AZ", phone: "(928) 344-8374" },
  "655": { name: "WESTERN DRILLING COMPANY, LLC", city: "Buckeye, AZ", phone: "(623) 327-1200" },
  "659": { name: "RUEN DRILLING, INC.", city: "Clark Fork, ID", phone: "(208) 266-1151" },
  "667": { name: "CATALINA WELL & PUMP, LLC", city: "Tucson, AZ", phone: "(520) 818-9053" },
  "670": { name: "DEWEY DRILLING & PUMP, INC.", city: "Dewey, AZ", phone: "(928) 632-7687" },
  "674": { name: "COLLUM DRILLING, INC.", city: "Wickenburg, AZ", phone: "(602) 677-6408" },
  "676": { name: "ELBROCK DRILLING, LLC", city: "Animas, NM", phone: "(575) 534-7820" },
  "689": { name: "R. DAVIS DRILLING, LLC", city: "Springerville, AZ", phone: "(928) 245-0230" },
  "701": { name: "SUNBELT DRILLING, LLC", city: "Apache Junction, AZ", phone: "(602) 376-1123" },
  "715": { name: "MOORHEAD DRILLING DBA MOORHEAD PUMP SERVICE", city: "Mc Neal, AZ", phone: "(520) 234-5983" },
  "725": { name: "ST. CLAIR DRILLING AND PUMP SERVICE", city: "Cochise, AZ", phone: "(520) 400-0738" },
  "731": { name: "SOUTHWEST REMEDIATION DBA DDC, LLC", city: "Scottsdale, AZ", phone: "(602) 549-0925" },
  "733": { name: "HYDER DRILLING, LLC", city: "Dateland, AZ", phone: "602-918-3651" },
  "741": { name: "WISDOM  DRILLING, LLC", city: "Young, AZ", phone: "(928) 978-0252" },
  "752": { name: "HOLE TECH TUCSON, INC.", city: "Tucson, AZ", phone: "(520) 975-5060" },
  "757": { name: "K.R. WELL DRILLING, LLC", city: "Bouse, AZ", phone: "(928) 851-2975" },
  "769": { name: "MAJOR DRILLING AMERICA, INC.", city: "Salt Lake City, UT", phone: "(801) 974-0645" },
  "771": { name: "EXCEL PUMP AND WELL SERVICE, LLC", city: "Globe, AZ", phone: "(928) 812-7520" },
  "776": { name: "CENTRAL ARIZONA PUMP, LLC", city: "Payson, AZ", phone: "(928) 476-5440" },
  "779": { name: "EMPIRE PUMP CORPORATION", city: "Phoenix, AZ", phone: "(602) 403-0007" },
  "780": { name: "WILLIS MANAGEMENT ENTERPRISES, INC DBA WILLIS DRLG & PUMP", city: "Snowflake, AZ", phone: "(928) 536-4414" },
  "784": { name: "ALTAR DRILLING, INC.", city: "Tucson, AZ", phone: "520-289-4741" },
  "792": { name: "TONATEC EXPLORATION,  LLC", city: "Mapleton, UT", phone: "801-310-1628" },
  "796": { name: "SHUMWAY EXPLORATION, LLC", city: "Cedar City, UT", phone: "(435) 590-1912" },
  "798": { name: "MIKE'S DRILLING, LLC", city: "Vail, AZ", phone: "(520) 490-0399" },
  "816": { name: "HYDRO RESOURCES - ROCKY MOUNTAIN, INC.", city: "Fort Lupton, CO", phone: "(970) 381-3788" },
  "817": { name: "CHAMPION CORROSION PRODUCTS, INC.", city: "Midland, TX", phone: "(432) 682-8343" },
  "822": { name: "ALPINE REMEDIATION, INC.", city: "Golden, CO", phone: "303-277-0857" },
  "823": { name: "NATIONAL EWP, INC.", city: "Elko, NV", phone: "(775) 753-7355" },
  "830": { name: "BEEMAN DRILLING SERVICES DBA T B DRLG SVCS", city: "Moab, UT", phone: "435-259-7281" },
  "836": { name: "MEINZER WELL SERVICE, LLC", city: "Eloy, AZ", phone: "(520) 705-9502" },
  "838": { name: "MOHAVE SERVICE LLC", city: "Colorado City, AZ", phone: null },
  "841": { name: "PATAGONIA TRADING COMPANY, LLC", city: "Sonoita, AZ", phone: "(520) 455-5099" },
  "842": { name: "ENERGY SERVICES, LLC", city: "Colorado City, AZ", phone: "435-619-4652" },
  "843": { name: "PALOMA IRRIGATION & DRAINAGE DISTRICT", city: "Gila Bend, AZ", phone: "602-819-0344" },
  "845": { name: "SOUTHLANDS ENGINEERING, LLC", city: "Tucson, AZ", phone: "(520) 940-0472" },
  "847": { name: "HYDRO-SOLUTIONS PUMP & WELL SERVICE", city: "Gilbert, AZ", phone: "480-277-7849" },
  "850": { name: "TIMBERLINE DRILLING, INC.", city: "Hayden, ID", phone: "(208) 818-0588" },
  "852": { name: "SMYTH INDUSTRIES, INC.", city: "Tucson, AZ", phone: "(520) 750-8719" },
  "854": { name: "ACS SERVICES, LLC", city: "Mesa, AZ", phone: "(480) 968-0190" },
  "855": { name: "RESILIENT DRILLING SERVICES, LLC", city: "Phoenix, AZ", phone: "(602) 218-8848" },
  "857": { name: "WILDCAT DRILLING, INC.", city: "Phoenix, AZ", phone: "(602) 689-0228" },
  "859": { name: "LAST DROP DRILLING & PUMP SERVICES, LLC", city: "Cedar City, UT", phone: "(435) 559-9357" },
  "860": { name: "PACIFIC COAST WELL DRILLING, INC.", city: "Paso Robles, CA", phone: "(805) 434-5543" },
  "863": { name: "LONGMIRE WELL SERVICE, INC.", city: "Willcox, AZ", phone: "(602) 531-3660" },
  "866": { name: "JNJ WELL SERVICE, LLC", city: "Chandler, AZ", phone: "(480) 603-7083" },
  "867": { name: "RELIANT WELL DRILLING & PUMP CORP., INC.", city: "Tucson, AZ", phone: "(520) 276-0913" },
  "868": { name: "W/W SERVICES, LLC", city: "Willcox, AZ", phone: "(928) 651-0147" },
  "869": { name: "PRIDE DRILLING, LLC", city: "Benson, AZ", phone: "(520) 250-0078" },
  "871": { name: "HOOVER DRILLING COMPANY, LLC", city: "Casa Grande, AZ", phone: "(520) 251-1449" },
  "872": { name: "SOUTH BOUND DRILLING, LLC", city: "Goodyear, AZ", phone: "(623) 693-4142" },
  "877": { name: "VERDAD GROUP, LLC", city: "Tucson, AZ", phone: "(520) 743-8553" },
  "880": { name: "MATCOR, INC.", city: "Commerce City, CO", phone: null },
  "883": { name: "SUPERIOR DRILLING LLC", city: "Litchfield Park, AZ", phone: "(602) 290-7332" },
  "884": { name: "WESTERN HYDRO ENGINEERING, LLC", city: "Cochise, AZ", phone: "(520) 826-1164" },
  "885": { name: "THE WELL GUYS, LLC", city: "Dewey, AZ", phone: "(480) 536-5828" },
  "888": { name: "PANTERRA ENERGY, LLC", city: "Fort Morgan, CO", phone: "(970) 420-1210" },
  "889": { name: "WELL INDUSTRIES, INC.", city: "Chico, CA", phone: "(530) 891-5545" },
  "890": { name: "GRANILLO CONSTRUCTION, INC.", city: "Florence, AZ", phone: "(520) 709-4180" },
  "891": { name: "CONE TEC, INC.", city: "Salt Lake City, UT", phone: "(801) 973-3801" },
  "892": { name: "STAR WATER TECHNOLOGIES, LLC", city: "Tucson, AZ", phone: "(520) 649-5213" },
  "893": { name: "DESERT MOUNTAIN DRILLING & PUMP SERVICE, LLC", city: "Vail, AZ", phone: "(928) 242-6329" },
  "895": { name: "D AND M WELL SERVICE, LLC", city: "Douglas, AZ", phone: "(520) 364-2261" },
  "898": { name: "HOLT SERVICES, INC.", city: "Milton, WA", phone: "(253) 604-4878" },
  "900": { name: "ALFORD DRILLING, LLC", city: "Elko, NV", phone: "(775) 299-5635" },
  "903": { name: "FUGRO USA LAND INC", city: "Houston, TX", phone: "(713) 346-4002" },
  "904": { name: "INTEGRITY DRILLING SERVICES", city: "Queen Creek, AZ", phone: "(928) 300-2093" },
  "909": { name: "AUTHENTIC DRILLING", city: "Kiowa, CO", phone: "(303) 351-3581" },
  "913": { name: "RCS DRILLING LLC", city: "Gilbert, AZ", phone: "480-540-2485" },
  "914": { name: "REI DRILLING", city: "Salt Lake City, UT", phone: "(801) 281-2880" },
  "915": { name: "TISCHLER INVESTMENTS LLC DBA: CET WELL DRILLING", city: "Chino Valley, AZ", phone: "(928) 420-6639" },
  "917": { name: "NEXTGEN WATER WELL SERVICE LLC", city: "Eagar, AZ", phone: "(432) 813-8704" },
  "918": { name: "ASSOCIATED ENVIRONMENTAL INDUSTRIES CORP", city: "Norman, OK", phone: "405-360-1480" },
  "919": { name: "TRIPLE L WELL AND PUMP SERVICE", city: "Huachuca City, AZ", phone: "(520) 456-9377" },
  "921": { name: "AMERICAN DRILLING CORPORATION", city: "Spokane Valley, WA", phone: "(509) 921-7836" },
  "922": { name: "JRGO, LLC DBA INTEGRITY ASSESSMENT GROUP LLC", city: "Clare, MI", phone: "(830) 279-1915" },
  "924": { name: "LAMB DRILLING LLC", city: "South Jordan, UT", phone: "801-834-9495" },
  "925": { name: "FALCON DRILLING INC", city: "Mound House, NV", phone: "(775) 246-0720" },
  "927": { name: "ELLINGSON DRAINAGE INC", city: "West Concord, MN", phone: "(507) 527-2294" },
  "929": { name: "CHAMBERS CHOICE DRILLING", city: "Twentynine Palms, CA", phone: "760-401-7232" },
  "931": { name: "MALCOLM DRILLING COMPANY", city: "San Francisco, CA", phone: "(415) 901-4421" },
  "932": { name: "CLUFF BROTHERS DRILLING", city: "Rodeo, NM", phone: "(435) 625-1126" },
  "933": { name: "PREMIER DRILLING", city: "Elko, NV", phone: "(208) 520-4451" },
  "936": { name: "AQUA 2000 WATER WELL & DRILLING SERVICES, LLC", city: "Yuma, AZ", phone: "(928) 246-9213" },
  "937": { name: "BIG SKY EXPLORATION", city: "Raleigh, NC", phone: "(602) 329-6330" },
  "938": { name: "TRUE NORTH DRILLING LLC", city: "San Tan Valley, AZ", phone: "(435) 572-5098" },
  "939": { name: "MERSINO DEWATERING LLC", city: "Auburn Hills, MI", phone: "(810) 730-1122" },
  "941": { name: "BRAYTON LEASING LLC", city: "Tonopah, AZ", phone: "(928) 851-5157" },
  "943": { name: "ENVIROTECH DRILLING LLC", city: "Winnemucca, NV", phone: "(775) 421-0481" },
  "944": { name: "RELIABLE WATER WELL SERVICES LLC", city: "San Luis, AZ", phone: "(928) 919-0173" },
  "945": { name: "ST JOHNS WELL DRILLING COMPANY LLP", city: "Florence, AZ", phone: "(520) 840-3274" },
  "946": { name: "CASNER DRILLING & PUMP LLC", city: "Rimrock, AZ", phone: "(928) 821-8161" },
  "947": { name: "PRISBREY DRILLING LLC", city: "St. George, UT", phone: "(435) 632-1340" },
  "949": { name: "WAYFINDER DRILLING LTD", city: "Reno, NV", phone: "(604) 629-9427" },
  "956": { name: "GILA PUMP LLC", city: "Young, AZ", phone: null },
  "960": { name: "BALOW'S BLACK ROCK DRILLING LLC", city: "Skull Valley, AZ", phone: null },
  "963": { name: "ALASKA MIDNIGHT SUN DRILLING, INC.", city: "Whitehorse, YT", phone: null },
  "972": { name: "XTREMEX MINING TECHNOLOGY INC", city: "Bellaire, TX", phone: null },
  "974": { name: "LSG DRILLING", city: "Redding, CA", phone: "530-646-5621" }
};

const json = (body, status = 200, cacheable = false) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": cacheable ? `public, max-age=${CACHE_SECONDS}` : "no-store"
    }
  });

async function esri(params) {
  const u = new URL(WELLS55);
  Object.entries({ f: "json", returnGeometry: "false", ...params })
    .forEach(([k, v]) => u.searchParams.set(k, v));
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(u.toString(), { signal: ctl.signal });
    if (!r.ok) throw new Error("ADWR returned " + r.status);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || "query failed");
    return (j.features || []).map(f => f.attributes);
  } finally { clearTimeout(t); }
}

const median = a => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : Math.round((s[i - 1] + s[i]) / 2);
};

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));
  const county = (url.searchParams.get("county") || "").toUpperCase().replace(/[^A-Z ]/g, "");
  const radius = Math.min(Math.max(parseInt(url.searchParams.get("radius") || "8047", 10) || 8047, 800), 40000);

  const byPoint = isFinite(lat) && isFinite(lon);
  if (!byPoint && !county) return json({ ok: false, error: "Provide lat and lon, or county." }, 400);

  const key = `https://drillers-cache/${SCHEMA}/${byPoint ? lat.toFixed(3) + "," + lon.toFixed(3) + "/" + radius : county}`;
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return json({ ...(await hit.json()), cached: true }, 200, true);

  // Pull the individual records rather than server-side grouping: we need the
  // depth distribution per driller, not just a count.
  const params = {
    where: "WELL_DEPTH > 20 AND WELL_DEPTH < 5000 AND DLIC_NUM IS NOT NULL",
    outFields: "DLIC_NUM,WELL_DEPTH,INSTALLED,COUNTY,PUMPRATE,TESTEDRATE",
    resultRecordCount: "2000"
  };
  if (byPoint) {
    Object.assign(params, {
      geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", inSR: "4326",
      distance: String(radius), units: "esriSRUnit_Meter",
      spatialRel: "esriSpatialRelIntersects"
    });
  } else {
    params.where += ` AND COUNTY='${county.replace(/'/g, "''")}'`;
  }

  let rows;
  try { rows = await esri(params); }
  catch (e) { return json({ ok: false, error: "ADWR well registry unavailable: " + (e.message || e) }, 502); }

  const groups = new Map();
  for (const r of rows) {
    const lic = String(r.DLIC_NUM || "").trim();
    if (!lic) continue;
    if (!groups.has(lic)) groups.set(lic, { licence: lic, depths: [], years: [], yields: [] });
    const g = groups.get(lic);
    const d = +r.WELL_DEPTH;
    if (d > 0) g.depths.push(d);
    const yr = r.INSTALLED ? new Date(r.INSTALLED).getUTCFullYear() : null;
    if (yr && yr > 1900 && yr < 2100) g.years.push(yr);
    const y = +r.TESTEDRATE || +r.PUMPRATE;
    if (y > 0) g.yields.push(y);
  }

  const drillers = [...groups.values()]
    // Licence "0" is a placeholder on old records, not a company.
    .filter(g => g.depths.length > 0 && g.licence !== "0")
    .map(g => {
      const rec = NAMES[g.licence] || null;
      return {
      licence: g.licence,
      // Flattened — the lookup holds a record, but callers want plain fields.
      // Phone is deliberately withheld from the public payload: enquiries go
      // through the quote form so the lead is captured and forwarded, rather
      // than the page acting as a free phone directory.
      name: rec ? rec.name : null,
      city: rec ? rec.city : null,
      // ADWR publishes only currently-active licences, so a miss usually means
      // the driller has retired rather than that the data is wrong.
      licensed: !!rec,
      wells: g.depths.length,
      medianDepth: median(g.depths),
      deepest: Math.max(...g.depths),
      shallowest: Math.min(...g.depths),
      medianYieldGpm: g.yields.length ? median(g.yields) : null,
      firstYear: g.years.length ? Math.min(...g.years) : null,
      lastYear: g.years.length ? Math.max(...g.years) : null
      };
    })
    // Currently-licensed companies first — those are the ones you can call.
    .sort((a, b) => (b.licensed - a.licensed) || (b.wells - a.wells));

  const payload = {
    ok: true,
    scope: byPoint ? { lat, lon, radiusMiles: +(radius / 1609.34).toFixed(1) } : { county },
    wellsConsidered: rows.length,
    drillerCount: drillers.length,
    licensedCount: drillers.filter(d => d.licensed).length,
    namesAvailable: Object.keys(NAMES).length > 0,
    drillers: drillers.slice(0, 40),
    caveats: [
      "Built from filed well registrations, so it shows who has drilled here — not who is currently accepting work.",
      "This is a partial extract of the ADWR registry; driller totals understate real activity.",
      drillers.some(d => !d.licensed)
        ? "Some licence numbers on older wells aren't on ADWR's current list — those drillers have most likely retired."
        : null,
      Object.keys(NAMES).length === 0
        ? "Company names are not yet loaded — ADWR publishes the licence-to-name list at app.azwater.gov/DrillersList."
        : null
    ].filter(Boolean),
    source: {
      dataset: "Wells55 well registry",
      publisher: "Arizona Department of Water Resources",
      service: WELLS55.replace(/\/query$/, "")
    },
    cached: false
  };

  const res = json(payload, 200, true);
  await cache.put(key, res.clone());
  return res;
}
