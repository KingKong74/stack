// THE QUALITY TAB IS WIRED (#497). It reads this project's own checks, bugs,
// run ledger and per-check history, and every control on it writes.
//
// It is `ui_kits/console/QualityScreen.jsx` — ported to TS as a mockup by #450,
// given its data here — laid back over the loop #278 built the real page for:
// run → see what is red → file what is real → fix → re-run → close. THE SHAPE
// IS THE KIT'S AND THE ARITHMETIC IS `lib/quality.ts`'S. Nothing in this file
// decides how bad something is; read that module's header before changing a
// number, because the rail's badge is derived from the same functions and the
// two are required to agree.
//
// WHAT CAME BACK, in the order #450's header listed what it cost:
//
//  • RUNNING, ADDING, EDITING AND DELETING A CHECK all have a surface again —
//    Run all, ▸ run on any row, the composer (which doubles as the editor and
//    carries the delete), and a FEATURE run at the foot of an open fold, which
//    is the only browser caller `POST /run {feature}` has ever had.
//  • FILING A BUG AND MOVING ITS STATUS, and with them the bug↔check link
//    (#278). Both directions are writable: `file a bug` on a red check carries
//    `check_id`, and `write a check` on an uncovered bug creates the check and
//    then links the bug to it. Those two are the ONLY paths that ever set that
//    column, which is why they are worth the extra call.
//  • THE RUN LEDGER AND A CHECK'S HISTORY are read again — the strip's
//    sparkline is `check_runs` (full runs only) and every diagnosis on the page
//    comes out of `check_results`.
//  • THE NAV BADGE COUNTS THIS PROJECT ONCE MORE. `qualityAttention` replaces
//    the mockup's `QUALITY_ATTENTION` and takes the same payload the rail
//    already has, so no screen fetches to draw a number.
//  • `hl` IS STILL IGNORED. No tab has honoured a bug key since #450 and this
//    one does not restore it — every deep link resolves and lands on the page.
//
// FOUR PLACES THE KIT'S PICTURE AND THIS APP'S DATA DISAGREED, AND THE DATA WON:
//
//  1. THE KIT'S FIVE SEVERITIES ARE NOT A COLUMN. They are derived — the whole
//     of `lib/quality.ts`'s header is that decision. Nothing on this page
//     writes a `SevKey`; the only severity anyone can SET is a bug's own
//     critical/high/medium/low, in the composer and nowhere else.
//  2. "RUNS ON" IS "RUN BY". The kit schedules a check push/nightly/manual;
//     Stack has no per-check schedule at all — the server probes on demand and
//     on the nightly, or the result is REPORTED from outside (#291). An
//     external row therefore has no ▸ run and says so, rather than offering a
//     button that 400s.
//  3. "AREA / SUBJECT" IS ONE FREE-TEXT `feature`, so the Checks tab's filter
//     is a Feature filter and the fold is one level, not two. Ungrouped is a
//     REAL group and sorts last.
//  4. BUGS CLUSTER BY STATUS, THEN BY COVERAGE. They have no area and no
//     subject and no repro field; they have a status (which this screen writes)
//     and, since #278, a check that covers them. The kit's "N uncovered" count
//     is the one label that survives unchanged, because that one was always
//     about the link.
//
// ONE THING NO BROWSER CAN STILL DO: mark a check external. `external` is set
// by the first POST /report and by nothing else, on purpose — a browser able to
// flip a real probe into a reported row could retire a check it never ran.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Bug, BugStatus, Check, CheckHistory, CheckMethod, CheckRun, Severity } from '../types';
import {
  createBug, createCheck, deleteBug, deleteCheck, getCheckHistory, getCheckRuns,
  patchBug, patchCheck, runChecks, type CheckInput,
} from '../store';
import { STATUS_LABEL } from '../lib/ui';
import { isHeld } from '../lib/approval';
import { useAutoRefresh } from '../lib/autoRefresh';
import {
  SEVERITY, SEV_KEYS, UNGROUPED, assertLabel, bugAge, bugGrade, checkResultLine, clusterBugs,
  failSignature, fmtMs, groupByFeature, isGreenFlake, openItems, plural, readHealth, readHistory,
  runBy, sparkline, statStrip, type FeatureGroup, type OpenItem, type SevKey,
} from '../lib/quality';
import { MoreMenu } from '../components/MoreMenu';
import { ConfirmModal } from '../components/ConfirmModal';
import { KitIcon } from './kit/KitIcon';

const METHODS: CheckMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];
const BUG_STATUSES: BugStatus[] = ['open', 'investigating', 'fixing', 'fixed'];

type QTab = 'overview' | 'checks' | 'bugs';

// What the composer edits. Kept as strings because every field is a text input
// or a select — the numeric one is parsed on submit, once.
type CheckDraft = {
  name: string; url: string; method: CheckMethod; expectStatus: string;
  reqBody: string; contains: string; jsonPath: string; jsonExpect: string;
  semantic: string; feature: string; auth: boolean;
};

const EMPTY_DRAFT: CheckDraft = {
  name: '', url: '', method: 'GET', expectStatus: '200', reqBody: '',
  contains: '', jsonPath: '', jsonExpect: '', semantic: '', feature: '', auth: false,
};

const draftOf = (c: Check): CheckDraft => ({
  name: c.name, url: c.url, method: c.method, expectStatus: String(c.expectStatus),
  reqBody: c.reqBody, contains: c.contains, jsonPath: c.jsonPath, jsonExpect: c.jsonExpect,
  semantic: c.semantic, feature: c.feature, auth: c.auth,
});

const toInput = (d: CheckDraft): CheckInput => ({
  name: d.name.trim(), url: d.url.trim(), method: d.method,
  expect_status: Number(d.expectStatus) || 200,
  req_body: d.reqBody.trim(), contains: d.contains.trim(),
  json_path: d.jsonPath.trim(), json_expect: d.jsonExpect.trim(),
  semantic: d.semantic.trim(), feature: d.feature.trim(), auth: d.auth,
});

// What the composer is open FOR. `linkBug` is the bug whose "write a check"
// opened it: on a successful CREATE the new check is linked back to it, which
// is one of the only two writers of `bugs.check_id` anywhere.
type CheckComposerState = { draft: CheckDraft; editing: Check | null; linkBug: string | null } | null;
type BugComposerState = { title: string; severity: Severity; checkId: number | null; checkName: string } | null;
type Pending = { title: string; body: ReactNode; confirmLabel: string; run: () => Promise<void> } | null;

export function Quality({ slug, checks, bugs, onRefresh }: {
  slug: string;
  checks: Check[];
  bugs: Bug[];
  onRefresh: () => void;
}) {
  const [tab, setTab] = useState<QTab>('overview');
  const [sev, setSev] = useState<SevKey | null>(null);
  const [openFeature, setOpenFeature] = useState<string | null>(null);
  const [checkForm, setCheckForm] = useState<CheckComposerState>(null);
  const [bugForm, setBugForm] = useState<BugComposerState>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState('');

  // THE LEDGER AND THE HISTORY ARE THIS SCREEN'S OWN FETCH, and the only one it
  // makes. Neither is in the project payload — they are two aggregate queries
  // nothing else on the app reads — so they are fetched here and re-fetched
  // after anything that writes a result. `checks` and `bugs` arrive as props
  // from the one payload every tab renders from.
  const [runs, setRuns] = useState<CheckRun[]>([]);
  const [history, setHistory] = useState<CheckHistory>({});
  // ARMED IN THE BODY, NOT ONLY CLEARED IN THE CLEANUP. StrictMode mounts every
  // effect twice in development — mount, clean up, mount — so a ref that is
  // only ever set false by a cleanup is false for the rest of the page's life
  // the moment the first teardown runs. The ledger then never lands and a run
  // leaves its rows on "running…" for good, in dev alone, which is exactly
  // where it would be blamed on the server.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const readLedger = useCallback(() => {
    Promise.all([getCheckRuns(slug, 40), getCheckHistory(slug, 20)])
      // An older server 404s the history; an empty one reads as "no memory
      // yet" everywhere it is used, which is the honest degrade.
      .then(([r, h]) => { if (alive.current) { setRuns(r); setHistory(h); } })
      .catch(() => { /* the page still draws from checks alone */ });
  }, [slug]);
  useEffect(() => { readLedger(); }, [readLedger]);

  // Which checks are mid-run. A run is a real HTTP probe with an 8s server-side
  // cap, so the row has to say it is working or a slow check reads as a dead
  // button.
  const [running, setRunning] = useState<ReadonlySet<number>>(new Set());
  const [runningAll, setRunningAll] = useState(false);

  // #312 — the run ledger moves on the HOST's clock (the nightly suite runs
  // while this screen is open), and it is NOT in the payload the parent's own
  // auto-refresh re-reads, so a screen left open would drift: fresh check rows
  // over a stale sparkline and stale diagnoses. Through the shared hook, never
  // a bare setInterval, so one device-local setting still governs every poll.
  // Paused while a run is in flight — that run ends by re-reading this anyway.
  useAutoRefresh(readLedger, !runningAll && running.size === 0);

  const guard = async (fn: () => Promise<void>) => {
    try { setError(''); await fn(); }
    catch (e) { setError((e as Error)?.message || 'Something went wrong.'); }
  };

  // Every write lands the same way: persist, re-read the payload (checks and
  // bugs are props) and re-read this screen's own two queries. A run changes
  // both halves at once, which is why they are never refreshed separately.
  const after = () => { onRefresh(); readLedger(); };

  const mark = (ids: number[], on: boolean) => setRunning((prev) => {
    const next = new Set(prev);
    for (const id of ids) { if (on) next.add(id); else next.delete(id); }
    return next;
  });

  const runScope = (scope: { id: number } | { feature: string } | undefined, ids: number[]) =>
    guard(async () => {
      mark(ids, true);
      if (!scope) setRunningAll(true);
      try { await runChecks(slug, scope); after(); }
      finally { if (alive.current) { mark(ids, false); setRunningAll(false); } }
    });

  const runAll = () => runScope(undefined, checks.filter((c) => !c.external).map((c) => c.id));
  const runOne = (id: number) => runScope({ id }, [id]);
  const runFeature = (g: FeatureGroup) =>
    runScope({ feature: g.key }, g.checks.filter((c) => !c.external).map((c) => c.id));

  const saveCheck = (state: NonNullable<CheckComposerState>) => guard(async () => {
    const input = toInput(state.draft);
    if (state.editing) {
      await patchCheck(slug, state.editing.id, input);
      setCheckForm(null);
      after();
      return;
    }
    const made = await createCheck(slug, input);
    // THE FORM CLOSES THE MOMENT THE CHECK EXISTS, and that ordering is the
    // whole point: the link and the first run are both allowed to fail, and if
    // either threw with the composer still open, pressing Save again would
    // create a SECOND check with the same definition. Nothing after this line
    // can be retried into a duplicate.
    setCheckForm(null);
    // #278's data change, written from the bug's side. Only ever on create: a
    // bug already linked to something is not re-aimed by writing a check.
    // Surfaced if it fails, because a check written FOR a bug that ends up not
    // wearing it is the loop quietly losing its thread.
    if (state.linkBug) {
      await patchBug(slug, state.linkBug, { check_id: made.id })
        .catch((e) => setError(`Check saved, but linking it to ${state.linkBug} failed: ${(e as Error).message}`));
    }
    await runChecks(slug, { id: made.id }).catch(() => { /* a new check may be red; that is a result */ });
    after();
  });

  const removeCheck = (c: Check) => setPending({
    title: `Delete “${c.name}”?`,
    body: <>Its result and its whole history go with it. Any bug filed off it keeps its own record and simply stops being covered.</>,
    confirmLabel: 'Delete check',
    run: async () => { await deleteCheck(slug, c.id); after(); },
  });

  const fileBug = (state: NonNullable<BugComposerState>) => guard(async () => {
    const title = state.title.trim();
    if (!title) return;
    await createBug(slug, { title, severity: state.severity, check_id: state.checkId });
    setBugForm(null);
    after();
  });

  const setBugStatus = (b: Bug, status: BugStatus) =>
    guard(async () => { await patchBug(slug, b.id, { status }); after(); });

  const keepBug = (b: Bug) =>
    guard(async () => { await patchBug(slug, b.id, { reviewed: true }); after(); });

  const unlinkBug = (b: Bug) =>
    guard(async () => { await patchBug(slug, b.id, { check_id: null }); after(); });

  const removeBug = (b: Bug) => setPending({
    title: `Delete ${b.id}?`,
    // Dismissing an extracted bug tombstones its fingerprint so the next push
    // cannot re-file it — that is what Dismiss MEANS and why it has no undo.
    body: b.source === 'hook'
      ? <>This one was read off a push. Deleting it remembers the dismissal, so the next push will not file it again — there is no undo.</>
      : <>It is removed for good.</>,
    confirmLabel: 'Delete bug',
    run: async () => { await deleteBug(slug, b.id); after(); },
  });

  // ---- the derived page ----------------------------------------------------

  const health = useMemo(() => readHealth(checks, bugs), [checks, bugs]);
  const items = useMemo(() => openItems(checks, bugs, history), [checks, bugs, history]);
  const stats = useMemo(() => statStrip(items, health), [items, health]);
  const bars = useMemo(() => sparkline(runs), [runs]);
  const features = useMemo(() => groupByFeature(checks, bugs, history), [checks, bugs, history]);
  const clusters = useMemo(() => clusterBugs(bugs, checks, STATUS_LABEL), [bugs, checks]);
  const checkById = useMemo(() => new Map(checks.map((c) => [c.id, c])), [checks]);

  const rows = (sev ? items.filter((o) => o.severity === sev) : items);
  const lastAll = runs.find((r) => r.scope === 'all');

  // A bug's "write a check" seeds the composer from the bug, so the check that
  // would have caught it starts with its words rather than an empty box.
  const writeCheckFor = (item: OpenItem) => {
    setTab('checks');
    setCheckForm({
      draft: { ...EMPTY_DRAFT, name: item.name.slice(0, 120), feature: '' },
      editing: null, linkBug: item.bugKey,
    });
  };
  const fileBugFor = (c: Check) => {
    setTab('bugs');
    setBugForm({
      title: `${c.name}: ${failSignature(c)}`.slice(0, 300),
      severity: 'high', checkId: c.id, checkName: c.name,
    });
  };

  const act = (item: OpenItem) => {
    if (item.wantsCheck) return { label: 'write a check', write: true, onClick: () => writeCheckFor(item) };
    if (item.canRun && item.checkId != null) {
      return {
        label: running.has(item.checkId) ? 'running…' : item.kind === 'bug' ? '▸ retest' : '▸ re-run',
        write: false, onClick: () => runOne(item.checkId!),
        busy: running.has(item.checkId),
      };
    }
    return null;
  };

  return (
    <div className="ql">
      <div className="ql-head">
        <div className="ql-title">
          <h1>Quality</h1>
          <span className="lede">
            {health.label} — {health.why}
            {lastAll ? ` Last full run ${lastAll.when}.` : ''}
          </span>
        </div>
        <span className="ql-headacts">
          <button className="k-btn sm" onClick={runAll}
            disabled={runningAll || !checks.some((c) => !c.external)}>
            <span className="ql-play">▸</span>{runningAll ? 'Running…' : 'Run all'}
          </button>
          {tab === 'bugs' ? (
            <button className="k-btn sm secondary"
              onClick={() => setBugForm({ title: '', severity: 'medium', checkId: null, checkName: '' })}>
              <KitIcon name="plus" size={13} />Report a bug
            </button>
          ) : (
            <button className="k-btn sm secondary"
              onClick={() => { setTab('checks'); setCheckForm({ draft: EMPTY_DRAFT, editing: null, linkBug: null }); }}>
              <KitIcon name="plus" size={13} />New check
            </button>
          )}
        </span>
      </div>

      {error && <div className="action-error">{error}</div>}

      {/* One strip instead of five tiles: the five numbers read as a sentence
          left to right, and the sparkline is the same suite over its last 30
          FULL runs — a run-one charted beside them would be a dip that never
          happened. */}
      <section className="ql-stats">
        {stats.map((s) => (
          <span className="ql-stat" key={s.l}>
            <span className={`v${s.good ? ' good' : ''}${s.sev ? ` sev-${s.sev} sev-fg` : ''}`}>{s.v}</span>
            <span className="l">{s.l}</span>
          </span>
        ))}
        {bars.length > 1 && (
          <span className="ql-spark">
            <span className="bars">
              {bars.map((b) => (
                <span key={b.key} className={`bar${b.amber ? ' amber' : ''}`}
                  style={{ height: `${b.height}%` }} title={b.title} />
              ))}
            </span>
            <span className="cap">last {bars.length} full runs</span>
          </span>
        )}
      </section>

      <div className="k-tabs ql-tabs">
        {([
          { value: 'overview', label: 'Overview', n: items.length },
          { value: 'checks', label: 'Checks', n: checks.length },
          { value: 'bugs', label: 'Bugs', n: bugs.length },
        ] as { value: QTab; label: string; n: number }[]).map((t) => (
          <button key={t.value} className={`k-tab${tab === t.value ? ' on' : ''}`} onClick={() => setTab(t.value)}>
            {t.label}<span className="n">{t.n}</span>
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          <section className="ql-panel">
            <header className="ql-panelhead">
              <span className="t">Open items</span>
              <span className="ql-sevfilter">
                {SEV_KEYS.map((k) => {
                  const n = items.filter((o) => o.severity === k).length;
                  if (!n) return null;
                  const on = sev === k;
                  return (
                    <button key={k} className={`ql-sevchip sev-${k}${on ? ' on' : ''}`}
                      aria-pressed={on} onClick={() => setSev(on ? null : k)}>
                      <span className="ql-dot" />
                      {SEVERITY[k].label}<span className="n">{n}</span>
                    </button>
                  );
                })}
              </span>
            </header>
            {rows.length === 0 && (
              <p className="ql-empty">
                {items.length
                  ? 'Nothing at that grade. Clear the filter to see the rest.'
                  : checks.length || bugs.length
                    ? 'Nothing needs you. Every check that has run is green and nothing is open.'
                    : 'No checks and no bugs yet — a check is the only automated net this project has.'}
              </p>
            )}
            {rows.map((o) => (
              <OpenRow key={o.key} item={o} action={act(o)}
                onFileBug={o.wantsBug && o.checkId != null && checkById.has(o.checkId)
                  ? () => fileBugFor(checkById.get(o.checkId!)!) : null} />
            ))}
          </section>

          <section className="ql-panel">
            <header className="ql-panelhead">
              <span className="t">By feature</span>
              <span className="sub">
                {plural(checks.length, 'check')} · {plural(features.length, 'feature')}
                {' · pass rate, not coverage'}
              </span>
            </header>
            {features.length === 0 && <p className="ql-empty">Nothing to group yet.</p>}
            {features.map((f) => (
              <FeatureRow key={f.key} feature={f} history={history} running={running}
                open={openFeature === f.key}
                onToggle={() => setOpenFeature(openFeature === f.key ? null : f.key)}
                onRun={runOne} onRunAll={() => runFeature(f)} />
            ))}
          </section>
        </>
      )}

      {tab === 'checks' && (
        <ChecksTab
          checks={checks} history={history} running={running}
          form={checkForm} onForm={setCheckForm}
          onSave={saveCheck} onRun={runOne} onDelete={removeCheck} />
      )}

      {tab === 'bugs' && (
        <>
          {bugForm && (
            <BugComposer state={bugForm} onChange={setBugForm}
              onSubmit={() => fileBug(bugForm)} onClose={() => setBugForm(null)} />
          )}
          <section className="ql-panel">
            <header className="ql-panelhead">
              <span className="t">Bugs</span>
              <span className="sub">
                {plural(bugs.filter((b) => b.status !== 'fixed').length, 'open')} ·{' '}
                {bugs.filter((b) => b.status !== 'fixed' && b.checkId == null).length} uncovered
              </span>
            </header>
            {clusters.length === 0 && <p className="ql-empty">No bugs filed. A push extracts them; ＋ Report a bug files one by hand.</p>}
            {clusters.map((cl) => (
              <BugCluster key={cl.status} cluster={cl} checkById={checkById} running={running}
                onStatus={setBugStatus} onKeep={keepBug} onUnlink={unlinkBug} onDelete={removeBug}
                onRun={runOne}
                onWriteCheck={(b) => { setTab('checks'); setCheckForm({
                  draft: { ...EMPTY_DRAFT, name: b.title.slice(0, 120) }, editing: null, linkBug: b.id,
                }); }} />
            ))}
          </section>
        </>
      )}

      {pending && (
        <ConfirmModal title={pending.title} body={pending.body} confirmLabel={pending.confirmLabel} danger
          onCancel={() => setPending(null)}
          onConfirm={() => { const p = pending; setPending(null); guard(p.run); }} />
      )}
    </div>
  );
}

function SevTag({ severity }: { severity: SevKey }) {
  return (
    <span className={`ql-sevtag sev-${severity}`}>
      <span className="ql-dot" />{SEVERITY[severity].label}
    </span>
  );
}

type RowAction = { label: string; write: boolean; onClick: () => void; busy?: boolean } | null;

function OpenRow({ item, action, onFileBug }: {
  item: OpenItem; action: RowAction; onFileBug: (() => void) | null;
}) {
  return (
    <div className={`ql-openrow sev-${item.severity}`}>
      <span className="ql-dot" />
      <div className="mid">
        <span className="nm">{item.name}</span>
        <span className="sub">{item.detail}{item.meta ? ` · ${item.meta}` : ''}</span>
      </div>
      {item.bugKey && <span className="bug">{item.bugKey}</span>}
      <span className="tag"><SevTag severity={item.severity} /></span>
      {/* A red check nobody has filed against gets the OTHER half of the loop.
          It is a second action rather than a menu because filing the bug is
          the point of looking at this row. */}
      {onFileBug && <button className="ql-act write" onClick={onFileBug}>file a bug</button>}
      {action && (
        <button className={`ql-act${action.write ? ' write' : ''}`}
          onClick={action.onClick} disabled={action.busy}>{action.label}</button>
      )}
    </div>
  );
}

function FeatureRow({ feature, history, running, open, onToggle, onRun, onRunAll }: {
  feature: FeatureGroup; history: CheckHistory; running: ReadonlySet<number>;
  open: boolean; onToggle: () => void; onRun: (id: number) => void; onRunAll: () => void;
}) {
  const runnable = feature.checks.filter((c) => !c.external).length;
  return (
    <>
      <button className={`ql-frow${open ? ' open' : ''}`} onClick={onToggle} aria-expanded={open}
        title={feature.read}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className={`ql-dot${feature.worst ? ` sev-${feature.worst}` : ' clean'}`} />
        <span className="nm">{feature.label}</span>
        <span className="meter">
          {/* No pass is not a failed pass — a group nothing has run in says so
              rather than drawing an empty bar that reads as 0%. */}
          {feature.rate == null ? <span className="clean">never run</span> : (
            <span className={`track${feature.rate === 100 ? '' : ' part'}`}>
              <span className="fill" style={{ width: `${feature.rate}%` }} />
            </span>
          )}
        </span>
        {/* THE NUMBER AGREES WITH THE BAR. Both are over the checks that have
            RUN: `10/15` beside a bar drawn at 83% is two different claims in
            one row, and the never-run difference is said in the fold's own
            sentence and drawn with a clock on each row inside it. */}
        <span className="n">{feature.passing}/{feature.run}</span>
        <span className="avg">{fmtMs(feature.avgMs)}</span>
        <span className="tag">
          {feature.worst ? <SevTag severity={feature.worst} /> : <span className="clean">clean</span>}
        </span>
      </button>
      {open && (
        <div className="ql-fbody">
          <p className="read">{feature.read}</p>
          {feature.checks.map((c) => {
            const h = readHistory(history[c.id]);
            const red = c.lastStatus === 'fail';
            const flake = isGreenFlake(c, h);
            // NEVER RUN IS NOT A PASS, and it gets its own glyph and its own
            // tone here for the same reason the Checks tab gives it one: a
            // green tick over a check nobody has ever run is the NULL-verdict
            // lie in a picture.
            const tone = red ? `sev-${feature.worst || 'broken'}` : flake ? 'sev-flaky' : c.lastStatus ? 'ok' : 'never';
            return (
              <div className="row" key={c.id}>
                <span className={`ico ${tone}`}>
                  <KitIcon name={red || flake ? 'circle-alert' : tone === 'never' ? 'clock' : 'circle-check'} size={12} />
                </span>
                <span className="nm">{c.name}</span>
                <span className="avg">{checkResultLine(c)}</span>
                {c.external
                  ? <span className="ql-act" aria-disabled>reported</span>
                  : <button className="ql-act" onClick={() => onRun(c.id)} disabled={running.has(c.id)}>
                      {running.has(c.id) ? 'running…' : '▸ re-run'}
                    </button>}
              </div>
            );
          })}
          {/* The one browser caller `POST /run {feature}` has. A feature run
              lands a `feature`-scoped row in the ledger, so it never shows up
              in the trend above as a dip. */}
          {runnable > 0 && (
            <div className="row foot">
              <span className="nm">{plural(runnable, 'check')} Stack can probe in this feature</span>
              <button className="ql-act" onClick={onRunAll}>▸ run the feature</button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/* ---------- Checks ---------- */

function ChecksTab({ checks, history, running, form, onForm, onSave, onRun, onDelete }: {
  checks: Check[]; history: CheckHistory; running: ReadonlySet<number>;
  form: CheckComposerState; onForm: (s: CheckComposerState) => void;
  onSave: (s: NonNullable<CheckComposerState>) => void;
  onRun: (id: number) => void; onDelete: (c: Check) => void;
}) {
  const [term, setTerm] = useState('');
  const [feature, setFeature] = useState('__all');
  const [grouped, setGrouped] = useState(true);

  // '' is a real feature, so the "everything" option needs a key that cannot
  // collide with one — hence `__all` rather than an empty string.
  const featureKeys = useMemo(
    () => [...new Set(checks.map((c) => c.feature || ''))].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b))),
    [checks]);

  // A FILTER THAT HAS OUTLIVED ITS FEATURE FALLS BACK TO ALL. Delete the last
  // check under a feature — or edit it into another one — and the select is
  // left pointing at a key no check carries, which renders as a blank control
  // over an empty table: the screen says "no checks" about a suite of sixty.
  // Derived rather than corrected in an effect, so there is no render where
  // the two disagree.
  const live = feature === '__all' || featureKeys.includes(feature) ? feature : '__all';
  const q = term.trim().toLowerCase();
  const rows = checks.filter((c) =>
    (live === '__all' || (c.feature || '') === live)
    && (!q || `${c.name} ${c.feature} ${c.url} ${assertLabel(c)}`.toLowerCase().includes(q)));

  const groups = [...new Set(rows.map((c) => c.feature || ''))]
    .sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    .map((k) => ({ key: k, label: k || UNGROUPED, checks: rows.filter((c) => (c.feature || '') === k) }));

  return (
    <div className="ql-checks">
      <div className="ql-checkbar">
        <span className="searchbox sm ql-search">
          <KitIcon name="search" size={14} />
          <input placeholder="Search checks" aria-label="Search checks"
            value={term} onChange={(e) => setTerm(e.target.value)} />
        </span>
        <select className="km-select sm ql-area" aria-label="Feature"
          value={live} onChange={(e) => setFeature(e.target.value)}>
          <option value="__all">All features</option>
          {featureKeys.map((k) => <option key={k} value={k}>{k || UNGROUPED}</option>)}
        </select>
        <span className="ql-seg">
          {(['Grouped', 'Flat'] as const).map((m) => (
            <button key={m} className={`opt${(m === 'Grouped') === grouped ? ' on' : ''}`}
              onClick={() => setGrouped(m === 'Grouped')}>{m}</button>
          ))}
        </span>
        <span className="ql-checkcount">
          {rows.length} of {checks.length} checks · {rows.filter((c) => c.external).length} reported
        </span>
        {!form && (
          <button className="k-btn sm secondary"
            onClick={() => onForm({ draft: EMPTY_DRAFT, editing: null, linkBug: null })}>
            <KitIcon name="plus" size={13} />New check
          </button>
        )}
      </div>

      {form && (
        <CheckComposer state={form} onChange={onForm} onSubmit={() => onSave(form)}
          onClose={() => onForm(null)}
          onDelete={form.editing ? () => { const c = form.editing!; onForm(null); onDelete(c); } : null} />
      )}

      <section className="ql-panel">
        <div className="ql-crowhead">
          <span className="c-check">Check</span>
          <span className="c-on">Run by</span>
          <span className="c-last">Last</span>
          <span className="c-pass">Pass</span>
          <span className="c-time">Time</span>
          <span className="c-act" />
        </div>
        {rows.length === 0 && (
          <p className="ql-empty">{checks.length ? 'No check matches that.' : 'No checks yet.'}</p>
        )}
        {grouped
          ? groups.map((g) => (
            <CheckGroup key={g.key} group={g} history={history} running={running}
              onRun={onRun} onEdit={(c) => onForm({ draft: draftOf(c), editing: c, linkBug: null })} />
          ))
          : rows.map((c) => (
            <CheckRow key={c.id} check={c} history={history} running={running}
              onRun={onRun} onEdit={() => onForm({ draft: draftOf(c), editing: c, linkBug: null })} />
          ))}
      </section>
    </div>
  );
}

function CheckGroup({ group, history, running, onRun, onEdit }: {
  group: { key: string; label: string; checks: Check[] };
  history: CheckHistory; running: ReadonlySet<number>;
  onRun: (id: number) => void; onEdit: (c: Check) => void;
}) {
  const [open, setOpen] = useState(true);
  const bad = group.checks.filter((c) => c.lastStatus === 'fail').length;
  const never = group.checks.filter((c) => !c.lastStatus).length;
  return (
    <>
      <button className="ql-cgroup" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className="nm">{group.label}</span>
        <span className="n">{group.checks.length}</span>
        {/* Never run is its own state, not a pass and not a failure — the same
            rule as a NULL verdict. */}
        <span className={`state${bad ? ' bad' : ''}`}>
          {bad ? `${bad} not passing` : never === group.checks.length ? 'never run' : never ? `${never} never run` : 'all passing'}
        </span>
      </button>
      {open && group.checks.map((c) => (
        <CheckRow key={c.id} check={c} history={history} running={running}
          onRun={onRun} onEdit={() => onEdit(c)} />
      ))}
    </>
  );
}

function CheckRow({ check, history, running, onRun, onEdit }: {
  check: Check; history: CheckHistory; running: ReadonlySet<number>;
  onRun: (id: number) => void; onEdit: () => void;
}) {
  const h = readHistory(history[check.id]);
  const flake = isGreenFlake(check, h);
  const last = check.lastStatus === 'fail' ? 'failed'
    : !check.lastStatus ? 'never run' : flake ? 'flaky' : 'passed';
  const tone = check.lastStatus === 'fail' ? 'fail'
    : !check.lastStatus ? 'never' : flake ? 'flake' : 'pass';
  const busy = running.has(check.id);
  return (
    <div className="ql-crow">
      <span className="c-check">
        <span className="nm">{check.name}</span>
        <span className="sub">
          {check.feature || UNGROUPED} · {check.method} — asserts {assertLabel(check)}
          {check.lastStatus === 'fail' && check.lastError ? ` · ${check.lastError}` : ''}
          {h.diagnosis ? ` · ${h.diagnosis}` : ''}
        </span>
      </span>
      <span className="c-on">{runBy(check)}</span>
      <span className={`c-last ${tone}`}>{last}</span>
      <span className="c-pass">{h.n ? `${h.n - h.fails}/${h.n}` : '—'}</span>
      <span className="c-time">{fmtMs(check.lastMs)}</span>
      <span className="c-act">
        {/* #291 — an external row's result is reported by something that ran
            outside Stack; probing it here would overwrite that report with the
            outcome of a request that tested nothing. The route 400s it, so the
            button is not offered rather than offered to fail. */}
        {check.external
          ? <span className="ql-act" aria-disabled title="Reported from outside Stack">reported</span>
          : <button className="ql-act" onClick={() => onRun(check.id)} disabled={busy}>
              {busy ? '…' : '▸ run'}
            </button>}
        <button className="ql-act edit" onClick={onEdit}>edit</button>
      </span>
    </div>
  );
}

/* ---------- the two composers ----------
   Both reuse the board dialog's own field classes (`km-field`, `km-input`,
   `km-select`): they are the kit's form row, and a second spelling of a label
   over a control is how two forms drift apart. */

function Composer({ title, submit, disabled, onSubmit, onClose, onDelete, deleteLabel, children }: {
  title: string; submit: string; disabled?: boolean;
  onSubmit: () => void; onClose: () => void;
  onDelete?: (() => void) | null; deleteLabel?: string;
  children: ReactNode;
}) {
  return (
    <section className="ql-composer">
      <span className="t">{title}</span>
      {children}
      <div className="foot">
        {onDelete && <button className="k-btn sm ghost del" onClick={onDelete}>{deleteLabel}</button>}
        <button className="k-btn sm ghost" onClick={onClose}>Cancel</button>
        <button className="k-btn sm accent" onClick={onSubmit} disabled={disabled}>{submit}</button>
      </div>
    </section>
  );
}

function Field({ label, placeholder, hint, value, onChange }: {
  label: string; placeholder: string; hint?: string;
  value: string; onChange: (v: string) => void;
}) {
  return (
    <label className="km-field">
      <span className="lbl">{label}</span>
      <span className="searchbox km-input">
        <input placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
      </span>
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

function Picker<T extends string>({ label, options, labels, value, onChange, hint }: {
  label: string; options: readonly T[]; labels?: Record<string, string>;
  value: T; onChange: (v: T) => void; hint?: string;
}) {
  return (
    <label className="km-field">
      <span className="lbl">{label}</span>
      <select className="km-select" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => <option key={o} value={o}>{labels?.[o] ?? o}</option>)}
      </select>
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

function CheckComposer({ state, onChange, onSubmit, onClose, onDelete }: {
  state: NonNullable<CheckComposerState>;
  onChange: (s: CheckComposerState) => void;
  onSubmit: () => void; onClose: () => void; onDelete: (() => void) | null;
}) {
  const d = state.draft;
  const set = (patch: Partial<CheckDraft>) => onChange({ ...state, draft: { ...d, ...patch } });
  const bodyOk = d.method !== 'GET' && d.method !== 'HEAD';
  const valid = !!d.name.trim() && /^https?:\/\//i.test(d.url.trim());

  return (
    <Composer
      title={state.editing ? `Edit “${state.editing.name}”` : 'New check'}
      submit={state.editing ? 'Save' : 'Add and run'}
      disabled={!valid}
      onSubmit={onSubmit} onClose={onClose}
      onDelete={onDelete} deleteLabel="Delete">
      {state.linkBug && (
        <p className="ql-composernote">
          Filed against <b>{state.linkBug}</b> — this check will remember the bug it was written for.
        </p>
      )}
      {state.editing && !state.editing.external && (
        <p className="ql-composernote">
          Changing anything but the name or the feature clears this check's stored result and its whole history —
          a pass against the old definition would be a lie against the new one.
        </p>
      )}
      <div className="ql-fields">
        <Field label="Name" placeholder="Bugs — collection carries an id" value={d.name} onChange={(name) => set({ name })} />
        <Field label="Feature" placeholder="The read layer" hint="What it tests — blank is the Ungrouped bucket"
          value={d.feature} onChange={(feature) => set({ feature })} />
        <Field label="URL" placeholder="https://…" value={d.url} onChange={(url) => set({ url })} />
        <Picker label="Method" options={METHODS} value={d.method} onChange={(method) => set({ method })} />
        <Field label="Expect status" placeholder="200" value={d.expectStatus} onChange={(expectStatus) => set({ expectStatus })} />
        {bodyOk && <Field label="Request body" placeholder='{"title":"x"}' value={d.reqBody} onChange={(reqBody) => set({ reqBody })} />}
        <Field label="Body contains" placeholder="ok" hint="Optional" value={d.contains} onChange={(contains) => set({ contains })} />
        <Field label="JSON path" placeholder="0.id" hint="Optional dot-path into a JSON response"
          value={d.jsonPath} onChange={(jsonPath) => set({ jsonPath })} />
        <Field label="JSON equals" placeholder="live" hint="Blank = the path only has to exist"
          value={d.jsonExpect} onChange={(jsonExpect) => set({ jsonExpect })} />
        {/* Gemini judges this one, so it degrades silently when there is no key
            — the assertion is simply skipped rather than failing the check. */}
        <Field label="✧ Plain-language expectation" placeholder="the page lists at least one project"
          hint="Judged by Gemini on each run; skipped when no key is configured"
          value={d.semantic} onChange={(semantic) => set({ semantic })} />
      </div>
      <label className="ql-checkbox">
        <input type="checkbox" checked={d.auth} onChange={(e) => set({ auth: e.target.checked })} />
        Run with this project's own token — only ever sent to its own site URL (#261)
      </label>
    </Composer>
  );
}

function BugComposer({ state, onChange, onSubmit, onClose }: {
  state: NonNullable<BugComposerState>;
  onChange: (s: BugComposerState) => void;
  onSubmit: () => void; onClose: () => void;
}) {
  return (
    <Composer title="Report a bug" submit="File bug" disabled={!state.title.trim()}
      onSubmit={onSubmit} onClose={onClose}>
      {state.checkName && (
        <p className="ql-composernote">
          ↳ filed from <b>{state.checkName}</b> — the bug will remember the check that caught it, and the check will wear the bug.
        </p>
      )}
      <div className="ql-fields">
        <Field label="What happened" placeholder="Response drops the id field"
          value={state.title} onChange={(title) => onChange({ ...state, title })} />
        <Picker label="Severity" options={SEVERITIES} value={state.severity}
          onChange={(severity) => onChange({ ...state, severity })}
          hint="Critical reads as Blocking on this page; low as Cosmetic" />
      </div>
    </Composer>
  );
}

/* ---------- Bugs ---------- */

function BugCluster({ cluster, checkById, running, onStatus, onKeep, onUnlink, onDelete, onRun, onWriteCheck }: {
  cluster: ReturnType<typeof clusterBugs>[number];
  checkById: Map<number, Check>;
  running: ReadonlySet<number>;
  onStatus: (b: Bug, s: BugStatus) => void;
  onKeep: (b: Bug) => void;
  onUnlink: (b: Bug) => void;
  onDelete: (b: Bug) => void;
  onRun: (id: number) => void;
  onWriteCheck: (b: Bug) => void;
}) {
  const [open, setOpen] = useState(cluster.status !== 'fixed');
  return (
    <>
      <button className={`ql-barea${cluster.worst ? ` sev-${cluster.worst}` : ''}`}
        onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className="nm">{cluster.label}</span>
        <span className="n">{plural(cluster.bugs.length, 'bug')}</span>
        {cluster.uncovered > 0 && <span className="unc">{cluster.uncovered} uncovered</span>}
        <span className="tag">
          {cluster.worst ? <SevTag severity={cluster.worst} /> : <span className="clean">closed</span>}
        </span>
      </button>

      {open && cluster.subjects.map((sub) => (
        <div className="ql-subject-group" key={sub.subject}>
          <div className="ql-subject">
            <span className={`ql-dot${sub.covered ? ' clean' : ''}`} />
            <span className="nm">{sub.subject}</span>
            <span className="n">{sub.bugs.length}</span>
            <span className="rule" />
          </div>
          {sub.bugs.map((b) => (
            <BugRow key={b.id} bug={b} cover={b.checkId == null ? null : checkById.get(b.checkId) ?? null}
              running={running} onStatus={onStatus} onKeep={onKeep} onUnlink={onUnlink}
              onDelete={onDelete} onRun={onRun} onWriteCheck={onWriteCheck} />
          ))}
        </div>
      ))}
    </>
  );
}

function BugRow({ bug, cover, running, onStatus, onKeep, onUnlink, onDelete, onRun, onWriteCheck }: {
  bug: Bug; cover: Check | null; running: ReadonlySet<number>;
  onStatus: (b: Bug, s: BugStatus) => void;
  onKeep: (b: Bug) => void;
  onUnlink: (b: Bug) => void;
  onDelete: (b: Bug) => void;
  onRun: (id: number) => void;
  onWriteCheck: (b: Bug) => void;
}) {
  // A hook-extracted bug nobody has signed off is HELD from the overnight
  // runner (#359). The Dashboard's review deck was the only surface that could
  // keep one while this tab was a mockup; Keep is back here, where the bug is.
  //
  // THROUGH `isHeld`, NOT SPELLED AGAIN. The rule already exists three times
  // (server/src, scripts/lib, web/src/lib) because no package can import
  // another, and a fourth copy inside one of those packages is the one with no
  // excuse. The hand-rolled version here read `source !== 'manual'`, which is
  // the same answer today and the WRONG DIRECTION tomorrow: a source nobody
  // has taught it about would be treated as held, and blocking work a human
  // typed is the failure mode this feature must not have.
  const held = isHeld(bug);
  const options = [
    ...(held ? [{ key: 'keep', label: 'Keep — sign it off', onSelect: () => onKeep(bug) }] : []),
    ...(cover ? [{ key: 'unlink', label: 'Unlink its check', onSelect: () => onUnlink(bug) }] : []),
    { key: 'delete', label: bug.source === 'hook' ? 'Dismiss (no undo)' : 'Delete', danger: true, onSelect: () => onDelete(bug) },
  ];
  const busy = cover != null && running.has(cover.id);

  return (
    <div className="ql-brow">
      <span className="id">{bug.id}</span>
      <span className="t" title={cover ? `Covered by “${cover.name}”` : undefined}>{bug.title}</span>
      {held && <span className="ql-held" title="Read off a push; held from the overnight runner until it is kept">held</span>}
      {/* The status is the one thing about a bug this screen writes, so it is a
          control on the row rather than a line in a menu. */}
      <select className="km-select sm ql-bstatus" aria-label={`Status of ${bug.id}`}
        value={bug.status} onChange={(e) => onStatus(bug, e.target.value as BugStatus)}>
        {BUG_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
      </select>
      <span className="tag"><SevTag severity={bugGrade(bug.severity)} /></span>
      <span className="age">{bugAge(bug)}</span>
      {cover && !cover.external
        ? <button className="ql-act" onClick={() => onRun(cover.id)} disabled={busy}>{busy ? '…' : '▸ retest'}</button>
        : cover
          ? <span className="ql-act" aria-disabled>reported</span>
          : <button className="ql-act write" onClick={() => onWriteCheck(bug)}>write a check</button>}
      <MoreMenu options={options} small label={`More for ${bug.id}`} />
    </div>
  );
}
