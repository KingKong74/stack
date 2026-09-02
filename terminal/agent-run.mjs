// The tab-agent sandbox (#364) — what makes a `claude -p` run started FOR an
// agent prompt (the Curator's passes; the Auditor, Polaris and the Merge
// room's read were culled with their surfaces) safe to
// run at all.
//
// This is its own file, pulled out of stack-term.mjs, for one reason: it is
// the one thing in that daemon that MUST NOT be able to drift back towards
// the autopilot's posture without someone noticing. An agent prompt is
// assembled from tracker rows — a bug title, a roadmap note, a branch diff —
// and a tracker row is text somebody else wrote. If a crafted row could talk
// the model into a tool call, its author would have a shell on this host.
// So the run gets EVERY tool disabled (`--disallowed-tools` plus
// `--permission-mode plan`, belt and braces) and a scratch cwd that is not a
// repo, so the worst case of a tool slipping through a future CLI change is
// an empty directory rather than the source. Pure and side-effect-free on
// import so `server/test/agent-sandbox.test.mjs` can assert on the exact
// argv without a host, a tmux or a claude anywhere nearby:
//
//   node server/test/agent-sandbox.test.mjs
//
// This is deliberately NOT the autopilot's posture — that runs with
// --dangerously-skip-permissions because it is MEANT to write code, in a
// throwaway worktree, from a prompt the runner composed itself.

import { homedir } from 'node:os';
import { join } from 'node:path';

// Every tool an agent run must not have. Read and write tools both — the run
// only ever needs to think and answer.
export const AGENT_NO_TOOLS = [
  'Bash', 'Edit', 'Write', 'NotebookEdit', 'Read', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'Task', 'TodoWrite',
];

// Never a repo. A function, not a constant, so a test can call it without
// $HOME being set at import time.
export function agentScratchDir() {
  return join(homedir(), '.stack', 'agent-run');
}

// The full argv this daemon execs `claude` with, for a given prompt and
// (optionally) a model alias. Byte-for-byte what stack-term.mjs built inline
// before this file existed: `--disallowed-tools` takes the tool list as
// separate argv entries (spread, not joined), and `--model` is appended only
// when the alias passes the same charset check the settings UI uses — this
// process is the one that execs, so it re-checks rather than trusting the
// server validated it.
export function agentClaudeArgs(prompt, model) {
  const args = [
    '-p', String(prompt ?? ''),
    '--output-format', 'json',
    '--permission-mode', 'plan',
    '--disallowed-tools', ...AGENT_NO_TOOLS,
  ];
  if (model && /^[a-z0-9][a-z0-9._-]{0,99}$/i.test(String(model))) {
    args.push('--model', String(model));
  }
  return args;
}
