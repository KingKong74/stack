# web/ — the client

The root `CLAUDE.md` holds the cross-package rules (mirrored predicates, fail-safe directions). This
file holds what applies only here. These file headers carry their own rules; read one before editing
its file: `lib/branch.ts`, `lib/plan.ts`, `lib/quality.ts`, `lib/termClipboard.ts`, `lib/termLaunch.ts`, `styles.css`,
`components/Brandmark.tsx`, `components/RoadmapModal.tsx`, `components/Asking.tsx`,
`detail/Board.tsx`, `detail/BoardMap.tsx`, `lib/workMap.ts`, `detail/BoardFocus.tsx`, `detail/ForYou.tsx`, `detail/Plans.tsx`,
`detail/Development.tsx`, `detail/SkillsAgents.tsx`, `detail/Loops.tsx`, `detail/Artifacts.tsx`, `detail/Spine.tsx`,
`detail/Architecture.tsx`, `detail/Course.tsx`,
`components/Markdown.tsx`.

## Structure

- **`store.ts` is the only module that touches the network or device storage.** Components never
  `fetch` and never touch localStorage. `request()` attaches the bearer and throws `AuthError` on
  401, which clears the token and returns to the gate.
- **`lib/route.ts` is a hash router, and the tab decides what `hl` means.** A tab that doesn't use a
  highlight ignores it rather than 404ing. Legacy route spellings fall through to Overview.
- **For you is two route keys on one screen** (`overview` = Course, the project home since #622;
  `activity`), switched by a strip that writes the key. `auto` is the board's Propositions tab: Board
  writes it back through `onRoute`, so its links survive. Don't collapse route keys into component state.
- **A recurring re-fetch goes through `lib/autoRefresh.ts`.** One device-local setting governs every
  screen that polls the host, and it also stops a hidden tab polling — except `whileHidden`, whose
  one caller is the #519 notifier while desktop notifications are on (its job is the unwatched tab).
- `lib/brief.ts` holds the `DIRECTIVES` catalogue, whose keys mirror the server's
  `SESSION_DEFAULTS`.

## Which screen a row is on

`homeOf` (`lib/plan.ts`) is the one function that decides, returning `auto | icebox | board`. A row
on two screens gets acted on twice; a row on none has silently vanished.

- **Auto-ideas** (Board → Propositions, route key `auto`): a held row (`hook`/`fly`/`plan`, not signed off) that
  nobody has worked and that is in no slice. Promote sends `{reviewed:true, parentId:null}` plus the picked `sliceId`.
- **Icebox** (#608, same pane): signed off or manual, in no slice.
- **Board**: sliced rows, held or not (a held row is `Held` on the map and signs off from its
  menu). **Once anybody has worked a row** (a claim, a `built_note` or a tick: `isWorked`), it's
  board work whatever its sign-off or slice says (an unsliced one hangs straight off the project).
  Its hold then only gates the runner.
- **The board is designed for the owner's hands** (2026-11-02). Weigh UX, not automation policy,
  when changing it; the run gates live in the root file and the server.
- **A task and its tickets** (parts, `parent_id`, one level deep). The task's stage is rolled up
  from its parts (`clusterKeyOf`); a part whose task is off the board is an ordinary task again.
- **The Board tab is the work map** (`detail/BoardMap.tsx`): Map (a tree) and Lanes (a lane per
  job), with every write borrowed from `Board.tsx`. There is no kanban and no List (owner's
  calls, 2026-11-20). Map and Lanes must agree on what is on the board.
- **There is no Roadmap tab** (owner's call, 2026-10-28). The `canvas` column is dormant: nothing
  writes or serves it. Don't bring back a third home without changing `homeOf` with it.

## Ordering

- **`queueOrder` is the client twin of the runner's sort**, given the current milestone's ordered
  live slice IDs. Ready rank leads, then slice order and item `sliceRank`, then bucket; ties keep
  the order the server already sent.
- `position` is a different number: scoped to the bucket, still PATCHable, and written by nothing in
  the client.
- `points` is unitless and NULL means unset, never zero in a total. `estimate` is in weeks, and
  `defaultLen` in `lib/plan.ts` is the one place weeks and schedule minutes meet. `due_on` is a day
  (use `dayOf`, never `toISOString`) and gates nothing.

## Mockups

Several screens are kit mockups being wired back one at a time. **Each wears a Mock chip**, on the
rail row or on the sub-tab itself where a tab is only partly wired; a chip over a wired view warns
about the wrong thing. **A number must agree with the screen behind it**: a wired badge shows a real
count, a mockup's badge shows the mockup's count.

Not reachable from a browser (use `./stack` and the API): labels, the ⎇ claim, writing the stored
schedule, a merge, automode and the loop's mode. **The verdict is on the work map** (its details
panel; Lanes' menu has Approve). Approve ticks too; Send back writes `refine_note` and releases the
claim; `Board.tsx` says why.

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
