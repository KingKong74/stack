# Agents, skills and terminal configuration

Stack stores reusable spawn profiles and skills in Postgres. Skills have explicit Claude/Codex
targets and optional text resources; their revision covers the complete bundle. The host discovers
verified checkouts and Git worktrees, installs only managed files and reports actual disk hashes.
Unmanaged directories and symlink traversals are refused. Generated project skills use local Git
excludes. Installation evidence expires after 15 minutes and does not prove model invocation.

New Stack Terminal sessions prepare compatible skills and optional Claude profiles before spawn.
Their launch snapshot records the runtime/version, checkout, branch, HEAD, dirty-tree state,
supplied revisions and context-delivery limitations. Reconnect reads the original tmux-keyed
snapshot without replaying a task. The Configuration dialog compares it with the current library;
runtime skill discovery may independently observe newer files. External/older sessions remain
unknown. Codex profile delegation, lifecycle and usage capture are not integrated.

The daemon advertises profile-delivery capabilities. After installing new host code, restart the
terminal daemon when it is appropriate to detach active browser clients. Until it advertises the
capability, the UI refuses profile selection instead of pretending an older daemon supplied it.
CLI account/model configuration remains the owner's; no provider fallback is added.

## Stack specialists

Source skills live under `skills/stack-*`. `node scripts/stack-specialists.mjs` previews the library
installation; `--run` creates missing skills and profiles. Repeating it preserves matching records
and refuses to overwrite differing human-authored content. These profiles link Stack-scoped
skills so generic fleet executor/reviewer defaults do not acquire project-only requirements.

The Builder implements scoped work; Reviewer reads correctness/verification evidence; Devil's
Advocate challenges open assumptions; Code Architect traces boundaries/contracts; Exterminator
investigates and deduplicates bugs. The three read-only specialists have no shell/write tools.
Exterminator has Bash for bounded investigation in disposable worktrees and is not read-only.
Findings are annotations; human verdicts, Ready membership and fixing authority stay separate.

## Manual diagnostic passes

The profile editor's **Run diagnostic** captures an exact base/head pair and an optional tracked
working-tree scope. It queues a `specialist` job in the existing dispatcher lane, respecting fleet
and per-project serialisation. Builder implementation uses a terminal, not this diagnostic path.

The host reads the requested Git diff and calls native Claude once in a neutral scratch directory
with every tool, MCP server and skill invocation disabled. Only a native subscription login is
accepted; there is no API-key fallback. A diagnostic cannot execute a reproduction, write files or
give a verdict. Its report states that verification commands were not executed. Empty findings
are valid; no model output is an error. Input/output and duration caps are explicit. Pausing a job
cancels the process; late completion cannot overwrite a paused or completed state.

A CLI alternative, dry until `--run`:

```bash
node scripts/stack-specialist-run.mjs --profile stack-reviewer --base HEAD^ --head HEAD
```

The API is `POST /api/projects/:slug/specialists/runs` with `requestId`, `profileKey`, full `base`
and `head` commit hashes, optional literal `paths` (up to eight), `includeWorkingTree`, `note` and bounded `maxSeconds`.
`GET .../runs/:id` returns its captured spec, state and structured evidence. Identical request IDs
return the same job without rewriting its input. The worker uses `POST .../start` and `.../result`;
the latter cannot overwrite paused work. Reports are kept in the existing job ledger, not a new
task system. Automatic specialist schedules are not enabled by these operations.

## Observation policies

Project **Loops** stores real diagnostic policies; the sample merge/prune chains are removed.
Creating a policy always leaves it disabled. Enabling only allows eligibility checks: it does not
bypass the global arm switch, quiet hours, usage-limit hold or existing fleet/project claim gates.
The existing minute dispatcher polls enabled policies, reads exact host Git revisions and queues
eligible passes through the same diagnostic adapter. There is no second scheduler. A missing API,
checkout, revision or usage record starts no pass. A first pass compares HEAD with its parent;
later passes compare the last queued HEAD. Divergent history requires investigation.

Policies show their trigger, literal paths, cooldown, run cap, token budget and last reported stop
reason. `GET /api/specialist-loops` is the host's aggregate enabled-policy feed. Project endpoints
under `/api/projects/:slug/specialists/loops` list/create policies, PATCH `{enabled}`, and POST
`/:id/dry-run` or `/:id/dispatch` with exact base/head, connected and localMinutes. Dry-run changes
nothing and browser simulation assumes host availability without certifying it. Scope and limits
are immutable; create a new disabled policy to replace them. DELETE removes only disabled policies and retains their diagnostic ledger. Disabling atomically pauses its
queued/active diagnostics; existing cancellation polling stops an active child.

Each project shares one rolling 24-hour diagnostic population across its policies and manual runs.
A successful manual pass with the same profile, skill revisions and model must exist in that window.
A pass reserves 60,000 tokens before starting; actual reported input/output/cache tokens replace
that reservation on completion. This is a start gate, not a hard per-call token ceiling. Missing,
partial or negative usage holds further passes. Attempts include failures and pauses. Unchanged
HEAD, an active diagnostic, cooldown, exhausted caps or three recent failed passes also hold.
Reports annotate evidence only; they never file fixes, move Ready work, merge or give a verdict.
No observation policy has been enabled as part of installation or verification.

### Controlled pilot and repair handoff

Run `scripts/specialist-loop-pilot.test.mjs` with DATABASE_URL pointing at a fresh throwaway
Postgres database (unset STACK_API). It exercises actual policy routes, temporary Git commits,
the host sweep, existing claim SQL and result recording. Native output is injected: this check
proves orchestration, not account availability or model judgement. It covers dispatcher restarts,
repeated heads, cooldown, global disarm, empty selected input, disabling queued work and late
results. A failed/paused call without usage blocks another attempt instead of treating it as free.

Before owner activation, deploy the checked server/web revision, verify the host terminal's
capabilities, and complete a manual diagnostic for each intended profile. Check that the stored
base/head, profile/skills, supplied files and blind spots match what actually ran. Native output
may contain hypotheses, which remain qualifications beside each finding; a completed call is not
a human verdict or a passing verification suite. A narrow diff can leave important helpers unseen.
Use the eligibility simulation, then inspect the host's real stop reason before choosing to enable.

Begin with one Reviewer or Exterminator policy, explicit literal paths, a long cooldown and a small
attempt cap. Keep automatic fixes out of this pilot. To repair a substantiated finding, the owner
creates or approves a scoped item in the existing planning/Ready workflow. The existing Builder
runner then applies its normal approval, slice, claim, verification and review gates. Observation
reports themselves cannot commission that work. Retain the original run ID/revisions as evidence;
repeated reports of the same trigger do not authorise additional fixes.
