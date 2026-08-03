import { useCallback, useEffect, useRef, useState } from 'react';
import { go } from '../lib/route';
import { getReviewDebrief, type AutopilotSchedule, type ControlData, type ControlProject, type ReviewDebrief, type RunRow } from '../store';

// ---------------------------------------------------------------------------
// #286 (design 24a) — DEBRIEF A NIGHT. Opens from a cell in the Nights
// calendar (12a), which stays exactly as it was: this replaces the thin detail
// card that used to sit under the grid, not the grid.
//
// The design's roster is a REVIEWER and an ARCHITECT. Stack has one of them.
// The reviewer is real, and since #282 its read is STORED on the run row
// (review_verdict / review_note / review_findings) rather than thrown away
// after the auto-merge gate — so the column is the reviewer's own verdict on
// each change, not an inference from it. A run with no stored verdict says "no
// review ran", which is deliberately not the same as "nothing found".
// The architect became real with #284 — a separate pass asking "where is this
// codebase going?" rather than "is this change correct?" — so its column is its
// stored read too, and WHERE THEY DISAGREE renders when the two land on
// opposite sides of the SAME change. When either has not run, its panel says
// "no pass ran" rather than implying it looked and found nothing.
//
// The other half of the design is the part Stack can answer completely: what
// landed, and what the night is waiting on you to decide.
//
// #325 — the run ARITHMETIC (landed/tokens/cost, the reviewer + architect
// roll-ups, where they disagree, the RUNS-derived decision rows and the
// per-push note) now comes from the same server-composed debrief the Review
// room's own Debrief view reads (GET /api/review/debrief) rather than a
// second local derivation over the 7-day/60-row usage window — this room and
// that one were deriving the same night separately, and one answer is the
// point. What stays local is what the endpoint genuinely cannot know: the
// upcoming/booked plan, the merge strip and the item's own verdict.
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
  // #304 — `landed` is what the tab reports and `quiet` is a past night that
  // produced nothing; the strip uses them to lean toward the nights with work
  // in them rather than treating every day the same.
  days: { date: string; label: string; sub: string; on: boolean; landed?: number; quiet?: boolean }[];
  onClose: () => void;
  onPickDay: (date: string) => void;
  onRunNow: () => void;
  onMerge: (branch: string, itemId: string, itemTitle: string, mergeClean?: boolean | null) => void;
  onOpenPlanner: (row: AutopilotSchedule) => void;
}) {
  // Future night, nothing run: this is a plan, not a debrief, and saying so
  // beats rendering an empty debrief that reads like the night failed. Only
  // this branch needs no server call at all.
  const upcoming = runs.length === 0 && !past;

  // The debrief for this ONE project + night, composed server-side. Fetched
  // only once the night has actually run — see `upcoming` above.
  const [debrief, setDebrief] = useState<ReviewDebrief | null>(null);
  const [loading, setLoading] = useState(!upcoming);
  const [error, setError] = useState('');
  // The "slug#day" the in-flight (or most recently landed) request is FOR —
  // reopening the panel on a different cell fires a new request quickly, and
  // a slow response for a night the reader has since clicked away from must
  // never overwrite what is on screen now.
  const requestKey = useRef('');

  const fetchDebrief = useCallback((day: string, slug: string) => {
    const k = `${slug}#${day}`;
    requestKey.current = k;
    setLoading(true);
    setError('');
    setDebrief(null);
    getReviewDebrief(day, slug)
      .then((d) => {
        if (requestKey.current !== k) return;
        setDebrief(d);
        setLoading(false);
      })
      .catch((e) => {
        if (requestKey.current !== k) return;
        setError(e instanceof Error ? e.message : 'Failed to load the debrief.');
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!upcoming) fetchDebrief(date, project.slug);
  }, [upcoming, date, project.slug, fetchDebrief]);

  // ---- what the night is waiting on that stays LOCAL regardless of the
  // debrief fetch — the item's own verdict (itemDone/verdict live only on the
  // local run rows, not the payload) and the merge strip (project.branches). ----
  const nightBranches = new Set(runs.map((r) => r.branch).filter(Boolean));
  const unmerged = (project.branches ?? []).filter((b) => nightBranches.has(b.branch));
  const awaitingVerdict = runs.filter((r) => r.outcome === 'landed' && r.itemDone && !r.verdict);

  const localDecisions: Decision[] = [];
  if (awaitingVerdict.length > 0) {
    localDecisions.push({
      key: 'verdict', tag: 'VERDICT', tone: 'warn',
      text: `${awaitingVerdict.length} item${awaitingVerdict.length === 1 ? '' : 's'} landed and ${awaitingVerdict.length === 1 ? 'is' : 'are'} waiting on your verdict — the runner never marks its own work solid.`,
      act: '→ Reviews', onAct: () => go.detail(project.slug, 'roadmap'),
    });
  }
  for (const b of unmerged) {
    localDecisions.push({
      key: `merge${b.branch}`, tag: 'MERGE', tone: 'warn',
      text: `${b.branch} is still open${b.ahead != null ? ` — ${b.ahead} ahead of main` : ''}${b.mergeClean === false ? ', and the host\'s probe says it conflicts' : b.mergeClean ? ' and merges clean' : ''}.`,
      act: '⇥ Merge',
      onAct: () => onMerge(b.branch, b.itemId, b.itemTitle, b.mergeClean),
    });
  }

  const badge = upcoming ? (books.length || nightly ? 'booked' : 'open')
    : !debrief || !debrief.ran ? 'quiet'
    : debrief.runs.some((r) => r.outcome === 'failed') ? 'failed'
    : debrief.runs.some((r) => r.outcome === 'limit') ? 'limit'
    : debrief.stats.landed > 0 ? 'landed' : 'quiet';

  return (
    <div className="mc-debrief">
      <div className="db-head">
        <span className="title">{upcoming ? 'Planned' : 'Debrief'}</span>
        <div className="db-tabs" role="tablist" aria-label="Pick a night">
          {days.map((d) => (
            <button key={d.date} role="tab" aria-selected={d.on}
              className={`db-tab ${d.on ? 'on' : ''} ${d.landed ? 'landed' : ''} ${d.quiet ? 'quiet' : ''}`}
              title={d.landed
                ? `${d.landed} change${d.landed === 1 ? '' : 's'} landed`
                : d.quiet ? 'Nothing landed this night' : undefined}
              onClick={() => onPickDay(d.date)}>
              <b>{d.label}</b>
              <i>{d.sub || '·'}</i>
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <span className="roster" title="Two Gemini passes per run: the reviewer asks whether the change is correct, the architect asks where it takes the codebase. Both annotate; neither decides.">
          roster: reviewer · architect{data.autopilot.advisorModel ? ' · advisor on builds' : ''}
        </span>
        <button className="db-close" onClick={onClose} aria-label="Close the debrief">×</button>
      </div>

      {upcoming ? (<>
        <div className="db-hero">
          <div className="l">
            <div className="row">
              <span className="t">{project.name} — {date}</span>
              <span className={`badge ${badge}`}>{badge}</span>
            </div>
            <div className="sum">
              {books.length || nightly
                ? `${books.length + (nightly ? 1 : 0)} session${books.length + (nightly ? 1 : 0) === 1 ? '' : 's'} booked. Nothing to debrief until it runs.`
                : 'Nothing booked for this night, and nothing has run.'}
            </div>
          </div>
          <div className="stats">
            <div className="st"><b>0</b><span>runs</span></div>
            <div className="st"><b className="good">0</b><span>landed</span></div>
            <div className="st"><b>{fmtTok(0)}</b><span>tokens</span></div>
            <div className="st"><b>{fmtUsd(0)}</b><span>cost</span></div>
          </div>
        </div>

        <div className="db-body">
          <div className="db-main">
            <div className="db-cap">
              <span className="cap">WHAT IS BOOKED</span>
              <span className="hair" />
              <span className="note">{books.length + (nightly ? 1 : 0)} booked</span>
            </div>

            {books.map((b) => (
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
            {nightly && (
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
            {books.length === 0 && !nightly && (
              <div className="db-none">
                Nothing is booked for this night. ▶ Run now queues a session, or + Plan a session
                books one on the calendar above.
              </div>
            )}

            <div className="db-cap" style={{ marginTop: 4 }}>
              <span className="cap">DECISIONS THIS DEBRIEF ASKS FOR</span>
              <span className="hair" />
            </div>
            {localDecisions.map((d) => (
              <div className={`db-decision ${d.tone}`} key={d.key}>
                <span className="tag">{d.tag}</span>
                <span className="t">{d.text}</span>
                <button className="btn-repo sm" onClick={d.onAct}>{d.act}</button>
              </div>
            ))}
            {localDecisions.length === 0 && (
              <div className="db-none">
                Nothing to decide — this night has not run yet. ▶ Run now queues it.
              </div>
            )}
          </div>
        </div>
      </>) : loading ? (
        <div className="db-body">
          <div className="db-main">
            <div className="db-none">Composing the debrief for {date}…</div>
          </div>
        </div>
      ) : error ? (
        <div className="db-body">
          <div className="db-main">
            <div className="db-none">
              {error} <button className="btn-repo sm" onClick={() => fetchDebrief(date, project.slug)}>Retry</button>
            </div>
          </div>
        </div>
      ) : !debrief ? null : !debrief.ran ? (<>
        <div className="db-hero">
          <div className="l">
            <div className="row">
              <span className="t">{project.name} — {date}</span>
              <span className={`badge ${badge}`}>{badge}</span>
            </div>
            <div className="sum">Nothing ran this night.</div>
          </div>
          <div className="stats">
            <div className="st"><b>0</b><span>runs</span></div>
            <div className="st"><b className="good">0</b><span>landed</span></div>
            <div className="st"><b>{fmtTok(0)}</b><span>tokens</span></div>
            <div className="st"><b>{fmtUsd(0)}</b><span>cost</span></div>
          </div>
        </div>
        <div className="db-body">
          <div className="db-main">
            <div className="db-cap">
              <span className="cap">WHAT LANDED</span>
              <span className="hair" />
              <span className="note">nothing to show</span>
            </div>
            <div className="db-none">
              Nothing ran this night — nothing was queued, or the dispatcher was down. The Now
              room's fleet line says which.
            </div>
            <div className="db-cap" style={{ marginTop: 4 }}>
              <span className="cap">DECISIONS THIS DEBRIEF ASKS FOR</span>
              <span className="hair" />
            </div>
            {localDecisions.map((d) => (
              <div className={`db-decision ${d.tone}`} key={d.key}>
                <span className="tag">{d.tag}</span>
                <span className="t">{d.text}</span>
                <button className="btn-repo sm" onClick={d.onAct}>{d.act}</button>
              </div>
            ))}
            {localDecisions.length === 0 && (
              <div className="db-none">
                Nothing to decide — this night has not run yet. ▶ Run now queues it.
              </div>
            )}
          </div>
        </div>
      </>) : (() => {
        // ---- everything below reads the loaded, ran night -------------------
        // `debrief.runs` is the night's WHOLE population (unbounded, unlike the
        // local `runs` prop's 7-day/60-row usage window) — it is the one array
        // WHAT LANDED, its caption and the hero counts all read, so none of
        // them can disagree about how many runs there were. The local `runs`
        // prop still carries two fields the payload doesn't — `itemDone` and
        // `verdict` — because those live on the roadmap ITEM (item_done /
        // review_tag, joined by item_id server-side), not the run row, so the
        // join below is keyed by itemId: a top-up for two fields, never the
        // source of which runs exist. A payload run outside the local prop's
        // capped window simply has no entry here, and is rendered without a
        // verdict rather than dropped or given one it cannot back up.
        const localByItem = new Map(
          runs.filter((r) => r.itemId != null).map((r) => [r.itemId as string, r]));

        const commits = debrief.runs.reduce((n, r) => n + (r.commits ?? 0), 0);
        const pushNotes = debrief.runs.filter((r) => r.pushNote).length;

        const reviewedRuns = debrief.runs.filter((r) => r.reviewVerdict);
        const unreviewed = debrief.stats.runs - debrief.reviewer.ran;
        const worst = debrief.reviewer.blocked > 0 ? 'blocked' : debrief.reviewer.flagged > 0 ? 'concerns' : 'clean';

        const archedRuns = debrief.runs.filter((r) => r.architectVerdict);
        const arcWorst = archedRuns.some((r) => r.architectVerdict === 'concerning') ? 'concerning'
          : archedRuns.some((r) => r.architectVerdict === 'drifting') ? 'drifting' : 'aligned';

        const split = debrief.disagree[0];
        const disagreement = !split ? '' : split.reviewVerdict === 'clean'
          ? `On ${split.itemId ? `#${split.itemId}` : split.branch || 'one change'} the reviewer says the change is clean, while the architect reads it as ${split.architectVerdict}.`
          : `On ${split.itemId ? `#${split.itemId}` : split.branch || 'one change'} the reviewer wants it blocked, while the architect finds the structure aligned.`;

        // Decisions: VERDICT + MERGE are computed above from local data and
        // stay first (unchanged ordering); the run-derived three read the
        // payload so they never disagree with the Review room's own count.
        const decisions: Decision[] = [...localDecisions];
        if (debrief.reviewer.blocked > 0) {
          decisions.push({
            key: 'blocked', tag: 'REVIEWER', tone: 'warn',
            text: `The reviewer marked ${debrief.reviewer.blocked === 1 ? 'a change' : `${debrief.reviewer.blocked} changes`} BLOCKED. It only annotates — nothing was held back on its say-so, so this is yours to act on.`,
            act: '→ Review', onAct: () => go.detail(project.slug, 'roadmap'),
          });
        }
        const red = debrief.runs.reduce((n, r) => n + (r.checksFailing ?? 0), 0);
        if (red > 0) {
          decisions.push({
            key: 'checks', tag: 'CHECKS', tone: 'warn',
            text: `The night left ${red} check${red === 1 ? '' : 's'} red. A green suite is what auto-merge and auto-verdict spend, so this is worth closing before the next night.`,
            act: '→ Quality', onAct: () => go.detail(project.slug, 'quality'),
          });
        }
        const limit = debrief.runs.some((r) => r.outcome === 'limit');
        if (limit) {
          decisions.push({
            key: 'limit', tag: 'PAUSED', tone: 'quiet',
            text: 'A session stopped on the usage limit. It queued its own resume — the Now room shows the hold and can fire it early.',
            act: '→ Now', onAct: onClose,
          });
        }
        if (decisions.length === 0) {
          decisions.push({
            key: 'clear', tag: 'CLEAR', tone: 'quiet',
            text: 'Nothing from this night is waiting on you — every item that landed has a verdict, and no branch is left open.',
            act: '→ Reviews', onAct: () => go.detail(project.slug, 'roadmap'),
          });
        }

        return (<>
          <div className="db-hero">
            <div className="l">
              <div className="row">
                <span className="t">{project.name} — {date}</span>
                <span className={`badge ${badge}`}>{badge}</span>
              </div>
              <div className="sum">
                {`${debrief.stats.runs} run${debrief.stats.runs === 1 ? '' : 's'}, ${debrief.stats.landed} landed${commits > 0 ? `, ${commits} commit${commits === 1 ? '' : 's'}` : ''}. ${
                  pushNotes > 0
                    ? `The reviewer left ${pushNotes} note${pushNotes === 1 ? '' : 's'} on the pushes.`
                    : 'The reviewer left no note on these pushes.'}`}
              </div>
            </div>
            <div className="stats">
              <div className="st"><b>{debrief.stats.runs}</b><span>runs</span></div>
              <div className="st"><b className="good">{debrief.stats.landed}</b><span>landed</span></div>
              <div className="st"><b>{fmtTok(debrief.stats.tokens)}</b><span>tokens</span></div>
              <div className="st"><b>{fmtUsd(debrief.stats.costUsd)}</b><span>cost</span></div>
            </div>
          </div>

          <div className="db-body">
            <div className="db-main">
              <div className="db-cap">
                <span className="cap">WHAT LANDED</span>
                <span className="hair" />
                <span className="note">{debrief.runs.length === 0 ? 'nothing to show' : `${debrief.runs.length} attempt${debrief.runs.length === 1 ? '' : 's'}`}</span>
              </div>

              {debrief.runs.map((r, i) => {
                // The item-level top-up — undefined for a run outside the
                // local prop's window, in which case the verdict badge and
                // button below are simply omitted rather than guessed at.
                const local = r.itemId ? localByItem.get(r.itemId) : undefined;
                return (
                  <div className={`db-change ${r.outcome}`} key={`${r.itemId || 'gen'}${i}`}>
                    <div className="row">
                      <span className={`dot ${r.outcome}`} />
                      <div className="who">
                        <span className="t">{r.itemId ? `#${r.itemId} ` : ''}{r.itemTitle || 'general session'}</span>
                        <span className="w">{r.branch || 'no branch'}{r.commits ? ` · ${r.commits} commit${r.commits === 1 ? '' : 's'}` : ''} · {r.when}</span>
                      </div>
                      <span className="diff">{fmtTok(r.tokens)} tok{r.costUsd > 0 ? ` · ${fmtUsd(r.costUsd)}` : ''}</span>
                      {local && (
                        <span className={`verdict ${local.verdict || (local.itemDone ? 'awaiting' : r.outcome)}`}>
                          {local.verdict ? VERDICT_LABEL[local.verdict] ?? local.verdict.toUpperCase()
                            : local.itemDone ? 'AWAITING VERDICT'
                            : r.outcome.toUpperCase()}
                        </span>
                      )}
                    </div>
                    <div className="notes">
                      {r.summary && (
                        <div className="n session">
                          <span className="agent">SESSION</span>
                          <span className="t">{r.summary}</span>
                        </div>
                      )}
                      {r.reviewNote ? (
                        <div className={`n reviewer ${r.reviewVerdict}`}>
                          <span className="agent">REVIEWER</span>
                          <span className="t">
                            <b>{(r.reviewVerdict || 'reviewed').toUpperCase()}</b>
                            {r.reviewFindings ? ` · ${r.reviewFindings} filed` : ''} — {r.reviewNote}
                          </span>
                        </div>
                      ) : r.pushNote ? (
                        <div className="n reviewer">
                          <span className="agent">REVIEWER</span>
                          <span className="t">{r.pushNote}</span>
                        </div>
                      ) : null}
                      {!r.summary && !r.reviewNote && !r.pushNote && (
                        <div className="n quiet">
                          <span className="t">No account from the session and no reviewer note on this push.</span>
                        </div>
                      )}
                      <div className="acts">
                        {local && r.itemId && (
                          <button className="btn-repo sm" onClick={() => go.detail(project.slug, 'roadmap', r.itemId!)}>
                            {local.itemDone && !local.verdict ? 'Verdict it' : 'Open the item'}
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
            </div>

            {/* ---- the roster rail ---- */}
            <div className="db-rail">
              <div className="db-agent">
                <div className="hd">
                  <span className="chip reviewer">REVIEWER</span>
                  <span className="model">{data.geminiReady === false ? 'no key configured' : 'gemini · per push'}</span>
                </div>
                {debrief.reviewer.ran > 0 ? (<>
                  <div className={`verdictcard ${worst}`}>
                    <span className="v">
                      {worst === 'blocked' ? 'Blocked — the reviewer wants a look'
                        : worst === 'concerns' ? 'Concerns raised'
                        : 'Clean across the night'}
                    </span>
                    <span className="s">
                      {debrief.reviewer.ran} of {debrief.stats.runs} run{debrief.stats.runs === 1 ? '' : 's'} carry a stored
                      review{debrief.reviewer.findings > 0 ? `, and ${debrief.reviewer.findings} finding${debrief.reviewer.findings === 1 ? '' : 's'} went to the review inbox` : ''}.
                      These are the reviewer's own verdicts on the diffs — suggestions, not state: the
                      item's verdict is still yours to give.
                    </span>
                  </div>
                  {reviewedRuns.map((r, i) => (
                    <div className="revline" key={`${r.itemId ?? 'gen'}${i}`}>
                      <span className={`mark ${r.reviewVerdict}`}>
                        {r.reviewVerdict === 'blocked' ? '✕' : r.reviewVerdict === 'concerns' ? '!' : '✓'}
                      </span>
                      <span className="t">
                        <code>{r.itemId ? `#${r.itemId}` : r.branch || 'run'}</code> {r.reviewNote || r.reviewVerdict}
                      </span>
                    </div>
                  ))}
                  {unreviewed > 0 && (
                    <div className="revline">
                      <span className="mark">·</span>
                      <span className="t">
                        {unreviewed} run{unreviewed === 1 ? '' : 's'} carr{unreviewed === 1 ? 'ies' : 'y'} no
                        stored review — no review ran on {unreviewed === 1 ? 'it' : 'them'}, which is not
                        the same as nothing found.
                      </span>
                    </div>
                  )}
                </>) : (
                  <div className="verdictcard quiet">
                    <span className="v">No note on this night</span>
                    <span className="s">
                      {data.geminiReady === false
                        ? 'No Gemini key is configured, so no review ran. Every Gemini surface is absent rather than broken.'
                        : 'No run this night carries a stored review — the reviewer runs from the autopilot after a push, and rows from before #282 never kept one. That is not the same as nothing found.'}
                    </span>
                  </div>
                )}
              </div>

              <div className="db-sep" />

              {/* #284 filled the design's second seat: a separate Gemini pass asking
                  "where is this codebase going?" rather than "is this correct?". */}
              <div className="db-agent">
                <div className="hd">
                  <span className={`chip architect ${archedRuns.length ? '' : 'off'}`}>ARCHITECT</span>
                  <span className="model">{archedRuns.length ? 'gemini · per run' : 'no pass on this night'}</span>
                </div>
                {debrief.architect.ran > 0 ? (<>
                  <div className={`verdictcard arch ${arcWorst}`}>
                    <span className="v">
                      {arcWorst === 'concerning' ? 'Concerning drift'
                        : arcWorst === 'drifting' ? 'Drifting'
                        : 'Aligned'}
                    </span>
                    <span className="s">
                      {debrief.architect.drifted > 0
                        ? `${debrief.architect.drifted} of ${debrief.architect.ran} change${debrief.architect.ran === 1 ? '' : 's'} took the codebase somewhere it was not already going.`
                        : `${debrief.architect.ran} change${debrief.architect.ran === 1 ? '' : 's'} read as aligned with the patterns already there.`}
                      {' '}It files nothing — structure notes are not bugs, and nobody could close them.
                    </span>
                  </div>
                  {archedRuns.filter((r) => r.architectNote).map((r, i) => (
                    <div className="revline" key={`a${r.itemId ?? 'gen'}${i}`}>
                      <span className={`mark ${r.architectVerdict}`}>
                        {r.architectVerdict === 'concerning' ? '✕' : r.architectVerdict === 'drifting' ? '~' : '✓'}
                      </span>
                      <span className="t">
                        <code>{r.itemId ? `#${r.itemId}` : r.branch || 'run'}</code> {r.architectNote}
                      </span>
                    </div>
                  ))}
                  {archedRuns.flatMap((r) => r.architectObs ?? []).slice(0, 4).map((o, i) => (
                    <div className="revline obs" key={`o${i}`}>
                      <span className="mark">·</span>
                      <span className="t">{o}</span>
                    </div>
                  ))}
                </>) : (
                  <div className="verdictcard quiet">
                    <span className="v">No structural pass on this night</span>
                    <span className="s">
                      The architect runs at the end of a run, beside the reviewer. Nothing here means no
                      pass ran on this night's changes — not that the structure is fine.
                    </span>
                  </div>
                )}
              </div>

              {/* Two opinions can disagree; one cannot. This only renders when both
                  actually spoke and landed on different sides of the same change. */}
              {disagreement && (<>
                <div className="db-sep" />
                <div className="db-agent">
                  <span className="cap">WHERE THEY DISAGREE</span>
                  <div className="disagree">
                    <span className="t">{disagreement}</span>
                    <span className="n">
                      Correct and drifting are not a contradiction — the reviewer reads the change, the
                      architect reads where it leaves the codebase. Both are suggestions; the verdict is
                      still yours.
                    </span>
                  </div>
                </div>
              </>)}
            </div>
          </div>
        </>);
      })()}

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
