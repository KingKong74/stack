// THE FOR-YOU SCREEN IS COURSE AND TWO WIRED PANES (#444, #496, #622). The
// `overview` key draws detail/Course.tsx, the project home, which replaced the
// kit's Overview mockup described below; ProjectDetail renders it directly.
//
// Overview is `ui_kits/console/ForYouScreen.jsx` ported to TS, on the kit's OWN
// sample rows (KING-18, king/col-virtualisation) — it reads nothing and writes
// nothing, and says so on its own sub-tab rather than on the rail row, because
// a chip over the whole screen would warn about the panes it is wrong for.
// AUTO-IDEAS IS REAL: it draws this project's rows and it writes. ACTIVITY IS
// REAL and read-only: the kit's day-grouped feed drawn from the payload's own
// `activity` (the last 50 pushes), one event per push.
//
// ---- Auto-ideas (#496) ----------------------------------------------------
//
// IT IS THE OTHER SCREEN A ROADMAP ROW CAN LIVE ON, and `homeOf` in lib/plan.ts
// is the one function that decides which — read its header before touching this
// pane or the board. What lands here is a session's own output:
// a `hook` row (the extractor read it off a push) or a `fly` row (a live
// session opened it for work it was asked to do) that NOBODY HAS SIGNED OFF and
// NOBODY HAS WORKED. The owner asked for exactly that separation: what a
// machine thought of overnight is not the plan, so it does not sit on the board
// among committed work.
//
// THE MOMENT SOMEBODY WORKS ONE IT IS BOARD WORK, sign-off or no sign-off — a
// claim, a built note or a tick (`isWorked`). That is the other half of the
// ask: only what we actually worked on goes to the board. A session that opens
// its own card and builds it does not have to be promoted onto the board it
// should never have left, and the hold it still carries is said and answered
// there instead (Board.tsx's `held` chip and card menu).
//
// PROMOTE is `{ reviewed: true, parentId: null }` plus the slice picked beside
// it (#608): it signs the row off, which releases it to the overnight runner's
// approval gate (#359), and files it into a slice (the board) or, with none,
// the ICEBOX, which this pane draws below the queue.
//
// DISMISS IS DELETE, and on a `hook` row it TOMBSTONES THE FINGERPRINT so the
// next push cannot re-create it. That is what Dismiss has always meant and why
// it has no undo; the second press is because the word does not say it alone.
//
// WHAT THIS RESTORES. #444 culled the real Auto-ideas screen and with it the
// last place in any browser that could clear `reviewed_at` on a held row or
// tombstone an extracted fingerprint — the predicate went untouched, so a held
// item stayed held, stayed skipped silently by an unattended enqueue and stayed
// refused out loud by ▶ Run now, with `./stack` and the API the only way back.
// That is answerable from a browser again.
//
// ---- what the other two panes still cost -----------------------------------
//
// They replaced `detail/Overview.tsx` (the progression spine, the verdict
// queue, the resume card, the three measured `pulse` bands, the north star, the
// directives, the deployment and tech-stack editors) and `detail/Activity.tsx`
// (the real per-push feed, with its Gemini notes and its commit highlight).
//
//  • THE PULSE IS NO LONGER READ BY ANY SCREEN. `GET /projects/:slug/pulse`,
//    `pulse.js` and every partition it computes are all still there and still
//    tested; nothing fetches them. The numbers in the Model usage and Tests
//    panes below are the kit's, not this project's, and none of the rules those
//    bands enforced — spend is two populations, absent is not zero, a plan
//    night is not a failed run — is being enforced by anything on screen.
//  • THE NORTH STAR, THE DIRECTIVES, DEPLOYMENT and TECH STACK lost their
//    editors. `PATCH /projects/:slug` still takes all four and SessionStart
//    still injects the directives, so what is set stays set and only the
//    browser's way of changing it went.
//  • `hl` ON THE ACTIVITY TAB IS A COMMIT HASH, and the feed rings that push
//    (the Timeline's rows link here with one). A hash older than the payload's
//    50 pushes matches nothing and is ignored quietly, same as the board's.
//
// The interactions in Overview are the kit's own and are all local state: the
// working copy's fold, the model list's open row and its Close. They persist
// nothing — leaving the tab is the undo. The three PANES are NOT state: each is
// its own route key and the strip in ProjectDetail writes it (see the Tab union
// there), so `hl` on Auto-ideas opens that row's card.

import { useEffect, useMemo, useState } from 'react';
import { KitIcon, type KitIconName } from './kit/KitIcon';
import type { Activity, Milestone, RoadmapItem, Slice } from '../types';
import { isAutoIdea } from '../lib/plan';
import { IceboxList, SlicePicker, liveSlices } from './Spine';
import { priorityMeta, timeAgo } from '../lib/ui';
import { patchRoadmapItem, deleteRoadmapItem } from '../store';

type Tone = 'info' | 'danger' | 'success' | 'warning' | 'neutral';

// #500 — HOW A SUGGESTED TEST READS ON ITS ROW. Two kinds, and the difference
// is worth drawing rather than flattening to one "test" chip: one is a gap
// something already fell through, the other is a part of the app nothing
// watches. The first is the one you act on today.
const TEST_META: Record<'bug' | 'function', { label: string; icon: KitIconName; tone: Tone }> = {
  bug: { label: 'would have caught', icon: 'circle-alert', tone: 'danger' },
  function: { label: 'nothing checks', icon: 'circle-check', tone: 'success' },
};

export type ForYouPane = 'activity' | 'auto';

export function ForYou({ pane, slug, items, slices, milestones, activity, onRefresh, onEdit, highlightId }: {
  pane: ForYouPane;
  slug: string;
  /** The payload's pushes, newest first — the Activity pane's only input. */
  activity: Activity[];
  /** The project payload's own roadmap, flattened and in payload order — the
   *  SAME list the board and Plans are given, so one list is
   *  partitioned across screens rather than fetches disagreeing. */
  items: RoadmapItem[];
  /** #608 — where Promote and the Icebox can file a row. */
  slices: Slice[];
  milestones: Milestone[];
  onRefresh: () => void;
  /** Open the item modal — note, title, area, sub-area and plan. */
  onEdit: (it: RoadmapItem) => void;
  /** A row id (Auto-ideas) or commit hash (Activity) this pane may recognise. */
  highlightId: string | null;
}) {
  if (pane === 'activity') return <ActivityPane activity={activity} highlightId={highlightId} />;
  if (pane === 'auto') {
    return <AutoPane slug={slug} items={items} slices={slices} milestones={milestones} onRefresh={onRefresh} onEdit={onEdit}
      highlightId={highlightId} />;
  }
  return null; // `overview` is Course now (#622), drawn by ProjectDetail
}

/* ---------- Overview ---------- */

function dayLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'long' });
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(now) - start(d)) / 86_400_000);
  if (days === 0) return `Today · ${date}`;
  if (days === 1) return `Yesterday · ${date}`;
  const weekday = d.toLocaleDateString('en-AU', { weekday: 'long' });
  return days < 7 ? `${weekday} · ${date}`
    : `${weekday} · ${d.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}`;
}

const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

function ActivityPane({ activity, highlightId }: { activity: Activity[]; highlightId: string | null }) {
  // A summary is a paragraph, so a row shows three lines and a click reads the
  // rest. Local state: leaving the tab is the reset. A highlighted push opens.
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { if (highlightId) setOpen(highlightId); }, [highlightId]);
  const groups = useMemo(() => {
    const now = new Date();
    const out: { day: string; events: Activity[] }[] = [];
    for (const a of activity) {
      const day = a.at && !Number.isNaN(Date.parse(a.at)) ? dayLabel(a.at, now) : 'Recent';
      const last = out[out.length - 1];
      if (last && last.day === day) last.events.push(a);
      else out.push({ day, events: [a] });
    }
    return out;
  }, [activity]);

  if (!activity.length) {
    return (
      <span className="im-empty">
        No pushes yet. Every push posts a summary here, so you can scan what changed without
        reading diffs.
      </span>
    );
  }

  return (
    <div className="fy-feed">
      {groups.map((g, gi) => (
        <div className="fy-day" key={`${g.day}-${gi}`}>
          <span className="fy-dim">{g.day}</span>
          {g.events.map((a, i) => (
            // `data-hl` is the hash ProjectDetail's scroller looks for; the
            // ring is drawn here because only this pane knows the row matched.
            <div className={`fy-event${highlightId && a.hash === highlightId ? ' hl' : ''}`}
              key={`${a.hash}-${i}`} data-hl={a.hash}
              onClick={() => setOpen(open === a.hash ? null : a.hash)}>
              <span className="fy-chip tone-info"><KitIcon name="arrow-up-right" size={13} /></span>
              <div className="mid">
                <div className="top">
                  <span className="t">Pushed to</span>
                  <span className="br">{a.branch}</span>
                  {(a.tokens ?? 0) > 0 && (
                    <span className="fy-dim" title="Real token usage for the session, from its transcript (#178)">
                      {fmtTokens(a.tokens!)} tok
                    </span>
                  )}
                  <span className="fy-ago">{a.when}</span>
                </div>
                <div className="fy-commit">
                  <span className="sha">{a.hash === '—' ? '—' : a.hash.slice(0, 7)}</span>
                  <span className={`msg${open === a.hash ? '' : ' clamp'}`}>{a.summary.trim() || 'No summary was posted for this push.'}</span>
                </div>
                {/* THE SECOND MODEL ANNOTATES; it is drawn in the accent and
                    labelled as Gemini's, never as a verdict. Empty until stamped. */}
                {a.geminiNote.trim() && (
                  <div className="fy-gem"><span className="star">✦</span><b>Gemini</b> {a.geminiNote}</div>
                )}
                {a.tags.length > 0 && (
                  <div className="fy-tags">
                    {a.tags.map((t, ti) => <span className="k-tag" key={ti}>{t}</span>)}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ---------- Auto-ideas ---------- */
// The rows keep the `.ai-*` classes the culled queue wore, because the kit's row
// and Stack's were already the same shape: what it is, what it says, where it
// came from, and the answers. What changed is that the answers are real.

function AutoPane({ slug, items, slices, milestones, onRefresh, onEdit, highlightId }: {
  slug: string; items: RoadmapItem[]; slices: Slice[]; milestones: Milestone[]; onRefresh: () => void;
  onEdit: (it: RoadmapItem) => void; highlightId: string | null;
}) {
  // The local copy is what makes a promote feel instant: the row leaves this
  // pane on the next render rather than on the re-read's round trip. `onRefresh`
  // still runs, because the rail's three counts are read off the payload and a
  // row that moved screens has to move in both places.
  const [rows, setRows] = useState<RoadmapItem[]>(items);
  useEffect(() => { setRows(items); }, [items]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);

  useEffect(() => {
    const n = Number(highlightId);
    if (Number.isFinite(n) && n > 0) setOpen(n);
  }, [highlightId]);

  // ONE PREDICATE, SHARED WITH THE STRIP'S COUNT. `isAutoIdea` is `homeOf`
  // asked one way; nothing here may re-derive the population from `source` and
  // `reviewed`, or the badge and the pane can disagree about what is waiting.
  //
  // NEWEST FIRST, on the only stamp the row carries. A queue of things found
  // overnight is read top-down and the freshest is the one you have context
  // for; `id` breaks the tie because `updated_at` is written by every PATCH and
  // two rows extracted from one push share a second.
  const queue = useMemo(() => rows
    .filter((it) => !it.archived && isAutoIdea(it))
    .sort((a, b) => (Date.parse(b.updatedAt || '') || 0) - (Date.parse(a.updatedAt || '') || 0) || b.id - a.id),
  [rows]);

  const guard = async (id: number, fn: () => Promise<void>) => {
    setBusy(id);
    try { setErr(''); await fn(); }
    catch (e) { setErr((e as Error)?.message || 'Something went wrong.'); }
    finally { setBusy(null); }
  };
  const wrote = (updated: RoadmapItem) => {
    setRows((r) => r.map((x) => (x.id === updated.id ? updated : x)));
    onRefresh();
  };

  // PROMOTE: `reviewed: true` is the sign-off the overnight runner gates on
  // (#359), and `parentId: null` detaches it. WHERE IT LANDS is the slice
  // picked beside the button (#608): a slice puts it on the board, none puts it
  // in the Icebox below. A plan piece that inherited its parent's slice keeps
  // it unless another is picked. `committed` is retired and no longer sent.
  const [target, setTarget] = useState<Record<number, number | null>>({});
  const targetOf = (it: RoadmapItem) => (it.id in target ? target[it.id] : it.sliceId);
  const promote = (it: RoadmapItem) =>
    guard(it.id, async () => {
      const sliceId = targetOf(it);
      wrote(await patchRoadmapItem(slug, it.id, {
        reviewed: true, parentId: null, ...(sliceId !== it.sliceId ? { sliceId } : {}),
      }));
    });
  // THE ICEBOX'S TWO WAYS OUT: into a slice, or archived.
  const toSlice = (it: RoadmapItem, sliceId: number) =>
    guard(it.id, async () => { wrote(await patchRoadmapItem(slug, it.id, { sliceId })); });
  const archive = (it: RoadmapItem) =>
    guard(it.id, async () => { wrote(await patchRoadmapItem(slug, it.id, { archived: true })); });
  const hasSlices = liveSlices(slices, milestones).length > 0;
  // DELETE, and on a `hook` row the server tombstones the fingerprint with it.
  const dismiss = (it: RoadmapItem) =>
    guard(it.id, async () => {
      await deleteRoadmapItem(slug, it.id);
      setRows((r) => r.filter((x) => x.id !== it.id));
      onRefresh();
    });

  return (
    <div className="ai">
      <div className="ai-lede">
        What your sessions found and nobody has answered yet — read off a push, or opened by a
        session for work it was doing. Nothing here is on the board, and the overnight runner
        leaves all of it alone until you answer. <b>Promote</b> signs it off into the slice picked beside
        it, which puts it on the board, or into the Icebox below when there is none.
        {' '}Rows marked <b>test</b> are checks a session thought were missing (#500) — one kind for
        a defect that got through, one for a route nothing watches.
      </div>

      {err && <div className="km-err" role="alert">{err}</div>}

      {queue.map((it) => {
        const on = open === it.id;
        const p = priorityMeta(it.bucket);
        // WHERE IT CAME FROM, in the words the rest of the app uses. A `fly`
        // row names its session when it had one — that is the tmux name on the
        // running-sessions strip, so the sentence points at something real.
        const src = it.source === 'hook'
          ? 'read off a push'
          : it.source === 'plan'
          ? 'a piece of a planned item'
          : `opened by ${it.flySession || 'a session'}`;
        // A SUGGESTED TEST WEARS ITS OWN GLYPH, because it is answered
        // differently from everything else in this queue: an idea is kept or
        // promoted, a test is WRITTEN, and the row says which kind of answer it
        // is waiting for before you read the title.
        const t = it.testKind ? TEST_META[it.testKind] : null;
        return (
          <div className={`ai-row${on ? ' open' : ''}`} key={it.id} data-hl={it.id}
            onClick={() => { setOpen(on ? null : it.id); setConfirming(null); }}>
            <span className={`ai-ico tone-${t ? t.tone : it.source === 'hook' ? 'info' : 'warning'}`}>
              <KitIcon name={t ? t.icon : it.source === 'hook' ? 'arrow-up-right' : 'terminal'} size={13} />
            </span>
            <div className="ai-body">
              <div className="ai-top">
                <span className="ai-title">{it.title}</span>
                <span className="ai-when">{timeAgo(it.updatedAt)}</span>
              </div>
              {it.note.trim() && <p className={`ai-why${on ? '' : ' clamp'}`}>{it.note}</p>}
              <div className="ai-meta">
                <span className="ai-src">#{it.id}</span>
                <span className="ai-signal">{src}</span>
                {/* WHAT IT WOULD TEST, not just that it is a test. A target is
                    the difference between a suggestion and a wish — it is what
                    the Quality tab's composer would open onto — so an empty one
                    says so rather than rendering an empty chip. A session may
                    describe a defect it never filed, and that is a real state. */}
                {t && (
                  <span className={`k-tag ${t.tone}`} title="A test this session suggested">
                    test · {t.label}{it.testTarget.trim() ? ` ${it.testTarget}` : '…'}
                  </span>
                )}
                {it.area.trim() && <span className="k-tag">{it.area}</span>}
                <span className="k-tag" style={{ color: p.color }} title={`Priority — ${p.label}`}>
                  {p.glyph} {p.short}
                </span>
                {it.skipped && <span className="k-tag warning">parked</span>}
              </div>
              {/* EDIT AND DISMISS LIVE IN THE BODY, not in the action column.
                  Stacked with Promote they made an open row three
                  buttons tall against a two-line body, so opening one opened a
                  hole in the middle of the list. Here they fill the width the
                  body already has and the row barely grows. */}
              {on && (
                <div className="ai-more">
                  <button className="k-btn ghost sm" onClick={() => onEdit(it)}>
                    <KitIcon name="pencil" size={13} />Edit…
                  </button>
                  {/* On a `hook` row this TOMBSTONES the fingerprint, so the
                      next push cannot bring it back. The second press is
                      because "Dismiss" does not say that on its own. */}
                  <button className="k-btn danger sm" disabled={busy === it.id}
                    onClick={() => (confirming === it.id ? dismiss(it) : setConfirming(it.id))}>
                    <KitIcon name="trash-2" size={13} />
                    {confirming === it.id
                      ? (it.source === 'hook' ? 'Really? The next push will not re-add it' : 'Really discard?')
                      : 'Dismiss'}
                  </button>
                </div>
              )}
            </div>
            <div className="ai-acts" onClick={(e) => e.stopPropagation()}>
              {hasSlices && (
                <SlicePicker value={targetOf(it)} slices={slices} milestones={milestones}
                  label={`Where #${it.id} lands when promoted`} iceboxLabel="Icebox"
                  onPick={(sid) => setTarget((t) => ({ ...t, [it.id]: sid }))} />
              )}
              <button className="k-btn accent sm" disabled={busy === it.id} onClick={() => promote(it)}
                title={targetOf(it) === null ? 'Sign it off and keep it in the Icebox' : 'Sign it off and put it on the board, in the picked slice'}>
                <KitIcon name="arrow-up-right" size={13} />Promote
              </button>
            </div>
          </div>
        );
      })}

      {queue.length === 0 && (
        <span className="im-empty">
          Nothing waiting. A push files what it finds here, and so does a session opening a card
          for its own work — until somebody works it, at which point it is board work.
        </span>
      )}

      <IceboxList items={rows} slices={slices} milestones={milestones} busy={busy}
        onSlice={toSlice} onArchive={archive} onEdit={onEdit} />
    </div>
  );
}
