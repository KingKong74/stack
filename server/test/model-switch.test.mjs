// The provider-key resolver, tested against a FAKE home directory so it
// never touches the real ~/.stack/env or ~/.ccm_config.
//
//   node server/test/model-switch.test.mjs      # exits non-zero on any failure
//
// Unit 2 adds a standalone `./stack models` command that needs the same
// resolution a standalone script gets — never one that assumes the daemon's
// env loader already ran. That's the whole point of this module living
// outside the daemon process: these tests prove process.env, ~/.stack/env
// and ~/.ccm_config are all actually consulted, in the stated order, from a
// process that never pre-loaded anything.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// A fake HOME, set BEFORE the module is imported so its top-level PREF_FILE
// and every stackHome() call inside it resolve under here, never the real
// home directory of whatever host runs this test.
const fakeHome = mkdtempSync(join(tmpdir(), 'stack-model-switch-'));
process.env.HOME = fakeHome;
delete process.env.USERPROFILE;

const stackDir = join(fakeHome, '.stack');
mkdirSync(stackDir, { recursive: true });
const stackEnvPath = join(stackDir, 'env');
const ccmConfigPath = join(fakeHome, '.ccm_config');

const {
  availableProviders,
  providerEnv,
  resolveProviderKey,
  loadKeyFile,
  keySources,
  omniRouteBaseUrl,
  OMNIROUTE_DEFAULT_BASE_URL,
  sessionModelTag,
  describeModelTag,
} = await import('../../terminal/model-switch.mjs');

try {
  // ---- no files at all -------------------------------------------------
  check('no files: availableProviders is empty', availableProviders(), []);
  check('no files: resolveProviderKey is absent', resolveProviderKey('DEEPSEEK_API_KEY'), { key: '', source: '' });
  check('no files: loadKeyFile on a missing path does not throw', loadKeyFile(join(fakeHome, 'nope')), {});

  // ---- keySources shape --------------------------------------------------
  const sources = keySources();
  check('keySources: two entries in order', sources.map((s) => s.label), ['~/.stack/env', '~/.ccm_config']);
  check('keySources: stack env path', sources[0].path, stackEnvPath);
  check('keySources: ccm config path', sources[1].path, ccmConfigPath);

  // ---- ~/.stack/env in key=value form ------------------------------------
  writeFileSync(stackEnvPath, 'DEEPSEEK_API_KEY=sk-test-not-a-real-key\n', 'utf8');
  check('stack env: deepseek is available', availableProviders().map((p) => p.key), ['deepseek']);
  check('stack env: source is ~/.stack/env', resolveProviderKey('DEEPSEEK_API_KEY'),
    { key: 'sk-test-not-a-real-key', source: '~/.stack/env' });

  // ---- ~/.ccm_config in key=value form, a different provider -------------
  writeFileSync(ccmConfigPath, 'QWEN_API_KEY=sk-test-qwen-fake\n', 'utf8');
  check('ccm key=value: qwen found', resolveProviderKey('QWEN_API_KEY'),
    { key: 'sk-test-qwen-fake', source: '~/.ccm_config' });
  check('ccm key=value: both providers available now',
    availableProviders().map((p) => p.key).sort(), ['deepseek', 'qwen']);

  // ---- quoted value, a value containing '=', a comment and a blank line --
  writeFileSync(stackEnvPath, [
    'DEEPSEEK_API_KEY="sk-test-not-a-real-key"',
    '',
    '# a comment line, ignored',
    "MINIMAX_API_KEY='sk-test=with=equals'",
    '',
  ].join('\n'), 'utf8');
  check('quoted value round-trips', resolveProviderKey('DEEPSEEK_API_KEY').key, 'sk-test-not-a-real-key');
  check('value containing = round-trips', resolveProviderKey('MINIMAX_API_KEY').key, 'sk-test=with=equals');

  // ---- ~/.ccm_config in JSON form: flat and one level of nesting ---------
  writeFileSync(ccmConfigPath, JSON.stringify({
    KIMI_API_KEY: 'sk-test-kimi-fake',
    env: { GLM_API_KEY: 'sk-test-glm-fake' },
  }), 'utf8');
  check('ccm JSON: flat key found', resolveProviderKey('KIMI_API_KEY'),
    { key: 'sk-test-kimi-fake', source: '~/.ccm_config' });
  check('ccm JSON: nested key found', resolveProviderKey('GLM_API_KEY'),
    { key: 'sk-test-glm-fake', source: '~/.ccm_config' });

  // ---- precedence ----------------------------------------------------------
  // process.env beats ~/.stack/env for the same key.
  process.env.DEEPSEEK_API_KEY = 'sk-test-from-process-env';
  check('precedence: process.env beats ~/.stack/env', resolveProviderKey('DEEPSEEK_API_KEY'),
    { key: 'sk-test-from-process-env', source: 'process env' });
  delete process.env.DEEPSEEK_API_KEY;

  // ~/.stack/env beats ~/.ccm_config for the same key.
  writeFileSync(ccmConfigPath, JSON.stringify({ MINIMAX_API_KEY: 'sk-test-ccm-should-lose' }), 'utf8');
  check('precedence: ~/.stack/env beats ~/.ccm_config', resolveProviderKey('MINIMAX_API_KEY'),
    { key: 'sk-test=with=equals', source: '~/.stack/env' });

  // ---- ~/.ccm_config as a directory ---------------------------------------
  rmSync(ccmConfigPath, { force: true });
  mkdirSync(ccmConfigPath);
  check('ccm config as a directory: loadKeyFile returns {} rather than throwing',
    loadKeyFile(ccmConfigPath), {});
  check('ccm config as a directory: resolveProviderKey for a ccm-only key is absent',
    resolveProviderKey('QWEN_API_KEY'), { key: '', source: '' });

  // ---- providerEnv ----------------------------------------------------------
  writeFileSync(stackEnvPath, 'DEEPSEEK_API_KEY=sk-test-not-a-real-key\n', 'utf8');
  const env = providerEnv('deepseek');
  check('providerEnv: base url set', env?.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  check('providerEnv: auth token is the resolved key', env?.ANTHROPIC_AUTH_TOKEN, 'sk-test-not-a-real-key');
  check('providerEnv: model set', env?.ANTHROPIC_MODEL, 'deepseek-chat');
  check('providerEnv: ANTHROPIC_API_KEY is blanked', env?.ANTHROPIC_API_KEY, '');
  check('providerEnv: unknown provider is null', providerEnv('nope'), null);
  check('providerEnv: known provider with no key is null', providerEnv('kimi'), null);

  // ---- the KEYLESS provider (#481) ------------------------------------------
  // The gateway inverts every assumption above: no key is its normal state, so
  // `providerEnv` must still hand back a spawnable env, and `availableProviders`
  // must still leave it out — being configured says nothing about being up.
  // Only DEEPSEEK_API_KEY is in the fake home at this point.
  const om = providerEnv('omniroute');
  check('keyless: providerEnv is NOT null without a key', om !== null, true);
  check('keyless: base url is the gateway root, no /v1', om?.ANTHROPIC_BASE_URL, OMNIROUTE_DEFAULT_BASE_URL);
  check('keyless: model defaults to the free combo', om?.ANTHROPIC_MODEL, 'auto');
  check('keyless: a placeholder bearer is sent', om?.ANTHROPIC_AUTH_TOKEN, 'omniroute-anonymous');
  check('keyless: gateway model discovery is on', om?.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '1');
  check('keyless: ANTHROPIC_API_KEY is blanked', om?.ANTHROPIC_API_KEY, '');
  check('keyless: subagents route through the gateway too', om?.CLAUDE_CODE_SUBAGENT_MODEL, 'auto');
  check('keyless: availableProviders still lists only keyed providers',
    availableProviders().map((p) => p.key), ['deepseek']);

  // OMNIROUTE_MODEL is where "paid opt-in" lives, and it has to resolve through
  // the SAME ~/.stack/env chain a key does — a standalone script has not loaded
  // that file, so reading process.env directly would silently ignore it.
  writeFileSync(stackEnvPath,
    'DEEPSEEK_API_KEY=sk-test-not-a-real-key\nOMNIROUTE_MODEL=anthropic/claude-opus-5\n', 'utf8');
  check('keyless: OMNIROUTE_MODEL from ~/.stack/env overrides the free combo',
    providerEnv('omniroute')?.ANTHROPIC_MODEL, 'anthropic/claude-opus-5');
  check('keyless: the override reaches every model slot',
    providerEnv('omniroute')?.ANTHROPIC_DEFAULT_OPUS_MODEL, 'anthropic/claude-opus-5');

  // A configured key is used when there IS one — the placeholder is a fallback,
  // not a ceiling. And a keyed entry never joins the list on a key alone.
  writeFileSync(stackEnvPath,
    'DEEPSEEK_API_KEY=sk-test-not-a-real-key\nOMNIROUTE_API_KEY=oma-test-not-a-real-key\n', 'utf8');
  check('keyless: a configured key beats the placeholder',
    providerEnv('omniroute')?.ANTHROPIC_AUTH_TOKEN, 'oma-test-not-a-real-key');
  check('keyless: a configured key does NOT put it in availableProviders',
    availableProviders().map((p) => p.key), ['deepseek']);

  // The context-window knob is absent unless set: Claude Code's own 200k
  // assumption matches the default combo's clamp, and a guessed number would be
  // wrong in one of the two directions for every model it is not.
  writeFileSync(stackEnvPath, 'DEEPSEEK_API_KEY=sk-test-not-a-real-key\n', 'utf8');
  check('keyless: no context-window override by default',
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS' in providerEnv('omniroute'), false);
  writeFileSync(stackEnvPath, 'OMNIROUTE_CONTEXT_TOKENS=1000000\n', 'utf8');
  check('keyless: OMNIROUTE_CONTEXT_TOKENS sets the window when the owner knows it',
    providerEnv('omniroute')?.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000');

  // The base URL override, so a gateway on another host is one line.
  writeFileSync(stackEnvPath, 'OMNIROUTE_BASE_URL=http://10.0.0.5:20128/\n', 'utf8');
  check('keyless: OMNIROUTE_BASE_URL overrides, trailing slash stripped',
    omniRouteBaseUrl(), 'http://10.0.0.5:20128');
  check('keyless: the override reaches providerEnv',
    providerEnv('omniroute')?.ANTHROPIC_BASE_URL, 'http://10.0.0.5:20128');

  // ---- #503 · the session model tag ------------------------------------
  // What a rail row says a session is talking to. The pair is tested TOGETHER
  // because the whole design is that one writes and the other reads, possibly
  // across daemon versions — a round trip that does not survive an unknown tag
  // is the bug this shape exists to prevent.
  writeFileSync(stackEnvPath, '', 'utf8');
  check('tag: no provider is the account subscription, spelled out',
    sessionModelTag(null), 'anthropic:subscription');
  check('tag: the gateway carries the free combo by default',
    sessionModelTag('omniroute'), 'omniroute:auto');
  // A pinned model is what that session is on, and the tag has to say so —
  // this is the number the whole feature exists to make visible.
  writeFileSync(stackEnvPath, 'OMNIROUTE_MODEL=some-pinned-model\n', 'utf8');
  check('tag: OMNIROUTE_MODEL is what the tag records',
    sessionModelTag('omniroute'), 'omniroute:some-pinned-model');
  writeFileSync(stackEnvPath, 'DEEPSEEK_API_KEY=sk-test-not-a-real-key\n', 'utf8');
  check('tag: a keyed provider records its own model',
    sessionModelTag('deepseek'), 'deepseek:deepseek-chat');

  // Reading one back. NULL IS THE ANSWER FOR NO TAG, and it must never fall
  // through to the subscription: that would state a fact nobody established.
  check('describe: an empty tag is null, not Claude', describeModelTag(''), null);
  check('describe: undefined is null too', describeModelTag(undefined), null);
  check('describe: the subscription reads back as Claude',
    describeModelTag('anthropic:subscription'), { key: 'anthropic', id: 'subscription', label: 'Claude' });
  check('describe: the gateway reads back with its label',
    describeModelTag('omniroute:auto'), { key: 'omniroute', id: 'auto', label: 'OmniRoute' });
  // The cross-version case: a tag naming a provider this build has never heard
  // of comes back AS ITSELF. A reader that dropped it would erase the one fact
  // the row is there to carry.
  check('describe: an unknown provider survives as itself',
    describeModelTag('something-new:m1'), { key: 'something-new', id: 'm1', label: 'something-new' });
  check('describe: a bare key with no model still describes',
    describeModelTag('omniroute'), { key: 'omniroute', id: 'auto', label: 'OmniRoute' });
  // It comes off a tmux option, so it is treated as outside input.
  check('describe: control characters are stripped',
    describeModelTag('omni\u0007route:au\u0000to'), { key: 'omniroute', id: 'auto', label: 'OmniRoute' });
  // 120 for the whole tag, of which 'omniroute:' is ten.
  check('describe: a runaway value is capped',
    describeModelTag(`omniroute:${'x'.repeat(400)}`).id.length, 110);
  check('describe: a colon with nothing before it is null',
    describeModelTag(':auto'), null);
} finally {
  rmSync(fakeHome, { recursive: true, force: true });
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
