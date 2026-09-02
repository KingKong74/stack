# Stack UI

A dark-only console palette. Everything here is **CSS custom properties** — there is no
component library in this project yet, so build with plain elements and style them with these
tokens. Do not reach for `window.*` components; there are none to reach for.

## Setup

Load `styles.css` and nothing else — its `@import` closure carries the whole system: the two
webfonts, then the tokens. No provider, no wrapper, no theme attribute.

```html
<link rel="stylesheet" href="styles.css">
<body style="background: var(--surface-canvas); color: var(--text-primary); font: var(--type-body);">
```

**The app is dark-only.** There is no light counterpart, so state every colour once and never
write a `prefers-color-scheme` or `[data-theme]` branch — the second branch would have no values
to use.

## The idiom: style by ROLE, not by ramp step

The ramps (`--grey-*`, `--blue-*`, `--lime-*`, `--red-500`, `--amber-500`) exist so the roles have
somewhere to point. Reach for a role. Touch a ramp step only when you are building a new role.

| Family | Use | Members |
|---|---|---|
| Surface | every background | `--surface-canvas` (page) · `--surface-sunken` · `--surface-raised` · `--surface-card` · `--surface-overlay` (floats) · `--surface-selected` · `--surface-hover` · `--surface-press` · `--scrim` |
| Text | every foreground | `--text-primary` · `--text-secondary` · `--text-tertiary` · `--text-disabled` · `--text-link` · `--text-link-hover` · `--text-accent` · `--text-inverse` |
| Border | every hairline | `--border-subtle` (separate) · `--border-default` (enclose) · `--border-strong` · `--border-focus` · `--border-accent` |
| Action | anything pressable | `--action-primary` + `-hover`/`-press` · `--action-accent` + `-hover`/`-press` · `--action-danger` |
| Status | state, in pairs | `--status-{success,info,danger,warning,neutral}-bg` with its matching `-fg` |
| Viz | chart series, in order | `--viz-1` … `--viz-6` |
| Space | gaps and padding | `--space-1` (2px) … `--space-12` (80px) |
| Radius | corners | `--radius-xs` … `--radius-2xl`, `--radius-pill` |
| Type | one `font:` each | `--type-display` · `--type-title` · `--type-heading` · `--type-body` · `--type-body-sm` · `--type-label` · `--type-caption` · `--type-code` · `--type-eyebrow` |
| Motion | transitions | `--dur-fast` · `--dur-normal` · `--ease-standard` · `--ease-out` · `--transition-control` |
| Elevation | what floats | `--shadow-sm` · `--shadow-md` · `--shadow-lg` · `--ring-focus` |

Four rules this palette will punish you for breaking:

1. **A fill tone is not a text tone.** `--action-primary` and `--critical` are grounds, sized for
   white text *on* them; used as a `color` they fail AA. The foregrounds are `--text-link` and
   `--status-danger-fg` (Stack names them `--accent-text` and `--critical-text`).
2. **Use a status pair together.** Each `-fg` clears AA on its own `-bg` and nowhere else.
3. **Prefer a type composite.** `font: var(--type-body-sm);` is one declaration instead of four.
4. **A resting card carries no shadow.** Elevation marks what floats or what is under the cursor.

## Two vocabularies, both live

Layer 1 is the kit's (`--surface-canvas`, `--text-primary`). Layer 2 is Stack's own, aliased onto
it — `--paper`, `--surface`, `--ink`, `--accent`, `--live`, `--critical`, `--muted`, `--panel` and
40 more. They are the same values, and Stack's own CSS reads the aliases. **Prefer layer 1 when
writing new work**; read layer 2 when reading Stack's. One trap: `--ink` is near-**white**.

## Where the truth is

`tokens/colors.css`, `tokens/typography.css`, `tokens/spacing.css`, `tokens/elevation.css`,
`tokens/motion.css`, `tokens/aliases.css` — all reachable from `styles.css`. Read them before
styling; the guideline cards under `guidelines/` show every one of them rendered.

## Building with it

```html
<article style="background: var(--surface-card); border: 1px solid var(--border-subtle);
                border-radius: var(--radius-lg); padding: var(--space-5);
                display: flex; flex-direction: column; gap: var(--space-4);
                box-shadow: var(--shadow-sm); transition: var(--transition-control);">
  <span style="font: var(--type-body-sm); color: var(--text-primary);">Row recycling on scroll</span>
  <div style="display: flex; align-items: center; gap: var(--space-3);">
    <span style="font: var(--weight-medium) var(--text-xs)/1 var(--font-mono);
                 color: var(--text-link);">#440</span>
    <span style="font: var(--type-label); border-radius: var(--radius-sm); padding: 2px 8px;
                 background: var(--status-info-bg); color: var(--status-info-fg);">In Review</span>
  </div>
</article>
```

Identifiers — ids, branches, hashes, counts, timestamps — are always mono. If it could be typed
back into a terminal, it is `var(--font-mono)`.
