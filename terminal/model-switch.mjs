// Alternative AI provider catalogue for the Stack web terminal.
//
// When Claude hits a usage limit, the daemon offers these as drop-in
// replacements. All expose the Anthropic API surface via ANTHROPIC_BASE_URL,
// so Claude Code switches transparently. Provider catalogue derived from
// https://github.com/foreveryh/claude-code-switch (MIT).
//
// API keys are read from process.env (loaded from ~/.stack/env by the daemon's
// env loader at startup) and from ~/.ccm_config (the claude-code-switch config
// file). Keys are never logged or included in any user-visible output.
//
// Persistence: the user's chosen provider is saved to ~/.stack/term-model.json
// as { preferred: "deepseek" }. The server's settings table is out of scope for
// host-side terminal code.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

// Parse ~/.ccm_config — same key=value format as ~/.stack/env.
function loadCcmConfig() {
  const path = join(homedir(), '.ccm_config');
  if (!existsSync(path)) return {};
  try {
    const result = {};
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const eq = s.indexOf('=');
      if (eq < 0) continue;
      const k = s.slice(0, eq).trim();
      const v = s.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (k) result[k] = v;
    }
    return result;
  } catch { return {}; }
}

// Providers that have a configured API key.
// process.env takes priority (already loaded from ~/.stack/env); ~/.ccm_config fallback.
export function availableProviders() {
  const cfg = loadCcmConfig();
  return PROVIDERS.filter((p) => (process.env[p.envKey] || cfg[p.envKey] || '').length > 0);
}

// Environment overrides to inject when spawning claude with this provider.
// ANTHROPIC_API_KEY is blanked so an existing Anthropic key cannot interfere.
export function providerEnv(providerKey) {
  const p = PROVIDERS.find((x) => x.key === providerKey);
  if (!p) return null;
  const cfg = loadCcmConfig();
  const apiKey = process.env[p.envKey] || cfg[p.envKey] || '';
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
const PREF_FILE = join(homedir(), '.stack', 'term-model.json');

export function loadPreferredProvider() {
  try {
    const j = JSON.parse(readFileSync(PREF_FILE, 'utf8'));
    return typeof j.preferred === 'string' ? j.preferred : null;
  } catch { return null; }
}

export function savePreferredProvider(key) {
  try { writeFileSync(PREF_FILE, JSON.stringify({ preferred: key }), 'utf8'); } catch { /* non-fatal */ }
}
