#!/usr/bin/env node
// Stack — the OmniRoute gateway and the CLI runtimes that can run against it (#481).
//
// Sits beside scripts/stack-models.mjs and mirrors its contract on purpose:
// same flags, same exit codes, same reticence about keys. That one answers "which
// alternative providers have a key"; this one answers "is the gateway up, what is
// it routing, and what can I actually start against it".
//
// INVARIANT, inherited verbatim from stack-models.mjs: never print any part of a
// key, not even a prefix or suffix — the character count is the only thing this
// ever says about a key's content. Any future edit that adds a "show me the key"
// convenience breaks that on sight.
//
// SECOND INVARIANT, this file's own: nothing here launches anything with a copy
// of process.env. `omniroute` reads <cwd>/.env on every invocation and the daemon
// has already loaded ~/.stack/env into this process, so both leaks are real and
// both are closed in terminal/cli-registry.mjs — read runtimeEnv()'s header
// before changing how a child is spawned.
//
// Usage:
//   node scripts/stack-omniroute.mjs [--json] [--check]
//   ./stack omniroute                            gateway status
//   ./stack omniroute runtimes [--json]          which CLIs, installed or not
//   ./stack omniroute launch [--cli K] [--model M] [-- args...]
//   ./stack omniroute setup <cli> [--dry-run]    delegate to `omniroute setup-*`
//
//   --json    machine-readable instead of the table
//   --check   exit 1 when the gateway is UNREACHABLE (for a health check);
//             without it the exit code is 0 — a gateway that is not running is
//             a state to report, not a failure of this command
//
// Standing it up (loopback ONLY — the gateway binds 0.0.0.0 whatever its own
// host variables say, so Docker's publish is what actually constrains it, and
// --restart handles reboots so there is no cron line to keep in step):
//
//   docker run -d --name omniroute --restart unless-stopped --stop-timeout 40 \
//     -e OMNIROUTE_MEMORY_MB=3072 --memory=4g -e INITIAL_PASSWORD="$OMNIROUTE_ADMIN_PASSWORD" \
//     -p 127.0.0.1:20128:20128 -v omniroute-data:/app/data diegosouzapw/omniroute:3.8.50
//
// Zero dependencies.

import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(join(HERE, '..', rel)).href);

const {
  probeOmniRoute, omniRouteBaseUrl, resolveProviderKey, resolveHostValue,
  getProvider, providerEnv, gatewayModels, cleanContextTokens,
} = await load('terminal/model-switch.mjs');
const {
  RUNTIMES, getRuntime, runtimeArgv, runtimeEnv, telemetryBanner,
} = await load('terminal/cli-registry.mjs');

const USAGE = 'usage: stack omniroute [--json] [--check]\n'
  + '       stack omniroute runtimes [--json]\n'
  + '       stack omniroute launch [--cli <key>] [--model <id>] [--context-tokens <n>] [-- <tool args>]\n'
  + '       stack omniroute setup <cli> [--dry-run]\n';

// Is a binary on PATH? `command -v` rather than `which`, which is not everywhere.
function onPath(bin) {
  if (!bin) return false;
  return spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0;
}

// ---- status ---------------------------------------------------------------

async function collect() {
  const gateway = await probeOmniRoute({ timeoutMs: 2500 });
  const p = getProvider('omniroute');
  const key = resolveProviderKey(p.envKey);
  const model = resolveHostValue('OMNIROUTE_MODEL');
  const baseSrc = resolveHostValue('OMNIROUTE_BASE_URL');

  // The catalogue read, and why it can legitimately be unavailable: the gateway
  // authenticates /v1/models but NOT /v1/messages. Inference works with no key
  // at all — that is the zero-config promise and what makes this provider
  // keyless — while the catalogue needs one. A 401 here is therefore a normal
  // state to report, never an error and never "the gateway is broken".
  let catalogue = { available: false, reason: 'gateway not reachable', models: 0, free: null };
  if (gateway.reachable) {
    catalogue = await readCatalogue();
  }

  return {
    gateway,
    baseUrl: gateway.baseUrl,
    baseUrlSource: baseSrc.key ? baseSrc.source : 'default',
    model: model.key || p.model,
    modelSource: model.key ? model.source : 'default (the free combo)',
    paidOptIn: Boolean(model.key),
    key: { configured: key.key.length > 0, source: key.source || null, keyLength: key.key.length },
    catalogue,
  };
}

async function readCatalogue() {
  // (#504) One reader, in model-switch.mjs, because the daemon now serves this
  // same catalogue to the browser's model picker and two fetchers would drift.
  // This wrapper keeps the status line's shape: a COUNT, plus the reason when
  // there is nothing to count.
  const r = await gatewayModels({ timeoutMs: 8000 });
  return r.ok
    ? { available: true, reason: '', models: r.models.length, hidden: r.total - r.models.length, free: null }
    : { available: false, reason: r.reason, models: 0, hidden: 0, free: null };
}

function renderStatus(s) {
  const out = [];
  out.push('Stack — the OmniRoute gateway');
  out.push('');
  if (s.gateway.reachable) {
    out.push(`  ● reachable   ${s.baseUrl}  (${s.baseUrlSource})`);
  } else {
    // Fail LOUD: name the reason, or a stopped gateway reads as a broken install.
    out.push(`  ○ UNREACHABLE ${s.baseUrl}  — ${s.gateway.reason}`);
    out.push('');
    out.push('  Nothing is answering there. If it should be running:');
    out.push('    docker start omniroute        # if the container exists');
    out.push('    docker ps -a --filter name=omniroute');
  }
  out.push('');
  out.push(`  Model     ${s.model}  (${s.modelSource})`);
  out.push(s.paidOptIn
    ? '            PAID ROUTING IS OPTED IN — OMNIROUTE_MODEL names a specific model.'
    : '            Free by default: the combo routes to keyless providers.');
  out.push(s.key.configured
    ? `  Key       configured · ${s.key.source} · ${s.key.keyLength} chars`
    : '  Key       none — inference does not need one; the catalogue does');
  if (s.gateway.reachable) {
    out.push(s.catalogue.available
      ? `  Catalogue ${s.catalogue.models} models`
        + (s.catalogue.hidden
          // The gap is SAID, not silently absorbed: a reader comparing this
          // with the gateway's own dashboard would otherwise have two counts
          // and no idea which one to believe.
          ? `\n            ${s.catalogue.hidden} more are listed and cannot be started `
            + '— their ids carry spaces or brackets; all measured so far are image models'
          : '')
      : `  Catalogue unavailable — ${s.catalogue.reason}`);
  }
  out.push('');
  out.push('Runtimes: stack omniroute runtimes');
  return out.join('\n');
}

// ---- runtimes -------------------------------------------------------------

function collectRuntimes() {
  return RUNTIMES.map((r) => ({
    key: r.key,
    label: r.label,
    launch: r.launch,
    telemetry: r.telemetry,
    installed: r.bin ? onPath(r.bin) : false,
    bin: r.bin,
    install: r.install,
    setup: r.setup,
    requiresModel: r.requiresModel,
    notes: r.notes,
  }));
}

function renderRuntimes(rows) {
  const out = [];
  out.push('Stack — CLI runtimes that can run against the gateway');
  out.push('');
  for (const r of rows) {
    const mark = r.installed ? '●' : '○';
    const how = r.launch === 'setup-only' ? 'setup-only' : r.launch;
    const tel = r.telemetry === 'full' ? 'full telemetry' : 'NO telemetry';
    out.push(`  ${mark} ${r.key.padEnd(13)} ${how.padEnd(11)} ${tel.padEnd(14)} ${r.installed ? 'installed' : 'not installed'}`);
    if (!r.installed && r.install) out.push(`      install:  ${r.install}`);
    if (!r.installed && !r.install) out.push('      install:  not pinned by OmniRoute\'s docs — configure by hand');
    if (r.setup) out.push(`      configure: stack omniroute setup ${r.key}`);
  }
  out.push('');
  out.push('● installed   ○ not installed');
  out.push('');
  out.push('"NO telemetry" is not a caveat, it is the deal: such a session files no');
  out.push('checkpoint, records no usage, is invisible to edit-watch, and gets NO branch');
  out.push('claims injected. Check `stack tree` before you pick anything up in one.');
  return out.join('\n');
}

// ---- launch ---------------------------------------------------------------

function launch(args) {
  const cliIdx = args.indexOf('--cli');
  const modelIdx = args.indexOf('--model');
  const dashdash = args.indexOf('--');
  const cli = cliIdx >= 0 ? args[cliIdx + 1] : 'claude';
  const model = modelIdx >= 0 ? args[modelIdx + 1] : '';
  // The window that goes WITH that model, read off the catalogue by whoever
  // picked it. Optional: without it Claude Code assumes 200k for an id it does
  // not recognise, which is right for the default combo and wrong for a pinned
  // 1M model — see providerEnv's note on why this is never guessed.
  const ctxIdx = args.indexOf('--context-tokens');
  const contextTokens = ctxIdx >= 0 ? cleanContextTokens(args[ctxIdx + 1]) : '';
  const passthrough = dashdash >= 0 ? args.slice(dashdash + 1) : [];

  const r = getRuntime(cli);
  if (!r) {
    process.stderr.write(`[stack] unknown runtime: ${cli}\n`
      + `        known: ${RUNTIMES.map((x) => x.key).join(', ')}\n`);
    return 1;
  }

  const baseSrc = resolveHostValue('OMNIROUTE_BASE_URL');
  const built = runtimeArgv(cli, {
    model,
    baseUrl: baseSrc.key ? omniRouteBaseUrl() : '',
    passthrough,
  });
  if (built.error) {
    process.stderr.write(`[stack] ${built.error}\n`);
    return 1;
  }
  // BOTH binaries, and the runtime's own comes first. For a delegated row
  // `built.bin` is `omniroute`, not the runtime — checking only that one lets a
  // missing codex through to be reported by a process the reader did not start,
  // after a banner for a session that was never going to begin.
  if (!onPath(r.bin)) {
    process.stderr.write(`[stack] ${r.bin} is not on PATH.\n`
      + (r.install ? `        install it with: ${r.install}\n`
        : '        OmniRoute pins no install line for it — configure it by hand.\n'));
    return 127;
  }
  if (!onPath(built.bin)) {
    process.stderr.write(`[stack] ${built.bin} is not on PATH.\n`
      + '        install it with: npm install -g omniroute\n');
    return 127;
  }

  // The banner BEFORE the handover, never after: the runtime's own splash will
  // scroll it away, and the branch-claim line is the half that matters.
  const banner = telemetryBanner(cli);
  if (banner) process.stderr.write(`\n⚠  ${banner.split('\n').join('\n   ')}\n\n`);

  // The child env: an allowlist plus what Stack deliberately passes, with every
  // name in the launched directory's .env shadowed. See cli-registry.runtimeEnv.
  const cwd = process.cwd();
  const extra = { OMNIROUTE_API_KEY: resolveProviderKey('OMNIROUTE_API_KEY').key || '' };
  if (r.launch === 'native') {
    // Stack owns this one's env: point it at the gateway itself.
    //
    // (#504) AND `--model` REACHES IT HERE, not through runtimeArgv. A native
    // runtime takes no model FLAG — `claude` has its own idea of what --model
    // means and it is not a gateway id — so for this row the model is an env
    // override, which is the only spelling claude actually honours. A delegated
    // row is the opposite: `omniroute run` takes the flag and owns the env.
    // Same word, two mechanisms, and this is where they part.
    Object.assign(extra, providerEnv('omniroute', { model, contextTokens }) || {});
  }
  const env = runtimeEnv({ cwd, extra });

  const run = spawnSync(built.bin, built.args, { stdio: 'inherit', cwd, env });
  if (run.error) {
    process.stderr.write(`[stack] could not launch ${built.bin}: ${run.error.message}\n`);
    return 1;
  }
  return run.status ?? 0;
}

// ---- setup ----------------------------------------------------------------

function setup(args) {
  const cli = args.find((a) => !a.startsWith('-'));
  if (!cli) {
    process.stderr.write('[stack] setup needs a runtime: stack omniroute setup <cli>\n');
    return 1;
  }
  const r = getRuntime(cli);
  if (!r) {
    process.stderr.write(`[stack] unknown runtime: ${cli}\n`);
    return 1;
  }
  if (!r.setup) {
    process.stderr.write(`[stack] ${r.label} has no OmniRoute setup command.\n`
      + `        ${r.notes}\n`);
    return 1;
  }
  if (!onPath('omniroute')) {
    process.stderr.write('[stack] omniroute is not on PATH — npm install -g omniroute\n');
    return 127;
  }
  // Deliberately a pass-through. Stack does not reimplement writing
  // ~/.codex/config.toml or ~/.qwen/settings.json: that is OmniRoute's own
  // tested recipe, and a second copy here would drift the moment either moves.
  const rest = args.filter((a) => a !== cli);
  const env = runtimeEnv({
    cwd: process.cwd(),
    extra: { OMNIROUTE_API_KEY: resolveProviderKey('OMNIROUTE_API_KEY').key || '' },
  });
  const run = spawnSync('omniroute', [r.setup, ...rest], { stdio: 'inherit', env });
  return run.status ?? 0;
}

// ---- main -----------------------------------------------------------------

export async function main(argv = []) {
  const args = Array.isArray(argv) ? argv : process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }

  const sub = args[0] && !args[0].startsWith('-') ? args[0] : '';
  const rest = sub ? args.slice(1) : args;

  if (sub === 'runtimes') {
    const rows = collectRuntimes();
    process.stdout.write(rest.includes('--json')
      ? JSON.stringify({ runtimes: rows }, null, 2) + '\n'
      : renderRuntimes(rows) + '\n');
    return 0;
  }
  if (sub === 'launch') return launch(rest);
  if (sub === 'setup') return setup(rest);
  if (sub) {
    process.stderr.write(`[stack] unknown subcommand: ${sub}\n${USAGE}`);
    return 1;
  }

  const known = new Set(['--json', '--check']);
  const unknown = args.find((a) => !known.has(a));
  if (unknown) {
    process.stderr.write(`[stack] unknown option: ${unknown}\n${USAGE}`);
    return 1;
  }

  const state = await collect();
  process.stdout.write(args.includes('--json')
    ? JSON.stringify(state, null, 2) + '\n'
    : renderStatus(state) + '\n');

  if (args.includes('--check')) return state.gateway.reachable ? 0 : 1;
  return 0;
}

const invoked = process.argv[1] && process.argv[1].endsWith('stack-omniroute.mjs');
if (invoked) {
  main(process.argv.slice(2)).then((code) => process.exit(code ?? 0));
}
