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
and `head` commit hashes, optional `includeWorkingTree`, `note` and bounded `maxSeconds`.
`GET .../runs/:id` returns its captured spec, state and structured evidence. Identical request IDs
return the same job without rewriting its input. The worker uses `POST .../start` and `.../result`;
the latter cannot overwrite paused work. Reports are kept in the existing job ledger, not a new
task system. Automatic specialist schedules are not enabled by these operations.
