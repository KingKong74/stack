// What model actually ANSWERED in a session (#505) — the transcript reader and
// the tmux->transcript map the SessionStart hook writes.
//
//   node server/test/session-model.test.mjs      # pure, no database, no daemon
//
// The thing worth pinning here is the FAIL-SILENT direction. Every unreadable
// case must come back '' so the row falls back to showing the route it asked
// for — never a guess, and never the route dressed up as an answer.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const { lastModelIn, noteTranscript, readMap, resolvedModelFor } =
  await import('../../terminal/session-model.mjs');

const dir = mkdtempSync(join(tmpdir(), 'stack-session-model-'));
try {
  const line = (model, text) => JSON.stringify({
    type: 'assistant', message: { model, content: [{ type: 'text', text }] },
  });

  // A gateway combo genuinely changes model mid-session — that is the whole
  // reason the route alone is not an answer. The LAST one is what answered.
  const t = join(dir, 'session.jsonl');
  writeFileSync(t, [line('big-pickle', 'one'), line('big-pickle', 'two'), line('mimo-v2.5-free', 'three')].join('\n'));
  check('the last model in the tail is the answer', lastModelIn(t), 'mimo-v2.5-free');

  // Fail silent, every way a read can go wrong.
  check('a missing file reads as unknown', lastModelIn(join(dir, 'nope.jsonl')), '');
  const empty = join(dir, 'empty.jsonl');
  writeFileSync(empty, '');
  check('an empty transcript reads as unknown', lastModelIn(empty), '');
  const noModel = join(dir, 'nomodel.jsonl');
  writeFileSync(noModel, JSON.stringify({ type: 'user', message: { content: 'hi' } }));
  check('a transcript with no model line reads as unknown', lastModelIn(noModel), '');

  // A tail read starts mid-line, so the first line is usually a fragment. The
  // reader must not care — and must still find the model on a LATER line.
  const big = join(dir, 'big.jsonl');
  writeFileSync(big, [line('old-model', 'x'.repeat(4000)), line('new-model', 'y')].join('\n'));
  check('a tail that starts mid-line still finds the last model',
    lastModelIn(big, { tailBytes: 500 }), 'new-model');
  // And when the window is too small to contain ANY model line, it says
  // unknown rather than reaching further back for a stale one.
  check('a tail too small to hold a model line says unknown',
    lastModelIn(big, { tailBytes: 8 }), '');

  // The map the hook writes.
  const map = join(dir, 'map.json');
  check('a map that does not exist yet is empty', readMap(map), {});
  check('noteTranscript writes', noteTranscript('stack-term-abc', t, { file: map }), true);
  check('and it reads back through the tmux name', resolvedModelFor('stack-term-abc', { file: map }), 'mimo-v2.5-free');
  check('an unknown tmux name is unknown, not a guess', resolvedModelFor('stack-term-nope', { file: map }), '');
  check('a nameless or pathless note is refused',
    [noteTranscript('', t, { file: map }), noteTranscript('x', '', { file: map })], [false, false]);

  // Pruning happens on WRITE, because the reader runs every minute and the
  // writer once per session.
  const old = Date.now() - 30 * 24 * 60 * 60_000;
  writeFileSync(map, JSON.stringify({ 'stack-term-ancient': { transcript: t, at: old } }));
  noteTranscript('stack-term-new', t, { file: map });
  check('an entry older than the TTL is dropped on the next write',
    Object.keys(readMap(map)), ['stack-term-new']);

  // Corrupt input is a missing map, not a crash: this file is on disk and is
  // written by a hook that must never block a session start.
  writeFileSync(map, 'not json at all');
  check('a corrupt map reads as empty', readMap(map), {});
  check('and resolving through it is unknown', resolvedModelFor('stack-term-abc', { file: map }), '');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
