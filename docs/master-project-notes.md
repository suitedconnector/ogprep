---
tags: [project, buildoffgrid, cost-to-livable, master]
updated: 2026-09-12
---

# Master Project Notes — Build Off Grid / Cost to Livable

**Live:** buildoffgrid.ogprep.com · Cloudflare Pages · repo `/Volumes/DevProjects/MVPs/CostToLivable`

**What it is:** a diligence layer for rural land water, built from public state records that
nobody else joins up. Parcel in → what water costs, whether you're allowed to have it, and who
would drill it.

**The discipline:** the app compiles, people decide. Surface the fact, name the question, leave
the conclusion. A wrong inference in a chat costs nothing; the same inference shown to 14,000
people costs trust and possibly someone's money.

---

## Built

### Arizona
- 174,782 filed well records → county medians (`data/az-well-stats-by-county.json`)
- Live radius lookup via ADWR **Wells55 registry** (`/api/wells`) — was GWSI, the
  voluntary monitoring network, which returned 19 wells where the registry returns 322
- **Depth finder** (`find.html`) — 163,719 wells binned into 8,588 cells of ~1.4 miles.
  Search by depth you can afford to drill. 2,336 cells median under 200 ft.
- Driller directory from Wells55 licence numbers joined to ADWR's licensed list
- **Parcel search in all 15 counties** via the AZGeo statewide layer, scoped to a county
  envelope so the spatial index narrows before the APN scan. Acreage measured from the
  parcel geometry. **Mohave** alone keeps its assessor adapter for zoning and valuation —
  Yavapai's GIS returns 403 to Cloudflare's egress, so it routes to the state layer.

### Utah
- Water rights near a point (`/api/waterrights`) — WRPOD, live/dead classification,
  monitoring bores excluded
- **Well depths read from filed logs** (`/api/utahwelldepths`) — Utah's map layer has no depth,
  so this reads `wlbrowse.asp` per well. Throttled to 3 concurrent, cached 6 months per well.
- Dry hole detection from driller comment fields
- **Parcel search for all 29 counties** — HB113 (2005) requires every county to publish to one
  statewide layer with an identical schema. One adapter covers the state.
- **Water right checker** (`/api/waterright`) — paste any right number from any marketplace,
  get status, priority vs regulation schedule, uses, acre-feet, owner of record
- Rights grid (`tools/build-utah-rights-grid.mjs`) — 283,291 live rights, 66,281 domestic,
  8,783 cells. **4,614 cells have live rights and zero domestic.**

### Cross-cutting
- SSURGO septic suitability at the point (`/api/soil`)
- Rainfall via Open-Meteo for catchment sizing
- Three-way water comparison — well / haul / catchment, upfront vs running total
- Leaflet maps on both pages, satellite default, ghosted basemap
- Light and dark themes, light default
- Nothing pre-selected — the page asks rather than assuming

---

## Next up

### 1. Soil, much deeper ⭐
We use one SSURGO interpretation out of dozens. Same free API, same point query. Adding these
turns "cost to livable" from a water tool into a buildability tool:

| Interpretation | Why it matters |
| -------------- | -------------- |
| **Depth to bedrock** | Excavation, foundation, trenching. Shallow rock turns a $5k driveway into $25k |
| **Dwellings with/without basements** | Direct rating of whether soil carries a house |
| **Local roads and streets** | Whether a driveway survives spring. Often the second-largest line |
| **Shallow excavations** | Trenching for water and power — never budgeted |
| **Shrink-swell** | Expansive clay cracks foundations. Common in AZ and UT, invisible until it isn't |
| **Flooding / ponding frequency** | Build site risk |
| **Hydric soils** | Possible wetland → federal permitting. A deal-ender absent from every listing |
| **Source of gravel / topsoil** | Build road base on site instead of trucking it |
| **Corrosion of steel / concrete** | Well casing life, buried tanks, footings |
| **Frost action** | Foundation depth, pipe burial depth |

Caveat stays: planning-scale interpretations, not a geotech report or a perc test.

### 2. Water quality — never discussed until now ⭐

The app answers *will you hit water* and *what will it cost*. It says nothing about
whether the water is drinkable. In Arizona that is a serious omission: **arsenic** is
widespread in rural groundwater, and a well that produces 20 gpm at 100 ft but needs a
treatment system is a different purchase from one that doesn't.

**The structural fact to carry into the UI:** domestic wells are not regulated. Roughly
300,000 Arizonans drink from wells that fall outside the Safe Drinking Water Act, so
nobody tests them systematically and **parcel-level quality data does not exist**. What
exists is ambient monitoring points — exactly the same shape as well depth, and the same
honest framing: here is what was measured near you, not a measurement of your parcel.

| Source | Covers | Notes |
| ------ | ------ | ----- |
| **Water Quality Portal** (`waterqualitydata.us`) | Both states, one adapter | USGS + EPA + 400 agencies. Documented web services, `well` and `spring` site types. Start here — it is the AZGeo of water chemistry. |
| **ADEQ Arizona Water Quality Database** | AZ | Groundwater and surface chemistry from ADEQ and 100+ reporting agencies. Ambient monitoring since 1995, 200+ constituents. |
| **ADWR GWSI** | AZ | Already queried for depth; also carries water-quality monitoring sites. May be free. |
| Utah DEQ Division of Drinking Water | UT | **Unverified.** Check whether ambient groundwater chemistry is published separately from public-system compliance. |

**What to surface, in priority order:** arsenic, nitrate, fluoride, uranium, TDS/salinity,
hardness. Arsenic first — it is the one that drives a treatment budget in Arizona.

**Do not state a parcel is safe or unsafe.** Report what was found nearby, the distance,
and the standard it is measured against. A water test costs about $150 and is the actual
answer; the app's job is to tell someone whether to expect that bill.

### 3. Hand off to Haulagua when a well is not the answer — PARKED

The note below already said this; Skull Valley was the first real instance. A 1,315 ft
domestic well 0.69 miles away, three records total, no trend data. That is not a well
decision, it is a hauling decision, and this app is the only thing that knows it.

Decided, so it does not get re-litigated:

- **Trigger is a written rule, not a judgment.** Fewer than N wells with a depth, or a
  median above X ft, or no legal path. It is our directory on the other end, so the
  threshold has to be stated in code and not decided case by case.
- **Disclose plainly.** "on **Haulagua**, our water hauling directory." Not "sister site" —
  that hints at a relationship without stating one, which is the version a reader resents
  discovering. "Our" is honest and costs nothing.
- **Deep-link to results, not a search box.** We own both ends, so define the URL contract:
  `haulagua.com/water-haulers/az/<county>`. The county is already in hand from the parcel
  lookup. Someone who has just been told there is no well here should not be asked to
  re-enter where they are.
- **Arizona only for now.** Haulagua covers Texas and Arizona. Utah is where hauling matters
  *most* — closed basins, no right, no legal path — so this gets much stronger once Utah is
  listed there. A dead referral is worse than none.
- **Do not land them on the homepage.** Its front door is pool fills and construction. A
  rural buyer arriving from a $80,000 well problem should not see a backyard swimming pool.
- **Fallback when the county has no haulers listed yet** — state page, or an honest "none
  listed here yet, here is how to find one." An empty results page spends the credit twice.

Open question: does Haulagua actually have haulers listed in Yavapai and Mohave? Check
before wiring, not after.

### 4. Utah bulk well depth
Call **801-538-7240** (Technical Services) for access to the WELLDB export at
`waterrights.utah.gov/gisinfo/dbtables.asp`. Currently returns Access Denied. Unblocks a Utah
depth map and ends per-well scraping entirely. Draft in `docs/agency-data-requests.md`.

### 5. Multi-state expansion
Model travels; implementation doesn't. Three things vary:
- **Water law** — prior appropriation (West) vs riparian (East). Different product, not a config flag.
  Realistically the ~11 Western states, which is also where the cheap land is.
- **Exempt well rules** — AZ allows domestic wells without a right; UT doesn't. Every state sits
  somewhere on that spectrum.
- **Data quality — the real gate.** AZ took a day because ADWR publishes everything. UT depth is
  still blocked.

**Do a data-availability scan first**, then pick build order. Don't guess.

### 6. Demand-side capture
Let someone post "I need 1 af, domestic, Area 73." Nobody has that list, and it's what owners
who are holding would actually respond to.

### 7. Verify the ADWR discrepancy ⚠️
**CAUSE FOUND, 12 Sept 2026.** Not a conflict — two different datasets. The live radius lookup
read **GWSI**, which is the voluntary water-level monitoring network, while the driller panel and
county figures read **Wells55**, the drilling registry. At a test point near St Johns, GWSI
returned **19** wells and the registry returned **322** at the same radius.

`/api/wells` now reads the registry. Re-check the Wikieup figures after deploying — the 119 ft
number should move, and it feeds the Arizona demo card and the cost model.

---

## Known gaps

- **Utah cost model uses Arizona per-foot rates.** The 460 ft is Utah data; the dollar figure is
  an Arizona-costed guess. Get a real per-foot number from Grimshaw or Gardner Brothers.
- Utah has no yield data at all — not filed.
- Utah depth coverage starts 1991; older wells are indexed without numbers.
- Arizona APN search covers 2 of 15 counties.
- Obsidian MCP connector is broken — schema dialect its tools declare fails validation.

---

## Business model

Free data → paid introductions. The page that says "you cannot legally drill here" is the page
that should introduce a hauler; the page that says "460 ft median" should introduce a driller.

**Closed basins structurally protect hauling demand.** No right, no appropriation, no approval
needed — it's what's left when everything else is blocked. Makes **haulagua.com** more
interesting than it looked.

**Not a marketplace.** Utah rights are real property; brokering them needs a licence, and three
exchanges already hold seller relationships. Compete on *analysis* instead — none of them tell a
buyer whether a right survives regulation, sits in a movable policy area, or has forfeiture
exposure. That runs on data already assembled.

**Open question for Kevin:** is this a company, or an acquisition edge for the deals we're in?
Currently doing both.

---

## Contacts

| Who | Number |
| --- | ------ |
| ADWR Public Records — Ricardo Fuentes | 602-771-8619 |
| UT Water Rights — Southwestern Region (Iron) | 435-586-4231 |
| UT Technical Services (bulk WELLDB) | 801-538-7240 |
| UT Well Drilling — Jim Goddard | 801-538-7314 |
| Iron County Recorder | 435-477-8350 |

## Related

- [[utah-water-cedar-valley]] — Cedar Valley closed basin, Spring Creek lead, tax deed warning
- `docs/agency-data-requests.md` — drafted requests for bulk data access
