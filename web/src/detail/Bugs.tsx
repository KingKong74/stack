import { useState, useRef } from 'react';
import type { Bug, BugStatus, Severity } from '../types';
import { STATUS_LABEL } from '../lib/ui';

type BugFilter = 'all' | 'open' | 'fixing' | 'fixed';

const matches = (b: Bug, f: BugFilter) =>
  f === 'all' ? true : f === 'open' ? (b.status === 'open' || b.status === 'investigating') : b.status === f;

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];
const BUG_STATUSES: BugStatus[] = ['open', 'investigating', 'fixing', 'fixed'];

// #161: Quick-add bug composer — one-line inline composer, Enter to file.
// Sits above the bug list, lower friction for jotting failures noticed while auditing.
function QuickBugComposer({ onAdd }: { onAdd: (title: string, severity: Severity) => void }) {
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState<Severity>('medium');
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    onAdd(t, severity);
    setTitle('');
    setSeverity('medium');
    inputRef.current?.focus();
  };

  return (
    <div className="bug-quick-add">
      <input
        ref={inputRef}
        className="field-input sm grow"
        placeholder="Quick-add a bug…"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
      />
      <div className="bug-quick-sevs">
        {SEVERITIES.map((s) => (
          <button
            key={s}
            className={`bug-quick-sev ${s}${severity === s ? ' on' : ''}`}
            onClick={() => setSeverity(s)}
            title={s}
          >{s[0].toUpperCase()}</button>
        ))}
      </div>
      <button className="btn-submit sm" onClick={submit} disabled={!title.trim()}>File</button>
    </div>
  );
}

export function Bugs({
  bugs, filter, setFilter, onReport, onOpenLink, highlightId, onSetStatus, onDelete, onQuickAddBug,
}: {
  bugs: Bug[]; filter: BugFilter; setFilter: (f: BugFilter) => void;
  onReport: () => void; onOpenLink: (hash: string) => void; highlightId?: string | null;
  onSetStatus: (bug: Bug, status: BugStatus) => void;
  onDelete: (bug: Bug) => void;
  onQuickAddBug: (title: string, severity: Severity) => void;
}) {
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const counts = {
    all: bugs.length,
    open: bugs.filter((b) => b.status === 'open' || b.status === 'investigating').length,
    fixing: bugs.filter((b) => b.status === 'fixing').length,
    fixed: bugs.filter((b) => b.status === 'fixed').length,
  };
  const openCount = bugs.filter((b) => b.status !== 'fixed').length;
  const chips: { key: BugFilter; label: string }[] = [
    { key: 'all', label: 'All' }, { key: 'open', label: 'Open' },
    { key: 'fixing', label: 'Fixing' }, { key: 'fixed', label: 'Fixed' },
  ];
  const visible = bugs.filter((b) => matches(b, filter));

  return (
    <div>
      <div className="section-bar">
        <div className="titles">
          <div className="h">Bugs</div>
          <div className="subtitle">{openCount} open · {counts.fixing} in progress</div>
        </div>
        <div className="bar-actions">
          {chips.map((c) => (
            <button key={c.key} className={`chip-sm ${filter === c.key ? 'on' : ''}`} onClick={() => setFilter(c.key)}>
              {c.label} {counts[c.key]}
            </button>
          ))}
          <button className="btn-dark" style={{ marginLeft: 4 }} onClick={onReport}>+ Report</button>
        </div>
      </div>

      {/* #161: one-line quick-add composer — Enter to file, severity chips inline */}
      <QuickBugComposer onAdd={onQuickAddBug} />

      {visible.length ? (
        <div className="buglist">
          {visible.map((b) => (
            <div className={`bug ${highlightId === b.id ? 'hl' : ''}`} key={b.id} data-hl={b.id}>
              <div className={`sev-bar ${b.severity}`} />
              <div className="bug-body">
                <div className="bug-main">
                  <div className="bug-title">
                    {b.title}
                    {b.source === 'hook' && <span className="auto-cue" title="Auto-extracted from a push">auto</span>}
                  </div>
                  <div className="bug-meta">
                    <span className="mono">{b.id} · {b.meta}</span>
                    {b.linkRef && (
                      <button className="link-chip" onClick={() => onOpenLink(b.linkRef!)}>↳ {b.linkRef}</button>
                    )}
                  </div>
                </div>
                <span className={`sev-pill ${b.severity}`}>{b.severity}</span>
                {pickerFor === b.id ? (
                  <span className="review-pick">
                    {BUG_STATUSES.map((s) => (
                      <button key={s} className="review-pick-opt"
                        onClick={() => { setPickerFor(null); if (s !== b.status) onSetStatus(b, s); }}>
                        {STATUS_LABEL[s]}
                      </button>
                    ))}
                  </span>
                ) : (
                  <button className={`status-pill ${b.status} clickable`} onClick={() => setPickerFor(b.id)}
                    title="Change status">{STATUS_LABEL[b.status as BugStatus]}</button>
                )}
                <span className="bug-quick">
                  {b.status !== 'fixed' && (
                    <button className="bug-resolve" onClick={() => onSetStatus(b, 'fixed')}
                      aria-label="Mark fixed" title="Mark fixed">✓</button>
                  )}
                  <button className="bug-x" onClick={() => onDelete(b)} aria-label="Delete bug" title="Delete">×</button>
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <div className="big">{filter === 'all' ? 'No bugs reported' : `Nothing ${filter}`}</div>
          <div>{filter === 'all' ? 'A clean slate. Report one when something breaks.' : 'Try a different filter.'}</div>
        </div>
      )}
    </div>
  );
}
