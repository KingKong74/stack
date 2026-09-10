#!/usr/bin/env node
// render-icons.mjs — the favicon and the PWA icons, rendered from the logo.
//
// WHY A SCRIPT AND NOT THREE CHECKED-IN PNGs NOBODY CAN REDRAW: the mark lives
// in web/src/components/Brandmark.tsx as SVG rects. The tab icon and the home
// screen icon have to be the SAME logo, and the only way that stays true after
// somebody nudges a plate is if the binaries are OUTPUT, not artwork. This file
// carries the geometry a second time — a PNG renderer cannot import a TSX
// component — so THE TWO COPIES MUST BE CHANGED TOGETHER. Brandmark.tsx's
// header says so from its side.
//
// The hexes are literal here on purpose, and this is the one place in the repo
// where that is allowed: a standalone .svg served as a favicon has no
// stylesheet to read --grey-1000 from, and a browser that failed to resolve the
// variable would draw an invisible icon. Each is named after the token it is a
// copy of, and they are checked against web/src/styles.css on every run — the
// script REFUSES to write anything if one has drifted.
//
// Usage:
//   node scripts/render-icons.mjs            # write web/public/{favicon.svg,icons/*.png}
//   node scripts/render-icons.mjs --check     # verify the hexes still match styles.css, write nothing
//
// Needs the chromium in scripts/playwright (the UI smoke's, already on this
// host) to rasterise; run scripts/playwright/setup-browser-deps.sh first if it
// will not launch.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Copies of the kit tokens, verified against styles.css below.
const TONE = {
  'grey-1000': '#0A0B0C',
  'grey-750': '#2A2C2F',
  'blue-500': '#3B82E8',
  'blue-400': '#7DAAEB',
  'lime-500': '#BFEC7E',
};

// The 4a plates, in the mark's own 64-unit grid. `full` is the three-plate
// form; `reduced` drops the middle one and thickens the survivors, which is
// what the mark does below 24px (Brandmark.tsx's header says why).
const PLATES = {
  full: [
    { x: 22, y: 12.5, w: 29, h: 10, fill: 'blue-500' },
    { x: 13, y: 27, w: 38, h: 10, fill: 'blue-400' },
    { x: 13, y: 41.5, w: 29, h: 10, fill: 'lime-500' },
  ],
  reduced: [
    { x: 22, y: 14, w: 29, h: 11, fill: 'blue-400' },
    { x: 13, y: 39, w: 29, h: 11, fill: 'lime-500' },
  ],
};

/**
 * One mark as standalone SVG source.
 *
 * `inset` draws the hero tile — 2.5 units in with a --grey-750 hairline. Every
 * icon here is bleed: an app icon is cropped by the platform (iOS rounds it,
 * Android may mask it to a circle) so an inset tile just loses its own edge,
 * and at favicon size the hairline is sub-pixel.
 *
 * `scale` shrinks the plates about the centre without shrinking the tile —
 * that is what a maskable icon needs, since Android crops as much as 20% off
 * every side and a mark drawn to the full grid loses its top and bottom plate.
 */
function markSvg({ size, reduced = false, inset = false, scale = 1 }) {
  const plates = (reduced ? PLATES.reduced : PLATES.full).map((p) => {
    const x = 32 + (p.x - 32) * scale, y = 32 + (p.y - 32) * scale;
    const [w, h] = [p.w * scale, p.h * scale];
    const round = (n) => Number(n.toFixed(2));
    return `  <rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" `
      + `rx="${round(2 * scale)}" fill="${TONE[p.fill]}"/>  <!-- --${p.fill} -->`;
  });
  const tile = inset
    ? `  <rect x="2.5" y="2.5" width="59" height="59" rx="12" fill="${TONE['grey-1000']}" stroke="${TONE['grey-750']}"/>`
    : `  <rect width="64" height="64" rx="${scale < 1 ? 0 : 13}" fill="${TONE['grey-1000']}"/>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64" fill="none">`,
    '  <title>Stack</title>',
    tile,
    ...plates,
    '</svg>',
    '',
  ].join('\n');
}

/** The tokens this file copies must still say what styles.css says. */
function checkTones() {
  const css = readFileSync(join(ROOT, 'web/src/styles.css'), 'utf8');
  const drift = [];
  for (const [name, hex] of Object.entries(TONE)) {
    const found = css.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`));
    if (!found) drift.push(`--${name} is not in styles.css at all`);
    else if (found[1].toUpperCase() !== hex.toUpperCase()) {
      drift.push(`--${name} is ${found[1]} in styles.css, ${hex} here`);
    }
  }
  return drift;
}

const OUTPUTS = [
  // The tab. Reduced, because a tab strip renders it at 16px.
  { path: 'web/public/favicon.svg', svg: { size: 64, reduced: true } },
  // Home screen and installed-app icons. Full mark, full-bleed tile.
  { path: 'web/public/icons/icon-180.png', px: 180, svg: { size: 180 } },
  { path: 'web/public/icons/icon-192.png', px: 192, svg: { size: 192 } },
  { path: 'web/public/icons/icon-512.png', px: 512, svg: { size: 512 } },
  // Android's maskable slot: square to the edge, mark inside the safe circle.
  { path: 'web/public/icons/icon-maskable-512.png', px: 512, svg: { size: 512, scale: 0.62 } },
];

async function main() {
  const drift = checkTones();
  if (drift.length) {
    console.error('[render-icons] the palette moved and these copies did not:');
    for (const d of drift) console.error(`  · ${d}`);
    console.error('  Nothing written. Update TONE above to match styles.css.');
    return 1;
  }
  if (process.argv.includes('--check')) {
    console.log('[render-icons] tones match styles.css.');
    return 0;
  }

  const { chromium } = await import(join(ROOT, 'scripts/playwright/node_modules/playwright/index.mjs'));
  const browser = await chromium.launch();
  try {
    for (const out of OUTPUTS) {
      const svg = markSvg(out.svg);
      const dest = join(ROOT, out.path);
      mkdirSync(dirname(dest), { recursive: true });
      if (!out.px) {
        writeFileSync(dest, svg);
        console.log(`[render-icons] ${out.path} (svg)`);
        continue;
      }
      const page = await browser.newPage({
        viewport: { width: out.px, height: out.px },
        deviceScaleFactor: 1,
      });
      await page.setContent(
        `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>${svg}`,
        { waitUntil: 'load' },
      );
      await page.screenshot({ path: dest, omitBackground: true });
      await page.close();
      console.log(`[render-icons] ${out.path} (${out.px}px)`);
    }
  } finally {
    await browser.close();
  }
  return 0;
}

process.exit(await main());
