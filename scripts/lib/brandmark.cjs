// brandmark.cjs — the logo, in a terminal.
//
// The third of the design's three "in place" applications: the header, the
// browser tab, and the command line. The mark is three offset plates
// (web/src/components/Brandmark.tsx has the artwork and the reasoning); here a
// plate is a run of block characters and its colour is a 24-bit SGR escape, so
// the CLI's banner is recognisably the same object as the topbar's logo rather
// than the word "Stack" in bold.
//
// COMMONJS ON PURPOSE: the `stack` dispatcher is extensionless, so it is CJS
// and cannot `require` an .mjs. An ESM script that wants the banner can still
// `import brandmark from './lib/brandmark.cjs'`.
//
// The RGB triplets are a third copy of three kit tokens, and this is the only
// one with no drift check on it — scripts/render-icons.mjs verifies its own
// against styles.css and refuses to write, but a banner cannot afford to read a
// 270 KB stylesheet to print four lines. Run `node scripts/render-icons.mjs
// --check` after a palette change and fix all three copies together.
//
// TWO RULES, both about not writing escape codes where they will be read as
// data. `banner()` returns the PLAIN form unless it is told colour is wanted —
// the caller decides, because only the caller knows whether its stdout is a
// terminal or a pipe someone is grepping. And the banner belongs on `stack`
// bare and `stack help` ONLY: a subcommand that prints a logo above its JSON is
// a subcommand nobody can pipe.

// The 64-unit grid of the mark, mapped onto a 12-column terminal cell grid.
// Each row is [start column, width]; a terminal cell is about twice as tall as
// it is wide, so the three plates become three rows with no gap between them
// and the offsets alone carry the stagger.
const PLATES = [
  { col: 4, width: 5, rgb: [59, 130, 232] },   // --blue-500
  { col: 2, width: 7, rgb: [125, 170, 235] },  // --blue-400
  { col: 2, width: 5, rgb: [191, 236, 126] },  // --lime-500
];

const RESET = '\u001b[0m';
const paint = (rgb, s) => `\u001b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${s}${RESET}`;

/** True when writing colour to this stream is safe and wanted. */
function wantsColour(stream = process.stdout) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(stream && stream.isTTY) && process.env.TERM !== 'dumb';
}

/**
 * The stacked lockup — plates over the name, which is what the design puts on
 * a splash and a CLI banner. Returns the lines without a trailing newline so a
 * caller can space it however its own output is spaced.
 */
function banner({ colour = wantsColour(), word = 'Stack' } = {}) {
  const rows = PLATES.map(({ col, width, rgb }) => {
    const bar = '█'.repeat(width);
    return ' '.repeat(col) + (colour ? paint(rgb, bar) : bar);
  });
  return [...rows, '  ' + word].join('\n');
}

/**
 * The reduced mark on one line, for sitting beside a command the way the
 * design's terminal panel does. Two plates, as everywhere the mark is small.
 */
function inline({ colour = wantsColour() } = {}) {
  const [, mid, base] = PLATES;
  const bar = (p, n) => (colour ? paint(p.rgb, '▄'.repeat(n)) : '▄'.repeat(n));
  return bar(mid, 3) + bar(base, 2);
}

module.exports = { banner, inline, wantsColour };
