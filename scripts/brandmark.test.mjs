#!/usr/bin/env node
// The CLI banner's drift check (#494) — the third copy of the logo, held to the
// other two without the banner paying for it.
// Run: node scripts/brandmark.test.mjs
//
// WHY A TEST AND NOT A RUNTIME CHECK: scripts/lib/brandmark.cjs carries its
// plate colours as literal RGB triplets because `stack` bare cannot afford to
// read a 270 KB stylesheet to print four lines. render-icons.mjs checks its own
// hexes on every run; the banner had nothing. So the check lives here, where
// the cost is paid once per test run and never per keystroke.
//
// WHAT IT READS: the banner's OWN OUTPUT, not its source — `banner({colour})`
// and `inline({colour})` emit 24-bit SGR escapes, so the triplets, columns and
// widths come back exactly as a terminal would draw them, and nothing had to
// be exported just for a test to see it. Against that:
//   · the tones — each plate's triplet must be its token's hex in styles.css;
//   · the geometry — the 12-column banner cannot equal the 64-unit grid, so it
//     is held to the grid's RELATIONS (which plates share a left edge, a right
//     edge, a width; which way each offset runs), taken off Brandmark.tsx;
//   · the reduced form — inline() is the two-plate mark, so its tones must be
//     the reduced form's fills, in order;
//   · render-icons.mjs's PLATES must still be Brandmark.tsx's rects, since
//     those two can be compared exactly and nothing else compares them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { banner, inline } = require('./lib/brandmark.cjs');

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const css = read('web/src/styles.css');
const tsx = read('web/src/components/Brandmark.tsx');
const icons = read('scripts/render-icons.mjs');

/** A token's hex in styles.css as an [r, g, b] triplet (the first definition, as render-icons reads it). */
function tokenRgb(name) {
  const m = css.match(new RegExp(`--${name}:\\s*#([0-9A-Fa-f]{6})\\b`));
  assert.ok(m, `--${name} is not a six-digit hex in styles.css`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
}

const SGR = /\u001b\[38;2;(\d+);(\d+);(\d+)m([^\u001b]*)\u001b\[0m/g;

/** The banner's plate rows as { col, width, rgb }, read off its painted output. */
function bannerPlates() {
  return banner({ colour: true }).split('\n').filter((l) => l.includes('\u001b')).map((line) => {
    const hits = [...line.matchAll(SGR)];
    assert.equal(hits.length, 1, `a banner row should be one painted run: ${JSON.stringify(line)}`);
    const [, r, g, b, bar] = hits[0];
    return { col: line.indexOf('\u001b'), width: [...bar].length, rgb: [+r, +g, +b] };
  });
}

/** Brandmark.tsx's rects for one form, in draw order, as { x, w, fill }. */
function tsxPlates(form) {
  // The reduced form sits in the ternary's first branch, the full form in its second.
  const [reducedSrc, fullSrc] = tsx.split(/\)\s*:\s*\(/);
  const src = form === 'reduced' ? reducedSrc : fullSrc;
  const rects = [...src.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"[^>]*?var\(--([a-z]+-\d+)\)/g)]
    .map(([, x, y, w, h, fill]) => ({ x: +x, y: +y, w: +w, h: +h, fill }))
    // the tile is grey; the plates never are
    .filter((r) => !r.fill.startsWith('grey-'));
  assert.ok(rects.length >= 2, `could not read the ${form} plates out of Brandmark.tsx`);
  return rects;
}

/** render-icons.mjs's PLATES for one form. */
function iconPlates(form) {
  const block = icons.match(new RegExp(`${form}: \\[([\\s\\S]*?)\\]`));
  assert.ok(block, `could not find PLATES.${form} in render-icons.mjs`);
  return [...block[1].matchAll(/x: ([\d.]+), y: ([\d.]+), w: ([\d.]+), h: ([\d.]+), fill: '([a-z]+-\d+)'/g)]
    .map(([, x, y, w, h, fill]) => ({ x: +x, y: +y, w: +w, h: +h, fill }));
}

const sign = (n) => Math.sign(n);

test('each banner plate is painted in its token, exactly as styles.css has it', () => {
  const plates = bannerPlates();
  const full = tsxPlates('full');
  assert.equal(plates.length, full.length, 'the banner and the mark have a different number of plates');
  full.forEach((p, i) => {
    assert.deepEqual(plates[i].rgb, tokenRgb(p.fill),
      `banner row ${i + 1} should be --${p.fill}; fix PLATES in scripts/lib/brandmark.cjs`);
  });
});

test('the banner keeps the mark\'s geometry: shared edges, shared widths, offset directions', () => {
  const b = bannerPlates();
  const m = tsxPlates('full');
  for (let i = 0; i < m.length; i++) {
    for (let j = i + 1; j < m.length; j++) {
      const pair = `plates ${i + 1} and ${j + 1}`;
      assert.equal(sign(b[j].col - b[i].col), sign(m[j].x - m[i].x), `${pair}: left edges moved differently`);
      assert.equal(sign((b[j].col + b[j].width) - (b[i].col + b[i].width)),
        sign((m[j].x + m[j].w) - (m[i].x + m[i].w)), `${pair}: right edges moved differently`);
      assert.equal(sign(b[j].width - b[i].width), sign(m[j].w - m[i].w), `${pair}: widths compare differently`);
    }
  }
});

test('the inline mark is the reduced form: its two tones, in order', () => {
  const tones = [...inline({ colour: true }).matchAll(SGR)].map(([, r, g, b]) => [+r, +g, +b]);
  const reduced = tsxPlates('reduced');
  assert.deepEqual(tones, reduced.map((p) => tokenRgb(p.fill)));
});

test('the plain forms carry no escape codes (a pipe gets text)', () => {
  assert.ok(!banner({ colour: false }).includes('\u001b'));
  assert.ok(!inline({ colour: false }).includes('\u001b'));
});

test('render-icons.mjs\'s plates are still Brandmark.tsx\'s rects', () => {
  for (const form of ['full', 'reduced']) {
    assert.deepEqual(iconPlates(form), tsxPlates(form),
      `the ${form} mark differs between render-icons.mjs and Brandmark.tsx — change both, then re-run the renderer`);
  }
});
