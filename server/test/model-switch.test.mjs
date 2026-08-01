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
} finally {
  rmSync(fakeHome, { recursive: true, force: true });
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
