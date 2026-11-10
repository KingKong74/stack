import { hrefTo, type Route } from './route';

// THE FLICK (⌃`): one key between the terminal and the board, both ways.
//
// The terminal stays mounted once visited (App.tsx), so going back to
// `#/terminal` with NO cwd is exactly "back": same panes, same focus, nothing
// opened. Adding a cwd would re-run the screen's ⌨ handoff, which focuses or
// SPAWNS a session for that directory, so a cwd is passed only when the
// terminal has never been opened.
//
// From the terminal, the target is the BOARD of the project the FOCUSED pane is
// in, because that is the work you are looking at, and the button says Board.
// It never returns to whichever tab of that project you left (For you, say):
// the owner pressed Board and landed on For you (2026-11-10). A pane outside
// any project falls back to wherever you came from.
//
// Pure, so `scripts/flick.test.mjs` can read it without a browser.
export type FlickState = {
  /** The focused pane's project slug ('' when none, or not a tracked project). */
  termProject: string;
  /** The hash of the last non-terminal screen visited ('' before any). */
  lastAway: string;
  /** Whether the terminal has been mounted in this tab. */
  termMounted: boolean;
};

export function flickTarget(route: Route, s: FlickState): string {
  if (route.name === 'terminal') {
    if (s.termProject) return hrefTo.detail(s.termProject, 'roadmap');
    return s.lastAway || hrefTo.dashboard;
  }
  if (s.termMounted) return hrefTo.terminal();
  return hrefTo.terminal(route.name === 'detail' ? route.id : undefined);
}

/** ⌃` on every platform (⌘` is the macOS window switcher). Matched on the
    physical key, so a non-US layout's backquote position still works. */
export const isFlickKey = (e: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'code'>) =>
  e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === 'Backquote';

export const FLICK_HINT = '⌃`';
