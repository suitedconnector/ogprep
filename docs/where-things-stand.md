---
tags: [project, buildoffgrid, cost-to-livable, status]
updated: 2026-09-14
---

# Where things stand

Written because the obstacles got hard to hold in your head. Plain language, no
schema talk. Read the first section and stop worrying about most of it.

---

## Working — verified 14 September, all twelve sources green

A health check now runs all of this in five seconds: `node tools/health-check.mjs`

| What | Evidence |
| ---- | -------- |
| Arizona well records | 322 wells returned near the Apache test point |
| Arizona parcel search, all 15 counties | Apache parcel resolves by number |
| Water service areas | Kingman Municipal Water returns |
| AMA boundaries (the legal gate) | Phoenix point correctly falls inside an AMA |
| Utah water rights | 3,397 points of diversion near Cedar Valley |
| Utah well logs | 1,522 logs nearby |
| Utah parcels, all 29 counties | Kevin's parcel resolves |
| **Mohave County assessor** | **Responds.** Arizona keeps zoning-tier data |
| Soil (septic suitability) | USDA responding |
| Rainfall (catchment sizing) | Open-Meteo returning daily series |

**Nothing in that list is broken.** If something feels wrong in the app, it is
far more likely to be how a number is labelled than where it came from.

---

## The one real data problem right now

**The driller panel is reading 5.5% of Arizona's wells.**

There are two copies of Arizona's well registry on the internet:

- **ADWR's own**, updated daily, ~174,782 wells. `/api/wells` reads this.
- **A frozen copy** somebody uploaded to ArcGIS Online years ago with no owner
  named and no update path. **9,679 wells.** `/api/drillers` reads this.

That is why the Skull Valley lookup showed *"Balow's Windmill — 1 well nearby,
one well at 375 ft, 1947–1947."* It is not a sparse area. The panel was
searching one twentieth of the filings, so nearly every driller shows one old
well.

Practical effect: **driller rankings are currently close to meaningless.** A
company with forty wells near a parcel and one with a single well look identical.

**The fix is one endpoint swap.** ADWR's registry carries the driller licence
number on every record, so the panel can read the same source the depths now
come from. Roughly an hour. This is the highest-value thing outstanding.

---

## Obstacles that are not bugs

**The site is behind Cloudflare Access.** Anyone who opens
`buildoffgrid.ogprep.com` hits an email sign-in wall. Fine while you are
building — but the landing page, the waitlist form and any link you post to
Facebook all depend on a stranger being able to open the page. This is a
settings change, not work, and everything from the marketing plan is blocked
behind it.

**Yavapai County blocks our server.** Their GIS returns 403 to Cloudflare's IP
addresses. Not your bug, not new, and probably a blanket firewall rule rather
than a decision about you. Already worked around: Yavapai parcels now come from
the state layer, so you get location and acreage but not zoning or assessed
value. A request letter is drafted in `docs/agency-data-requests.md`.

**There is no way to take money.** No checkout anywhere. Whatever the model
turns out to be, that is the missing piece — and it should stay missing until
somebody has told you what they would pay for.

---

## Fixed on 11–14 September

Worth reading, because several of these were wrong for months and the app now
says something different.

**The median was the mean.** `/api/wells` never returned a median depth, so the
page labelled the average as a median and compared it against the county's real
median. At the Graham test parcel this reported 127 ft where the true median was
96 — and inverted the verdict from *deeper than the county* to *shallower*.

**The well lookup was reading the wrong dataset.** Arizona keeps two: GWSI (a
voluntary water-level monitoring network, sparse by design) and Wells55 (the
drilling registry, everything ever filed). The live lookup read GWSI. At one
point that was **19 wells where the registry has 322**. Now fixed — and it
closed the Wikieup discrepancy that had been open in the notes for weeks. The
two figures were never contradicting each other; they were counting different
wells.

**One well could appear several times.** A deepening or a replacement gets its
own registration at the same spot. Those now collapse into one well, keeping
whichever filing carries the most detail.

**County fallback was wildly wrong in places.** When a radius query found too
few wells it dropped to the county median. At the shallowest cell in Arizona —
24 ft, in Navajo County, whose county median is 335 ft — that overstated the
well by fourteen times. It now falls back to a 1.4-mile grid cell first.

**Parcel search went from 2 counties to 15.** The statewide layer cannot be
searched by parcel number alone (it times out), but scoping to a county envelope
first makes it instant, including Maricopa's 1.5M parcels. This removed the need
for a five-hour crawl that was nearly built.

**Acreage is now measured from the parcel outline** and confirmed three ways —
your app, Regrid and Buildability all return 1.9 acres for the same Yavapai
parcel.

**A scary red panel was overruling the local wells.** The water-table trend
reads 2.8-mile cells and will accept one ring out, so it can describe ground
three miles away. At the Apache parcel it announced water at 218 ft in red while
the nineteen wells within two miles put it at 37. It now yields to the local
measurement and says so.

**Every endpoint now identifies itself.** None sent a User-Agent, and Yavapai's
403 was surfacing as "No parcel found — check the number," which reads as a bad
parcel number rather than a refusal.

**Demo cards corrected.** Wikieup now reads 113 wells, median 110 ft, water at
45 ft, 20 gpm — against a previous claim of 32 wells and an *average* of 119 ft.
The old numbers were close, which is reassuring; the evidence behind them was
thin.

**Yield exists.** The registry records what each well tested at. Nobody else in
this market has that, and it is not displayed anywhere yet.

---

## Still unknown

- **Never opened on a phone.** Not once.
- **Greenlee showed two different numbers on one page** — the banner reported a
  grid figure while the costs reported county figures. A diagnostic is in place
  and will print to the browser console next time it happens.
- **Whether anyone will pay, and for what.** No evidence either way.

---

## The next three, in order

1. **Turn off Cloudflare Access.** Ten minutes, unblocks every plan.
2. **Repoint the driller panel at ADWR's registry.** An hour, fixes the only
   real data problem left.
3. **Show yield in the results.** An hour, and it is a number no competitor has.

Then stop building. Find a post, leave a comment with real numbers in it, and
look up a parcel for whoever asks. Ten of those will teach you more than another
week of features.

---

## How to read anything I tell you about this project

Numbers pulled from a live query are reliable. Summaries of what the app *used
to do*, given hours later in a long session, are not — six were wrong on
13–14 September and you caught all six. If a claim about the app's history
matters, ask for it to be re-checked rather than taking it.
