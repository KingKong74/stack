// A capped note says it was capped (BUG-12).
//
//   node server/test/cap-note.test.mjs      # exits non-zero on any failure
//
// Pure — capNote is a string function, so this needs no database and no host.
// The assertion that matters is the one about the MARKER, not the length: a
// slice at 2000 was already correct in the sense of bounding the column, and
// was still a defect, because the reader of a truncated account had no way to
// know it was reading part of one. Seven of the 212 notes on this host lost
// their tail that way, and the tail is where a session says what it could not
// finish.
import { capNote, NOTE_MAX } from '../src/util.js';

let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

// ---- under the cap: untouched except for trimming ---------------------------
{
  const note = 'Landed the branch strip on the Now room. Verified with a strict build.';
  check('a short note comes back whole', capNote(note) === note, capNote(note));
  check('whitespace is trimmed', capNote(`  ${note}\n`) === note);
  check('nullish is the empty string, not "null"', capNote(null) === '' && capNote(undefined) === '');
}

// ---- exactly at the cap: still no marker ------------------------------------
{
  const exact = 'x'.repeat(NOTE_MAX);
  check('a note of exactly the cap is not marked', capNote(exact) === exact);
}

// ---- over the cap: kept, and SAID ------------------------------------------
{
  const long = `${'x'.repeat(NOTE_MAX)}TAIL THAT GETS CUT`;
  const out = capNote(long);
  check('the first NOTE_MAX characters survive', out.startsWith('x'.repeat(NOTE_MAX)));
  check('the tail past the cap is gone', !out.includes('TAIL THAT GETS CUT'));
  check('the truncation is stated', /truncated/.test(out), out.slice(-120));
  check('the true length is named', out.includes(String(long.length)), out.slice(-120));
  check('the marker is the only thing past the cap', out.length < NOTE_MAX + 120, `length ${out.length}`);
}

// ---- the cap is a parameter, and the marker follows it ----------------------
{
  const out = capNote('abcdefghij', 4);
  check('a caller-set cap is honoured', out.startsWith('abcd') && !out.includes('efghij'), out);
  check('a caller-set cap is stated too', out.includes('10 characters') && out.includes('first 4'), out);
}

console.log(fails ? `\n${fails} failing` : '\nall passing');
process.exit(fails ? 1 : 0);
