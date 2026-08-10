#!/usr/bin/env node
// Stack — /checkpoint poster.
//
// Reads a JSON checkpoint on stdin and POSTs it to STACK_API/api/ingest as a
// rich, Claude-authored checkpoint (authored = true). The /checkpoint slash
// command composes the JSON; this script just loads the token from ~/.stack/env
// (never printing it) and ships it. Shares its POST/env/git logic with the
// SessionEnd hook via stack-post.mjs.
//
// Usage:
//   node ~/.stack/stack-checkpoint.mjs            # read checkpoint JSON on stdin and post
//   node ~/.stack/stack-checkpoint.mjs --settings # print current settings JSON (for the command)
//
// Install: copy alongside the hooks into ~/.stack/ (with stack-post.mjs).

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  loadStackEnv, logStderr, projectFromGit, fetchSettings, postIngest,
} from './stack-post.mjs';

loadStackEnv();

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

// #381/#174 — the tmux session this checkpoint is being written from, so a fly
// card and a built row can both be stamped with it. Filled HERE rather than
// asked of the composing session: it is a fact about the process, and a model
// asked for one it cannot see will supply a plausible-looking name instead of
// nothing, which is worse than no provenance at all.
//
// Silent on every failure — not in tmux, no tmux binary, a name that is not the
// shape the server accepts. This is provenance, and no checkpoint may ever fail
// for want of it.
function tmuxSession() {
  if (!process.env.TMUX) return null;
  try {
    const name = execFileSync('tmux', ['display-message', '-p', '#S'], {
      encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) ? name : null;
  } catch { return null; }
}

(async () => {
  if (!process.env.STACK_API || !process.env.STACK_TOKEN) {
    logStderr('STACK_API and STACK_TOKEN must be set in ~/.stack/env.');
    process.exit(1);
  }

  // --settings: emit the current settings so /checkpoint can honour
  // checkpoint_detail and include_chores. Token stays inside this process.
  if (process.argv.includes('--settings')) {
    const s = await fetchSettings();
    process.stdout.write(JSON.stringify(s));
    process.exit(0);
  }

  let input = {};
  try { input = JSON.parse(readStdin() || '{}'); } catch {
    logStderr('checkpoint stdin was not valid JSON.');
    process.exit(1);
  }

  // Fill the project identity from git if the caller didn't provide one.
  const cwd = input.cwd || input.session?.cwd || process.cwd();
  const fromGit = projectFromGit(cwd);
  const project = {
    slug: input.project?.slug || fromGit.slug,
    name: input.project?.name || fromGit.name,
    repo: input.project?.repo || fromGit.repo,
    repo_url: input.project?.repo_url || fromGit.repo_url,
  };

  // Force the authored flag and fill commit/branch from git when absent.
  const session = {
    ...(input.session || {}),
    authored: true,
    commit_hash: input.session?.commit_hash || fromGit.commit,
    branch: input.session?.branch || fromGit.branch,
    // A name the caller sent wins — a session may know better than the process
    // it is running in (a console spawned under another name) — but it is
    // filled from tmux when absent rather than left to be guessed.
    session: input.session?.session || tmuxSession() || undefined,
    cwd,
  };

  const body = {
    project,
    session,
    extract: input.extract || { bugs: [], next_steps: [] },
  };

  const result = await postIngest(body);
  if (!result.ok) {
    logStderr(`checkpoint failed${result.status ? ` (HTTP ${result.status})` : ''}${result.reason ? `: ${result.reason}` : ''}`);
    process.exit(1);
  }
  logStderr(`checkpoint saved for ${project.slug}${session.commit_hash ? ` @ ${session.commit_hash}` : ''}`);

  // #174 — say what the `built` block did, and say it even when it did nothing
  // it was asked to. `missed` is the line that matters: a roadmap id that is
  // not on this board means the session cited a wrong number, and a silent
  // success there is exactly the failure this feature exists to end. Printed
  // only when something was actually sent, so an ordinary checkpoint is as
  // quiet as it always was.
  const built = result.body?.built;
  if (built && (built.linked || built.created || built.missed)) {
    const parts = [];
    if (built.linked) parts.push(`${built.linked} row(s) updated`);
    if (built.created) parts.push(`${built.created} row(s) filed`);
    if (built.missed) parts.push(`${built.missed} id(s) NOT on this board — nothing was written for them`);
    logStderr(`built: ${parts.join(', ')}`);
  }
  process.exit(0);
})();
