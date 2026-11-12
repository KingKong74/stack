// COURSE (#622): THE PROJECT HOME, and the spine's own view, drawn as the For
// You redesign's timeline (2026-11-11): DONE (the last checkpoint) · YOU ARE
// HERE (the next step, picked from the checkpoint's next-up list) · AHEAD (the
// current milestone and its slices). The charter's opening is its footnote.
//
// IT REPLACES THE OVERVIEW MOCKUP on the `overview` route key, so every deep
// link to a project's home lands here. Everything on it is DERIVED from the
// one payload every tab renders from (no fetch of its own), and every number
// agrees with the screen it links to:
//
//  • A slice's state is `sliceStateOf` (lib/plan.ts), the board's own.
//  • "In flight" is claimed and NOT yet built, the spine's IN FLIGHT stage
//    (lib/spine.ts), which subtracts Built because a claim stays after the
//    work lands. "Waiting on your verdict" is Built with no verdict, which is
//    the board's built work awaiting a human verdict.
//  • The Icebox and Auto-ideas counts are `homeOf`, the same as their pane.
//
// It writes nothing. RESUME IN TERMINAL opens an UNCLAIMED claude tab briefed
// with the picked step: a next-up line is prose, not a card, so there is no row
// to claim (the board's ⌨ is the path that claims). The pick is local state.

import { useMemo, useState } from 'react';
import { KitIcon } from './kit/KitIcon';
import type { Activity, Milestone, RoadmapItem, Slice } from '../types';
import type { CharterSummary } from '../store';
import type { Resume } from '../types';
import { queueTermLaunch } from '../store';
import { isAutoIdea, isBuilt, isIced, sliceStateOf } from '../lib/plan';
import { currentMilestone, liveSlices } from './Spine';
import { go } from '../lib/route';
import { newTermName } from '../lib/termLaunch';
import { copyText } from '../lib/termClipboard';
import { resumeBrief, sentences, splitStep } from '../lib/course';

const HL_SHOWN = 4;
const SHAS_SHOWN = 6;
const STATE_LABEL = { empty: 'Empty', open: 'Open', built: 'Built', done: 'Done' } as const;

export function Course({ slug, name, items, milestones, slices, charter, resume, northStar = '', phase = '', activity = [], lastSlice = null }: {
  slug: string; name: string; items: RoadmapItem[]; milestones: Milestone[]; slices: Slice[];
  charter: CharterSummary | null; resume: Resume | null;
  /** The project's north star, the footnote; the charter's opening stands in. */
  northStar?: string;
  /** The last checkpoint's phase line, which heads the Done column. */
  phase?: string;
  /** The payload's pushes, newest first: the Done column's commits. */
  activity?: Activity[];
  /** #626 — the slice the latest checkpoint said it worked, or null. */
  lastSlice?: number | null;
}) {
  const live = useMemo(() => items.filter((it) => !it.archived), [items]);
  const ms = currentMilestone(milestones);
  const msSlices = useMemo(() => (ms ? liveSlices(slices, milestones).filter((s) => s.milestoneId === ms.id) : []),
    [ms, slices, milestones]);
  const states = useMemo(() => new Map(msSlices.map((s) => [s.id, sliceStateOf(s.id, live)])), [msSlices, live]);
  const msTotal = [...states.values()].reduce((n, st) => n + st.total, 0);
  const msBuilt = [...states.values()].reduce((n, st) => n + st.built, 0);

  const inFlight = live.filter((it) => !it.done && it.claimedBy.trim() !== '' && !isBuilt(it));
  const waiting = live.filter((it) => isBuilt(it) && !it.reviewTag);
  const nowSlices = new Set(inFlight.map((it) => it.sliceId).filter((x): x is number => x !== null));
  const iced = live.filter(isIced).length;
  const ideas = live.filter(isAutoIdea).length;
  const goal = String(ms?.goal || '').split(/\n\s*\n/)[0].trim();
  // The footnote: the north star's first sentence, else the charter's opening
  // with its markdown heading dropped.
  const northLine = sentences(northStar.trim() || (charter?.summary || '').replace(/^#+\s*\S+\s*/, ''))[0] || '';

  // DONE: the checkpoint's sentences as highlights, and the pushes of the
  // latest push's day as its commits.
  const [more, setMore] = useState(false);
  const highlights = useMemo(() => sentences(resume?.summary || ''), [resume?.summary]);
  const shas = useMemo(() => {
    const day = (a: Activity) => (a.at ? new Date(a.at).toDateString() : '');
    const first = activity[0] ? day(activity[0]) : '';
    return activity.filter((a) => a.hash !== '—' && day(a) === first).slice(0, SHAS_SHOWN);
  }, [activity]);
  const workedSlice = lastSlice != null ? slices.find((s) => s.id === lastSlice) : undefined;

  // HERE: one picked step; the rest are "or instead".
  const steps = resume?.nextUp || [];
  const [pick, setPick] = useState(0);
  const at = pick < steps.length ? pick : 0;
  const step = steps.length ? splitStep(steps[at]) : null;
  const [copied, setCopied] = useState(false);
  const brief = () => resumeBrief(name, steps[at] || '', resume?.summary || '');
  const resumeInTerminal = () => {
    const tmux = newTermName();
    queueTermLaunch(tmux, brief());
    go.terminal(slug, tmux);
  };
  const copyBrief = async () => {
    if (await copyText(brief())) { setCopied(true); setTimeout(() => setCopied(false), 1800); }
  };

  return (
    <div className="cb">
      <div className="cb-rail" aria-hidden="true">
        <span className="cb-stop"><i className="past" /><span>{resume?.when ? `Last session · ${resume.when}` : 'Last session'}</span></span>
        <span className="cb-stop here"><i className="here" /><span>You are here</span></span>
        <span className="cb-stop"><i className="ahead" /><span>Ahead</span></span>
      </div>

      <div className="cb-cols">
        {/* ---- DONE ---- */}
        <section className="cb-done">
          <span className="cb-h">{phase.trim() || (resume ? 'Last checkpoint' : 'Nothing checkpointed yet')}</span>
          {workedSlice && <span className="k-tag" title="The slice the last checkpoint said it worked">{workedSlice.title}</span>}
          {shas.length > 0 && (
            <div className="cb-shas">
              {shas.map((a) => (
                <button key={a.hash} className="cb-sha" title={a.headline || a.summary.slice(0, 120)}
                  onClick={() => go.detail(slug, 'activity', a.hash)}>{a.hash.slice(0, 7)}</button>
              ))}
            </div>
          )}
          {highlights.length > 0 ? (
            <ul className="cb-hl">
              {(more ? highlights : highlights.slice(0, HL_SHOWN)).map((h, i) => <li key={i}>{h}</li>)}
            </ul>
          ) : (
            <p className="co-dim">Run <code>/checkpoint</code> at the end of a session and it lands here.</p>
          )}
          {highlights.length > HL_SHOWN && (
            <button className="cb-more" onClick={() => setMore(!more)}>
              {more ? 'Show less' : `+${highlights.length - HL_SHOWN} more`}
            </button>
          )}
          {waiting.length > 0 && (
            <button className="cb-verdict" onClick={() => go.detail(slug, 'roadmap')}>
              <b>{waiting.length}</b><span>waiting on your verdict</span><KitIcon name="chevron-right" size={14} />
            </button>
          )}
        </section>

        {/* ---- YOU ARE HERE ---- */}
        <section className="cb-here">
          <div className="cb-step">
            <span className="cb-cap">Your next step</span>
            {step ? (
              <>
                <h2 className="cb-title">{step.title}</h2>
                {step.detail && <p className="cb-detail">{step.detail}</p>}
              </>
            ) : (
              <p className="cb-detail">No next step recorded. The next <code>/checkpoint</code> names one.</p>
            )}
          </div>
          <div className="cb-acts">
            <button className="k-btn accent" onClick={resumeInTerminal}
              title="Open a claude tab in this project, briefed with this step">
              Resume in Terminal ▸
            </button>
            {step && <button className="k-btn secondary" onClick={copyBrief}>{copied ? 'Copied' : 'Copy brief'}</button>}
          </div>
          {steps.length > 1 && (
            <div className="cb-others">
              <span className="cb-cap">Or instead</span>
              {steps.map((s, i) => i === at ? null : (
                <button key={i} className="cb-other" onClick={() => setPick(i)}>
                  <span className="n">{String(i + 1).padStart(2, '0')}</span>
                  <span className="t">{splitStep(s).title}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* ---- AHEAD ---- */}
        <section className="cb-ahead">
          <div className="cb-step">
            <span className="cb-cap">Milestone</span>
            <span className="cb-h">{ms ? ms.name : 'None current'}</span>
            {ms?.targetOn && <span className="k-tag" title="A target you set. It gates nothing.">by {ms.targetOn}</span>}
          </div>
          {goal && <p className="cb-goal">{goal}</p>}
          {ms && (
            <div className="cb-prog">
              <div className="co-bar" role="img" aria-label={`${msBuilt} of ${msTotal} built`}>
                <span style={{ width: `${msTotal ? Math.round((msBuilt / msTotal) * 100) : 0}%` }} />
              </div>
              <span className="co-num">{msBuilt}/{msTotal}</span>
            </div>
          )}
          {!ms && <p className="co-dim">Set one from the board’s milestone strip; slices hang off it.</p>}
          {ms && msSlices.length === 0 && <p className="co-dim">No slices in it yet. Make one from the board.</p>}
          {msSlices.length > 0 && (
            <ul className="cb-slices">
              {msSlices.map((s) => {
                const st = states.get(s.id)!;
                const now = nowSlices.has(s.id);
                return (
                  <li key={s.id}>
                    <i className={now ? 'now' : st.status === 'open' ? 'open' : st.status === 'empty' ? '' : 'built'}
                      title={now ? 'Something in this slice is being worked right now' : STATE_LABEL[st.status]} />
                    <button className="cb-slicename" onClick={() => go.detail(slug, 'roadmap')}>{s.title}</button>
                    <span className="co-num">{st.built}/{st.total}</span>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="cb-foot">
            <span className="co-dim">
              {ms ? <>Current milestone: <b>{ms.name}</b></> : 'No current milestone'}
              {inFlight.length > 0 ? ` · ${inFlight.length} in flight` : ''}
            </span>
            <div className="cb-acts">
              <button className="k-btn sm secondary" onClick={() => go.detail(slug, 'milestones')}>Milestones</button>
              {(iced > 0 || ideas > 0) && (
                <button className="k-btn sm ghost" onClick={() => go.detail(slug, 'auto')}>
                  {ideas > 0 ? `${ideas} to answer` : ''}{ideas > 0 && iced > 0 ? ' · ' : ''}{iced > 0 ? `${iced} in the Icebox` : ''} →
                </button>
              )}
            </div>
          </div>
        </section>
      </div>

      <p className="cb-north">
        {northLine
          ? <>North star: {northLine}{' '}<button className="co-link" onClick={() => go.detail(slug, 'charter')}>Charter</button></>
          : <>No charter yet: every session starts by reading its opening.{' '}<button className="co-link" onClick={() => go.detail(slug, 'charter')}>Write it</button></>}
      </p>
    </div>
  );
}
