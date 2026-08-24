#!/usr/bin/env node
// Stack — the agent spawn profile catalogue from the terminal (`stack
// agents`). The human-facing surface for server/src/agent-profiles.js's pure engine:
// list what a spawn can build with, read one profile in full (the prompt is
// the thing a human actually wants to read before customising it), create or
// PATCH one, reset a builtin back to factory or drop a custom one, and point
// one roadmap item at a profile — the same `agentProfile` PATCH the Roadmap
// modal would make, from the command line.
//
// `assign` checks the requested key against the live catalogue itself: the
// server stores `roadmap_items.agent_profile` as a free string (nothing to
// validate against at write time), so an assignment naming a profile that
// does not exist would silently fall back to the executor at spawn time —
// exactly the kind of silent nothing this repo avoids.
//
// Usage:
//   stack agents [list] [--json]
//   stack agents show <key>
//   stack agents set <key> [--name X] [--description X] [--model X]
//                    [--tools a,b,c] [--prompt X] [--prompt-file PATH]
//                    [--enable|--disable]
//   stack agents reset <key>
//   stack agents assign <slug> <item-id> [<key>]
//   stack agents help
//
// API + token come from ~/.stack/env (STACK_API / STACK_TOKEN) — same source
// as the hooks and the dispatcher; the token is never printed.

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadStackEnv } from '../hook/stack-post.mjs';

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

function parseArgs(argv, valueFlags = [], boolFlags = []) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valueFlags.includes(a)) {
      out[a] = argv[++i];
      if (out[a] === undefined || String(out[a]).startsWith('--')) return { error: `${a} needs a value` };
    } else if (boolFlags.includes(a)) {
      out[a] = true;
    } else if (a.startsWith('--')) {
      return { error: `unknown option: ${a}` };
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

function usage(stream) {
  stream.write([
    'usage: stack agents [list] [--json]',
    '       stack agents show <key>',
    '       stack agents set <key> [--name X] [--description X] [--model X]',
    '                        [--tools a,b,c] [--prompt X] [--prompt-file PATH]',
    '                        [--enable|--disable]',
    '       stack agents reset <key>',
    '       stack agents assign <slug> <item-id> [<key>]',
    '       stack agents help',
    '',
    'list and customise the agent spawn profiles.',
  ].join('\n') + '\n');
}

function table(rows, head) {
  const widths = head.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)));
  const line = (r) => r.map((cell, c) => cell.padEnd(widths[c])).join('  ').trimEnd() + '\n';
  process.stdout.write(line(head));
  for (const r of rows) process.stdout.write(line(r));
}

async function cmdList(argv) {
  const args = parseArgs(argv, [], ['--json', '--help', '-h']);
  if (args.error) return fail(`${args.error}\nusage: stack agents [list] [--json]`);
  if (args['--help'] || args['-h']) { process.stdout.write('usage: stack agents [list] [--json]\n'); return 0; }
  if (args.positional.length) return fail(`unexpected argument "${args.positional[0]}"\nusage: stack agents [list] [--json]`);

  const cfg = apiConfig();
  if (!cfg) return fail('not configured — ~/.stack/env needs STACK_API and STACK_TOKEN.');

  let res;
  try {
    res = await request(cfg, 'GET', '/api/agent-profiles');
  } catch {
    return fail(`could not reach ${cfg.api} — is the Stack API up?`);
  }
  if (!res.ok) return fail(res.json.error || `the API said no (${res.status}).`);

  if (args['--json']) {
    process.stdout.write(JSON.stringify(res.json, null, 2) + '\n');
    return 0;
  }

  const { profiles = [], knownTools = [] } = res.json || {};
  if (!profiles.length) {
    process.stdout.write('No agent profiles.\n');
    return 0;
  }
  const rows = profiles.map((p) => [
    p.key,
    p.name,
    p.model ? p.model : '(inherit)',
    (p.tools || []).join(', '),
    `${p.builtin ? 'builtin' : 'custom'}${p.enabled === false ? ' · disabled' : ''}`,
  ]);
  table(rows, ['KEY', 'NAME', 'MODEL', 'TOOLS', 'TYPE']);
  process.stdout.write(`\nKnown tools: ${knownTools.join(', ')}\n`);
  return 0;
}

async function cmdShow(argv) {
  const args = parseArgs(argv, [], ['--help', '-h']);
  if (args.error) return fail(`${args.error}\nusage: stack agents show <key>`);
  if (args['--help'] || args['-h']) { process.stdout.write('usage: stack agents show <key>\n'); return 0; }
  const key = args.positional[0];
  if (!key) return fail('which profile? usage: stack agents show <key>');
  if (args.positional.length > 1) return fail('too many arguments — one profile key at most.');

  const cfg = apiConfig();
  if (!cfg) return fail('not configured — ~/.stack/env needs STACK_API and STACK_TOKEN.');

  let res;
  try {
    res = await request(cfg, 'GET', '/api/agent-profiles');
  } catch {
    return fail(`could not reach ${cfg.api} — is the Stack API up?`);
  }
  if (!res.ok) return fail(res.json.error || `the API said no (${res.status}).`);

  const profile = (res.json.profiles || []).find((p) => p.key === key);
  if (!profile) return fail(`no such agent profile "${key}". Run \`stack agents list\` to see what's there.`);

  process.stdout.write(`key          ${profile.key}\n`);
  process.stdout.write(`name         ${profile.name}\n`);
  process.stdout.write(`type         ${profile.builtin ? 'builtin' : 'custom'}\n`);
  process.stdout.write(`status       ${profile.enabled === false ? 'disabled' : 'enabled'}\n`);
  process.stdout.write(`model        ${profile.model ? profile.model : '(inherit)'}\n`);
  process.stdout.write(`tools        ${(profile.tools || []).join(', ')}\n`);
  process.stdout.write(`description  ${profile.description || '(none)'}\n`);
  process.stdout.write(`\nprompt:\n${profile.prompt}\n`);
  return 0;
}

async function cmdSet(argv) {
  const usageLine = 'usage: stack agents set <key> [--name X] [--description X] [--model X] [--tools a,b,c] [--prompt X] [--prompt-file PATH] [--enable|--disable]';
  const args = parseArgs(
    argv,
    ['--name', '--description', '--model', '--tools', '--prompt', '--prompt-file'],
    ['--enable', '--disable', '--help', '-h']
  );
  if (args.error) return fail(`${args.error}\n${usageLine}`);
  if (args['--help'] || args['-h']) { process.stdout.write(`${usageLine}\n`); return 0; }
  const key = args.positional[0];
  if (!key) return fail(`which profile? ${usageLine}`);
  if (args.positional.length > 1) return fail('too many arguments — one profile key at most.');
  if (args['--enable'] && args['--disable']) return fail('--enable and --disable are mutually exclusive.');

  let prompt;
  if ('--prompt-file' in args) {
    try {
      prompt = readFileSync(resolve(args['--prompt-file']), 'utf8').trim();
    } catch (e) {
      return fail(`could not read --prompt-file "${args['--prompt-file']}": ${e.message}`);
    }
  } else if ('--prompt' in args) {
    prompt = args['--prompt'];
  }

  const patch = {};
  if ('--name' in args) patch.name = args['--name'];
  if ('--description' in args) patch.description = args['--description'];
  if ('--model' in args) patch.model = args['--model'];
  if ('--tools' in args) patch.tools = args['--tools'].split(',').map((t) => t.trim()).filter(Boolean);
  if (prompt !== undefined) patch.prompt = prompt;
  if (args['--enable']) patch.enabled = true;
  if (args['--disable']) patch.enabled = false;

  if (!Object.keys(patch).length) {
    return fail('nothing to set — pass at least one of --name, --description, --model, --tools, --prompt, --prompt-file, --enable, --disable.');
  }

  const cfg = apiConfig();
  if (!cfg) return fail('not configured — ~/.stack/env needs STACK_API and STACK_TOKEN.');

  let listRes;
  try {
    listRes = await request(cfg, 'GET', '/api/agent-profiles');
  } catch {
    return fail(`could not reach ${cfg.api} — is the Stack API up?`);
  }
  if (!listRes.ok) return fail(listRes.json.error || `the API said no (${listRes.status}).`);
  const exists = (listRes.json.profiles || []).some((p) => p.key === key);

  let res;
  try {
    if (exists) {
      res = await request(cfg, 'PATCH', `/api/agent-profiles/${encodeURIComponent(key)}`, patch);
    } else {
      // PATCH 404s on an unknown key — creating one needs the full POST, and
      // the server rejects a profile with no prompt, so catch that here with
      // a message that actually names the flag to pass.
      if (patch.prompt === undefined) {
        return fail(`"${key}" is not an existing profile — creating a new one needs a prompt (--prompt or --prompt-file).`);
      }
      res = await request(cfg, 'POST', '/api/agent-profiles', { key, ...patch });
    }
  } catch {
    return fail(`could not reach ${cfg.api} — is the Stack API up?`);
  }
  if (!res.ok) return fail(res.json.error || `the API said no (${res.status}).`);

  const verb = exists ? 'updated' : 'created';
  process.stdout.write(`Profile "${res.json.key}" ${verb}.\n`);
  process.stdout.write(`  name    ${res.json.name}\n`);
  process.stdout.write(`  model   ${res.json.model ? res.json.model : '(inherit)'}\n`);
  process.stdout.write(`  tools   ${(res.json.tools || []).join(', ')}\n`);
  process.stdout.write(`  status  ${res.json.enabled === false ? 'disabled' : 'enabled'}\n`);
  return 0;
}

async function cmdReset(argv) {
  const args = parseArgs(argv, [], ['--help', '-h']);
  if (args.error) return fail(`${args.error}\nusage: stack agents reset <key>`);
  if (args['--help'] || args['-h']) { process.stdout.write('usage: stack agents reset <key>\n'); return 0; }
  const key = args.positional[0];
  if (!key) return fail('which profile? usage: stack agents reset <key>');
  if (args.positional.length > 1) return fail('too many arguments — one profile key at most.');

  const cfg = apiConfig();
  if (!cfg) return fail('not configured — ~/.stack/env needs STACK_API and STACK_TOKEN.');

  let res;
  try {
    res = await request(cfg, 'DELETE', `/api/agent-profiles/${encodeURIComponent(key)}`);
  } catch {
    return fail(`could not reach ${cfg.api} — is the Stack API up?`);
  }
  if (res.status === 404) return fail(`no such agent profile "${key}".`);
  if (!res.ok) return fail(res.json.error || `the API said no (${res.status}).`);

  if (res.status === 204) {
    process.stdout.write(`Custom profile "${key}" removed.\n`);
  } else {
    process.stdout.write(`Builtin profile "${key}" reset to factory settings.\n`);
    process.stdout.write(`  model   ${res.json.model ? res.json.model : '(inherit)'}\n`);
    process.stdout.write(`  tools   ${(res.json.tools || []).join(', ')}\n`);
  }
  return 0;
}

async function cmdAssign(argv) {
  const usageLine = 'usage: stack agents assign <slug> <item-id> [<key>]';
  const args = parseArgs(argv, [], ['--help', '-h']);
  if (args.error) return fail(`${args.error}\n${usageLine}`);
  if (args['--help'] || args['-h']) { process.stdout.write(`${usageLine}\n`); return 0; }
  if (args.positional.length < 2) return fail(usageLine);
  if (args.positional.length > 3) return fail(`too many arguments.\n${usageLine}`);
  const [slug, itemArg, key] = args.positional;

  const itemId = Number(itemArg);
  if (!Number.isInteger(itemId) || itemId <= 0) return fail(`<item-id> needs a roadmap item number, got "${itemArg}".`);

  const cfg = apiConfig();
  if (!cfg) return fail('not configured — ~/.stack/env needs STACK_API and STACK_TOKEN.');

  if (key) {
    // The server column is a free string — validate against the live
    // catalogue here, or an unknown key would silently fall back to the
    // executor at spawn time instead of failing loudly.
    let listRes;
    try {
      listRes = await request(cfg, 'GET', '/api/agent-profiles');
    } catch {
      return fail(`could not reach ${cfg.api} — is the Stack API up?`);
    }
    if (!listRes.ok) return fail(listRes.json.error || `the API said no (${listRes.status}).`);
    const known = (listRes.json.profiles || []).map((p) => p.key);
    if (!known.includes(key)) {
      return fail(`no such agent profile "${key}" — assigning it would silently fall back to the executor at spawn time. Known profiles: ${known.join(', ') || '(none)'}.`);
    }
  }

  let res;
  try {
    res = await request(cfg, 'PATCH', `/api/projects/${encodeURIComponent(slug)}/roadmap/${itemId}`, { agentProfile: key || '' });
  } catch {
    return fail(`could not reach ${cfg.api} — is the Stack API up?`);
  }
  if (res.status === 404) return fail(`no project "${slug}" or no roadmap item #${itemId} on ${cfg.api}.`);
  if (!res.ok) return fail(res.json.error || `the API said no (${res.status}).`);

  if (key) {
    process.stdout.write(`Item #${itemId} in ${slug} now builds with profile "${key}".\n`);
  } else {
    process.stdout.write(`Item #${itemId} in ${slug} cleared — builds with the default executor.\n`);
  }
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  const sub = argv[0];
  const rest = argv.slice(1);

  if (!sub || sub.startsWith('--')) return cmdList(argv);

  switch (sub) {
    case 'list': return cmdList(rest);
    case 'show': return cmdShow(rest);
    case 'set': return cmdSet(rest);
    case 'reset': return cmdReset(rest);
    case 'assign': return cmdAssign(rest);
    case 'help':
      usage(process.stdout);
      return 0;
    default:
      process.stderr.write(`[stack] unknown agents subcommand: ${sub}\n\n`);
      usage(process.stderr);
      return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Run directly via `node scripts/stack-agents.mjs [list|show|set|reset|assign] …`
  // Any thrown error (network issue, bug) must still exit non-zero so callers
  // can distinguish failure from success (#124). The cmd*() functions use
  // fail() for expected errors; this catch handles unexpected throws.
  const code = await main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`[stack] agents error: ${e.message}\n`);
    return 1;
  });
  process.exit(typeof code === 'number' ? code : 1);
}
