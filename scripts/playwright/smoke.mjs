#!/usr/bin/env node
// smoke.mjs — a headless-browser smoke pass over Stack's own UI (#291).
//
// WHY THIS EXISTS: "build green" (tsc) says the TypeScript compiles; it says
// nothing about what actually renders. Two real layout bugs reached the owner
// invisibly to tsc — a terminal that did not reflow when a rail toggled, and a
// 3-pane grid overflowing its own height (a bare `1fr` floors at the canvas
// intrinsic height). Neither is a type error. This harness drives a real
// Chromium against a running instance of the app, walks every top-level
// screen at two viewports, and reports what actually painted: console errors,
// failed requests, a rejected auth token, and layout overflow.
//
// FAIL-SAFE DIRECTION (CLAUDE.md, "Fail-safe direction"): this is a TEST, not
// a recorder, so it fails LOUD. An unreachable app, a browser that will not
// launch, a missing token — every one of those returns exit 1 with a plain
// reason. It never degrades to "nothing found": a check that reports zero
// findings because it could not look is the same lie as a NULL review verdict
// rendering green, and CLAUDE.md is explicit that both are the same mistake.
//
// READ-ONLY: this harness navigates and observes only. It never clicks a
// control that writes — the screens it visits are the live app's real
// trackers, and a stray click here would land in a real project.
//
// WALKING IS NOT ENOUGH (#401): every one of that item's five defects sat
// behind a CONTROL — a grain label that understated a four-day window as
// twenty-nine minutes, a calendar grip that resized on the wrong axis, lane
// names that desynced once a lane stacked two bars. A harness that only
// navigates cannot see any of them, because the first paint of a screen is
// its most-tested state. So a screen may also declare `interactions`: presses
// the harness makes before scanning again.
//
// WHAT MAY BE AN INTERACTION — the read-only rule above is NOT relaxed here,
// it is narrowed to something checkable. A control qualifies only if pressing
// it changes VIEW STATE ONLY: React state that no store.ts call reads and no
// request follows. The Roadmap's four board buttons all qualify — each is a
// bare `setBoard`, verified by reading the handlers. A bar, a card, a tick, a
// drawer field and anything opening a modal over real tracker rows do NOT, and
// the fact that a press "only opens something" is not the test: the test is
// whether a write can follow from where it leaves you.
//
// AND AN INTERACTION FAILS LOUD (see the fail-safe note below). A control that
// cannot be found, cannot be pressed, or leaves no trace of having been pressed
// is an `error` finding, never a skip. Silence there would be this file's own
// central lie in miniature — a run reporting a clean board because it never
// managed to touch one.
//
//   node scripts/playwright/smoke.mjs [options]
//   scripts/run-ui-smoke.sh [options]     (installs deps first if missing)
//
// Options: --url --token --slug --out --screens --viewport --timeout
//          --headed --json --report --no-interactions --help
//          (see --help for details)

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- the interactions ------------------------------------------------------
// Presses a screen may declare. Each is { id, label, click, expect }:
//
//   click   the control to press (a Playwright selector)
//   expect  proof the press LANDED — a selector that must exist afterwards and
//           must not already exist before. Without it a run cannot tell a
//           working control from an inert one, which is the difference between
//           this harness testing a control and merely photographing it.
//
// THE ROADMAP IS ONE BOARD NOW. The strip of four (Board · Scope · Tiers ·
// Parked) is culled, so the four `setBoard` presses that stood here have no
// control to press. What replaces them are the two panels the board opens over
// itself — both read-only, both proved by something that must NOT already be on
// screen, and both drawn whatever the board holds. Deliberately NOT a press on a
// card: a card-shaped interaction fails on a project whose board is empty, and a
// harness that cries about an empty board is one nobody trusts.
const ROADMAP_PANELS = [
  {
    id: 'board-labels',
    label: 'Roadmap — labels menu',
    click: '.rp-bar .rp-labelbtn',
    expect: '.rp-bar .rp-labelpop',
  },
  {
    id: 'board-archive',
    label: 'Roadmap — archive rail',
    click: '.rp-bar .rp-archive-toggle',
    expect: '.rp .rp-archive',
  },
];

// ---- the screens ---------------------------------------------------------
// One entry per top-level route this harness walks. `<slug>` is substituted
// for the --slug value at run time. Order matches the app's own nav order.
export const SCREENS = [
  { id: 'dashboard', label: 'Dashboard', path: '#/' },
  // Mission Control's rooms are culled; `#/control` is the placeholder that
  // stands where they were. Still walked, and deliberately: it is linked from
  // six topbars, so a layout break on it is a break the owner meets — and the
  // walk is what proves the route still resolves rather than 404ing.
  { id: 'control', label: 'Control — placeholder', path: '#/control' },
  { id: 'terminal', label: 'Terminal', path: '#/terminal' },
  { id: 'skills', label: 'Skills', path: '#/skills' },
  { id: 'timeline', label: 'Timeline', path: '#/timeline' },
  { id: 'settings', label: 'Settings', path: '#/settings' },
  { id: 'project-overview', label: 'Project — Overview', path: '#/p/<slug>' },
  { id: 'project-quality', label: 'Project — Quality', path: '#/p/<slug>/quality' },
  // The roadmap tab IS the board, so its own bar is on screen at first paint
  // and needs no navigating to. If a strip ever comes back over it, these
  // interactions start reporting a control they cannot reach — which is the
  // correct, loud answer.
  {
    id: 'project-roadmap',
    label: 'Project — Roadmap',
    path: '#/p/<slug>/roadmap',
    interactions: ROADMAP_PANELS,
  },
  { id: 'project-activity', label: 'Project — Activity', path: '#/p/<slug>/activity' },
  // The three screens the console kit added. Activity above and Auto-ideas
  // here are two tabs of ONE screen (For you) reached by two routes, and both
  // are walked on purpose: the route is the contract, and a strip that stopped
  // honouring one of its keys would still render perfectly on the other.
  { id: 'project-auto', label: 'Project — Auto-ideas', path: '#/p/<slug>/auto' },
  { id: 'project-ideas', label: 'Project — Roadmap capture', path: '#/p/<slug>/ideas' },
  { id: 'project-plans', label: 'Project — Plans', path: '#/p/<slug>/plans' },
];

// desktop = the ordinary window this app is designed for; narrow = where a
// rigid multi-pane grid breaks first — exactly the class of bug #291 exists
// to catch (a 3-pane grid does not have room to be rigid at 1024).
export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  narrow: { width: 1024, height: 768 },
};

// Requests to ignore for the request-failed finding. Empty on purpose: every
// request this harness makes is one it should be able to explain, so nothing
// is silently excluded. If a noisy, harmless request needs ignoring later,
// name it here with a comment saying why — never filter silently in the
// listener itself.
export const IGNORED_REQUEST_PATTERNS = [
  // (none yet)
];

const CAP_PER_KIND = 25;
const SETTLE_MS = 600;

// The row's IDENTITY on the server (POST /api/projects/:slug/checks/report
// matches by name — the first report PLANTS the row, every later one updates
// it). A module-level constant, not an inline string, so it stays greppable
// and the client and any future caller can never drift apart on the name.
export const REPORT_CHECK_NAME = 'UI Smoke Harness';

// The feature it is grouped under on the Quality page. Sent only on the FIRST
// report — the one that plants the row — because the server refuses to regroup
// a check somebody has since filed elsewhere. This harness is not an HTTP probe
// of one route: it drives a real browser over every screen, so it belongs to
// the app's surface rather than to any of the API groups the seeded suite uses.
export const REPORT_CHECK_FEATURE = 'The rendered app';

// The server caps `error` at 500 characters too, but this harness does not
// rely on that: truncating silently server-side would still leave a caller
// believing it sent the whole string, so this harness caps its own summary
// itself and never depends on the server to finish the job.
const REPORT_ERROR_CAP = 500;

// ---- ~/.stack/env reader --------------------------------------------------
// Same tiny parser scripts/stack-seed-checks.mjs already uses: `KEY=value`
// per line, blanks and `#` comments ignored. Kept local rather than shared so
// this package stays a single self-contained file with its own dependency
// footprint (scripts/playwright is intentionally its own package.json).
function readStackEnv() {
  try {
    const text = readFileSync(join(homedir(), '.stack', 'env'), 'utf8');
    const get = (k) => text.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
    return { STACK_API: get('STACK_API'), STACK_TOKEN: get('STACK_TOKEN') };
  } catch {
    return {};
  }
}

// ---- base URL resolution ---------------------------------------------------
// Order: --url > $STACK_UI_URL > http://localhost:${WEB_PORT:-8787}. 8787 is
// docker-compose.yml's own default web port ("${WEB_PORT:-8787}:80"), and
// WEB_PORT is honoured here for the same reason it's honoured there — a host
// that remapped the compose port needs the fallback to follow it.
function resolveUrl(argUrl) {
  if (argUrl) return argUrl;
  if (process.env.STACK_UI_URL) return process.env.STACK_UI_URL;
  return `http://localhost:${process.env.WEB_PORT || 8787}`;
}

// ---- argv parsing (no dependency) -----------------------------------------
function parseArgs(argv) {
  const flag = (n) => argv.includes(`--${n}`);
  const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  return {
    url: resolveUrl(arg('url')),
    token: arg('token'),
    slug: arg('slug') || 'stack',
    out: arg('out') || join(HERE, 'screenshots'),
    screens: arg('screens') ? arg('screens').split(',').map((s) => s.trim()).filter(Boolean) : null,
    viewport: arg('viewport'),
    timeout: Number(arg('timeout')) || 20000,
    headed: flag('headed'),
    json: flag('json'),
    report: flag('report'),
    noInteractions: flag('no-interactions'),
    help: flag('help'),
  };
}

function printHelp() {
  process.stdout.write(`usage: node scripts/playwright/smoke.mjs [options]

  --url <base>     base URL of the running app
                    (resolution order: --url > $STACK_UI_URL > http://localhost:\${WEB_PORT:-8787})
  --token <t>      bearer token (default: STACK_TOKEN from ~/.stack/env)
  --slug <s>       project slug for the per-project screens (default: stack)
  --out <dir>      screenshot directory (default: scripts/playwright/screenshots)
  --screens <csv>  run only these screen ids
  --viewport <n>   run only this viewport (desktop|narrow)
  --timeout <ms>   per-navigation timeout (default: 20000)
  --headed         run headed instead of headless
  --json           print the report JSON to stdout instead of the table
  --report         POST the outcome to the project's own checks (Quality page,
                    Suite segment) as '${REPORT_CHECK_NAME}' — off by default
  --no-interactions  walk and scan only; do not press any control. The default
                    is to press them, because a screen's first paint is its
                    most-tested state and #401's defects were all behind a
                    control. Use this to isolate whether a finding needs a press.
  --help           print this message

Screens: ${SCREENS.map((s) => s.id).join(', ')}
Viewports: ${Object.keys(VIEWPORTS).join(', ')}
Interactions: ${SCREENS.filter((s) => s.interactions?.length)
    .map((s) => `${s.id} (${s.interactions.length})`).join(', ') || 'none'}

Exits 0 only when zero error or layout findings were reported across every
screen and viewport run. 'info' findings (third-party noise) are always
recorded and printed but never fail the run. See scripts/playwright/README.md
for what each finding kind means and what is deliberately not reported.
`);
}

// ---- element description ---------------------------------------------------
// Rendered in the browser (page.evaluate), kept here only as documentation of
// the contract: { selector, scrollWidth/clientWidth or scrollHeight/clientHeight, rect }.

// ---- report / table rendering ----------------------------------------------
function severityCounts(findings) {
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    layout: findings.filter((f) => f.severity === 'layout').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };
}

// A row is a PASS, not a screen: one screen contributes its first paint plus
// one row per interaction, and the label has to distinguish them or a reader
// cannot tell which press a finding belongs to.
function rowLabel(r) {
  return `${r.id}${r.interaction ? `/${r.interaction}` : ''}@${r.viewport}`;
}

function printTable(report, out) {
  const rows = report.screens;
  const pad = Math.max(...rows.map((r) => rowLabel(r).length), 20);
  process.stdout.write('\nscreen@viewport'.padEnd(0) + '\n');
  for (const r of rows) {
    const { errors, layout, info } = severityCounts(r.findings);
    const ok = errors === 0 && layout === 0;
    process.stdout.write(
      `  ${ok ? '✓' : '✗'} ${rowLabel(r).padEnd(pad)}  `
      + `errors:${String(errors).padStart(2)}  layout:${String(layout).padStart(2)}  info:${String(info).padStart(2)}\n`,
    );
  }

  const withFindings = rows.filter((r) => r.findings.some((f) => f.severity === 'error' || f.severity === 'layout'));
  if (withFindings.length) {
    process.stdout.write('\nfindings:\n');
    for (const r of withFindings) {
      process.stdout.write(`\n  ${rowLabel(r)} (${r.path}):\n`);
      for (const sev of ['error', 'layout']) {
        const findings = r.findings.filter((f) => f.severity === sev);
        if (!findings.length) continue;
        for (const f of findings) {
          const extra = { ...f };
          delete extra.kind; delete extra.severity; delete extra.screen; delete extra.viewport; delete extra.detail;
          const extraStr = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '';
          process.stdout.write(`    [${sev}] ${f.kind}: ${f.detail}${extraStr}\n`);
        }
      }
    }
  }

  // 'info' findings (third-party console/request noise, CLAUDE.md-style
  // "annotate, never hide") are always shown, in a section of their own, so
  // a reader can see exactly what was filtered out of the pass/fail count
  // without it being reported as a defect in Stack's own UI.
  const infoRows = rows.filter((r) => r.findings.some((f) => f.severity === 'info'));
  if (infoRows.length) {
    process.stdout.write('\ninfo — third-party, recorded but does not fail the run:\n');
    for (const r of infoRows) {
      const infoFindings = r.findings.filter((f) => f.severity === 'info');
      process.stdout.write(`\n  ${rowLabel(r)} (${r.path}):\n`);
      for (const f of infoFindings) {
        process.stdout.write(`    [info] ${f.kind}: ${f.detail}\n`);
      }
    }
  }

  const totals = report.totals;
  const s = totals.suppressed || { ellipsis: 0, lineClamp: 0, thirdParty: 0, clippedAncestor: 0, foreignFrame: 0, viewport: 0 };
  const suppressedTotal = s.ellipsis + s.lineClamp + s.thirdParty + s.clippedAncestor + (s.foreignFrame || 0) + (s.viewport || 0);
  const suppressedParts = [];
  if (s.ellipsis) suppressedParts.push(`${s.ellipsis} ellipsis`);
  if (s.lineClamp) suppressedParts.push(`${s.lineClamp} line-clamp`);
  if (s.thirdParty) suppressedParts.push(`${s.thirdParty} third-party`);
  if (s.clippedAncestor) suppressedParts.push(`${s.clippedAncestor} clipped-ancestor`);
  if (s.foreignFrame) suppressedParts.push(`${s.foreignFrame} foreign-frame`);
  if (s.viewport) suppressedParts.push(`${s.viewport} viewport`);
  const suppressedStr = suppressedTotal ? ` (${suppressedTotal} suppressed: ${suppressedParts.join(', ')})` : '';

  process.stdout.write(
    `\n${totals.screens} screen${totals.screens === 1 ? '' : 's'} run `
    + `(${totals.passes} pass${totals.passes === 1 ? '' : 'es'}, `
    + `${totals.interactions} interaction${totals.interactions === 1 ? '' : 's'}), `
    + `${totals.errors} error finding${totals.errors === 1 ? '' : 's'}, `
    + `${totals.layout} layout finding${totals.layout === 1 ? '' : 's'}, `
    + `${totals.info} info finding${totals.info === 1 ? '' : 's'}, `
    + `${totals.screenshots} screenshot${totals.screenshots === 1 ? '' : 's'}${suppressedStr}.\n`,
  );
  process.stdout.write(`screenshots: ${out}\n`);
  process.stdout.write(`report:      ${join(out, 'report.json')}\n`);
}

// ---- element / layout scan --------------------------------------------------
// Runs once per screen inside the page. Returns raw finding fragments (kind +
// detail fields); severity/screen/viewport are stamped on afterwards.
/* eslint-disable no-undef */
function scanLayout() {
  function isRendered(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (Number(cs.opacity) === 0) return false;
    return true;
  }

  function selectorPath(el) {
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 4) {
      const tag = node.tagName.toLowerCase();
      const id = node.id ? `#${node.id}` : '';
      const classes = (node.classList ? Array.from(node.classList).slice(0, 2) : [])
        .map((c) => `.${c}`).join('');
      parts.unshift(`${tag}${id}${classes}`);
      node = node.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  // WHY THIS EXISTS (#291 follow-up): a first full run produced 149 layout
  // findings, and the overwhelming majority were never bugs — they were the
  // app disclosing that content is cut off, or a canvas doing exactly what
  // it is designed to do. A harness that cries wolf that often teaches its
  // reader to stop reading it, which defeats the whole point (CLAUDE.md,
  // "a capped list must say it is capped" — the same rule applies to any
  // filter: never slice silently, always say what and how much).
  //
  //   - element-overflow-x: `text-overflow: ellipsis` REQUIRES
  //     `overflow: hidden`, so `scrollWidth > clientWidth` is the normal,
  //     PERMANENT state of every deliberately-truncated label in the app —
  //     the ellipsis IS the disclosure that something is cut off, which is
  //     the opposite of the bug this finding exists to catch (content cut
  //     off with no visual hint at all).
  //   - element-overflow-y: `-webkit-line-clamp` is the vertical equivalent
  //     of the same thing — a deliberate multi-line clamp, not a pane
  //     silently too short for its content.
  //   - element-past-viewport: an element only pushes the DOCUMENT wider
  //     than the window (what `page-overflow-x` reports as a symptom) if
  //     nothing between it and the page clips or scrolls it first. A canvas
  //     wider than the window that its own container clips with
  //     `overflow: hidden` never causes the page itself to scroll and is not
  //     a bug. (The Workbench's 2400px ground was the case this was written
  //     against, and went with the Workbench cull.)
  //   - either overflow axis on a VIEWPORT: an element windowing a coordinate
  //     space larger than itself is doing its job, not running out of room.
  //     The Roadmap board is the horizontal case — `.rp-cols` scrolls its own
  //     columns sideways BY DESIGN, which is what a board of lists is, and the
  //     page itself never scrolls with it. (The Timeline was the case this rule
  //     was first written against, and it is culled.) Adding interactions that
  //     move between boards made this the single
  //     loudest finding in the run (12 at first paint, 49 once pressed), all
  //     of it structural noise. Same reasoning as the ellipsis rule: the app
  //     shows the cut, so it is not the silent cut this finding hunts.
  //     THE VERTICAL HALF (#423) was proven on the Workbench ground: it held
  //     an absolutely-positioned field panned under it, was 3× its own height
  //     in content by design, and offered a minimap that said so. (The Polaris
  //     stage was the second such surface. Both are culled now; the rule is
  //     kept general because the shape, not the screen, is what it is about.) What it must NOT swallow is a pane whose FLOW content is too
  //     tall for it — which is why the test disqualifies an element with any
  //     in-flow child that spills, and why the Futures scrub's clipped drag
  //     handle was still reported and then fixed in styles.css rather than
  //     filtered away here.
  //
  // Every one of these is COUNTED, never dropped silently: `suppressed`
  // below is folded into the screen's report and the run's printed summary,
  // so a reader can always see how much was filtered and why.
  const results = {
    pageOverflowX: null, elementOverflowX: [], elementOverflowY: [], elementPastViewport: [],
    suppressed: { ellipsis: 0, lineClamp: 0, clippedAncestor: 0, foreignFrame: 0, viewport: 0 },
  };

  const docWidth = document.documentElement.scrollWidth;
  const winWidth = window.innerWidth;
  if (docWidth > winWidth + 1) {
    results.pageOverflowX = { scrollWidth: docWidth, innerWidth: winWidth };
  }

  const all = Array.from(document.querySelectorAll('*'));
  const reportedX = []; // elements already reported for overflow-x (ancestor dedupe)
  const reportedY = [];
  const reportedPast = [];

  const hasReportedAncestor = (el, list) => list.some((r) => r !== el && r.contains(el));

  // An element that holds NOTHING but cross-origin iframes is measuring someone
  // else's document, at that document's own intrinsic size. The dashboard's
  // project cards are exactly this: `span.preview` clips a live iframe of each
  // deployed site, à la Vercel, so scrollWidth 1043 > clientWidth 261 is the
  // whole point of the card and cannot be "fixed" from inside this app. Same
  // family as BUG-7 — a stranger's page reported as this one's defect — and
  // deliberately the tightest form of the rule: one non-frame child, or one
  // same-origin frame, and it is Stack's layout again and gets reported.
  const onlyForeignFrames = (el) => {
    const kids = Array.from(el.children);
    if (!kids.length) return false;
    return kids.every((k) => {
      if (k.tagName !== 'IFRAME') return false;
      try { return new URL(k.src, location.href).origin !== location.origin; } catch { return false; }
    });
  };

  // Is this element WINDOWING a larger coordinate space, rather than being a
  // box its content outgrew? Absolute positioning is the signature, and the
  // test is deliberately two-sided: at least one child positioned into the
  // space (so an ordinary empty clipper does not qualify), and NO child left in
  // normal flow that actually spills. That second half is what keeps the rule
  // honest — a real "content ran out of room" bug is a flow child pushing past
  // the edge, and one of those anywhere disqualifies the element no matter how
  // many absolute siblings it has.
  //
  // ONE FUNCTION, BOTH AXES (#423). It was horizontal-only while the Timeline
  // was the only surface it had been checked against; the vertical case was
  // proven on the Workbench ground (an `inset: 0` field under a 2400×1800 wire
  // canvas, panned and zoomed by a transform). BOTH OF THOSE SURFACES ARE NOW
  // CULLED — the Workbench with its canvas, the Timeline with #428 — so this
  // rule currently has no live example, and saying so is the point: it is not
  // dead code but an unexercised guard, and the next surface that windows a
  // coordinate space larger than itself inherits it already parameterised. Two
  // spellings of
  // this test would be the drift the rest of this file's rules exist to
  // prevent, so the axis is a parameter.
  const isViewport = (el, axis = 'x') => {
    const kids = Array.from(el.children);
    if (!kids.length) return false;
    const far = axis === 'y' ? 'bottom' : 'right';
    const edge = el.getBoundingClientRect()[far];
    let positioned = 0;
    for (const k of kids) {
      const pos = getComputedStyle(k).position;
      if (pos === 'absolute' || pos === 'fixed') positioned++;
      else if (k.getBoundingClientRect()[far] > edge + 1) return false;
    }
    return positioned > 0;
  };

  const CLIPPING_OVERFLOW = ['hidden', 'clip', 'auto', 'scroll'];
  const hasClippingAncestor = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      if (CLIPPING_OVERFLOW.includes(getComputedStyle(node).overflowX)) return true;
      node = node.parentElement;
    }
    return false;
  };

  for (const el of all) {
    if (el === document.documentElement || el === document.body) continue;
    if (!isRendered(el)) continue;
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();

    if ((cs.overflowX === 'hidden' || cs.overflowX === 'clip') && el.scrollWidth > el.clientWidth + 1) {
      if (cs.textOverflow === 'ellipsis') {
        results.suppressed.ellipsis++;
      } else if (onlyForeignFrames(el)) {
        results.suppressed.foreignFrame++;
      } else if (isViewport(el, 'x')) {
        results.suppressed.viewport++;
      } else if (!hasReportedAncestor(el, reportedX)) {
        reportedX.push(el);
        results.elementOverflowX.push({
          selector: selectorPath(el),
          scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        });
      }
    }

    if ((cs.overflowY === 'hidden' || cs.overflowY === 'clip') && el.scrollHeight > el.clientHeight + 1) {
      const clamp = cs.getPropertyValue('-webkit-line-clamp');
      const clamped = clamp && clamp !== 'none' && !Number.isNaN(Number(clamp));
      if (clamped) {
        results.suppressed.lineClamp++;
      } else if (onlyForeignFrames(el)) {
        results.suppressed.foreignFrame++;
      } else if (isViewport(el, 'y')) {
        results.suppressed.viewport++;
      } else if (!hasReportedAncestor(el, reportedY)) {
        reportedY.push(el);
        results.elementOverflowY.push({
          selector: selectorPath(el),
          scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        });
      }
    }

    if (rect.right > winWidth + 1) {
      if (hasClippingAncestor(el)) {
        results.suppressed.clippedAncestor++;
      } else if (!hasReportedAncestor(el, reportedPast)) {
        reportedPast.push(el);
        results.elementPastViewport.push({
          selector: selectorPath(el),
          right: Math.round(rect.right), innerWidth: winWidth,
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        });
      }
    }
  }

  return results;
}
/* eslint-enable no-undef */

function capList(list, kind, screen, viewport) {
  const total = list.length;
  const shown = list.slice(0, CAP_PER_KIND);
  const findings = shown.map((item) => ({
    kind, severity: 'layout', screen, viewport,
    detail: describeLayoutFinding(kind, item),
    ...item,
  }));
  if (total > CAP_PER_KIND) {
    findings.push({
      kind, severity: 'layout', screen, viewport,
      detail: `${kind} capped at ${CAP_PER_KIND} of ${total} total — the true count is higher than shown above.`,
      capped: true, shown: CAP_PER_KIND, total,
    });
  }
  return findings;
}

function describeLayoutFinding(kind, item) {
  switch (kind) {
    case 'element-overflow-x':
      return `${item.selector} clips overflow-x but scrollWidth ${item.scrollWidth} > clientWidth ${item.clientWidth}`;
    case 'element-overflow-y':
      return `${item.selector} clips overflow-y but scrollHeight ${item.scrollHeight} > clientHeight ${item.clientHeight}`;
    case 'element-past-viewport':
      return `${item.selector} right edge ${item.right} exceeds viewport width ${item.innerWidth}`;
    default:
      return kind;
  }
}

// ---- one pass ---------------------------------------------------------------
// The layout scan, its capped findings and a screenshot, over whatever is on
// screen RIGHT NOW. Shared by the base pass and by every interaction, so a
// pressed screen is measured with exactly the same yardstick as a first paint —
// a second, drifting copy of this is how those two would start disagreeing.
async function scanAndShoot(page, { screenId, viewportName, sink, shotPath }) {
  let layout = {
    pageOverflowX: null, elementOverflowX: [], elementOverflowY: [], elementPastViewport: [],
    suppressed: { ellipsis: 0, lineClamp: 0, clippedAncestor: 0, foreignFrame: 0, viewport: 0 },
  };
  try {
    layout = await page.evaluate(scanLayout);
  } catch (e) {
    sink.findings.push({
      kind: 'page-error', severity: 'error', screen: screenId, viewport: viewportName,
      detail: `layout scan failed: ${e.message}`.slice(0, 300),
    });
  }

  if (layout.pageOverflowX) {
    sink.findings.push({
      kind: 'page-overflow-x', severity: 'layout', screen: screenId, viewport: viewportName,
      detail: `document scrollWidth ${layout.pageOverflowX.scrollWidth} > window innerWidth ${layout.pageOverflowX.innerWidth}`,
      ...layout.pageOverflowX,
    });
  }
  sink.findings.push(...capList(layout.elementOverflowX, 'element-overflow-x', screenId, viewportName));
  sink.findings.push(...capList(layout.elementOverflowY, 'element-overflow-y', screenId, viewportName));
  sink.findings.push(...capList(layout.elementPastViewport, 'element-past-viewport', screenId, viewportName));

  try {
    // VIEWPORT-CLIPPED, never fullPage: a full-page shot grows the viewport to
    // fit the content, which hides the exact overflow bug this harness exists
    // to catch. A human never scrolls to see the problem — they see the clipped
    // viewport, so that's what this shoots.
    await page.screenshot({ path: shotPath, fullPage: false });
  } catch (e) {
    sink.findings.push({
      kind: 'page-error', severity: 'error', screen: screenId, viewport: viewportName,
      detail: `screenshot failed: ${e.message}`.slice(0, 300),
    });
  }

  return layout;
}

// A control is given its own short deadline rather than --timeout's. That flag
// budgets a NAVIGATION — a page load, a round trip, a render. A control that is
// already on screen either responds in a moment or is broken, and inheriting a
// 20s navigation budget would turn each missing control into a 20s stall,
// making a fully-broken screen the slowest possible run.
const CONTROL_TIMEOUT_MS = 4000;

// Press one control and decide whether the press LANDED. Returns true only when
// it did; every other road out files an `error` finding and returns false, so a
// control this harness could not work is never mistaken for one that works
// (the fail-loud rule in the header).
async function runInteraction(page, { screenId, viewportName, interaction, sink }) {
  const fail = (kind, detail) => {
    sink.findings.push({
      kind, severity: 'error', screen: screenId, viewport: viewportName,
      interaction: interaction.id, detail: String(detail).slice(0, 300),
    });
    return false;
  };

  const control = page.locator(interaction.click).first();
  try {
    await control.waitFor({ state: 'visible', timeout: CONTROL_TIMEOUT_MS });
  } catch {
    return fail('control-missing',
      `${interaction.label}: no visible control matched \`${interaction.click}\` — it moved, was renamed, `
      + 'or the screen never rendered it. Nothing about this control was tested.');
  }

  // Read the "before" side BEFORE the press, or there is nothing to compare to.
  const textProbe = interaction.expectTextChangeIn
    ? page.locator(interaction.expectTextChangeIn).first()
    : null;
  const before = textProbe ? await textProbe.textContent().catch(() => null) : null;

  try {
    await control.click({ timeout: CONTROL_TIMEOUT_MS });
  } catch (e) {
    return fail('control-inert', `${interaction.label}: \`${interaction.click}\` could not be clicked — ${e.message}`);
  }

  await page.waitForTimeout(SETTLE_MS);

  if (interaction.expect) {
    try {
      await page.locator(interaction.expect).first().waitFor({ state: 'visible', timeout: CONTROL_TIMEOUT_MS });
    } catch {
      return fail('control-inert',
        `${interaction.label}: pressed \`${interaction.click}\`, but \`${interaction.expect}\` never appeared — `
        + 'the press did not take effect.');
    }
  }

  if (textProbe) {
    const after = await textProbe.textContent().catch(() => null);
    if (after === null) {
      return fail('control-inert',
        `${interaction.label}: \`${interaction.expectTextChangeIn}\` is gone after the press, so the press cannot be judged.`);
    }
    if (after === before) {
      return fail('control-inert',
        `${interaction.label}: pressed \`${interaction.click}\`, but \`${interaction.expectTextChangeIn}\` still reads `
        + `"${String(after).trim()}" — the press changed nothing.`);
    }
  }

  return true;
}

// ---- third-party attribution -----------------------------------------------
// WHY THIS EXISTS: a first full run reported 18 error findings, and most of
// them were about the Cloudflare RUM analytics beacon and about OTHER
// projects' sites — the dashboard renders live previews of other projects'
// cards, so a console error or failed request can originate from a page
// this harness never navigated to on purpose. Attributing that to Stack is
// the same mistake the preflight already guards the whole run against
// (README "Preflight"): reporting a stranger's problem as this app's own.
// `page-error` is reclassified too, but only ever by its stack — see
// foreignStackOrigin below, and BUG-7, which is what that rule is for.
// `auth-rejected` is untouched for a reason that does hold: it is judged by path
// (`/api/`), not by message content, so there is nothing to misattribute.
function originOf(candidateUrl) {
  try { return new URL(candidateUrl).origin; } catch { return null; }
}

// Conservative on purpose: only reclassifies when a URL can be extracted,
// parsed, AND its origin differs from the base. Any ambiguity leaves the
// finding as a normal error — CLAUDE.md's own rule for this feature: "a
// false 'this is someone else's problem' is worse than a noisy true one,
// because it hides a real defect".
function foreignOriginIn(text, baseOrigin) {
  const matches = text.match(/https?:\/\/[^\s'"()]+/g);
  if (!matches) return null;
  for (const raw of matches) {
    const origin = originOf(raw.replace(/[.,;:]+$/, ''));
    if (origin && origin !== baseOrigin) return origin;
  }
  return null;
}

// A page error is attributed by its STACK, and by nothing else (BUG-7).
//
// The rule above this one used to exempt page-error entirely, reasoning that an
// uncaught exception fires through window.onerror inside Stack's own page even
// when a third party threw it. That is true of a third-party SCRIPT on the
// page. It is not true of a cross-origin IFRAME, which is a separate document
// with its own window — and the dashboard renders one per project card, a live
// preview of each deployed site. Playwright reports an exception from any frame
// of the page as the page's own, so a stranger's site crashing in a 261px-wide
// card was filed against Stack at medium severity. Proved by running the
// dashboard twice: with the preview iframes refused, the page throws nothing.
//
// The MESSAGE is not evidence and is never read here: "Minified React error
// #418" carries a react.dev URL in its own text, so a genuine Stack error would
// attribute itself to react.dev. Only frames — `at fn (https://host/file:1:2)`
// — say where code was actually running. If any frame is same-origin the
// finding stays Stack's; if none can be parsed it stays Stack's too, which is
// the same conservative direction as everything else in this section.
function foreignStackOrigin(stack, baseOrigin) {
  const origins = [];
  for (const m of String(stack || '').matchAll(/\bat\s[^\n]*?(https?:\/\/[^\s)]+)/g)) {
    const origin = originOf(m[1].replace(/[.,;:]+$/, ''));
    if (origin) origins.push(origin);
  }
  if (!origins.length || origins.includes(baseOrigin)) return null;
  return origins[0];
}

// ---- preflight --------------------------------------------------------------
// WHY THIS EXISTS: a port answering is not the same as the right app
// answering. This harness's whole purpose is letting a session see its OWN
// rendering — every other host process on the machine is noise it must never
// mistake for Stack. The incident that forced this: the default base URL was
// a port that, on one host, belonged to a completely unrelated app. The
// harness happily walked its screens and reported 154 real, entirely
// worthless layout findings about a stranger's UI, with nothing in the
// output to say so. `GET /api/health` distinguishes them: Stack's own route
// (server/src/index.js) answers `{ ok, version, uptime }`; checking `ok`
// alone is exactly what let the impostor pass, because plenty of unrelated
// services answer `{ ok: true, ... }` on their own health route too. This
// runs once, before any browser is launched, and aborts the whole run on
// anything but an unambiguous match.
async function preflight(url, token, timeoutMs) {
  let res;
  try {
    res = await fetch(`${url}/api/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return {
      ok: false,
      reason: `${url} is not reachable: ${e.message}. Bring the app up, or pass --url.`,
    };
  }

  if (res.status !== 200) {
    return {
      ok: false,
      reason: `${url} answered, but /api/health returned HTTP ${res.status}, not 200. `
        + `Point --url at Stack (the compose default is http://localhost:8787).`,
    };
  }

  let body;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {
    return {
      ok: false,
      reason: `${url} answered, but /api/health did not return JSON. `
        + `Point --url at Stack (the compose default is http://localhost:8787).`,
    };
  }

  if (body.ok !== true || typeof body.version === 'undefined') {
    return {
      ok: false,
      reason: `${url} answered, but it is not Stack: /api/health returned ${JSON.stringify(body)} `
        + `with no \`version\` field. Point --url at Stack (the compose default is http://localhost:8787).`,
    };
  }

  return { ok: true, version: body.version };
}

// ---- external report -------------------------------------------------------
// #291 — POST the outcome of THIS run to the project's own checks, so a smoke
// run lands on the Quality page instead of only in a terminal nobody re-reads.
// Picks the single worst finding for the one-line `error` summary: an error
// finding outranks a layout one (a broken screen is worse than a clipped
// pane), and within a severity the first one encountered stands in for the
// rest — this is a compact pointer for a human to open the full report.json
// or the screenshots, not a replacement for either.
function summariseFailure(screenReports, viewportNames) {
  const uniqueScreens = new Set(screenReports.map((r) => r.id)).size;
  const allFindings = screenReports.flatMap((r) => r.findings);
  const errors = allFindings.filter((f) => f.severity === 'error').length;
  const layout = allFindings.filter((f) => f.severity === 'layout').length;
  const worst = allFindings.find((f) => f.severity === 'error') || allFindings[0];
  // The interaction rides in the one-line summary too: "a layout finding on the
  // roadmap" and "a layout finding on the roadmap once zoomed to Hour" send a
  // reader to different places, and this line is all the Quality page shows.
  const worstWhere = worst ? `${worst.screen}${worst.interaction ? `/${worst.interaction}` : ''}@${worst.viewport}` : '';
  const worstStr = worst ? ` — worst: ${worst.kind} on ${worstWhere}: ${worst.detail}` : '';
  const summary = `${errors} errors, ${layout} layout findings over ${uniqueScreens} screen${uniqueScreens === 1 ? '' : 's'} `
    + `/ ${viewportNames.length} viewport${viewportNames.length === 1 ? '' : 's'}${worstStr}`;
  return summary.slice(0, REPORT_ERROR_CAP);
}

// Target is the SAME base URL this run just smoked (never a separately
// configured API host, and never a flag of its own): the preflight has
// already proved that base is Stack, and a run against a preview instance
// must land on that preview's own Quality page, not on production's. One
// less thing that can be pointed at the wrong place — which is exactly the
// mistake the preflight exists to catch in the first place. Same reasoning
// for the token: the same bearer this run used to smoke the app, never a
// second credential.
//
// FAILURE HANDLING: a failed report warns loudly but never changes the exit
// code. The exit code answers "is the UI sound?" — a flaky API is not a UI
// finding, and letting a failed recording turn a clean run red would teach a
// reader to distrust the one signal this harness exists to give. It is never
// swallowed either: a report that silently did not land is a Quality page
// quietly showing yesterday's result as if it were today's, so this always
// prints and always records what happened in report.json's `reported` field.
async function reportOutcome({ url, token, slug, totals, durationMs, screenReports, viewportNames, timeoutMs }) {
  const pass = (totals.errors + totals.layout) === 0;
  const body = {
    name: REPORT_CHECK_NAME,
    feature: REPORT_CHECK_FEATURE,
    status: pass ? 'pass' : 'fail',
    ms: durationMs,
    url,
    error: pass ? null : summariseFailure(screenReports, viewportNames),
  };

  let res;
  try {
    res = await fetch(`${url}/api/projects/${slug}/checks/report`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const reason = `unreachable: ${e.message}`;
    process.stderr.write(`\nWARNING: failed to report the smoke result to Stack — ${reason}\n`);
    return { ok: false, reason };
  }

  if (res.status < 200 || res.status >= 300) {
    const text = await res.text().catch(() => '');
    const reason = `HTTP ${res.status} — ${text.slice(0, 300)}`;
    process.stderr.write(`\nWARNING: failed to report the smoke result to Stack — ${reason}\n`);
    return { ok: false, reason };
  }

  process.stdout.write(`\nreported to ${slug}'s Quality page: ${body.status.toUpperCase()} (${REPORT_CHECK_NAME})\n`);
  return { ok: true, name: REPORT_CHECK_NAME, status: body.status };
}

// ---- main -------------------------------------------------------------------
export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) { printHelp(); return 0; }

  if (opts.viewport && !VIEWPORTS[opts.viewport]) {
    process.stderr.write(`unknown viewport "${opts.viewport}" — choose one of: ${Object.keys(VIEWPORTS).join(', ')}\n`);
    return 1;
  }
  const viewportNames = opts.viewport ? [opts.viewport] : Object.keys(VIEWPORTS);

  const wantScreens = opts.screens
    ? SCREENS.filter((s) => opts.screens.includes(s.id))
    : SCREENS;
  if (opts.screens && !wantScreens.length) {
    process.stderr.write(`none of the requested screens matched: ${opts.screens.join(', ')}\n`);
    return 1;
  }

  const token = opts.token || readStackEnv().STACK_TOKEN;
  if (!token) {
    process.stderr.write('no bearer token — pass --token or set STACK_TOKEN in ~/.stack/env.\n');
    return 1;
  }

  const url = opts.url.replace(/\/$/, '');
  const baseOrigin = originOf(url);

  const check = await preflight(url, token, opts.timeout);
  if (!check.ok) {
    process.stderr.write(`${check.reason}\n`);
    return 1;
  }

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    process.stderr.write(
      'playwright dependencies not installed — run scripts/run-ui-smoke.sh, which installs them.\n',
    );
    return 1;
  }

  mkdirSync(opts.out, { recursive: true });

  const startedAt = Date.now();
  const screenReports = [];
  let fatal = null;

  let browser;
  try {
    // --no-sandbox: chromium's sandbox needs either root-owned setuid helpers
    // or user namespaces, neither of which an unattended session on this
    // host has. This is a local harness pointed at the owner's own app, not
    // a browser opening untrusted pages, so the sandbox is not protecting
    // against anything this run is exposed to.
    // --disable-dev-shm-usage: a small /dev/shm otherwise crashes the
    // renderer mid-run.
    browser = await chromium.launch({ headless: !opts.headed, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  } catch (e) {
    process.stderr.write(
      `chromium failed to launch: ${e.message}\n`
      + 'if this is missing shared libraries, run scripts/run-ui-smoke.sh (it provisions them '
      + 'via scripts/playwright/setup-browser-deps.sh) instead of invoking smoke.mjs directly.\n',
    );
    return 1;
  }

  try {
    for (const viewportName of viewportNames) {
      const viewport = VIEWPORTS[viewportName];
      let ctx;
      let page;
      try {
        ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
        await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } }, ['stack.token', token]);
        page = await ctx.newPage();
      } catch (e) {
        fatal = `could not open a browser context for viewport ${viewportName}: ${e.message}`;
        break;
      }

      for (const screen of wantScreens) {
        const path = screen.path.replace('<slug>', opts.slug);

        // The listeners below fire for whichever PASS is running: the screen's
        // first paint, then each interaction in turn. `sink` is what they push
        // into and it is re-pointed as each pass starts, so a console error
        // raised BY a zoom press is filed against that press rather than
        // against the paint that happened to come before it.
        // `thirdParty` is the per-pass tally folded into `suppressed` — those
        // findings are NOT dropped (they still land as `info`), this just
        // counts how many were kept out of the error tally.
        let sink = { findings: [], thirdParty: 0 };

        const onConsole = (msg) => {
          if (msg.type() === 'error') {
            const text = msg.text();
            // The text first, then where the console message was RAISED. The
            // browser's own "Failed to load resource: … 404" carries no URL in
            // its text at all, so text alone attributed a framed site's missing
            // avatar.jpg to Stack — the same misattribution as BUG-7, reaching
            // the finding by a different road. location() names it exactly.
            const at = msg.location()?.url;
            const foreign = foreignOriginIn(text, baseOrigin)
              || (at && originOf(at) && originOf(at) !== baseOrigin ? originOf(at) : null);
            if (foreign) {
              sink.thirdParty++;
              sink.findings.push({
                kind: 'third-party-console', severity: 'info', screen: screen.id, viewport: viewportName,
                detail: text.slice(0, 300), origin: foreign,
              });
            } else {
              sink.findings.push({
                kind: 'console-error', severity: 'error', screen: screen.id, viewport: viewportName,
                detail: text.slice(0, 300),
              });
            }
          }
        };
        const onPageError = (err) => {
          const detail = String(err && err.message ? err.message : err).slice(0, 300);
          const foreign = foreignStackOrigin(err && err.stack, baseOrigin);
          if (foreign) {
            sink.thirdParty++;
            sink.findings.push({
              kind: 'third-party-page-error', severity: 'info', screen: screen.id, viewport: viewportName,
              detail, origin: foreign,
            });
          } else {
            sink.findings.push({
              kind: 'page-error', severity: 'error', screen: screen.id, viewport: viewportName, detail,
            });
          }
        };
        const onRequestFailed = (req) => {
          const reqUrl = req.url();
          if (IGNORED_REQUEST_PATTERNS.some((p) => p.test ? p.test(reqUrl) : reqUrl.includes(p))) return;
          const origin = originOf(reqUrl);
          if (origin && origin !== baseOrigin) {
            sink.thirdParty++;
            sink.findings.push({
              kind: 'third-party-request', severity: 'info', screen: screen.id, viewport: viewportName,
              detail: `${reqUrl} — ${req.failure()?.errorText || 'unknown failure'}`,
              url: reqUrl,
            });
          } else {
            sink.findings.push({
              kind: 'request-failed', severity: 'error', screen: screen.id, viewport: viewportName,
              detail: `${reqUrl} — ${req.failure()?.errorText || 'unknown failure'}`,
              url: reqUrl,
            });
          }
        };
        const onResponse = (res) => {
          const resUrl = res.url();
          const status = res.status();
          if (status >= 500) {
            const origin = originOf(resUrl);
            if (origin && origin !== baseOrigin) {
              sink.thirdParty++;
              sink.findings.push({
                kind: 'third-party-request', severity: 'info', screen: screen.id, viewport: viewportName,
                detail: `${resUrl} → ${status}`, url: resUrl, status,
              });
            } else {
              sink.findings.push({
                kind: 'http-error', severity: 'error', screen: screen.id, viewport: viewportName,
                detail: `${resUrl} → ${status}`, url: resUrl, status,
              });
            }
          }
          if (resUrl.includes('/api/') && status === 401) {
            sink.findings.push({
              kind: 'auth-rejected', severity: 'error', screen: screen.id, viewport: viewportName,
              detail: `${resUrl} → 401 — the app was tested SIGNED OUT; every layout result for this screen is worthless.`,
              url: resUrl,
            });
          }
        };

        page.on('console', onConsole);
        page.on('pageerror', onPageError);
        page.on('requestfailed', onRequestFailed);
        page.on('response', onResponse);

        let navigated = true;
        try {
          await page.goto(`${url}/${path}`, { waitUntil: 'load', timeout: opts.timeout });
          await page.waitForLoadState('networkidle', { timeout: opts.timeout }).catch(() => {});
          await page.waitForTimeout(SETTLE_MS);
        } catch (e) {
          navigated = false;
          sink.findings.push({
            kind: 'navigation-failed', severity: 'error', screen: screen.id, viewport: viewportName,
            detail: e.message.slice(0, 300),
          });
        }

        // Closes off the pass that `sink` is currently collecting and files it
        // as its own row. "It is capped and says so" (CLAUDE.md) applied to
        // suppression: a reader must be able to see that filtering happened and
        // how much, for every pass, every run — never a silent slice.
        const closePass = (layout, screenshotPath, interaction) => {
          screenReports.push({
            id: screen.id,
            label: interaction ? `${screen.label} · ${interaction.label}` : screen.label,
            path, viewport: viewportName,
            ...(interaction ? { interaction: interaction.id } : {}),
            screenshot: screenshotPath,
            findings: sink.findings,
            suppressed: {
              ellipsis: layout.suppressed?.ellipsis || 0,
              lineClamp: layout.suppressed?.lineClamp || 0,
              thirdParty: sink.thirdParty,
              clippedAncestor: layout.suppressed?.clippedAncestor || 0,
              foreignFrame: layout.suppressed?.foreignFrame || 0,
              viewport: layout.suppressed?.viewport || 0,
            },
          });
        };

        const baseShot = join(opts.out, `${screen.id}@${viewportName}.png`);
        const baseLayout = await scanAndShoot(page, {
          screenId: screen.id, viewportName, sink, shotPath: baseShot,
        });
        closePass(baseLayout, baseShot, null);

        // Each interaction is a pass of its own: press, then measure with the
        // same yardstick. They run in SEQUENCE on the one page and deliberately
        // do not reset it between presses — the zoom stops are ordered
        // coarsest-first so each is a real change from the last, and a control
        // that only misbehaves once you have already moved the view is exactly
        // the kind of defect walking a screen cannot reach.
        //
        // A failed press still closes a pass. What it must never do is skip
        // silently, and it must not let the NEXT press inherit a view it never
        // established, so the rest of the screen's interactions are abandoned
        // and each says so — a wrong reading is worse than an absent one.
        const interactions = opts.noInteractions ? [] : (screen.interactions || []);
        if (navigated && interactions.length) {
          let broken = null;
          for (const interaction of interactions) {
            sink = { findings: [], thirdParty: 0 };
            const shot = join(opts.out, `${screen.id}--${interaction.id}@${viewportName}.png`);

            if (broken) {
              sink.findings.push({
                kind: 'interaction-abandoned', severity: 'error', screen: screen.id, viewport: viewportName,
                interaction: interaction.id,
                detail: `${interaction.label}: not attempted — "${broken}" failed earlier on this screen, so the view `
                  + 'it needed was never established. Nothing about this control was tested.',
              });
              closePass({ suppressed: {} }, null, interaction);
              continue;
            }

            const landed = await runInteraction(page, {
              screenId: screen.id, viewportName, interaction, sink,
            });
            if (!landed) broken = interaction.label;

            const layout = await scanAndShoot(page, {
              screenId: screen.id, viewportName, sink, shotPath: shot,
            });
            closePass(layout, shot, interaction);
          }
        }

        page.off('console', onConsole);
        page.off('pageerror', onPageError);
        page.off('requestfailed', onRequestFailed);
        page.off('response', onResponse);
      }

      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  const durationMs = Date.now() - startedAt;
  const totals = {
    // A PASS is a row (a first paint, or one interaction); a SCREEN is a route.
    // Counting passes as screens would report a run that pressed seven controls
    // on one screen as having covered seven screens.
    screens: new Set(screenReports.map((r) => `${r.id}@${r.viewport}`)).size,
    passes: screenReports.length,
    interactions: screenReports.filter((r) => r.interaction).length,
    errors: screenReports.reduce((n, r) => n + r.findings.filter((f) => f.severity === 'error').length, 0),
    layout: screenReports.reduce((n, r) => n + r.findings.filter((f) => f.severity === 'layout').length, 0),
    // 'info' findings (third-party console/request noise) are recorded and
    // printed but never drive the exit code — see the exit-code line below,
    // which is deliberately errors+layout only.
    info: screenReports.reduce((n, r) => n + r.findings.filter((f) => f.severity === 'info').length, 0),
    suppressed: {
      ellipsis: screenReports.reduce((n, r) => n + (r.suppressed?.ellipsis || 0), 0),
      lineClamp: screenReports.reduce((n, r) => n + (r.suppressed?.lineClamp || 0), 0),
      thirdParty: screenReports.reduce((n, r) => n + (r.suppressed?.thirdParty || 0), 0),
      clippedAncestor: screenReports.reduce((n, r) => n + (r.suppressed?.clippedAncestor || 0), 0),
      foreignFrame: screenReports.reduce((n, r) => n + (r.suppressed?.foreignFrame || 0), 0),
      viewport: screenReports.reduce((n, r) => n + (r.suppressed?.viewport || 0), 0),
    },
    screenshots: screenReports.filter((r) => r.screenshot).length,
  };

  const report = {
    generatedAt: new Date().toISOString(),
    url, slug: opts.slug, durationMs,
    preflight: { url, ok: check.ok, version: check.version },
    viewports: viewportNames,
    screens: screenReports,
    totals,
  };

  if (opts.report) {
    report.reported = await reportOutcome({
      url, token, slug: opts.slug, totals, durationMs, screenReports, viewportNames, timeoutMs: opts.timeout,
    });
  }

  writeFileSync(join(opts.out, 'report.json'), JSON.stringify(report, null, 2));

  if (fatal) {
    process.stderr.write(`${fatal}\n`);
    return 1;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    printTable(report, opts.out);
  }

  return (totals.errors + totals.layout) > 0 ? 1 : 0;
}

// Direct run (node scripts/playwright/smoke.mjs) as well as via run-ui-smoke.sh.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code ?? 0)).catch((e) => {
    process.stderr.write(`ui-smoke failed: ${e.message}\n`);
    process.exit(1);
  });
}
