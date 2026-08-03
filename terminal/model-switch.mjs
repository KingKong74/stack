// Alternative AI provider catalogue for the Stack web terminal.
//
// When Claude hits a usage limit, the daemon offers these as drop-in
// replacements. All expose the Anthropic API surface via ANTHROPIC_BASE_URL,
// so Claude Code switches transparently. Provider catalogue derived from
// https://github.com/foreveryh/claude-code-switch (MIT).
//
// API keys resolve process.env -> ~/.stack/env -> ~/.ccm_config (the
// claude-code-switch config file), in that order. process.env is checked
// first because the daemon's own env loader has already pre-loaded
// ~/.stack/env into it by startup, but any OTHER host-side helper (a
// standalone script, a CLI command) has not — so this module reads
// ~/.stack/env itself rather than assuming it. Keys are never logged or
// included in any user-visible output.
//
// Persistence: the user's chosen provider is saved to ~/.stack/term-model.json
// as { preferred: "deepseek" }. The server's settings table is out of scope for
// host-side terminal code.

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// HOME resolution, factored out so it can be overridden for tests and so
// every path in this file agrees on one home directory. USERPROFILE covers
// Windows-ish hosts where HOME may be unset.
function stackHome() {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

// Provider catalogue — baseUrl must expose the Anthropic messages API surface.
// Derived from https://github.com/foreveryh/claude-code-switch ccm.sh.
export const PROVIDERS = [
  {
    key: 'deepseek',
    label: 'DeepSeek',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com/anthropic',
    envKey: 'DEEPSEEK_API_KEY',
  },
  {
    key: 'kimi',
    label: 'Kimi',
    model: 'kimi-k2.5',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    envKey: 'KIMI_API_KEY',
  },
  {
    key: 'glm',
    label: 'GLM',
    model: 'glm-5',
    baseUrl: 'https://api.z.ai/api/anthropic',
    envKey: 'GLM_API_KEY',
  },
  {
    key: 'qwen',
    label: 'Qwen',
    model: 'qwen3-max-2026-01-23',
    baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic',
    envKey: 'QWEN_API_KEY',
  },
  {
    key: 'minimax',
    label: 'MiniMax',
    model: 'MiniMax-M2.5',
    baseUrl: 'https://api.minimax.io/anthropic',
    envKey: 'MINIMAX_API_KEY',
  },
];

// Parse a key file — either the key=value format ~/.stack/env and
// ~/.ccm_config both use, or JSON (some builds of the ccm tool write JSON
// instead). Never throws: a missing file, an unreadable one or a path that
// is actually a directory (an EISDIR on read, which existsSync alone would
// not catch) all resolve to "no keys found" rather than an error.
export function loadKeyFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const result = {};
      // One level of nesting: a top-level object's own string values are
      // pulled in too, so a `{"env":{"KIMI_API_KEY":"..."}}` shape is found.
      // Top-level keys win — a nested key never overwrites one already set.
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') result[k] = v;
      }
      for (const v of Object.values(parsed)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          for (const [ck, cv] of Object.entries(v)) {
            if (typeof cv === 'string' && !(ck in result)) result[ck] = cv;
          }
        }
      }
      return result;
    }
  } catch { /* not JSON — fall through to key=value */ }

  const result = {};
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq < 0) continue;
    const k = s.slice(0, eq).trim();
    const v = s.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (k) result[k] = v;
  }
  return result;
}

// The ordered list of files consulted for a provider key, after process.env.
export function keySources() {
  return [
    { label: '~/.stack/env', path: join(stackHome(), '.stack', 'env') },
    { label: '~/.ccm_config', path: join(stackHome(), '.ccm_config') },
  ];
}

// Resolve one provider's API key, honouring the process.env -> ~/.stack/env
// -> ~/.ccm_config precedence described at the top of this file. Whitespace-
// only values count as absent.
export function resolveProviderKey(envKey) {
  const fromEnv = (process.env[envKey] || '').trim();
  if (fromEnv) return { key: fromEnv, source: 'process env' };
  for (const { label, path } of keySources()) {
    const cfg = loadKeyFile(path);
    const v = (cfg[envKey] || '').trim();
    if (v) return { key: v, source: label };
  }
  return { key: '', source: '' };
}

// Providers that have a configured API key.
export function availableProviders() {
  return PROVIDERS.filter((p) => resolveProviderKey(p.envKey).key.length > 0);
}

// Environment overrides to inject when spawning claude with this provider.
// ANTHROPIC_API_KEY is blanked so an existing Anthropic key cannot interfere.
export function providerEnv(providerKey) {
  const p = PROVIDERS.find((x) => x.key === providerKey);
  if (!p) return null;
  const apiKey = resolveProviderKey(p.envKey).key;
  if (!apiKey) return null;
  return {
    ANTHROPIC_BASE_URL: p.baseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_MODEL: p.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: p.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: p.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: p.model,
    ANTHROPIC_SMALL_FAST_MODEL: p.model,
    CLAUDE_CODE_SUBAGENT_MODEL: p.model,
    ANTHROPIC_API_KEY: '',
  };
}

export function getProvider(key) {
  return PROVIDERS.find((p) => p.key === key) ?? null;
}

// Persist and recall the user's preferred alternative provider across sessions.
const PREF_FILE = join(stackHome(), '.stack', 'term-model.json');

export function loadPreferredProvider() {
  try {
    const j = JSON.parse(readFileSync(PREF_FILE, 'utf8'));
    return typeof j.preferred === 'string' ? j.preferred : null;
  } catch { return null; }
}

export function savePreferredProvider(key) {
  try { writeFileSync(PREF_FILE, JSON.stringify({ preferred: key }), 'utf8'); } catch { /* non-fatal */ }
}
