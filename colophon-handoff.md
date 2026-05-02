# Colophon — Project Handoff

A directory of senior independent creatives. Buyers buy a "look" pass to access contact info. Talent applies for inclusion; gets vetted manually.

This doc is a living source of truth. Update it whenever you change architecture, copy intent, or operational policy.

---

## TL;DR — what runs where

| Concern | Where |
| --- | --- |
| Site code | `index.html` (single file, React + Babel via CDN) |
| Hosting | Vercel, project name `thisworks`, watching `main` of `github.com/maxerdenberger/colophon` |
| Custom domain | `colophon.contact` |
| API endpoints | `/api/*.js` (Vercel serverless) |
| Talent data | Public Google Sheets CSV (URL is `SHEETS_CSV` in `index.html`) |
| Form submissions | Formspree (`FORM_ENDPOINT` in `index.html`); fallback to `mailto:hello@colophon.contact` |
| Payments | Stripe Checkout (`/api/checkout`) |
| Email auth | Stripe-on-success URLs + signed session tokens (`/api/create-session` + `/api/verify-session`) |
| Admin gate | Client password `590Rossmore` at `/admin`. Server side validates Bearer for `/api/send-invites`. Keep `ADMIN_SECRET` on Vercel matched. |

---

## Public surfaces

The site is a single React app. Five public tabs in the nav, all with the new tab-anchored drawer chrome:

| # | Key | Tab label | Drawer color | What it does |
| --- | --- | --- | --- | --- |
| 01 | `bench` | the bench | sage `#A8C4B8` | Drawer dual-purposes: shows the manifesto + "how we decide" criteria + newsletter signup; swaps to the hovered creative's dossier when a bench row is hovered. |
| 02 | `look` | build a bench | gold `#E8C478` | Terminal-style filter view (discipline / availability / experience / timezone / rate / duration). Live tally bar at the top. Stripe checkout below. |
| 03 | `concierge` | concierge | coral `#E8A4A0` | Pay $199 → fill brief → we send 5+ names. Pay stage has marketing copy ("rather skip the browsing?"); brief stage is a form. |
| 04 | `apply` | join the bench | olive-green `#B5BD68` | Talent application. Underline-style fields. |
| 05 | `access` | access | grey-blue `#A8B8C8` | Centered modal with code input. Submits to `/access?token=…` for the existing AccessPage to verify-session. |

Tab 01 + 02 click and hover scroll the page underneath to put the bench teaser in view.

---

## Architecture

### State axes (in `App`)

- `page` — `'home' | 'access' | 'admin' | 'invite' | 'success'`
- `activeDrawer` — `null | 'bench' | 'look' | 'concierge' | 'apply' | 'access'`
- `drawerFilters` — current filter state from the build wizard, flows into the bench teaser
- `seedKey` — bumps when filters are seeded externally (clicking a bench row)
- `hoveredCreative` — bench row hover; bench drawer reads it to swap content

### Always-mounted bench

`BenchTeaser` is part of `HomePage` and is always visible on `page === 'home'`. Drawers float over it via the new `Drawer` component (right-side panel anchored to its tab's left edge, fixed-position, height collapses to 0 when closed). Tabs 01 and 02 anchor strictly to their own tab's left edge so the bench stays visible to their left. Tabs 03–05 keep a 936px floor when their tab sits too far right.

### Live filter passthrough

`PricingPage` (build wizard) toggles → `useEffect` → `onFiltersChange(filters)` → `App.setDrawerFilters` → `HomePage` receives `activeFilters` → `BenchTeaser` receives `activeFilters` → `useMemo` recomputes filtered rows → bench updates live behind the gold drawer.

Click on a bench row → `App.openLookSeededFromCreative(creative)` → derives a filter object from the creative → calls `seedAndOpenLook({...})` → bumps `seedKey` → `PricingPage` syncs internal filters when `seedKey` changes (via `useRef` so it doesn't loop with its own `onFiltersChange` emissions) → opens look drawer.

### Holdback

`deriveCounts` subtracts a deterministic 10–17 from the raw row count (and ~half from `availableNow`) based on a 4-hour time bucket. The public-facing total tracks real supply but won't equal the raw CSV row count — accounts for duds, mid-renegotiations, quietly closed entries.

### Code-name pool

`PHIL_POOL` (≈500 names) covers philosophers, design / advertising / type legends, photographers, filmmakers, and distance runners. The CSV parser walks the pool in order with a `Set` for dedup, so the bench gets real-sounding names through the entire database.

### Live-supply theatre

- `BenchTeaser` swaps one random visible row for a different bench member every 42–120s (random per tick). Disabled while filters are active.
- Every 40–90s when no filters are active, all visible rows scramble in unison via a shared `matrixTick` wired into each row's `Scramble` runKey.

---

## Drawers

The `Drawer` component (around line 3300 in `index.html`) is the chrome. Per-tab colour comes from the `TAB_*` constants. Capture-phase document click listener handles outside-click close (was bubble-phase, which mis-fired when wizard buttons unmounted on click). Drawer outer div also stops bubble propagation as belt-and-suspenders.

`compact={true}` makes the drawer height-fit-to-content (no `bottom: 0`). Used by the access modal originally, no longer needed since access is a true modal.

---

## API endpoints

All in `/api/*.js`:

- `bench-count.js` — read-only, returns count of matching bench rows for a given filter blob. Public.
- `checkout.js` — Stripe Checkout session creation.
- `create-session.js` — mints a signed token (used after Stripe success).
- `verify-session.js` — validates a token from a query string.
- `lookup-applicant.js` — used by `/invite` confirm flow.
- `invite-confirm.js` — applicant confirmation handler.
- `join.js`, `redeem.js` — flow helpers (check the file for current contract).
- `send-invites.js` — admin-only, requires `Authorization: Bearer <ADMIN_SECRET>`. Used by the AdminPage invite sender + AdminTestFlows referral test.

### Hypothetical / not-yet-implemented

- `/api/bench-update` — POST endpoint expected by `AdminBenchBrowser`. Should accept `{ action: 'approve' | 'deny' | 'revoke' | 'add', id, name, ... }` with `Authorization: Bearer <ADMIN_SECRET>`, write back to the source CSV / Google Sheet (Sheets API), and return success/failure. **Not implemented yet** — the buttons fire the request and surface an error in the inline log if the endpoint is missing.
- `/api/dark-mode` — same pattern. The current admin "go dark" toggle uses `localStorage` only (per-browser). For real site-wide maintenance, set `DARK_MODE=1` on Vercel and gate at the entry server-side.

---

## Form routing (Formspree by default)

`submitForm()` posts JSON to `FORM_ENDPOINT` and falls back to a `mailto:` if that fails. Each call sets a `source:` and `_subject:` so the inbox can route:

| Source tag | Where it comes from |
| --- | --- |
| `apply-bench` | Talent application (tab 04) |
| `concierge-brief` | Concierge brief stage (post-pay) |
| `concierge` | Build-wizard concierge upsell (`/api/lead`) |
| `bench-newsletter` | Newsletter signup at the bottom of the bench drawer |
| `home-got-a-project` | Footer "got a project?" form |
| `founder-intake` | Was the public founders tab; now lives in `AdminTestFlows`. |
| `admin-test-*` | Test submissions fired from the admin console |

---

## Admin console (`/admin`)

Password: `590Rossmore`. Client gate; `/api/send-invites` validates the same value as Bearer.

Top-bar actions: download this handoff MD, take site dark.

Panels in order:

1. **AdminStatsPanel** — total / available / median yoe / past clients tiles + Americas / EU-Africa / Asia-Pacific region split. Live from `useBench`.
2. **AdminBenchBrowser** — filter input, scrollable list of every bench row with per-row Approve / Deny / Revoke buttons. Manual-add form below. All actions POST to `/api/bench-update`.
3. **AdminQuickLinks** — Stripe Payments, the bench Sheet, Vercel, Formspree, GitHub, the public `/access` page.
4. **AdminTestFlows** — `run all →` button + per-flow buttons that POST to every public form path (talent application, concierge brief, concierge upsell `/api/lead`, founder intake, newsletter, home brief, referral invite via `/api/send-invites`). All payloads tagged `source: 'admin-test-*'`, addressed to `merdenberger@gmail.com`. Inline log shows results.
5. **Existing invite sender** — single-test or batch-JSON modes for `/api/send-invites`.

---

## Soft-launch test plan

After deploying, run this checklist top-to-bottom:

1. **Public homepage** — open `colophon.contact`, verify tabs 01-05 visible, footer clocks span the page, hovering a clock winds it.
2. **Tab 01** — click; sage drawer opens with the manifesto, criteria, newsletter signup. Hover a bench row; drawer content swaps to dossier. Easter egg: "(under 4 yrs →)" link should open the gold drawer prefiltered.
3. **Tab 02** — click; gold drawer opens with terminal-style filter list. Toggle a filter; tally updates and bench teaser behind filters live. Click a bench row; gold drawer reopens prefilled.
4. **Tab 03** — concierge drawer opens. Pay button starts Stripe Checkout (do not actually pay).
5. **Tab 04** — apply drawer opens. Underline-style fields, prefilled hints. Form should submit (use a test email).
6. **Tab 05** — access modal opens centered with backdrop blur. Submit a fake code; should redirect to `/access?token=…`.
7. **Admin** — `colophon.contact/admin`, unlock with `590Rossmore`. Hit `run all →` on AdminTestFlows; verify emails arrive at `merdenberger@gmail.com`.
8. **Site-dark** — click "↓ take site dark" in admin top bar; reload the public homepage in another tab; should see the maintenance splash. Click "↑ bring site back live" in admin; reload public; back to normal.

---

## Operations

### To make the site go dark site-wide (real)

1. Set `DARK_MODE=1` env var on Vercel.
2. Add a server-side gate in the relevant API or in `vercel.json` rewrites that returns the maintenance page.
3. The current admin button only flips localStorage — per-browser, useful for local testing or sharing a `?dark=1` link.

### To add or remove someone from the bench

Today: edit the source Google Sheet directly. The CSV is re-fetched on every visit so changes propagate within a refresh. Once `/api/bench-update` is implemented, AdminBenchBrowser does this through buttons.

### To rotate the admin secret

1. Generate a new value, e.g. via `openssl rand -hex 16`.
2. Update the `ADMIN_PW` constant in `index.html` AND set `ADMIN_SECRET` to the same value on Vercel.
3. Redeploy.

### To rotate the GitHub token (assistant access)

A classic `repo`-scope PAT was issued for assistant pushes during build-out. Revoke it at `github.com/settings/tokens` when assistant work is done. Issue a fresh fine-grained or classic PAT only as needed; never commit the token value to the repo.

---

## Outstanding / known issues

- `/api/bench-update` is referenced from AdminBenchBrowser but **not implemented**. Buttons will log "status 404" until the endpoint exists. Implementation requires the Sheets API with a service-account credential committed to Vercel env (`GOOGLE_APPLICATION_CREDENTIALS_JSON` or similar) and a write scope.
- `/api/dark-mode` not implemented. The admin button only writes localStorage.
- The orphan wrapper components `BenchDrawer`, `LookDrawer`, `ConciergeDrawer`, `ApplyDrawer` are still defined in `index.html` but unreferenced. Safe to remove in a cleanup pass.
- The public-facing `founders` tab was reverted (admin-side intake instead). The `submitForm` `source: 'founder-intake'` is still wired through AdminTestFlows so admin can dogfood it.
- Formspree is rate-limited — running AdminTestFlows' `run all` rapid-fire may queue or drop a few. Wait 30s between full runs.

---

## File map (`index.html` line approximations — drift over time)

| Component / region | Approx line |
| --- | --- |
| `<style>` block | 88–290 |
| `C` palette tokens | ≈340 |
| `FIELD` / `BUTTON_PRIMARY` constants | ≈360 |
| `BENCH` (seed array) | ≈400 |
| `PHIL_POOL` | ≈460 |
| `SHEETS_CSV` constant | ≈410 |
| `parseSheetCSV` | ≈530 |
| `deriveCounts` + `holdbackForNow` | ≈610 |
| `BenchProvider` / `useBench` | ≈680 |
| `Scramble` | ≈770 |
| `AnalogClock` | ≈830 |
| `BenchDashboard` (legacy) | ≈900 |
| `BenchTeaser` | ≈1140 |
| `OppsTable` | ≈1290 |
| `Footer` | ≈1340 |
| `HomePage` | ≈1450 |
| `ApplyPage` (tab 04) | ≈1620 |
| `PricingPage` (tab 02 build wizard) | ≈1750 |
| `UnlockedBenchTable` | ≈2280 |
| `AccessPage` | ≈2480 |
| `ConciergePage` | ≈2660 |
| `InvitePage` | ≈2880 |
| `SuccessPage` | ≈2920 |
| `AdminPage` + sub-components | ≈2950 |
| `Drawer` | ≈3300 |
| `BenchDrawerContent` | ≈3380 |
| `AccessModal` | ≈3490 |
| `FolderTab` / `Header` / `App` | ≈3800 |

(Search by component name when these drift.)

---

## Glossary

- **bench** — the directory of vetted creatives.
- **look** — a paid pass (day / week / month) that unlocks names + contact info on the bench.
- **drawer** — a tab-anchored side panel; opens on tab click, closes on ESC / outside click / clicking the active tab.
- **dossier** — the right-side card showing a creative's discipline, name, status, note, clients (sage). Triggers on bench row hover; lives in the bench drawer.
- **holdback** — public total = raw rows minus 10–17, cycled per 4-hour bucket.
- **seed** — when filters are applied externally (clicking a bench row), the build wizard syncs from the seeded values.

---

_Last updated alongside commit `7c9b7fc`. Keep this doc updated; it's the fastest way to onboard a new collaborator or pick the project up after a long gap._
