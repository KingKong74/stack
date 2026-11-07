// COURSE (#622): THE PROJECT HOME, and the spine's own view. It answers
// "where is this going?" before any card: the charter's opening, the current
// milestone and its slices, what is being worked right now, the sprint in
// progress, and where the last session left off.
//
// IT REPLACES THE OVERVIEW MOCKUP on the `overview` route key, so every deep
// link to a project's home lands here. Everything on it is DERIVED from the
// one payload every tab renders from (no fetch of its own), and every number
// agrees with the screen it links to:
//
//  • A slice's state is `sliceStateOf` (lib/plan.ts), the board's own.
//  • "Now" is in-flight work: claimed and NOT yet built, the spine's IN FLIGHT
//    stage (lib/spine.ts), which subtracts Built because a claim stays after
//    the work lands. "Waiting on you" is Built with no verdict, which is the
//    Inbox's built pane, so the count and the Inbox agree.
//  • The Icebox and Auto-ideas counts are `homeOf`, the same as their pane.
//
// Read-only. Every press is a link to the screen that owns the write.

import { useMemo } from 'react';
import { KitIcon } from './kit/KitIcon';
import type { Milestone, RoadmapItem, Slice, Sprint } from '../types';
import type { CharterSummary } from '../store';
import type { Resume } from '../types';
import { isAutoIdea, isBuilt, isIced, sliceStateOf } from '../lib/plan';
import { currentMilestone, liveSlices } from './Spine';
import { go } from '../lib/route';

const NOW_SHOWN = 6;
const STATE_LABEL = { empty: 'Empty', open: 'Open', built: 'Built', done: 'Done' } as const;
const STATE_TONE = { empty: '', open: 'info', built: 'warning', done: 'success' } as const;

export function Course({ slug, items, milestones, slices, sprints, charter, resume }: {
  slug: string; items: RoadmapItem[]; milestones: Milestone[]; slices: Slice[]; sprints: Sprint[];
  charter: CharterSummary | null; resume: Resume | null;
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
  const active = sprints.find((b) => b.status === 'active') || null;
  const sprintOf = (sliceId: number) => sprints.find((b) => b.status !== 'done' && b.sliceIds.includes(sliceId)) || null;
  const iced = live.filter(isIced).length;
  const ideas = live.filter(isAutoIdea).length;
  const goal = String(ms?.goal || '').split(/\n\s*\n/)[0].trim();

  return (
    <div className="co">
      <section className="co-sec co-where">
        <span className="co-eyebrow">Where this is going</span>
        {charter?.summary ? (
          <p className="co-charter">
            {charter.summary}{charter.truncated ? '…' : ''}{' '}
            <button className="co-link" onClick={() => go.detail(slug, 'charter')}>Charter</button>
          </p>
        ) : (
          <p className="co-charter co-dim">
            No charter yet: every session starts by reading its opening.{' '}
            <button className="co-link" onClick={() => go.detail(slug, 'charter')}>Write it</button>
          </p>
        )}
      </section>

      <section className="co-sec">
        <div className="co-head">
          <span className="co-eyebrow">Milestone</span>
          <span className="co-title">{ms ? ms.name : 'None current'}</span>
          {ms?.targetOn && <span className="k-tag" title="A target you set. It gates nothing.">by {ms.targetOn}</span>}
          <span className="co-rule" />
          {ms && <span className="co-num">{msBuilt}/{msTotal} built</span>}
        </div>
        {goal && <p className="co-goal">{goal}</p>}
        {ms && msTotal > 0 && (
          <div className="co-bar" role="img" aria-label={`${msBuilt} of ${msTotal} built`}>
            <span style={{ width: `${Math.round((msBuilt / msTotal) * 100)}%` }} />
          </div>
        )}
        {!ms && <p className="co-dim">Set one from the board’s milestone strip; slices hang off it.</p>}
        {ms && msSlices.length === 0 && <p className="co-dim">No slices in it yet. Make one from the board.</p>}
        {msSlices.length > 0 && (
          <ul className="co-slices">
            {msSlices.map((s) => {
              const st = states.get(s.id)!;
              const box = sprintOf(s.id);
              return (
                <li key={s.id} className="co-slice">
                  {nowSlices.has(s.id) && <span className="co-now" title="Something in this slice is being worked right now">Now</span>}
                  <button className="co-slicename" onClick={() => go.detail(slug, 'roadmap')}>{s.title}</button>
                  {box && <span className={`k-tag${box.status === 'active' ? ' info' : ''}`}
                    title={box.status === 'active' ? 'In the sprint in progress' : 'Committed to a planned sprint'}>{box.name}</span>}
                  <span className="co-rule" />
                  <span className="co-num">{st.built}/{st.total}</span>
                  <span className={`k-tag ${STATE_TONE[st.status]}`.trim()}>{STATE_LABEL[st.status]}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="co-grid">
        <section className="co-sec">
          <div className="co-head">
            <span className="co-eyebrow">Now</span>
            <span className="co-rule" />
            <span className="co-num">{inFlight.length} in flight</span>
          </div>
          {inFlight.length === 0 && <p className="co-dim">Nothing is being worked right now.</p>}
          <ul className="co-list">
            {inFlight.slice(0, NOW_SHOWN).map((it) => (
              <li key={it.id}>
                <button className="co-link" onClick={() => go.detail(slug, 'roadmap', String(it.id))}>#{it.id}</button>
                <span className="co-item">{it.title}</span>
                <span className="k-tag mono" title="The branch that holds it">{it.claimedBy}</span>
              </li>
            ))}
          </ul>
          {inFlight.length > NOW_SHOWN && <p className="co-dim">…and {inFlight.length - NOW_SHOWN} more on the board.</p>}
          {waiting.length > 0 && (
            <button className="k-btn sm secondary co-wait" onClick={() => go.inbox()}>
              <KitIcon name="circle-check" size={13} />{waiting.length} built, waiting on your verdict
            </button>
          )}
        </section>

        <section className="co-sec">
          <div className="co-head">
            <span className="co-eyebrow">Sprint</span>
            <span className="co-title sm">{active ? active.name : 'None in progress'}</span>
          </div>
          {active ? (
            active.sliceIds.length ? (
              <ul className="co-list">
                {active.sliceIds.map((id) => {
                  const s = slices.find((x) => x.id === id);
                  const st = sliceStateOf(id, live);
                  return (
                    <li key={id}>
                      <span className="co-item">{s?.title || `Slice ${id}`}</span>
                      <span className="co-num">{st.built}/{st.total} built</span>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="co-dim">It commits to no slices yet, so the planning lane has nothing.</p>
          ) : (
            <p className="co-dim">No sprint is in progress, so nothing is being planned. Building is the Ready queue’s job.</p>
          )}
        </section>
      </div>

      {resume && (resume.summary || resume.nextUp.length > 0) && (
        <section className="co-sec">
          <div className="co-head">
            <span className="co-eyebrow">Where you left off</span>
            <span className="co-rule" />
            {resume.when && <span className="co-num">{resume.when}</span>}
          </div>
          {resume.summary && <p className="co-goal">{resume.summary}</p>}
          {resume.nextUp.length > 0 && (
            <ul className="co-bullets">{resume.nextUp.slice(0, 5).map((n) => <li key={n}>{n}</li>)}</ul>
          )}
        </section>
      )}

      {(iced > 0 || ideas > 0) && (
        <button className="k-btn sm ghost co-ice" onClick={() => go.detail(slug, 'auto')}>
          {ideas > 0 ? `${ideas} idea${ideas === 1 ? '' : 's'} to answer` : ''}
          {ideas > 0 && iced > 0 ? ' · ' : ''}
          {iced > 0 ? `${iced} in the Icebox` : ''}
        </button>
      )}
    </div>
  );
}
