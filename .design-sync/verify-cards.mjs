// verify-cards.mjs — the gate for a palette-only sync.
//
//   node .design-sync/verify-cards.mjs            # exits non-zero on any finding
//   node .design-sync/verify-cards.mjs --shots    # also write PNGs to review
//
// WHY THIS AND NOT package-validate.mjs. That validator opens by requiring
// `_ds_bundle.js` with a `@ds-bundle` header naming a namespace and a component
// array, and hard-fails `[NO_DIST]` without one. This run ships the PALETTE and
// no components, so the standard gate is structurally unsatisfiable — and the
// skill's rule is that off-script GENERATION is legitimate while off-script
// verification is not. So the gate is not skipped, it is replaced by one that
// fits what is actually being shipped, and it is stricter than looking:
//
//   1. Each card renders in headless chromium with a non-empty body and no
//      pageerror — the `[RENDER]` check, kept.
//   2. Every `<link href>` resolves — the `[LINK_HREF_MISSING]` check, kept.
//   3. Every file's first line is a `@dsCard` comment — the `[DSCARD_MISSING]`
//      check, kept: without it the card never appears in the pane.
//   4. Every `@import` in the styles.css closure resolves on disk — the
//      `[CSS_IMPORT_MISSING]` check, kept, and it is the one that matters most
//      here: a rendered design receives ONLY that closure.
//   5. THE ONE THIS ADDS. Every swatch carries `data-token`/`data-prop`, and the
//      browser is asked what it actually PAINTED there. A swatch whose painted
//      colour is not the token's own resolved value is a lie about the palette
//      — and an unresolved `var()` paints nothing at all, which is exactly how a
//      card keeps claiming a token the app has since renamed.
//
// Checking 5 by eye is the thing that already failed once in this repo: a pale
// bar downscaled over a dark page reads as dark, and a light-topbar bug survived
// being looked at directly (#432). Measuring is not optional here.

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'ds-bundle');
const SHOTS = process.argv.includes('--shots');
const SHOT_DIR = join(REPO, '.design-sync/.shots');

const findings = [];
const fail = (tag, msg) => { findings.push(`[${tag}] ${msg}`); };
let checks = 0;
const ok = (msg) => { checks++; if (process.env.DS_VERBOSE) console.log(`  ok   ${msg}`); };

// --- static checks (no browser) ---------------------------------------------

// 3. the @dsCard marker
const cards = readdirSync(join(OUT, 'guidelines')).filter((f) => f.endsWith('.html')).sort();
if (!cards.length) fail('ZERO_MATCH', 'no cards in ds-bundle/guidelines');
for (const f of cards) {
  const first = readFileSync(join(OUT, 'guidelines', f), 'utf8').split('\n')[0];
  if (!/^<!--\s*@dsCard\s/.test(first)) fail('DSCARD_MISSING', `${f}: first line isn't a @dsCard comment`);
  else if (!/group="[^"]+"/.test(first)) fail('DSCARD_MISSING', `${f}: @dsCard has no group=`);
  else ok(`${f}: @dsCard`);
}

// 2. every <link href> resolves relative to its own file
for (const f of cards) {
  const html = readFileSync(join(OUT, 'guidelines', f), 'utf8');
  for (const m of html.matchAll(/<link[^>]+href="([^"]+)"/g)) {
    const target = resolvePath(join(OUT, 'guidelines'), m[1]);
    if (!existsSync(target)) fail('LINK_HREF_MISSING', `${f}: <link href="${m[1]}"> doesn't resolve`);
    else ok(`${f}: link ${m[1]}`);
  }
}

// 4. the styles.css @import closure, walked transitively
const seen = new Set();
(function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  if (!existsSync(file)) { fail('CSS_IMPORT_MISSING', `${file.replace(OUT, '')} is @imported but doesn't exist`); return; }
  const css = readFileSync(file, 'utf8');
  for (const m of css.matchAll(/@import\s+(?:url\()?["']([^"']+)["']\)?/g)) {
    if (/^https?:/.test(m[1])) { ok(`remote @import ${m[1]}`); continue; }
    walk(resolvePath(dirname(file), m[1]));
  }
}(join(OUT, 'styles.css')));
ok(`styles.css closure: ${seen.size} files`);

// --- the render + measure pass ----------------------------------------------

// The repo already owns a pinned playwright + a cached chromium for the UI
// smoke (#291, scripts/playwright). Reusing it is the right dependency: one
// browser version verifies the app and the design bundle, and this script adds
// nothing to install. `scripts/playwright/setup-browser-deps.sh --print-env`
// still has to be eval'd first on this host — chromium needs a rootless
// library prefix there.
let chromium;
for (const spec of ['playwright', join(REPO, 'scripts/playwright/node_modules/playwright/index.mjs'),
  join(REPO, 'scripts/playwright/node_modules/playwright/index.js')]) {
  try {
    const mod = await import(spec.startsWith('/') ? pathToFileURL(spec).href : spec);
    if (mod.chromium) { chromium = mod.chromium; break; }
    if (mod.default?.chromium) { chromium = mod.default.chromium; break; }
  } catch { /* try the next */ }
}
if (!chromium) {
  console.error('[RENDER_SKIPPED] playwright not importable — install it, or run scripts/run-ui-smoke.sh once to provision scripts/playwright');
  process.exit(2);
}

/** #rrggbb / rgb() -> [r,g,b]. Anything else (a gradient, a keyword) -> null. */
function rgb(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [0, 1, 2].map((i) => parseInt(m[1][i] + m[1][i], 16));
  m = /^rgba?\(([^)]+)\)/i.exec(s);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (p.length >= 3 && p.slice(0, 3).every(Number.isFinite)) return p.slice(0, 3);
  }
  return null;
}

const alphaOf = (v) => {
  const m = /rgba\([^)]*[,/]\s*([\d.]+)\s*\)$/.exec(String(v).trim());
  return m ? Number(m[1]) : 1;
};

/** ms and s are the same duration; the browser reports whichever it likes. */
const asMs = (v) => {
  const m = /^([\d.]+)(ms|s)$/.exec(String(v).trim());
  return m ? Number(m[1]) * (m[2] === 's' ? 1000 : 1) : null;
};

/** A font stack survives the round trip with different quoting and spacing. */
const stack = (v) => String(v).replace(/["']/g, '').split(',').map((x) => x.trim().toLowerCase()).join(',');

/**
 * A shadow means the same thing however the browser writes it back. It
 * reorders the parts (colour first), stamps units on every length, moves
 * `inset` to the end, and resolves hexes to rgb() — so the strings never match
 * and the VALUES always do. Canonicalise both sides instead: per layer, the
 * colour as four numbers, the lengths as pixels, and the inset flag.
 */
function shadowKey(v) {
  const s = String(v).trim();
  if (!s || s === 'none') return 'none';
  const layers = [];
  let depth = 0; let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { layers.push(cur); cur = ''; } else cur += ch;
  }
  layers.push(cur);
  return layers.map((layer) => {
    const inset = /\binset\b/.test(layer) ? 'inset' : '';
    const colour = /(#[0-9a-f]{3,8}|rgba?\([^)]*\))/i.exec(layer);
    const c = colour ? rgb(colour[1]) : null;
    const a = colour ? alphaOf(colour[1]) : 1;
    // Strip BOTH colour spellings before hunting lengths: a hex is a run of
    // digits, and `#18191A` yields a phantom "18191" that no painted side has.
    const lengths = (layer.replace(/rgba?\([^)]*\)/gi, ' ').replace(/#[0-9a-f]{3,8}/gi, ' ')
      .match(/-?[\d.]+(?:px)?/gi) || []).map((n) => Number(String(n).replace(/px$/i, '')));
    // A shadow has four lengths; the browser writes the trailing zeros the
    // author left off, so both sides are padded before they are compared.
    while (lengths.length < 4) lengths.push(0);
    return `${inset}|${c ? c.join(',') : '?'}|${a}|${lengths.slice(0, 4).join(',')}`;
  }).join(' / ');
}

/** Is what the browser painted what the swatch claimed? Property-aware. */
function compare(prop, want, got) {
  if (prop === 'box-shadow') return shadowKey(want) === shadowKey(got);
  if (/duration|delay/.test(prop)) {
    const a = asMs(want); const b = asMs(got);
    return a !== null && b !== null && Math.abs(a - b) < 0.5;
  }
  if (prop === 'font-family') return stack(want) === stack(got);
  const norm = (v) => String(v).replace(/\s+/g, ' ').trim();
  return norm(want) === norm(got);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
if (SHOTS) mkdirSync(SHOT_DIR, { recursive: true });

for (const f of cards) {
  const errs = [];
  page.removeAllListeners('pageerror');
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(pathToFileURL(join(OUT, 'guidelines', f)).href, { waitUntil: 'load' });
  await page.waitForTimeout(120);

  // 1. rendered, and rendered with something in it
  const text = (await page.evaluate(() => document.body.innerText.trim())).length;
  if (!text) fail('RENDER', `${f}: body is empty`);
  else ok(`${f}: rendered (${text} chars)`);
  for (const e of errs) fail('RENDER_ERRORS', `${f}: ${e}`);

  // 5. what the browser actually painted, against the token's own value
  const measured = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return [...document.querySelectorAll('[data-token][data-prop]')].map((el) => {
      const prop = el.dataset.prop;
      return {
        token: el.dataset.token,
        prop,
        painted: getComputedStyle(el).getPropertyValue(prop).trim(),
        declared: root.getPropertyValue(el.dataset.token).trim(),
        expect: el.dataset.expect || '',
      };
    });
  });
  if (!measured.length) fail('RENDER_THIN', `${f}: no measurable swatches (nothing carries data-token)`);

  for (const s of measured) {
    if (!s.declared) {
      fail('TOKENS_MISSING', `${f}: ${s.token} is referenced but :root doesn't define it`);
      continue;
    }
    // Lengths, shadows and easings compare as strings after normalising space;
    // colours compare as numbers, composited when the token is translucent.
    if (s.prop === 'background-color' || s.prop === 'color' || s.prop === 'border-top-color') {
      const want = rgb(s.declared);
      const got = rgb(s.painted);
      if (!want) { ok(`${f}: ${s.token} (not a flat colour, skipped)`); continue; }
      if (!got) { fail('RENDER', `${f}: ${s.token} painted "${s.painted}", which is not a colour`); continue; }
      // ALPHA IS COMPARED, NOT COMPOSITED. getComputedStyle reports a
      // translucent paint as the rgba it was given, not as the blend the screen
      // shows — so compositing the expected side alone made every translucent
      // token (--surface-hover, --border-subtle, --scrim) read as drift.
      const off = Math.max(...want.map((c, i) => Math.abs(c - got[i])), Math.abs(alphaOf(s.declared) - alphaOf(s.painted)) * 255);
      if (off > 1) fail('PALETTE_DRIFT', `${f}: ${s.token} declares ${s.declared} but paints ${s.painted}`);
      else ok(`${f}: ${s.token} paints its own value`);
    } else {
      if (!s.painted) { fail('RENDER', `${f}: ${s.token} (${s.prop}) painted nothing`); continue; }
      // What this swatch claims. `data-expect` wins where the token's own value
      // is not directly comparable — a --type-* composite is a whole `font:`
      // shorthand, so the specimen names the one part it is demonstrating.
      const want = s.expect || s.declared;
      if (!compare(s.prop, want, s.painted)) {
        fail('PALETTE_DRIFT', `${f}: ${s.token} (${s.prop}) should be ${want} but paints ${s.painted}`);
      } else ok(`${f}: ${s.token} ${s.prop} = ${s.painted}`);
    }
  }

  if (SHOTS) await page.screenshot({ path: join(SHOT_DIR, `${f.replace('.card.html', '')}.png`), fullPage: true });
}

await browser.close();

writeFileSync(join(REPO, '.design-sync/.verify.json'),
  JSON.stringify({ at: new Date().toISOString(), cards: cards.length, checks, findings }, null, 2));

console.log(`\n${cards.length} cards · ${checks} checks passed · ${findings.length} finding(s)`);
for (const f of findings) console.log(`  ${f}`);
if (SHOTS) console.log(`\nscreenshots: ${SHOT_DIR}`);
process.exit(findings.length ? 1 : 0);
