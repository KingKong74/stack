// #330 — the Polaris galaxy's ✧ orbit proposal. filterOrbitProposals is pure
// precisely so a bad model answer can be exercised without a DB or a server.
//
//   node server/test/future-orbits.test.mjs      # exits non-zero on any failure
import { filterOrbitProposals } from '../src/routes/futures.js';

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${ok ? '' : `  (want ${JSON.stringify(want)})`}`);
};

const stars = [
  { id: 1, title: 'Terminal overhaul' },
  { id: 2, title: 'Mission Control' },
];
const loose = [
  { id: 10, title: 'Add tab completion' },
  { id: 11, title: 'Dark mode toggle' },
  { id: 12, title: 'Faster idle reaper' },
];

// A clean, legal proposal set.
{
  const out = filterOrbitProposals(
    { items: [{ id: 10, parentId: 1, why: 'Terminal work.' }, { id: 11, parentId: 2, why: '  Control theming.  ' }] },
    { stars, loose }
  );
  check('two legal proposals kept, in order', out.map((o) => o.id), [10, 11]);
  check('title comes from OUR row, not the model', out[0].title, 'Add tab completion');
  check('parentTitle comes from OUR row', out[0].parentTitle, 'Terminal overhaul');
  check('why is trimmed', out[1].why, 'Control theming.');
}

// raw not an object at all.
check('raw undefined -> []', filterOrbitProposals(undefined, { stars, loose }), []);
check('raw null -> []', filterOrbitProposals(null, { stars, loose }), []);
check('raw a bare string -> []', filterOrbitProposals('nonsense', { stars, loose }), []);

// items not an array.
check('items missing -> []', filterOrbitProposals({}, { stars, loose }), []);
check('items a string -> []', filterOrbitProposals({ items: 'nope' }, { stars, loose }), []);
check('items an object -> []', filterOrbitProposals({ items: { id: 10, parentId: 1 } }, { stars, loose }), []);

// String ids should coerce via Number and still match.
{
  const out = filterOrbitProposals({ items: [{ id: '10', parentId: '1', why: 'string ids' }] }, { stars, loose });
  check('string id coerces and matches', out.length, 1);
  check('string id coerced value', out[0]?.id, 10);
  check('string parentId coerced value', out[0]?.parentId, 1);
}

// Unknown ids on either side are dropped silently.
check('unknown loose id dropped', filterOrbitProposals({ items: [{ id: 999, parentId: 1 }] }, { stars, loose }), []);
check('unknown star id dropped', filterOrbitProposals({ items: [{ id: 10, parentId: 999 }] }, { stars, loose }), []);

// A star proposed as the child (id) is not a legal loose idea.
check('a star as the child id is dropped', filterOrbitProposals({ items: [{ id: 1, parentId: 2 }] }, { stars, loose }), []);

// A loose idea proposed as the parent is not a legal star.
check('a loose idea as the parent is dropped', filterOrbitProposals({ items: [{ id: 10, parentId: 11 }] }, { stars, loose }), []);

// Self-parenting.
check('self-parenting dropped (loose id used as its own parent)', filterOrbitProposals({ items: [{ id: 10, parentId: 10 }] }, { stars, loose }), []);
check('self-parenting dropped (star id both sides)', filterOrbitProposals({ items: [{ id: 1, parentId: 1 }] }, { stars, loose }), []);

// Duplicate ids: keep the first only.
{
  const out = filterOrbitProposals(
    { items: [{ id: 10, parentId: 1, why: 'first' }, { id: 10, parentId: 2, why: 'second' }] },
    { stars, loose }
  );
  check('duplicate id keeps only the first', out.length, 1);
  check('duplicate id keeps first parent', out[0].parentId, 1);
  check('duplicate id keeps first why', out[0].why, 'first');
}

// why is capped at 200 chars.
{
  const long = 'x'.repeat(300);
  const out = filterOrbitProposals({ items: [{ id: 10, parentId: 1, why: long }] }, { stars, loose });
  check('why capped at 200', out[0].why.length, 200);
}

// More than 20 items: capped at 20 kept proposals.
{
  const manyStars = Array.from({ length: 25 }, (_, i) => ({ id: 100 + i, title: `Star ${i}` }));
  const manyLoose = Array.from({ length: 25 }, (_, i) => ({ id: 200 + i, title: `Idea ${i}` }));
  const items = manyLoose.map((l, i) => ({ id: l.id, parentId: manyStars[i].id, why: `reason ${i}` }));
  const out = filterOrbitProposals({ items }, { stars: manyStars, loose: manyLoose });
  check('kept proposals capped at 20', out.length, 20);
  check('cap keeps the first 20 in order', out.map((o) => o.id), manyLoose.slice(0, 20).map((l) => l.id));
}

// Non-integer / garbage ids on either field are dropped.
check('non-numeric id dropped', filterOrbitProposals({ items: [{ id: 'nope', parentId: 1 }] }, { stars, loose }), []);
check('non-numeric parentId dropped', filterOrbitProposals({ items: [{ id: 10, parentId: 'nope' }] }, { stars, loose }), []);
check('missing id/parentId dropped', filterOrbitProposals({ items: [{ why: 'no ids at all' }] }, { stars, loose }), []);

// Empty stars or loose lists: nothing can ever match.
check('empty stars list yields nothing', filterOrbitProposals({ items: [{ id: 10, parentId: 1 }] }, { stars: [], loose }), []);
check('empty loose list yields nothing', filterOrbitProposals({ items: [{ id: 10, parentId: 1 }] }, { stars, loose: [] }), []);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
