import { go } from '../lib/route';
import type { AutopilotSchedule, ControlData, ControlProject, RunRow } from '../store';

// ---------------------------------------------------------------------------
// #286 (design 24a) — DEBRIEF A NIGHT. Opens from a cell in the Nights
// calendar (12a), which stays exactly as it was: this replaces the thin detail
// card that used to sit under the grid, not the grid.
//
// The design's roster is a REVIEWER and an ARCHITECT. Stack has one of them.
// The reviewer is real — `hook/stack-gemini-review.mjs` reads each auto/* push
// and stamps a one-line take onto the session — so its column is its actual
// output. The architect is not a thing Stack runs: there is no standing model
// watching the codebase across weeks, and no drift metric behind the design's
// bars. That column renders as an explicit absent state, and WHERE THEY
// DISAGREE does not render at all, because one opinion cannot disagree.
//
// The other half of the design is the part Stack can answer completely: what
// landed, and what the night is waiting on you to decide.
// ---------------------------------------------------------------------------

const fmtTok = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
const fmtUsd = (n: number) => (n >= 0.005 ? `$${n.toFixed(2)}` : n > 0 ? '<$0.01' : '$0.00');

const VERDICT_LABEL: Record<string, string> = {
  solid: 'SOLID', 'needs-work': 'NEEDS WORK', rethink: 'RETHINK',
};

// One decision the night is waiting on. Every one of these is a real crossing
// the autopilot cannot make alone — that is why they are the debrief's ask.
interface Decision {
  key: string;
  tag: string;
  tone: 'warn' | 'quiet';
  text: string;
  act: string;
  onAct: () => void;
}

export function NightDebrief({
  data, project, date, runs, books, nightly, past, onClose, onPickDay, days, onRunNow, onMerge, onOpenPlanner,
}: {
  data: ControlData;
  project: ControlProject;
  date: string;
  runs: RunRow[];
  // A night that has not happened has nothing to debrief. The same panel then
  // shows what is BOOKED for it, keeping the calendar's ✎ planner reachable.
  books: AutopilotSchedule[];
  nightly: boolean;
  past: boolean;
  days: { date: string; label: string; sub: string; on: boolean }[];
  onClose: () => void;
  onPickDay: (date: string) => void;
  onRunNow: () => void;
  onMerge: (branch: string, itemId: string, itemTitle: string, mergeClean?: boolean | null) => void;
  onOpenPlanner: (row: AutopilotSchedule) => void;
}) {
  // Future night, nothing run: this is a plan, not a debrief, and saying so
  // beats rendering an empty debrief that reads like the night failed.
  const upcoming = runs.length === 0 && !past;
  const landed = runs.filter((r) => r.outcome === 'landed');
  const tokens = runs.reduce((n, r) => n + r.tokens, 0);
  const cost = runs.reduce((n, r) => n + r.costUsd, 0);
  const commits = runs.reduce((n, r) => n + (r.commits ?? 0), 0);

  // The reviewer's notes for THIS night and project. Matching is by day + slug:
  // a push and the run that produced it share both, and the branch is carried
  // for display rather than used as the join, since a general night can push
  // more than one lane.
  const notes = (data.reviewNotes ?? []).filter((n) => n.slug === project.slug && n.day === date);
  const noteFor = (r: RunRow) =>
    notes.find((n) => r.branch && n.branch === r.branch) ?? null;

  // ---- what the night is waiting on ---------------------------------------
  const decisions: Decision[] = [];
  const awaiting = landed.filter((r) => r.itemDone && !r.verdict);
  if (awaiting.length > 0) {
    decisions.push({
      key: 'verdict', tag: 'VERDICT', tone: 'warn',
      text: `${awaiting.length} item${awaiting.length === 1 ? '' : 's'} landed and ${awaiting.length === 1 ? 'is' : 'are'} waiting on your verdict — the runner never marks its own work solid.`,
      act: '→ Reviews', onAct: () => go.detail(project.slug, 'roadmap'),
    });
  }
  // Branches this night produced that the host still reports as unmerged.
  const nightBranches = new Set(runs.map((r) => r.branch).filter(Boolean));
  const unmerged = (project.branches ?? []).filter((b) => nightBranches.has(b.branch));
  for (const b of unmerged) {
    decisions.push({
      key: `merge${b.branch}`, tag: 'MERGE', tone: 'warn',
      text: `${b.branch} is still open${b.ahead != null ? ` — ${b.ahead} ahead of main` : ''}${b.mergeClean === false ? ', and the host\'s probe says it conflicts' : b.mergeClean ? ' and merges clean' : ''}.`,
      act: '⇥ Merge',
      onAct: () => onMerge(b.branch, b.itemId, b.itemTitle, b.mergeClean),
    });
  }
  const red = runs.reduce((n, r) => n + (r.checksFailing ?? 0), 0);
  if (red > 0) {
    decisions.push({
      key: 'checks', tag: 'CHECKS', tone: 'warn',
      text: `The night left ${red} check${red === 1 ? '' : 's'} red. A green suite is what auto-merge and auto-verdict spend, so this is worth closing before the next night.`,
      act: '→ Quality', onAct: () => go.detail(project.slug, 'quality'),
    });
  }
  const limit = runs.some((r) => r.outcome === 'limit');
  if (limit) {
    decisions.push({
      key: 'limit', tag: 'PAUSED', tone: 'quiet',
      text: 'A session stopped on the usage limit. It queued its own resume — the Now room shows the hold and can fire it early.',
      act: '→ Now', onAct: onClose,
    });
  }
  if (decisions.length === 0 && runs.length > 0) {
    decisions.push({
      key: 'clear', tag: 'CLEAR', tone: 'quiet',
      text: 'Nothing from this night is waiting on you — every item that landed has a verdict, and no branch is left open.',
      act: '→ Reviews', onAct: () => go.detail(project.slug, 'roadmap'),
    });
  }

  const badge = upcoming ? (books.length || nightly ? 'booked' : 'open')
    : runs.length === 0 ? 'quiet'
    : runs.some((r) => r.outcome === 'failed') ? 'failed'
    : limit ? 'limit'
    : landed.length > 0 ? 'landed' : 'quiet';

  return (
    <div className="mc-debrief">
      <div className="db-head">
        <span className="title">{upcoming ? 'Planned' : 'Debrief'}</span>
        <div className="db-tabs" role="tablist" aria-label="Pick a night">
          {days.map((d) => (
            <button key={d.date} role="tab" aria-selected={d.on}
              className={`db-tab ${d.on ? 'on' : ''}`} onClick={() => onPickDay(d.date)}>
              <b>{d.label}</b>
              <i>{d.sub || '·'}</i>
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <span className="roster" title="Stack runs a reviewer over each push. It runs no architect — there is no standing model watching the codebase across weeks.">
          roster: reviewer{data.autopilot.advisorModel ? ' · advisor on builds' : ''} · no architect
        </span>
        <button className="db-close" onClick={onClose} aria-label="Close the debrief">×</button>
      </div>

      <div className="db-hero">
        <div className="l">
          <div className="row">
            <span className="t">{project.name} — {date}</span>
            <span className={`badge ${badge}`}>{badge}</span>
          </div>
          <div className="sum">
            {upcoming
              ? (books.length || nightly
                  ? `${books.length + (nightly ? 1 : 0)} session${books.length + (nightly ? 1 : 0) === 1 ? '' : 's'} booked. Nothing to debrief until it runs.`
                  : 'Nothing booked for this night, and nothing has run.')
              : runs.length === 0
              ? 'Nothing ran this night.'
              : `${runs.length} run${runs.length === 1 ? '' : 's'}, ${landed.length} landed${commits > 0 ? `, ${commits} commit${commits === 1 ? '' : 's'}` : ''}. ${
                  notes.length > 0
                    ? `The reviewer left ${notes.length} note${notes.length === 1 ? '' : 's'} on the pushes.`
                    : 'The reviewer left no note on these pushes.'}`}
          </div>
        </div>
        <div className="stats">
          <div className="st"><b>{runs.length}</b><span>runs</span></div>
          <div className="st"><b className="good">{landed.length}</b><span>landed</span></div>
          <div className="st"><b>{fmtTok(tokens)}</b><span>tokens</span></div>
          <div className="st"><b>{fmtUsd(cost)}</b><span>cost</span></div>
        </div>
      </div>

      <div className="db-body">
        <div className="db-main">
          <div className="db-cap">
            <span className="cap">{upcoming ? 'WHAT IS BOOKED' : 'WHAT LANDED'}</span>
            <span className="hair" />
            <span className="note">
              {upcoming ? `${books.length + (nightly ? 1 : 0)} booked`
                : runs.length === 0 ? 'nothing to show'
                : `${runs.length} attempt${runs.length === 1 ? '' : 's'}`}
            </span>
          </div>

          {upcoming && books.map((b) => (
            <div className="db-change booked" key={b.id}>
              <div className="row">
                <span className="dot booked" />
                <div className="who">
                  <span className="t">
                    {b.agenda.length ? `${b.agenda.length} on the agenda, in order`
                      : b.itemId ? `#${b.itemId} ${b.itemTitle || 'pinned item'}`
                      : b.area ? `the board, scoped to ${b.area}` : "the board's own priority order"}
                  </span>
                  <span className="w">{b.name} · {b.atTime} · {b.kind}</span>
                </div>
                <button className="btn-repo sm" onClick={() => onOpenPlanner(b)}>✎ Edit the plan</button>
              </div>
            </div>
          ))}
          {upcoming && nightly && (
            <div className="db-change booked">
              <div className="row">
                <span className="dot booked" />
                <div className="who">
                  <span className="t">the armed nightly — {data.autopilot.maxItems === 0
                    ? 'unlimited items (the clock and token budget govern)'
                    : `up to ${data.autopilot.maxItems} item${data.autopilot.maxItems === 1 ? '' : 's'}`}, must before should</span>
                  <span className="w">{data.autopilot.time} · every automode project</span>
                </div>
              </div>
            </div>
          )}
          {upcoming && books.length === 0 && !nightly && (
            <div className="db-none">
              Nothing is booked for this night. ▶ Run now queues a session, or + Plan a session
              books one on the calendar above.
            </div>
          )}

          {!upcoming && runs.length === 0 && (
            <div className="db-none">
              Nothing ran this night — nothing was queued, or the dispatcher was down. The Now
              room's fleet line says which.
            </div>
          )}

          {!upcoming && runs.map((r, i) => {
            const note = noteFor(r);
            return (
              <div className={`db-change ${r.outcome}`} key={`${r.itemId ?? 'gen'}${i}`}>
                <div className="row">
                  <span className={`dot ${r.outcome}`} />
                  <div className="who">
                    <span className="t">{r.itemId ? `#${r.itemId} ` : ''}{r.itemTitle || 'general session'}</span>
                    <span className="w">{r.branch || 'no branch'}{r.commits ? ` · ${r.commits} commit${r.commits === 1 ? '' : 's'}` : ''} · {r.when}</span>
                  </div>
                  <span className="diff">{fmtTok(r.tokens)} tok{r.costUsd > 0 ? ` · ${fmtUsd(r.costUsd)}` : ''}</span>
                  <span className={`verdict ${r.verdict || (r.itemDone ? 'awaiting' : r.outcome)}`}>
                    {r.verdict ? VERDICT_LABEL[r.verdict] ?? r.verdict.toUpperCase()
                      : r.itemDone ? 'AWAITING VERDICT'
                      : r.outcome.toUpperCase()}
                  </span>
                </div>
                <div className="notes">
                  {r.summary && (
                    <div className="n session">
                      <span className="agent">SESSION</span>
                      <span className="t">{r.summary}</span>
                    </div>
                  )}
                  {note?.note && (
                    <div className="n reviewer">
                      <span className="agent">REVIEWER</span>
                      <span className="t">{note.note}</span>
                    </div>
                  )}
                  {!r.summary && !note?.note && (
                    <div className="n quiet">
                      <span className="t">No account from the session and no reviewer note on this push.</span>
                    </div>
                  )}
                  <div className="acts">
                    {r.itemId && (
                      <button className="btn-repo sm" onClick={() => go.detail(project.slug, 'roadmap', r.itemId!)}>
                        {r.itemDone && !r.verdict ? 'Verdict it' : 'Open the item'}
                      </button>
                    )}
                    {r.branch && (
                      <button className="btn-repo sm" onClick={() => go.detail(project.slug, 'activity')}>
                        Open the activity
                      </button>
                    )}
                    <div style={{ flex: 1 }} />
                    <span className="meta">
                      {r.checksFailing == null ? 'checks not run'
                        : r.checksFailing === 0 ? 'checks green'
                        : `${r.checksFailing} check${r.checksFailing === 1 ? '' : 's'} red`}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}

          <div className="db-cap" style={{ marginTop: 4 }}>
            <span className="cap">DECISIONS THIS DEBRIEF ASKS FOR</span>
            <span className="hair" />
          </div>
          {decisions.map((d) => (
            <div className={`db-decision ${d.tone}`} key={d.key}>
              <span className="tag">{d.tag}</span>
              <span className="t">{d.text}</span>
              <button className="btn-repo sm" onClick={d.onAct}>{d.act}</button>
            </div>
          ))}
          {decisions.length === 0 && (
            <div className="db-none">
              Nothing to decide — this night has not run yet. ▶ Run now queues it.
            </div>
          )}
        </div>

        {/* ---- the roster rail ---- */}
        <div className="db-rail">
          <div className="db-agent">
            <div className="hd">
              <span className="chip reviewer">REVIEWER</span>
              <span className="model">{data.geminiReady === false ? 'no key configured' : 'gemini · per push'}</span>
            </div>
            {notes.length > 0 ? (<>
              <div className="verdictcard">
                <span className="v">{notes.length} note{notes.length === 1 ? '' : 's'} on this night</span>
                <span className="s">
                  The reviewer reads each auto/* push as a diff and leaves one line. Its findings
                  become review-inbox items; the structured verdict it produces is consumed by the
                  auto-merge gate and not kept, so these lines are what survives.
                </span>
              </div>
              {notes.map((n) => (
                <div className="revline" key={n.hash}>
                  <span className="mark">·</span>
                  <span className="t"><code>{n.hash}</code> {n.note}</span>
                </div>
              ))}
            </>) : (
              <div className="verdictcard quiet">
                <span className="v">No note on this night</span>
                <span className="s">
                  {data.geminiReady === false
                    ? 'No Gemini key is configured, so no review ran. Every Gemini surface is absent rather than broken.'
                    : 'The reviewer runs from the autopilot after a push. No note here means no auto/* push this night carried one.'}
                </span>
              </div>
            )}
          </div>

          <div className="db-sep" />

          {/* The design's second seat. Stack does not fill it, and drawing a
              plausible architect would be inventing output — so the seat is
              shown empty, with what filling it would actually require. */}
          <div className="db-agent">
            <div className="hd">
              <span className="chip architect off">ARCHITECT</span>
              <span className="model">not on the roster</span>
            </div>
            <div className="verdictcard quiet">
              <span className="v">No architect runs</span>
              <span className="s">
                Stack reviews each change but nothing watches the codebase across weeks, so there
                is no drift to report and nothing here to disagree with the reviewer. Filling this
                seat means a standing pass over the accumulated diff, on its own schedule — a
                different job from reviewing one push, and one nothing currently does.
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="db-foot">
        <button className="btn-repo sm" onClick={() => go.detail(project.slug, 'roadmap')}>→ Reviews</button>
        <button className="btn-repo sm" onClick={onRunNow}>▶ Run now</button>
        <div style={{ flex: 1 }} />
        <span className="note">
          Reverting is per item, from the Reviews view — ⎌ Undo reverts that item's commits on a
          throwaway worktree and un-ticks it. There is no revert-the-whole-night button, because a
          night is several independent items and undoing them as a block would take back work you
          may have already accepted.
        </span>
      </div>
    </div>
  );
}
