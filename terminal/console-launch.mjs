// SPAWNING A TAB AGENT'S CONSOLE AS THAT AGENT (#380).
//
// A console (#379) was `exec claude` in the project's checkout: a plain session
// that happened to be drawn on the Auditor's tab. It now spawns with the
// agent's briefing as an appended system prompt, so it IS the Auditor from turn
// zero — no paste, no Enter, and no first turn spent re-typing what the tab was
// already showing. The text comes from the server (`routes/console.js`); this
// module is only how it reaches the CLI.
//
// ---- why a launcher script, and not an argument ---------------------------
//
// The prompt is multi-line prose with quotes, backticks and apostrophes in it,
// and the path it has to travel is hostile to every one of them: the daemon
// builds a shell string, tmux hands that string to /bin/sh, and sh hands what
// is left to bash. Three parsers, each with its own quoting rules, and one
// unbalanced quote in a project's north star silently changes the command.
//
// So the TEXT never travels. It is written to a file, and a two-line script
// beside it reads it back with `$(cat …)` — a shell substitution, not a parse,
// so the prompt can contain anything at all. Only two things are interpolated
// into a command line, and both are constrained: a path this module composed
// itself, and a model alias matched against an allow-list. That is the same
// posture as `skipPerms`: a boolean mapped to one flag, no path for arbitrary
// arguments to reach the spawn.
//
// `--append-system-prompt` and not `--system-prompt`: the CLI's own prompt is
// what makes the session able to work in the checkout at all, and replacing it
// would buy an agent identity at the cost of the agent. Verified honoured by an
// INTERACTIVE session, which is the only mode a console ever runs in.
//
// ---- and why writing the file is safe -------------------------------------
//
// The prime arrives over the browser's start frame, so in principle a client
// could send any text. It is not a new privilege: the same client can open a
// shell session on this host and type anything into it. What is bounded here is
// the blast radius of the FILE — one directory Stack owns, one file per session
// name (already validated by the caller), a length cap, and a name that can
// never contain a path separator.

import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The same cap the server composes to (console-prime.PRIME_CAP), applied again
// here because this end must not trust the length of what it was handed.
export const PRIME_CAP = 8000;

// The alias allow-list, matching server/src/agents.js's cleanAgentModel: a safe
// freeform charset rather than an enum, so a model newer than the catalogue
// still works and nothing with whitespace or shell metacharacters reaches a
// command line.
const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

// POSIX single-quote escaping: the only characters that survive are the ones
// inside the quotes, and an embedded quote is closed, escaped and reopened.
export const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The script, as a pure function of the two constrained inputs — so the shape
// of the command can be tested without a filesystem or a claude on the box.
export function launchScript({ promptPath, skipPerms, model }) {
  const args = [`--append-system-prompt "$(cat ${shQuote(promptPath)})"`];
  if (skipPerms === true) args.push('--dangerously-skip-permissions');
  if (model && MODEL_RE.test(String(model))) args.push('--model', shQuote(String(model)));
  return `#!/bin/bash
# Written by Stack's terminal daemon (#380) — the launcher for one tab agent's
# console. Regenerated every time that console is opened; editing it by hand
# lasts until the next open.
exec claude ${args.join(' ')}
`;
}

export const consoleDir = () => join(homedir(), '.stack', 'console');

// Write the pair and return the SCRIPT PATH, or '' if the write failed. '' is
// the FAIL-SAFE direction and both callers depend on it: an unprimed console is
// a working terminal, and a console that refuses to open because a file could
// not be written is not. The path (rather than a command) is what comes back
// because the two spawn paths quote differently — one builds a shell string for
// tmux, the other an argv array.
//
// `key` must already be a validated tmux session name (or an equally
// constrained id) — it becomes a filename, and this asserts rather than
// sanitises, because a caller that has not validated it has a bug elsewhere.
export function primedLaunch({ key, prime, skipPerms, model }) {
  if (!prime || !/^[A-Za-z0-9_-]{1,80}$/.test(String(key || ''))) return '';
  try {
    const dir = consoleDir();
    mkdirSync(dir, { recursive: true });
    const promptPath = join(dir, `${key}.md`);
    const scriptPath = join(dir, `${key}.sh`);
    writeFileSync(promptPath, String(prime).slice(0, PRIME_CAP), 'utf8');
    writeFileSync(scriptPath, launchScript({ promptPath, skipPerms, model }), 'utf8');
    chmodSync(scriptPath, 0o700);
    return scriptPath;
  } catch {
    return '';
  }
}

// Run it as a LOGIN shell, like the unprimed path's `bash -lc`: claude is on
// PATH through the owner's profile, and a non-login shell would not find it.
export const launchCommand = (scriptPath) => `/bin/bash -l ${shQuote(scriptPath)}`;
