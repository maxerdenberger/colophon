# Colophon · Handoff

A new operator session should be able to read this top-to-bottom in 5 minutes and know exactly what's live, what we decided, and what's next.

---

## What it is

Paid-access directory of independent freelance creatives in advertising. Hiring managers (buyers) pay for a pass; creatives (the bench) are vouched-for, no agency markup. Site: **colophon.contact**. Repo: **github.com/maxerdenberger/colophon**. Deployed via Vercel (project `thisworks` under team `maxerdenbergers-projects`).

---

## Operator vocabulary

- **Buyer** = hiring manager / demand side. Anyone who would pay for bench access.
- **Creative / applicant** = supply side. Anyone on or applying to the bench.
- **The bench** = curated set of vouched-for creatives. Public-facing.
- **Activation gate** = the welcome-email referral form. New approvals must complete 3 peer refs + 1 buyer ref to surface publicly.

---

## Architecture (live)

```
SHEET (single source of truth)
  Form Responses 1 tab → bench rows (status: new|bench|rejected|paused, confirmed: yes/no)
  Referrals tab        → 3 + 1 referral log

APIs (/api/*.js, Vercel functions)
  /api/bench         GET — Sheet read, 15-second cache. Public-safe projection.
  /api/queue         GET — Formspree submissions cross-referenced against Sheet
  /api/action        POST — approve/reject/pause (email-deduped batchUpdate)
  /api/activate      POST — 3+1 ref submit, flips confirmed='yes', auto-invites peers
  /api/daily         GET — cron at 13:00 UTC. Pings 25 stalest rows, auto-pauses >90d
  /api/buyers        GET — Stripe customers, ranked by spend
  /api/contacts      GET — unified email roll-up (applicants/buyers/referrals/newsletter/concierge)
  /api/version       GET — deployed git SHA for the BuildStamp banner
  /api/send-approval-email POST — welcome email with activation CTA

FRONT (index.html, single SPA)
  /                  — landing
  /look              — public bench
  /access            — paid bench (token-scoped)
  /apply             — apply form (drawer)
  /concierge         — concierge brief form (drawer)
  /pricing           — bench builder + checkout
  /invite            — referral page (1+1, soft)
  /activate          — activation gate (3+1, hard, post-welcome)
  /emerging          — under-4-yrs free tier
  /admin             — operator console
```

---

## Key decisions (the why)

**Sheet as source of truth.** localStorage drift caused multiple data crises. Every visibility decision now reads from the Sheet via service account (15s cache). No CSV publish-to-web dependency. No localStorage gates for who's on the bench.

**Four-state status vocabulary.** `new | bench | rejected | paused`. Legacy values (approved/pending/denied/cold/duplicate/active) translate on read. Single column drives all visibility.

**Activation gate (2026-05-22 cutoff).** New approvals after this date must complete `/activate` (3 peer + 1 buyer refs) to surface publicly. Existing 160+ bench rows are grandfathered via `createdAtTs < ACTIVATION_GATE_TS` (index.html line ~947). Manual override: flip `Confirmed` column to `yes` in the Sheet.

**Discipline canonicalizer.** Single `canonicalDiscipline()` helper (index.html ~line 659) buckets every form variant + "Other" write-in into 7 buckets: CD, AD, copywriting, design leadership, brand strategy, motion, ux/content. Used everywhere — adapter, filter UI, stat counts, code-name pool selection.

**Per-discipline code-name pools.** `PHIL_POOLS` map (index.html ~line 497). Writers → copywriters, designers → AD/design lead, runners → brand strategy, filmmakers → motion, ad CDs → creative direction. `pickCodeName(discipline, used)` walks own pool → fallback chain → any unused → "creative N".

**Operator pin.** Max is injected into the bench client-side as CD primary / AD secondary / DL+strategy tertiary, always-available, legend-tinted. Only injects if his email isn't already in the Sheet (index.html refreshBench).

**Synthetic multi-discipline.** When a Sheet row's discipline cell is empty, hash distribution assigns a primary + ~55% chance of a secondary. So filters cross-match even with sparse data.

**Snapshot key versioning.** `colophon_bench_snapshot_v2` in localStorage. Bump the `_v2` whenever adapter output shape changes — invalidates every stale browser cache.

**One-keystroke deploy.** `./ship.sh "msg"` from repo root: clears stale lock, stages, commits, pushes. Vercel auto-deploys.

---

## Recent shipped work (last session)

1. **Activation gate** — `/activate` page, `/api/activate` endpoint, welcome email CTA, grandfather logic
2. **Operator pin** — Max as CD/Art always-available
3. **Mint readout card** — post-purchase, with persistent "add booked names" upsell
4. **Filter supply counts** — `(N)` next to each option, dim when zero
5. **Discipline canonicalizer** + per-discipline code-name pools
6. **Apply form alignment** — dropped "Strategy" dup, renamed avail labels to match front filter
7. **Build stamp** — top of `/admin`, shows deployed SHA + commit subject + age
8. **Buyers panel** — Stripe customers ranked by spend, copy-emails + CSV
9. **Contacts roll-up** — applicants/buyers/referrals/newsletter/concierge, side toggle (demand vs supply)
10. **Template library** — collapsible reference of every email + form
11. **Scramble jitter fix** — ghost-sibling pattern, 30% slower
12. **Header-map substring fallback** — fixed value-prop blurb + multi-disc parsing
13. **Repo cleanup** — orphan HTML/JS drafts removed (`git rm`)

---

## Open threads

- **Pending-activation admin view** — surface who's been approved but hasn't completed `/activate`, with a one-click "nudge again" button. Sized at ~30 min, not started.
- **Britton Taylor lookup** — operator asked if he's on the strategy bench. Not in May-6 snapshot. Live Sheet query needed.
- **Vercel Web Analytics enablement** — admin panel links to `/maxerdenbergers-projects/thisworks/analytics`. Needs to be turned on in Vercel project settings to start collecting.
- **Test bench session** — operator bought a test bench earlier; verify activation flow end-to-end on a fresh approval.

---

## Cron jobs

- `/api/daily` at `0 13 * * *` UTC — auto-pause >90d stale, auto-selective 45-90d, ping top 25 stalest >21d

---

## Critical env vars (Vercel)

```
SHEETS_SPREADSHEET_ID
GOOGLE_SERVICE_EMAIL
GOOGLE_PRIVATE_KEY              (\n must be literal \\n in env)
FORMSPREE_API_KEY
FORMSPREE_FORM_ID               (default xqenzjew)
RESEND_API_KEY
STRIPE_SECRET_KEY
ADMIN_KEY                       (fallback: '590Rossmore')
CRON_SECRET                     (optional; if set, /api/daily requires it)
ACTIVATION_TOKEN_SECRET         (optional; falls back to ADMIN_KEY for HMAC)
OPERATOR_EMAIL                  (default: merdenberger@gmail.com)
```

---

## Conventions

- **No emojis in code or commits.** Operator preference.
- **No `console.log` left behind.** Security audit clean as of last session.
- **`./ship.sh` for every push.** Don't run raw `git add/commit/push` unless debugging.
- **Bump `SNAPSHOT_KEY`** when adapter shape changes.
- **Don't introduce a fifth status state.** If you need state beyond `new|bench|rejected|paused`, use a flag column (like `confirmed`) instead.
