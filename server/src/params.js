// NUMERIC ROUTE PARAMS, VALIDATED BEFORE THEY REACH SQL.
//
// Found while testing #174: `DELETE /api/projects/stack/roadmap/undefined`
// KILLED THE WHOLE API. Not the request — the process. The route did
// `Number(req.params.id)`, handed the NaN to Postgres, and pg raised `invalid
// input syntax for type integer: "NaN"` inside an async handler. Express 4 does
// not catch a rejected promise from an async handler, so it surfaced as an
// unhandled rejection, and Node's default since v15 is to terminate. One
// malformed URL from any authenticated caller took Stack down for every project
// until the container restarted.
//
// It is trivially reachable by ACCIDENT, which is the point — that is exactly
// how it was found: a test script interpolated an `id` that was `undefined`
// into a path. A stale bookmark, a client bug, or a shell loop with an empty
// variable does the same thing.
//
// Two defences, and both are wanted:
//
//   • THIS — the handler never runs with a NaN, and the caller gets a 400 that
//     says what was wrong. `router.param()` is Express's own hook for exactly
//     this, so it costs one line per router and no change to any handler.
//   • The `unhandledRejection` guard in index.js — the backstop for the other
//     hundred-odd async handlers, where the next NaN-shaped bug will be.
//
// A param callback runs ONCE per request per param name, before every handler
// on that router, and `mergeParams` sub-routers get their own. It does not fire
// for a param the route does not declare, so mounting it is free on routers
// whose ids are not numeric.

// Ids are SERIAL columns: positive integers, nothing else. A float, a negative,
// a hex string or anything with a stray character is refused rather than
// truncated — `Number('3abc')` is NaN but `parseInt('3abc')` is 3, and a route
// that silently acts on item 3 because the caller asked for '3abc' is worse
// than one that says no.
const POSITIVE_INT = /^[1-9][0-9]{0,15}$/;

/**
 * An Express param callback that refuses anything but a positive integer.
 * `name` is only used in the message, so the caller is told which part of the
 * path it got wrong rather than just "bad request".
 *
 * Mount with: `router.param('id', numericParam('id'))`
 */
export function numericParam(name = 'id') {
  return (req, res, next, value) => {
    if (!POSITIVE_INT.test(String(value))) {
      return res.status(400).json({ error: `${name} must be a positive integer — got ${JSON.stringify(String(value))}.` });
    }
    next();
  };
}

/** The common case, ready to mount: `router.param('id', numericId)`. */
export const numericId = numericParam('id');
