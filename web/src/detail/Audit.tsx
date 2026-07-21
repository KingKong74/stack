import { useEffect, useState } from 'react';
import type { Check, CheckMethod, CheckRun } from '../types';
import { getCheckRuns, type CheckInput, type AuditResult } from '../store';

const METHODS: CheckMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

// The composer's working copy of a check — strings throughout, snake_cased on save.
type Draft = {
  method: CheckMethod; name: string; url: string; expect: string;
  reqBody: string; contains: string; jsonPath: string; jsonExpect: string; semantic: string;
};
const EMPTY_DRAFT: Draft = {
  method: 'GET', name: '', url: '', expect: '200',
  reqBody: '', contains: '', jsonPath: '', jsonExpect: '', semantic: '',
};
const toDraft = (c: Check): Draft => ({
  method: c.method, name: c.name, url: c.url, expect: String(c.expectStatus),
  reqBody: c.reqBody, contains: c.contains, jsonPath: c.jsonPath, jsonExpect: c.jsonExpect, semantic: c.semantic,
});

// Derive which assertion tab is active from a populated draft (for edit open-with state).
type AssertionTab = 'none' | 'contains' | 'json' | 'semantic';
function deriveAssertionTab(d: Draft): AssertionTab {
  if (d.semantic) return 'semantic';
  if (d.jsonPath) return 'json';
  if (d.contains) return 'contains';
  return 'none';
}

// ---- the dashboard header: health at a glance + the run-history trend ----

function fmtMs(ms: number | null) {
  if (ms == null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function AuditDashboard({ checks, runs, busy, onRun }: {
  checks: Check[]; runs: CheckRun[]; busy: boolean; onRun: () => void;
}) {
  const passing = checks.filter((c) => c.lastStatus === 'pass').length;
  const failing = checks.filter((c) => c.lastStatus === 'fail').length;
  const never = checks.length - passing - failing;
  const run = passing + failing;
  const passRate = run ? Math.round((passing / run) * 100) : null;
  const latencies = checks.flatMap((c) => (c.lastStatus && c.lastMs != null ? [c.lastMs] : []));
  const avgMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
  const lastRun = runs[0];

  // The trend strip renders full Run-alls oldest → newest; run-ones would read
  // as false dips (1/1 bars), so they stay out of the trend.
  const trend = runs.filter((r) => r.scope === 'all').slice(0, 30).reverse();

  const tone = passRate === null ? 'quiet' : failing > 0 ? 'bad' : never > 0 ? 'part' : 'good';

  return (
    <div className="adash">
      <div className={`adash-health ${tone}`}>
        <div className="n">{passRate === null ? '—' : `${passRate}%`}</div>
        <div className="l">{passRate === null ? 'not yet run' : 'of tests passing'}</div>
      </div>
      <div className="adash-tiles">
        <div className="adash-tile"><div className="n">{checks.length}</div><div className="l">tests</div></div>
        <div className="adash-tile good"><div className="n">{passing}</div><div className="l">passing</div></div>
        <div className={`adash-tile ${failing ? 'bad' : ''}`}><div className="n">{failing}</div><div className="l">failing</div></div>
        <div className="adash-tile"><div className="n">{never}</div><div className="l">never run</div></div>
        <div className="adash-tile"><div className="n">{fmtMs(avgMs)}</div><div className="l">avg response</div></div>
        <div className="adash-tile"><div className="n">{lastRun ? lastRun.when : '—'}</div><div className="l">last run</div></div>
      </div>
      <div className="adash-side">
        {trend.length > 0 && (
          <div className="adash-trend" title="Run history — each bar is one Run all">
            {trend.map((r) => (
              <div key={r.id} className={`adash-bar ${r.failed ? 'bad' : 'good'}`}
                title={`${r.passed}/${r.total} passed · ${r.when} · ${fmtMs(r.durationMs)}`}>
                <div className="fill" style={{ height: `${r.total ? Math.max(8, Math.round((r.passed / r.total) * 100)) : 8}%` }} />
              </div>
            ))}
          </div>
        )}
        {checks.length > 0 && (
          <button className="btn-repo checks-run" disabled={busy} onClick={onRun}>
            {busy ? 'Running…' : '▸ Run all'}
          </button>
        )}
      </div>
    </div>
  );
}

// The failing-now callout: every red test with its error, front and centre,
// each one a click from a filed bug. Gone entirely while everything's green.
function FailingNow({ checks, busy, onRun, onFileBug }: {
  checks: Check[]; busy: boolean; onRun: (id: number) => void; onFileBug: (c: Check) => void;
}) {
  const failing = checks.filter((c) => c.lastStatus === 'fail');
  if (!failing.length) return null;
  return (
    <div className="adash-failing">
      <div className="adash-failing-head">
        {failing.length} test{failing.length === 1 ? '' : 's'} failing
      </div>
      {failing.map((c) => (
        <div className="adash-fail-row" key={c.id}>
          <span className="check-dot fail" />
          <span className="check-name">{c.name}</span>
          <span className="adash-fail-error">{c.lastError || `HTTP ${c.lastCode}`}</span>
          <span className="check-actions">
            <button className="check-tobug" onClick={() => onFileBug(c)} title="File this failure as a bug">→ Bug</button>
            <button className="check-runone" disabled={busy} onClick={() => onRun(c.id)} title="Re-run this test">▸</button>
          </span>
        </div>
      ))}
    </div>
  );
}

// The test suite (#143, named by #145): HTTP tests against the project's live
// application — plain probes and function tests (method + body against an
// endpoint) with assertions on status, a body keyword, a JSON-path value or a
// Gemini-judged expectation. Run all (or one) with a click; ✎ edits in place.
// #173: optional assertions sit behind a compact tab affordance.
function TestsPanel({
  checks, siteUrl, busy, onRun, onAdd, onEdit, onDelete, onFileBug,
}: {
  checks: Check[]; siteUrl: string; busy: boolean;
  onRun: (id?: number) => void;
  onAdd: (input: CheckInput) => void;
  onEdit: (id: number, patch: Partial<CheckInput>) => void;
  onDelete: (id: number) => void;
  onFileBug: (c: Check) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [d, setD] = useState<Draft>(EMPTY_DRAFT);
  const [assertTab, setAssertTab] = useState<AssertionTab>('none');
  const set = (patch: Partial<Draft>) => setD((prev) => ({ ...prev, ...patch }));

  const close = () => { setOpen(false); setEditingId(null); setD(EMPTY_DRAFT); setAssertTab('none'); };
  const startAdd = () => { setD(EMPTY_DRAFT); setEditingId(null); setAssertTab('none'); setOpen(true); };
  const startEdit = (c: Check) => {
    const draft = toDraft(c);
    setD(draft);
    setAssertTab(deriveAssertionTab(draft));
    setEditingId(c.id);
    setOpen(true);
  };

  // When switching assertion tabs, clear stale assertion fields so the save is clean.
  const switchAssertTab = (tab: AssertionTab) => {
    setAssertTab(tab);
    if (tab !== 'contains') set({ contains: '' });
    if (tab !== 'json') set({ jsonPath: '', jsonExpect: '' });
    if (tab !== 'semantic') set({ semantic: '' });
  };

  const save = () => {
    if (!d.name.trim() || !/^https?:\/\//i.test(d.url.trim())) return;
    // Every field goes on the wire — '' clears on edit, the server nulls empties.
    const input: CheckInput = {
      name: d.name.trim(), url: d.url.trim(), method: d.method,
      expect_status: Number(d.expect) || 200,
      req_body: d.reqBody.trim(), contains: d.contains.trim(),
      json_path: d.jsonPath.trim(), json_expect: d.jsonExpect.trim(),
      semantic: d.semantic.trim(),
    };
    if (editingId !== null) onEdit(editingId, input); else onAdd(input);
    close();
  };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') save(); else if (e.key === 'Escape') close();
  };

  const hasBody = d.method !== 'GET' && d.method !== 'HEAD';

  const ASSERT_TABS: { key: AssertionTab; label: string }[] = [
    { key: 'none', label: '+ assertion' },
    { key: 'contains', label: 'Body keyword' },
    { key: 'json', label: 'JSON path' },
    { key: 'semantic', label: '✧ Semantic' },
  ];

  return (
    <div className="checks">
      <div className="checks-head">
        <div className="left">
          <span className="checks-title">Tests</span>
          <span className="checks-sub">
            {checks.length
              ? `${checks.length} test${checks.length === 1 ? '' : 's'} against the live app`
              : 'test the live app — pages up, functions answering, responses saying the right thing'}
          </span>
        </div>
        <div className="checks-actions">
          {!open && checks.length === 0 && siteUrl && (
            <button className="checks-quick" onClick={() => onAdd({ name: 'Site up', url: siteUrl })}>
              + Site up
            </button>
          )}
          {!open && <button className="checks-quick" onClick={startAdd}>+ Add test</button>}
        </div>
      </div>

      {open && (
        <div className="check-composer">
          {/* Row 1: always-on fields */}
          <div className="check-composer-row">
            <select className="field-input sm code check-method-pick" value={d.method}
              onChange={(e) => set({ method: e.target.value as CheckMethod })} title="HTTP method">
              {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <input className="field-input sm" autoFocus placeholder="Name — e.g. Login endpoint"
              value={d.name} onChange={(e) => set({ name: e.target.value })} onKeyDown={keys} />
            <input className="field-input sm grow" placeholder="https://…"
              value={d.url} onChange={(e) => set({ url: e.target.value })} onKeyDown={keys} />
            <input className="field-input sm code" placeholder="200" value={d.expect}
              onChange={(e) => set({ expect: e.target.value })} title="Expected HTTP status" onKeyDown={keys} />
          </div>

          {/* Request body — only for methods that carry a payload */}
          {hasBody && (
            <textarea className="field-input sm check-body" rows={3}
              placeholder='Request body (optional) — JSON is sent as application/json, e.g. {"email": "test@example.com"}'
              value={d.reqBody} onChange={(e) => set({ reqBody: e.target.value })}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); }
                else if (e.key === 'Escape') { e.preventDefault(); close(); }
              }} />
          )}

          {/* Assertion type selector + conditional fields */}
          <div className="check-assert-row">
            <div className="check-assert-tabs">
              {ASSERT_TABS.map(({ key, label }) => (
                <button
                  key={key}
                  className={`check-assert-tab${assertTab === key ? ' on' : ''}${key === 'none' && assertTab === 'none' ? ' placeholder' : ''}`}
                  onClick={() => switchAssertTab(assertTab === key && key !== 'none' ? 'none' : key)}
                  title={key === 'none' ? 'Add an optional assertion' : undefined}
                >
                  {key === 'none' && assertTab !== 'none' ? '× assertion' : label}
                </button>
              ))}
            </div>

            {assertTab === 'contains' && (
              <input className="field-input sm grow" autoFocus
                placeholder="Response body must contain this text"
                value={d.contains} onChange={(e) => set({ contains: e.target.value })} onKeyDown={keys}
                title="Fail unless the response body contains this text" />
            )}
            {assertTab === 'json' && (
              <>
                <input className="field-input sm code" autoFocus
                  placeholder="$.path.to.field"
                  value={d.jsonPath} onChange={(e) => set({ jsonPath: e.target.value })} onKeyDown={keys}
                  title="A dot path into the JSON response — fails if missing" />
                <input className="field-input sm" placeholder="expected value (optional)"
                  value={d.jsonExpect} onChange={(e) => set({ jsonExpect: e.target.value })} onKeyDown={keys}
                  title="What that path should equal (leave empty to only require it exists)" />
              </>
            )}
            {assertTab === 'semantic' && (
              <input className="field-input sm grow" autoFocus
                placeholder="e.g. shows the dashboard, no error banners"
                value={d.semantic} onChange={(e) => set({ semantic: e.target.value })} onKeyDown={keys}
                title="A plain-language expectation — Gemini judges the response against it" />
            )}
          </div>

          <div className="check-composer-row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn-submit sm" onClick={save}>{editingId !== null ? 'Save' : 'Add'}</button>
            <button className="btn-cancel sm" onClick={close}>Cancel</button>
          </div>
        </div>
      )}

      {checks.length > 0 && (
        <div className="check-rows">
          {checks.map((c) => (
            <div className={`check-row ${c.lastStatus}`} key={c.id}>
              <span className={`check-dot ${c.lastStatus || 'never'}`} />
              <span className={`check-method ${c.method === 'GET' ? '' : 'fn'}`}>{c.method}</span>
              <span className="check-name">{c.name}</span>
              <span className="check-url">{c.url}</span>
              {c.contains && <span className="check-contains" title="Body must contain this text">"{c.contains}"</span>}
              {c.jsonPath && (
                <span className="check-contains" title="JSON-path assertion on the response">
                  {c.jsonPath}{c.jsonExpect ? ` = ${c.jsonExpect}` : ''}
                </span>
              )}
              {c.semantic && <span className="check-contains" title="Gemini judges the response against this expectation">✧ {c.semantic}</span>}
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
                <button className="check-runone" disabled={busy} onClick={() => onRun(c.id)} title="Run this test">▸</button>
                <button className="check-runone" onClick={() => startEdit(c)} aria-label="Edit test" title="Edit">✎</button>
                <button className="check-x" onClick={() => onDelete(c.id)} aria-label="Delete test" title="Delete">×</button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The automated bug audit (#144). ✧ Run audit: Gemini reads the owner's audit
// brief, the check results and the live page, and files suspected bugs straight
// into the review inbox — keep or dismiss them there. The brief is how you tell
// it what to look for. ⧉ Claude prompt copies a deeper investigation prompt to
// paste into a Claude session (the terminal's Claude mode) for the specific,
// hands-on inquiries Gemini can't do from outside.
function BugAuditPanel({
  auditContext, onSaveBrief, busy, result, error, onRun, claudeCopy, onCopyClaude,
}: {
  auditContext: string; onSaveBrief: (text: string) => void;
  busy: boolean; result: AuditResult | null; error: string; onRun: () => void;
  claudeCopy: 'idle' | 'busy' | 'copied' | 'failed'; onCopyClaude: () => void;
}) {
  const [briefOpen, setBriefOpen] = useState(false);
  const [draft, setDraft] = useState(auditContext);

  const claudeLabel = claudeCopy === 'busy' ? 'Composing…'
    : claudeCopy === 'copied' ? '✓ Copied' : claudeCopy === 'failed' ? 'Copy failed' : '⧉ Claude prompt';

  return (
    <div className="checks audit">
      <div className="checks-head">
        <div className="left">
          <span className="checks-title">✧ Bug audit</span>
          <span className="checks-sub">
            {result
              ? `${result.logged} logged to the review inbox${result.skipped ? ` · ${result.skipped} already known` : ''}`
              : 'Gemini reads the brief, the tests and the live page — suspected bugs land in the review inbox'}
          </span>
        </div>
        <div className="checks-actions">
          <button className="checks-quick" onClick={() => { setDraft(auditContext); setBriefOpen(!briefOpen); }}>
            {briefOpen ? 'Close brief' : auditContext ? '✎ Audit brief' : '+ Audit brief'}
          </button>
          <button className="checks-quick" disabled={claudeCopy === 'busy'} onClick={onCopyClaude}
            title="Copy a deep-audit prompt for a Claude session — for the specific investigation Gemini can't do">
            {claudeLabel}
          </button>
          <button className="btn-repo checks-run" disabled={busy} onClick={onRun}>
            {busy ? 'Auditing…' : '✧ Run audit'}
          </button>
        </div>
      </div>

      {briefOpen && (
        <div className="audit-brief">
          <textarea className="field-input sm audit-brief-text" rows={3} autoFocus
            placeholder="What should the auditor look for? The flows that matter, known trouble spots, what to ignore…"
            value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onSaveBrief(draft.trim()); setBriefOpen(false); }
              else if (e.key === 'Escape') { e.preventDefault(); setBriefOpen(false); }
            }} />
          <div className="audit-brief-actions">
            <button className="btn-submit sm" disabled={draft.trim() === auditContext}
              onClick={() => { onSaveBrief(draft.trim()); setBriefOpen(false); }}>Save brief</button>
            <button className="btn-cancel sm" onClick={() => setBriefOpen(false)}>Cancel</button>
          </div>
        </div>
      )}

      {error && <div className="audit-note error">{error}</div>}
      {result && !result.findings.length && (
        <div className="audit-note">Audit came back clean — nothing worth logging.</div>
      )}
      {result && result.findings.length > 0 && (
        <div className="check-rows">
          {result.findings.map((f, i) => (
            <div className="check-row audit-finding" key={i}>
              <span className={`sev-pill ${f.severity}`}>{f.severity}</span>
              <span className="check-name">{f.title}</span>
              {f.evidence && <span className="check-url">{f.evidence}</span>}
              <span className="audit-outcome">
                {f.outcome === 'logged' ? `→ ${f.bug?.id} · review inbox`
                  : f.outcome === 'duplicate' ? 'already tracked' : 'previously dismissed'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The Audit tab: the testing-and-audit dashboard for the project's live app.
// Health header + run-history trend over the failing-now callout, the test
// suite, and the Gemini bug audit. Run history is this tab's own fetch (the
// detail payload stays lean); it refreshes whenever a run settles.
export function Audit({
  slug, checks, siteUrl, checksBusy, onRunChecks, onAddCheck, onEditCheck, onDeleteCheck, onCheckToBug,
  auditContext, onSaveAuditContext, auditBusy, auditResult, auditError, onRunAudit,
  claudeCopy, onCopyClaudePrompt,
}: {
  slug: string;
  checks: Check[]; siteUrl: string; checksBusy: boolean;
  onRunChecks: (id?: number) => void;
  onAddCheck: (input: CheckInput) => void;
  onEditCheck: (id: number, patch: Partial<CheckInput>) => void;
  onDeleteCheck: (id: number) => void;
  onCheckToBug: (c: Check) => void;
  auditContext: string; onSaveAuditContext: (text: string) => void;
  auditBusy: boolean; auditResult: AuditResult | null; auditError: string;
  onRunAudit: () => void;
  claudeCopy: 'idle' | 'busy' | 'copied' | 'failed'; onCopyClaudePrompt: () => void;
}) {
  const [runs, setRuns] = useState<CheckRun[]>([]);

  // Fetch on mount and again whenever a run (or the check-rerunning audit)
  // settles; a history miss is quietly an empty trend, never an error.
  useEffect(() => {
    if (checksBusy || auditBusy) return;
    let live = true;
    getCheckRuns(slug).then((r) => { if (live) setRuns(r); }).catch(() => {});
    return () => { live = false; };
  }, [slug, checksBusy, auditBusy]);

  return (
    <div>
      <AuditDashboard checks={checks} runs={runs} busy={checksBusy} onRun={() => onRunChecks()} />
      <FailingNow checks={checks} busy={checksBusy} onRun={(id) => onRunChecks(id)} onFileBug={onCheckToBug} />
      <TestsPanel checks={checks} siteUrl={siteUrl} busy={checksBusy}
        onRun={onRunChecks} onAdd={onAddCheck} onEdit={onEditCheck} onDelete={onDeleteCheck} onFileBug={onCheckToBug} />
      <BugAuditPanel auditContext={auditContext} onSaveBrief={onSaveAuditContext}
        busy={auditBusy} result={auditResult} error={auditError} onRun={onRunAudit}
        claudeCopy={claudeCopy} onCopyClaude={onCopyClaudePrompt} />
    </div>
  );
}
