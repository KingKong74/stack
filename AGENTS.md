# Codex in Stack

Stack is a self-hosted workspace for resuming projects, choosing work, building it and reviewing
the result. Read [GOALS.md](GOALS.md) for direction and [docs/codex.md](docs/codex.md) for the
Codex workflow and its current limits.

## Repository instructions

Read the root [CLAUDE.md](CLAUDE.md) before changing anything. It is the shared source of
cross-package rules, including approval, Ready queues, branch claims, human verdicts, mirrored
predicates, secret handling and fail-safe behaviour. Its rules apply to Codex too; references to
Claude hooks describe that runtime's capabilities, not capabilities Codex automatically has.

Before editing a package, read its `CLAUDE.md`: `web/`, `server/`, `scripts/`, `hook/` or
`terminal/`. Read file-header instructions before changing the file. Keep shared rules there
rather than copying them here. Do not rewrite any `CLAUDE.md` through an agent session: the
existing rule requires a human Save through Mission Control → Context.

## Work safely in the shared checkout

- Inspect `git status --short` and the current branch before editing. Preserve other sessions'
  changes; stage only your own work. Prefer a separate worktree for overlapping changes.
- Codex receives no automatic Stack resume block or branch claims. Read live state using the
  workflow in `docs/codex.md` before selecting board work. If live state is unavailable, report
  that limitation and do not pick unattended work or assume a row is unclaimed.
- Follow the owner's explicit task. Do not create roadmap cards merely to track starting work.
  Never set Ready membership or issue a human verdict. Leave built branch work claimed for review.
- Use en-AU spelling. Do not add paid model calls or change provider/account configuration as a
  side effect of development.

## Verification and handoff

Unless the owner directs otherwise, commit and push this session's changes to `main` after
relevant checks pass. Do not require a separate review branch, mirror preview or further merge
approval by default. This owner instruction takes precedence over conflicting branch or merge
workflow guidance in `CLAUDE.md`. A separate worktree may still be used to protect the shared
checkout. Stage only your own work; preserve other sessions' changes. If checks or the push fail,
report the failure.

Run the relevant checks described in the package guidance. UI changes require the strict web
build and `./stack ui-smoke`; tone changes also require the palette audit. Route or payload changes
require their checks to change with them. Database checks use a throwaway database, never production.

For documentation changes, run `node scripts/context-budget.test.mjs` and `git diff --check`.
Keep this entry point short: goals belong in GOALS.md, setup in docs/codex.md, live task status in
Stack. Report what changed, what was verified, and any remaining limits. A Codex checkpoint is an
explicit poster operation, not a `/checkpoint` slash command or an automatic SessionEnd hook.
