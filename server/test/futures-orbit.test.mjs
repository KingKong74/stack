// #314 — a converged set of Polaris ideas has to carry its orbit (#312) into
// the Gemini prompt: a star and its planets/moons, not a flat unrelated list.
//
//   node server/test/futures-orbit.test.mjs      # exits non-zero on any failure
//
// Pure: renderConvergeItems takes rows, not a request/db/Gemini, so this runs
// with no database and no framework — same idiom as fleet-roles.test.mjs.
import { renderConvergeItems } from '../src/routes/futures.js';

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${ok ? '' : `  (want ${JSON.stringify(want)})`}`);
};

const idea = (id, overrides = {}) => ({
  id, area: 'growth', alignment: 'on-course', title: `Idea ${id}`, note: `Note ${id}`,
  parent_id: null, is_star: false, ...overrides,
});

console.log('--- star with two planets and a moon ---');
{
  // Given out of orbit order on purpose — a loose idea interleaved between
  // the star and its planets, and a moon listed before its own planet — so a
  // passing test proves the function reorders, not that the input happened
  // to already be grouped. Root PLACEMENT still follows given order: the
  // star (first root seen) sorts before the loose idea (second root seen).
  const rows = [
    idea(1, { title: 'The star', is_star: true }),
    idea(30, { title: 'Moon of 20', parent_id: 20 }),
    idea(10, { title: 'Loose idea, no orbit' }),
    idea(20, { title: 'Planet of 1', parent_id: 1 }),
    idea(21, { title: 'Second planet of 1', parent_id: 1 }),
  ];
  const { text, shown, total, ids } = renderConvergeItems(rows);
  check('nothing dropped', [shown, total], [5, 5]);
  // Star (1) immediately followed by its own orbit (20, then 20's moon 30,
  // then 21) before the loose idea's given-order slot is reached.
  check('parent-before-orbit order', ids, [1, 20, 30, 21, 10]);
  check('star line marks itself', text.split('\n')[0], '1 | growth | on-course | star | The star | Note 1');
  check('planet line orbits its star', text.split('\n')[1], '20 | growth | on-course | orbits 1 | Planet of 1 | Note 20');
  check('moon line orbits its planet', text.split('\n')[2], '30 | growth | on-course | orbits 20 | Moon of 20 | Note 30');
  check('no cap note when nothing is dropped', text.includes('showing'), false);
}

console.log('\n--- ideas with no parent are unaffected ---');
{
  const rows = [idea(5, { title: 'Alpha' }), idea(6, { title: 'Beta' }), idea(7, { title: 'Gamma' })];
  const { ids, text } = renderConvergeItems(rows);
  check('given order kept', ids, [5, 6, 7]);
  check('loose ideas render "-"', text.split('\n').every((l) => l.includes(' | - | ')), true);
}

console.log('\n--- the cap states the true total and never orphans a child ---');
{
  // Three independent families of 4 (star + 3 planets each) — 12 rows, cap 10.
  // 10 is not a multiple of 4, so a naive slice-at-10 would cut the third
  // family's last planet away from its star. The family-aware cap must drop
  // the whole third family instead, keeping exactly 8.
  const rows = [];
  for (const s of [100, 200, 300]) {
    rows.push(idea(s, { title: `Star ${s}`, is_star: true }));
    for (const off of [1, 2, 3]) rows.push(idea(s + off, { title: `Planet ${s + off}`, parent_id: s }));
  }
  const { shown, total, ids, text } = renderConvergeItems(rows, 10);
  check('total is the true count', total, 12);
  check('shown is a whole number of families (8, not 10)', shown, 8);
  check('kept families only', ids, [100, 101, 102, 103, 200, 201, 202, 203]);
  check('no planet without its own star', ids.every((id) => {
    const r = rows.find((x) => x.id === id);
    return r.is_star || ids.includes(r.parent_id);
  }), true);
  check('prompt states the true total beside the shown count',
    text.includes('showing 8 of 12 picked ideas'), true);
}

console.log('\n--- root order is respected as GIVEN, not sorted ---');
{
  // The second-numbered family is listed FIRST in rows on purpose — id order
  // and given order disagree here, so a pass only proves anything if the
  // function is reading the rows' own order rather than sorting by id.
  const rows = [
    idea(200, { title: 'Star 200', is_star: true }),
    idea(201, { title: 'Planet 201', parent_id: 200 }),
    idea(202, { title: 'Planet 202', parent_id: 200 }),
    idea(100, { title: 'Star 100', is_star: true }),
    idea(101, { title: 'Planet 101', parent_id: 100 }),
    idea(102, { title: 'Planet 102', parent_id: 100 }),
  ];
  const { shown, ids } = renderConvergeItems(rows, 3);
  check('only room for one family', shown, 3);
  check('the FIRST-GIVEN family survives, not the lowest id', ids, [200, 201, 202]);
}

console.log('\n--- a family bigger than the cap is still kept whole ---');
{
  const rows = [idea(1, { is_star: true, title: 'Big star' })];
  for (let i = 2; i <= 25; i++) rows.push(idea(i, { parent_id: 1, title: `Planet ${i}` }));
  const { shown, total, ids } = renderConvergeItems(rows, 10);
  check('the oversized family is not truncated internally', shown, 25);
  check('every row is present', ids.length, total);
}

console.log('\n--- edge cases ---');
{
  const empty = renderConvergeItems([]);
  check('empty input does not throw and reports nothing', [empty.shown, empty.total, empty.ids], [0, 0, []]);
  const nully = renderConvergeItems(null);
  check('null input does not throw either', [nully.shown, nully.total], [0, 0]);
}

console.log('\n--- orphaned child (parent not in the picked set) falls back to given order ---');
{
  // Idea 50 orbits 40, but 40 was never picked — it must not crash the
  // grouping, and it still says WHO it orbits even though that parent is not
  // in this set to sit next to.
  const rows = [idea(50, { title: 'Orphan', parent_id: 40 }), idea(51, { title: 'Other' })];
  const { ids, text } = renderConvergeItems(rows);
  check('orphan treated as its own root, given order kept', ids, [50, 51]);
  check('orphan still names its parent', text.split('\n')[0].includes('orbits 40'), true);
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
