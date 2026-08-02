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
scripts/run-ui-smoke.sh --url http://localhost:8787   # against a running `docker compose` stack
scripts/run-ui-smoke.sh --slug myproject --json
node scripts/playwright/smoke.mjs --help
```

With no `--url`, the base URL resolves `--url` > `$STACK_UI_URL` >
`http://localhost:${WEB_PORT:-8787}` — 8787 is `docker-compose.yml`'s own
default web port (`"${WEB_PORT:-8787}:80"`), and `WEB_PORT` is honoured here
for a host that remapped it.

`run-ui-smoke.sh` installs `scripts/playwright`'s own dependencies on first
run (this package is deliberately separate from the rest of the repo, which
stays dependency-free) and makes sure the chromium build playwright wants is
present, then hands off to `smoke.mjs`. Every argument passes through.

Exit code 0 means zero findings across every screen and viewport. Anything
else is 1 — a broken screen, an unreachable app, or a browser that would not
launch.

## Preflight: is this actually Stack?

Before any browser is launched, the harness fetches `<url>/api/health` and
requires a 200 JSON body with `ok: true` and a `version` field — Stack's own
shape. This exists because of a real incident: the harness's default base
URL once pointed at a port that, on one host, belonged to an entirely
unrelated app; the harness dutifully walked its screens anyway and reported
154 layout findings that were all true and all worthless, with nothing in
the output to say the wrong application had been smoked. A port answering is
not the same as the right app answering, so a run refuses outright — exit 1,
plain-language reason, no screens visited — rather than silently succeeding
against the wrong application. The preflight result (`url`, `ok`, `version`)
is recorded as a top-level `preflight` field in `report.json`, so a stored
report always says what was actually smoked.

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

## `--report`: landing a run on the Quality page

`--report` is **opt-in** — a plain local run stays side-effect-free. When
passed, after the run completes it POSTs the outcome to
`<url>/api/projects/<slug>/checks/report`, the external-check inlet
(`server/src/routes/checks.js`), before `report.json` is written to disk —
so the file on disk always reflects whether the report landed. `<url>` is
the **same base URL this run just smoked** — never a separately configured
API host — and it carries the same bearer token the run used.

That lands the result on the project's **Quality page, Suite segment**, as a
check named `UI Smoke Harness` and marked "reported" rather than "run by
Stack". The row does not need seeding: `stack seed-checks` never creates it —
the **first** `--report` POST plants the row itself, and every later one
updates the same row by name.

- `status` is `pass` when the run found zero findings of either severity,
  otherwise `fail`.
- `error` (fail only) is a compact one-line summary: the error/layout counts,
  how many screens and viewports were covered, and the single worst finding
  — e.g. `6 errors, 29 layout findings over 14 screens / 2 viewports — worst:
  page-error on dashboard@desktop: Minified React error #418`.

A failed report **warns loudly but never reddens a clean run**: the exit code
answers "is the UI sound?", which is a question about the app, not about
whether the recording of that answer reached the server. So a failed POST
(unreachable API, non-2xx, a 409 name clash) prints a loud warning naming the
status and body and records `reported: { ok: false, reason }` in
`report.json` — but the process exit code still comes from the findings
alone. It is never swallowed silently either: a report that did not land is a
Quality page quietly showing yesterday's result as if it were today's, so
this is always visible in both the terminal and the stored report. A
successful report prints one confirmation line and records
`reported: { ok: true, name, status }`.

## Running it on a host without root

Chromium needs a handful of shared libraries (nss, atk, cairo, pango, and a
few more) that a minimal Debian/Ubuntu host may not have installed. The
normal fix, `npx playwright install-deps`, shells out to `apt install` and
needs root — which an unattended overnight session has no password to give.

`scripts/run-ui-smoke.sh` probes for this first (via `ldd` on the cached
chromium binary) and, only if something is actually missing, runs
`scripts/playwright/setup-browser-deps.sh`. That script fetches the missing
`.deb` files with `apt-get download` and extracts them with `dpkg-deb -x`
— both rootless — into a private prefix at `~/.stack/ui-smoke-deps` (or
`$STACK_UI_SMOKE_DEPS`), then points `LD_LIBRARY_PATH` and
`FONTCONFIG_FILE` at it for the smoke run. **Nothing is installed
system-wide** — the prefix is only ever read by this harness's own chromium
process, and re-running the provisioner is a no-op once it has already run
(pass `--force` to rebuild it).

The two alternatives, if you'd rather not use the private prefix:
- `sudo npx playwright install-deps` on this host (needs a password), or
- run the harness inside `mcr.microsoft.com/playwright:v1.62.1-noble` with
  `--network host`, which already has every library installed.

**Caveat:** the private prefix supplies DejaVu Sans as its sans-serif
fallback (there is no system font stack in the prefix), so glyph metrics can
differ slightly from what the owner's own browser renders. Treat a
borderline overflow finding as a prompt to check the screenshot, not as
gospel on its own.

## Fail-safe direction

This is a **test**, not a recorder (CLAUDE.md, "Fail-safe direction"): it
fails loud. An unreachable app, a browser that will not launch, a missing
token — all of these return exit 1 with a plain-language reason, never a
silent "0 findings". A check that reports nothing because it could not look
is the same lie as a `NULL` review verdict rendering green.
