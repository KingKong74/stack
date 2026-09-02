// tokens-split.mjs — web/src/styles.css  ->  ds-bundle/{styles.css,tokens/*.css}
//
//   node .design-sync/tokens-split.mjs            # writes ds-bundle/
//   node .design-sync/tokens-split.mjs --print    # just report what it parsed
//
// WHY THIS EXISTS AT ALL. The design-sync converter builds its output from a
// package's compiled `dist/`, and Stack has none: `web/` is a private Vite APP
// (no `main`, no `exports`, `vite build` emits an app bundle), so there is
// nothing to bundle into `window.<global>.*`. The skill's own escape hatch
// applies — produce the layout by whatever means the repo allows — and this is
// that means for the half of the system that IS shippable today: the palette.
//
// THE ONE RULE: NOTHING IS RETYPED. Every token file, and every swatch on every
// guideline card, is generated from the `:root` block in web/src/styles.css.
// That block is the app's live palette (#432 — the kit's tokens verbatim, with
// Stack's own names aliased onto them), so a card cannot name a token the app
// does not define, and a value cannot drift from the app by being copied wrong.
// Re-run this after any palette change and the whole bundle follows.
//
// THE TWO LAYERS SURVIVE THE SPLIT. Layer 1 (the kit's own `--grey-*`,
// `--blue-*`, `--surface-*`, `--text-*` …) goes to `tokens/*.css` by concern.
// Layer 2 — Stack's names aliased onto layer 1 — goes to `tokens/aliases.css`
// and is the file that makes this Stack's system rather than a copy of the kit.
// A design built with this palette reads either vocabulary.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(REPO, 'web/src/styles.css');
const HTML = join(REPO, 'web/index.html');
const OUT = join(REPO, 'ds-bundle');

/**
 * THE FONT LINK, LIFTED OUT OF THE APP'S OWN index.html.
 *
 * `--font-sans` and `--font-mono` name Instrument Sans and JetBrains Mono, and
 * the app gets both from a Google Fonts <link> in its HTML — nowhere in the
 * stylesheet. A bundle that copied only the CSS would therefore ship two font
 * families it does not load, and every design built with it would silently
 * render in a fallback with nothing downstream to catch it. So the same URL the
 * app uses is @imported into the bundle's entry, where the closure carries it.
 * Read, never retyped: change the link in index.html and this follows.
 */
function fontImport() {
  const html = readFileSync(HTML, 'utf8');
  const m = /<link[^>]+href="(https:\/\/fonts\.googleapis\.com\/[^"]+)"/.exec(html);
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

// --- parse -----------------------------------------------------------------

/** The `:root { … }` block, brace-counted rather than regexed to the first `}`. */
function rootBlock(css) {
  const start = css.indexOf(':root {');
  if (start < 0) throw new Error(':root block not found in web/src/styles.css');
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') { if (--depth === 0) return css.slice(start, i + 1); }
  }
  throw new Error(':root block is unterminated');
}

/**
 * Walk the block, carrying the last comment as the current section. Multi-line
 * comments (the palette's rationale) are kept whole: they are the WHY, and the
 * whole point of shipping the palette to a design agent is that it inherits the
 * reasoning, not just the hexes.
 */
function parse(block) {
  const tokens = [];
  let section = 'Ungrouped';
  let layer = 1;
  let comment = null;
  const re = /\/\*([\s\S]*?)\*\/|(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g;
  let m;
  let lastEnd = 0;
  while ((m = re.exec(block))) {
    // A comment on the SAME LINE as the declaration before it annotates that
    // declaration; only a comment on its own line opens a section. Without this
    // `--paper: var(--surface-canvas);  /* app background */` renames the
    // section for every token after it.
    const trailing = m[1] !== undefined && !block.slice(lastEnd, m.index).includes('\n');
    lastEnd = re.lastIndex;
    if (trailing) {
      const prev = tokens[tokens.length - 1];
      if (prev) prev.trail = m[1].trim().replace(/\s+/g, ' ');
      continue;
    }
    if (m[1] !== undefined) {
      const text = m[1].trim();
      if (/^-+\s*2\./.test(text) || /STACK'S NAMES/.test(text)) layer = 2;
      // A section header is the short label form; a long rationale comment
      // annotates the NEXT token instead of renaming the section.
      const oneLine = text.split('\n')[0].trim();
      if (text.length < 90 && !text.includes('\n')) {
        section = oneLine.replace(/^-+\s*/, '').replace(/\s*-+$/, '').replace(/^\d\.\s*/, '');
      } else {
        comment = text;
      }
      continue;
    }
    tokens.push({
      name: m[2], value: m[3].trim().replace(/\s+/g, ' '), section, layer,
      note: comment,
    });
    comment = null;
  }
  return tokens;
}

// --- resolve ---------------------------------------------------------------

/** Follow `var(--x)` chains to the literal a browser would paint. */
export function resolve(name, byName, seen = new Set()) {
  const t = byName.get(name);
  if (!t || seen.has(name)) return null;
  seen.add(name);
  const v = t.value.trim();
  const solo = /^var\(\s*(--[A-Za-z0-9-]+)\s*\)$/.exec(v);
  if (solo) return resolve(solo[1], byName, seen);
  return v;
}

// --- emit ------------------------------------------------------------------

// Which concern each parsed section belongs to. A section this does not name
// lands in colors.css, which is where every unclassified tone belongs.
const FILES = {
  'tokens/colors.css': [
    'Neutrals — cool-tinted greys', 'Blue — primary action', 'Lime — accent, success, highlight',
    'Semantic hues', 'Surfaces', 'Text', 'Borders', 'Interactive',
    'Status pairs (bg / fg)', 'Data viz — lime and blue lead, greys fill',
  ],
  'tokens/typography.css': ['Type'],
  'tokens/spacing.css': ['Space, radius, control heights, frame'],
  'tokens/elevation.css': ['Elevation'],
  'tokens/motion.css': ['Motion'],
};

const BANNER = (title, why) => `/* ${title}
   ${'='.repeat(Math.max(0, 66 - title.length))}
   Generated from web/src/styles.css by .design-sync/tokens-split.mjs.
   Do not edit here — edit the :root block in the app and re-run.

   ${why}
*/\n\n`;

function emit(tokens) {
  const files = new Map();
  const put = (path, token) => {
    if (!files.has(path)) files.set(path, []);
    files.get(path).push(token);
  };
  const sectionFile = new Map();
  for (const [file, sections] of Object.entries(FILES)) {
    for (const s of sections) sectionFile.set(s, file);
  }
  for (const t of tokens) {
    if (t.layer === 2) put('tokens/aliases.css', t);
    else put(sectionFile.get(t.section) || 'tokens/colors.css', t);
  }

  const WHY = {
    'tokens/colors.css': 'Every tone the system paints. The ramps come first and the ROLES\n   (surface/text/border/action/status/viz) are aliases onto them — style with a\n   role, not a ramp step, unless you are building the ramp itself.',
    'tokens/typography.css': 'The type scale, and the --type-* composites that pack weight/size/leading/family\n   into one `font:` shorthand. Prefer a composite: it is the whole typographic\n   decision in one token.',
    'tokens/spacing.css': 'The spacing and radius scales, control heights, and the frame widths the app\n   shell is built on.',
    'tokens/elevation.css': 'Shadows and focus rings. A resting card has no shadow in this system; elevation\n   marks what floats (menus, dialogs) and what is being pointed at.',
    'tokens/motion.css': 'Durations and easings. --transition-control is the one every control uses, so\n   hover and focus feel identical everywhere.',
    'tokens/aliases.css': "LAYER 2 — Stack's own vocabulary, aliased onto the kit tokens. Both names are\n   live: --paper and --surface-canvas are the same colour, and the app's ~3,600\n   lines of CSS read these. Two traps they encode: --ink is near-WHITE, and a\n   FILL tone is not a TEXT tone (--accent/--accent-text, --critical/--critical-text).",
  };

  const out = [];
  for (const [path, list] of files) {
    const title = path.split('/').pop().replace('.css', '').toUpperCase();
    let css = BANNER(`${title} — Stack UI tokens`, WHY[path] || '');
    css += ':root {\n';
    let section = null;
    for (const t of list) {
      if (t.section !== section) {
        section = t.section;
        css += `\n  /* ${section} */\n`;
      }
      if (t.note) css += t.note.split('\n').map((l) => `  /* ${l.trim()} */`).join('\n') + '\n';
      css += `  ${t.name}: ${t.value};${t.trail ? `  /* ${t.trail} */` : ''}\n`;
    }
    css += '}\n';
    out.push([path, css]);
  }
  return out;
}

// --- run -------------------------------------------------------------------

const tokens = parse(rootBlock(readFileSync(SRC, 'utf8')));
const byName = new Map(tokens.map((t) => [t.name, t]));

if (process.argv.includes('--print')) {
  const bySection = new Map();
  for (const t of tokens) bySection.set(t.section, (bySection.get(t.section) || 0) + 1);
  for (const [s, n] of bySection) console.log(String(n).padStart(4), s);
  console.log(`\n${tokens.length} tokens · layer 1: ${tokens.filter((t) => t.layer === 1).length} · layer 2: ${tokens.filter((t) => t.layer === 2).length}`);
  process.exit(0);
}

if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(join(OUT, 'tokens'), { recursive: true });

const emitted = emit(tokens);
for (const [path, css] of emitted) {
  writeFileSync(join(OUT, path), css);
  console.log(`  ${path.padEnd(24)} ${css.split('\n').length - 1} lines`);
}

// THE ENTRY. A rendered design receives only this file's transitive @import
// closure — so anything not reachable from here does not exist as far as the
// design agent is concerned. Order is layer 1 then layer 2, because layer 2's
// values are var() references INTO layer 1.
const order = ['tokens/colors.css', 'tokens/typography.css', 'tokens/spacing.css',
  'tokens/elevation.css', 'tokens/motion.css', 'tokens/aliases.css']
  .filter((p) => emitted.some(([q]) => q === p));
const font = fontImport();
if (!font) console.warn('  ! no Google Fonts <link> found in web/index.html — the bundle will ship families it does not load');
writeFileSync(join(OUT, 'styles.css'), `${BANNER('STACK UI — the palette entry',
  'A rendered design receives only this file\'s @import closure, so everything the\n   system defines is reachable from here — including the two faces, which the app\n   itself loads from its HTML. Layer 1 (the kit\'s tokens) loads before layer 2\n   (Stack\'s names), because layer 2 resolves INTO layer 1.')
}${font ? `/* Instrument Sans + JetBrains Mono — the same request web/index.html makes. */\n@import url("${font}");\n\n` : ''}${order.map((p) => `@import "./${p}";`).join('\n')}\n`);
console.log(`  styles.css               @imports ${order.length} token files${font ? ' + the font host' : ''}`);

writeFileSync(join(OUT, '.tokens.json'), JSON.stringify(
  tokens.map((t) => ({ ...t, resolved: resolve(t.name, byName) })), null, 2));
console.log(`\n${tokens.length} tokens written · ${tokens.filter((t) => t.layer === 2).length} of them Stack aliases`);
