# stack-ui-smoke

A headless-browser smoke harness over Stack's own UI (#291) — a session
cannot see its own rendering, and two real layout bugs reached the owner that
way: a terminal that did not reflow when a rail toggled, and a 3-pane grid
overflowing its own height (a bare `1fr` floors at the canvas intrinsic
height). "Build green" (tsc, strict TS) says the TypeScript compiles; it says
nothing about what actually paints. This drives real Chromium against a
running instance of the app, walks every top-level screen at two viewports,
and reports what it finds.

It is **read-only** — it navigates and observes, never clicks a control that
writes. The screens it visits are the live app's real trackers.

## Running it

```bash
scripts/run-ui-smoke.sh                              # against ~/.stack/env's STACK_API
scripts/run-ui-smoke.sh --url http://localhost:5173   # against a local `npm run dev`
scripts/run-ui-smoke.sh --slug myproject --json
node scripts/playwright/smoke.mjs --help
```

`run-ui-smoke.sh` installs `scripts/playwright`'s own dependencies on first
run (this package is deliberately separate from the rest of the repo, which
stays dependency-free) and makes sure the chromium build playwright wants is
present, then hands off to `smoke.mjs`. Every argument passes through.

Exit code 0 means zero findings across every screen and viewport. Anything
else is 1 — a broken screen, an unreachable app, or a browser that would not
launch.

## Why playwright is pinned to 1.62.1

Not a caret range. Playwright 1.62.1 wants chromium revision 1234, which is
already present in `~/.cache/ms-playwright` on this host — a pinned install
resolves to exactly that version and downloads nothing. A caret range could
silently roll to a version wanting a different revision on some future `npm
install`, turning every run into an unexpected multi-hundred-megabyte
download.

## Why screenshots are viewport-clipped, not full-page

`fullPage: true` expands the browser's rendered canvas to fit the page's
content — which is precisely the condition that HIDES an overflow bug. What a
human actually sees when they open the app is the viewport, clipped exactly
as the harness shoots it.

## Findings

Two severities, both fail the run (exit 1) — separated only so a reader can
tell a broken script from a broken layout:

**`error`** — something is actually broken:
- `console-error` — the page logged a console error.
- `page-error` — an uncaught exception in the page.
- `request-failed` — a network request failed outright.
- `http-error` — a response came back 5xx.
- `auth-rejected` — a `/api/` response came back 401. This is worse than the
  others: it means the harness smoke-tested a **signed-out** app, so every
  layout finding recorded alongside it is worthless.
- `navigation-failed` — `page.goto` itself threw.

**`layout`** — the page rendered but something visually broke:
- `page-overflow-x` — the document is wider than the window (the symptom).
- `element-overflow-x` / `element-overflow-y` — an element clips its overflow
  (`overflow: hidden`/`clip`) but its content is bigger than the box —
  content silently cut off. `element-overflow-y` is the shape of the #291
  3-pane grid bug: a pane taller than the container that clips it.
  Deduplicated to the OUTERMOST offending ancestor, and capped at 25 reported
  elements per kind per screen — when the cap bites, the report says so
  alongside the true total (CLAUDE.md: a capped list must say it is capped).
- `element-past-viewport` — a visible element whose right edge exceeds the
  window width (the actual culprit that `page-overflow-x` only reports the
  symptom of).

## Output

`<out>/report.json` (default `scripts/playwright/screenshots/report.json` —
see `--out`) holds the full machine-readable report;
`<out>/<screen-id>@<viewport>.png` holds one screenshot per screen per
viewport. Neither ever contains the bearer token.

## Fail-safe direction

This is a **test**, not a recorder (CLAUDE.md, "Fail-safe direction"): it
fails loud. An unreachable app, a browser that will not launch, a missing
token — all of these return exit 1 with a plain-language reason, never a
silent "0 findings". A check that reports nothing because it could not look
is the same lie as a `NULL` review verdict rendering green.
