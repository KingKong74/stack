// Swarm's tile preview and branch fields on GET /terminal/detached.
//   node server/test/term-preview.test.mjs      # pure, no database, no daemon
import assert from 'node:assert/strict';
import { previewLines, cleanBranch, cleanProject } from '../src/term-preview.js';

assert.deepEqual(previewLines(''), []);
assert.deepEqual(previewLines('a\n\n\n\nb\n\n\n'), ['a', '', 'b'], 'blank runs collapse, trailing blanks go');
assert.deepEqual(previewLines('\n\nfirst'), ['first'], 'leading blanks go');
assert.equal(previewLines(Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n')).length, 14, 'line cap');
assert.deepEqual(previewLines('x\ny\nz', 2), ['y', 'z'], 'keeps the END of the pane');
assert.equal(previewLines('q'.repeat(1000))[0].length, 240, 'width cap');
assert.deepEqual(previewLines('trail   \n'), ['trail']);

assert.equal(cleanBranch('term/d84389b4'), 'term/d84389b4');
assert.equal(cleanBranch('x; rm -rf'), '');
assert.equal(cleanBranch(undefined), '');
assert.equal(cleanProject('stack'), 'stack');
assert.equal(cleanProject('../etc'), '', 'no escaping the jail in a label');
console.log('term-preview: ok');
