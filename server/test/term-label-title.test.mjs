import assert from 'node:assert/strict';
import { titleLabel } from '../src/term-label.js';
assert.equal(titleLabel('terminal - Swarm edits'), 'Terminal - Swarm edits');
assert.equal(titleLabel('one two three four five six'), 'One two three four');
assert.equal(titleLabel('  login   error fix '), 'Login error fix');
assert.equal(titleLabel(''), '');
console.log('Terminal title limits passed');
