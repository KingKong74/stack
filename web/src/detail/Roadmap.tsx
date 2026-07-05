import { useState } from 'react';
import type { Roadmap as RoadmapData, RoadmapItem, Priority } from '../types';
import type { IntakeSuggestion } from '../store';
import { PRIORITY_META } from '../lib/ui';

export type ReviewTag = 'solid' | 'needs-work' | 'rethink';
export const REVIEW_TAGS: { key: ReviewTag; label: string }[] = [
  { key: 'solid', label: 'Solid' },
  { key: 'needs-work', label: 'Needs more work' },
  { key: 'rethink', label: 'Rethink' },
];
const tagLabel = (tag: string) => REVIEW_TAGS.find((t) => t.key === tag)?.label || tag;

// MoSCoW roadmap. Open items live in their bucket columns (with lane-claim
// chips and edit/delete on hover); completed items move to the collapsed
// Archive below — still counted by the progress model, reviewable with a
// verdict tag (needs-work/rethink offer a follow-up item), restorable by
// un-ticking.
export function Roadmap({
  roadmap, onAdd, onToggle, onEdit, onDelete, onReviewTag, onToggleSkip, highlightId,
  draft, onResumeDraft, onDiscardDraft, onSortIntake, onApplyIntake,
}: {
  roadmap: RoadmapData;
  onAdd: (p: Priority) => void;
  onToggle: (item: RoadmapItem) => void;
  onEdit: (item: RoadmapItem) => void;
  onDelete: (item: RoadmapItem) => void;
  onReviewTag: (item: RoadmapItem, tag: ReviewTag) => void;
  onToggleSkip: (item: RoadmapItem) => void;
  highlightId?: string | null;
  draft?: { title: string } | null;
  onResumeDraft?: () => void;
  onDiscardDraft?: () => void;
  onSortIntake?: (text: string) => Promise<IntakeSuggestion[]>;
  onApplyIntake?: (items: IntakeSuggestion[]) => Promise<void>;
}) {
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  const [intakeOpen, setIntakeOpen] = useState(false);
  // Done items split into the pipeline: To verify (no verdict yet — test it,
  // verdict it, or send it back) → Archive (verdict given). Latest first.
  const ts = (it: RoadmapItem) => (it.updatedAt ? Date.parse(it.updatedAt) : 0);
  const doneItems = PRIORITY_META.flatMap((col) => roadmap[col.key].filter((it) => it.done));
  const toVerify = doneItems.filter((it) => !it.reviewTag).sort((a, b) => ts(b) - ts(a));
  const archived = doneItems.filter((it) => it.reviewTag).sort((a, b) => ts(b) - ts(a));
  // Open the archive straight away when a deep-link targets an archived item.
  const [archiveOpen, setArchiveOpen] = useState(
    () => archived.some((it) => String(it.id) === highlightId));
  // Archive rendering: the MoSCoW grid, or a dense paginated list + verdict filter.
  const [archView, setArchView] = useState<'grid' | 'list'>('grid');
  const [archFilter, setArchFilter] = useState<'all' | ReviewTag>('all');
  const [archPage, setArchPage] = useState(0);
  const filtered = archived.filter((it) => archFilter === 'all' || it.reviewTag === archFilter);
  const ARCH_PAGE_SIZE = 12;
  const archPages = Math.max(1, Math.ceil(filtered.length / ARCH_PAGE_SIZE));
  const archSlice = filtered.slice(archPage * ARCH_PAGE_SIZE, (archPage + 1) * ARCH_PAGE_SIZE);

  // Verdict picker + restore/delete controls, shared by both archive views.
  const archActions = (it: RoadmapItem) => (
    pickerFor === it.id ? (
      <div className="review-pick">
        {REVIEW_TAGS.map((t) => (
          <button key={t.key} className={`review-pick-opt ${t.key}`}
            onClick={() => { setPickerFor(null); onReviewTag(it, t.key); }}>
            {t.label}
          </button>
        ))}
      </div>
    ) : (
      <div className="road-actions arch">
        {it.reviewTag ? (
          <button className={`review-verdict ${it.reviewTag}`} onClick={() => setPickerFor(it.id)}
            title="Change the verdict">{tagLabel(it.reviewTag)}</button>
        ) : (
          <button className="review-verdict none" onClick={() => setPickerFor(it.id)}
            title="Review this completed item">Review</button>
        )}
        <button onClick={() => onDelete(it)} aria-label="Delete item" title="Delete">×</button>
      </div>
    )
  );

  return (
    <div>
      <div className="section-bar" style={{ marginBottom: 6 }}>
        <div className="titles">
          <div className="h">Roadmap</div>
          <div className="subtitle">MoSCoW prioritisation</div>
        </div>
        <div className="bar-actions">
          {draft && (
            <>
              <button className="draft-chip" onClick={onResumeDraft} title="Resume the unfinished item">
                ✎ Draft · {draft.title.trim() || 'untitled'}
              </button>
              <button className="draft-x" onClick={onDiscardDraft} aria-label="Discard draft" title="Discard draft">×</button>
            </>
          )}
          {onSortIntake && onApplyIntake && !intakeOpen && (
            <button className="gemini-btn" onClick={() => setIntakeOpen(true)}
              title="Dump loose ideas — Gemini proposes where each belongs">✧ Intake</button>
          )}
        </div>
      </div>
      <div className="subtitle" style={{ marginBottom: 20 }}>
        What must ship, what should, what could, and what won't — this round. Tick items off as you go;
        the dashboard progress is computed from Must/Should completion.
      </div>

      {intakeOpen && onSortIntake && onApplyIntake && (
        <IntakePanel onSort={onSortIntake} onApply={onApplyIntake} onClose={() => setIntakeOpen(false)} />
      )}

      <div className="road-grid">
        {PRIORITY_META.map((col) => {
          const open = roadmap[col.key].filter((it) => !it.done);
          // Parked items sink to the bottom of their bucket.
          const items = [...open.filter((it) => !it.skipped), ...open.filter((it) => it.skipped)];
          return (
            <div className="road-col" key={col.key}>
              <div className="road-col-head">
                <span className="dot" style={{ background: col.color }} />
                <span className="name">{col.label}</span>
                <span className="count">{items.length}</span>
              </div>
              <div className="road-items">
                {items.map((it) => (
                  <div className={`road-item ${it.skipped ? 'skipped' : ''} ${highlightId === String(it.id) ? 'hl' : ''}`} key={it.id} data-hl={it.id}>
                    <button
                      className="road-check"
                      onClick={() => onToggle(it)}
                      aria-label="Mark done" title="Mark done — moves to the archive"
                    />
                    <div className="road-body">
                      <div className="t">
                        {it.title}
                        {it.source === 'hook' && <span className="auto-cue" title="Auto-extracted from a push">auto</span>}
                        {it.skipped && <span className="skip-chip" title="Parked — not to be picked up yet">⏸ parked</span>}
                      </div>
                      {it.note && <div className="note">{it.note}</div>}
                      {it.claimedBy && <div className="claim-chip" title="Claimed by this lane">⚑ {it.claimedBy}</div>}
                    </div>
                    <div className="road-actions">
                      <button onClick={() => onToggleSkip(it)} aria-label={it.skipped ? 'Unpark item' : 'Park item'}
                        title={it.skipped ? 'Unpark — back in play' : 'Park — skip for now'}>{it.skipped ? '▶' : '⏸'}</button>
                      <button onClick={() => onEdit(it)} aria-label="Edit item" title="Edit">✎</button>
                      <button onClick={() => onDelete(it)} aria-label="Delete item" title="Delete">×</button>
                    </div>
                  </div>
                ))}
                <button className="road-add" onClick={() => onAdd(col.key)}>+ Add</button>
              </div>
            </div>
          );
        })}
      </div>

      {/* to verify — completed but unverdicted: test it, verdict it, or send it back */}
      {toVerify.length > 0 && (
        <div className="verify-strip">
          <div className="verify-head">
            <span className="verify-title">To verify</span>
            <span className="verify-sub">
              {toVerify.length} completed — test each, give a verdict, or send it back to the board
            </span>
          </div>
          {toVerify.map((it) => (
            <div className="verify-row" key={it.id} data-hl={it.id}>
              <span className="arch-list-bucket">{PRIORITY_META.find((p) => p.key === it.bucket)?.short}</span>
              <div className="verify-body">
                <div className="t">
                  {it.title}
                  {it.claimedBy && <span className="claim-chip inline" title="Done by this lane">⚑ {it.claimedBy}</span>}
                </div>
                {it.note && <div className="note">{it.note}</div>}
              </div>
              <button className="verify-back" onClick={() => onToggle(it)}
                title="Didn't hold up — send it back to the board">↩ Board</button>
              {archActions(it)}
            </div>
          ))}
        </div>
      )}

      {/* archive — verdict-given items, out of the way but recoverable */}
      {archived.length > 0 && (
        <div className="road-archive">
          <div className="road-archive-bar">
            <button className="road-archive-head" onClick={() => setArchiveOpen((o) => !o)}
              aria-expanded={archiveOpen}>
              <span className="chev">{archiveOpen ? '▾' : '▸'}</span>
              Archive <span className="count">{filtered.length}</span>
              <span className="hint">reviewed items, latest first — still count toward progress</span>
            </button>
            {archiveOpen && (
              <div className="arch-controls">
                <div className="chips">
                  {([
                    { key: 'all', label: 'All', n: archived.length },
                    ...REVIEW_TAGS.map((t) => ({
                      key: t.key as 'all' | ReviewTag, label: t.label,
                      n: archived.filter((it) => it.reviewTag === t.key).length,
                    })),
                  ] as { key: 'all' | ReviewTag; label: string; n: number }[]).map((c) => (
                    <button key={c.key} className={`chip-sm ${archFilter === c.key ? 'on' : ''}`}
                      onClick={() => { setArchFilter(c.key); setArchPage(0); }}>
                      {c.label} {c.n}
                    </button>
                  ))}
                </div>
                <div className="seg-control sm" role="tablist" aria-label="Archive view">
                  <button role="tab" aria-selected={archView === 'grid'}
                    className={`seg-opt ${archView === 'grid' ? 'on' : ''}`} onClick={() => setArchView('grid')}>Buckets</button>
                  <button role="tab" aria-selected={archView === 'list'}
                    className={`seg-opt ${archView === 'list' ? 'on' : ''}`} onClick={() => setArchView('list')}>List</button>
                </div>
              </div>
            )}
          </div>
          {archiveOpen && archView === 'grid' && (
            <div className="road-grid arch">
              {PRIORITY_META.map((col) => {
                const items = filtered.filter((it) => it.bucket === col.key);
                return (
                  <div className="road-col" key={col.key}>
                    <div className="road-col-head">
                      <span className="dot" style={{ background: col.color }} />
                      <span className="name">{col.label}</span>
                      <span className="count">{items.length}</span>
                    </div>
                    <div className="road-items">
                      {items.map((it) => (
                        <div className="road-item done" key={it.id} data-hl={it.id}>
                          <button className="road-check on" onClick={() => onToggle(it)}
                            aria-label="Mark not done" title="Restore to the roadmap">✓</button>
                          <div className="road-body">
                            <div className="t">
                              {it.title}
                              {it.source === 'hook' && <span className="auto-cue" title="Auto-extracted from a push">auto</span>}
                              {it.claimedBy && <span className="claim-chip inline" title="Done by this lane">⚑ {it.claimedBy}</span>}
                            </div>
                            {it.note && <div className="note">{it.note}</div>}
                            {archActions(it)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {archiveOpen && archView === 'list' && (
            <div className="arch-list">
              {archSlice.map((it) => (
                <div className="arch-list-row" key={it.id} data-hl={it.id}>
                  <button className="road-check on sm" onClick={() => onToggle(it)}
                    aria-label="Mark not done" title="Restore to the roadmap">✓</button>
                  <span className="arch-list-bucket">{PRIORITY_META.find((p) => p.key === it.bucket)?.short}</span>
                  <span className="arch-list-text">
                    <span className="arch-list-title">{it.title}</span>
                    {it.note && <span className="arch-list-note">{it.note}</span>}
                  </span>
                  {archActions(it)}
                </div>
              ))}
              {archPages > 1 && (
                <div className="arch-pager">
                  <button disabled={archPage === 0} onClick={() => setArchPage((p) => p - 1)}>‹</button>
                  <span>{archPage * ARCH_PAGE_SIZE + 1}–{Math.min((archPage + 1) * ARCH_PAGE_SIZE, filtered.length)} of {filtered.length}</span>
                  <button disabled={archPage >= archPages - 1} onClick={() => setArchPage((p) => p + 1)}>›</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// The idea intake: dump loose lines, Gemini proposes a destination for each
// (a MoSCoW bucket for startable work, Futures + alignment for what-ifs), and
// nothing is created until the human reviews — every destination is overridable
// per row, rows can be binned, and Apply creates the survivors through the
// normal CRUD paths.
const INTAKE_DESTS: { key: IntakeSuggestion['dest']; label: string }[] = [
  { key: 'must', label: 'Must' }, { key: 'should', label: 'Should' },
  { key: 'could', label: 'Could' }, { key: 'wont', label: "Won't" },
  { key: 'future', label: '✧ Future' },
];

function IntakePanel({
  onSort, onApply, onClose,
}: {
  onSort: (text: string) => Promise<IntakeSuggestion[]>;
  onApply: (items: IntakeSuggestion[]) => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'idle' | 'sorting' | 'applying'>('idle');
  const [items, setItems] = useState<IntakeSuggestion[] | null>(null);
  const [error, setError] = useState('');

  const sort = async () => {
    if (!text.trim() || busy !== 'idle') return;
    setBusy('sorting');
    setError('');
    try {
      setItems(await onSort(text));
    } catch (e) {
      setError((e as Error)?.message || 'Sorting failed.');
    } finally {
      setBusy('idle');
    }
  };

  const apply = async () => {
    if (!items?.length || busy !== 'idle') return;
    setBusy('applying');
    setError('');
    try {
      await onApply(items);
      setText('');
      setItems(null);
      onClose();
    } catch (e) {
      setError((e as Error)?.message || 'Could not add the items.');
      setBusy('idle');
      return;
    }
    setBusy('idle');
  };

  const setDest = (i: number, dest: IntakeSuggestion['dest']) =>
    setItems((cur) => cur!.map((it, j) => (j === i ? { ...it, dest, alignment: dest === 'future' ? it.alignment : null } : it)));
  const drop = (i: number) => setItems((cur) => cur!.filter((_, j) => j !== i));

  return (
    <div className="intake">
      {!items ? (
        <>
          <div className="intake-head">
            <span className="intake-title">✧ Intake</span>
            <span className="intake-sub">
              Smash everything in — one idea per line (or just paragraphs). Gemini proposes where
              each belongs; you review before anything lands.
            </span>
          </div>
          <textarea className="field-area intake-area" autoFocus value={text}
            placeholder={'dark mode for the settings page\nsome kind of export to CSV??\nmaybe this becomes a whole plugin system one day…'}
            onChange={(e) => setText(e.target.value)} />
          {error && <div className="gemini-suggest err">✧ {error}</div>}
          <div className="intake-actions">
            <button className="btn-cancel sm" onClick={onClose}>Close</button>
            <button className="btn-submit sm" onClick={sort} disabled={!text.trim() || busy !== 'idle'}>
              {busy === 'sorting' ? '✧ Sorting…' : '✧ Sort with Gemini'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="intake-head">
            <span className="intake-title">✧ Proposed sorting</span>
            <span className="intake-sub">Override any destination, bin what's wrong, then apply.</span>
          </div>
          <div className="intake-rows">
            {items.map((it, i) => (
              <div className="intake-row" key={i}>
                <div className="intake-body">
                  <div className="t">{it.title}</div>
                  {it.note && <div className="note">{it.note}</div>}
                  {it.why && (
                    <div className="why">
                      ✧ {it.why}
                      {it.dest === 'future' && it.alignment ? ` · suggested ${it.alignment}` : ''}
                    </div>
                  )}
                </div>
                <div className="seg-control sm" role="tablist" aria-label="Destination">
                  {INTAKE_DESTS.map((d) => (
                    <button key={d.key} role="tab" aria-selected={it.dest === d.key}
                      className={`seg-opt ${it.dest === d.key ? 'on' : ''}`}
                      onClick={() => setDest(i, d.key)}>{d.label}</button>
                  ))}
                </div>
                <button className="draft-x" onClick={() => drop(i)} aria-label="Bin this one" title="Bin">×</button>
              </div>
            ))}
          </div>
          {error && <div className="gemini-suggest err">✧ {error}</div>}
          <div className="intake-actions">
            <button className="btn-cancel sm" onClick={() => setItems(null)}>← Back</button>
            <button className="btn-submit sm" onClick={apply} disabled={!items.length || busy !== 'idle'}>
              {busy === 'applying' ? 'Adding…' : `Add ${items.length} item${items.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
