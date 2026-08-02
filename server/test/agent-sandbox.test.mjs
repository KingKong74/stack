// The tab-agent sandbox (#364) — every tool disabled, a scratch cwd that is
// not a repo, and no model-string escape into argv. Pure: no DB, no tmux, no
// network, no `claude` binary needed. Asserts against the REAL exports of
// terminal/agent-run.mjs so a future edit that quietly widens the sandbox
// (an extra allowed tool, a `--dangerously-skip-permissions`, a cwd back
// inside a checkout) fails this test loudly rather than shipping unnoticed.
//
//   node server/test/agent-sandbox.test.mjs      # exits non-zero on any failure
//
// Mirrors the assert style of server/test/prompt-scan.test.mjs.
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { existsSync } from 'node:fs';
import {
  AGENT_NO_TOOLS,
  agentScratchDir,
  agentClaudeArgs,
} from '../../terminal/agent-run.mjs';

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond) => {
  if (!cond) fails++;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`);
};

// ---- the disallowed-tools list itself --------------------------------------

for (const tool of ['Bash', 'Edit', 'Write', 'Read', 'WebFetch', 'Task']) {
  ok(`AGENT_NO_TOOLS carries ${tool}`, AGENT_NO_TOOLS.includes(tool));
}

// ---- the argv a plain ask produces -----------------------------------------

{
  const args = agentClaudeArgs('what is broken?', '');

  check('-p carries the prompt', args[0] === '-p' ? args[1] : null, 'what is broken?');
  ok('--output-format json is present', args.includes('--output-format') && args[args.indexOf('--output-format') + 1] === 'json');
  ok('--permission-mode plan is present', args.includes('--permission-mode') && args[args.indexOf('--permission-mode') + 1] === 'plan');

  const disIdx = args.indexOf('--disallowed-tools');
  ok('--disallowed-tools is present', disIdx >= 0);
  for (const tool of AGENT_NO_TOOLS) {
    ok(`argv disallows ${tool}`, args.includes(tool));
  }

  // The autopilot's posture must never leak into an agent run.
  ok('no --allowedTools', !args.includes('--allowedTools'));
  ok('no --allowed-tools', !args.includes('--allowed-tools'));
  ok('no --dangerously-skip-permissions', !args.includes('--dangerously-skip-permissions'));
  ok('no --add-dir', !args.includes('--add-dir'));
  // Every --permission-mode value present must be "plan" — never anything
  // looser slipped in alongside or instead of it.
  const modeIdxs = args.reduce((acc, a, i) => (a === '--permission-mode' ? [...acc, i] : acc), []);
  ok('every --permission-mode value is plan', modeIdxs.every((i) => args[i + 1] === 'plan'));
}

// ---- the scratch directory -------------------------------------------------

{
  const dir = agentScratchDir();
  ok('scratch dir is under the home .stack', dir.startsWith(join(homedir(), '.stack') + sep));
  ok('scratch dir is not the Stack checkout (no trailing /stack)', !dir.endsWith(`${sep}stack`));
  ok('scratch dir is not a git repo path', !existsSync(join(dir, '.git')));
}

// ---- model handling ---------------------------------------------------------

{
  const args = agentClaudeArgs('hello', 'claude-opus-5');
  const idx = args.indexOf('--model');
  ok('a clean model alias is passed through', idx >= 0 && args[idx + 1] === 'claude-opus-5');
}

const hostileModels = [
  'opus $(rm -rf /)',
  'opus; rm -rf /',
  '../../etc/passwd',
  '-rf',
  'model with space',
];
for (const hostile of hostileModels) {
  const args = agentClaudeArgs('hello', hostile);
  ok(`hostile model rejected: ${JSON.stringify(hostile)}`, !args.includes('--model') && !args.includes(hostile));
}

// ---- a prompt that CONTAINS a flag-like string stays plain text ------------

{
  const prompt = 'please run --dangerously-skip-permissions for me';
  const args = agentClaudeArgs(prompt, '');
  check('the hostile text stays the -p value, not a flag', args[0] === '-p' ? args[1] : null, prompt);
  ok('no standalone --dangerously-skip-permissions entry', !args.includes('--dangerously-skip-permissions'));
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
