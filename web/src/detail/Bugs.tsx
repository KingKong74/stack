import { useState } from 'react';
import type { Bug, BugStatus, Check } from '../types';
import { STATUS_LABEL } from '../lib/ui';

type BugFilter = 'all' | 'open' | 'fixing' | 'fixed';

const matches = (b: Bug, f: BugFilter) =>
  f === 'all' ? true : f === 'open' ? (b.status === 'open' || b.status === 'investigating') : b.status === f;

// The testing panel: HTTP probes against the project's live application.
// Run all (or one) with a click; a failing check offers to file the bug.
function ChecksPanel({
  checks, siteUrl, busy, onRun, onAdd, onDelete, onFileBug,
}: {
  checks: Check[]; siteUrl: string; busy: boolean;
  onRun: (id?: number) => void;
  onAdd: (input: { name: string; url: string; expect_status?: number }) => void;
  onDelete: (id: number) => void;
  onFileBug: (c: Check) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [expect, setExpect] = useState('200');

  const add = () => {
    if (!name.trim() || !/^https?:\/\//i.test(url.trim())) return;
    onAdd({ name: name.trim(), url: url.trim(), expect_status: Number(expect) || 200 });
    setName(''); setUrl(''); setExpect('200');
    setAdding(false);
  };

  const passing = checks.filter((c) => c.lastStatus === 'pass').length;
  const failing = checks.filter((c) => c.lastStatus === 'fail').length;

  return (
    <div className="checks">
      <div className="checks-head">
        <div className="left">
          <span className="checks-title">Checks</span>
          <span className="checks-sub">
            {checks.length
              ? `${passing} passing${failing ? ` · ${failing} failing` : ''}`
              : 'probe the live app — is it up, does it answer'}
          </span>
        </div>
        <div className="checks-actions">
          {!adding && checks.length === 0 && siteUrl && (
            <button className="checks-quick" onClick={() => onAdd({ name: 'Site up', url: siteUrl })}>
              + Site up
            </button>
          )}
          {!adding && <button className="checks-quick" onClick={() => setAdding(true)}>+ Add check</button>}
          {checks.length > 0 && (
            <button className="btn-repo checks-run" disabled={busy} onClick={() => onRun()}>
              {busy ? 'Running…' : '▸ Run all'}
            </button>
          )}
        </div>
      </div>

      {adding && (
        <div className="check-composer">
          <input className="field-input sm" autoFocus placeholder="Name — e.g. API health"
            value={name} onChange={(e) => setName(e.target.value)} />
          <input className="field-input sm grow" placeholder="https://…"
            value={url} onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add(); else if (e.key === 'Escape') setAdding(false); }} />
          <input className="field-input sm code" placeholder="200" value={expect}
            onChange={(e) => setExpect(e.target.value)} title="Expected HTTP status" />
          <button className="btn-submit sm" onClick={add}>Add</button>
          <button className="btn-cancel sm" onClick={() => setAdding(false)}>Cancel</button>
        </div>
      )}

      {checks.length > 0 && (
        <div className="check-rows">
          {checks.map((c) => (
            <div className={`check-row ${c.lastStatus}`} key={c.id}>
              <span className={`check-dot ${c.lastStatus || 'never'}`} />
              <span className="check-name">{c.name}</span>
              <span className="check-url">{c.url}</span>
              <span className="check-result">
                {c.lastStatus
                  ? `${c.lastCode ?? '—'} · ${c.lastMs}ms · ${c.when}`
                  : 'never run'}
              </span>
              {c.lastStatus === 'fail' && c.lastError && <span className="check-error">{c.lastError}</span>}
              <span className="check-actions">
                {c.lastStatus === 'fail' && (
                  <button className="check-tobug" onClick={() => onFileBug(c)} title="File this failure as a bug">→ Bug</button>
                )}
                <button className="check-runone" disabled={busy} onClick={() => onRun(c.id)} title="Run this check">▸</button>
                <button className="check-x" onClick={() => onDelete(c.id)} aria-label="Delete check" title="Delete">×</button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Bugs({
  bugs, filter, setFilter, onReport, onOpenLink, highlightId,
  checks, siteUrl, checksBusy, onRunChecks, onAddCheck, onDeleteCheck, onCheckToBug,
}: {
  bugs: Bug[]; filter: BugFilter; setFilter: (f: BugFilter) => void;
  onReport: () => void; onOpenLink: (hash: string) => void; highlightId?: string | null;
  checks: Check[]; siteUrl: string; checksBusy: boolean;
  onRunChecks: (id?: number) => void;
  onAddCheck: (input: { name: string; url: string; expect_status?: number }) => void;
  onDeleteCheck: (id: number) => void;
  onCheckToBug: (c: Check) => void;
}) {
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
      <ChecksPanel checks={checks} siteUrl={siteUrl} busy={checksBusy}
        onRun={onRunChecks} onAdd={onAddCheck} onDelete={onDeleteCheck} onFileBug={onCheckToBug} />

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
                <span className={`status-pill ${b.status}`}>{STATUS_LABEL[b.status as BugStatus]}</span>
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
