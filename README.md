# Cost to Livable

A tool for rural land buyers. Land is priced per acre; you pay **cost to livable** — water, wastewater, power, access. In Arizona the gap between those two numbers is usually larger than the price of the land.

Single-file, no build step, no dependencies. Open `index.html` or drop it on any static host.

## What it does

1. Pick an Arizona county → shows well depth statistics from the ADWR Wells55 registry.
2. Paste coordinates → queries ADWR's Groundwater Site Inventory **live** for wells within ½–5 miles, and switches the cost model from county averages to those actual wells.
3. Enter a land price → returns estimated cost to livable, a low/likely/high range, and the multiple over the land price.
4. Lead capture → county, APN, email, plus the context of what they were looking at.

## Honest status

Only the **water** line is derived from location. Everything else is a published statewide range that does not move when you change county or coordinates.

| Line item | Status |
|---|---|
| Water (well) | Real — from wells near the coordinates, or county records |
| Water (hauling) | Statewide range |
| Septic | Statewide range. User picks conventional vs ATU — should be derived from soil |
| Power | Statewide range. Does not vary by location |
| Access & site | Statewide range. Placeholder |
| Land price | User input |

Every line is tagged in the UI (`parcel data` / `county data` / `typical range` / `you`) so this is visible rather than buried.

## Data sources

**Live query** — ADWR Groundwater Site Inventory, ArcGIS Online:
```
https://services.arcgis.com/C34zQ7veRS0V1t04/arcgis/rest/services/GWSI_Sites_2024/FeatureServer/0/query
```
Supports native point-radius search. Useful fields: `WELL_DEPTH`, `WL_DTW` (depth to water), `DD_LAT`/`DD_LONG`, `DRILL_DATE_TEXT`, `WATER_USE`, `REG_ID` (links to Wells55).

**County fallback** — `data/az-well-stats-by-county.json`, from the Wells55 registry. See the `_meta` block for caveats; it is a partial extract.

**Do not depend on** `gisweb3.azwater.gov` — ADWR's own ArcGIS server returned 522 timeouts consistently during development.

**Costs** — published 2026 Arizona figures: drilling $25–75/ft by formation, complete well systems $20,000–50,000 installed, conventional septic $7,500–15,000, alternative/ATU $20,000–40,000, cisterns $8,000–20,000 installed, hauled water $200–350 per 1,000 gallons.

## Open questions

**Licensing.** ADWR's data disclaimer retains "any intellectual property interest" and requests that recipients not redistribute. Facts generally aren't copyrightable and derived analysis is original work, but this needs an Arizona attorney before charging for reports. Ask ADWR directly — Public Records Coordinator, (602) 771-8619.

**Formspree free tier** is 50 submissions/month.

**CORS** — ADWR is called from the visitor's browser. If that ever breaks, proxy server-side.

## Next

1. **Soil → septic.** NRCS SSURGO is free and national; converts the biggest guess into a derivation. Highest-value fix.
2. **Access cost.** Driveway length from parcel to nearest maintained road (OSM/TIGER), plus slope from USGS 3DEP.
3. **Gates, not just costs.** Legal access, zoning, AMA status (already a Wells55 field), severed mineral rights. A parcel with no legal access isn't expensive — it's unusable, and no dollar figure captures that.
4. **APN → coordinates.** County assessor data. Currently the manual step behind the lead form.
5. Pull the complete ADWR registry rather than the partial extract.
