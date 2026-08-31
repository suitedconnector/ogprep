# Finding the full Wells55 registry

We currently query a University of Arizona copy of Wells55 holding roughly
**8,900 wells with usable depths**. ADWR's real registry holds about
**200,600**. That gap is what makes the driller directory and the county
statistics thin.

GWSI (used for the map and radius search) is a different dataset and is fine —
it comes from ADWR's own ArcGIS Online org and covers ~42,000 field-verified
sites. Nothing below affects that.

Work through these in order and stop when one returns a large record count.

---

## 1. Wells55_Jan26 — most promising

Published January 2026 by a University of Arizona account. Never inspected.

Find its service URL:

```
https://www.arcgis.com/sharing/rest/search?q=Wells55_Jan26&f=pjson&num=10
```

Look for `"url"` in the result. Then open that URL with `/0/query` appended and
ask for a count only:

```
<SERVICE_URL>/0/query?where=1%3D1&returnCountOnly=true&f=pjson
```

**What you're looking for:** `count` well above 100,000.
If it returns ~9,000 it's the same extract we already have — move on.

---

## 2. ADWR Open Data portal

Their official publishing channel.

```
https://gisdata2016-11-18t150447874z-azwater.opendata.arcgis.com/
```

Search it for "Well Registry" or "Wells55". Open the dataset page and look for
a **View API Resources** or **I want to use this** panel — that exposes a
GeoService/FeatureServer URL. Run the same count query against it.

---

## 3. ADWR's own server

Was returning HTTP 522 all day on 30 Aug, but may recover.

```
https://gisweb3.azwater.gov/arcgis/rest/services?f=pjson
```

If that loads, look for a Wells folder, then the Wells55 layer, then count it.

---

## 4. Public records request — the guaranteed route

Ricardo Fuentes, Public Records Coordinator, (602) 771-8619.
Ask for the complete Wells55 registry as CSV or shapefile.

Worth combining with the licensing question already drafted, since it's the
same conversation and the same person.

---

## What to send back

Whichever route works, paste:

- the service URL
- the `count` it returned
- one sample record (`<SERVICE_URL>/0/query?where=1%3D1&outFields=*&resultRecordCount=1&f=pjson`)

The sample matters as much as the count — I need to confirm `DLIC_NUM`,
`WELL_DEPTH`, `COUNTY`, `INSTALLED` and the yield fields are present and
populated, since those drive the driller directory and the county pages.

---

## Then what

Once a fuller source is confirmed, three things improve at once:

1. **Driller directory** — real counts per company instead of one or two wells
2. **County statistics** — `data/az-well-stats-by-county.json` regenerated from
   the full registry rather than a 4% sample
3. **County pages** — enough data per county to be worth publishing

Nothing else needs to change: the query shape is identical, only the service
URL moves.
