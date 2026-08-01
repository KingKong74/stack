#!/usr/bin/env node
// Stack — which alternative AI providers have an API key configured (#184).
//
// terminal/model-switch.mjs is where the web terminal resolves a provider key
// when Claude hits a usage limit; this command just reports what that resolver
// would find, from where, and what is still missing — the keys themselves are
// the owner's to paste into ~/.stack/env or ~/.ccm_config, this only tells them
// the state of play.
//
// INVARIANT: never print any part of a key, not even a prefix or suffix — the
// character count is the only thing this ever says about a key's content. Any
// future edit that adds a "show me the key" convenience breaks that on sight.
//
// Usage:
//   node scripts/stack-models.mjs [--json] [--check]
//   ./stack models [--json] [--check]           # via the root dispatcher
//
//   --json    print { providers, sources, preferred, configuredCount } instead
//             of the table
//   --check   exit 1 when NO provider is configured (for a health check);
//             without --check the exit code is always 0 — nothing configured
//             yet is a state to report, not a failure
//
// Zero dependencies.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { statSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const {
  PROVIDERS, keySources, resolveProviderKey, loadPreferredProvider,
} = await import(pathToFileURL(join(HERE, '..', 'terminal', 'model-switch.mjs')).href);

// statSync inside a try is existsSync-then-read without the race.
function pathExists(path) {
  try { statSync(path); return true; }
  catch { return false; }
}

function collect() {
  const providers = PROVIDERS.map((p) => {
    const { key, source } = resolveProviderKey(p.envKey);
    return {
      key: p.key,
      label: p.label,
      model: p.model,
      envKey: p.envKey,
      configured: key.length > 0,
      source: key.length > 0 ? source : null,
      keyLength: key.length,
    };
  });
  const sources = keySources().map((s) => ({ ...s, exists: pathExists(s.path) }));
  const preferred = loadPreferredProvider();
  const configuredCount = providers.filter((p) => p.configured).length;
  return { providers, sources, preferred, configuredCount };
}

function renderTable(state) {
  const out = [];
  out.push('Stack — alternative AI providers (web terminal switch-over on a usage limit)');
  out.push('');
  for (const p of state.providers) {
    const marker = p.configured ? '●' : '○';
    const status = p.configured ? 'configured' : 'not configured';
    const line = [
      marker,
      p.label.padEnd(10),
      p.envKey.padEnd(20),
      p.model.padEnd(22),
    ].join(' ');
    out.push(p.configured
      ? `${line} ${p.source} · ${p.keyLength} chars`
      : `${line} ${status}`);
  }
  out.push('');
  out.push('Key files consulted (after process env), in order:');
  for (const s of state.sources) {
    out.push(`  ${s.exists ? '✓' : '·'} ${s.label}  ${s.exists ? '(present)' : '(absent — that is normal, not an error)'}`);
  }
  out.push('');
  out.push(state.preferred
    ? `Preferred provider: ${state.preferred} — offered first when Claude hits a usage limit.`
    : 'No preferred provider saved yet — the web terminal will offer whichever is configured.');

  if (state.providers.some((p) => !p.configured)) {
    out.push('');
    out.push('To add one, append a line to ~/.stack/env, e.g.:');
    out.push("  echo 'DEEPSEEK_API_KEY=your-key-here' >> ~/.stack/env");
    out.push('~/.stack/env is host-side, gitignored and never committed. The terminal');
    out.push('daemon picks up a new key on its next session — nothing in the repo restarts.');
  }
  return out.join('\n');
}

export async function main(argv = []) {
  const args = Array.isArray(argv) ? argv : process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('usage: stack models [--json] [--check]\n');
    return 0;
  }
  const known = new Set(['--json', '--check']);
  const unknown = args.find((a) => !known.has(a));
  if (unknown) {
    process.stderr.write(`[stack] unknown option: ${unknown}\nusage: stack models [--json] [--check]\n`);
    return 1;
  }

  const state = collect();
  process.stdout.write(args.includes('--json')
    ? JSON.stringify(state, null, 2) + '\n'
    : renderTable(state) + '\n');

  if (args.includes('--check')) return state.configuredCount > 0 ? 0 : 1;
  return 0;
}

const invoked = process.argv[1] && process.argv[1].endsWith('stack-models.mjs');
if (invoked) {
  main(process.argv.slice(2)).then((code) => process.exit(code ?? 0));
}
