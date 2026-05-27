# Paid test #01 — Instagram ads, real-time wedge

**Author:** Paid Performance Lead
**Status:** Draft for CEO review — parked pending Meta business review (~4 days)
**Date:** 2026-05-25
**Cost:** $75/wk × 1 week → $75 first read, extend if working
**Ad account:** `act_751195664328635` (confirmed existing, 2026-05-25)

## Hypothesis

The "real-time" wedge — *good vs. good-and-available* — earns the click from people who have lived the moment of needing a freelancer this week and not having a list. We test whether that copy converts in IG Feed + Stories when shown to marketing/design buyers in US metros.

If the hypothesis is right we see CTR > 0.8% (above IG B2B benchmark of ~0.6%) and link clicks land on `colophon.contact` at < $3 CPC. If the homepage holds attention we'll see /look wizard opens in the next iteration (requires pixel — see "open" below).

## Audience

**Geo:** US — top 10 metros (NYC, LA, SF Bay, Chicago, Boston, Austin, Seattle, Atlanta, DC, Miami). Skip rest-of-world for round 1; CPCs are higher abroad and the bench is US-leaning.

**Demo:** 28–55, all genders.

**Interests / behaviors (Meta detailed targeting):**
- Job titles: *Founder, Co-founder, Marketing Director, Head of Marketing, Brand Manager, Design Director, Creative Director, Head of Design, Producer, Product Marketing Manager*
- Industries: *Marketing & Advertising, Design, Internet, Computer Software*
- Interests: *Freelance work, Adobe Creative Cloud, Figma, Webflow, brand strategy*
- Behaviors: *Small business owners, Engaged shoppers (proxy for purchase intent)*

**Exclusions:** existing Page followers (no point paying to reach people who already know us). Add Stripe-buyer custom audience as exclusion once the pixel is wired.

## Creative

Two variants. Both lead to `colophon.contact?utm_source=instagram&utm_medium=paid&utm_campaign=real-time-wedge-01&utm_content={variant}`.

### Variant A — single image, tabbed-folder motif

**Visual:** the brand IG-tile chassis. Cream stock, black tab upper-right (`FILE / 05.26`), orange dot upper-left. Body line: *who's good. and who's good and available.*

Footer: `colophon · COLOPHON.CONTACT · FILED · MAY · 2026`

**Primary text (above the image):**

> there's a list of people who are good. and a list of people who are good and available.
>
> most directories give you the first one.
>
> → colophon.contact

**Headline (below image):** `the bench is the second list.`

**CTA button:** `Learn More`

### Variant B — 2-card carousel, IG-tile motif both cards

**Card 1:** tab `FILE / 05.26`, body line: *who's good.*
**Card 2:** tab `FILE / 05.26`, body line: *who's good and available.*

**Primary text:**

> two lists. most directories give you the first.
>
> we maintain the second.
>
> → colophon.contact

**CTA:** `Learn More`

Carousel forces the swipe — meta tends to reward two-card carousels with cheaper CPCs on B2B than single-image.

## Placements

IG Feed + IG Stories. Skip Reels (the visuals are static; Reels rewards video). Skip Audience Network entirely (cheap clicks, terrible quality).

## Budget + duration

- **$75 total** over 7 days = ~$10.71/day, split 50/50 between variants A and B.
- Campaign objective: **Traffic** (link clicks). NOT Conversions until the pixel is firing.
- Bid strategy: lowest cost (automatic). No bid cap for round 1.

## Metric + kill criterion

Primary: **cost per landing-page click** (LPC, Meta-reported).

| Outcome | What it means |
| --- | --- |
| LPC < $3 + CTR > 0.8% | Hypothesis confirmed. Scale to $150/wk, add a creative variant. |
| LPC $3–$5 + CTR 0.5–0.8% | Mixed. One variant likely better than the other; cut the loser, hold spend. |
| LPC > $5 or CTR < 0.4% after 3 days | Kill. Either copy doesn't translate to IG, or audience is wrong. Iterate. |
| Spend stalls (delivery problem) | Audience too narrow. Broaden interest list and re-launch. |

Secondary: **clicks → /look wizard opens** (proxy for buyer intent). Requires Meta pixel — see "open questions."

## Open questions (CEO action needed)

1. ~~**Meta Ads account.**~~ ✅ Confirmed: `act_751195664328635`.
2. **Meta Pixel.** Scaffolded in `index.html` (gated on `META_PIXEL_ID_PLACEHOLDER`). Needs a Pixel to be created in Meta Events Manager. Try this even while the business is under review — Pixel creation is often allowed.
3. **Ad account permissions.** Pikes MCP still 401s (their FB app is rejected). Launch path stays manual via Ads Manager.
4. **Approval to launch as-is.** Both variants are tone-compliant (no bench-size numbers, no named profiles). They use the same copy as the LinkedIn post that's queued for Tue. No tripwires triggered. Awaiting greenlight.
5. **Business review.** Meta has the business under review (≤4 days). Campaign creation likely gated until clear; account exists.

## Launch path (manual, since Meta MCP is unreachable)

1. CEO greenlights.
2. CEO (or Brand Steward if access) opens Meta Ads Manager → creates campaign per spec.
3. Brand Steward generates the V-A and V-B visuals (IG-tile motif) via the image-gen MCP and uploads to the ad set.
4. Set campaign live. Spend caps at $75 budget so no runaway.
5. Day 3 (Thu): Paid Performance checks delivery; reports to Chair.
6. Day 7 (Mon): Paid Performance writes the read; Chair brings it to weekly planning.

## Why this test, this week

The LinkedIn post for Tue 5/26 is the organic test of the same copy. Running paid in parallel means we learn:
- Does the copy work cold (paid, IG) vs. warm (organic, LI)?
- Does the IG audience respond to the same wedge as the LI audience?

Two channels, one wedge, one week — clean read.

---

## Status update — 2026-05-25 evening

Meta business account placed under automated review on creation. ETA up to 4 days. Test parked until review clears. Pixel scaffolding remains in working tree, unshipped (no-op until Pixel ID swapped in).

Plan revision: wait for review, use the gap to gather organic LinkedIn signal on the same `real-time wedge` copy. Shape paid creative accordingly when we unblock.
