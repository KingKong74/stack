# design-sync notes — Stack

Durable findings. Read this before the next sync; it is what stops the next run
re-discovering the same four things.

## The converter does not apply to this repo, and that is not a fixable config

`web/` is a **private Vite app**, not a published component library: `package.json` is
`"private": true` with no `main`, no `exports`, and `vite build` emits an app bundle (an
`index.html` plus hashed assets), not importable components. There is no Storybook and no
`*.stories.*`. Both converter shapes need a built `dist/` entry to bundle into
`window.<global>.*`, so `package-build.mjs` has nothing to consume — and it cannot even load
here, because the skill's scripts ship without `node_modules` and `esbuild` is not installed.

The base skill's escape hatch is what this repo uses: produce the layout by whatever means the
repo allows. `.design-sync/tokens-split.mjs` and `.design-sync/cards.mjs` are that means.

**Do not "fix" this by pointing the converter at `web/`.** The fix, if components are ever
wanted in the design system, is to give the repo a real library build — a second entry that
exports the presentational components with their own `dist/` and `.d.ts` — at which point the
standard converter applies and this off-script path can be retired.

## The standard gate cannot pass a palette-only bundle, so it was replaced, not skipped

`package-validate.mjs` opens by requiring `_ds_bundle.js` with a `@ds-bundle` header naming a
namespace and a component array, and hard-fails `[NO_DIST]` without one. A sync that ships the
palette and no components can never satisfy it.

`.design-sync/verify-cards.mjs` is the substitute and keeps four of the validator's own checks
(`[RENDER]`, `[LINK_HREF_MISSING]`, `[DSCARD_MISSING]`, `[CSS_IMPORT_MISSING]`) plus one the
validator has no equivalent for: every swatch carries `data-token`/`data-prop`, and the browser
is asked what it actually **painted** there. A swatch whose painted colour is not the token's
own resolved value is a lie about the palette, and an unresolved `var()` paints nothing at all
— which is exactly how a card goes on claiming a token the app has since renamed.

It found five real things on its first runs: four translucent tokens and a shadow set were
comparison bugs in the verifier itself, and `--placeholder` was a genuine card bug (measured but
never painted, because two conditions disagreed about whether a token was a colour). Current
state: **17 cards, 217 checks, 0 findings.**

## The fonts were not in the CSS

`--font-sans` and `--font-mono` name Instrument Sans and JetBrains Mono, and the app loads both
from a Google Fonts `<link>` in **`web/index.html`** — nowhere in `styles.css`. A bundle copying
only the CSS would have shipped two families it does not load, and every design built with it
would have rendered in a fallback with nothing downstream to catch it (the first card
screenshots did exactly that). `tokens-split.mjs` now lifts that same URL out of `index.html`
into the bundle's `styles.css`, so the closure carries the faces. **If the link in
`index.html` changes, re-run the generator — do not edit the bundle.**

## No `_ds_sync.json` is written, on purpose

The anchor's envelope (`bundleSha12`, `renderHashes`, `sourceKeys`, `keyRecipe` …) describes a
component bundle, and there is none. A partial anchor that vouches for nothing is worse than no
anchor: the next sync should re-verify everything, which for 17 generated cards costs seconds.
The base skill names omitting it as the honest choice in exactly this position.

## Two older design-system projects exist

- **Stack Design System** (`3a99f61e-c9cd-4015-992f-14392624dbc1`) — a July 25 sync with 32
  hand-shaped components, tokens and 15 guideline cards. Its palette **predates #432**, which
  replaced `:root` wholesale, so its `tokens/colors.css` and `reference/stack-web-styles.css`
  describe colours the app no longer has. Left untouched deliberately, as a record of the old
  palette; it is the thing to supersede or delete once components land in **Stack UI**.
- **Design System** (`8e6c80f2-7cd9-471b-a939-dc0cdca1d508`) — empty.

## Running it

```bash
node .design-sync/tokens-split.mjs        # web/src/styles.css -> ds-bundle/tokens/*.css
node .design-sync/cards.mjs               # -> ds-bundle/guidelines/*.card.html + README.md
node .design-sync/validate-conventions.mjs # every name the header teaches still resolves
cd scripts/playwright && eval "$(./setup-browser-deps.sh --print-env)" \
  && node ../../.design-sync/verify-cards.mjs --shots
```

The verifier reuses the repo's own pinned playwright and cached chromium (`scripts/playwright`,
#291) — one browser version verifies both the app and this bundle, and it installs nothing. On
this host chromium needs the rootless library prefix, hence the `eval`.
