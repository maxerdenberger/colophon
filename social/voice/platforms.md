# Per-platform format conventions

## LinkedIn (company page)

- 2-4 lines. Atmospheric or one-liner.
- Lowercase, declarative.
- Close with `→ colophon.contact` on its own line.
- No hashtags except `#onthebench` when the post belongs to the running thread.
- No tagging people unless explicit CEO approval.
- Best window: Tues-Thurs 9-11am PT or 4-6pm PT.

## Instagram (feed)

- **Visual** is the tabbed-folder motif on a 1:1 square: cream stock (`#F4F1EC`), small black tab upper-right with `FILE / MM.DD` metadata in IBM Plex Mono (white on black, letter-spaced), small solid orange dot (`#FF5100`) upper-left.
- **Body type:** Space Grotesk **Bold**, **upright/roman (never italic)**, **left-aligned** to the same x-position as the orange dot (~8% from canvas left), positioned in the lower-middle. One line or two short lines.
- **Footer:** thin black hairline near bottom edge, then `colophon · COLOPHON.CONTACT · FILED · MONTH · YEAR` — note "colophon" is lowercase, the rest is uppercase. IBM Plex Mono, letter-spaced, centered.
- **Caption** ≤ 2 lines + `→ colophon.contact` + `#onthebench`.
- Stories are off the table for soft-launch.
- Carousels permitted for "filed dossier" series — every slide uses the same chassis with different tab metadata + body.

## X (Twitter)

- One line. No URL. No hashtag.
- Atmosphere, not conversion. The bio carries the link.
- Quote-tweets of community pit moments are welcome when they're real.
- ≤ 140 chars even though the limit is higher — the line is the work.

## Threads

- Same shape as X. One or two posts in a row OK if the second is a beat, not a continuation.
- `#onthebench` permitted when the post belongs to the running theme.
- No URL.

## UTM convention

When a URL ships (LI + IG only), append:

```
?utm_source={platform}&utm_medium=organic&utm_campaign={topic-slug}
```

Example: `colophon.contact?utm_source=linkedin&utm_medium=organic&utm_campaign=real-time-bench`

The `/api/social-post` wrapper does NOT auto-UTM. Organic Social Lead adds it at draft time.

## Buffer timezone

Both Buffer channels are `America/Los_Angeles`. When computing `scheduled_at`, convert from your wall clock to PT and emit ISO-8601 with the PT offset, e.g. `2026-05-26T17:00:00-07:00`.
