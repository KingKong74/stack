import { useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal';
import {
  createAutopilotSchedule, patchAutopilotSchedule, getRoadmap, getBugs, AuthError,
  type AutopilotSchedule, type SessionKind,
} from '../store';
import type { Bug, RoadmapItem } from '../types';
import { isApproved, isHeld } from '../lib/approval';

// The session planner (#228) — a scheduled session opened into its own thing.
// Kind picks what the runner does; the agenda is the ordered work list chosen
// straight off the roadmap (or the bug tracker for a debug session); area
// scopes the general pick when no agenda is set. Everything lands on the
// schedule row, rides the job to the dispatcher, and becomes runner flags.

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const KINDS: { key: SessionKind; label: string; hint: string }[] = [
  { key: 'build', label: 'Build', hint: 'Work roadmap items on reviewable branches — the agenda in order, else the board top-down.' },
  { key: 'plan', label: 'Plan', hint: 'Design-doc session: no code, no branches — each picked item gets plan steps + a design note.' },
  { key: 'debug', label: 'Debug', hint: 'Fix bugs, each on its own branch — the agenda in order, else open bugs serious-first. Never closes a bug.' },
  { key: 'audit', label: 'Audit', hint: 'One hardening pass: run the suites, hunt verified defects, file them as bugs, strengthen tests.' },
];

type Mode = 'once' | 'daily' | 'custom';

export function SessionPlanModal({
  projects, initial, defaultSlug, onClose, onSaved,
}: {
  projects: { slug: string; name: string }[];
  initial: AutopilotSchedule | null;
  defaultSlug?: string;
  onClose: () => void;
  onSaved: (row: AutopilotSchedule, isNew: boolean) => void;
}) {
  const [slug, setSlug] = useState(initial?.slug || defaultSlug || '');
  const [kind, setKind] = useState<SessionKind>(initial?.kind || 'build');
  const [atTime, setAtTime] = useState(initial?.atTime || '21:00');
  const [mode, setMode] = useState<Mode>(
    initial ? (initial.runDate ? 'once' : initial.days.length === 7 ? 'daily' : 'custom') : 'once');
  const [runDate, setRunDate] = useState(initial?.runDate || fmtDate(new Date()));
  const [days, setDays] = useState<number[]>(initial?.days || []);
  const [area, setArea] = useState(initial?.area || '');
  const [agenda, setAgenda] = useState<(number | string)[]>(initial?.agenda?.length
    ? initial.agenda
    : initial?.itemId ? [Number(initial.itemId)] : []);
  const [note, setNote] = useState(initial?.note || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // The pickable work: open roadmap items (build/plan) or open bugs (debug),
  // fetched when the project is chosen. null = loading.
  const [items, setItems] = useState<RoadmapItem[] | null>(null);
  const [bugs, setBugs] = useState<Bug[] | null>(null);
  useEffect(() => {
    if (!slug) { setItems(null); setBugs(null); return; }
    let live = true;
    setItems(null);
    setBugs(null);
    getRoadmap(slug)
      .then((r) => { if (live) setItems([...r.must, ...r.should, ...r.could, ...r.wont].filter((it) => !it.done)); })
      .catch(() => { if (live) setItems([]); });
    getBugs(slug)
      .then((b) => { if (live) setBugs(b.filter((x) => x.status !== 'fixed')); })
      .catch(() => { if (live) setBugs([]); });
    return () => { live = false; };
  }, [slug]);

  const areas = useMemo(
    () => [...new Set((items || []).map((it) => it.area).filter(Boolean))].sort(),
    [items]);

  // What a general (agenda-less) build/plan session would take: the board's own
  // priority order — this IS the priority list, previewed so it's never a mystery.
  const boardPreview = useMemo(() => {
    if (!items || kind === 'debug' || kind === 'audit') return [];
    return items
      .filter((it) => ['must', 'should'].includes(it.bucket) && !it.claimedBy && !it.skipped
        && isApproved(it)
        && (!area || (it.area || '') === area)
        && (kind !== 'plan' || !(it.plan?.length)))
      .slice(0, 4);
  }, [items, kind, area]);

  const sevRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const bugPreview = useMemo(() => (kind !== 'debug' || !bugs ? [] :
    [...bugs].sort((a, b) => (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9)).slice(0, 4)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [kind, bugs]);

  const available = kind === 'debug'
    ? (bugs || []).filter((b) => !agenda.includes(b.id))
    : (items || []).filter((it) => !agenda.includes(it.id) && (kind !== 'plan' || !it.plan?.some((s) => s.done)));

  const agendaLabel = (key: number | string): string => {
    if (typeof key === 'string') {
      const b = (bugs || []).find((x) => x.id === key);
      return b ? `${key} · ${b.title}` : key;
    }
    const it = (items || []).find((x) => x.id === key);
    return it ? `#${key} [${it.bucket}] ${it.title}` : `#${key}`;
  };
  const moveAgenda = (i: number, dir: -1 | 1) =>
    setAgenda((a) => {
      const n = [...a];
      const j = i + dir;
      if (j < 0 || j >= n.length) return a;
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });

  // Switching kind changes what an agenda entry even is — clear it.
  const pickKind = (k: SessionKind) => {
    if (k === kind) return;
    setKind(k);
    setAgenda([]);
  };

  const save = async () => {
    if (!slug || busy) return;
    const dayList = mode === 'daily' ? [0, 1, 2, 3, 4, 5, 6] : mode === 'custom' ? days : [];
    if (mode === 'custom' && !dayList.length) { setErr('Pick at least one day for a repeating session.'); return; }
    if (mode === 'once' && !runDate) { setErr('Pick a date for a one-off session.'); return; }
    setBusy(true);
    setErr('');
    const payload = {
      atTime, days: dayList, runDate: mode === 'once' ? runDate : null,
      itemId: null, note: note.trim(), kind, agenda, area: kind === 'audit' || !agenda.length ? area : '',
    };
    try {
      const row = initial
        ? await patchAutopilotSchedule(initial.id, payload)
        : await createAutopilotSchedule({ slug, ...payload });
      onSaved(row, !initial);
      onClose();
    } catch (e) {
      if (!(e instanceof AuthError)) setErr((e as Error)?.message || 'Could not save the session.');
    } finally {
      setBusy(false);
    }
  };

  const kindHint = KINDS.find((k) => k.key === kind)?.hint || '';
  const showAgenda = kind !== 'audit';

  return (
    <Modal onClose={onClose} closeOnOverlay={false} wide>
      <div className="spm">
        <div className="spm-head">
          <span className="name">{initial ? 'Session plan' : 'Plan a session'}</span>
          <span className="sub">{initial ? `#${initial.id}` : ''}</span>
          <button className="spm-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="spm-row">
          <select value={slug} disabled={!!initial} aria-label="Project"
            onChange={(e) => { setSlug(e.target.value); setAgenda([]); setArea(''); }}>
            <option value="">Project…</option>
            {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
          </select>
          <input type="time" value={atTime} aria-label="Start time (host local)"
            onChange={(e) => setAtTime(e.target.value)} />
          <span className="seg-control sm" role="tablist" aria-label="Repeat">
            {(['once', 'daily', 'custom'] as Mode[]).map((m) => (
              <button key={m} role="tab" aria-selected={mode === m}
                className={`seg-opt ${mode === m ? 'on' : ''}`} onClick={() => setMode(m)}>
                {m === 'once' ? 'Once' : m === 'daily' ? 'Daily' : 'Days'}
              </button>
            ))}
          </span>
          {mode === 'once' && (
            <input type="date" value={runDate} min={fmtDate(new Date())} aria-label="Date"
              onChange={(e) => setRunDate(e.target.value)} />
          )}
          {mode === 'custom' && (
            <span className="mc-daypick" role="group" aria-label="Repeat days">
              {DAY_LABELS.map((label, d) => (
                <button key={label} className={`mc-daybtn ${days.includes(d) ? 'on' : ''}`}
                  aria-pressed={days.includes(d)}
                  onClick={() => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort())}>
                  {label[0]}
                </button>
              ))}
            </span>
          )}
        </div>

        <div className="spm-kinds" role="tablist" aria-label="Session kind">
          {KINDS.map((k) => (
            <button key={k.key} role="tab" aria-selected={kind === k.key}
              className={`spm-kind ${k.key} ${kind === k.key ? 'on' : ''}`}
              onClick={() => pickKind(k.key)}>{k.label}</button>
          ))}
        </div>
        <div className="spm-kind-hint">{kindHint}</div>

        {slug && (
          <>
            {showAgenda ? (
              <div className="spm-agenda">
                <div className="spm-col">
                  <div className="spm-col-head">
                    {kind === 'debug' ? 'Open bugs' : 'Open roadmap'}
                    {kind !== 'debug' && areas.length > 0 && (
                      <select className="spm-area" value={area} aria-label="Area scope"
                        onChange={(e) => setArea(e.target.value)}>
                        <option value="">all areas</option>
                        {areas.map((a) => <option key={a} value={a}>{a}</option>)}
                      </select>
                    )}
                  </div>
                  <div className="spm-list">
                    {(kind === 'debug' ? bugs : items) === null ? (
                      <div className="spm-empty">Loading…</div>
                    ) : available.length === 0 ? (
                      <div className="spm-empty">Nothing open to add.</div>
                    ) : kind === 'debug' ? (
                      (available as Bug[]).map((b) => (
                        <button key={b.id} className="spm-pick" onClick={() => setAgenda((a) => [...a, b.id])}>
                          <span className={`sev ${b.severity}`}>{b.severity}</span>
                          <span className="t">{b.id} {b.title}</span>
                          <span className="plus">＋</span>
                        </button>
                      ))
                    ) : (
                      (available as RoadmapItem[])
                        .filter((it) => !area || (it.area || '') === area)
                        .map((it) => (
                          // An unapproved auto-found item is unpickable for the same
                          // reason a claimed one is: the server drops it out of the
                          // agenda at enqueue time (#359), so offering it here would
                          // be offering a choice that silently does nothing.
                          <button key={it.id} className="spm-pick" disabled={Boolean(it.claimedBy) || isHeld(it)}
                            onClick={() => setAgenda((a) => [...a, it.id])}>
                            <span className={`bkt ${it.bucket}`}>{it.bucket}</span>
                            <span className="t">#{it.id} {it.title}{it.claimedBy ? ' — claimed' : isHeld(it) ? ' — in the review inbox' : ''}</span>
                            {it.area && <span className="ar">{it.area}</span>}
                            <span className="plus">＋</span>
                          </button>
                        ))
                    )}
                  </div>
                </div>
                <div className="spm-col">
                  <div className="spm-col-head">Agenda · worked in order</div>
                  <div className="spm-list">
                    {agenda.length === 0 ? (
                      <div className="spm-empty">
                        {kind === 'debug' ? (
                          <>No agenda — takes open bugs serious-first{bugPreview.length > 0 && (
                            <span className="preview">{bugPreview.map((b) => `${b.id} (${b.severity})`).join(' → ')}</span>)}
                          </>
                        ) : (
                          <>No agenda — takes the board's own priority order{area ? ` in "${area}"` : ''}{boardPreview.length > 0 && (
                            <span className="preview">{boardPreview.map((it) => `#${it.id} ${it.title.slice(0, 32)}`).join(' → ')}</span>)}
                          </>
                        )}
                      </div>
                    ) : (
                      agenda.map((key, i) => (
                        <div className="spm-agenda-row" key={String(key)}>
                          <span className="n">{i + 1}</span>
                          <span className="t">{agendaLabel(key)}</span>
                          <button onClick={() => moveAgenda(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                          <button onClick={() => moveAgenda(i, 1)} disabled={i === agenda.length - 1} aria-label="Move down">↓</button>
                          <button className="x" onClick={() => setAgenda((a) => a.filter((k) => k !== key))} aria-label="Remove">×</button>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="spm-audit">
                Audit scope:{' '}
                <select className="spm-area" value={area} aria-label="Area scope"
                  onChange={(e) => setArea(e.target.value)}>
                  <option value="">the whole project</option>
                  {areas.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
                {' '}— findings land in the bug tracker; test hardening pushes on <code>auto/audit-&lt;date&gt;</code>.
              </div>
            )}
          </>
        )}

        <input className="spm-note" placeholder="Note (optional — shows on the calendar chip)" value={note}
          aria-label="Note" onChange={(e) => setNote(e.target.value)} />

        {err && <div className="spm-err">{err}</div>}
        <div className="spm-foot">
          <button className="btn-cancel sm" onClick={onClose}>Cancel</button>
          <button className="btn-submit sm" disabled={!slug || busy} onClick={save}>
            {busy ? 'Saving…' : initial ? 'Save plan' : 'Schedule it'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
