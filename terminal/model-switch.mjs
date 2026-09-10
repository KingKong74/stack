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
//
// #481 — ONE ENTRY IS KEYLESS. Every provider above is a remote endpoint that
// exists whether or not this host can reach it, so "is it available" is "do we
// have its key". OmniRoute is a gateway running ON this host, so the question
// inverts: the key is optional and REACHABILITY is what decides. That is why
// `availableProviders()` (sync, key-only) and `availableProvidersLive()`
// (async, probes) are two functions and not one — the sync one is what the
// daemon's exit handler and `stack models` can call without awaiting, and
// widening it to cover a keyless entry would report a gateway that is not
// running as ready to take a session.
//
// The probe FAILS SAFE and LOUD, in that order: an unreachable gateway is never
// offered (a switch-over onto a refused connection is worse than no offer), but
// `probeOmniRoute()` always returns WHY so every caller can say it out loud.
// A silent omission reads as "you installed it wrong"; the reason reads as
// "the gateway is down", which is the true thing.

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// HOME resolution, factored out so it can be overridden for tests and so
// every path in this file agrees on one home directory. USERPROFILE covers
// Windows-ish hosts where HOME may be unset.
function stackHome() {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

// Where the gateway listens. The ROOT, with no /v1 — Claude Code appends
// `/v1/messages` itself and has no flag to say otherwise, so a base URL that
// already carries /v1 404s on every call. Overridable because the gateway need
// not be on this host; `omniroute` itself supports a remote.
export const OMNIROUTE_DEFAULT_BASE_URL = 'http://127.0.0.1:20128';

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
  // The gateway (#481). `keyless` is the whole of the difference and every
  // branch that treats it specially says so. `model` is the free combo: the
  // gateway ships a keyless provider wired into `auto`, so this answers on a
  // host that has pasted no key anywhere — which is the entire point, since a
  // limit prompt with nothing to offer is a session that just ends. Paid
  // routing is opt-in and costs one OMNIROUTE_MODEL line in ~/.stack/env.
  {
    key: 'omniroute',
    label: 'OmniRoute',
    model: 'auto',
    baseUrl: OMNIROUTE_DEFAULT_BASE_URL,
    envKey: 'OMNIROUTE_API_KEY',
    keyless: true,
    probePath: '/api/health',
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

// The same process.env -> ~/.stack/env -> ~/.ccm_config lookup for a value that
// is not a credential. `resolveProviderKey` already IS that function; only its
// name says otherwise. Aliased rather than copied so OMNIROUTE_MODEL resolves
// through exactly the chain this file's header promises — a standalone script
// has not loaded ~/.stack/env, which is the whole reason that chain exists.
export const resolveHostValue = resolveProviderKey;

// Where the gateway is, honouring an OMNIROUTE_BASE_URL override. Trailing
// slashes are stripped because every caller concatenates a path onto this.
export function omniRouteBaseUrl() {
  const override = resolveHostValue('OMNIROUTE_BASE_URL').key;
  return (override || OMNIROUTE_DEFAULT_BASE_URL).replace(/\/+$/, '');
}

// Providers that have a configured API key. KEY-ONLY AND SYNC ON PURPOSE — see
// the header. A keyless provider is excluded even when a key happens to be
// configured for it, because a key says nothing about whether its gateway is
// up, and this function's whole contract is "safe to offer right now".
export function availableProviders() {
  return PROVIDERS.filter((p) => !p.keyless && resolveProviderKey(p.envKey).key.length > 0);
}

// Is the gateway answering? Never throws and always carries a reason: a probe
// that swallows why it failed turns a stopped gateway into a mystery. Bounded
// by an AbortController so a host that accepts the connection and then says
// nothing costs `timeoutMs`, not the session.
export async function probeOmniRoute({ timeoutMs = 1500 } = {}) {
  const p = getProvider('omniroute');
  const baseUrl = omniRouteBaseUrl();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(baseUrl + p.probePath, { signal: ctrl.signal });
    if (!res.ok) return { reachable: false, baseUrl, reason: `gateway answered HTTP ${res.status}` };
    return { reachable: true, baseUrl, reason: '' };
  } catch (e) {
    // An abort is our own timeout; everything else carries a syscall code
    // (ECONNREFUSED for "not running") one level down under `cause`.
    // `cause` carries the useful half: a syscall code (ECONNREFUSED = "not
    // running") when there is one, and otherwise a message worth more than
    // fetch's own, which is the bare string "fetch failed" for every failure
    // it has. Never let that string be the reason a reader gets.
    const cause = e?.cause;
    const reason = e?.name === 'AbortError'
      ? `no answer within ${timeoutMs}ms`
      : String(cause?.code || e?.code || cause?.message || e?.message || 'unreachable');
    return { reachable: false, baseUrl, reason };
  } finally {
    clearTimeout(timer);
  }
}

// What may actually be offered right now: the keyed providers, plus the gateway
// when it answers. Returns the probe result alongside the list rather than just
// the list, because a caller that cannot say WHY the gateway is missing will
// print nothing and let the reader conclude they installed it wrong.
// The gateway leads the list when it is up: it is the one entry that needs no
// key, so it is the one most likely to actually work.
export async function availableProvidersLive(opts = {}) {
  const keyed = availableProviders();
  const gateway = await probeOmniRoute(opts);
  const providers = gateway.reachable ? [getProvider('omniroute'), ...keyed] : keyed;
  return { providers, gateway };
}

// Environment overrides to inject when spawning claude with this provider.
// ANTHROPIC_API_KEY is blanked so an existing Anthropic key cannot interfere.
export function providerEnv(providerKey) {
  const p = PROVIDERS.find((x) => x.key === providerKey);
  if (!p) return null;
  const apiKey = resolveProviderKey(p.envKey).key;
  // A keyed provider with no key is not configured and there is nothing to
  // spawn. A KEYLESS one is the opposite case: no key is the expected state,
  // so it gets an env block regardless and a placeholder bearer — Claude Code
  // wants some auth source, and a gateway not requiring one ignores it.
  if (!apiKey && !p.keyless) return null;
  if (p.keyless) {
    const model = resolveHostValue('OMNIROUTE_MODEL').key || p.model;
    return {
      ANTHROPIC_BASE_URL: omniRouteBaseUrl(),
      ANTHROPIC_AUTH_TOKEN: apiKey || 'omniroute-anonymous',
      ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      ANTHROPIC_SMALL_FAST_MODEL: model,
      CLAUDE_CODE_SUBAGENT_MODEL: model,
      // Lists the gateway's own catalogue in /model. Claude Code only shows
      // ids starting claude*/anthropic*, so this surfaces whatever the gateway
      // has aliased into that shape and nothing else — harmless when it has not.
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
      ANTHROPIC_API_KEY: '',
    };
  }
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
