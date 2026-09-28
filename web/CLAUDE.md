# web/ — the client

The root `CLAUDE.md` holds the cross-package rules (mirrored predicates, fail-safe directions). This
file holds what applies only here. These file headers carry their own rules; read one before editing
its file: `lib/branch.ts`, `lib/plan.ts`, `lib/quality.ts`, `lib/termClipboard.ts`, `lib/termLaunch.ts`, `styles.css`,
`components/Brandmark.tsx`, `components/RoadmapModal.tsx`, `components/Asking.tsx`,
`detail/Board.tsx`, `detail/Roadmap.tsx`, `detail/ForYou.tsx`, `detail/Plans.tsx`,
`detail/SessionPlans.tsx`, `detail/PlanToItems.tsx`, `lib/planUnits.ts`, `components/Markdown.tsx`.

## Structure

- **`store.ts` is the only module that touches the network or device storage.** Components never
  `fetch` and never touch localStorage. `request()` attaches the bearer and throws `AuthError` on
  401, which clears the token and returns to the gate.
- **`lib/route.ts` is a hash router, and the tab decides what `hl` means.** A tab that doesn't use a
  highlight ignores it rather than 404ing. Legacy route spellings fall through to Overview.
- **For you is three route keys on one screen** (`overview`, `activity`, `auto`), switched by a strip
  that writes the key. Don't collapse them into component state.
- **A recurring re-fetch goes through `lib/autoRefresh.ts`.** One device-local setting governs every
  screen that polls the host, and it also stops a hidden tab polling — except `whileHidden`, whose
  one caller is the #519 notifier while desktop notifications are on (its job is the unwatched tab).
- `lib/brief.ts` holds the `DIRECTIVES` catalogue, whose keys mirror the server's
  `SESSION_DEFAULTS`.

## Which screen a row is on

`homeOf` (`lib/plan.ts`) is the one function that decides, returning `auto | roadmap | board`. A row
on two screens gets acted on twice; a row on none has silently vanished.

- **Auto-ideas** (For you): a held row (`hook`/`fly`, not signed off) that nobody has worked.
- **Roadmap**: a kept idea, either a child (`parent_id`) or a signed-off row with `committed` false.
- **Board**: everything else. **Once anybody has worked a row** (a claim, a `built_note` or a tick:
  `isWorked`), it's board work whatever its sign-off says. Its hold then only gates the runner, and
  the board shows it (the `held` chip, answered from the card menu).
- **Promoting is two writes with two meanings**: Roadmap sends `{reviewed:true, committed:false}`
  ("keep this"); board sends `{reviewed:true, committed:true, parentId:null}` ("do this").
  `committed` defaults true, is read `!== false` on both sides, and no other PATCH branch touches it.
- **The board is for work we know we'll build; the Roadmap is for ideas** (owner's call). A
  hand-typed idea is kept on Roadmap by `committed` false, not by a hold (a manual row is never
  held). New idea files a free-standing one in the scoped area; ＋ on a board item files one under it.

## Ordering

- **`queueOrder` is the client twin of the runner's sort**, curried on the active sprint's id, and
  stable over the order the server already sent.
- `position` is a different number: scoped to the bucket, still PATCHable, and written by nothing in
  the client. The kanban has no within-column drag because its columns cut across buckets.
- `points` is unitless and NULL means unset, never zero in a total. `estimate` is in weeks, and
  `defaultLen` in `lib/plan.ts` is the one place weeks and schedule minutes meet. `due_on` is a day
  (use `dayOf`, never `toISOString`) and gates nothing.

## Mockups

Several screens are kit mockups being wired back one at a time. **Each wears a Mock chip**, on the
rail row or on the sub-tab itself where a tab is only partly wired; a chip over a wired view warns
about the wrong thing. **A number must agree with the screen behind it**: a wired badge shows a real
count, a mockup's badge shows the mockup's count.

Not reachable from a browser (use `./stack` and the API): a verdict, labels, the ⎇ claim, `automode`,
and writing the stored schedule.

## Derived state

- **Quality's five severities are derived, never a column** (`lib/quality.ts`). No grade of rank ≤ 3
  may depend on `check_results`, or the rail badge (off the payload) and the screen (which fetches
  history) stop counting the same rows.
- **A branch's merge state is derived, never stored** (`lib/branch.ts`). `unprobed` is not `clean`.

## Visual rules

- **The palette is the `:root` variables in `styles.css`, in two layers**: kit tokens, then Stack's
  aliases. Its header lists the traps. Never an inline hex.
- **The logo is drawn only by `components/Brandmark.tsx`**, and its geometry is copied in two scripts
  (see root). Move a plate, move all three, and re-run `scripts/render-icons.mjs`.
- `lib/termClipboard.ts`: ⌃C, ⌃V and OSC 52 each behave unlike a native terminal on purpose. Don't
  "simplify" them.

## Verifying a change

1. `npm run build` (strict).
2. `./stack ui-smoke` for layout.
3. `scripts/run-palette-audit.sh` if you touched tone. It measures the ground actually painted behind
   text; text it can't measure is its own bucket, never a pass.

Client logic can be tested from Node: `scripts/spine.test.mjs` runs `web/src` TypeScript directly
under Node's type-stripping loader. Follow that pattern.
