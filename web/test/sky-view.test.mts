// The Polaris sky's one "fit all" definition — tested against the REAL exports.
//
//   node web/test/sky-view.test.mts      # exits non-zero on any failure
//
// fitAll is a reset: it takes only the scope and must not carry anything else
// through. isFitAll is the chip's own question, and the scope must not be
// part of the answer — both scopes fit.
import { fitAll, isFitAll, FIT_ZOOM, type SkyView } from '../src/lib/skyView.ts';

let fails = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// ---- fitAll -----------------------------------------------------------------

check('fitAll(false) is the whole galaxy at Fit', fitAll(false), {
  northOnly: false, zoom: FIT_ZOOM, focus: null, selId: null, pan: { x: 0, y: 0 },
});

check('fitAll(true) is the same view in the north star scope', fitAll(true), {
  northOnly: true, zoom: FIT_ZOOM, focus: null, selId: null, pan: { x: 0, y: 0 },
});

check('only northOnly differs between the two scopes',
  { ...fitAll(false), northOnly: 'x' }, { ...fitAll(true), northOnly: 'x' });

check('fitAll ignores whatever you were looking at — same scope, deep-equal result',
  fitAll(false), fitAll(false));
check('...and in the north scope too', fitAll(true), fitAll(true));

{
  // No zoom, focus, selection or drag can survive a fitAll call — it takes
  // only the scope, so there is nothing else for the caller to pass through.
  const before: SkyView = { northOnly: false, zoom: 4, focus: 'core', selId: 99, pan: { x: 120, y: -40 } };
  check('fitAll from a scrolled, focused, selected, dragged view still resets fully',
    fitAll(before.northOnly), fitAll(false));
}

{
  const freshPan = fitAll(false).pan !== fitAll(false).pan;
  if (!freshPan) fails++;
  console.log(`${freshPan ? 'ok  ' : 'FAIL'}  fitAll returns a fresh pan object each call${freshPan ? '' : '\n        got  the same object\n        want two distinct objects'}`);
}

// ---- isFitAll -----------------------------------------------------------------

check('isFitAll is true for fitAll(false)', isFitAll(fitAll(false)), true);
check('isFitAll is true for fitAll(true) — scope is not part of the answer', isFitAll(fitAll(true)), true);

check('isFitAll is false when zoomed in',
  isFitAll({ ...fitAll(false), zoom: 2 }), false);
check("isFitAll is false with a focused system — 'core'",
  isFitAll({ ...fitAll(false), focus: 'core' }), false);
check("isFitAll is false with a focused system — 'belt'",
  isFitAll({ ...fitAll(false), focus: 'belt' }), false);
check('isFitAll is false with a focused system — a star id',
  isFitAll({ ...fitAll(false), focus: 'star-7' }), false);
check('isFitAll is false with a selected idea',
  isFitAll({ ...fitAll(false), selId: 12 }), false);
check('isFitAll is false with a non-zero pan on x alone',
  isFitAll({ ...fitAll(false), pan: { x: 5, y: 0 } }), false);
check('isFitAll is false with a non-zero pan on y alone',
  isFitAll({ ...fitAll(false), pan: { x: 0, y: 5 } }), false);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
