// THE DEVELOPMENT TAB (the Board Map design's Development, 2026-11-21): pushes
// on a branch graph, by the session or run that made them, with the host's
// branches beside them.
//
// WHERE THE ROWS COME FROM. Stack keeps no git log of its own, so the graph is
// drawn from what it did record: `GET /ledger` (each Claude session with the
// commit it ended on, and each autopilot run), autopilot jobs still going, and
// each reported branch's tip. A lane is a BRANCH NAME, not git ancestry: a
// lane joins main at the next main row below its oldest row, which is where it
// most likely forked, and the caption says so. Nothing here may claim a merge
// it did not see.
//
// TWO POPULATIONS. A session's tokens and a run's spend are never summed
// (root CLAUDE.md). A run whose suite never ran reads "not run", never green,
// and a run with no second-model review reads NO REVIEW. A session row has no
// checks of its own and reads "—".
//
// FAIL SILENT on the host. Branches and worktrees come from the dispatcher's
// report; with no report the panel says Stack cannot see them, never that
// there are none. `unprobed` is not `clean` (lib/branch.ts).
//
// NOTHING HERE WRITES except Run in terminal, which is the Board's own write
// (`onRun`). A merge follows a verdict and is queued through the API.
//
// AN `#N` IN A SUMMARY IS LINKED ONLY WHEN THE ROADMAP HAS THAT ID. Items, bugs
// and futures are separate sequences all written "#N".

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Markdown } from '../components/Markdown';
import type { RoadmapItem } from '../types';
import { getBranchReport, getLedger } from '../store';
import type { BranchReport, ReportedBranch, ReportedWorktree, LedgerEntry, LedgerNow } from '../store';
import { mergeStateOf, MERGE_STATE_META, parseBranch } from '../lib/branch';
import { useAutoRefresh } from '../lib/autoRefresh';
import { timeAgo } from '../lib/ui';

type Tone = 'danger' | 'info' | 'warning' | 'success' | 'neutral';
type Filter = 'all' | 'tracked' | 'main';

// A report older than this reads as stale: the dispatcher posts every few minutes.
const REPORT_STALE_MS = 30 * 60_000;
const QUIET_MS = 15 * 60_000;
const RH = 56;                 // a graph row's height; the SVG is drawn to it
const LANES = 6;               // main plus five; more branches share lanes
const X = (l: number) => 10 + l * 18;
const Y = (i: number) => i * RH + RH / 2;
const LANE_COLOR = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-6)', 'var(--viz-3)', 'var(--viz-5)', 'var(--viz-4)'];

// ---- small readers ---------------------------------------------------------

const tok = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M tok` : n >= 1000 ? `${Math.round(n / 1000)}k tok` : `${n} tok`;
const ago = (iso: string | null | undefined) => timeAgo(iso).replace(' ago', '');

// The `#N` references in a summary, in order of first mention.
export function refsIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(?<![\w&/])#(\d{1,6})\b/g)) {
    const n = Number(m[1]);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

// The first real line of a summary, so a row reads as a sentence.
function lede(text: string): string {
  for (const raw of text.split('\n')) {
    const l = raw.replace(/^\s*(?:#+|[-*]|\d+\.)\s*/, '').replace(/\*\*|`/g, '').trim();
    if (l) return l;
  }
  return '';
}

// A worktree holds work origin cannot see: uncommitted, unpushed, or ahead with no upstream.
const holdsWork = (w: ReportedWorktree) =>
  w.dirty > 0 || (w.unpushed ?? 0) > 0 || (w.unpushed === null && w.ahead > 0);

// ---- the rows --------------------------------------------------------------

interface Push {
  key: string; hash: string; branch: string; msg: string; at: string;
  who: string; itemId: number | null;
  check: { label: string; tone: Tone };
  entry?: LedgerEntry; tip?: ReportedBranch; job?: LedgerNow['jobs'][number];
}

const NO_CHECK = { label: '—', tone: 'neutral' as Tone };

export function buildPushes(entries: LedgerEntry[], now: LedgerNow | null, report: BranchReport | null,
  known: (id: number) => boolean): Push[] {
  const out: Push[] = [];
  for (const j of now?.jobs || []) {
    out.push({ key: `j-${j.id}`, hash: '', branch: j.branch || 'main', msg: j.itemTitle || j.detail || `Autopilot ${j.kind}`,
      at: j.startedAt || j.createdAt || '', who: `autopilot ${j.kind}`, itemId: j.itemId,
      check: { label: j.status, tone: j.status === 'running' ? 'info' : j.status === 'paused' ? 'warning' : 'neutral' }, job: j });
  }
  for (const e of entries) {
    if (e.kind === 'session') {
      out.push({ key: `s-${e.id}`, hash: e.commit.slice(0, 7), branch: e.branch || 'main',
        msg: lede(e.summary) || '(no summary recorded)', at: e.at,
        who: e.authored ? 'checkpoint' : `session ${e.sessionId.slice(0, 8)}`,
        itemId: refsIn(e.summary).find(known) ?? null, check: NO_CHECK, entry: e });
    } else {
      out.push({ key: `r-${e.id}`, hash: '', branch: e.branch || 'main', msg: e.itemTitle || lede(e.summary) || '(no summary recorded)',
        at: e.at, who: e.tmuxSession || 'autopilot', itemId: e.itemId,
        check: e.checksFailing === null ? { label: 'not run', tone: 'neutral' }
          : e.checksFailing === 0 ? { label: 'green', tone: 'success' } : { label: `${e.checksFailing} failing`, tone: 'danger' },
        entry: e });
    }
  }
  // A reported branch whose tip no recorded row stands for.
  for (const b of report?.branches || []) {
    if (b.ahead === 0 || out.some((p) => p.branch === b.branch)) continue;
    out.push({ key: `b-${b.branch}`, hash: '', branch: b.branch, msg: b.subject || '(no subject)', at: b.committedAt || '',
      who: 'branch tip', itemId: b.itemId ?? parseBranch(b.branch).itemId, check: NO_CHECK, tip: b });
  }
  return out.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
}

// ---- the view --------------------------------------------------------------

export function DevelopmentView({ slug, items, onOpen, onCount, onShowOnMap, onRun }: {
  slug: string; items: RoadmapItem[]; onOpen: (it: RoadmapItem) => void;
  onCount?: (n: number | null) => void;
  onShowOnMap: (it: RoadmapItem) => void;
  onRun: (it: RoadmapItem) => void;
}) {
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [now, setNow] = useState<LedgerNow | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [paged, setPaged] = useState(false);
  const [more, setMore] = useState(false);
  const [report, setReport] = useState<BranchReport | null>(null);
  const [reportErr, setReportErr] = useState(false);
  const [failed, setFailed] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selBranch, setSelBranch] = useState<string | null>(null);
  const [selPush, setSelPush] = useState<string | null>(null);
  const [side, setSide] = useState(true);

  const byId = useMemo(() => new Map(items.map((r) => [r.id, r])), [items]);

  // A poll replaces the first page while nothing older is loaded; once the
  // reader has paged back, it only adds entries newer than the top.
  const readTop = useCallback(async (fresh: boolean) => {
    try {
      const page = await getLedger(slug);
      setNow(page.now);
      setFailed('');
      if (fresh || !paged) {
        setEntries(page.entries); setNext(page.nextBefore);
        if (fresh) setPaged(false);
        return;
      }
      setEntries((prev) => {
        const top = prev?.[0]?.at || '';
        return [...page.entries.filter((e) => e.at > top), ...(prev || [])];
      });
    } catch (e) { setFailed((e as Error)?.message || 'Could not read the session ledger.'); }
  }, [slug, paged]);

  const readReport = useCallback(async () => {
    try {
      const r = await getBranchReport(slug);
      setReport(r); setReportErr(false);
      onCount?.(r.reportedAt ? r.branches.filter((b) => b.ahead > 0).length : null);
    } catch { setReportErr(true); }
  }, [slug]);

  useEffect(() => { setEntries(null); readTop(true); }, [slug]);
  useEffect(() => { readReport(); }, [readReport]);
  useAutoRefresh(() => { readTop(false); readReport(); });

  const loadMore = async () => {
    if (!next) return;
    setMore(true);
    try {
      const page = await getLedger(slug, { before: next });
      setEntries((prev) => [...(prev || []), ...page.entries]);
      setNext(page.nextBefore); setPaged(true);
    } catch (e) { setFailed((e as Error)?.message || 'Could not read older entries.'); }
    finally { setMore(false); }
  };

  const all = useMemo(() => buildPushes(entries || [], now, report, (n) => byId.has(n)), [entries, now, report, byId]);
  const tracked = (branch: string, itemId: number | null) =>
    branch === 'main' || itemId !== null || parseBranch(branch).itemId !== null || parseBranch(branch).bugKey !== '';
  const pushes = all.filter((p) => filter === 'all' || (filter === 'main' ? p.branch === 'main' : tracked(p.branch, p.itemId)));

  // Lanes: main is 0, the rest by first appearance (newest first).
  const lane = new Map<string, number>([['main', 0]]);
  for (const p of pushes) if (!lane.has(p.branch)) lane.set(p.branch, 1 + ((lane.size - 1) % (LANES - 1)));
  const laneOf = (b: string) => lane.get(b) ?? 0;
  const colorOf = (b: string) => LANE_COLOR[laneOf(b)];
  const dim = (b: string) => !!selBranch && selBranch !== 'main' && b !== selBranch && b !== 'main';

  const paths = (() => {
    const out: { d: string; color: string; o: number; dashed: boolean; w: number }[] = [];
    const mainRows = pushes.map((p, i) => (p.branch === 'main' ? i : -1)).filter((i) => i >= 0);
    if (pushes.length) out.push({ d: `M${X(0)} ${Y(0)} L${X(0)} ${Y(pushes.length - 1)}`, color: LANE_COLOR[0], o: 1, dashed: false, w: 2.5 });
    for (const [b, l] of lane) {
      if (b === 'main') continue;
      const rows = pushes.map((p, i) => (p.branch === b ? i : -1)).filter((i) => i >= 0);
      if (!rows.length) continue;
      const top = rows[0], bottom = rows[rows.length - 1], x = X(l);
      const fork = mainRows.find((i) => i > bottom);
      const d = fork === undefined
        ? `M${x} ${Y(top)} L${x} ${Y(pushes.length - 1) + RH / 2}`
        : `M${x} ${Y(top)} L${x} ${Y(fork) - 22} Q${x} ${Y(fork)}, ${X(0)} ${Y(fork)}`;
      const untracked = !tracked(b, null) && !pushes.some((p) => p.branch === b && p.itemId !== null);
      out.push({ d, color: LANE_COLOR[l], o: dim(b) ? 0.3 : 1, dashed: untracked, w: 2 });
    }
    return out;
  })();

  const lastMain = all.find((p) => p.branch === 'main' && p.hash);
  const picked = pushes.find((p) => p.key === selPush) || null;
  const pickedItem = picked?.itemId != null ? byId.get(picked.itemId) : undefined;

  return (
    <div className={`dv-view${side ? '' : ' side-closed'}`}>
      <div className="dv-main">
        <div className="bl-head">
          <div className="bl-headtext">
            <h2>Development</h2>
            <span className="d">
              Pushes and runs, by the session that made them.{' '}
              {lastMain ? <>The last commit Stack recorded on <span className="mono">main</span> is <span className="mono link">{lastMain.hash}</span>.</>
                : 'No session has recorded a commit on main yet.'}
            </span>
          </div>
          <div className="bl-chips">
            {([['all', 'All branches'], ['tracked', 'Tracked work'], ['main', 'main only']] as [Filter, string][]).map(([k, label]) => (
              <button key={k} className={`bl-chip${filter === k ? ' on' : ''}`} onClick={() => setFilter(k)}>{label}</button>
            ))}
          </div>
        </div>

        {failed && <div className="km-err" role="alert">{failed}</div>}

        <div className="dv-cols dv-grid" aria-hidden>
          <span>Graph</span><span className="c-hash">Commit</span><span>Push</span><span>Checks</span><span className="c-when">When</span>
        </div>
        <div className={`dv-graph${entries !== null ? ' ready' : ''}`}>
          <svg className="dv-svg" width={X(LANES - 1) + 14} height={Math.max(1, pushes.length * RH)} aria-hidden>
            {paths.map((p, i) => (
              <path key={i} d={p.d} fill="none" style={{ stroke: p.color, strokeWidth: p.w, opacity: p.o }}
                strokeDasharray={p.dashed ? '3 3' : undefined} />
            ))}
            {pushes.map((p, i) => (
              <circle key={p.key} cx={X(laneOf(p.branch))} cy={Y(i)} r={4.75}
                style={{ fill: 'var(--surface-sunken)', stroke: colorOf(p.branch), strokeWidth: 2.5, opacity: dim(p.branch) ? 0.3 : 1 }} />
            ))}
          </svg>
          {entries === null && !failed && <span className="dv-say">Reading the ledger…</span>}
          {entries !== null && pushes.length === 0 && (
            <span className="dv-say">
              {filter === 'all' ? 'No session or run has reported for this project yet. The SessionEnd hook records one when a Claude Code session ends.'
                : 'Nothing recorded matches this filter.'}
            </span>
          )}
          {pushes.map((p) => {
            const it = p.itemId !== null ? byId.get(p.itemId) : undefined;
            return (
              <div key={p.key} className={`dv-row dv-grid${selPush === p.key ? ' on' : ''}${dim(p.branch) ? ' dim' : ''}`}
                onClick={() => { setSelBranch(p.branch); setSelPush(p.key); setSide(true); }}
                onDoubleClick={() => { if (it) onOpen(it); }}>
                <span />
                <span className="c-hash hash">{p.hash || (p.job ? 'live' : p.tip ? 'tip' : '—')}</span>
                <span className="push">
                  <span className="msg">{p.msg}</span>
                  <span className="meta">
                    <span className="sw" style={{ background: colorOf(p.branch) }} />
                    <span className="br">{p.branch}</span>
                    <span>{p.who}</span>
                    {it && (
                      <span className="ref" role="link" tabIndex={0} title={it.title}
                        onClick={(e) => { e.stopPropagation(); onShowOnMap(it); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onShowOnMap(it); } }}>#{it.id}</span>
                    )}
                  </span>
                </span>
                <span className={`chk k-tag${p.check.tone === 'neutral' || p.check.tone === 'info' ? (p.check.tone === 'info' ? ' info' : '') : ` ${p.check.tone}`}`}>{p.check.label}</span>
                <span className="c-when when">{ago(p.at)}</span>
              </div>
            );
          })}
        </div>
        {next && (
          <button className="k-btn sm secondary dv-more" onClick={loadMore} disabled={more}>
            {more ? 'Reading…' : 'Older entries'}
          </button>
        )}
        <span className="bl-note">
          A lane is a branch name, not git ancestry: it joins main where it most likely forked. Lanes with no tracked
          item show dashed. Double-click a row to open its item.
        </span>
      </div>

      <aside className="bl-side dv-side">
        {!side ? (
          <button className="bl-sideopen" onClick={() => setSide(true)} title="Expand">
            <span>«</span><span className="v">Branches</span>
          </button>
        ) : (
          <>
            <button className="bl-sidex" onClick={() => setSide(false)} title="Collapse">»</button>
            {picked && <PushDetail p={picked} item={pickedItem} byId={byId} onOpen={onOpen} onClose={() => setSelPush(null)} />}
            <Branches report={report} reportErr={reportErr} now={now} byId={byId} filter={filter}
              colorOf={(b) => (lane.has(b) ? colorOf(b) : 'var(--grey-500)')}
              selected={selBranch} onSelect={(b) => setSelBranch(selBranch === b ? null : b)}
              onOpen={onOpen} onShowOnMap={onShowOnMap} onRun={onRun} />
          </>
        )}
      </aside>
    </div>
  );
}

// ---- the selected push -----------------------------------------------------

function PushDetail({ p, item, byId, onOpen, onClose }: {
  p: Push; item: RoadmapItem | undefined; byId: Map<number, RoadmapItem>;
  onOpen: (it: RoadmapItem) => void; onClose: () => void;
}) {
  const e = p.entry;
  const meta: string[] = [];
  if (e?.kind === 'session') {
    if (e.model) meta.push(e.model.replace(/^claude-/, ''));
    if (e.tokens > 0) meta.push(tok(e.tokens));
    if (e.filesTotal > 0) meta.push(`${e.filesTotal} file${e.filesTotal === 1 ? '' : 's'}`);
  } else if (e?.kind === 'run') {
    meta.push(`${e.commits} commit${e.commits === 1 ? '' : 's'}`);
    if (e.tokens > 0) meta.push(tok(e.tokens));
    if (e.costUsd > 0) meta.push(`$${e.costUsd.toFixed(2)}`);
    meta.push(e.reviewVerdict ? `review: ${e.reviewVerdict}` : 'no review');
  } else if (p.tip) {
    meta.push(`↑${p.tip.ahead} ↓${p.tip.behind}`, `+${p.tip.adds} −${p.tip.dels}`);
  }
  const refs = e?.kind === 'session' ? refsIn(e.summary).filter((n) => byId.has(n)).slice(0, 6) : [];
  return (
    <div className="dv-push">
      <div className="bl-sidetop">
        <span className="kind">{p.job ? 'Live job' : e?.kind === 'run' ? 'Autopilot run' : e ? 'Session' : 'Branch tip'}</span>
        {p.hash && <span className="id">{p.hash}</span>}
        <span className="sp" />
        <button className="dv-x" onClick={onClose} aria-label="Close">×</button>
      </div>
      <span className="bl-sideunder mono">{p.branch} · {timeAgo(p.at)}</span>
      {meta.length > 0 && <span className="bl-sideunder">{meta.join(' · ')}</span>}
      <div className="dv-pushbody">
        {e?.summary ? <Markdown text={e.summary} /> : <p>{p.msg}</p>}
      </div>
      {(item || refs.length > 0) && (
        <div className="dv-refs">
          {item && <button className="k-btn sm" onClick={() => onOpen(item)}>Open #{item.id}</button>}
          {refs.filter((n) => n !== item?.id).map((n) => (
            <button key={n} className="k-btn sm ghost" title={byId.get(n)!.title} onClick={() => onOpen(byId.get(n)!)}>#{n}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- branches --------------------------------------------------------------

function Branches({ report, reportErr, now, byId, filter, colorOf, selected, onSelect, onOpen, onShowOnMap, onRun }: {
  report: BranchReport | null; reportErr: boolean; now: LedgerNow | null; byId: Map<number, RoadmapItem>;
  filter: Filter; colorOf: (b: string) => string; selected: string | null; onSelect: (b: string) => void;
  onOpen: (it: RoadmapItem) => void; onShowOnMap: (it: RoadmapItem) => void; onRun: (it: RoadmapItem) => void;
}) {
  const [showLevel, setShowLevel] = useState(false);
  const seen = !!report?.reportedAt;
  const stale = seen && !(Date.now() - Date.parse(report!.reportedAt!) < REPORT_STALE_MS);
  const itemOf = (b: ReportedBranch) => {
    const id = b.itemId ?? parseBranch(b.branch).itemId;
    return id === null ? undefined : byId.get(id);
  };
  const branches = (report?.branches || []).filter((b) => filter !== 'tracked' || itemOf(b) || parseBranch(b.branch).bugKey);
  const open = filter === 'main' ? [] : branches.filter((b) => b.ahead > 0);
  const level = filter === 'main' ? [] : branches.filter((b) => b.ahead === 0);
  const mainTree = report?.worktrees.find((w) => w.main);
  const trees = (report?.worktrees || []).filter((w) => !w.main && holdsWork(w));
  const liveOn = (branch: string) => (now?.sessions || []).find((s) => s.branch === branch);

  const card = (b: ReportedBranch) => {
    const it = itemOf(b);
    const st = mergeStateOf(b);
    const tone = st === 'conflict' ? 'danger' : st === 'clean' ? 'success' : st === 'behind' ? 'warning' : '';
    const sess = liveOn(b.branch);
    const quiet = sess && !(sess.lastSeenAt && Date.now() - Date.parse(sess.lastSeenAt) < QUIET_MS);
    const on = selected === b.branch;
    return (
      <div key={b.branch} className={`dv-branch${on ? ' on' : ''}`} onClick={() => onSelect(b.branch)}>
        <div className="top">
          <span className="sw" style={{ background: colorOf(b.branch) }} />
          <span className="name">{b.branch}</span>
          {b.ahead > 0
            ? <span className={`k-tag${tone ? ` ${tone}` : ''}`} title={MERGE_STATE_META[st].hint}>{MERGE_STATE_META[st].label}</span>
            : <span className="k-tag">level</span>}
        </div>
        <div className="meta">
          {sess && <span className="live"><span className={`dot${quiet ? ' quiet' : ''}`} />{quiet ? 'quiet session' : 'live session'}</span>}
          {it && <span className="ref">#{it.id}</span>}
          <span>{b.ahead} ahead · {b.behind} behind</span>
          {b.files > 0 && <span>+{b.adds} −{b.dels}</span>}
          <span>{ago(b.committedAt)}</span>
        </div>
        {on && (
          <>
            <span className="subj">{it ? it.title : b.subject || '(no subject)'}</span>
            {it && (
              <div className="acts">
                <button className="k-btn sm" onClick={(e) => { e.stopPropagation(); onOpen(it); }}>Open #{it.id}</button>
                <button className="k-btn sm secondary" onClick={(e) => { e.stopPropagation(); onShowOnMap(it); }}>Show on map</button>
                {!it.done && it.claimedBy.trim() === '' && (
                  <button className="k-btn sm secondary" onClick={(e) => { e.stopPropagation(); onRun(it); }}>Run in terminal</button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="dv-branches">
      <div className="dv-bhead"><span className="t">Branches</span>{seen && <span className="n">{open.length} open</span>}</div>
      {!seen && (
        <span className="dv-say">
          {reportErr ? 'Could not read the host report, so' : 'The host has not reported this project’s branches, so'} Stack
          cannot see branches or unpushed work here.
        </span>
      )}
      {stale && <span className="dv-say">The host’s report is from {timeAgo(report!.reportedAt)}; the dispatcher has stopped posting.</span>}
      {mainTree && (
        <div className={`dv-branch${selected === 'main' ? ' on' : ''}`} onClick={() => onSelect('main')}>
          <div className="top">
            <span className="sw" style={{ background: 'var(--viz-1)' }} />
            <span className="name">main</span>
            <span className="k-tag">shared checkout</span>
          </div>
          <div className="meta">
            <span className="mono">{mainTree.head.slice(0, 7)}</span>
            <span>{ago(mainTree.committedAt)}</span>
            {mainTree.dirty > 0 && <span>{mainTree.dirty} uncommitted</span>}
          </div>
        </div>
      )}
      {open.map(card)}
      {seen && open.length === 0 && filter !== 'main' && <span className="dv-say">No branch has work ahead of main.</span>}
      {level.length > 0 && (
        <>
          <button className="k-btn sm ghost" onClick={() => setShowLevel(!showLevel)}>
            {showLevel ? 'Hide' : 'Show'} {level.length} branch{level.length === 1 ? '' : 'es'} level with main
          </button>
          {showLevel && level.map(card)}
        </>
      )}
      {trees.length > 0 && (
        <>
          <div className="dv-bhead"><span className="t">Not pushed</span><span className="n">{trees.length}</span></div>
          {trees.map((w) => (
            <div key={w.path} className="dv-branch" title={w.path}>
              <div className="top">
                <span className="name">{w.branch || w.head.slice(0, 7)}{w.main ? ' (shared checkout)' : ''}</span>
                <span className="k-tag warning">holds work</span>
              </div>
              <div className="meta">
                {w.dirty > 0 && <span>{w.dirty} uncommitted</span>}
                {(w.unpushed ?? 0) > 0 && <span>{w.unpushed} unpushed</span>}
                {w.unpushed === null && w.ahead > 0 && <span>{w.ahead} ahead, no upstream</span>}
                <span>{w.subject}</span>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
