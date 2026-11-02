// node --test server/test/codex-account.test.mjs — no account or model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { readCodexAccount, parseCodexLimits, createCodexAccount } from '../../terminal/codex-account.mjs';
import { nativeLaunch } from '../../terminal/native-launch.mjs';

test('quota windows retain unknowns and convert seconds to milliseconds', () => {
  assert.equal(parseCodexLimits({}), null);
  assert.deepEqual(parseCodexLimits({ rateLimits: { primary: { usedPercent: 0, resetsAt: 42, windowDurationMins: 300 }, secondary: { usedPercent: 'bad' } } }), [
    { key: 'codex:primary', name: 'Codex · Session · 5h', pct: 0, resetAt: 42000 },
  ]);
  assert.equal(parseCodexLimits({ rateLimitsByLimitId: { custom: { limitName: 'Extra', secondary: { usedPercent: 101, windowDurationMins: 10080 } } } })[0].pct, 100);
});
test('read-only handshake, pagination and partial quota failure', async () => {
  const calls = [];
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.kill = () => {};
    child.stdin = new Writable({ write(bytes, _, callback) {
      const req = JSON.parse(bytes);
      calls.push(req);
      let result;
      if (req.id === 0) result = {};
      if (req.id === 1) result = req.params.cursor ? { data: [{ model: 'gpt-b' }] } : { data: [{ model: 'gpt-a', displayName: 'A' }], nextCursor: 'next' };
      if (req.id === 2) { queueMicrotask(() => child.stdout.write(JSON.stringify({ id: 2, error: { message: 'unavailable' } }) + '\n')); }
      else if (req.id !== undefined) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: req.id, result }) + '\n'));
      callback();
    } });
    return child;
  };
  assert.deepEqual(await readCodexAccount({ spawnProcess }), { models: [{ id: 'gpt-a', label: 'A' }, { id: 'gpt-b', label: 'gpt-b' }], limits: null });
  assert.deepEqual([...new Set(calls.map((c) => c.method))], ['initialize', 'initialized', 'model/list', 'account/rateLimits/read']);
});
test('missing CLI and timeout return unknown', async () => {
  const fake = (error) => () => {
    const c = new EventEmitter(); c.stdout = new PassThrough(); c.stdin = new PassThrough(); c.kill = () => {};
    if (error) queueMicrotask(() => c.emit('error', Error('missing')));
    return c;
  };
  assert.equal(await readCodexAccount({ spawnProcess: fake(true) }), null);
  assert.equal(await readCodexAccount({ spawnProcess: fake(false), timeoutMs: 10 }), null);
});
test('cache throttles failures, deduplicates and expires old success', async () => {
  let time = 0; let calls = 0;
  const account = createCodexAccount({ now: () => time, read: async () => ++calls === 1 ? { models: [], limits: [] } : null });
  const tick = () => new Promise((r) => setImmediate(r));
  assert.equal(account.get(), null); account.get(); await tick();
  assert.equal(calls, 1); assert.ok(account.get());
  time = 600_001; assert.equal(account.get(), null); await tick(); account.get();
  assert.equal(calls, 2);
});
test('explicit models use one safe argument and YOLO; shell injection rejected', () => {
  assert.match(nativeLaunch('codex', { codexModel: 'gpt-6.1-sol' }).command, /--dangerously-bypass-approvals-and-sandbox --model gpt-6.1-sol$/);
  for (const codexModel of ['a;id', '$(id)', '--help', "a'b"]) assert.throws(() => nativeLaunch('codex', { codexModel }));
});
