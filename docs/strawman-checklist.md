---
tags: [project, buildoffgrid, cost-to-livable, strategy]
updated: 2026-09-12
---

# Strawman checklist — does this app deserve to exist?

Written to be failed. Every question here is one a sceptical investor, or a competitor
with more money, would ask. Answer them with evidence, not with reasoning. Where the
honest answer is "I don't know", write that down rather than arguing.

---

## Test 0 — the one that matters most: can an LLM just do this?

**The claim under test:** the app's value is assembling public records nobody else joins
up. If a general-purpose model with web search can assemble them in thirty seconds, the
app is a nicer interface on a commodity, and the moat is presentation only.

### How to run it properly

Give the model the *same input the app takes* and ask for the *same outputs*. Do not
describe the app, do not hint at the sources, and do not help it when it flounders —
helping it is how you fool yourself.

**Prompt to use, verbatim:**

> I'm considering buying parcel 203-81-015 in Apache County, Arizona. Tell me:
> 1. The median depth of water wells drilled within 2 miles of it, and how many records
>    that is based on.
> 2. The median depth to water in those wells.
> 3. What drilling a well there would cost.
> 4. Whether I'm legally allowed to drill a domestic well on it without a water right.
> 5. Whether a community water system already covers that parcel, and who to call.
>
> Give me the figures and cite where each came from.

Run it on at least: one model with live web search, one without, and one "deep research"
mode. Then score each answer:

| Scored on | Pass looks like |
| --------- | --------------- |
| Located the parcel at all | Returns a real location for that APN, not a county centroid |
| Gave a depth figure | A number, not "it varies" or "contact a local driller" |
| Was the figure right | Within ~20% of the app's 100 ft, from the same 19 records |
| Showed its working | Names ADWR GWSI, not "sources suggest" |
| Time to answer | Compare honestly against ten seconds |
| Could a normal person do this | Would a land buyer have known to ask this way? |

### How to read the result — be honest about which of these it is

- **It gets everything right, fast.** The data moat is gone. What's left is workflow,
  trust and the driller introductions. That is a real but much smaller business, and you
  should know it now rather than in a year.
- **It gets the legal and service-area parts right but cannot produce a local depth
  figure.** This is the likely outcome, and it is the good one: the legal layer is
  published prose that models read well, and the depth figure requires querying a spatial
  API per parcel, which they cannot do. Your moat is the half that needs a query, not the
  half that needs reading.
- **It produces a confident number that is wrong.** The most dangerous outcome for buyers
  and the best one for you — but only if you can *demonstrate* the error. Screenshot it
  next to your records.

Re-run this every six months. Model browsing gets better; the date this test flips is the
date the business changes shape.

---

## 1. Is the problem real, and can you reach it?

- How many rural parcels change hands per year in AZ and UT? Is the market a few thousand
  transactions or a few hundred thousand?
- Do buyers know they have this question **before** they buy? If the realisation comes
  after closing, you cannot reach them at the moment of need, and nothing else matters.
- What do they actually do today? Not what they *should* do — what they do. Ask five.
- Is the pain expensive enough to act on? A $60,000 dry hole is; a $3,000 inconvenience
  is not.
- Where does someone stand when they need this? On a listing page, at a kitchen table, in
  a truck at the parcel? That location decides distribution.

## 2. Is the data defensible?

- Could a competitor buy what you assembled? Regrid sells parcels; ADWR publishes wells.
  What exactly cannot be bought?
- Is the barrier the *data* or the *joining*? Be precise. The joining is the asset —
  reading Utah's well logs one page at a time, dry-hole detection from comment fields,
  binning 163,719 wells into cells.
- What happens if ADWR ships a better API next year? Which parts of your work evaporate?
- How many external services does a single lookup depend on, and what is the annual
  probability one of them changes shape? (Yavapai already 403s. That is the pattern, not
  an exception.)
- Who else could build this in a weekend if they thought of it?

## 3. Is it better, or only different?

- Name the specific cases where the app gives a **different answer** than the
  alternatives — and where you can prove yours is right.
  *(Held today: GoOffGrid scores the $12,080 well parcel 86 and the $83,000 one 89.
  Golden Valley east 280 ft vs west 1,100 ft inside one place name.)*
- How often is the app more *accurate*, versus merely faster or prettier?
- Where is it worse? Name three. If you cannot, you have not looked.
- What is the false-confidence risk — the case where someone acts on your number and
  loses money? The county-median bug and the mean-labelled-as-median bug were both this.

## 4. Does it survive three years?

- Does the answer change often enough that anyone returns? Well depth barely moves.
  A one-time answer is a one-time customer.
- What is the maintenance load in hours per month, honestly measured?
- If you stopped working on it for six months, what breaks?
- Does it get better with use — more users, better data — or is it static?

## 5. Will anyone pay, and who?

- Has **one** person paid, or said in writing they would? Not "that's useful" — money.
- Is the payer the user? (Buyer pays for truth; seller pays for credibility; driller pays
  for leads. These are three different products.)
- What is the cheapest possible test of willingness to pay, and why has it not been run?
- If it stays free forever, what is it for — a business, or an acquisition edge for your
  own deals? Both is a valid answer, but only if said out loud.

## 6. The uncomfortable ones

- If this is such a good idea, why has nobody with money done it? Find the real reason,
  not a flattering one.
- What would have to be true for this to be a $1M/year business? Write the arithmetic.
  Users × price × retention. Does the number embarrass you?
- What is the strongest argument that you should stop? Make it properly, then answer it.
- What have you been avoiding? Payment plumbing and 39 unanswered intake responses have
  outlasted several rounds of feature work.
