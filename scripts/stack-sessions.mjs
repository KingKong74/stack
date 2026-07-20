#!/usr/bin/env node
// Stack — automation sessions from the terminal (`stack start-session` /
// `stack list-sessions`). The CLI face of Mission Control's job queue: start
// queues a manual autopilot job through the same POST /api/autopilot/start the
// ▶ Run now button uses (so the host dispatcher picks it up within a minute),
// list reads the queue back via GET /api/autopilot/jobs.
//
// Usage:
//   stack start-session [<slug>] [--item N]   start an automation session
//   stack list-sessions [<slug>] [--limit N] [--json]
//
//   <slug>      the project (start-session derives it from the cwd's git
//               remote when omitted; list-sessions defaults to all projects)
//   --item N    pin the session to roadmap item #N (default: the autopilot
//               picks the top eligible item itself)
//   --limit N   how many sessions to list (1–50, default 20)
//   --json      print the raw session rows as JSON
//
// API + token come from ~/.stack/env (STACK_API / STACK_TOKEN) — same source
// as the hooks and the dispatcher; the token is never printed.

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadStackEnv, projectFromGit } from '../hook/stack-post.mjs';

const fail = (msg) => { process.stderr.write(`[stack] ${msg}\n`); return 1; };

function apiConfig() {
  loadStackEnv();
  const api = (process.env.STACK_API || '').replace(/\/$/, '');
  const token = process.env.STACK_TOKEN;
  if (!api || !token) return null;
  return { api, token };
}

async function request(cfg, method, path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(`${cfg.api}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, json };
  } finally {
    clearTimeout(timer);
  }
}

// Positional slug wins; otherwise derive from the cwd's git remote — the same
// identity the hooks use, so `stack start-session` inside a tracked repo just
// works.
function resolveSlug(positional) {
  if (positional) return positional;
  const derived = projectFromGit(process.cwd());
  return derived?.slug || null;
}

function parseArgs(argv, flags) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags.includes(a)) {
      out[a] = argv[++i];
      if (out[a] === undefined || String(out[a]).startsWith('--')) return { error: `${a} needs a value` };
    } else if (a === '--json' || a === '--help' || a === '-h') {
      out[a] = true;
    } else if (a.startsWith('--')) {
      return { error: `unknown option: ${a}` };
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

const ACTIVE = new Set(['queued', 'claimed', 'running']);

export async function mainStart(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, ['--item']);
  if (args.error) return fail(`${args.error}\nusage: stack start-session [<slug>] [--item N]`);
  if (args['--help'] || args['-h']) {
    process.stdout.write('usage: stack start-session [<slug>] [--item N]\n');
    return 0;
  }
  if (args.positional.length > 1) return fail('too many arguments — one project slug at most.');

  const slug = resolveSlug(args.positional[0]);
  if (!slug) return fail('which project? Pass a slug (stack start-session <slug>) or run from inside a tracked repo.');

  let itemId = null;
  if ('--item' in args) {
    itemId = Number(args['--item']);
    if (!Number.isInteger(itemId) || itemId <= 0) return fail(`--item needs a roadmap item number, got "${args['--item']}".`);
  }

  const cfg = apiConfig();
  if (!cfg) return fail('not configured — ~/.stack/env needs STACK_API and STACK_TOKEN.');

  let res;
  try {
    res = await request(cfg, 'POST', '/api/autopilot/start', itemId ? { slug, itemId } : { slug });
  } catch {
    return fail(`could not reach ${cfg.api} — is the Stack API up?`);
  }
  if (res.status === 404) return fail(`no project called "${slug}" on ${cfg.api}.`);
  if (!res.ok) return fail(res.json.error || `the API said no (${res.status}).`);

  const job = res.json;
  // 200 = an open session for this project already exists — the API hands it
  // back instead of stacking a duplicate. Say so; don't claim a fresh start.
  if (res.status === 200) {
    process.stdout.write(`An automation session for ${job.slug} is already open — session ${job.id} (${job.status}).\n`);
    process.stdout.write('It runs to completion before a new one can start. Watch it with `stack list-sessions`.\n');
    return 0;
  }
  process.stdout.write('Automation session started.\n');
  process.stdout.write(`Session ID: ${job.id} · project ${job.slug}${job.itemId ? ` · item #${job.itemId}` : ''} · status ${job.status}\n`);
  process.stdout.write('The host dispatcher picks it up within a minute; follow along with `stack list-sessions` or Mission Control.\n');
  return 0;
}

export async function mainList(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, ['--limit']);
  if (args.error) return fail(`${args.error}\nusage: stack list-sessions [<slug>] [--limit N] [--json]`);
  if (args['--help'] || args['-h']) {
    process.stdout.write('usage: stack list-sessions [<slug>] [--limit N] [--json]\n');
    return 0;
  }
  if (args.positional.length > 1) return fail('too many arguments — one project slug at most.');
  const slug = args.positional[0] || '';
  const limit = '--limit' in args ? Number(args['--limit']) : 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return fail(`--limit needs a number from 1 to 50, got "${args['--limit']}".`);

  const cfg = apiConfig();
  if (!cfg) return fail('not configured — ~/.stack/env needs STACK_API and STACK_TOKEN.');

  let res;
  try {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (slug) qs.set('slug', slug);
    res = await request(cfg, 'GET', `/api/autopilot/jobs?${qs}`);
  } catch {
    return fail(`could not reach ${cfg.api} — is the Stack API up?`);
  }
  if (res.status === 404) return fail(`no project called "${slug}" on ${cfg.api}.`);
  if (!res.ok) return fail(res.json.error || `the API said no (${res.status}).`);

  const jobs = res.json;
  if (args['--json']) {
    process.stdout.write(JSON.stringify(jobs, null, 2) + '\n');
    return 0;
  }
  if (!jobs.length) {
    process.stdout.write(slug ? `No automation sessions for ${slug} yet.\n` : 'No automation sessions yet.\n');
    return 0;
  }
  const rows = jobs.map((j) => [
    String(j.id),
    j.slug,
    j.kind,
    ACTIVE.has(j.status) ? `● ${j.status}` : j.status,
    j.itemId ? `#${j.itemId}${j.itemTitle ? ` ${j.itemTitle}` : ''}`.slice(0, 40) : '—',
    j.when,
    j.detail || '',
  ]);
  const head = ['ID', 'PROJECT', 'KIND', 'STATUS', 'ITEM', 'WHEN', 'DETAIL'];
  const widths = head.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)));
  const line = (r) => r.map((cell, c) => cell.padEnd(widths[c])).join('  ').trimEnd() + '\n';
  process.stdout.write(line(head));
  for (const r of rows) process.stdout.write(line(r));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Run directly via `node scripts/stack-sessions.mjs [start|list] …`
  // Any thrown error (network issue, bug) must still exit non-zero so callers
  // can distinguish failure from success (#124). The mains use `fail()` for
  // expected errors; this catch handles unexpected throws.
  const list = process.argv[2] === 'list';
  const rest = process.argv.slice(list || process.argv[2] === 'start' ? 3 : 2);
  const code = await (list ? mainList(rest) : mainStart(rest)).catch((e) => {
    process.stderr.write(`[stack] ${list ? 'list-sessions' : 'start-session'} error: ${e.message}\n`);
    return 1;
  });
  process.exit(typeof code === 'number' ? code : 1);
}
