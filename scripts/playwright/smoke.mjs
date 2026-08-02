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
//   node scripts/playwright/smoke.mjs [options]
//   scripts/run-ui-smoke.sh [options]     (installs deps first if missing)
//
// Options: --url --token --slug --out --screens --viewport --timeout
//          --headed --json --help          (see --help for details)

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- the screens ---------------------------------------------------------
// One entry per top-level route this harness walks. `<slug>` is substituted
// for the --slug value at run time. Order matches the app's own nav order.
export const SCREENS = [
  { id: 'dashboard', label: 'Dashboard', path: '#/' },
  { id: 'control-now', label: 'Control — Now', path: '#/control' },
  { id: 'control-review', label: 'Control — Review', path: '#/control/review' },
  { id: 'control-roles', label: 'Control — Roles', path: '#/control/roles' },
  { id: 'terminal', label: 'Terminal', path: '#/terminal' },
  { id: 'skills', label: 'Skills', path: '#/skills' },
  { id: 'timeline', label: 'Timeline', path: '#/timeline' },
  { id: 'settings', label: 'Settings', path: '#/settings' },
  { id: 'project-overview', label: 'Project — Overview', path: '#/p/<slug>' },
  { id: 'project-quality', label: 'Project — Quality', path: '#/p/<slug>/quality' },
  { id: 'project-roadmap', label: 'Project — Roadmap', path: '#/p/<slug>/roadmap' },
  { id: 'project-futures', label: 'Project — Futures', path: '#/p/<slug>/futures' },
  { id: 'project-workbench', label: 'Project — Workbench', path: '#/p/<slug>/workbench' },
  { id: 'project-activity', label: 'Project — Activity', path: '#/p/<slug>/activity' },
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
  --help           print this message

Screens: ${SCREENS.map((s) => s.id).join(', ')}
Viewports: ${Object.keys(VIEWPORTS).join(', ')}

Exits 0 only when zero findings were reported across every screen and
viewport run. See scripts/playwright/README.md for what each finding kind
means.
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
  };
}

function printTable(report, out) {
  const rows = report.screens;
  const pad = Math.max(...rows.map((r) => `${r.id}@${r.viewport}`.length), 20);
  process.stdout.write('\nscreen@viewport'.padEnd(0) + '\n');
  for (const r of rows) {
    const { errors, layout } = severityCounts(r.findings);
    const ok = errors === 0 && layout === 0;
    process.stdout.write(
      `  ${ok ? '✓' : '✗'} ${`${r.id}@${r.viewport}`.padEnd(pad)}  `
      + `errors:${String(errors).padStart(2)}  layout:${String(layout).padStart(2)}\n`,
    );
  }

  const withFindings = rows.filter((r) => r.findings.length);
  if (withFindings.length) {
    process.stdout.write('\nfindings:\n');
    for (const r of withFindings) {
      process.stdout.write(`\n  ${r.id}@${r.viewport} (${r.path}):\n`);
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

  const totals = report.totals;
  process.stdout.write(
    `\n${totals.screens} screen${totals.screens === 1 ? '' : 's'} run, `
    + `${totals.errors} error finding${totals.errors === 1 ? '' : 's'}, `
    + `${totals.layout} layout finding${totals.layout === 1 ? '' : 's'}, `
    + `${totals.screenshots} screenshot${totals.screenshots === 1 ? '' : 's'}.\n`,
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

  const results = { pageOverflowX: null, elementOverflowX: [], elementOverflowY: [], elementPastViewport: [] };

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

  for (const el of all) {
    if (el === document.documentElement || el === document.body) continue;
    if (!isRendered(el)) continue;
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();

    if ((cs.overflowX === 'hidden' || cs.overflowX === 'clip') && el.scrollWidth > el.clientWidth + 1) {
      if (!hasReportedAncestor(el, reportedX)) {
        reportedX.push(el);
        results.elementOverflowX.push({
          selector: selectorPath(el),
          scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        });
      }
    }

    if ((cs.overflowY === 'hidden' || cs.overflowY === 'clip') && el.scrollHeight > el.clientHeight + 1) {
      if (!hasReportedAncestor(el, reportedY)) {
        reportedY.push(el);
        results.elementOverflowY.push({
          selector: selectorPath(el),
          scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        });
      }
    }

    if (rect.right > winWidth + 1) {
      if (!hasReportedAncestor(el, reportedPast)) {
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
        const findings = [];

        const onConsole = (msg) => {
          if (msg.type() === 'error') {
            findings.push({
              kind: 'console-error', severity: 'error', screen: screen.id, viewport: viewportName,
              detail: msg.text().slice(0, 300),
            });
          }
        };
        const onPageError = (err) => {
          findings.push({
            kind: 'page-error', severity: 'error', screen: screen.id, viewport: viewportName,
            detail: String(err && err.message ? err.message : err).slice(0, 300),
          });
        };
        const onRequestFailed = (req) => {
          const reqUrl = req.url();
          if (IGNORED_REQUEST_PATTERNS.some((p) => p.test ? p.test(reqUrl) : reqUrl.includes(p))) return;
          findings.push({
            kind: 'request-failed', severity: 'error', screen: screen.id, viewport: viewportName,
            detail: `${reqUrl} — ${req.failure()?.errorText || 'unknown failure'}`,
            url: reqUrl,
          });
        };
        const onResponse = (res) => {
          const resUrl = res.url();
          const status = res.status();
          if (status >= 500) {
            findings.push({
              kind: 'http-error', severity: 'error', screen: screen.id, viewport: viewportName,
              detail: `${resUrl} → ${status}`, url: resUrl, status,
            });
          }
          if (resUrl.includes('/api/') && status === 401) {
            findings.push({
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

        try {
          await page.goto(`${url}/${path}`, { waitUntil: 'load', timeout: opts.timeout });
          await page.waitForLoadState('networkidle', { timeout: opts.timeout }).catch(() => {});
          await page.waitForTimeout(SETTLE_MS);
        } catch (e) {
          findings.push({
            kind: 'navigation-failed', severity: 'error', screen: screen.id, viewport: viewportName,
            detail: e.message.slice(0, 300),
          });
        }

        let layout = { pageOverflowX: null, elementOverflowX: [], elementOverflowY: [], elementPastViewport: [] };
        try {
          layout = await page.evaluate(scanLayout);
        } catch (e) {
          findings.push({
            kind: 'page-error', severity: 'error', screen: screen.id, viewport: viewportName,
            detail: `layout scan failed: ${e.message}`.slice(0, 300),
          });
        }

        if (layout.pageOverflowX) {
          findings.push({
            kind: 'page-overflow-x', severity: 'layout', screen: screen.id, viewport: viewportName,
            detail: `document scrollWidth ${layout.pageOverflowX.scrollWidth} > window innerWidth ${layout.pageOverflowX.innerWidth}`,
            ...layout.pageOverflowX,
          });
        }
        findings.push(...capList(layout.elementOverflowX, 'element-overflow-x', screen.id, viewportName));
        findings.push(...capList(layout.elementOverflowY, 'element-overflow-y', screen.id, viewportName));
        findings.push(...capList(layout.elementPastViewport, 'element-past-viewport', screen.id, viewportName));

        const screenshotPath = join(opts.out, `${screen.id}@${viewportName}.png`);
        try {
          // VIEWPORT-CLIPPED, never fullPage: a full-page shot grows the
          // viewport to fit the content, which hides the exact overflow bug
          // this harness exists to catch. A human never scrolls to see the
          // problem — they see the clipped viewport, so that's what this shoots.
          await page.screenshot({ path: screenshotPath, fullPage: false });
        } catch (e) {
          findings.push({
            kind: 'page-error', severity: 'error', screen: screen.id, viewport: viewportName,
            detail: `screenshot failed: ${e.message}`.slice(0, 300),
          });
        }

        page.off('console', onConsole);
        page.off('pageerror', onPageError);
        page.off('requestfailed', onRequestFailed);
        page.off('response', onResponse);

        screenReports.push({
          id: screen.id, label: screen.label, path, viewport: viewportName,
          screenshot: screenshotPath, findings,
        });
      }

      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  const durationMs = Date.now() - startedAt;
  const totals = {
    screens: screenReports.length,
    errors: screenReports.reduce((n, r) => n + r.findings.filter((f) => f.severity === 'error').length, 0),
    layout: screenReports.reduce((n, r) => n + r.findings.filter((f) => f.severity === 'layout').length, 0),
    screenshots: screenReports.length,
  };

  const report = {
    generatedAt: new Date().toISOString(),
    url, slug: opts.slug, durationMs,
    preflight: { url, ok: check.ok, version: check.version },
    viewports: viewportNames,
    screens: screenReports,
    totals,
  };

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
