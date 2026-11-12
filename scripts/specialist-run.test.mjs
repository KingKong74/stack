import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runSpecialistJob, parseDiagnosticResult, nativeDiagnosticArgs } from './lib/specialist-run.mjs';
const repo = mkdtempSync(join(tmpdir(), 'stack-diagnostic-'));
const git = args => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
try {
 git(['init']); writeFileSync(join(repo, 'fixture.txt'), 'before'); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=f@f', 'commit', '-m', 'before']); const base = git(['rev-parse', 'HEAD']);
 writeFileSync(join(repo, 'fixture.txt'), 'after'); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=f@f', 'commit', '-m', 'after']); const head = git(['rev-parse', 'HEAD']);
 const spec = { base, head, includeWorkingTree: false, prompt: 'Review supplied evidence', note: '', maxSeconds: 10 };
 let calls = 0;
 const invoke = async prompt => { calls++; assert.ok(prompt.includes(head)); assert.ok(prompt.includes('Every tool and MCP server is disabled')); return { text: JSON.stringify({ summary: 'No findings in this scope', findings: [], read: [], blind: [] }) }; };
 const emptyScope = await runSpecialistJob({ repo, spec: { ...spec, paths: ['not-changed.txt'] }, invoke }); assert.equal(emptyScope.skipped, true); assert.equal(calls, 0);
 const result = await runSpecialistJob({ repo, spec, invoke }); assert.equal(result.findings.length, 0); assert.equal(result.provenance.head, head);
 writeFileSync(join(repo, 'fixture.txt'), 'dirty');
 const dirty = await runSpecialistJob({ repo, spec, invoke }); assert.equal(dirty.provenance.dirty, true); assert.ok(dirty.blind.some(b => b.includes('excluded')));
 const skipped = await runSpecialistJob({ repo, spec: { ...spec, base: head }, invoke }); assert.equal(skipped.skipped, true); assert.equal(calls, 2);
 await assert.rejects(() => runSpecialistJob({ repo, spec: { ...spec, head: base }, invoke }), /HEAD changed/);
 assert.throws(() => parseDiagnosticResult('', { read: [], blind: [] }), /No model read/);
 assert.throws(() => parseDiagnosticResult(JSON.stringify({ summary: 'invented', findings: [{ title: 'bad', path: 'outside', trigger: 'x', evidence: ['x'] }], read: [], blind: [] }), { read: ['fixture.txt'], blind: [] }), /supplied file scope/);
 console.log('PASS: captured Git provenance, dirty scope, empty-input no-op, stale HEAD refusal and missing/ungrounded output handling.');
} finally { rmSync(repo, { recursive: true, force: true }); }

const args = nativeDiagnosticArgs('supplied diff', '');
assert.ok(args[args.indexOf('--system-prompt') + 1].includes('Return one JSON object'));
assert.equal(args[args.indexOf('--tools') + 1], '');
assert.equal(args[args.indexOf('--max-turns') + 1], '1');
assert.ok(args.includes('--strict-mcp-config'));
