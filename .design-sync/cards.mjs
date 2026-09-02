// cards.mjs — ds-bundle/.tokens.json  ->  ds-bundle/guidelines/*.card.html
//
//   node .design-sync/cards.mjs      # after tokens-split.mjs
//
// GENERATED, NOT HAND-WRITTEN, and that is the fidelity argument. Every swatch,
// label and value on every card is read out of the same parse that produced
// tokens/*.css, which came from the app's own :root. So a card cannot name a
// token that does not exist, cannot show a value that has drifted from the app,
// and cannot silently miss a token somebody added — the ramp cards enumerate
// whatever the section actually holds.
//
// EACH CARD LINKS ../styles.css, never a token file directly: the entry's
// @import closure is exactly what a rendered design receives, so linking the
// entry is the only link that proves anything about how designs will look.
//
// The first line of every file is the `@dsCard` marker the Design System pane
// builds its index from. Without it the card exists but is never listed.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'ds-bundle');
const tokens = JSON.parse(readFileSync(join(OUT, '.tokens.json'), 'utf8'));

const byName = new Map(tokens.map((t) => [t.name, t]));
const inSection = (s) => tokens.filter((t) => t.section === s);
const named = (...names) => names.map((n) => byName.get(n)).filter(Boolean);
const has = (n) => byName.has(n);

// --- the page shell ---------------------------------------------------------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function card({ name, group, subtitle, viewport = '900x620', body, note }) {
  return `<!-- @dsCard group="${group}" name="${esc(name)}" subtitle="${esc(subtitle)}" viewport="${viewport}" -->
<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(name)} — Stack UI</title>
<link rel="stylesheet" href="../styles.css">
<style>
  /* The card's own frame. Written in the system's tokens so the card is itself
     an example of the palette it documents — and so a broken token shows up
     here first, in the furniture, before you reach the swatches. */
  html, body { margin: 0; background: var(--surface-canvas); color: var(--text-primary); }
  body { font: var(--type-body); padding: var(--space-8); }
  h1 { font: var(--type-title); letter-spacing: var(--tracking-tight); margin: 0 0 var(--space-3); }
  .lede { font: var(--type-body-sm); color: var(--text-secondary); margin: 0 0 var(--space-8); max-width: 76ch; text-wrap: pretty; }
  .grid { display: grid; gap: var(--space-5); }
  /* Swatch lists go multi-column — a single 700px column left half the card
     empty. A SCALE never does: read across and the ladder stops being a ladder,
     which is the one thing a scale card exists to show. */
  .grid.cols { grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); align-items: start; }
  .sw { display: flex; align-items: center; gap: var(--space-5); }
  .chip { width: 56px; height: 40px; flex: none; border-radius: var(--radius-md); border: 1px solid var(--border-subtle); }
  .meta { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .tok { font: var(--weight-medium) var(--text-xs)/1.3 var(--font-mono); color: var(--text-primary); }
  .val { font: var(--weight-regular) var(--text-2xs)/1.3 var(--font-mono); color: var(--text-tertiary); }
  .why { font: var(--type-caption); color: var(--text-tertiary); text-wrap: pretty; }
  section { margin-bottom: var(--space-9); }
  h2 { font: var(--type-eyebrow); letter-spacing: var(--tracking-caps); text-transform: uppercase;
       color: var(--text-tertiary); margin: 0 0 var(--space-5); }
  .note { font: var(--type-body-sm); color: var(--text-secondary); background: var(--surface-raised);
          border-left: 2px solid var(--border-accent); border-radius: var(--radius-md);
          padding: var(--space-5) var(--space-6); margin: 0 0 var(--space-8); text-wrap: pretty; max-width: 82ch; }
  .note b { color: var(--text-primary); font-weight: var(--weight-semibold); }
</style></head>
<body>
<h1>${esc(name)}</h1>
<p class="lede">${subtitle}</p>
${note ? `<p class="note">${note}</p>` : ''}
${body}
</body></html>
`;
}

/** One swatch row. `data-token` is what the verifier measures against. */
function swatch(t, { prop = 'background', shape = '' } = {}) {
  const style = prop === 'background'
    ? `background: var(${t.name});`
    : `background: var(--surface-card); color: var(${t.name}); display:flex; align-items:center; justify-content:center; font: var(--weight-semibold) var(--text-md)/1 var(--font-sans);`;
  return `<div class="sw">
    <div class="chip${shape}" style="${style}" data-token="${t.name}" data-prop="${prop === 'background' ? 'background-color' : 'color'}">${prop === 'background' ? '' : 'Aa'}</div>
    <div class="meta"><span class="tok">${t.name}</span><span class="val">${esc(t.resolved || t.value)}</span>
    ${t.trail ? `<span class="why">${esc(t.trail)}</span>` : ''}</div>
  </div>`;
}

const rows = (list, opts) => `<div class="grid cols">${list.map((t) => swatch(t, opts)).join('\n')}</div>`;

/** Does this token resolve to something paintable? One predicate, so a swatch
    can never be measured against a colour it was not actually painted with. */
const isColour = (t) => /^(#|rgb)/.test(t.resolved || '');

// --- the cards --------------------------------------------------------------

const cards = [];
const add = (file, spec) => cards.push([file, card(spec)]);

// 1-4: the ramps, straight off their sections.
for (const [file, section, name, subtitle] of [
  ['colors-neutrals', 'Neutrals — cool-tinted greys', 'Neutrals',
    'The grey ramp every surface and every piece of text is drawn from. Cool-tinted, not pure grey — it is what keeps the dark UI from reading as flat black.'],
  ['colors-blue', 'Blue — primary action', 'Blue — primary action',
    'Buttons, links, focus rings and selection. Blue is the ACTION colour: if something is pressable or selected, it is blue.'],
  ['colors-lime', 'Lime — accent, success, highlight', 'Lime — accent',
    'Success, highlight, and the first data-viz series. Lime is the ACCENT: it marks what went well or what to look at, never what to press.'],
  ['colors-semantic', 'Semantic hues', 'Semantic hues',
    'Red and amber, and the tints they pair with. Both are FILL tones — see the status card for the foregrounds that go on them.'],
]) {
  const list = inSection(section);
  // LOUD, not skipped. A section this file names and the palette no longer has
  // means a card silently disappeared — which is how a design system quietly
  // stops documenting a colour it still ships.
  if (!list.length) throw new Error(`no tokens in section ${JSON.stringify(section)} — the palette's section names have changed; update cards.mjs`);
  add(file, { name, group: 'Color', subtitle, body: rows(list) });
}

// 5: surfaces, stacked in depth order so the ladder is visible as a ladder.
if (inSection('Surfaces').length) {
  const s = inSection('Surfaces');
  add('colors-surfaces', {
    name: 'Surfaces',
    group: 'Color',
    subtitle: 'The depth ladder, from the page ground up to what floats above it. Pick by ROLE — canvas for the page, card for a resting panel, overlay for something that floats.',
    note: 'The app is <b>dark-only</b>. There is no light counterpart and no theme attribute, so every rule states its colour once.',
    body: `${rows(s)}
    <section style="margin-top: var(--space-9)"><h2>Stacked</h2>
    <div style="background: var(--surface-canvas); padding: var(--space-6); border-radius: var(--radius-xl);">
      <div style="background: var(--surface-raised); padding: var(--space-6); border-radius: var(--radius-lg);">
        <div style="background: var(--surface-card); padding: var(--space-6); border-radius: var(--radius-md); box-shadow: var(--shadow-sm);">
          <div style="background: var(--surface-overlay); padding: var(--space-5); border-radius: var(--radius-sm); font: var(--type-caption); color: var(--text-secondary);">
            canvas &rsaquo; raised &rsaquo; card &rsaquo; overlay
          </div></div></div></div></section>`,
  });
}

// 6: text roles, drawn AS TEXT on the ground they are meant for.
if (inSection('Text').length) {
  add('colors-text', {
    name: 'Text',
    group: 'Color',
    subtitle: 'The foreground roles, drawn as text on a card — which is the only way to judge them. Primary for what you read, secondary for supporting copy, tertiary for labels.',
    note: '<b>--text-primary is near-WHITE.</b> Anything that inverts to white on it disappears. And a FILL tone is never a text tone: --action-primary and --critical are grounds, --text-link and --status-danger-fg are their foregrounds.',
    body: rows(inSection('Text'), { prop: 'color' }),
  });
}

// 7: borders.
if (inSection('Borders').length) {
  add('colors-borders', {
    name: 'Borders',
    group: 'Color',
    subtitle: 'Hairlines, in the order you reach for them: subtle to separate, default to enclose, strong to emphasise, focus and accent to mark state.',
    body: `<div class="grid cols">${inSection('Borders').map((t) => `<div class="sw">
      <div class="chip" style="background: var(--surface-card); border: 2px solid var(${t.name});" data-token="${t.name}" data-prop="border-top-color"></div>
      <div class="meta"><span class="tok">${t.name}</span><span class="val">${esc(t.resolved || t.value)}</span></div>
    </div>`).join('\n')}</div>`,
  });
}

// 8: status pairs — the bg and fg TOGETHER, because that is the contract.
if (inSection('Status pairs (bg / fg)').length) {
  const pairs = ['success', 'info', 'danger', 'warning', 'neutral']
    .filter((k) => has(`--status-${k}-bg`) && has(`--status-${k}-fg`));
  add('colors-status', {
    name: 'Status',
    group: 'Color',
    subtitle: 'Five states, each a background and a foreground that belong together. Use them as a PAIR — the foreground is chosen to clear AA on its own background and nowhere else.',
    body: `<div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(240px, 1fr))">
    ${pairs.map((k) => `<div style="background: var(--status-${k}-bg); border-radius: var(--radius-lg); padding: var(--space-6); display:flex; flex-direction:column; gap:var(--space-3);"
        data-token="--status-${k}-bg" data-prop="background-color">
      <span style="font: var(--type-label); color: var(--status-${k}-fg);" data-token="--status-${k}-fg" data-prop="color">${k}</span>
      <span class="val">--status-${k}-bg<br>--status-${k}-fg</span>
    </div>`).join('\n')}</div>`,
  });
}

// 9: data viz.
if (inSection('Data viz — lime and blue lead, greys fill').length) {
  const v = inSection('Data viz — lime and blue lead, greys fill');
  add('viz', {
    name: 'Data viz',
    group: 'Color',
    subtitle: 'The series ramp, in order. Lime and blue lead because they are the two hues the rest of the system already means something with; the greys fill behind them.',
    body: `${rows(v)}
    <section style="margin-top: var(--space-9)"><h2>In a chart</h2>
    <div style="display:flex; align-items:flex-end; gap:var(--space-4); height:140px;">
      ${v.map((t, i) => `<span style="flex:1; height:${[100, 74, 55, 40, 28, 18][i] || 20}%; background: var(${t.name}); border-radius: var(--radius-sm) var(--radius-sm) 0 0;"></span>`).join('')}
    </div></section>`,
  });
}

// 10: the type scale.
{
  const sizes = tokens.filter((t) => /^--text-(2xs|xs|sm|md|lg|xl|2xl|3xl|4xl)$/.test(t.name));
  if (sizes.length) {
    add('type-scale', {
      name: 'Type scale',
      group: 'Type',
      subtitle: 'Nine steps. The small end does the work — labels, captions and mono all sit at 11-13px — and the large end is for one thing per screen.',
      body: `<div class="grid">${sizes.map((t) => `<div class="sw">
        <span style="font-size: var(${t.name}); font-family: var(--font-sans); font-weight: var(--weight-semibold); color: var(--text-primary); min-width: 220px;"
          data-token="${t.name}" data-prop="font-size">Stack UI</span>
        <div class="meta"><span class="tok">${t.name}</span><span class="val">${esc(t.resolved)}</span></div>
      </div>`).join('')}</div>`,
    });
  }
}

// 11: the composites — the tokens you should actually reach for.
{
  const comps = tokens.filter((t) => t.name.startsWith('--type-'));
  if (comps.length) {
    add('type-composites', {
      name: 'Type composites',
      group: 'Type',
      subtitle: 'Weight, size, leading and family in one `font:` shorthand. Reach for these before the raw scale — each one is a whole typographic decision already made.',
      note: 'Usage: <b>font: var(--type-body-sm);</b> — not four separate declarations.',
      body: `<div class="grid" style="gap: var(--space-7)">${comps.map((t) => `<div>
        <div style="font: var(${t.name}); color: var(--text-primary);"
          data-token="${t.name}" data-prop="font-size" data-expect="${esc(byName.get((/var\((--text-[a-z0-9]+)\)/.exec(t.value) || [])[1] || '')?.resolved || '')}">The quick brown fox — ${t.name.replace('--type-', '')}</div>
        <div class="val" style="margin-top:4px">${t.name} &middot; ${esc(t.value)}</div>
      </div>`).join('')}</div>`,
    });
  }
}

// 12: mono.
if (has('--font-mono')) {
  add('type-mono', {
    name: 'Mono',
    group: 'Type',
    subtitle: 'Every identifier the system shows a human: branch names, ids, hashes, counts, timestamps. If it can be typed back into a terminal, it is mono.',
    body: `<div class="grid">
      <div style="font: var(--type-code); color: var(--text-secondary);"
        data-token="--font-mono" data-prop="font-family">feat/440-board-columns</div>
      <div style="font: var(--type-code); color: var(--text-link);">#440</div>
      <div style="font: var(--weight-medium) var(--text-xs)/1 var(--font-mono); color: var(--text-tertiary);">03c16ba &middot; 17m ago</div>
      <div style="font: var(--type-eyebrow); letter-spacing: var(--tracking-caps); text-transform: uppercase; color: var(--text-tertiary);">in review</div>
      <div class="val" style="margin-top: var(--space-5)">${esc(byName.get('--font-mono').value)}</div>
    </div>`,
  });
}

// 13-14: spacing and radius, drawn to scale.
{
  const space = tokens.filter((t) => /^--space-\d+$/.test(t.name));
  if (space.length) {
    add('spacing', {
      name: 'Spacing',
      group: 'Foundations',
      subtitle: 'A 13-step scale. Gaps inside a component come from the low end (2-8px); the high end separates sections and frames the page.',
      body: `<div class="grid" style="gap: var(--space-4)">${space.map((t) => `<div class="sw">
        <span style="width: var(${t.name}); height: 16px; background: var(--action-accent); border-radius: var(--radius-xs); flex:none;"
          data-token="${t.name}" data-prop="width"></span>
        <div class="meta"><span class="tok">${t.name}</span><span class="val">${esc(t.resolved)}</span></div>
      </div>`).join('')}</div>`,
    });
  }
  const radius = tokens.filter((t) => t.name.startsWith('--radius-'));
  if (radius.length) {
    add('radius', {
      name: 'Radius',
      group: 'Foundations',
      subtitle: 'Seven steps. Controls take sm/md, cards take lg/xl, and pill is for anything that reads as a tag.',
      body: `<div style="display:flex; gap:var(--space-6); flex-wrap:wrap;">${radius.map((t) => `<div style="text-align:center">
        <div style="width:76px; height:76px; background: var(--surface-card); border: 1px solid var(--border-default); border-radius: var(${t.name});"
          data-token="${t.name}" data-prop="border-top-left-radius"></div>
        <div class="tok" style="margin-top:6px">${t.name.replace('--radius-', '')}</div>
        <div class="val">${esc(t.resolved)}</div>
      </div>`).join('')}</div>`,
    });
  }
}

// 15: elevation.
{
  const shadows = tokens.filter((t) => t.name.startsWith('--shadow-') || t.name.startsWith('--ring-'));
  if (shadows.length) {
    add('elevation', {
      name: 'Elevation',
      group: 'Foundations',
      subtitle: 'A resting card has NO shadow in this system. Elevation marks what floats — menus, dialogs, a card under the cursor — and the rings mark what has focus.',
      body: `<div style="display:flex; gap:var(--space-8); flex-wrap:wrap;">${shadows.map((t) => `<div style="text-align:center">
        <div style="width:120px; height:76px; background: var(--surface-card); border-radius: var(--radius-lg); box-shadow: var(${t.name});"
          data-token="${t.name}" data-prop="box-shadow"></div>
        <div class="tok" style="margin-top:10px">${t.name}</div>
      </div>`).join('')}</div>`,
    });
  }
}

// 16: motion — animated, because a duration you cannot feel is a number.
{
  const durs = tokens.filter((t) => t.name.startsWith('--dur-'));
  const eases = tokens.filter((t) => t.name.startsWith('--ease-'));
  if (durs.length) {
    add('motion', {
      name: 'Motion',
      group: 'Foundations',
      subtitle: 'Four durations and three easings. Controls use --transition-control so hover and focus feel identical everywhere; anything longer than --dur-slow is a scene change, not a control.',
      body: `<style>
        @keyframes slide { from { transform: translateX(0); } to { transform: translateX(180px); } }
        .runner { width: 26px; height: 26px; border-radius: var(--radius-sm); background: var(--action-primary);
                  animation: slide 1.6s infinite alternate; }
        @media (prefers-reduced-motion: reduce) { .runner { animation: none; } }
      </style>
      <section><h2>Durations</h2><div class="grid">${durs.map((t) => `<div class="sw">
        <div style="width:220px; background: var(--surface-raised); border-radius: var(--radius-sm); padding:4px;">
          <div class="runner" style="animation-duration: calc(${t.resolved} * 6); transition-duration: var(${t.name});"
            data-token="${t.name}" data-prop="transition-duration"></div></div>
        <div class="meta"><span class="tok">${t.name}</span><span class="val">${esc(t.resolved)}</span></div>
      </div>`).join('')}</div></section>
      <section><h2>Easings</h2><div class="grid">${eases.map((t) => `<div class="sw">
        <span class="tok" style="min-width:170px">${t.name}</span><span class="val">${esc(t.resolved)}</span>
      </div>`).join('')}</div></section>`,
    });
  }
}

// 17: THE ALIAS CARD — the one that makes this Stack's system and not the kit's.
{
  const aliases = tokens.filter((t) => t.layer === 2);
  if (aliases.length) {
    add('stack-aliases', {
      name: 'Stack names',
      group: 'Foundations',
      subtitle: `Layer 2: ${aliases.length} names of Stack's own, aliased onto the kit tokens. Both vocabularies are live and identical — --paper IS --surface-canvas — and the app's own CSS reads these.`,
      viewport: '900x900',
      note: 'Two traps this layer encodes. <b>--ink is near-WHITE</b>, so anything inverting to white on it vanishes. And <b>a fill tone is not a text tone</b>: --accent and --critical are grounds sized for white text ON them; as a `color` they fail AA, which is why --accent-text and --critical-text exist.',
      body: `<div class="grid" style="gap: var(--space-3)">${aliases.map((t) => `<div class="sw">
        <div class="chip" style="width:34px;height:26px;${isColour(t) ? `background: var(${t.name});` : 'background: transparent; border-style: dashed;'}"
          ${isColour(t) ? `data-token="${t.name}" data-prop="background-color"` : ''}></div>
        <div class="meta"><span class="tok">${t.name} <span style="color:var(--text-tertiary)">&rarr;</span> ${esc(t.value)}</span>
        ${t.trail ? `<span class="why">${esc(t.trail)}</span>` : `<span class="val">${esc(t.resolved || '')}</span>`}</div>
      </div>`).join('')}</div>`,
    });
  }
}

// --- write ------------------------------------------------------------------

mkdirSync(join(OUT, 'guidelines'), { recursive: true });
for (const [file, html] of cards) {
  writeFileSync(join(OUT, 'guidelines', `${file}.card.html`), html);
  console.log(`  guidelines/${file}.card.html`);
}

// THE README, header + generated index. The header is authored prose
// (.design-sync/conventions.md, the `readmeHeader` key) and is inlined into a
// design agent's system prompt; the index below it is generated, so it can
// never claim a card or a token file that this build did not emit.
const header = readFileSync(join(REPO, '.design-sync/conventions.md'), 'utf8').trimEnd();
const groups = new Map();
for (const [file, html] of cards) {
  const g = /group="([^"]+)"/.exec(html)?.[1] || 'Other';
  const name = /name="([^"]+)"/.exec(html)?.[1] || file;
  const sub = /subtitle="([^"]*)"/.exec(html)?.[1] || '';
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push({ file, name, sub });
}
const tokenFiles = readdirSync(join(OUT, 'tokens')).sort();
const counts = Object.fromEntries(tokenFiles.map((f) => [f,
  (readFileSync(join(OUT, 'tokens', f), 'utf8').match(/^\s*--[A-Za-z0-9-]+\s*:/gm) || []).length]));

writeFileSync(join(OUT, 'README.md'), `${header}

---

## What is in this project

${tokens.length} tokens, ${tokens.filter((t) => t.layer === 2).length} of them Stack's own alias
layer, and ${cards.length} guideline cards. **No components yet** — this sync covers the palette;
Stack's components live in an app rather than a published library and are a later run.

Everything here is generated from \`web/src/styles.css\` in the Stack repo by
\`.design-sync/tokens-split.mjs\` and \`.design-sync/cards.mjs\`, so nothing in it is retyped and
nothing can drift from the app. Re-run those two after any palette change.

### Tokens

| File | Tokens |
|---|---|
${tokenFiles.map((f) => `| \`tokens/${f}\` | ${counts[f]} |`).join('\n')}

\`styles.css\` @imports all of them plus the two webfonts. A rendered design receives only that
closure, so if it is not reachable from \`styles.css\` it does not exist.

### Guidelines

${[...groups].map(([g, list]) => `**${g}**\n\n${list.map((c) => `- \`guidelines/${c.file}.card.html\` — **${c.name}**: ${c.sub}`).join('\n')}`).join('\n\n')}
`);
console.log('  README.md');

console.log(`\n${cards.length} cards generated from ${tokens.length} parsed tokens`);
