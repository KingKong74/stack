// Prompt labelling route with a fake Gemini response; no DB or external calls.
// node server/test/terminal-label-prompt.test.mjs
import assert from 'node:assert/strict';
import express from '../node_modules/express/index.js';
import { terminal } from '../src/routes/terminal.js';
import { termDetachedTails, setDetachedLabel } from '../src/term.js';
const app = express(); app.use(express.json()); app.use('/terminal', terminal);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const originalFetch = globalThis.fetch;
process.env.GEMINI_API_KEY = 'fake-test-key';
let calls = [];
let title = 'Terminal - Swarm edits';
globalThis.fetch = async (url, opts) => {
  if (!String(url).startsWith('https://generativelanguage.googleapis.com/')) return originalFetch(url, opts);
  calls.push(JSON.parse(opts.body).contents[0].parts[0].text);
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ labels: { 'stack-term-a': title } }) }] } }] }), { status: 200 });
};
termDetachedTails().push({ name: 'stack-term-a', tail: 'Old output', cwd: 'stack', cmd: 'codex' }, { name: 'stack-term-b', tail: 'Unrelated output', cwd: 'other' });
const post = (body) => fetch(`${base}/terminal/label`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
try {
  const first = await post({ tmux: 'stack-term-a', prompt: 'Please fix the Swarm tiles' });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).detached.find((d) => d.name === 'stack-term-a').label, title);
  assert.match(calls[0], /Please fix the Swarm tiles/);
  assert.doesNotMatch(calls[0], /Unrelated output|Old output|Session stack-term-b/);
  title = 'Terminal - Green alerts';
  const second = await post({ tmux: 'stack-term-a', prompt: 'Now make Codex asking green' });
  assert.equal((await second.json()).detached.find((d) => d.name === 'stack-term-a').label, title);
  assert.match(calls[1], /Now make Codex asking green/);
  assert.equal((await post({ prompt: 'Missing identity' })).status, 400);
  assert.equal((await post({ tmux: 'missing', prompt: 'Missing session' })).status, 404);
  title = 'Unexpected idle rename';
  const idle = await post({});
  assert.equal((await idle.json()).detached.find((d) => d.name === 'stack-term-a').label, 'Terminal - Green alerts');
  assert.equal(calls.length, 3);
  assert.doesNotMatch(calls[2], /Session stack-term-a/);
  assert.match(calls[2], /Session stack-term-b/);
  const stable = await post({ tmux: 'stack-term-a', prompt: 'Keep updating only from my prompt' });
  assert.equal((await stable.json()).detached.find((d) => d.name === 'stack-term-a').label, title);
  assert.equal(calls.length, 4);
  setDetachedLabel('stack-term-b', 'Other task');
  assert.equal((await post({})).status, 200);
  assert.equal(calls.length, 4, 'idle refresh with named sessions makes no model call');
  console.log('Prompt label route passed: targeted input and repeated updates');
} finally {
  globalThis.fetch = originalFetch;
  await new Promise((resolve) => server.close(resolve));
}
