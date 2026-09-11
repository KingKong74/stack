// The CLI RUNTIME catalogue (#481) — which agent binary, as against which model.
//
// Deliberately NOT in model-switch.mjs, and the split is the point. That file
// answers "which model does this session run on" and its entries are endpoints.
// This one answers "which program IS the session", and its entries are programs
// with their own config files, their own resume, their own idea of a flag. The
// two look alike from a distance and conflating them is how the fifth runtime
// ends up costing as much as the second.
//
// Pure and side-effect-free on import, like agent-run.mjs, so
// `server/test/cli-registry.test.mjs` can assert the exact argv with no gateway,
// no tmux and none of these binaries anywhere near the host:
//
//   node server/test/cli-registry.test.mjs
//
// ---------------------------------------------------------------------------
// TELEMETRY IS A DECLARATION, NOT A COMMENT.
//
// Everything Stack knows about a session comes from Claude Code specifics, and a
// non-Claude runtime breaks all four at once — silently, which is the problem:
//
//   * hook/stack-session-start.mjs is a Claude Code hook. No resume brief, no
//     session defaults, and NO "Branch claims — respect these".
//   * hook/stack-session-end.mjs likewise. No commit recorded, no tokens_used,
//     model_usage or agent_calls — a gap in the feed where a night's work was.
//   * usage-meter.mjs and edit-watch.mjs both scan ~/.claude/projects/**/*.jsonl.
//     "Who is editing what" goes blind, and edit-watch reads transcripts rather
//     than git ON PURPOSE, so there is no fallback answer.
//   * agent-run.mjs's sandbox argv is claude-specific. Tab agents stay Claude-only.
//
// The branch-claims one is a CORRECTNESS HAZARD, not missing telemetry: a codex
// session does not know `claimed_by` exists and can re-pick a claimed item into
// a colliding branch. So `telemetry` is carried on every row and every launcher
// PRINTS it — CLAUDE.md's fail-SILENT rule, which is exactly about a reader
// mistaking absence for good news.
//
// The one bridge that does survive: ~/.stack/stack-checkpoint.mjs is a POSTER,
// not a hook. Any runtime that can run a shell command can still file a rich
// checkpoint by hand, which turns "you get nothing" into "nothing automatic".
// ---------------------------------------------------------------------------
//
// WHY MOST ROWS DELEGATE TO `omniroute run` RATHER THAN SETTING THE ENV HERE.
// Gemini is the argument. Its launcher writes a temporary isolated
// GEMINI_CLI_HOME and scrubs GOOGLE_API_KEY / GOOGLE_GENAI_USE_VERTEXAI /
// GOOGLE_GENAI_USE_GCA so a stored Google OAuth session cannot hijack the run.
// That is real, load-bearing, and would rot silently the moment it were copied.
// Mirroring per-runtime env here means a second copy of OmniRoute's own manifest
// with nothing holding the two in step — the mirrored-predicate failure CLAUDE.md
// keeps flagging. `claude` stays NATIVE because Stack already owns that path and
// it is the one that has to keep working with the gateway DOWN.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The runtimes, in the order `stack omniroute runtimes` lists them.
//
//   launch  'native'    — Stack builds the env itself (model-switch.providerEnv)
//           'omniroute' — `omniroute run <target>` owns the env and any overlay
//           'setup-only'— no run target exists; configure once, then launch bare
//   telemetry 'full' | 'none'  — see the block above; 'full' means Stack's hooks fire
//   install   the documented install line, or null where OmniRoute's docs pin none
export const RUNTIMES = [
  {
    key: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    launch: 'native',
    target: null,
    telemetry: 'full',
    setup: null,
    requiresModel: false,
    install: 'npm install -g @anthropic-ai/claude-code',
    notes: 'the only runtime Stack can see into; base URL is the gateway ROOT, no /v1',
  },
  {
    key: 'codex',
    label: 'OpenAI Codex CLI',
    bin: 'codex',
    launch: 'omniroute',
    target: 'codex',
    telemetry: 'none',
    setup: 'setup-codex',
    requiresModel: false,
    install: 'npm install -g @openai/codex',
    notes: 'provider injected via -c model_providers.omniroute.*; base URL carries /v1. '
      + 'Modern codex (v0.137+) reads ~/.codex/config.toml only — a config.yaml is silently ignored',
  },
  {
    key: 'gemini',
    label: 'Google Gemini CLI',
    bin: 'gemini',
    launch: 'omniroute',
    target: 'gemini',
    telemetry: 'none',
    setup: null,
    requiresModel: false,
    install: 'npm install -g @google/gemini-cli',
    notes: 'reads GOOGLE_GEMINI_BASE_URL at the ROOT (its SDK appends /v1beta). The launcher '
      + 'writes a temporary GEMINI_CLI_HOME and scrubs the Vertex/Code-Assist vars — do not '
      + 'reimplement that here. Its workspace-trust guard is the caller\'s: pass --skip-trust',
  },
  {
    key: 'qwen',
    label: 'Qwen Code',
    bin: 'qwen',
    launch: 'omniroute',
    target: 'qwen',
    telemetry: 'none',
    setup: 'setup-qwen',
    // The only run target that HARD-REQUIRES a model: without one the launcher
    // exits 2. Refused here with a sentence rather than shipped to fail there.
    requiresModel: true,
    install: 'npm install -g @qwen-code/qwen-code',
    notes: 'omniroute run qwen exits 2 without --model',
  },
  {
    key: 'aider',
    label: 'Aider',
    bin: 'aider',
    launch: 'omniroute',
    target: 'aider',
    telemetry: 'none',
    setup: 'setup-aider',
    requiresModel: false,
    install: 'pip install aider-chat',
    notes: 'receives --model openai/<id>; OPENAI_API_BASE is written at the root (LiteLLM appends the path)',
  },
  {
    key: 'crush',
    label: 'Crush',
    bin: 'crush',
    launch: 'setup-only',
    target: null,
    telemetry: 'none',
    setup: 'setup-crush',
    requiresModel: false,
    // Charm's, and OmniRoute's docs pin no install line for it. Recorded as
    // unknown rather than guessed: a wrong install command is worse than none.
    install: null,
    notes: 'setup-crush writes ~/.config/crush/crush.json; there is no `omniroute run crush`, '
      + 'so configure once and launch it bare',
  },
  {
    key: 'deepseek-tui',
    label: 'DeepSeek TUI',
    bin: null,
    launch: 'setup-only',
    target: null,
    telemetry: 'none',
    setup: null,
    requiresModel: false,
    install: null,
    // In OmniRoute's catalogue as configType 'custom' with full base-URL support,
    // but with no setup-* command and no documented install line or binary name.
    // Both left null on purpose — see `install` on crush.
    notes: 'dashboard/manual config only; OmniRoute pins neither a binary name nor an install '
      + 'line, so this row cannot be launched until one is filled in by hand',
  },
];

export function getRuntime(key) {
  return RUNTIMES.find((r) => r.key === String(key || '')) ?? null;
}

// The banner every launcher prints before handing over, for anything Stack
// cannot see into. Returns '' for a 'full' runtime so the caller can print
// unconditionally. Plain text: callers colour it, and a test reads it.
export function telemetryBanner(key) {
  const r = getRuntime(key);
  if (!r || r.telemetry === 'full') return '';
  return [
    `${r.label} is a launch-only runtime. This session files no checkpoint,`,
    'records no usage, and is invisible to edit-watch.',
    'Branch claims are NOT injected — check `./stack tree` before you pick anything up.',
    'To file a checkpoint by hand:  ~/.stack/stack-checkpoint.mjs',
  ].join('\n');
}

// The exact argv for a runtime. Pure: no spawn, no filesystem, no gateway.
// Returns { bin, args } or { error } — never throws, and never a half-built
// command, because a launcher that ships `omniroute run qwen` with no model
// gets exit 2 from a process the reader did not start and cannot explain.
export function runtimeArgv(key, { model = '', baseUrl = '', passthrough = [] } = {}) {
  const r = getRuntime(key);
  if (!r) return { error: `unknown runtime: ${key}` };
  const extra = Array.isArray(passthrough) ? passthrough.map(String) : [];

  if (r.launch === 'setup-only') {
    const how = r.setup
      ? `configure it once with \`stack omniroute setup ${r.key}\`, then launch \`${r.bin}\` yourself`
      : 'it has no OmniRoute setup command; configure it by hand from the gateway dashboard';
    return { error: `${r.label} has no launch target — ${how}` };
  }

  if (r.launch === 'native') {
    // Stack owns this spawn; the env comes from model-switch.providerEnv.
    return { bin: r.bin, args: [...extra] };
  }

  if (r.requiresModel && !model) {
    return { error: `${r.label} needs a model — pass --model (e.g. --model qwen/qwen3-max)` };
  }

  // `omniroute run <target> [--model X] [-- toolArgs...]`. The credential is
  // NEVER an argv flag: --api-key-env names the variable to read instead, so a
  // key reaches the child through the environment and `ps` stays clean. That is
  // the same invariant stack-term.mjs keeps for a respawn.
  const args = ['run', r.target, '--api-key-env', 'OMNIROUTE_API_KEY'];
  // Only when overridden. `omniroute run` already defaults to the same local
  // port, so passing it unconditionally would bake Stack's default into every
  // command line and hide the day the two defaults diverge.
  if (baseUrl) args.push('--base-url', String(baseUrl));
  if (model) args.push('--model', String(model));
  if (extra.length) args.push('--', ...extra);
  return { bin: 'omniroute', args };
}

// ---------------------------------------------------------------------------
// ENV HYGIENE (#481). Two separate leaks, two separate fixes, and the second is
// the non-obvious one.
//
// 1. Stack's own process env. The terminal daemon loads ~/.stack/env into
//    process.env at startup, so a naive `{...process.env}` hands STACK_TOKEN to
//    somebody else's CLI. The child env is therefore built as an ALLOWLIST, not
//    a copy — the same posture agent-run.mjs takes with tools.
//
// 2. The launched directory's .env. `omniroute` reads `<cwd>/.env` on every
//    invocation and there is no flag to stop it (OMNIROUTE_CLI_SKIP_REPO_ENV
//    skips only its own package directory). Launched from this repo it loads
//    Stack's POSTGRES_PASSWORD, API_TOKEN and GEMINI_API_KEY and passes them on.
//    A neutral cwd is not the fix, because the child inherits that cwd and the
//    whole point is to run the CLI in the user's own project.
//
//    The fix is the loader's own rule: it is FIRST-WINS
//    (`if (process.env[key] === undefined)`), so a name already present in the
//    child env means the file's value is ignored. Shadowing every name in
//    <cwd>/.env with '' therefore neutralises the file without reading a single
//    value out of it.
// ---------------------------------------------------------------------------

// What a child process needs to be a working terminal program, and nothing that
// carries a secret. Anything not on this list does not reach the child.
export const ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TERMINFO', 'COLORTERM',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME',
  'DISPLAY', 'NO_COLOR', 'FORCE_COLOR', 'COLUMNS', 'LINES',
  // (#505) TMUX and TMUX_PANE — how a process knows which tmux session it is
  // in. Not a credential: the value is a socket path, a pid and a session id,
  // all of which anything in the pane could find anyway.
  //
  // Dropping them made the gateway path differ from the native one INVISIBLY.
  // A native `exec claude` inherits the pane's environment, so Stack's
  // SessionStart hook can ask tmux its own name and record which transcript
  // this session is writing; a gateway launch rebuilt the env from this list
  // and the hook silently recorded nothing. The symptom was one rail row
  // knowing what model answered and its neighbour not, with no error anywhere.
  'TMUX', 'TMUX_PANE',
];

// The NAMES defined in a .env file. Names only — this never returns, logs or
// stores a value, which is what makes it safe to run over somebody's secrets.
// A missing or unreadable file is "no names", never an error.
export function dotenvKeyNames(dir) {
  let raw;
  try {
    raw = readFileSync(join(String(dir || '.'), '.env'), 'utf8');
  } catch {
    return [];
  }
  const names = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const name = s.slice(0, eq).trim().replace(/^export\s+/, '');
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

// The env a launched runtime actually gets: the allowlist, then the caller's
// additions, then every name in <cwd>/.env shadowed to ''. The shadow goes LAST
// so it cannot be undone by an addition — except for names the caller set on
// purpose, which win, because those are the ones Stack means to pass.
export function runtimeEnv({ source = process.env, cwd = '', extra = {} } = {}) {
  const out = {};
  for (const name of ENV_ALLOWLIST) {
    if (typeof source[name] === 'string') out[name] = source[name];
  }
  for (const name of dotenvKeyNames(cwd)) {
    if (!(name in extra)) out[name] = '';
  }
  for (const [k, v] of Object.entries(extra)) out[k] = String(v ?? '');
  return out;
}
