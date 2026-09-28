# terminal/ — the web terminal's host daemon

The root `CLAUDE.md` holds the cross-package rules. This file holds what applies only here. These
file headers carry their own rules; read one before editing its file: `agent-run.mjs`,
`model-switch.mjs`, `cli-registry.mjs`, `drop-file.mjs`.

- **The daemon dials out** to the server; the server can't reach the host. Run it by hand with
  `node terminal/stack-term.mjs` (normally the @reboot cron line). Logs: `~/.stack/term.log`.
- **The host is shared with other apps and the owner's live sessions.** Kill by exact session name,
  never a broad `pkill` pattern. Restarting the daemon detaches live sessions.
- **`prompt-scan.mjs` is pure and leans hard towards null.** A false block puts an Approve button in
  front of a question nobody asked, which is far worse than a real block noticed late.
- **`input-wait.mjs` (#519) is the OTHER stop, and the one the owner's sessions make**: bypass
  permissions means `prompt-scan` never fires for him. It reads a STYLED capture (`-e`), because
  claude's dimmed input suggestion is indistinguishable from a typed draft in a plain one. Same lean
  towards null; the daemon confirms a candidate across two reads before advertising `waiting`.
- **`edit-watch.mjs` reads who is editing what from transcripts, not git.** Two sessions in one
  checkout share a dirty tree, so git can't say who wrote what.
- **`agent-run.mjs` is unused but kept** as the reference host-side model call. Its sandbox (every
  tool off, a cwd that isn't a repo) exists because it ran prompts built from text somebody else
  wrote. Read it before writing the next host-side model call.
- **Provider keys resolve `process.env` → `~/.stack/env` → `~/.ccm_config`** through
  `model-switch.mjs`. Every reader goes through it, because a standalone script hasn't loaded
  `~/.stack/env`. `./stack models` reports the source and a character count, never the key.
- **A launch-only runtime (`cli-registry.mjs`) isn't a Stack session**: no branch claims are injected
  into it.
- **The OmniRoute gateway is host-side only**, bound to loopback by Docker's `-p 127.0.0.1:` (it binds
  0.0.0.0 whatever its own vars say). The server container can't reach it; routing server calls
  through it needs a compose service, which is a decision, not a tidy-up.
- **`termIdleHours` switches both reapers**: the host idle reaper and the daemon's one-minute unused
  sweep. Both fail safe: an unknown threshold reaps nothing.
- **Drops go to `~/.stack/drops`**, never the session's cwd (a stray screenshot in a repo gets
  committed). Pruning deletes, so it fails safe.
