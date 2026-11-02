# Working on Stack with Codex

## Repository setup

Open this repository as the Codex workspace. The root `AGENTS.md` points to the shared rules,
package guidance and project goals. Codex discovers AGENTS.md instructions; it does not
automatically discover this repo's CLAUDE.md files, so the entry point explicitly requires them.
See [official OpenAI documentation](https://learn.chatgpt.com/docs/agent-configuration/agents-md).

No API key, model change, global configuration or new service is needed for these repository
instructions. Existing authenticated Codex access is separate from Stack's API credentials.

## Current integration

| Capability | Codex today |
| --- | --- |
| Repository and package rules | AGENTS.md directs Codex to the existing shared guidance. |
| Launch in Stack Terminal | Select Codex, then open a session; native `codex` runs in tmux. `./stack term --cli codex` also launches natively. |
| Resume context and branch claims | Read explicitly; no automatic Claude SessionStart injection. |
| Rich activity and resume update | Author JSON and invoke the existing checkpoint poster explicitly. |
| SessionEnd backstop, usage and edit watching | No Codex integration; do not infer zero usage or no active edits. |
| Mission Control context editor | Existing implementation manages CLAUDE.md; AGENTS.md support is not added here. |

The Terminal page offers Claude and Codex, plus a utility Shell. It no longer offers gateway
models or provider fallback. Old device routing preferences are ignored. Claude's permission
setting applies only to Claude; Codex uses its own configuration and permissions. A missing CLI
or expired login is reported by the native command in its pane. Install/authenticate each CLI on
the terminal host before using it. Existing sessions retain the process they were started with.

The separate legacy OmniRoute CLI tools are outside this terminal change; the host gateway has
not been uninstalled or stopped.

## Start a task

Read AGENTS.md, the shared rules and the relevant package guidance. Inspect the checkout:

```bash
git status --short
git branch --show-current
./stack tree
```

The branch tree helps navigate work but is not a substitute for current API claims. For live
project state, use a short Node request which keeps credentials inside the process:

```bash
node --input-type=module <<'JS'
import { loadStackEnv } from './hook/stack-post.mjs';
loadStackEnv();
const { STACK_API, STACK_TOKEN } = process.env;
if (!STACK_API || !STACK_TOKEN) throw new Error('Stack access is not configured');
const response = await fetch(`${STACK_API.replace(/\/$/, '')}/api/projects/stack`, {
  headers: { authorization: `Bearer ${STACK_TOKEN}` },
  signal: AbortSignal.timeout(5000),
});
if (!response.ok) throw new Error(`Stack state unavailable (HTTP ${response.status})`);
console.log(JSON.stringify(await response.json(), null, 2));
JS
```

Run this from the Stack repo; for another project use its actual slug. Read the project's
directives, resume fields, Ready order and existing claims. An unavailable API means claims and
live directives are unknown. Continue an explicit local task only where it does not depend on
that missing state; do not select unattended board work. Claim an existing item before starting
it, following `templates/stack-agent-context.md` and the root rules.

Do not run the Claude SessionStart hook as a Codex adapter: it also posts presence and emits
Claude-specific instructions. Codex has no automatic branch-claim protection here.

## Finish a task

Verify the change using the package's required checks. Describe the actual work, verification
and unresolved limits. For a Stack checkpoint, read settings first:

```bash
node hook/stack-checkpoint.mjs --settings
```

Honour `checkpointDetail` and `includeChores` as described in
`.claude/commands/checkpoint.md`. That file is the schema reference; Codex invokes the poster
directly rather than assuming `/checkpoint` exists. A minimal authored payload is:

```json
{
  "project": { "slug": "stack" },
  "session": {
    "summary": "Describe only this session's actual changes and verification.",
    "current_phase": "Workspace integration",
    "in_progress": [],
    "next_up": [],
    "working_well": [],
    "blockers": [],
    "tags": ["codex"]
  },
  "extract": { "bugs": [], "tests": [], "built": [] }
}
```

Compose the real JSON in a temporary file, then post it from the project checkout:

```bash
node hook/stack-checkpoint.mjs < /tmp/stack-checkpoint.json
```

The poster loads `~/.stack/env`, sets `authored: true` and fills commit/branch from git. In a
shared checkout, verify the commit belongs to your work before relying on that fallback. Include
an explicit known commit when needed; do not attribute another session's HEAD to your change.
Leave unknown usage unreported. Never print the token or manufacture model/usage provenance.

Follow-ups belong in `session.next_up`; do not send `next_steps` or `futures`. Only report observed
bugs and test gaps. A `built` entry can mutate board rows: use the checkpoint schema's title/id
guard and only report work actually completed. A successful poster message confirms recording;
an error means the checkpoint was not confirmed. Posting is a live write, so do it as part of an
authorised task handoff, not while testing documentation examples.

## Next integration boundary

Automatic context delivery and Codex lifecycle/usage capture need a separate tested adapter.
Keep the runtime's telemetry declaration honest until those capabilities exist. The stages and
acceptance criteria are in GOALS.md.
