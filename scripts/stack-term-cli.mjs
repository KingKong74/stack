// `stack term [dir]` — a claude session in a named stack-term-* tmux session,
// from any real terminal (typically a laptop over ssh).
//
// Same lifecycle as the web terminal's claude tabs (#188): the session runs
// inside tmux, so closing the laptop lid / dropping ssh only detaches — the
// process keeps running, and because the name wears the daemon's own
// stack-term- prefix it shows up on Mission Control's running-sessions strip
// (Gemini-labelled) where any browser can jump in. The web and the laptop can
// mirror the same session: tmux fans one session out to every client.
//
// The name is stable per directory (stack-term-<dir>), so `stack term stack`
// from the laptop always lands back in the same session. Detach with ctrl-b d.
//
//   stack term            claude in $HOME (session stack-term-home)
//   stack term stack      claude in ~/stack (session stack-term-stack)
//   stack term --safe …   without --dangerously-skip-permissions
//   stack term --shell …  a plain shell instead of claude

import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmuxAvailable, sessionArgv } from '../terminal/tmux-session.mjs';

export function main(args = []) {
  const safe = args.includes('--safe');
  const shell = args.includes('--shell');
  const dir = args.filter((a) => !a.startsWith('--'))[0] || '';

  if (!tmuxAvailable()) {
    process.stderr.write('[stack term] tmux is not installed — install it or run claude directly.\n');
    return 1;
  }

  // Same jail as the web daemon: bare names resolve under $HOME, nothing above it.
  const root = homedir();
  const cwd = resolve(root, dir);
  if (cwd !== root && !cwd.startsWith(root + sep)) {
    process.stderr.write(`[stack term] ${dir} escapes ${root} — sessions stay under home.\n`);
    return 1;
  }

  const slug = (dir.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'home').slice(0, 40);
  const name = `stack-term-${slug}`;
  const cmd = shell ? 'exec bash -l'
    : `exec claude${safe ? '' : ' --dangerously-skip-permissions'}`;

  process.stderr.write(`[stack term] session ${name} in ${cwd} — detach with ctrl-b d, it keeps running\n`);
  const argv = sessionArgv(name, cwd, `/bin/bash -lc "${cmd}"`);
  const r = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit' });
  return r.status ?? 0;
}

// Direct invocation (node scripts/stack-term-cli.mjs) — the dispatcher calls main().
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
