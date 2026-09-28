# scripts/ — host CLI, autopilot and tests

The root `CLAUDE.md` holds the cross-package rules (mirrored predicates, run gates, fail-safe
directions). This file holds what applies only here. These file headers carry their own rules; read
one before editing its file: `stack-autopilot-dispatch.mjs`, `lib/autoverdict.mjs`, `lib/refine.mjs`,
`lib/worktree.mjs`, `lib/lane.mjs`.

## The autopilot

- **The nightly is how this repo builds itself.** Any change to `stack-autopilot.mjs` is a real
  behaviour change. For example, it still inlines its own `git worktree add/remove` rather than
  calling `lib/worktree.mjs`, and that is deliberate.
- The runner's pick is one of three copies of the run order, the approval predicate and the area
  lane (see root). No active sprint means it logs that and does nothing.
- **Per-project serialisation is not a knob**: every job runs against the one checkout at
  `$STACK_AUTOPILOT_ROOT/<slug>`. The host lockfile's name sanitiser is spelled in both the runner
  and the dispatcher's kill path; the dispatcher's header says what diverging costs.
- `heldByArea` reports only lane holds. A job waiting on the fleet cap is not held by an area.
- A refine round continues the item's own branch (`lib/refine.mjs`) and is never auto-merged or
  auto-verdicted.
- Auto-verdict conditions are in `lib/autoverdict.mjs`'s header, including the unmet "visible" leg,
  which is a debt. A refine round and a limit-hit run are never machine-verdicted.

## Branches

`lib/lane.mjs` is the canonical namer and parser (`<kind>/<id>-<summary>`; kinds feat · fix · ui ·
refactor · perf · test · docs · chore). It must keep parsing legacy `auto/item-N-<slug>` branches,
which are still on origin and in live `claimed_by` strings, with kind `''`. `web/src/lib/branch.ts`
is its twin.

## The CLI and tools

- `./stack` sub-commands that write are dry until `--run`.
- `lib/worktree.mjs` fails safe both ways (its header says why). Trees live at
  `~/.stack/worktrees/<key>`, inside the $HOME cwd jail the terminal daemon enforces; move the root
  out of $HOME and browser access breaks silently.
- `stack-context.mjs` exports `templates/stack-agent-context.md` verbatim.
- `roadmap-refs.mjs` checks `#id` citations against the board. Roadmap items, futures and bugs are
  separate id sequences all cited as `#N`, so check which table a number refers to.

## Tests

- `*.test.mjs` here are mostly pure: `node scripts/<name>.test.mjs`.
- `spine.test.mjs` runs `web/src` TypeScript under Node's type-stripping loader. Follow that pattern
  for client coverage.
- `playwright/smoke.mjs` **fails loud**: it exits 0 only on a clean pass, because an unreachable app
  reporting zero findings is a false green. Driving Playwright by hand needs the rootless dependency
  prefix (`playwright/setup-browser-deps.sh`). Files named `playwright/_*.mjs` are throwaway probes.
- `context-budget.test.mjs` guards every CLAUDE.md. Over budget means cut, not raise.
