# stack-ui-smoke

A headless-browser smoke harness over Stack's own UI (#291) — a session
cannot see its own rendering, and two real layout bugs reached the owner that
way: a terminal that did not reflow when a rail toggled, and a 3-pane grid
overflowing its own height (a bare `1fr` floors at the canvas intrinsic
height). "Build green" (tsc, strict TS) says the TypeScript compiles; it says
nothing about what actually paints. This drives real Chromium against a
running instance of the app, walks every top-level screen at two viewports,
presses the controls a screen declares, and reports what it finds.

It is **read-only** — it navigates and observes, and the only controls it
presses are ones that change view state and nothing else (see "Interactions").
The screens it visits are the live app's real trackers.

## Running it

```bash
scripts/run-ui-smoke.sh                              # against ~/.stack/env's STACK_API
scripts/run-ui-smoke.sh --url http://localhost:5173   # against a local `npm run dev`
scripts/run-ui-smoke.sh --url http://localhost:8787   # against a running `docker compose` stack
scripts/run-ui-smoke.sh --slug myproject --json
scripts/run-ui-smoke.sh --screens project-roadmap     # the Timeline, zoom stops and all
scripts/run-ui-smoke.sh --no-interactions             # walk and scan only, press nothing
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

Three severities. `error` and `layout` fail the run (exit 1); `info` never
does — separated so a reader can tell a broken script from a broken layout
from noise this harness chose not to hold Stack responsible for:

**`error`** — something is actually broken:
- `console-error` — the page logged a console error.
- `page-error` — an uncaught exception in the page. Kept when a stack frame
  names this app's own origin, or when no frame can be parsed at all; a
  cross-origin frame throwing inside an embedded iframe reclassifies to
  `third-party-page-error` (BUG-7 — see "What the harness deliberately does
  not report").
- `request-failed` — a network request failed outright.
- `http-error` — a response came back 5xx.
- `auth-rejected` — a `/api/` response came back 401. This is worse than the
  others: it means the harness smoke-tested a **signed-out** app, so every
  layout finding recorded alongside it is worthless.
- `navigation-failed` — `page.goto` itself threw.
- `control-missing` — an interaction's control (see "Interactions") was never
  found on the screen. It moved, was renamed, or the screen did not render it;
  either way **nothing about that control was tested**, which is why this is an
  error and not a skip.
- `control-inert` — the control was found and pressed, but left no trace: its
  `expect` selector never appeared, or the element it was supposed to change
  still reads exactly as it did before. A control that does nothing is the
  defect this catches.
- `interaction-abandoned` — an earlier interaction on the same screen failed,
  so this one was not attempted: the view it needed was never established, and
  measuring from the wrong state would produce a confidently wrong reading.

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

**`info`** — recorded and printed in their own section, never fail the run:
- `third-party-console` — a console error whose message names a URL on a
  different origin to the app under test.
- `third-party-request` — a failed request, or a 5xx response, whose URL is
  on a different origin to the app under test.
- `third-party-page-error` — an uncaught exception whose stack frames all sit
  on a different origin: something thrown inside one of the embedded preview
  iframes, not in this app.

## What the harness deliberately does not report

A first full run produced 18 `error` and 149 `layout` findings, and almost
none of them were about Stack. Reporting them anyway would have made the
harness cry wolf loudly enough that nobody would read it — which defeats the
whole point (CLAUDE.md: "a harness that cries wolf ... is a harness nobody
reads"). None of this is a silent slice: every filtered item is **counted**,
in a per-screen `suppressed: { ellipsis, lineClamp, thirdParty,
clippedAncestor, foreignFrame, viewport }` object in `report.json` and in the run's printed summary
line (e.g. `... (47 suppressed: 41 ellipsis, 6 third-party)`), and `info`
findings are shown in full, in their own section — filtered out of the
pass/fail count, never out of the report.

- **A truncated label is not a bug.** `text-overflow: ellipsis` REQUIRES
  `overflow: hidden`, so `scrollWidth > clientWidth` is the ellipsis's
  normal, permanent, intended state — the ellipsis IS the disclosure that
  content is cut off. `element-overflow-x` skips any element whose computed
  `text-overflow` is `ellipsis`; `element-overflow-y` skips the vertical
  equivalent, an element whose computed `-webkit-line-clamp` is a number
  (not `none`). The bug this finding exists to catch is content cut off with
  **no** visual hint at all — that case still reports.
- **A viewport onto a larger space is not a box that ran out of room.** The
  Timeline's lanes and ruler clip `overflow-x` and hold bars and ticks placed
  at a percentage of a window that zooms from an hour to a quarter, so at most
  zooms most bars sit off-window **by design** — and the app discloses it
  itself, with the `.rt-off` chip counting what went off each edge. Same for
  the Workbench ground (2400px, deliberately pannable) and the Polaris galaxy
  stage. `element-overflow-x` therefore skips an element whose overflowing
  children are all absolutely positioned, provided **no** child left in normal
  flow spills — one of those is a genuine out-of-room bug and disqualifies the
  element however many absolute siblings it has. Counted as `viewport`, and
  applied to the horizontal axis only, which is the one verified against a real
  surface. This is what stopped the Timeline interactions below burying the run:
  they took it from 12 such findings to 49, none of them defects.
- **A preview of another project's site is not Stack's problem.** The
  dashboard renders live previews of other projects' cards, so a console
  error or failed request can genuinely originate from a page this harness
  never meant to smoke (the observed cases: the Cloudflare RUM analytics
  beacon, and console/request noise from other projects' own sites).
  Attributing that to Stack is the same mistake the preflight below already
  guards the whole run against — reporting a stranger's problem as this
  app's own. `request-failed` / `http-error` reclassify to
  `third-party-request`, and `console-error` reclassifies to
  `third-party-console` when a URL can be extracted from the message, when
  that origin differs from the base URL's own origin. This is deliberately
  conservative: an ambiguous message is left as a real `console-error`,
  because a false "someone else's problem" hides a real defect, which is
  worse than one noisy true finding. A `console-error` whose message carries
  no URL — the browser's own "Failed to load resource: … 404" never does — is
  attributed by `location().url`, where the console message was raised.

  `page-error` was originally exempt from all of this, on the grounds that an
  uncaught exception fires inside Stack's own page even when a third party
  threw it. That holds for a third-party SCRIPT on the page. It does not hold
  for a cross-origin IFRAME, which is a separate document with its own window
  — and the dashboard renders one per project card. Playwright reports an
  exception from any frame as the page's own, so the `Minified React error
  #418` on the dashboard was filed against Stack as a hydration bug it could
  not have (this app calls `createRoot` and never hydrates; React 18's #418
  takes no arguments, and the observed one carries the React 19 `args[]=text`
  form). It comes from the Next.js site framed in a card. Proved by loading
  the dashboard twice: with cross-origin document requests refused, the page
  throws nothing at all.

  So a `page-error` is now attributed by its **stack frames only** — never by
  its message, which for that React error names `react.dev` and would
  misattribute a genuine Stack error to the docs site. Any same-origin frame,
  or no parseable frame, keeps it a real finding. `auth-rejected` stays
  exempt on its original grounds, which do hold: it is judged by request
  path, not message content.
- **An element holding nothing but a cross-origin iframe is measuring someone
  else's document.** `span.preview` on each project card clips a live iframe
  of that project's deployed site at the site's own intrinsic size — a
  1043px-wide document inside a 261px card is the entire design of the card,
  and nothing inside this app can change it. Suppressed as `foreignFrame`,
  and deliberately the tightest form of the rule: one non-frame child, or one
  same-origin frame, and it is this app's layout again and gets reported.
- **A pannable canvas clipped by its container is not a bug.** The Workbench
  canvas (`svg.wb-wires` inside `div.wb-ground`) is a deliberately-oversized,
  pannable 2400px surface that its container clips with `overflow: hidden` —
  it never makes the document itself scroll. `element-past-viewport` walks
  from the element up to `<body>` and, if any ancestor's computed
  `overflow-x` is `hidden`, `clip`, `auto` or `scroll`, the element is
  contained and is not reported — only an element that reaches the viewport
  edge with nothing clipping or scrolling it actually causes the
  document-level overflow that `page-overflow-x` names the symptom of.

## Interactions: pressing a control, not just looking at one

Walking a screen only ever measures its **first paint**, which is its
most-tested state. #401 is the case that forced this: all five of its defects
sat behind a control — a grain label that understated a four-day window as
twenty-nine minutes, a calendar grip that resized on the wrong axis, lane names
that desynced once a lane stacked two bars. A green build could not see any of
them, and neither could a harness that only navigates.

So a screen may declare `interactions`. Each is a press, and each press is a
**pass of its own**: the harness presses, waits, then runs exactly the same
layout scan and screenshot it runs on a first paint. They run in sequence on
one page and deliberately do not reset it between presses, because a control
that only misbehaves once you have already moved the view is precisely what
walking cannot reach. `project-roadmap` currently declares seven — the five
zoom stops (coarsest first, so each is a real change from the last), then
`Fit all` and `Now`.

**What may be an interaction.** The read-only rule is not relaxed here, it is
narrowed to something checkable: a control qualifies only if pressing it
changes **view state only** — React state that no `store.ts` call reads and no
request follows. The Timeline's zoom stops, `Now` and `Fit all` are all bare
`setView` calls, verified by reading the handlers. A bar, a card, a tick, a
drawer field, anything that opens a modal over real tracker rows: no. That a
press "only opens something" is not the test — the test is whether a write can
follow from where it leaves you.

**Every press must prove it landed**, or the harness is photographing the
Timeline rather than testing it. A zoom stop proves itself structurally: the
stop wearing `.on` is `grainFor()`'s answer to the resulting pixel density, not
an echo of the click, so a stop whose label and density disagree is caught
here. `Fit all` and `Now` are not toggles and prove themselves by the window
label's **text changing** across the press. Anything else — control absent,
unclickable, or inert — is an `error` finding, and the rest of that screen's
interactions are abandoned rather than measured from a state that was never
established.

`--no-interactions` walks and scans only, which is how you tell whether a
finding needs a press to appear.

## Output

`<out>/report.json` (default `scripts/playwright/screenshots/report.json` —
see `--out`) holds the full machine-readable report;
`<out>/<screen-id>@<viewport>.png` holds one screenshot per screen per
viewport, and `<out>/<screen-id>--<interaction-id>@<viewport>.png` one per
interaction. Neither ever contains the bearer token.

In the report, a row is a **pass**, not a screen: `totals.screens` counts
routes, `totals.passes` counts rows and `totals.interactions` counts the
pressed ones. Counting passes as screens would report a run that pressed seven
controls on one screen as having covered seven screens.

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
  element-overflow-y on terminal@narrow: div.term-pane.focused clips
  overflow-y but scrollHeight 569 > clientHeight 558`.

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
