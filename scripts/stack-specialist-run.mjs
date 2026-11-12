#!/usr/bin/env node
// Capture exact refs and queue a diagnostic in the existing dispatcher lane.
// Dry until --run. Does not execute a model directly or change account settings.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { loadStackEnv } from '../hook/stack-post.mjs';
loadStackEnv();
const arg = (key, fallback) => { const i = process.argv.indexOf(`--${key}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const project = arg('project', 'stack'), profileKey = arg('profile', 'stack-reviewer');
const git = ref => { const r = spawnSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }); if (r.status !== 0) throw Error(`Cannot resolve ${ref}`); return r.stdout.trim(); };
const body = { requestId: arg('request-id', randomUUID()), profileKey, base: git(arg('base', 'HEAD^')), head: git(arg('head', 'HEAD')),
  includeWorkingTree: process.argv.includes('--include-working-tree'), maxSeconds: Number(arg('seconds', 90)), note: arg('note', '') };
if (!process.argv.includes('--run')) console.log(JSON.stringify({ dry: true, project, ...body }, null, 2));
else {
  const r = await fetch(`${process.env.STACK_API.replace(/\/$/, '')}/api/projects/${encodeURIComponent(project)}/specialists/runs`, { method: 'POST', headers: { authorization: `Bearer ${process.env.STACK_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw Error(`Enqueue failed (HTTP ${r.status})`);
  console.log(JSON.stringify(await r.json(), null, 2));
}
