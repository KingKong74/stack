import { useEffect, useMemo, useRef, useState } from 'react';
import type { Bug, BugStatus, Check, CheckHistory, CheckMethod, CheckResult, CheckRun, Severity } from '../types';
import { getCheckHistory, getCheckRuns, agentCan, agentOffReason, type CheckInput, type AuditResult, type TabAgentState } from '../store';
import { STATUS_LABEL } from '../lib/ui';

// The Quality page (#278, design 20b) — Bugs and Audit merged into one card grid.
//
// They were always halves of one loop: run the checks → see what's red → file
// what's real → fix → re-run → close. That loop used to cross a tab boundary
// twice. Here it doesn't: one health verdict over one "Needs you" list that
// mixes red checks with serious bugs, the bug↔check link visible both ways
// (#278's one data change), and the long tails — the whole suite, the run
// ledger — behind two more segments rather than below a long scroll.
//
// Three segments, one page: Now (the dashboard), Suite (every check, with the
// composer), History (the run ledger). Everything either tab could do before is
// still here; nothing needed a second screen.

type Seg = 'now' | 'suite' | 'history';

const METHODS: CheckMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];
const BUG_STATUSES: BugStatus[] = ['open', 'investigating', 'fixing', 'fixed'];

const isOpen = (b: Bug) => b.status !== 'fixed';
const isSerious = (b: Bug) => isOpen(b) && (b.severity === 'critical' || b.severity === 'high');
const SEV_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const bySeverity = (a: Bug, b: Bug) => SEV_RANK[a.severity] - SEV_RANK[b.severity];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function fmtMs(ms: number | null) {
  if (ms == null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

// The failure signature the all-red read compares on: the error text if there is
// one, else the status code. Same signature across every check = one cause.
const failSignature = (c: Check) => (c.lastError || `HTTP ${c.lastCode ?? '?'}`).trim();

// A failure with no status code never reached the app at all (timeout, refused
// connection) — "no response" says that, where a bare em dash didn't.
const checkResult = (c: Check) =>
  c.lastStatus ? `${c.lastCode ?? 'no response'} · ${fmtMs(c.lastMs)} · ${c.when}` : 'never run';

// A red check still wants a bug filed when the one it's linked to is already
// fixed — that's a fresh regression, not a tracked failure.
const wantsBug = (bug: Bug | null) => !bug || bug.status === 'fixed';

// The assertion a check carries, as one short chip. Status-only checks say so —
// the chip is the honest answer to "what does passing mean here?".
function assertLabel(c: Check) {
  if (c.semantic) return { text: `✧ ${c.semantic}`, ai: true };
  if (c.jsonPath) return { text: c.jsonPath + (c.jsonExpect ? ` = ${c.jsonExpect}` : ''), ai: false };
  if (c.contains) return { text: `"${c.contains}"`, ai: false };
  return { text: `status ${c.expectStatus}`, ai: false };
}

// ---- #279: what a check remembers ---------------------------------------
//
// A check used to have a result but no memory, so a red light carried no
// diagnosis: a fresh regression and a fortnight of failure looked identical.
// These stats turn the same rows into the sentence you actually want — "failed
// 4 of the last 6 runs" — and they only ever claim what the window holds.

type HistoryStats = {
  n: number;            // results in the window
  fails: number;
  streak: number;       // leading runs sharing the newest result's status
  flaky: boolean;       // both outcomes inside the window
  diagnosis: string;    // plain language, '' when there's nothing to say
};

const NO_HISTORY: HistoryStats = { n: 0, fails: 0, streak: 0, flaky: false, diagnosis: '' };

function readHistory(results: CheckResult[] | undefined): HistoryStats {
  if (!results?.length) return NO_HISTORY;
  const n = results.length;
  const fails = results.filter((r) => r.status === 'fail').length;
  const newest = results[0].status;
  let streak = 0;
  while (streak < n && results[streak].status === newest) streak += 1;
  const flaky = fails > 0 && fails < n;

  // One run is not a trend — say nothing rather than dress it up. The phrase is
  // always a past participle, so it reads standalone on a row ("· failed 4 of
  // the last 6 runs") AND after a name ("Webhook receipt has …").
  // Order matters: a check whose newest result is its ONLY failure is a fresh
  // regression; one that has failed four times in the window is not, however
  // long its current streak.
  let diagnosis = '';
  if (n >= 2 && fails > 0) {
    diagnosis = fails === n ? `failed every one of the last ${n} runs`
      : fails === 1 ? (newest === 'fail' ? `failed for the first time in ${n} runs` : `failed once in the last ${n} runs`)
        : `failed ${fails} of the last ${n} runs`;
  }
  return { n, fails, streak, flaky, diagnosis };
}

// The sparkline: one bar per run, oldest → newest. Colour is the outcome;
// height is that run's latency against the slowest in the window, so a check
// that is passing but getting slower reads as such BEFORE it goes red.
function Spark({ results, width }: { results: CheckResult[] | undefined; width?: number }) {
  if (!results || results.length < 2) return null;
  const window = results.slice(0, 14).reverse();
  const slowest = Math.max(...window.map((r) => r.ms ?? 0), 1);
  const stats = readHistory(results);
  return (
    <span className="q-spark" style={width ? { width } : undefined}
      title={`${stats.n} runs · ${stats.fails} red${stats.diagnosis ? ` · ${stats.diagnosis}` : ''}`}>
      {window.map((r, i) => (
        <span key={i} className={r.status === 'fail' ? 'bad' : 'good'}
          style={{ height: `${Math.max(20, Math.round(((r.ms ?? 0) / slowest) * 100))}%` }} />
      ))}
    </span>
  );
}

// ---- the health read: one verdict over checks AND bugs -------------------

type Verdict = 'good' | 'needs-work' | 'down' | 'untested';

type Health = {
  verdict: Verdict; label: string; why: string;
  total: number; passing: number; failing: number; never: number; run: number;
  serious: number; open: number; avgMs: number | null;
  oneCause: string | null;   // every check failing the same way = the host, not N bugs
};

function readHealth(checks: Check[], bugs: Bug[], linkedRed: boolean): Health {
  const passing = checks.filter((c) => c.lastStatus === 'pass').length;
  const failing = checks.filter((c) => c.lastStatus === 'fail').length;
  const run = passing + failing;
  const never = checks.length - run;
  const serious = bugs.filter(isSerious).length;
  const open = bugs.filter(isOpen).length;
  const latencies = checks.flatMap((c) => (c.lastStatus === 'pass' && c.lastMs != null ? [c.lastMs] : []));
  const avgMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;

  // One cause: two or more checks, all of them red, all with the same signature.
  const red = checks.filter((c) => c.lastStatus === 'fail');
  const sig = red.length >= 2 && red.every((c) => failSignature(c) === failSignature(red[0]))
    ? failSignature(red[0]) : null;
  const oneCause = sig && passing === 0 ? sig : null;

  const base = {
    total: checks.length, passing, failing, never, run, serious, open, avgMs, oneCause,
  };

  if (!checks.length && !bugs.length) {
    return { ...base, verdict: 'untested', label: 'Untested', why: 'Nothing has been checked yet.' };
  }
  if (run > 0 && passing === 0) {
    return {
      ...base, verdict: 'down', label: 'Down',
      why: `0 of ${run} passing${oneCause ? ` — every one of them ${oneCause}.` : '.'}`,
    };
  }
  if (failing > 0 || serious > 0) {
    const bits = [failing > 0 ? `${plural(failing, 'check')} red` : '', serious > 0 ? `${plural(serious, 'serious bug')} open` : '']
      .filter(Boolean).join(' and ');
    return {
      ...base, verdict: 'needs-work', label: 'Needs work',
      why: `${bits.charAt(0).toUpperCase()}${bits.slice(1)}.${linkedRed
        ? ' One of the bugs is why one of the checks is red.'
        : failing > 0 && serious > 0 ? ' The pass rate alone would read fine.' : ''}`,
    };
  }
  if (!run) {
    return {
      ...base, verdict: 'untested', label: 'Untested',
      why: checks.length ? `${plural(checks.length, 'check')} waiting on a first run.` : 'No checks yet, nothing serious open.',
    };
  }
  return {
    ...base, verdict: 'good', label: 'Good',
    why: `${passing} of ${checks.length} passing, nothing serious open.${never ? ` ${plural(never, 'check')} never run.` : ''}`,
  };
}

// ---- health band + KPI cards --------------------------------------------

function HealthBand({ health, runs, detail }: { health: Health; runs: CheckRun[]; detail: string }) {
  // Full Run-alls only, oldest → newest: a run-one would read as a false dip.
  const trend = runs.filter((r) => r.scope === 'all').slice(0, 30).reverse();
  return (
    <div className={`q-health ${health.verdict}`}>
      <span className="q-eyebrow">HEALTH</span>
      <span className="q-verdict">{health.label}</span>
      <span className="q-why">{health.why}</span>
      {/* #279 — what the checks REMEMBER, not just what they say right now. */}
      {detail && <span className="q-why-more">{detail}</span>}
      {trend.length > 1 && (
        <div className="q-trend" title="Pass rate — one bar per Run all, oldest to newest">
          {trend.map((r) => (
            <div key={r.id} className={`q-trend-bar ${r.failed ? 'bad' : 'good'}`}
              style={{ height: `${r.total ? Math.max(10, Math.round((r.passed / r.total) * 100)) : 10}%` }}
              title={`${r.passed}/${r.total} passed · ${r.when} · ${fmtMs(r.durationMs)}`} />
          ))}
        </div>
      )}
    </div>
  );
}

function Kpis({ health, runs, busy }: { health: Health; runs: CheckRun[]; busy: boolean }) {
  const alls = runs.filter((r) => r.scope === 'all');
  const last = alls[0];
  const prev = alls[1];
  // Deltas are only claimed when there are two full runs to compare.
  const passDelta = last && prev ? last.passed - prev.passed : null;
  const failDelta = last && prev ? last.failed - prev.failed : null;
  const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

  return (
    <div className={`q-kpis${busy ? ' waiting' : ''}`}>
      <div className="q-kpi">
        <div className="q-kpi-n">
          <b>{health.passing}/{health.total}</b>
          {passDelta != null && passDelta !== 0 && (
            <span className={passDelta > 0 ? 'up' : 'down'}>{signed(passDelta)}</span>
          )}
        </div>
        <div className="q-kpi-l">Checks passing</div>
        <div className="q-kpi-s">{busy ? `from ${last?.when ?? 'the last run'}` : last ? `last run ${last.when}` : 'never run'}</div>
      </div>
      <div className={`q-kpi ${health.failing ? 'bad' : ''}`}>
        <div className="q-kpi-n">
          <b>{health.failing}</b>
          {failDelta != null && failDelta !== 0 && (
            <span className={failDelta > 0 ? 'down' : 'up'}>{failDelta > 0 ? signed(failDelta) : `was ${prev!.failed}`}</span>
          )}
        </div>
        <div className="q-kpi-l">Failing</div>
        <div className="q-kpi-s">{health.failing ? 'red as of the last run' : health.never ? `${health.never} never run` : 'all clear'}</div>
      </div>
      <div className={`q-kpi ${health.serious ? 'bad' : ''}`}>
        <div className="q-kpi-n"><b>{health.serious}</b></div>
        <div className="q-kpi-l">Serious bugs</div>
        <div className="q-kpi-s">{health.open ? `${health.open} open in total` : 'nothing open'}</div>
      </div>
      <div className="q-kpi">
        <div className="q-kpi-n"><b>{fmtMs(health.avgMs)}</b></div>
        <div className="q-kpi-l">Avg response</div>
        <div className="q-kpi-s">{health.avgMs == null ? 'no passing checks yet' : `across ${plural(health.passing, 'passing check')}`}</div>
      </div>
    </div>
  );
}

// ---- the inline report composer (the header's + Report) ------------------

function ReportBar({ prefill, checkName, onFile, onClose }: {
  prefill: string; checkName: string;
  onFile: (title: string, severity: Severity) => void; onClose: () => void;
}) {
  const [title, setTitle] = useState(prefill);
  const [severity, setSeverity] = useState<Severity>(prefill ? 'high' : 'medium');
  const input = useRef<HTMLInputElement>(null);

  // A → Bug press while the bar is already open re-aims it at the new failure.
  useEffect(() => {
    setTitle(prefill);
    setSeverity(prefill ? 'high' : 'medium');
    input.current?.focus();
  }, [prefill, checkName]);

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    onFile(t, severity);
    setTitle('');
    setSeverity('medium');
    input.current?.focus();
  };

  return (
    <div className="q-report">
      <input ref={input} className="field-input sm grow" autoFocus value={title}
        placeholder="What broke? One line is enough."
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); else if (e.key === 'Escape') onClose(); }} />
      <div className="bug-quick-sevs">
        {SEVERITIES.map((s) => (
          <button key={s} className={`bug-quick-sev ${s}${severity === s ? ' on' : ''}`}
            onClick={() => setSeverity(s)} title={s}>{s[0].toUpperCase()}</button>
        ))}
      </div>
      <button className="btn-submit sm" onClick={submit} disabled={!title.trim()}>File</button>
      {checkName && <span className="q-report-link" title="This bug will remember the check that caught it">↳ {checkName}</span>}
      <button className="q-esc" onClick={onClose}>esc</button>
    </div>
  );
}

// ---- the status pill that is its own editor ------------------------------

function StatusPill({ bug, onSet }: { bug: Bug; onSet: (s: BugStatus) => void }) {
  const [picking, setPicking] = useState(false);
  if (!picking) {
    return (
      <button className={`status-pill ${bug.status} clickable`} onClick={() => setPicking(true)}
        title="Change status">{STATUS_LABEL[bug.status]}</button>
    );
  }
  return (
    <span className="review-pick" onKeyDown={(e) => { if (e.key === 'Escape') setPicking(false); }}>
      {BUG_STATUSES.map((s) => (
        <button key={s} className="review-pick-opt"
          onClick={() => { setPicking(false); if (s !== bug.status) onSet(s); }}>{STATUS_LABEL[s]}</button>
      ))}
    </span>
  );
}

// ---- "Needs you": red checks and serious bugs in one list ----------------

type NeedsRow =
  | { kind: 'check'; check: Check; bug: Bug | null }
  | { kind: 'bug'; bug: Bug; check: Check | null };

function NeedsYou({
  rows, busy, history, onRunFailing, onRunOne, onFileBug, onSetStatus, onJump, highlightId,
}: {
  rows: NeedsRow[]; busy: boolean; history: CheckHistory;
  onRunFailing: () => void; onRunOne: (id: number) => void;
  onFileBug: (c: Check) => void; onSetStatus: (b: Bug, s: BugStatus) => void;
  onJump: (kind: 'check' | 'bug', id: string) => void; highlightId?: string | null;
}) {
  const checks = rows.filter((r) => r.kind === 'check').length;
  const bugs = rows.length - checks;
  const shown = rows.slice(0, 6);
  return (
    <div className="q-card wrong">
      <div className="q-card-head">
        <span className="q-card-title">Needs you</span>
        <span className="q-card-sub">
          {[checks ? plural(checks, 'check') : '', bugs ? plural(bugs, 'serious bug') : ''].filter(Boolean).join(' · ')}
        </span>
        <div className="q-spacer" />
        {checks > 0 && (
          <button className="q-card-act red" disabled={busy} onClick={onRunFailing}>▸ re-run the red ones</button>
        )}
      </div>
      <div className="q-rows">
        {shown.map((r) => (r.kind === 'check' ? (
          <div className="q-row check" key={`c${r.check.id}`}>
            <span className="q-kind">CHECK</span>
            <div className="q-row-main">
              <div className="q-row-title">
                <span className="t">{r.check.name}</span>
                {r.bug && (
                  <button className="q-link" onClick={() => onJump('bug', r.bug!.id)}
                    title="The bug filed from this check">↳ {r.bug.id} {r.bug.status}</button>
                )}
              </div>
              <span className="q-row-sub bad">
                {failSignature(r.check)}{r.check.lastStatus ? ` · ${r.check.when}` : ''}
                {/* #279 — is this new, or has it been broken all week? */}
                {readHistory(history[r.check.id]).diagnosis && (
                  <span className="q-diag"> · {readHistory(history[r.check.id]).diagnosis}</span>
                )}
              </span>
            </div>
            <Spark results={history[r.check.id]} width={54} />
            <div className="q-row-acts">
              {wantsBug(r.bug) && <button className="q-act red" onClick={() => onFileBug(r.check)}>→ Bug</button>}
              <button className="q-act" disabled={busy} onClick={() => onRunOne(r.check.id)}>▸ re-run</button>
            </div>
          </div>
        ) : (
          <div className={`q-row bug ${r.bug.severity}${highlightId === r.bug.id ? ' hl' : ''}`}
            key={`b${r.bug.id}`} data-hl={r.bug.id}>
            <span className="q-kind">BUG</span>
            <div className="q-row-main">
              <div className="q-row-title">
                <span className="t">{r.bug.title}</span>
                {r.check && (
                  <button className="q-link" onClick={() => onJump('check', String(r.check!.id))}
                    title="The check that caught it">↳ {r.check.name}</button>
                )}
              </div>
              <span className="q-row-sub">{r.bug.id} · {r.bug.meta}</span>
            </div>
            <div className="q-row-acts">
              <span className={`sev-pill ${r.bug.severity}`}>{r.bug.severity}</span>
              <StatusPill bug={r.bug} onSet={(s) => onSetStatus(r.bug, s)} />
            </div>
          </div>
        )))}
        {rows.length > shown.length && (
          <div className="q-more">+ {rows.length - shown.length} more · red checks first, then bugs by severity</div>
        )}
      </div>
    </div>
  );
}

// Every check failing the same way reads as the host being down, not as N bugs —
// so the page says so and files nothing on its own.
function OneCause({ signature, count, busy, onRunAll, onFileHost }: {
  signature: string; count: number; busy: boolean; onRunAll: () => void; onFileHost: () => void;
}) {
  return (
    <div className="q-card wrong">
      <div className="q-card-head">
        <span className="q-card-title">Every check is failing the same way</span>
        <div className="q-spacer" />
      </div>
      <div className="q-onecause">
        <p>
          All {count} returned <code>{signature}</code>. That reads like the host, not {count} bugs — we've
          held off filing anything.
        </p>
        <div className="q-row-acts">
          <button className="btn-submit sm" disabled={busy} onClick={onRunAll}>▸ Re-run all</button>
          <button className="q-act" onClick={onFileHost}>→ File one bug for the host</button>
        </div>
      </div>
    </div>
  );
}

// ---- the Gemini bug audit ------------------------------------------------

function AuditCard({
  context, onSaveBrief, busy, result, error, onRun, canPrompt, claudeCopy, onCopyClaude, checkCount,
}: {
  context: string; onSaveBrief: (t: string) => void;
  busy: boolean; result: AuditResult | null; error: string; onRun: () => void;
  // #361 — the deep-audit hand-off is the Auditor's SECOND op and switches
  // separately: it needs no key, so it is the half that still works on a
  // keyless server and the half worth being able to keep when the other goes.
  canPrompt: boolean;
  claudeCopy: 'idle' | 'busy' | 'copied' | 'failed'; onCopyClaude: () => void; checkCount: number;
}) {
  const [briefOpen, setBriefOpen] = useState(false);
  const [draft, setDraft] = useState(context);

  const claudeLabel = claudeCopy === 'busy' ? 'Composing…'
    : claudeCopy === 'copied' ? '✓ Copied' : claudeCopy === 'failed' ? 'Copy failed' : '⧉ prompt';

  return (
    <div className={`q-card audit${busy ? ' running' : ''}`}>
      <div className="q-card-head">
        <span className="q-card-title">✧ Bug audit</span>
        <div className="q-spacer" />
        <button className="q-card-act" onClick={() => { setDraft(context); setBriefOpen(!briefOpen); }}>
          {briefOpen ? 'close brief' : context ? '✎ brief' : '+ brief'}
        </button>
        {canPrompt && (
          <button className="q-card-act" disabled={claudeCopy === 'busy'} onClick={onCopyClaude}
            title="Copy a deep-audit prompt for a Claude session — the investigation Gemini can't do from outside">
            {claudeLabel}
          </button>
        )}
        <button className="btn-submit sm" disabled={busy} onClick={onRun}>{busy ? 'Auditing…' : '✧ Run'}</button>
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
            <span className="q-hint">⌘↵ saves · sent with every audit run</span>
            <button className="btn-submit sm" disabled={draft.trim() === context}
              onClick={() => { onSaveBrief(draft.trim()); setBriefOpen(false); }}>Save brief</button>
            <button className="btn-cancel sm" onClick={() => setBriefOpen(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="q-card-body">
        {busy ? (
          <>
            <div className="q-audit-run">reading the brief, {plural(checkCount, 'check result')} and the tracked bugs…</div>
            <div className="q-skel" style={{ width: '78%' }} />
            <div className="q-skel" style={{ width: '64%' }} />
            <div className="q-skel" style={{ width: '71%' }} />
            <span className="q-note">Findings land in the review inbox for you to keep or dismiss. The tracker doesn't change until you say so.</span>
          </>
        ) : error ? (
          <span className="q-note bad">{error}</span>
        ) : result ? (
          <>
            {/* #239 — a REOPENED regression is called out first and separately.
                It is the only outcome here that changed the tracker without a
                human asking, and folding it into "already known" is how a bug
                that came back after being fixed used to go unmentioned. */}
            <span className="q-card-sub">
              {(result.reopened ?? 0) > 0
                ? `${result.reopened} fixed bug${result.reopened === 1 ? '' : 's'} found live again and reopened`
                  + (result.logged ? ` · ${result.logged} new to the review inbox` : '')
                : result.logged
                  ? `${result.logged} logged to the review inbox${result.skipped ? ` · ${result.skipped} already known` : ''}`
                  : 'Audit came back clean — nothing worth logging.'}
            </span>
            {result.findings.map((f, i) => (
              <div className={`q-finding${f.outcome === 'reopened' ? ' regressed' : ''}`} key={i}>
                <span className={`sev-pill ${f.severity}`}>{f.severity}</span>
                <span className="t">{f.title}{f.evidence ? <em> — {f.evidence}</em> : null}</span>
                <span className="q-out">
                  {f.outcome === 'logged' ? `→ ${f.bug?.id} · review inbox`
                    : f.outcome === 'reopened' ? `↩ ${f.bug?.id ?? 'a fixed bug'} · regression, reopened`
                    : f.outcome === 'duplicate' ? 'already tracked' : 'previously dismissed'}
                </span>
              </div>
            ))}
          </>
        ) : (
          <span className="q-card-sub">
            Gemini reads the brief, the check results and the live page — suspected bugs land in the
            review inbox, never straight into the tracker.
          </span>
        )}
      </div>
    </div>
  );
}

// ---- the Now segment's two list cards -----------------------------------

function ChecksCard({ checks, bugFor, busy, onRunOne, onAdd, onOpenSuite }: {
  checks: Check[]; bugFor: (c: Check) => Bug | null; busy: boolean;
  onRunOne: (id: number) => void; onAdd: () => void; onOpenSuite: () => void;
}) {
  const failing = checks.filter((c) => c.lastStatus === 'fail');
  const rest = checks.filter((c) => c.lastStatus !== 'fail');
  // Under nine checks the card is the suite. Past that it shows what's wrong and
  // counts the rest — the Suite segment is where you read all of them.
  const folded = checks.length > 8;
  const shown = folded ? failing : [...failing, ...rest];
  const passingRest = rest.filter((c) => c.lastStatus === 'pass');
  const restAvg = (() => {
    const ms = passingRest.flatMap((c) => (c.lastMs != null ? [c.lastMs] : []));
    return ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null;
  })();

  return (
    <div className="q-card">
      <div className="q-card-head">
        <span className="q-card-title">Checks</span>
        <span className="q-card-sub">
          {checks.length
            ? [`${checks.filter((c) => c.lastStatus === 'pass').length} passing`,
              failing.length ? `${failing.length} failing` : '',
              checks.length - checks.filter((c) => c.lastStatus).length ? `${checks.length - checks.filter((c) => c.lastStatus).length} never run` : '',
            ].filter(Boolean).join(' · ')
            : 'nothing checked yet'}
        </span>
        <div className="q-spacer" />
        <button className="q-card-act" onClick={onAdd}>+ add</button>
      </div>
      <div className="q-rows tight">
        {shown.map((c) => {
          const a = assertLabel(c);
          const bug = bugFor(c);
          return (
            <div className={`q-crow ${c.lastStatus || 'never'}`} key={c.id}>
              <span className={`check-dot ${c.lastStatus || 'never'}`} />
              {c.auth && (
                <span className="check-authed" title="Runs with the app's own token — this project's origin only">🔒</span>
              )}
              <span className="q-crow-name">{c.name}</span>
              {bug && <span className="q-link flat" title="Filed from this check">↳ {bug.id}</span>}
              <span className={`q-assert${a.ai ? ' ai' : ''}`} title={a.text}>{a.text}</span>
              <span className={`q-crow-result ${c.lastStatus || 'never'}`}>{checkResult(c)}</span>
              <button className="q-icon" disabled={busy} onClick={() => onRunOne(c.id)} title="Run this check">▸</button>
            </div>
          );
        })}
        {folded && (
          <button className="q-fold" onClick={onOpenSuite}>
            <span className="q-fold-caret">▸</span>
            <span className="q-fold-t">{plural(rest.length, 'more check')}</span>
            <span className="q-fold-m">{restAvg != null ? `avg ${fmtMs(restAvg)}` : 'not all run'} · read them in Suite</span>
          </button>
        )}
        {!checks.length && <div className="q-note">No checks yet — the Suite segment is where you add the first.</div>}
      </div>
    </div>
  );
}

function BugsCard({ bugs, checkFor, showFixed, setShowFixed, onSetStatus, onDelete, onJump, onOpenCommit, highlightId }: {
  bugs: Bug[]; checkFor: (b: Bug) => Check | null;
  showFixed: boolean; setShowFixed: (v: boolean) => void;
  onSetStatus: (b: Bug, s: BugStatus) => void; onDelete: (b: Bug) => void;
  onJump: (kind: 'check', id: string) => void; onOpenCommit: (hash: string) => void;
  highlightId?: string | null;
}) {
  const open = bugs.filter(isOpen).sort(bySeverity);
  const fixed = bugs.filter((b) => b.status === 'fixed');
  const serious = open.filter(isSerious).length;
  const CAP = 10;
  const shown = showFixed ? [...open, ...fixed] : open.slice(0, CAP);

  return (
    <div className="q-card">
      <div className="q-card-head">
        <span className="q-card-title">Bugs</span>
        <span className="q-card-sub">
          {bugs.length
            ? [`${open.length} open`, serious ? `${serious} serious` : '', fixed.length ? `${fixed.length} fixed` : '']
              .filter(Boolean).join(' · ')
            : 'none reported'}
        </span>
        <div className="q-spacer" />
        {fixed.length > 0 && (
          <button className="q-card-act" onClick={() => setShowFixed(!showFixed)}>
            {showFixed ? 'hide fixed' : 'show fixed'}
          </button>
        )}
      </div>
      <div className="q-rows tight">
        {shown.map((b) => {
          const check = checkFor(b);
          return (
            <div className={`q-brow ${b.severity}${b.status === 'fixed' ? ' done' : ''}${highlightId === b.id ? ' hl' : ''}`}
              key={b.id} data-hl={b.id}>
              <span className="q-brow-title">{b.title}</span>
              {b.source === 'hook' && <span className="auto-cue" title="Auto-extracted from a push">auto</span>}
              <span className="q-brow-meta">{b.id}</span>
              {check && (
                <button className="q-link flat" onClick={() => onJump('check', String(check.id))}
                  title="The check that caught it">↳ {check.name}</button>
              )}
              {b.linkRef && (
                <button className="q-link flat mono" onClick={() => onOpenCommit(b.linkRef!)}
                  title="The push this bug came from — opens Activity">↳ {b.linkRef}</button>
              )}
              <span className={`sev-pill ${b.severity}`}>{b.severity}</span>
              <StatusPill bug={b} onSet={(s) => onSetStatus(b, s)} />
              <span className="q-brow-quick">
                {b.status !== 'fixed' && (
                  <button className="bug-resolve" title="Mark fixed" onClick={() => onSetStatus(b, 'fixed')}>✓</button>
                )}
                <button className="bug-x" title="Delete" onClick={() => onDelete(b)}>×</button>
              </span>
            </div>
          );
        })}
        {!showFixed && open.length > CAP && (
          <div className="q-more">+ {open.length - CAP} more open, by severity</div>
        )}
        {!bugs.length && (
          <div className="q-note">A clean slate. Report one when something breaks — or add a check so you hear about it first.</div>
        )}
        {!open.length && bugs.length > 0 && !showFixed && (
          <div className="q-note">Nothing open. {plural(fixed.length, 'bug')} fixed.</div>
        )}
      </div>
    </div>
  );
}

// ---- Suite: every check, with the composer ------------------------------

type Draft = {
  method: CheckMethod; name: string; url: string; expect: string;
  reqBody: string; contains: string; jsonPath: string; jsonExpect: string; semantic: string;
  auth: boolean;
};
const EMPTY_DRAFT: Draft = {
  method: 'GET', name: '', url: '', expect: '200',
  reqBody: '', contains: '', jsonPath: '', jsonExpect: '', semantic: '', auth: false,
};
const toDraft = (c: Check): Draft => ({
  method: c.method, name: c.name, url: c.url, expect: String(c.expectStatus),
  reqBody: c.reqBody, contains: c.contains, jsonPath: c.jsonPath, jsonExpect: c.jsonExpect, semantic: c.semantic,
  auth: c.auth,
});

type AssertionTab = 'none' | 'contains' | 'json' | 'semantic';
const deriveAssertionTab = (d: Draft): AssertionTab =>
  d.semantic ? 'semantic' : d.jsonPath ? 'json' : d.contains ? 'contains' : 'none';

function SuitePanel({
  checks, bugFor, siteUrl, busy, geminiReady, openAdd, onAddConsumed, history,
  onRun, onAdd, onEdit, onDelete, onFileBug, highlightId,
}: {
  checks: Check[]; bugFor: (c: Check) => Bug | null; siteUrl: string; busy: boolean;
  geminiReady: boolean; openAdd: boolean; onAddConsumed: () => void; history: CheckHistory;
  onRun: (id?: number) => void;
  onAdd: (input: CheckInput) => void;
  onEdit: (id: number, patch: Partial<CheckInput>) => void;
  onDelete: (id: number) => void;
  onFileBug: (c: Check) => void;
  highlightId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [d, setD] = useState<Draft>(EMPTY_DRAFT);
  const [assertTab, setAssertTab] = useState<AssertionTab>('none');
  // #279 — which check has its history unfolded (one at a time; the sparkline
  // is the affordance, the panel underneath is the receipts).
  const [openHistory, setOpenHistory] = useState<number | null>(null);
  const set = (patch: Partial<Draft>) => setD((prev) => ({ ...prev, ...patch }));

  const close = () => { setOpen(false); setEditingId(null); setD(EMPTY_DRAFT); setAssertTab('none'); };
  const startAdd = () => { setD(EMPTY_DRAFT); setEditingId(null); setAssertTab('none'); setOpen(true); };
  const startEdit = (c: Check) => {
    const draft = toDraft(c);
    setD(draft); setAssertTab(deriveAssertionTab(draft)); setEditingId(c.id); setOpen(true);
  };

  // The Checks card's "+ add" jumps here with the composer already open.
  useEffect(() => { if (openAdd) { startAdd(); onAddConsumed(); } }, [openAdd]);

  const switchAssertTab = (tab: AssertionTab) => {
    setAssertTab(tab);
    if (tab !== 'contains') set({ contains: '' });
    if (tab !== 'json') set({ jsonPath: '', jsonExpect: '' });
    if (tab !== 'semantic') set({ semantic: '' });
  };

  const save = () => {
    if (!d.name.trim() || !/^https?:\/\//i.test(d.url.trim())) return;
    const input: CheckInput = {
      name: d.name.trim(), url: d.url.trim(), method: d.method,
      expect_status: Number(d.expect) || 200,
      req_body: d.reqBody.trim(), contains: d.contains.trim(),
      json_path: d.jsonPath.trim(), json_expect: d.jsonExpect.trim(),
      semantic: d.semantic.trim(), auth: d.auth,
    };
    if (editingId !== null) onEdit(editingId, input); else onAdd(input);
    close();
  };
  const keys = (e: React.KeyboardEvent) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') close(); };
  const hasBody = d.method !== 'GET' && d.method !== 'HEAD';

  // ✧ Semantic is a Gemini surface: absent without a key, not a dead tab.
  const ASSERT_TABS: { key: AssertionTab; label: string }[] = [
    { key: 'none', label: '+ assertion' },
    { key: 'contains', label: 'Body keyword' },
    { key: 'json', label: 'JSON path' },
    ...(geminiReady ? [{ key: 'semantic' as AssertionTab, label: '✧ Semantic' }] : []),
  ];

  return (
    <div className="q-card">
      <div className="q-card-head">
        <span className="q-card-title">The suite</span>
        <span className="q-card-sub">
          {checks.length
            ? `${plural(checks.length, 'check')} against the live app`
            : 'test the live app — pages up, functions answering, responses saying the right thing'}
        </span>
        <div className="q-spacer" />
        {!open && !checks.length && siteUrl && (
          <button className="q-card-act" onClick={() => onAdd({ name: 'Site up', url: siteUrl })}>+ Site up</button>
        )}
        {!open && <button className="btn-submit sm" onClick={startAdd}>+ Add check</button>}
      </div>

      {open && (
        <div className="check-composer">
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

          {hasBody && (
            <textarea className="field-input sm check-body" rows={3}
              placeholder='Request body (optional) — JSON is sent as application/json, e.g. {"email": "test@example.com"}'
              value={d.reqBody} onChange={(e) => set({ reqBody: e.target.value })}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); }
                else if (e.key === 'Escape') { e.preventDefault(); close(); }
              }} />
          )}

          <div className="check-assert-row">
            <div className="check-assert-tabs">
              {ASSERT_TABS.map(({ key, label }) => (
                <button key={key}
                  className={`check-assert-tab${assertTab === key ? ' on' : ''}${key === 'none' && assertTab === 'none' ? ' placeholder' : ''}`}
                  onClick={() => switchAssertTab(assertTab === key && key !== 'none' ? 'none' : key)}
                  title={key === 'none' ? 'Add an optional assertion' : undefined}>
                  {key === 'none' && assertTab !== 'none' ? '× assertion' : label}
                </button>
              ))}
            </div>
            {assertTab === 'contains' && (
              <input className="field-input sm grow" autoFocus placeholder="Response body must contain this text"
                value={d.contains} onChange={(e) => set({ contains: e.target.value })} onKeyDown={keys}
                title="Fail unless the response body contains this text" />
            )}
            {assertTab === 'json' && (
              <>
                <input className="field-input sm code" autoFocus placeholder="$.path.to.field"
                  value={d.jsonPath} onChange={(e) => set({ jsonPath: e.target.value })} onKeyDown={keys}
                  title="A dot path into the JSON response — fails if missing" />
                <input className="field-input sm" placeholder="expected value (optional)"
                  value={d.jsonExpect} onChange={(e) => set({ jsonExpect: e.target.value })} onKeyDown={keys}
                  title="What that path should equal (leave empty to only require it exists)" />
              </>
            )}
            {assertTab === 'semantic' && (
              <input className="field-input sm grow" autoFocus placeholder="e.g. shows the dashboard, no error banners"
                value={d.semantic} onChange={(e) => set({ semantic: e.target.value })} onKeyDown={keys}
                title="A plain-language expectation — Gemini judges the response against it" />
            )}
          </div>

          {/* #261 — authenticated checks. The token lives on the server and only
              ever goes to this project's own origin, so say exactly that. */}
          <div className="check-composer-row check-auth-row">
            <label className="check-auth" title={siteUrl
              ? `Sends the app's own token. Only works against ${siteUrl} — the server refuses any other host.`
              : "Sends the app's own token. Needs the project's site URL set."}>
              <input type="checkbox" checked={d.auth} onChange={(e) => set({ auth: e.target.checked })} />
              <span>Authenticated</span>
              <span className="check-auth-hint">
                signed with the app&rsquo;s own token — this project&rsquo;s origin only
              </span>
            </label>
            <span className="grow" />
            <span className="q-hint">↵ saves · esc cancels</span>
            <button className="btn-submit sm" onClick={save}>{editingId !== null ? 'Save' : 'Add'}</button>
            <button className="btn-cancel sm" onClick={close}>Cancel</button>
          </div>
        </div>
      )}

      <div className="q-rows">
        {checks.map((c) => {
          const a = assertLabel(c);
          const bug = bugFor(c);
          const past = history[c.id];
          const stats = readHistory(past);
          const shown = openHistory === c.id;
          return (
            <div key={c.id}>
              <div className={`q-srow ${c.lastStatus || 'never'}${highlightId === String(c.id) ? ' hl' : ''}`}
                data-hl={c.id}>
                <span className={`check-dot ${c.lastStatus || 'never'}`} />
                <span className={`check-method ${c.method === 'GET' ? '' : 'fn'}`}>{c.method}</span>
                {c.auth && (
                  <span className="check-authed" title="Runs with the app's own token — this project's origin only">🔒</span>
                )}
                <div className="q-row-main">
                  <div className="q-row-title">
                    <span className="t">{c.name}</span>
                    <span className={`q-assert${a.ai ? ' ai' : ''}`} title={a.text}>{a.text}</span>
                    {/* #279 — flaky is its own signal: neither green nor honestly red. */}
                    {stats.flaky && c.lastStatus === 'pass' && (
                      <span className="q-flaky" title={stats.diagnosis}>flaky</span>
                    )}
                    {bug && <span className="q-link flat">↳ {bug.id} {bug.status}</span>}
                  </div>
                  <span className={`q-row-sub${c.lastStatus === 'fail' ? ' bad' : ''}`}>
                    {c.lastStatus === 'fail' && c.lastError ? c.lastError : c.url}
                    {stats.diagnosis && (
                      <span className="q-diag">
                        {' · '}{c.lastStatus === 'pass' ? 'green again — ' : ''}{stats.diagnosis}
                      </span>
                    )}
                  </span>
                </div>
                {/* The sparkline IS the affordance for the history panel. */}
                {stats.n > 1 ? (
                  <button className={`q-spark-btn${shown ? ' on' : ''}`} title="Show this check's recent runs"
                    onClick={() => setOpenHistory(shown ? null : c.id)}>
                    <Spark results={past} />
                  </button>
                ) : <span className="q-spark-none" title="No history yet — it builds from each run">·</span>}
                <span className={`q-crow-result ${c.lastStatus || 'never'}`}>{checkResult(c)}</span>
                <div className="q-row-acts">
                  {c.lastStatus === 'fail' && wantsBug(bug) && (
                    <button className="q-act red" onClick={() => onFileBug(c)}>→ Bug</button>
                  )}
                  <button className="q-icon" disabled={busy} onClick={() => onRun(c.id)} title="Run this check">▸</button>
                  <button className="q-icon" onClick={() => startEdit(c)} title="Edit">✎</button>
                  <button className="q-icon danger" onClick={() => onDelete(c.id)} title="Delete">×</button>
                </div>
              </div>
              {shown && past && (
                <div className="q-hist">
                  <div className="q-hist-head">
                    <span className="q-eyebrow">LAST {past.length} RUNS</span>
                    <span>{stats.fails ? `${stats.fails} red` : 'all green'}</span>
                    <div className="q-spacer" />
                    <span className="q-hist-note">
                      Kept per check; editing what a check tests clears its history, since past passes
                      were against a different test.
                    </span>
                  </div>
                  {past.map((r, i) => (
                    <div className={`q-hist-row ${r.status}`} key={i}>
                      <span className={`check-dot ${r.status}`} />
                      <span className="q-hist-when">{r.when}</span>
                      <span className="q-hist-code">{r.code ?? 'no response'}</span>
                      <span className="q-hist-ms">{fmtMs(r.ms)}</span>
                      <span className="q-hist-err">{r.error || ''}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {!checks.length && (
          <div className="q-note">
            Two checks and you'll know when this project breaks without opening it. Start with the one
            you'd check by hand.
          </div>
        )}
      </div>

      {checks.length > 0 && (
        <div className="q-foot">
          <span className="q-eyebrow">ASSERTIONS</span>
          <span>
            Every check asserts its status code. A body keyword, a JSON path{geminiReady ? ' or a plain-language expectation Gemini judges' : ''} narrows
            that to "answering correctly" rather than "answering at all". Runs are bounded at 8 seconds and only ever on demand.
          </span>
        </div>
      )}
    </div>
  );
}

// ---- History: the run ledger -------------------------------------------

function HistoryPanel({ runs }: { runs: CheckRun[] }) {
  const alls = runs.filter((r) => r.scope === 'all');
  const trend = alls.slice(0, 30).reverse();
  const green = alls.filter((r) => !r.failed).length;
  return (
    <div className="q-card">
      <div className="q-card-head">
        <span className="q-card-title">History</span>
        <span className="q-card-sub">
          {runs.length
            ? `${plural(runs.length, 'run')} recorded · ${green} of ${alls.length} full runs all green`
            : 'no runs recorded yet'}
        </span>
        <div className="q-spacer" />
        {trend.length > 1 && (
          <div className="q-trend inline">
            {trend.map((r) => (
              <div key={r.id} className={`q-trend-bar ${r.failed ? 'bad' : 'good'}`}
                style={{ height: `${r.total ? Math.max(10, Math.round((r.passed / r.total) * 100)) : 10}%` }}
                title={`${r.passed}/${r.total} · ${r.when}`} />
            ))}
          </div>
        )}
      </div>
      <div className="q-rows">
        {runs.map((r) => (
          <div className="q-hrow" key={r.id}>
            <span className={`check-dot ${r.failed ? 'fail' : 'pass'}`} />
            <span className="q-hrow-when">{r.when}</span>
            <span className="q-hrow-scope">{r.scope === 'all' ? 'run all' : 'one'}</span>
            <span className="q-hrow-bar">
              <span className={r.failed ? 'bad' : 'good'}
                style={{ width: `${r.total ? Math.round((r.passed / r.total) * 100) : 0}%` }} />
            </span>
            <span className={`q-hrow-rate ${r.failed ? 'bad' : 'good'}`}>{r.passed}/{r.total}</span>
            <span className="q-hrow-note">
              {r.failed ? `${plural(r.failed, 'check')} red` : r.total ? 'all green' : 'nothing to run'}
            </span>
            <span className="q-hrow-dur">{fmtMs(r.durationMs)}</span>
          </div>
        ))}
        {!runs.length && (
          <div className="q-note">Nothing yet. Every ▸ Run all lands a row here — that's what the pass-rate trend is drawn from.</div>
        )}
      </div>
      {runs.length > 0 && (
        <div className="q-foot">
          <span className="q-eyebrow">ON DEMAND</span>
          <span>
            Nothing is scheduled or polled. These are the runs someone (or the overnight autopilot's
            checks pass) asked for; each row is one round of the suite, bounded at 8 seconds a check.
          </span>
        </div>
      )}
    </div>
  );
}

// ---- the page ----------------------------------------------------------

export function Quality({
  slug, checks, bugs, siteUrl, geminiReady, agents, highlightId,
  checksBusy, onRunChecks, onAddCheck, onEditCheck, onDeleteCheck,
  onFileBug, onSetBugStatus, onDeleteBug, onOpenCommit,
  auditContext, onSaveAuditContext, auditBusy, auditResult, auditError, onRunAudit,
  claudeCopy, onCopyClaudePrompt,
}: {
  slug: string;
  checks: Check[]; bugs: Bug[]; siteUrl: string; geminiReady: boolean;
  // #361 — the AUDITOR's live state. This page is the Auditor's tab, and it is
  // the one tab with room to say so when the agent is off, so it reads the
  // state itself rather than taking pre-chewed booleans.
  agents: TabAgentState;
  highlightId?: string | null;
  checksBusy: boolean;
  onRunChecks: (id?: number) => void;
  onAddCheck: (input: CheckInput) => void;
  onEditCheck: (id: number, patch: Partial<CheckInput>) => void;
  onDeleteCheck: (id: number) => void;
  onFileBug: (title: string, severity: Severity, checkId: number | null) => void;
  onSetBugStatus: (b: Bug, s: BugStatus) => void;
  onDeleteBug: (b: Bug) => void;
  onOpenCommit: (hash: string) => void;   // the ↳ commit chip — jumps to Activity
  auditContext: string; onSaveAuditContext: (t: string) => void;
  auditBusy: boolean; auditResult: AuditResult | null; auditError: string; onRunAudit: () => void;
  claudeCopy: 'idle' | 'busy' | 'copied' | 'failed'; onCopyClaudePrompt: () => void;
}) {
  // #361 — what the Auditor may do on this project right now. Unknown reads as
  // yes (an older server sends no agent state), so this only ever hides a
  // surface the server has actually said it will refuse.
  const canAudit = agentCan(agents, 'auditor', 'audit');
  const canPrompt = agentCan(agents, 'auditor', 'auditprompt');
  const auditorOff = agentOffReason(agents, 'auditor', 'audit');

  const [seg, setSeg] = useState<Seg>('now');
  const [runs, setRuns] = useState<CheckRun[]>([]);
  const [history, setHistory] = useState<CheckHistory>({});
  const [report, setReport] = useState<{ open: boolean; title: string; check: Check | null }>(
    { open: false, title: '', check: null });
  const [showFixed, setShowFixed] = useState(false);
  const [openAdd, setOpenAdd] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  // The run ledger and each check's own history (#279) are this page's own
  // fetches (the detail payload stays lean); both refresh whenever a run — or
  // the check-rerunning audit — settles. A miss on either is quietly no memory,
  // never an error: an older server without /history just has no sparklines.
  useEffect(() => {
    if (checksBusy || auditBusy) return;
    let live = true;
    getCheckRuns(slug).then((r) => { if (live) setRuns(r); }).catch(() => {});
    getCheckHistory(slug).then((h) => { if (live) setHistory(h); }).catch(() => {});
    return () => { live = false; };
  }, [slug, checksBusy, auditBusy]);

  // A running suite ticks its own elapsed clock. The numbers above it grey out
  // rather than blanking — the last known state stays readable throughout.
  useEffect(() => {
    if (!checksBusy) { setElapsed(0); return; }
    const t = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(t);
  }, [checksBusy]);

  const byCheckId = useMemo(() => {
    const m = new Map<number, Bug>();
    // Open bugs win the chip: a fixed bug on a still-red check shouldn't read as
    // "handled". Newest first is the list's own order.
    for (const b of bugs) if (b.checkId != null && (!m.has(b.checkId) || (isOpen(b) && !isOpen(m.get(b.checkId)!)))) m.set(b.checkId, b);
    return m;
  }, [bugs]);
  const checkById = useMemo(() => new Map(checks.map((c) => [c.id, c])), [checks]);
  const bugFor = (c: Check) => byCheckId.get(c.id) ?? null;
  const checkFor = (b: Bug) => (b.checkId != null ? checkById.get(b.checkId) ?? null : null);

  const failing = checks.filter((c) => c.lastStatus === 'fail');
  const linkedRed = failing.some((c) => { const b = bugFor(c); return !!b && isOpen(b); });
  const health = readHealth(checks, bugs, linkedRed);

  // The one badge and the Now count: what's actually wrong — red checks plus
  // serious open bugs. Everything else can wait for you to come looking.
  const needs: NeedsRow[] = [
    ...failing.map((c) => ({ kind: 'check' as const, check: c, bug: bugFor(c) })),
    ...bugs.filter(isSerious).sort(bySeverity).map((b) => ({ kind: 'bug' as const, bug: b, check: checkFor(b) })),
  ];

  const virgin = !checks.length && !bugs.length;
  // What's open but not serious — the calm card names it rather than implying zero.
  const parked = bugs.filter((b) => isOpen(b) && !isSerious(b)).length;

  // #279 — the health card's second line: the one sentence the history can now
  // answer that a single result never could. Prefer the red check with the most
  // failures behind it; when nothing is red, name a flaky one, because a check
  // that passes intermittently is not a healthy check.
  const healthDetail = (() => {
    const named = (c: Check) => (failing.length === 1 || checks.length === 1 ? c.name : `“${c.name}”`);
    const worstRed = failing
      .map((c) => ({ c, s: readHistory(history[c.id]) }))
      .filter((x) => x.s.diagnosis)
      .sort((a, b) => b.s.fails - a.s.fails)[0];
    if (worstRed) return `${named(worstRed.c)} has ${worstRed.s.diagnosis}.`;
    const flaky = checks
      .map((c) => ({ c, s: readHistory(history[c.id]) }))
      .filter((x) => x.s.flaky && x.s.n >= 3)
      .sort((a, b) => b.s.fails - a.s.fails)[0];
    if (flaky) return `${named(flaky.c)} is passing now, but it ${flaky.s.diagnosis}.`;
    return '';
  })();

  // A deep link onto a fixed bug has to be able to find it.
  useEffect(() => {
    if (highlightId && bugs.some((b) => b.id === highlightId && b.status === 'fixed')) setShowFixed(true);
  }, [highlightId, bugs]);

  const openReport = (check: Check | null) => {
    setReport({
      open: true, check,
      title: check ? `${check.name} is failing — ${failSignature(check)}` : '',
    });
  };
  const fileFromReport = (title: string, severity: Severity) => {
    onFileBug(title, severity, report.check?.id ?? null);
    setReport({ open: false, title: '', check: null });
  };

  // Both link chips jump to the other half of the pair, in the segment that
  // holds it — that's the whole point of the merge.
  const jump = (kind: 'check' | 'bug', id: string) => {
    if (kind === 'check') setSeg('suite');
    window.setTimeout(() => {
      const node = document.querySelector(`[data-hl="${id}"]`);
      node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      node?.classList.add('hl');
      window.setTimeout(() => node?.classList.remove('hl'), 2400);
    }, 40);
  };

  const SEGS: { key: Seg; label: string; count: number }[] = [
    { key: 'now', label: 'Now', count: needs.length },
    { key: 'suite', label: 'Suite', count: checks.length },
    { key: 'history', label: 'History', count: runs.length },
  ];

  return (
    <div className="quality">
      <div className="q-bar">
        <div className="q-bar-title">Quality</div>
        <div className="seg-control sm q-segs">
          {SEGS.map((s) => (
            <button key={s.key} className={`seg-opt${seg === s.key ? ' on' : ''}`} onClick={() => setSeg(s.key)}>
              {s.label} <span className="q-seg-n">{s.count}</span>
            </button>
          ))}
        </div>
        <div className="q-spacer" />
        {checks.length > 0 && (
          <button className="btn-repo" disabled={checksBusy} onClick={() => onRunChecks()}>
            {checksBusy ? 'Running…' : '▸ Run all'}
          </button>
        )}
        <button className="btn-dark" onClick={() => (report.open ? setReport({ open: false, title: '', check: null }) : openReport(null))}>
          + Report
        </button>
      </div>

      {report.open && (
        <ReportBar prefill={report.title} checkName={report.check?.name ?? ''}
          onFile={fileFromReport} onClose={() => setReport({ open: false, title: '', check: null })} />
      )}

      <div className="q-top">
        <HealthBand health={health} runs={runs} detail={healthDetail} />
        {virgin ? (
          <div className="q-teach">
            <p>
              Two checks and you'll know when this project breaks without opening it. Start with the
              one you'd check by hand.
            </p>
            <div className="q-teach-acts">
              {siteUrl && (
                <button className="btn-submit sm" onClick={() => { onAddCheck({ name: 'Site up', url: siteUrl }); setSeg('suite'); }}>
                  + Site up
                </button>
              )}
              <button className="q-act" onClick={() => { setSeg('suite'); setOpenAdd(true); }}>+ Add check</button>
              <button className="q-act" onClick={() => openReport(null)}>+ Report a bug</button>
            </div>
          </div>
        ) : (
          <Kpis health={health} runs={runs} busy={checksBusy} />
        )}
      </div>

      {checksBusy && (
        <div className="q-running">
          <span className="q-running-t">Running {checks.length > 1 ? 'the checks' : 'the check'}</span>
          <span className="q-running-m">{plural(checks.length, 'check')} · {elapsed}s elapsed · bounded at 8s each</span>
          <span className="q-running-bar"><span /></span>
        </div>
      )}

      {seg === 'now' && (
        <div className="q-grid">
          {virgin ? (
            <div className="q-card span">
              <div className="q-note dashed">
                A clean slate. Report one when something breaks — or add a check so you hear about it
                first. No numbers until there's something to put in them.
              </div>
            </div>
          ) : (
            <>
              {health.oneCause ? (
                <OneCause signature={health.oneCause} count={failing.length} busy={checksBusy}
                  onRunAll={() => onRunChecks()} onFileHost={() => openReport(null)} />
              ) : needs.length ? (
                <NeedsYou rows={needs} busy={checksBusy} history={history} onRunFailing={() => onRunChecks()}
                  onRunOne={(id) => onRunChecks(id)} onFileBug={openReport}
                  onSetStatus={onSetBugStatus} onJump={jump} highlightId={highlightId} />
              ) : (
                <div className="q-card calm">
                  <div className="q-card-head"><span className="q-card-title">Nothing needs you</span></div>
                  <div className="q-card-body">
                    <span className="q-card-sub">
                      Nothing is red and nothing serious is open.
                      {parked > 0 && ` ${plural(parked, 'low-priority bug')} ${parked === 1 ? 'is' : 'are'} parked — ${parked === 1 ? "it'll" : "they'll"} wait.`}
                    </span>
                  </div>
                </div>
              )}

              {/* #361 — the ✧ Bug audit is the AUDITOR's, and the Auditor can be
                  switched off in Mission Control → Agents. Off, the card is
                  absent rather than dead (the same treatment a missing key
                  gets), but unlike a missing key this is a state somebody
                  chose, so the note below names the agent and where to undo it
                  — a vanished feature with no explanation is the worse half of
                  "render it absent". */}
              {canAudit && (
                <AuditCard context={auditContext} onSaveBrief={onSaveAuditContext}
                  busy={auditBusy} result={auditResult} error={auditError} onRun={onRunAudit}
                  canPrompt={canPrompt}
                  claudeCopy={claudeCopy} onCopyClaude={onCopyClaudePrompt} checkCount={checks.length} />
              )}

              {/* #364 — the Auditor runs Claude on the host now, so its own
                  state is the whole gate: `canAudit` folds in the switch, the
                  per-op switch AND whether the host daemon is up, and
                  `auditorOff` is the sentence for whichever one is missing.
                  The Gemini key stopped being this card's question. */}
              {!canAudit && (
                <div className="q-card span">
                  <div className="q-note dashed">
                    {auditorOff} The bug audit and its Claude hand-off are hidden until then.
                    Everything else here — filing, linking, triage, the whole suite — never needed it.
                  </div>
                </div>
              )}

              <ChecksCard checks={checks} bugFor={bugFor} busy={checksBusy}
                onRunOne={(id) => onRunChecks(id)}
                onAdd={() => { setSeg('suite'); setOpenAdd(true); }}
                onOpenSuite={() => setSeg('suite')} />

              <BugsCard bugs={bugs} checkFor={checkFor} showFixed={showFixed} setShowFixed={setShowFixed}
                onSetStatus={onSetBugStatus} onDelete={onDeleteBug} onJump={jump}
                onOpenCommit={onOpenCommit} highlightId={highlightId} />

              {!geminiReady && (
                <div className="q-card span">
                  <div className="q-note dashed">
                    Plain-language check assertions need a Gemini key — the bug audit does not any
                    more, it runs Claude on the host (#364). Everything else on this page — filing,
                    linking, triage, the whole suite — works without either.
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {seg === 'suite' && (
        <SuitePanel checks={checks} bugFor={bugFor} siteUrl={siteUrl} busy={checksBusy}
          geminiReady={geminiReady} openAdd={openAdd} onAddConsumed={() => setOpenAdd(false)}
          history={history}
          onRun={onRunChecks} onAdd={onAddCheck} onEdit={onEditCheck} onDelete={onDeleteCheck}
          onFileBug={openReport} highlightId={highlightId} />
      )}

      {seg === 'history' && <HistoryPanel runs={runs} />}
    </div>
  );
}
