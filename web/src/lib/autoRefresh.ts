import { useEffect, useRef, useState } from 'react';
import { getAutoRefreshSeconds, onAutoRefreshChange } from '../store';

// #312 — the one recurring re-fetch in the app. Every screen that watches
// something moving on the HOST's clock (terminal sessions, branch previews,
// Mission Control's job queue, the skill tree) calls this instead of writing
// its own setInterval, so the Settings → Auto refresh control governs all of
// them and there is exactly one place to reason about the cost.
//
// Three rules the hand-rolled polls each got half-right:
//
//   • A HIDDEN TAB DOES NOT POLL. Background tabs used to keep hitting the API
//     all day for a screen nobody was looking at. The browser throttles the
//     timer, it does not stop it.
//   • …and coming BACK refreshes immediately, when a tick was actually missed.
//     That is the case the feature exists for: you switch away, the night
//     finishes, you switch back — the screen should not be showing the state
//     you left. Without this the tab reads stale for up to a whole interval,
//     which is the manual reload again by another name.
//   • The callback is read through a ref, so a caller may pass an inline arrow
//     (they all do) without re-arming the timer on every render — a re-armed
//     interval never fires when renders come faster than the interval.
//
// `enabled` is the caller's own gate (the screen is showing, a slug is known).
// It never resets the poll to a different cadence — only off and on.
//
// `whileHidden` is the ONE exception to the hidden-tab rule, and it has
// exactly one caller: the #519 notifier, when the owner has turned desktop
// notifications on. Its whole job is the moment he is NOT looking — a watcher
// that sleeps whenever the tab is hidden notifies only people already staring
// at it. It is still one light read per interval, still governed by the same
// cadence, and Off still means off.
export function useAutoRefresh(fn: () => void, enabled = true, opts: { whileHidden?: boolean } = {}): void {
  const whileHidden = !!opts.whileHidden;
  const latest = useRef(fn);
  useEffect(() => { latest.current = fn; });

  const [seconds, setSeconds] = useState(getAutoRefreshSeconds);
  useEffect(() => onAutoRefreshChange(() => setSeconds(getAutoRefreshSeconds())), []);

  useEffect(() => {
    if (!enabled || seconds <= 0) return;
    const ms = seconds * 1000;
    // Seeded at arm-time so the first visibility return can only fire once a
    // full interval has actually passed — flicking between tabs is not a
    // reason to re-fetch.
    let lastRun = Date.now();
    const run = () => { lastRun = Date.now(); latest.current(); };
    const t = window.setInterval(() => { if (whileHidden || !document.hidden) run(); }, ms);
    const onVisible = () => { if (!document.hidden && Date.now() - lastRun >= ms) run(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, seconds, whileHidden]);
}
