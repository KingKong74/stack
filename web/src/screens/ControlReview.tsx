import { useEffect, useMemo, useState } from 'react';
import {
  getReview, getReviewBrief, getRefineDraft, patchRoadmapItem, deleteRoadmapItem, queueUndo,
  startAutopilot, setReviewPrefill,
  type ReviewBrief, type ReviewData, type ReviewItem, type ReviewNightRun,
} from '../store';
import { go } from '../lib/route';
import { ConfirmModal } from '../components/ConfirmModal';
import { Modal } from '../components/Modal';

// The Review room (#282 — design 24b + 24a).
//
// Review used to be a view inside ONE project's Roadmap tab. That was the wrong
// shape once the nights started running across projects: what you want in the
// morning is a single queue of everything waiting on you, in the room where the
// rest of the automation lives. So it moved here, and the Roadmap tab lost it.
//
// Two views, one room:
//   Queue (24b)    one change at a time — rail on the left, the change on the
//                  right, the reviewer's read already attached, three keys to
//                  clear it. Every action the old Reviews view had is still
//                  here; the keyed three are just the ones you reach for.
//   Debrief (24a)  a night at a time — what landed, what the reviewer thought,
//                  and the decisions that night is asking you for.
//
// The room mutates nothing itself: verdicts, refinements, shelving and undo all
// go through the same per-project routes the Roadmap tab used.

type View = 'queue' | 'debrief';
type Filter = 'todo' | 'flagged' | 'shelved' | 'settled';

const VERDICT_LABEL: Record<string, string> = {
  clean: 'CLEAN', concerns: 'CONCERNS', blocked: 'BLOCKED', '': 'NO REVIEW',
};
// #284 — the architect's reads. It answers a different question from the
// reviewer's, so it gets its own vocabulary and its own chip.
const ARCH_LABEL: Record<string, string> = {
  aligned: 'ALIGNED', drifting: 'DRIFTING', concerning: 'CONCERNING', '': '',
};
const ORIGIN_LABEL = { auto: '⚙ autopilot', branch: '⚑ branch', manual: 'by hand' } as const;

// Review annotations (#146), unchanged: quick labels you stick on while testing.
const NOTE_TAGS: { key: string; label: string }[] = [
  { key: 'fix', label: 'Fix' },
  { key: 'needs-more', label: 'Needs more' },
  { key: 'polish', label: 'Polish' },
  { key: 'question', label: 'Question' },
];
const noteTagLabel = (t: string) => NOTE_TAGS.find((x) => x.key === t)?.label || t;

const fmtTok = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M tok` : n >= 1000 ? `${Math.round(n / 1000)}k tok` : `${n} tok`;

// A change's size, as honestly as Stack can state it: commits, not lines. The
// server can't run git, so there is no diffstat to show — saying "4 commits" is
// true where "+120/−18" would be invented.
const sizeOf = (it: ReviewItem) =>
  it.run ? `${it.run.commits} commit${it.run.commits === 1 ? '' : 's'}` : 'by hand';

// Nights are grouped on the run's UTC day (the same convention the week strip
// uses); the label is relative so "last night" reads as last night.
function nightLabel(day: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const yday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  if (day === today) return 'Tonight';
  if (day === yday) return 'Last night';
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
}

export function ReviewRoom({ onCount, focus }: {
  onCount?: (n: number) => void;
  // "slug#id" — a specific change another room wants judged (the Build room's
  // verdict gate). Applied once the queue lands; a stale link falls back to
  // the normal list rather than selecting nothing.
  focus?: string;
}) {
  const [data, setData] = useState<ReviewData | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>('queue');
  const [filter, setFilter] = useState<Filter>('todo');
  const [selId, setSelId] = useState<string>('');       // "slug#id"
  const [night, setNight] = useState<string>('');        // the debrief's chosen day
  const [busy, setBusy] = useState(false);
  const [settledNote, setSettledNote] = useState<{ key: string; text: string; undo?: () => void } | null>(null);

  // Per-row transient state, all in-memory: Gemini's brief, an undo receipt.
  const [briefs, setBriefs] = useState<Map<string, { loading?: boolean; error?: string; data?: ReviewBrief }>>(new Map());
  const [undoNotes, setUndoNotes] = useState<Map<string, string>>(new Map());
  const [undoFor, setUndoFor] = useState<ReviewItem | null>(null);
  const [refineFor, setRefineFor] = useState<ReviewItem | null>(null);
  const [refineText, setRefineText] = useState('');
  const [refineQueue, setRefineQueue] = useState(false);
  // Turn 3 — the ✦ draft. `draft` non-null is design 3b: the same text, wearing
  // the accent chrome that says a machine wrote the first pass. It is the SAME
  // refineText either way, so an edit in 3b is just an edit — there is no
  // "accept the draft" step to forget, and Send it back sends whatever the box
  // says. `before` is what the human had typed, restored if they dismiss it.
  const [refineDraft, setRefineDraft] = useState<{ basis: string; read: string[]; secs: number; before: string } | null>(null);
  const [refineBusy, setRefineBusy] = useState(false);
  // Two different things get said under the box and they must not look alike:
  // a Gemini failure is an error, and "the record evidences nothing to change"
  // is a finding — arguably the most useful answer the assist gives.
  const [refineSay, setRefineSay] = useState<{ tone: 'note' | 'err'; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ReviewItem | null>(null);

  const load = () => {
    getReview()
      .then((d) => { setData(d); setError(''); onCount?.(d.totals.pending); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load the review queue.'));
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const key = (it: ReviewItem) => `${it.slug}#${it.id}`;

  // The four lists behind the filter chips. "Flagged" is evidence, not opinion:
  // the reviewer said blocked, or the run finished with checks red.
  const lists = useMemo(() => {
    const q = data?.queue ?? [];
    const active = q.filter((it) => !it.shelved);
    return {
      todo: active,
      flagged: active.filter((it) => it.run?.reviewVerdict === 'blocked' || (it.run?.checksFailing ?? 0) > 0),
      shelved: q.filter((it) => it.shelved),
      settled: data?.settled ?? [],
    } as Record<Filter, ReviewItem[]>;
  }, [data]);

  const list = lists[filter];
  const sel = list.find((it) => key(it) === selId) ?? list[0] ?? null;

  // Keep a selection as the list changes under you (a verdict removes a row).
  useEffect(() => {
    if (!list.length) { setSelId(''); return; }
    if (!list.some((it) => key(it) === selId)) setSelId(key(list[0]));
  }, [list, selId]);

  // An incoming focus wins over that fallback, so it is declared AFTER it:
  // both fire in the same commit, and the later setSelId is the one that
  // sticks. Applied once per requested key — after that the room is yours.
  const [focused, setFocused] = useState('');
  useEffect(() => {
    if (!focus || !data || focused === focus) return;
    setFocused(focus);
    const hit = (data.queue ?? []).find((it) => key(it) === focus);
    if (!hit) return;          // already verdicted, or never in the queue
    setView('queue');
    setFilter(hit.shelved ? 'shelved' : 'todo');
    setSelId(focus);
  }, [focus, data, focused]);

  // ---- mutations. Each one PATCHes, then reloads: the queue is a server-side
  // read over two tables, and re-deriving it locally would be a second source
  // of truth for what is still waiting on you. ----

  const act = async (fn: () => Promise<unknown>, note?: { key: string; text: string; undo?: () => void }) => {
    setBusy(true);
    try {
      await fn();
      if (note) setSettledNote(note);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not go through.');
    } finally {
      setBusy(false);
    }
  };

  const giveVerdict = (it: ReviewItem) => act(
    () => patchRoadmapItem(it.slug, Number(it.id), { review_tag: 'solid' }),
    {
      key: key(it),
      text: `#${it.id} ${it.title} — marked solid.`,
      undo: () => act(() => patchRoadmapItem(it.slug, Number(it.id), { review_tag: '' })),
    },
  );

  const shelve = (it: ReviewItem) => act(
    () => patchRoadmapItem(it.slug, Number(it.id), { review_shelved: !it.shelved }),
    {
      key: key(it),
      text: it.shelved ? `#${it.id} back on the list.` : `#${it.id} shelved — it waits under Shelved until you bring it back.`,
      undo: () => act(() => patchRoadmapItem(it.slug, Number(it.id), { review_shelved: it.shelved })),
    },
  );

  // ↩ Board: it didn't hold up. Un-ticking clears the verdict and the branch
  // claim server-side, so the item re-enters play fresh.
  const toBoard = (it: ReviewItem) => act(
    () => patchRoadmapItem(it.slug, Number(it.id), { done: false }),
    { key: key(it), text: `#${it.id} sent back to the board — the old verdict and branch claim didn't come with it.` },
  );

  // ✎ Refine (#146): the delta-only send-back, optionally queuing the session.
  const doRefine = () => {
    const it = refineFor;
    if (!it) return;
    const text = refineText.trim();
    const queue = refineQueue;
    // Whether the words were typed or drafted, what is sent is what the box
    // said — so the receipt below never distinguishes the two, and neither
    // does refine_note. A draft the human sent is the human's instruction.
    setRefineFor(null);
    setRefineDraft(null);
    setRefineSay(null);
    act(async () => {
      await patchRoadmapItem(it.slug, Number(it.id), { done: false, refine_note: text });
      if (queue) await startAutopilot(it.slug, it.id);
    }, {
      key: key(it),
      text: queue
        ? `#${it.id} sent back with your refinement, and a session is queued on it.`
        : `#${it.id} sent back with your refinement — what landed stays on record.`,
    });
  };

  // Opening the dialog always starts from the item's own refine note and a
  // clear draft — a chrome left over from the last item would caption someone
  // else's words as this one's draft.
  const openRefine = (it: ReviewItem) => {
    setRefineFor(it);
    setRefineText(it.refineNote);
    setRefineQueue(false);
    setRefineDraft(null);
    setRefineSay(null);
  };

  // Turn 3 — ✦ Draft it with Gemini. Offered from the empty box (3a) and again
  // as ↻ redraft once there is one (3b).
  //
  // What it deliberately does NOT do: tick "Queue a session on it now". The
  // design shows that box checked in the drafted state, and it stays the
  // human's — ticking it spends a session, and a machine writing a sentence is
  // not grounds for a machine deciding to spend on it. Same fail-safe direction
  // the arm switch follows.
  const draftRefine = () => {
    const it = refineFor;
    if (!it || refineBusy) return;
    const before = refineDraft ? refineDraft.before : refineText;
    const t0 = Date.now();
    setRefineBusy(true);
    setRefineSay(null);
    getRefineDraft(it.slug, Number(it.id))
      .then((d) => {
        // Nothing to say is a real answer, not a failure. The prompt asks for an
        // empty draft whenever the record does not evidence a change, so an
        // empty one means the record is clean — say that and leave the box
        // alone, rather than dressing up silence as a draft.
        if (!d.draft) {
          setRefineSay({ tone: 'note', text: d.read.length
            ? `Nothing in the record calls for a refinement — Gemini read ${d.read.join(', ')} and found no evidenced change to ask for. Say what you saw yourself.`
            : 'There is almost no record behind this item — no run log and no reviewer read — so there was nothing to draft from. Say what you saw yourself.' });
          return;
        }
        setRefineText(d.draft);
        setRefineDraft({ basis: d.basis, read: d.read, secs: Math.max(1, Math.round((Date.now() - t0) / 1000)), before });
      })
      .catch((e) => setRefineSay({ tone: 'err', text: e instanceof Error ? e.message : 'Gemini call failed.' }))
      .finally(() => setRefineBusy(false));
  };
  // ✕ — drop the draft and put back what the human had typed before it. A
  // dismiss that silently kept the machine's words would be the one way this
  // dialog could send something nobody chose.
  const dropDraft = () => {
    setRefineText(refineDraft?.before ?? '');
    setRefineDraft(null);
    setRefineSay(null);
  };
  const closeRefine = () => {
    setRefineFor(null);
    setRefineDraft(null);
    setRefineSay(null);
    setRefineBusy(false);
  };

  // ⎌ Undo (#128): the host reverts the item's #N-tagged main commits.
  const doUndo = (it: ReviewItem) => {
    setUndoFor(null);
    setUndoNotes((m) => new Map(m).set(key(it), 'Queuing the revert…'));
    queueUndo(it.slug, Number(it.id))
      .then(() => setUndoNotes((m) => new Map(m).set(key(it),
        `Undo queued — the host reverts every main commit tagged #${it.id} and returns the item to the board within a minute or two.`)))
      .catch((e) => setUndoNotes((m) => new Map(m).set(key(it), e instanceof Error ? e.message : 'Undo failed.')));
  };

  const toggleTag = (it: ReviewItem, tag: string) => act(() => patchRoadmapItem(it.slug, Number(it.id), {
    review_tags: it.reviewTags.includes(tag) ? it.reviewTags.filter((t) => t !== tag) : [...it.reviewTags, tag],
  }));

  const remove = (it: ReviewItem) => act(() => deleteRoadmapItem(it.slug, Number(it.id)));

  // ✧ Brief (#134): Gemini's reviewer brief — what shipped, how to test it,
  // likely risks. In-memory annotation; nothing is stored.
  const toggleBrief = (it: ReviewItem) => {
    const k = key(it);
    if (briefs.has(k)) { setBriefs((m) => { const n = new Map(m); n.delete(k); return n; }); return; }
    setBriefs((m) => new Map(m).set(k, { loading: true }));
    getReviewBrief(it.slug, Number(it.id))
      .then((d) => setBriefs((m) => new Map(m).set(k, { data: d })))
      .catch((e) => setBriefs((m) => new Map(m).set(k, { error: e instanceof Error ? e.message : 'Gemini call failed.' })));
  };

  // ⌨ Session: a terminal in that project, primed with the review context.
  const openSession = (it: ReviewItem) => {
    const brief = [
      `Review roadmap item #${it.id} — ${it.title}`,
      it.note ? `\nThe item:\n${it.note}` : '',
      it.builtNote ? `\nWhat the building session says landed:\n${it.builtNote}` : '',
      it.run?.reviewNote ? `\nWhat the second-model reviewer said:\n${it.run.reviewNote}` : '',
      '\nVerify it: read the relevant code, run or build the app where useful, and check what landed',
      'matches the item. Report what holds up and what does not — no fixes without asking first.',
    ].filter(Boolean).join('\n');
    try { sessionStorage.setItem('stack.term.brief', brief); } catch { /* private mode */ }
    go.terminal(it.slug);
  };

  // ＋ Bug / ＋ Audit: the room has no modals and no project loaded, so it
  // stashes a prefill and opens the project, which picks it up exactly once.
  const logTicket = (it: ReviewItem, kind: 'bug' | 'audit') => {
    setReviewPrefill({ kind, slug: it.slug, itemId: it.id, title: it.title });
    go.detail(it.slug, kind === 'bug' ? 'quality' : 'roadmap');
  };

  // Three keys clear a change; j/k walk the queue. Ignored while a modal is
  // open or a field has focus, so typing a refinement never votes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (view !== 'queue' || !sel || refineFor || undoFor || confirmDelete) return;
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const idx = list.findIndex((x) => key(x) === key(sel));
      if (e.key === '1') { e.preventDefault(); giveVerdict(sel); }
      else if (e.key === '2') { e.preventDefault(); openRefine(sel); }
      else if (e.key === '3') { e.preventDefault(); shelve(sel); }
      else if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); if (idx < list.length - 1) setSelId(key(list[idx + 1])); }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); if (idx > 0) setSelId(key(list[idx - 1])); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---- the debrief's nights ----
  const nights = useMemo(() => {
    const byDay = new Map<string, ReviewNightRun[]>();
    for (const r of data?.nights ?? []) {
      if (!r.day) continue;
      (byDay.get(r.day) ?? byDay.set(r.day, []).get(r.day)!).push(r);
    }
    return [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([day, runs]) => ({
        day,
        label: nightLabel(day),
        runs,
        landed: runs.filter((r) => r.outcome === 'landed').length,
        failed: runs.filter((r) => r.outcome === 'failed' || r.outcome === 'limit').length,
        tokens: runs.reduce((n, r) => n + r.tokens, 0),
        costUsd: runs.reduce((n, r) => n + r.costUsd, 0),
      }));
  }, [data]);
  const shownNight = nights.find((n) => n.day === night) ?? nights[0] ?? null;

  if (error && !data) return <div className="mc-error">{error}</div>;
  if (!data) return <div className="empty-state"><div className="big">Loading the review queue…</div></div>;

  const FILTERS: { key: Filter; label: string }[] = [
    { key: 'todo', label: 'To review' },
    { key: 'flagged', label: 'Flagged' },
    { key: 'shelved', label: 'Shelved' },
    { key: 'settled', label: 'Settled' },
  ];

  return (
    <div className="rv">
      <div className="rv-bar">
        <div className="seg-control sm" role="tablist" aria-label="Review view">
          {(['queue', 'debrief'] as View[]).map((v) => (
            <button key={v} role="tab" aria-selected={view === v}
              className={`seg-opt ${view === v ? 'on' : ''}`} onClick={() => setView(v)}>
              {v === 'queue' ? 'Queue' : 'Debrief'}
            </button>
          ))}
        </div>
        <span className="rv-header">
          {data.totals.pending
            ? `${data.totals.pending} change${data.totals.pending === 1 ? '' : 's'} waiting on you across ${data.totals.projects} project${data.totals.projects === 1 ? '' : 's'}`
            : 'Nothing waiting on you'}
          {data.totals.flagged > 0 && ` · ${data.totals.flagged} flagged`}
        </span>
        <div className="rv-spacer" />
        {view === 'queue' && (
          <div className="chips">
            {FILTERS.map((f) => (
              <button key={f.key} className={`chip-sm ${filter === f.key ? 'on' : ''}`}
                onClick={() => setFilter(f.key)}>
                {f.label} {lists[f.key].length}
              </button>
            ))}
          </div>
        )}
        {view === 'queue' && filter === 'todo' && list.length > 1 && (
          <button className="rv-bulk" disabled={busy}
            title="Mark every change in this list solid — for the mornings where you have already seen them all"
            onClick={() => act(async () => {
              for (const it of list) await patchRoadmapItem(it.slug, Number(it.id), { review_tag: 'solid' });
            }, { key: 'bulk', text: `${list.length} change${list.length === 1 ? '' : 's'} marked solid.` })}>
            ✓ All solid
          </button>
        )}
      </div>

      {error && <div className="mc-error">{error}</div>}

      {/* The receipt for what you just did, with its undo. Room level, not row
          level: a verdict removes its row from the list, so a receipt pinned to
          the selection would disappear exactly when you might want it back. */}
      {settledNote && (
        <div className="rv-receipt">
          <span>{settledNote.text}</span>
          {settledNote.undo && (
            <button onClick={() => { settledNote.undo!(); setSettledNote(null); }}>undo</button>
          )}
          <button className="x" onClick={() => setSettledNote(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      {view === 'queue' ? (
        <div className="rv-split">
          <div className="rv-rail">
            <div className="rv-rail-head">
              <span className="lbl">{FILTERS.find((f) => f.key === filter)?.label.toUpperCase()}</span>
              <div className="rv-spacer" />
              <span className="prog">{list.length ? `${list.findIndex((x) => sel && key(x) === key(sel)) + 1} of ${list.length}` : '—'}</span>
            </div>
            <div className="rv-rail-list">
              {list.map((it) => {
                const v = it.run?.reviewVerdict ?? '';
                return (
                  <button key={key(it)} className={`rv-card ${sel && key(sel) === key(it) ? 'on' : ''}`}
                    onClick={() => setSelId(key(it))}>
                    <span className="row1">
                      <span className={`rv-verdict ${v || 'none'}`}>{VERDICT_LABEL[v]}</span>
                      {(it.run?.checksFailing ?? 0) > 0 && (
                        <span className="rv-flag" title="The run finished with checks red">CHECKS</span>
                      )}
                      {/* #284 — ARCH only when the architect had something to say;
                          "aligned" is not news and would just add noise. */}
                      {it.run?.architectVerdict && it.run.architectVerdict !== 'aligned' && (
                        <span className="rv-arch" title={it.run.architectNote || 'The architect flagged structure'}>ARCH</span>
                      )}
                      {it.reviewTag && <span className="rv-settled-chip">{it.reviewTag}</span>}
                      <span className="rv-spacer" />
                      <span className="age">{it.when}</span>
                    </span>
                    <span className="t">{it.title}</span>
                    <span className="row2">
                      <span className="where">{it.name} · #{it.id}</span>
                      <span className="size">{sizeOf(it)}</span>
                    </span>
                  </button>
                );
              })}
              {!list.length && (
                <div className="rv-empty">
                  {filter === 'todo' ? 'Nothing waiting. Completed work lands here with a note on what was built.'
                    : filter === 'flagged' ? 'Nothing flagged — no reviewer said blocked and no run left checks red.'
                      : filter === 'shelved' ? 'Nothing shelved.'
                        : 'Nothing verdicted yet.'}
                </div>
              )}
            </div>
          </div>

          {sel ? <Detail
            it={sel}
            busy={busy}
            brief={briefs.get(key(sel))}
            undoNote={undoNotes.get(key(sel))}
            onVerdict={() => giveVerdict(sel)}
            onRefine={() => { openRefine(sel); }}
            onShelve={() => shelve(sel)}
            onBoard={() => toBoard(sel)}
            onUndo={() => setUndoFor(sel)}
            onBrief={() => toggleBrief(sel)}
            onSession={() => openSession(sel)}
            onLogBug={() => logTicket(sel, 'bug')}
            onLogAudit={() => logTicket(sel, 'audit')}
            onToggleTag={(t) => toggleTag(sel, t)}
            onDelete={() => setConfirmDelete(sel)}
          /> : (
            <div className="rv-detail empty">
              <div className="empty-state">
                <div className="big">All clear</div>
                <div>Nothing in this list needs a verdict.</div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <Debrief nights={nights} shown={shownNight} onPickNight={setNight}
          onOpenItem={(slug, id) => go.detail(slug, 'roadmap', id)}
          onReview={(slug, id) => { setView('queue'); setFilter('todo'); setSelId(`${slug}#${id}`); }} />
      )}

      {/* ✎ Refine (#146) + the ✦ assist (Turn 3). Two states of one dialog:
          3a offers the draft from an empty box, 3b wraps the same box in the
          accent chrome once a machine has written the first pass. The text is
          one piece of state across both, so the draft is editable the instant
          it lands and there is no accept step between it and Send it back. */}
      {refineFor && (
        <Modal onClose={closeRefine}>
          <h3>✎ Refine #{refineFor.id}</h3>
          <div className="confirm-body" style={{ marginBottom: 12 }}>
            Say only what to change on top of what landed. The item goes back to the board as
            itself — same id, what landed stays on record — carrying just this instruction.
          </div>
          {refineDraft ? (
            <div className="rv-draft">
              <div className="rv-draft-head">
                <span className="who">✦ Gemini draft</span>
                <span className="from" title={refineDraft.read.length
                  ? `Written from ${refineDraft.read.join(', ')}. Gemini cannot read the repository — there is no diff here, only the project's record of the work.`
                  : 'This item had almost no record behind it — read the draft twice.'}>
                  {refineDraft.read.length ? `from ${refineDraft.read.join(' · ')}` : 'from a thin record'}
                  {refineDraft.basis && ` · leaned on ${refineDraft.basis}`}
                  {` · ${refineDraft.secs}s`}
                </span>
                <button className="act" disabled={refineBusy} onClick={draftRefine}
                  title="Ask again — the record has not changed, but the wording will">
                  {refineBusy ? '◴' : '↻ redraft'}
                </button>
                <button className="act" onClick={dropDraft}
                  title="Drop the draft and put back what you had typed">✕</button>
              </div>
              <textarea className="field-input" rows={5} autoFocus value={refineText}
                onChange={(e) => setRefineText(e.target.value)}
                onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') doRefine(); }} />
            </div>
          ) : (<>
            <textarea className="field-input" rows={5} autoFocus value={refineText}
              placeholder="e.g. the totals are right but the empty state still says “no items”"
              onChange={(e) => setRefineText(e.target.value)}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') doRefine(); }} />
            {/* Absent, not disabled, on a keyless server — the same rule every
                other Gemini surface follows. */}
            {data?.geminiReady && (
              <div className="rv-draft-offer">
                <button className="btn-repo sm" disabled={refineBusy} onClick={draftRefine}>
                  {refineBusy ? '◴ Drafting…' : '✦ Draft it with Gemini'}
                </button>
                <span className="note" title="Gemini cannot read the repository. It reads the project's RECORD of the work: the session's own account, the second model's stored read of the branch diff, the architect's structural read, and the files the sessions on that branch touched.">
                  reads the run log and the reviewer's notes
                </span>
              </div>
            )}
          </>)}
          {refineSay && <div className={`rv-draft-say ${refineSay.tone}`}>{refineSay.text}</div>}
          <label className="rv-queue-toggle">
            <input type="checkbox" checked={refineQueue} onChange={(e) => setRefineQueue(e.target.checked)} />
            <span>Queue a session on it now</span>
          </label>
          <div className="modal-actions" style={{ marginTop: 14 }}>
            <button className="btn-cancel" onClick={closeRefine}>Cancel</button>
            <button className="btn-submit" disabled={!refineText.trim()} onClick={doRefine}>Send it back</button>
          </div>
        </Modal>
      )}
      {undoFor && (
        <ConfirmModal
          title="Undo this change?"
          body={<>Revert every commit on main tagged <b>#{undoFor.id}</b> and send the item back to
            the board. The host does the revert in a throwaway worktree and pushes the revert
            commits — nothing is rewritten.</>}
          confirmLabel="Queue the undo" cancelLabel="Cancel" danger
          onConfirm={() => doUndo(undoFor)} onCancel={() => setUndoFor(null)} />
      )}
      {confirmDelete && (
        <ConfirmModal
          title="Delete this item?"
          body={<>Delete <b>{confirmDelete.title}</b> from {confirmDelete.name}. Its history goes
            with it; the commits stay on main.</>}
          confirmLabel="Delete item" cancelLabel="Cancel" danger
          onConfirm={() => { const it = confirmDelete; setConfirmDelete(null); remove(it); }}
          onCancel={() => setConfirmDelete(null)} />
      )}
    </div>
  );
}

// ---- the change under review (24b's right-hand pane) --------------------

function Detail({
  it, busy, brief, undoNote,
  onVerdict, onRefine, onShelve, onBoard, onUndo, onBrief, onSession, onLogBug, onLogAudit,
  onToggleTag, onDelete,
}: {
  it: ReviewItem; busy: boolean;
  brief?: { loading?: boolean; error?: string; data?: ReviewBrief };
  undoNote?: string;
  onVerdict: () => void; onRefine: () => void; onShelve: () => void; onBoard: () => void;
  onUndo: () => void; onBrief: () => void; onSession: () => void;
  onLogBug: () => void; onLogAudit: () => void;
  onToggleTag: (t: string) => void; onDelete: () => void;
}) {
  const v = it.run?.reviewVerdict ?? '';
  const facts: { k: string; v: string; tone?: string }[] = [
    { k: 'project', v: it.name },
    { k: 'item', v: `#${it.id} · ${it.bucket}` },
    { k: 'built by', v: it.origin === 'branch' ? `⚑ ${it.branch}` : ORIGIN_LABEL[it.origin] },
    { k: 'completed', v: it.when },
    ...(it.run ? [
      { k: 'branch', v: it.run.branch || '—' },
      { k: 'commits', v: String(it.run.commits) },
      { k: 'spend', v: `${fmtTok(it.run.tokens)}${it.run.costUsd ? ` · $${it.run.costUsd.toFixed(2)}` : ''}` },
      {
        k: 'checks',
        v: it.run.checksFailing == null ? 'none ran'
          : it.run.checksFailing === 0 ? 'all green' : `${it.run.checksFailing} failing`,
        tone: (it.run.checksFailing ?? 0) > 0 ? 'bad' : it.run.checksFailing === 0 ? 'good' : undefined,
      },
    ] : []),
    ...(it.risk && it.risk !== 'normal' ? [{ k: 'risk', v: it.risk }] : []),
  ];

  return (
    <div className="rv-detail">
      <div className="rv-detail-head">
        <div className="row">
          <span className={`rv-verdict ${v || 'none'}`}>{VERDICT_LABEL[v]}</span>
          <span className="meta">{it.name} · #{it.id} · {sizeOf(it)} · completed {it.when}</span>
        </div>
        <h3>{it.title}</h3>
        {it.note && <p className="what">{it.note}</p>}
        {it.refineNote && (
          <p className="what refine">↻ Pending refinement: {it.refineNote}</p>
        )}
      </div>

      <div className="rv-detail-body">
        <div className="rv-main">
          <section>
            <div className="rv-lbl">THE CHANGE</div>
            {it.builtNote ? (
              <div className="rv-built">{it.builtNote}</div>
            ) : (
              <div className="rv-quiet">
                The session that built this left no account of what landed. The run's own summary is
                below; the branch is where the truth is.
              </div>
            )}
            {it.run?.summary && (
              <div className="rv-runsum">
                <span className="lbl">The session's own account</span>
                {it.run.summary}
              </div>
            )}
            {it.run && (
              <div className="rv-changefoot">
                <span className="mono">{it.run.branch}</span>
                <span className="mono">{it.run.commits} commit{it.run.commits === 1 ? '' : 's'}</span>
                <span className="rv-spacer" />
                <span className="rv-quiet inline">
                  No line-by-line diff here — the server can't run git. Read it on the branch, or
                  open a session below.
                </span>
              </div>
            )}
          </section>

          <section>
            <div className="rv-lbl">WHAT THE AGENTS SAID</div>
            {v ? (
              <div className={`rv-opinion ${v}`}>
                <span className="agent">REVIEWER</span>
                <div className="body">
                  <span className="t">{it.run?.reviewNote || 'No note — only the verdict.'}</span>
                  <span className="meta">
                    ✧ Gemini on the branch diff · {VERDICT_LABEL[v].toLowerCase()}
                    {it.run?.reviewFindings != null && ` · ${it.run.reviewFindings} finding${it.run.reviewFindings === 1 ? '' : 's'} filed to the review inbox`}
                  </span>
                </div>
              </div>
            ) : (
              <div className="rv-quiet">
                No second-model review ran on this change{it.origin === 'manual' ? ' — it was built by hand' : ''}.
                That is not the same as nothing being wrong with it.
              </div>
            )}
            {/* #284 — the architect, when it ran. Different question from the
                reviewer's: not "is this correct" but "where is this going". */}
            {it.run?.architectVerdict ? (
              <div className={`rv-opinion arch ${it.run.architectVerdict}`}>
                <span className="agent arch">ARCHITECT</span>
                <div className="body">
                  <span className="t">{it.run.architectNote || 'No note — only the verdict.'}</span>
                  {it.run.architectObs.length > 0 && (
                    <ul className="rv-obs">
                      {it.run.architectObs.map((o, i) => <li key={i}>{o}</li>)}
                    </ul>
                  )}
                  <span className="meta">
                    ✧ Gemini on the same diff · structure, not correctness · {ARCH_LABEL[it.run.architectVerdict].toLowerCase()}
                  </span>
                </div>
              </div>
            ) : (
              <div className="rv-quiet dashed">
                No architect read this change{it.origin === 'manual' ? ' — it was built by hand' : ''}. The
                structural pass runs at the end of an autopilot run and needs a Gemini key.
              </div>
            )}
            {brief && (
              <div className="review-brief">
                {brief.loading && <div className="rb-loading">✧ Reading the item, its run and the checks…</div>}
                {brief.error && <div className="rb-err">{brief.error}</div>}
                {brief.data && (<>
                  <div className="rb-summary">{brief.data.summary}</div>
                  {brief.data.test.length > 0 && (
                    <div className="rb-block">
                      <div className="rb-lbl">Test it</div>
                      <ol>{brief.data.test.map((s, i) => <li key={i}>{s}</li>)}</ol>
                    </div>
                  )}
                  {brief.data.risks.length > 0 && (
                    <div className="rb-block">
                      <div className="rb-lbl">Likely risks</div>
                      <ul>{brief.data.risks.map((s, i) => <li key={i}>{s}</li>)}</ul>
                    </div>
                  )}
                  <div className="rb-foot">✧ Gemini's read — verify before trusting it.</div>
                </>)}
              </div>
            )}
          </section>

          <section>
            <div className="rv-lbl">YOUR NOTES WHILE TESTING</div>
            <div className="review-tags">
              {NOTE_TAGS.map((t) => (
                <button key={t.key} className={`rt ${it.reviewTags.includes(t.key) ? 'on' : ''}`}
                  onClick={() => onToggleTag(t.key)}
                  title="Review annotation — sticks to the item while it awaits its verdict">
                  {t.label}
                </button>
              ))}
              {it.reviewTags.filter((t) => !NOTE_TAGS.some((c) => c.key === t)).map((t) => (
                <button key={t} className="rt on" onClick={() => onToggleTag(t)}
                  title="Review annotation — click to remove">{noteTagLabel(t)}</button>
              ))}
            </div>
          </section>
        </div>

        <div className="rv-side">
          <div className="rv-panel">
            <div className="rv-lbl">FACTS</div>
            {facts.map((f) => (
              <div className="rv-fact" key={f.k}>
                <span className="k">{f.k}</span>
                <span className={`v ${f.tone ?? ''}`}>{f.v}</span>
              </div>
            ))}
          </div>

          <div className="rv-panel">
            <div className="rv-lbl">DECIDE</div>
            <button className="rv-act primary" disabled={busy} onClick={onVerdict}>
              <span className="k">1</span><span>Solid — close it out</span>
            </button>
            <button className="rv-act" disabled={busy} onClick={onRefine}>
              <span className="k">2</span><span>✎ Refine — send back the delta</span>
            </button>
            <button className="rv-act" disabled={busy} onClick={onShelve}>
              <span className="k">3</span><span>{it.shelved ? '▶ Back to the list' : '⏸ Later'}</span>
            </button>
            <span className="rv-note">
              Solid is the only verdict — dissatisfaction goes through Refine, which sends the item
              back carrying just what to change. 1/2/3 work from the keyboard; j/k walk the queue.
            </span>
          </div>

          <div className="rv-panel">
            <div className="rv-lbl">ALSO</div>
            <div className="rv-more">
              <button disabled={busy} onClick={onBoard} title="Didn't hold up — send it back to the board unchanged">↩ Board</button>
              <button disabled={busy} onClick={onUndo} title="Revert this item's commits on main and send it back">⎌ Undo</button>
              <button onClick={onBrief} title="✧ Gemini writes the reviewer's brief — what shipped, how to test it, likely risks">✧ Brief</button>
              <button onClick={onSession} title="Open a terminal in this project primed with this review">⌨ Session</button>
              <button onClick={onLogBug} title="Log a bug ticket against this item">＋ Bug</button>
              <button onClick={onLogAudit} title="Log an audit item to check what landed">＋ Audit</button>
              <button className="danger" onClick={onDelete} title="Delete the item">× Delete</button>
            </div>
          </div>

          {undoNote && <div className="rv-panel note">⎌ {undoNote}</div>}
        </div>
      </div>
    </div>
  );
}

// ---- the night debrief (24a) --------------------------------------------

type Night = {
  day: string; label: string; runs: ReviewNightRun[];
  landed: number; failed: number; tokens: number; costUsd: number;
};

function Debrief({ nights, shown, onPickNight, onOpenItem, onReview }: {
  nights: Night[]; shown: Night | null; onPickNight: (day: string) => void;
  onOpenItem: (slug: string, id: string) => void;
  onReview: (slug: string, id: string) => void;
}) {
  if (!nights.length) {
    return (
      <div className="empty-state">
        <div className="big">No nights to debrief</div>
        <div>Once the autopilot has run, each night's work is summarised here.</div>
      </div>
    );
  }
  const n = shown!;
  // What the night is asking you for — each one a real decision with a real
  // door, not a summary line.
  const decisions = [
    ...n.runs.filter((r) => r.reviewVerdict === 'blocked').map((r) => ({
      tag: 'BLOCKED', tone: 'bad' as const,
      t: `The reviewer blocked ${r.itemTitle || `#${r.itemId}`} — ${r.reviewNote || 'it flagged serious findings'}`,
      act: 'Review it', run: r,
    })),
    ...n.runs.filter((r) => (r.checksFailing ?? 0) > 0).map((r) => ({
      tag: 'CHECKS', tone: 'bad' as const,
      t: `${r.itemTitle || `#${r.itemId}`} landed with ${r.checksFailing} check${r.checksFailing === 1 ? '' : 's'} red`,
      act: 'Review it', run: r,
    })),
    ...n.runs.filter((r) => r.outcome === 'limit').map((r) => ({
      tag: 'PAUSED', tone: 'warn' as const,
      t: `${r.itemTitle || `#${r.itemId}`} stopped on the usage limit — its branch keeps its claim`,
      act: 'Open the item', run: r,
    })),
    ...n.runs.filter((r) => r.outcome === 'failed').map((r) => ({
      tag: 'FAILED', tone: 'bad' as const,
      t: `${r.itemTitle || `#${r.itemId}`} failed — ${r.summary?.slice(0, 120) || 'no account left behind'}`,
      act: 'Open the item', run: r,
    })),
  ];
  const reviewed = n.runs.filter((r) => r.reviewVerdict);
  const clean = reviewed.filter((r) => r.reviewVerdict === 'clean').length;

  return (
    <div className="rv-debrief">
      <div className="rv-nights">
        {/* #304 — the strip is a chooser, so it should point at the nights
            worth opening. A night that LANDED something wears its count in the
            live tone; a night that produced nothing recedes. Receding is
            colour and weight, never removal: a quiet night is still a night
            you can open, and the selected one is never dimmed, or the strip
            would fade out the very thing you just pressed. */}
        {nights.slice(0, 8).map((x) => (
          <button key={x.day}
            className={`rv-night ${x.day === n.day ? 'on' : ''} ${x.landed > 0 ? 'landed' : 'quiet'}`}
            title={x.landed > 0
              ? `${x.landed} change${x.landed === 1 ? '' : 's'} landed this night`
              : 'Nothing landed this night'}
            onClick={() => onPickNight(x.day)}>
            <span className="d">{x.label}</span>
            <span className="s">
              {x.landed > 0
                ? `${x.landed} landed${x.failed ? ` · ${x.failed} not` : ''}`
                : x.failed ? `${x.failed} didn't land` : 'nothing landed'}
            </span>
          </button>
        ))}
      </div>

      <div className="rv-debrief-head">
        <div className="left">
          <div className="row">
            <h3>{n.label}</h3>
            <span className={`rv-badge ${n.failed ? 'warn' : 'good'}`}>
              {n.failed ? `${n.landed} landed · ${n.failed} didn't` : `${n.landed} landed`}
            </span>
          </div>
          <p>
            {n.runs.length} run{n.runs.length === 1 ? '' : 's'} across{' '}
            {new Set(n.runs.map((r) => r.slug)).size} project{new Set(n.runs.map((r) => r.slug)).size === 1 ? '' : 's'}
            {reviewed.length
              ? `. The reviewer read ${reviewed.length} of them and called ${clean} clean.`
              : '. No second-model review ran, so nothing arrived pre-verdicted.'}
            {(() => {
              const arch = n.runs.filter((r) => r.architectVerdict);
              const drift = arch.filter((r) => r.architectVerdict !== 'aligned').length;
              if (!arch.length) return '';
              return drift
                ? ` The architect flagged ${drift} for structure.`
                : ' The architect found nothing drifting.';
            })()}
          </p>
        </div>
        <div className="stats">
          <div className="st"><span className="n">{n.landed}</span><span className="l">landed</span></div>
          <div className="st"><span className={`n ${n.failed ? 'bad' : ''}`}>{n.failed}</span><span className="l">didn't</span></div>
          <div className="st"><span className="n">{fmtTok(n.tokens)}</span><span className="l">spent</span></div>
          <div className="st"><span className="n">${n.costUsd.toFixed(2)}</span><span className="l">cost</span></div>
        </div>
      </div>

      <div className="rv-debrief-body">
        <div className="rv-main">
          <div className="rv-rule"><span className="rv-lbl">WHAT LANDED</span><i /><span className="mono">{n.landed} of {n.runs.length} runs</span></div>
          {n.runs.map((r) => (
            <div className={`rv-change ${r.outcome}`} key={r.id}>
              <div className="head">
                <span className={`dot ${r.outcome === 'landed' ? 'good' : r.outcome === 'planned' ? 'plan' : 'bad'}`} />
                <div className="body">
                  <span className="t">{r.itemTitle || `#${r.itemId}` || r.branch}</span>
                  <span className="where">{r.name} · {r.branch || 'no branch'} · {r.when}</span>
                </div>
                <span className="size">{r.commits} commit{r.commits === 1 ? '' : 's'}</span>
                <span className={`rv-verdict ${r.reviewVerdict || 'none'}`}>{VERDICT_LABEL[r.reviewVerdict || '']}</span>
              </div>
              <div className="notes">
                {r.reviewNote && (
                  <div className={`rv-opinion ${r.reviewVerdict || 'none'} tight`}>
                    <span className="agent">REVIEWER</span>
                    <span className="t">{r.reviewNote}</span>
                  </div>
                )}
                {r.architectVerdict && r.architectVerdict !== 'aligned' && (
                  <div className={`rv-opinion arch ${r.architectVerdict} tight`}>
                    <span className="agent arch">ARCHITECT</span>
                    <span className="t">{r.architectNote || ARCH_LABEL[r.architectVerdict]}</span>
                  </div>
                )}
                {r.summary && (
                  <div className="rv-opinion session tight">
                    <span className="agent">SESSION</span>
                    <span className="t">{r.summary.slice(0, 400)}</span>
                  </div>
                )}
                <div className="acts">
                  {r.itemId && <button className="primary" onClick={() => onReview(r.slug, r.itemId)}>Review this change</button>}
                  {r.itemId && <button onClick={() => onOpenItem(r.slug, r.itemId)}>Open the item</button>}
                  <div className="rv-spacer" />
                  <span className="mono">{fmtTok(r.tokens)}{r.costUsd ? ` · $${r.costUsd.toFixed(2)}` : ''}</span>
                </div>
              </div>
            </div>
          ))}

          {decisions.length > 0 && (<>
            <div className="rv-rule"><span className="rv-lbl">DECISIONS THIS DEBRIEF ASKS FOR</span><i /></div>
            {decisions.map((d, i) => (
              <div className={`rv-decision ${d.tone}`} key={i}>
                <span className="tag">{d.tag}</span>
                <span className="t">{d.t}</span>
                <button onClick={() => (d.act === 'Review it'
                  ? onReview(d.run.slug, d.run.itemId)
                  : onOpenItem(d.run.slug, d.run.itemId))}>{d.act}</button>
              </div>
            ))}
          </>)}
          {!decisions.length && (
            <div className="rv-quiet dashed">
              Nothing from this night needs a decision beyond the verdicts themselves.
            </div>
          )}
        </div>

        <div className="rv-side">
          <div className="rv-panel">
            <div className="rv-lbl">REVIEWER</div>
            {reviewed.length ? (<>
              <div className={`rv-verdict-big ${clean === reviewed.length ? 'clean' : 'concerns'}`}>
                {clean === reviewed.length ? 'Nothing to flag' : `${reviewed.length - clean} of ${reviewed.length} flagged`}
              </div>
              {reviewed.map((r) => (
                <div className="rv-revline" key={r.id}>
                  <span className={`mark ${r.reviewVerdict}`}>{r.reviewVerdict === 'clean' ? '✓' : r.reviewVerdict === 'blocked' ? '✕' : '!'}</span>
                  <span className="t">{r.itemTitle || `#${r.itemId}`}{r.reviewNote ? ` — ${r.reviewNote}` : ''}</span>
                </div>
              ))}
            </>) : (
              <div className="rv-quiet">
                No review ran on this night's work. The nightly review needs a Gemini key; without
                one, changes arrive unread.
              </div>
            )}
          </div>

          <div className="rv-panel">
            <div className="rv-lbl">ARCHITECT</div>
            {(() => {
              // #284 — the night's structural reads. Drifting and concerning are
              // the news; a night that is entirely aligned says so in one line
              // rather than listing every change that was fine.
              const read = n.runs.filter((r) => r.architectVerdict);
              const flagged = read.filter((r) => r.architectVerdict !== 'aligned');
              if (!read.length) {
                return (
                  <div className="rv-quiet">
                    No structural pass ran on this night's work. The architect reads each branch diff
                    at run end and needs a Gemini key.
                  </div>
                );
              }
              return (<>
                <div className={`rv-verdict-big ${flagged.length ? 'concerns' : 'clean'}`}>
                  {flagged.length
                    ? `${flagged.length} of ${read.length} drifting`
                    : `All ${read.length} aligned`}
                </div>
                {flagged.length === 0 && (
                  <div className="rv-quiet">Nothing this night pushed the codebase anywhere it wasn't already going.</div>
                )}
                {flagged.map((r) => (
                  <div className="rv-revline" key={r.id}>
                    <span className={`mark ${r.architectVerdict}`}>
                      {r.architectVerdict === 'concerning' ? '✕' : '~'}
                    </span>
                    <span className="t">
                      {r.itemTitle || `#${r.itemId}`}{r.architectNote ? ` — ${r.architectNote}` : ''}
                      {r.architectObs.length > 0 && (
                        <ul className="rv-obs">{r.architectObs.map((o, i) => <li key={i}>{o}</li>)}</ul>
                      )}
                    </span>
                  </div>
                ))}
              </>);
            })()}
          </div>

          <div className="rv-panel">
            <div className="rv-lbl">SPEND</div>
            <div className="rv-fact"><span className="k">tokens</span><span className="v">{fmtTok(n.tokens)}</span></div>
            <div className="rv-fact"><span className="k">cost</span><span className="v">${n.costUsd.toFixed(2)}</span></div>
            <div className="rv-fact"><span className="k">per landed</span>
              <span className="v">{n.landed ? `$${(n.costUsd / n.landed).toFixed(2)}` : '—'}</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}
