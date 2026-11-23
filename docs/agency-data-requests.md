# Three emails to send

All short on purpose. Agencies get long rambling requests constantly; a specific
ask with named fields is far more likely to get actioned.

---

## 1. Utah Division of Water Rights — START WITH THE PHONE CALL

**Call:** Technical Services — **(801) 538-7240**

Utah already runs a public bulk-export utility for exactly this data:

> https://waterrights.utah.gov/gisinfo/dbtables.asp
> → Water Well Database (well logs): `pubdump.exe?DBNAME=WELLDB`

It currently returns **"Access Denied. Contact Utah Division of Water Rights —
Technical Services, 801-538-7240."** So the facility exists and is simply gated.
You are asking for access to something they already operate, not asking them to
build anything. That is a five-minute phone call, not a project.

**What to say:**

> "Hi — I'm trying to use the public database table download at
> waterrights.utah.gov/gisinfo/dbtables.asp, specifically the Water Well Database.
> It's returning Access Denied and pointing me to this number. I'm building a free
> tool that shows people the depth of wells near a parcel they're considering
> buying. What do I need to do to get access?"

**If they ask why:** you're currently reading well logs one page at a time from
`wlbrowse.asp`, which is slow for you and unnecessary load for them. A bulk table
solves both. That framing helps — you're offering to stop hitting their web app.

**Ask on the same call:**

1. Update frequency, and whether re-downloading periodically is acceptable
2. Any attribution wording they want displayed
3. Whether commercial use of the export is restricted

### Email version, if you'd rather write than call

**To:** Technical Services — address via https://waterrights.utah.gov/contact.asp
**Subject:** Access request — Water Well Database table download (pubdump / WELLDB)

To whom it may concern,

I'm trying to use the Division's database table download page at
waterrights.utah.gov/gisinfo/dbtables.asp — specifically the Water Well Database
(well logs). It returns "Access Denied" and directs users to Technical Services at
801-538-7240.

I run a small free tool that helps people evaluate rural land before buying it. For
Utah parcels it shows nearby water rights and, where available, the depths of wells
drilled close by. At the moment the only way I can get depth is to request individual
well log pages from wlbrowse.asp, which is slow for me and adds avoidable load to
your web application. A bulk table would eliminate that entirely.

Could you tell me what's required to get access to the WELLDB export? I'm also glad
to hear about any attribution or use conditions you'd like applied.

Thank you for the work that goes into keeping these records public.

Best regards,
Tal Freibergs
714.713.5129
tfrei320@gmail.com

---

### Fallback, only if the bulk export is refused

**To:** Jim Goddard, Well Drilling Program — (801) 538-7314

Ask instead that four fields be added to the `Utah_Well_Logs` feature service they
already publish on ArcGIS Online: total bore depth, finished well depth, finished
casing diameter, and most recent static water level. All four already exist in the
database behind the well log viewer, so this is an export question rather than new
data collection.

---

## 2. Arizona Department of Water Resources — licensing confirmation

**To:** Ricardo Fuentes, Public Records Coordinator — (602) 771-8619
**Find current email at:** https://www.azwater.gov (Public Records)

**Subject:** Confirming permitted use of the Wells55 registry export

Mr Fuentes,

I've downloaded the public Arizona well registry export (Wells55 / AZ Well Registry
2024, 241,708 records) and I'm using it to power a free tool that shows people the
depths of wells drilled near a parcel they're considering buying, along with what a
well would likely cost.

Before this gets any real traffic I'd like to confirm two things:

1. Is there any restriction on using this data in a commercial or ad-supported
   context? The tool is free to use, but it is a business.
2. Is there a preferred attribution wording the Department would like displayed?

I currently credit it as "Arizona Department of Water Resources — Wells55 registry"
with a link, and I'm glad to change that to whatever you prefer.

I also use the GWSI service for live radius queries. If that has different terms from
the bulk export, I'd appreciate knowing.

Thanks for your time.

Best regards,
Tal Freibergs
714.713.5129
tfrei320@gmail.com

---

## 3. Yavapai County GIS — allowlist request

**To:** Yavapai County GIS / IT
**Find current contact at:** https://gis.yavapaiaz.gov (GIS Division), or the
County IT department via https://www.yavapaiaz.gov

**Subject:** Request to allow server-side access to the public Districts feature service

### What's actually happening

`gis.yavapaiaz.gov/arcgis/rest/services/Districts/FeatureServer/15` answers a
browser normally, and returns **403** to a request originating from Cloudflare's
network. Tested with and without a `User-Agent` header — same result — so it is
the source IP that is refused, not the request shape. Almost certainly a blanket
WAF rule against datacentre address ranges rather than any decision about this
project.

Consequence today: Yavapai parcels resolve through the state AZGeo layer instead,
so location and mapped acreage still work, but **zoning, assessed value and
improved-vs-vacant are gone for the county.** Those come only from the Districts
service.

**Do not try to work around this.** Spoofing browser headers to defeat a block is
both dishonest and fragile. Ask, or do without.

### Email

To whom it may concern,

I run a small free tool that helps people evaluate rural land before buying it —
it shows nearby well depths, likely water cost, and soil suitability for septic,
all from public records.

For Yavapai parcels I read your public Districts feature service
(`/arcgis/rest/services/Districts/FeatureServer/15`) to show parcel size, zoning
and district assignments. Requests from a browser succeed; requests from my server
receive a 403. I've tested with and without a descriptive User-Agent and the result
is the same, so I believe the block is on the originating IP range rather than
anything about the request. My requests come from Cloudflare Workers.

The volume is very low — one query per parcel a user looks up, cached for thirty
days afterwards — and every request identifies itself as:

    BuildOffGrid/1.0 (+https://buildoffgrid.ogprep.com; parcel lookup; contact via site)

Would it be possible to allow that traffic? If there is a preferred route for
programmatic access, or an API key arrangement, I'm happy to use that instead.

I'm also glad to add whatever attribution wording the County would like displayed
alongside the data.

Thank you for keeping these records publicly available.

Best regards,
Tal Freibergs
714.713.5129
tfrei320@gmail.com

---

## Notes before you send

- **Verify the current email addresses** on both agency sites. Phone numbers and staff
  change; I'm giving you the numbers and the pages to check, not addresses I've confirmed.
- **The Utah one is the higher-value ask.** If they add those four fields, the scraping
  problem disappears entirely and the app gets much faster. Worth a follow-up call to
  Goddard if there's no reply in two weeks — well program staff are usually reachable
  by phone.
- **The ADWR one is defensive.** You're almost certainly fine — it's a public records
  export — but getting it in writing costs nothing and protects you later.
- **Don't mention the 503s.** You've already fixed the behaviour that caused them.
  Leading with "your server rejected me" invites a block rather than a conversation.
- **Yavapai is the odd one out** — it's the only request where the problem is a
  refusal rather than a gate, so it's the only one where naming the 403 is the point.
  Keep the tone as "I think this is incidental", because it almost certainly is.
- **Check Mohave before sending.** If `mcgis.mohave.gov` blocks the same way, send
  both letters together and treat it as one pattern rather than two incidents —
  and if that happens, Arizona has no assessor-detail tier at all until someone
  replies.
