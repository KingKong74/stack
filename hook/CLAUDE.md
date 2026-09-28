# hook/ — Claude Code hooks and the /checkpoint poster

The root `CLAUDE.md` holds the cross-package rules. This file holds what applies only here.

- **`~/.stack/` holds copies, not symlinks.** Editing a file here changes nothing until you run
  `cp hook/*.mjs ~/.stack/`. When a fix seems inert, `diff hook/<f> ~/.stack/<f>`.
- **Both hooks always exit 0** and log only to stderr: they must never block Claude Code starting or
  stopping. `stack-checkpoint.mjs` is a poster, not a hook, so it may exit non-zero; it never prints
  a token.
- **Both hooks fail open**: an unreachable API reads as "on", so the degradation is to recording, not
  silence.
- **SessionStart is registered without `async`** (SessionEnd stays `async`). Its `additionalContext`
  must be captured synchronously to land in the session. It guards the API call with a short timeout
  and emits nothing on any miss.
- **SessionEnd posts the commit this session made**, read from its own `git commit` results in the
  transcript. It falls back to `git rev-parse HEAD` only when the session committed nothing, since
  HEAD is wrong whenever sessions run in parallel in one checkout.
- **A subagent's usage is in its own transcript, not the parent's** (`stack-session-end.mjs` says
  where). Subagent spend is often the larger half. A lost transcript reads as unpriced, not free.
  Neither source counts every delegation, so `agent_calls` is the max of the two.
- **`/checkpoint`** is authored by the session itself (`.claude/commands/checkpoint.md`) and piped to
  `stack-checkpoint.mjs`, which sets `authored:true`, fills commit/branch from git and posts to
  `/api/ingest` with the token from `~/.stack/env`. SessionEnd is the silent metadata backstop.
- Tokens come only from `~/.stack/env`, never the shell profile or settings.json.

```bash
node hook/stack-session-start.mjs --demo    # print the resume block
node hook/stack-session-end.mjs --demo      # fire the backstop
node hook/stack-checkpoint.mjs --settings   # current settings, as /checkpoint reads them
node hook/stack-gemini-review.mjs --dry     # second-model review of the last commit (--architect too)
```
