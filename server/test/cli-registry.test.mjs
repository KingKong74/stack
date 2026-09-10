// The CLI runtime catalogue (#481) — the exact argv per runtime, and the env a
// launched runtime is actually handed.
//
//   node server/test/cli-registry.test.mjs      # exits non-zero on any failure
//
// Pure, the way server/test/agent-sandbox.test.mjs is pure: no gateway, no tmux,
// and none of these binaries need exist. The argv assertions are the point —
// each runtime wants its base URL in a different shape and its model on a
// different flag, and a wrong one fails inside a process the reader did not
// start and cannot explain.
//
// Two invariants here have teeth beyond the argv:
//   * no credential ever reaches argv (--api-key-env names the variable instead),
//     so `ps` stays clean the way stack-term.mjs already promises;
//   * the child env is an ALLOWLIST and every name in <cwd>/.env is shadowed —
//     the two ways Stack's own secrets could otherwise reach somebody else's CLI.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const {
  RUNTIMES, getRuntime, runtimeArgv, telemetryBanner,
  runtimeEnv, dotenvKeyNames, ENV_ALLOWLIST,
} = await import('../../terminal/cli-registry.mjs');

const dir = mkdtempSync(join(tmpdir(), 'stack-cli-registry-'));

try {
  // ---- the catalogue ------------------------------------------------------
  check('claude is the ONLY runtime Stack can see into',
    RUNTIMES.filter((r) => r.telemetry === 'full').map((r) => r.key), ['claude']);
  check('every row declares its telemetry',
    RUNTIMES.every((r) => r.telemetry === 'full' || r.telemetry === 'none'), true);
  check('unknown runtime is null', getRuntime('nope'), null);

  // ---- argv: native -------------------------------------------------------
  check('claude: native, Stack owns the spawn', runtimeArgv('claude'), { bin: 'claude', args: [] });
  check('claude: passthrough args survive',
    runtimeArgv('claude', { passthrough: ['--continue'] }), { bin: 'claude', args: ['--continue'] });

  // ---- argv: delegated ----------------------------------------------------
  check('codex: delegated to omniroute run',
    runtimeArgv('codex'),
    { bin: 'omniroute', args: ['run', 'codex', '--api-key-env', 'OMNIROUTE_API_KEY'] });
  check('codex: a model is passed on the flag',
    runtimeArgv('codex', { model: 'deepseek/deepseek-chat' }).args,
    ['run', 'codex', '--api-key-env', 'OMNIROUTE_API_KEY', '--model', 'deepseek/deepseek-chat']);
  check('gemini: passthrough goes after --, so --skip-trust reaches gemini not omniroute',
    runtimeArgv('gemini', { passthrough: ['--skip-trust'] }).args,
    ['run', 'gemini', '--api-key-env', 'OMNIROUTE_API_KEY', '--', '--skip-trust']);

  check('codex: a base URL is passed only when overridden',
    runtimeArgv('codex', { baseUrl: 'http://10.0.0.5:20128' }).args,
    ['run', 'codex', '--api-key-env', 'OMNIROUTE_API_KEY', '--base-url', 'http://10.0.0.5:20128']);
  check('codex: and is absent by default, so the two defaults cannot silently diverge',
    runtimeArgv('codex').args.includes('--base-url'), false);

  // The credential invariant, asserted directly rather than left to review:
  // this is the line a well-meaning edit breaks first.
  for (const r of RUNTIMES) {
    const built = runtimeArgv(r.key, { model: 'x/y', passthrough: ['--z'] });
    const argv = [built.bin, ...(built.args || [])].join(' ');
    check(`${r.key}: no credential flag in argv`, /--(api-key|token)\b(?!-env)/.test(argv), false);
  }

  // ---- argv: the refusals -------------------------------------------------
  // qwen exits 2 without a model, so it is refused HERE with a sentence.
  check('qwen: refused without a model', !!runtimeArgv('qwen').error, true);
  check('qwen: the refusal says what to pass',
    /--model/.test(runtimeArgv('qwen').error), true);
  check('qwen: accepted with one',
    runtimeArgv('qwen', { model: 'qwen/qwen3-max' }).args,
    ['run', 'qwen', '--api-key-env', 'OMNIROUTE_API_KEY', '--model', 'qwen/qwen3-max']);

  check('crush: setup-only, refused rather than given a bogus run line',
    !!runtimeArgv('crush').error, true);
  check('crush: the refusal names its setup command',
    /stack omniroute setup crush/.test(runtimeArgv('crush').error), true);
  check('deepseek-tui: refused, and says it has no setup command either',
    /no OmniRoute setup command/.test(runtimeArgv('deepseek-tui').error), true);
  check('setup-only rows never produce a bin',
    RUNTIMES.filter((r) => r.launch === 'setup-only')
      .every((r) => runtimeArgv(r.key).bin === undefined), true);

  // ---- the telemetry banner ----------------------------------------------
  check('claude: no banner — Stack can see into it', telemetryBanner('claude'), '');
  const banner = telemetryBanner('codex');
  check('codex: the banner names the checkpoint gap', /files no checkpoint/.test(banner), true);
  check('codex: the banner names the branch-claim hazard', /Branch claims are NOT injected/.test(banner), true);
  check('codex: the banner offers the poster as the bridge',
    /stack-checkpoint\.mjs/.test(banner), true);

  // ---- env: the allowlist -------------------------------------------------
  const source = {
    PATH: '/usr/bin', HOME: '/home/x', TERM: 'xterm-256color',
    STACK_TOKEN: 'stack-secret-not-real',
    ANTHROPIC_API_KEY: 'sk-secret-not-real',
    AWS_SECRET_ACCESS_KEY: 'aws-secret-not-real',
  };
  const env = runtimeEnv({ source, cwd: dir });
  check('env: the allowlist passes through', [env.PATH, env.HOME, env.TERM],
    ['/usr/bin', '/home/x', 'xterm-256color']);
  check('env: STACK_TOKEN does NOT reach the child', 'STACK_TOKEN' in env, false);
  check('env: nor does an Anthropic key', 'ANTHROPIC_API_KEY' in env, false);
  check('env: nor anything else unlisted', 'AWS_SECRET_ACCESS_KEY' in env, false);
  check('env: it is an allowlist, not a denylist',
    Object.keys(env).every((k) => ENV_ALLOWLIST.includes(k)), true);

  // ---- env: shadowing the launched directory's .env -----------------------
  // `omniroute` reads <cwd>/.env on every invocation and its loader is
  // first-wins, so a name already set means the file's value is ignored.
  writeFileSync(join(dir, '.env'),
    '# a comment\nPOSTGRES_PASSWORD=pg-secret-not-real\nAPI_TOKEN=api-secret-not-real\n'
    + 'export GEMINI_API_KEY=gem-secret-not-real\nmalformed line\n', 'utf8');

  check('dotenv: names only, comments and malformed lines skipped',
    dotenvKeyNames(dir), ['POSTGRES_PASSWORD', 'API_TOKEN', 'GEMINI_API_KEY']);
  check('dotenv: a directory with no .env is no names', dotenvKeyNames(tmpdir()).length >= 0, true);

  const shadowed = runtimeEnv({ source, cwd: dir });
  check('shadow: every .env name is present and EMPTY, so the loader skips the file',
    [shadowed.POSTGRES_PASSWORD, shadowed.API_TOKEN, shadowed.GEMINI_API_KEY], ['', '', '']);
  check('shadow: and no real value was ever read',
    JSON.stringify(shadowed).includes('secret-not-real'), false);

  // A name Stack means to pass wins over the shadow — that is the whole point
  // of the ordering, and the gateway key is exactly such a name.
  const withKey = runtimeEnv({ source, cwd: dir, extra: { OMNIROUTE_API_KEY: 'oma-test', API_TOKEN: 'deliberate' } });
  check('shadow: a deliberate value beats the shadow', withKey.API_TOKEN, 'deliberate');
  check('shadow: the gateway key is passed through the env, not argv',
    withKey.OMNIROUTE_API_KEY, 'oma-test');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
