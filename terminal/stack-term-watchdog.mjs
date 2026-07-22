#!/usr/bin/env node
// Stack — the terminal daemon's watchdog (#221).
//
// The failure this exists for (2026-07-22): the daemon process was still alive
// on the host but its relay uplink had died hours earlier — pgrep said fine,
// Mission Control said no terminal, and nothing restarted anything. The relay's
// connected flag is the only honest health signal, so that's what this checks.
//
// Run from cron every few minutes:
//   */5 * * * * /usr/bin/node /home/you/stack/terminal/stack-term-watchdog.mjs >> ~/.stack/term-watchdog.log 2>&1
//
// Behaviour, deliberately conservative (a watchdog that flaps is worse than
// none):
//   1. Ask the relay GET /api/terminal/agent. connected:true → exit 0.
//   2. API unreachable → exit 0. We can't tell daemon-down from server-down,
//      and restarting the daemon can't fix a dead server (fail safe, like the
//      dispatcher).
//   3. connected:false → probe again after 30s (a daemon mid-reconnect-backoff
//      or a server that just rebooted reads as down for a moment).
//   4. Still false → kill every stack-term daemon process (both spellings: the
//      script path AND the bare retitled name — this morning's zombie held the
//      agent slot precisely because pgrep by script name missed it), then
//      relaunch exactly like the @reboot crontab line, detached, appending to
//      ~/.stack/term.log.
//   5. A restart stamp (~/.stack/term-watchdog.stamp) enforces a 10-minute
//      cool-down so a genuinely broken daemon doesn't get kill-looped while
//      you're reading its log.
//
// Zero dependencies; reads STACK_API/STACK_TOKEN from ~/.stack/env like every
// other host-side script. The token is never printed.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ~/.stack/env loader — same shape as the hooks', kept inline so the watchdog
// works even if the repo checkout is missing everything but this file.
(function loadEnvFile() {
  const f = join(homedir(), '.stack', 'env');
  if (!existsSync(f)) return;
  try {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const eq = s.indexOf('=');
      if (eq < 0) continue;
      const k = s.slice(0, eq).trim();
      const v = s.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (k && process.env[k] === undefined) process.env[k] = v;
    }
  } catch { /* unreadable env — the API probe below will just fail safe */ }
})();

const API = process.env.STACK_API;
const TOKEN = process.env.STACK_TOKEN;
const STAMP = join(homedir(), '.stack', 'term-watchdog.stamp');
const TERM_LOG = join(homedir(), '.stack', 'term.log');
const DAEMON = join(dirname(fileURLToPath(import.meta.url)), 'stack-term.mjs');
const COOLDOWN_MS = 10 * 60_000;

const log = (msg) => console.log(`${new Date().toISOString()} watchdog: ${msg}`);

if (!API || !TOKEN) { log('STACK_API/STACK_TOKEN not set — nothing checked.'); process.exit(0); }

async function agentConnected() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);
  try {
    const res = await fetch(`${API.replace(/\/$/, '')}/api/terminal/agent`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return null; // server up but odd (old build?) — treat as unknowable
    const body = await res.json();
    return body.connected === true;
  } catch {
    return null; // unreachable — fail safe
  } finally {
    clearTimeout(timer);
  }
}

const first = await agentConnected();
if (first === true) process.exit(0);
if (first === null) { log('API unreachable (or /api/terminal/agent not deployed yet) — nothing done; a daemon restart cannot fix that.'); process.exit(0); }

// Down. Give a mid-backoff daemon (or a server that just came up) one chance.
await new Promise((r) => setTimeout(r, 30_000));
const second = await agentConnected();
if (second !== false) {
  log(second === true ? 'uplink recovered on its own.' : 'API went unreachable — standing down.');
  process.exit(0);
}

// Confirmed down. Respect the cool-down so we never kill-loop a broken daemon.
try {
  if (Date.now() - statSync(STAMP).mtimeMs < COOLDOWN_MS) {
    log('uplink still down but inside the restart cool-down — waiting.');
    process.exit(0);
  }
} catch { /* no stamp yet — proceed */ }

// Kill both spellings of the daemon: by script path (a normally-launched one)
// and by the bare retitled name (the zombie shape that started all this).
// pkill exits 1 for "nothing matched", which is fine.
const pkill = (args) => { try { execFileSync('pkill', args, { stdio: 'ignore' }); return true; } catch { return false; } };
const killedByPath = pkill(['-f', 'stack-term.mjs']);
const killedByName = pkill(['-x', 'stack-term']);
log(`stale daemon processes killed (by path: ${killedByPath}, by title: ${killedByName}).`);

// Relaunch exactly like the @reboot line: detached, log appended.
const out = openSync(TERM_LOG, 'a');
spawn(process.execPath, [DAEMON], { detached: true, stdio: ['ignore', out, out] }).unref();
writeFileSync(STAMP, `${new Date().toISOString()}\n`);
log(`daemon relaunched (${DAEMON}) — uplink should be back within seconds.`);
