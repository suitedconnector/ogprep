---
tags: [project, buildoffgrid, cost-to-livable, master]
updated: 2026-09-07
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
- Live radius lookup via ADWR GWSI (`/api/wells`)
- **Depth finder** (`find.html`) — 163,719 wells binned into 8,588 cells of ~1.4 miles.
  Search by depth you can afford to drill. 2,336 cells median under 200 ft.
- Driller directory from Wells55 licence numbers joined to ADWR's licensed list
- APN lookup for **Mohave** and **Yavapai** only (each assessor runs its own GIS)

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

### 2. Utah bulk well depth
Call **801-538-7240** (Technical Services) for access to the WELLDB export at
`waterrights.utah.gov/gisinfo/dbtables.asp`. Currently returns Access Denied. Unblocks a Utah
depth map and ends per-well scraping entirely. Draft in `docs/agency-data-requests.md`.

### 3. Multi-state expansion
Model travels; implementation doesn't. Three things vary:
- **Water law** — prior appropriation (West) vs riparian (East). Different product, not a config flag.
  Realistically the ~11 Western states, which is also where the cheap land is.
- **Exempt well rules** — AZ allows domestic wells without a right; UT doesn't. Every state sits
  somewhere on that spectrum.
- **Data quality — the real gate.** AZ took a day because ADWR publishes everything. UT depth is
  still blocked.

**Do a data-availability scan first**, then pick build order. Don't guess.

### 4. Demand-side capture
Let someone post "I need 1 af, domestic, Area 73." Nobody has that list, and it's what owners
who are holding would actually respond to.

### 5. Verify the ADWR discrepancy ⚠️
At Wikieup the finder says wells average **119 ft**; the three drillers listed there filed wells
at **565, 700 and 935 ft**. GWSI monitoring sites vs the Wells55 drilling registry disagreeing
about the same ground. The 119 ft figure is on the Arizona demo card and feeds the cost model.
**Resolve before anyone relies on it.** Same shape as the county-median error caught earlier.

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
