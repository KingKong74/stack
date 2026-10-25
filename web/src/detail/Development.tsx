// THE DEVELOPMENT TAB — the project's audit trail: what Claude is doing now,
// and what every session and autopilot run did. The board's third tab.
//
// Solo development lands on main, so branches are the exception here, not
// the frame. Three sections, top to bottom:
//
//  1. NOW. Claude sessions whose hook pinged recently (`presence`), autopilot
//     jobs not yet finished, items claimed but not built, and host worktrees
//     holding work origin cannot see. Presence is a heartbeat with a long TTL,
//     so a session reads as LAST HEARD at a time, never as provably alive.
//  2. THE LEDGER. `GET /ledger`: interactive sessions and autopilot runs on one
//     timeline, grouped by local day. Each entry keeps its own spend, and this
//     file never adds a session's tokens to a run's: they are two populations
//     (root CLAUDE.md). A run with no review reads NO REVIEW, never clean; a
//     run whose suite never ran reads that, never green. A review read is an
//     agent's annotation, so it is drawn as a plain tag, never a verdict tone.
//  3. BRANCHES, only when origin has any. The groups are `mergeStateOf`'s
//     states and `unprobed` is not `clean` (lib/branch.ts).
//
// FAIL SILENT on the host. The worktrees and branches come from the
// dispatcher's report; with no report the tab says Stack cannot see them,
// never that there are none.
//
// NOTHING HERE WRITES. A merge follows a verdict and the Inbox queues it; the
// one action is opening an item, which is the board's own item modal.
//
// AN `#N` IN A SUMMARY IS LINKED ONLY WHEN THE ROADMAP HAS THAT ID. Items, bugs
// and futures are separate sequences all written "#N", so an id this project's
// roadmap doesn't hold stays plain text rather than opening the wrong thing.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { KitIcon } from './kit/KitIcon';
import { Markdown } from '../components/Markdown';
import type { RoadmapItem } from '../types';
import { getBranchReport, getLedger } from '../store';
import type {
  BranchReport, ReportedBranch, ReportedWorktree, LedgerEntry, LedgerNow, LedgerRun, LedgerSession,
} from '../store';
import { mergeStateOf, isMergeable, MERGE_STATE_META, parseBranch } from '../lib/branch';
import { isBuilt } from '../lib/plan';
import { useAutoRefresh } from '../lib/autoRefresh';
import { timeAgo, dayLabel } from '../lib/ui';

type Tone = 'danger' | 'info' | 'warning' | 'success' | 'neutral';
type Kind = '' | 'session' | 'run';

// A report older than this reads as stale. The dispatcher posts every few
// minutes, so half an hour means it has stopped, not that it is slow.
const REPORT_STALE_MS = 30 * 60_000;
// A presence ping older than this reads "quiet": the hook pings on activity,
// so a session sitting at its prompt goes quiet long before its row expires.
const QUIET_MS = 15 * 60_000;

const KIND_CHIPS: { value: Kind; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'session', label: 'Claude sessions' },
  { value: 'run', label: 'Autopilot runs' },
];

// ---- small readers ---------------------------------------------------------

const tok = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M tok` : n >= 1000 ? `${Math.round(n / 1000)}k tok` : `${n} tok`;

const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};

const model = (m: string) => m.replace(/^claude-/, '');

// Sessions record absolute paths, often inside a scratch worktree. Drawn
// relative to the checkout they were in, so one file reads the same whichever
// worktree touched it.
export function shortPath(p: string, cwd = ''): string {
  if (cwd && p.startsWith(`${cwd}/`)) return p.slice(cwd.length + 1);
  const m = /\/(?:scratchpad\/[^/]+|\.?stack-wt-[^/]+|\.stack\/autopilot\/[^/]+|stack)\/(.+)$/.exec(p);
  if (m) return m[1];
  return p.replace(/^\/home\/[^/]+\//, '~/');
}

// The `#N` references in a summary, in order of first mention.
export function refsIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(?<![\w&/])#(\d{1,6})\b/g)) {
    const n = Number(m[1]);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

// The first real line of a summary: headings and list markers stripped, so
// a collapsed row reads as a sentence.
function lede(text: string): string {
  for (const raw of text.split('\n')) {
    const l = raw.replace(/^\s*(?:#+|[-*]|\d+\.)\s*/, '').replace(/\*\*|`/g, '').trim();
    if (l) return l;
  }
  return '';
}

const OUTCOME_TONE: Record<string, Tone> = {
  landed: 'success', failed: 'danger', limit: 'warning', 'no-commits': 'neutral', planned: 'neutral',
};

// ---- the view --------------------------------------------------------------

export function DevelopmentView({ slug, items, onOpen }: {
  slug: string; items: RoadmapItem[]; onOpen: (it: RoadmapItem) => void;
}) {
  const [kind, setKind] = useState<Kind>('');
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [now, setNow] = useState<LedgerNow | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [paged, setPaged] = useState(false);
  const [more, setMore] = useState(false);
  const [report, setReport] = useState<BranchReport | null>(null);
  const [reportErr, setReportErr] = useState(false);
  const [failed, setFailed] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const byId = useMemo(() => new Map(items.map((r) => [r.id, r])), [items]);

  // The first page and the live strip. A poll replaces the first page while
  // nothing older is loaded; once the reader has paged back, it only adds
  // entries newer than the top, so the page they are reading doesn't shift.
  const readTop = useCallback(async (fresh: boolean) => {
    try {
      const page = await getLedger(slug, { kind });
      setNow(page.now);
      setFailed('');
      if (fresh || !paged) {
        setEntries(page.entries);
        setNext(page.nextBefore);
        if (fresh) setPaged(false);
        return;
      }
      setEntries((prev) => {
        const top = prev?.[0]?.at || '';
        return [...page.entries.filter((e) => e.at > top), ...(prev || [])];
      });
    } catch (e) { setFailed((e as Error)?.message || 'Could not read the session ledger.'); }
  }, [slug, kind, paged]);

  const readReport = useCallback(async () => {
    try { setReport(await getBranchReport(slug)); setReportErr(false); }
    catch { setReportErr(true); }
  }, [slug]);

  // Keyed on slug and kind only: `paged` changing is not a reason to re-read.
  useEffect(() => { setEntries(null); readTop(true); }, [slug, kind]);
  useEffect(() => { readReport(); }, [readReport]);
  useAutoRefresh(() => { readTop(false); readReport(); });

  const loadMore = async () => {
    if (!next) return;
    setMore(true);
    try {
      const page = await getLedger(slug, { kind, before: next });
      setEntries((prev) => [...(prev || []), ...page.entries]);
      setNext(page.nextBefore);
      setPaged(true);
    } catch (e) { setFailed((e as Error)?.message || 'Could not read older entries.'); }
    finally { setMore(false); }
  };

  const days = useMemo(() => {
    const out: { label: string; rows: LedgerEntry[] }[] = [];
    for (const e of entries || []) {
      const label = dayLabel(e.at);
      if (out.length && out[out.length - 1].label === label) out[out.length - 1].rows.push(e);
      else out.push({ label, rows: [e] });
    }
    return out;
  }, [entries]);

  return (
    <div className="km-dev">
      <NowStrip now={now} report={report} reportErr={reportErr} items={items} onOpen={onOpen} />

      {/* `.ready` once the read has answered, entries or none: the smoke's
          hook, since a loading ledger and a loaded one share every other class. */}
      <div className={`km-devgroup km-devledger${entries !== null ? ' ready' : ''}`}>
        <div className="km-batchhead">
          <span className="lbl">Session ledger</span>
          <span className="rule" />
        </div>
        <div className="im-bar km-devbar">
          {KIND_CHIPS.map((c) => (
            <button key={c.value || 'all'} className={`im-chip${kind === c.value ? ' on' : ''}`}
              onClick={() => setKind(c.value)}>{c.label}</button>
          ))}
        </div>

        {failed && <div className="km-err" role="alert">{failed}</div>}
        {entries === null && !failed && <span className="km-devsay">Reading the ledger…</span>}
        {entries !== null && entries.length === 0 && (
          <span className="km-devsay">
            {kind === 'run' ? 'No autopilot run has reported for this project.'
              : 'No session has reported for this project yet. The SessionEnd hook records one when a Claude Code session ends.'}
          </span>
        )}

        {days.map((d) => (
          <div className="km-devday" key={d.label}>
            <div className="km-devdaylbl">{d.label}</div>
            {d.rows.map((e) => {
              const key = `${e.kind}-${e.id}`;
              const props = { open: open === key, onToggle: () => setOpen(open === key ? null : key), byId, onOpen };
              return e.kind === 'session'
                ? <SessionRow key={key} s={e} {...props} />
                : <RunRow key={key} r={e} {...props} />;
            })}
          </div>
        ))}

        {next && (
          <button className="k-btn sm secondary km-devmore" onClick={loadMore} disabled={more}>
            {more ? 'Reading…' : 'Older entries'}
          </button>
        )}
      </div>

      {report && report.branches.length > 0 && <BranchSection report={report} byId={byId} />}
    </div>
  );
}

// ---- now -------------------------------------------------------------------

// A worktree is worth showing when it holds work origin cannot see:
// uncommitted files, commits not pushed, or commits on a branch with no
// upstream at all.
const holdsWork = (w: ReportedWorktree) =>
  w.dirty > 0 || (w.unpushed ?? 0) > 0 || (w.unpushed === null && w.ahead > 0);

function NowStrip({ now, report, reportErr, items, onOpen }: {
  now: LedgerNow | null; report: BranchReport | null; reportErr: boolean;
  items: RoadmapItem[]; onOpen: (it: RoadmapItem) => void;
}) {
  const claimed = items.filter((it) => it.claimedBy.trim() !== '' && !isBuilt(it));
  const trees = report ? report.worktrees.filter(holdsWork) : [];
  const seeTrees = !!report?.worktreesAt;
  const stale = !!report?.reportedAt && !(Date.now() - Date.parse(report.reportedAt) < REPORT_STALE_MS);
  const count = (now?.sessions.length || 0) + (now?.jobs.length || 0) + claimed.length + trees.length;

  return (
    <div className="km-devgroup">
      <div className="km-batchhead">
        <span className="lbl tone-info">Now</span>
        {now && <span className="n">{count}</span>}
        <span className="rule" />
      </div>
      {!now && <span className="km-devsay">Reading what is live…</span>}

      {now?.sessions.map((p) => {
        const quiet = !p.lastSeenAt || !(Date.now() - Date.parse(p.lastSeenAt) < QUIET_MS);
        return (
          <NowRow key={`p-${p.sessionId}`} tone={quiet ? 'neutral' : 'success'} icon="terminal"
            title={`Claude session${p.branch ? ` on ${p.branch}` : ''}`}
            sub={`${p.cwd ? shortPath(p.cwd) || p.cwd : 'unknown checkout'} · started ${timeAgo(p.startedAt)}`}
            tag={quiet ? `quiet · last heard ${timeAgo(p.lastSeenAt)}` : `active · ${timeAgo(p.lastSeenAt)}`}
            hint="From the session's own hook pings. A session that ended without its end hook stays listed until its ping expires." />
        );
      })}

      {now?.jobs.map((j) => {
        const it = j.itemId === null ? undefined : items.find((r) => r.id === j.itemId);
        return (
          <NowRow key={`j-${j.id}`} tone={j.status === 'running' ? 'info' : j.status === 'paused' ? 'warning' : 'neutral'}
            icon="clock" title={`Autopilot ${j.kind}${j.itemId !== null ? ` · #${j.itemId}` : ''}`}
            sub={j.itemTitle || j.detail || j.branch || '—'} tag={j.status}
            onClick={it ? () => onOpen(it) : undefined} />
        );
      })}

      {claimed.map((it) => (
        <NowRow key={`c-${it.id}`} tone="neutral" icon="git-branch" title={`#${it.id} ${it.title}`}
          sub={`claimed by ${it.claimedBy}`} tag={it.reviewTag ? 'sent back' : 'claimed, not built'}
          onClick={() => onOpen(it)} />
      ))}

      {trees.map((w) => (
        <NowRow key={`w-${w.path}`} tone="warning" icon="code"
          title={`${w.branch || w.head}${w.main ? ' (shared checkout)' : ''}`}
          sub={w.subject || w.path}
          tag={[
            w.dirty > 0 && `${w.dirty} uncommitted`,
            (w.unpushed ?? 0) > 0 && `${w.unpushed} unpushed`,
            w.unpushed === null && w.ahead > 0 && `${w.ahead} ahead, no upstream`,
          ].filter(Boolean).join(' · ')}
          hint={w.path} />
      ))}

      {now && count === 0 && seeTrees && !stale && <span className="km-devsay">Nothing is running or waiting to be pushed.</span>}
      {now && !seeTrees && (
        <span className="km-devsay">
          {reportErr ? 'Could not read the host report, so' : 'The host has not reported this project’s checkouts, so'} Stack
          cannot see uncommitted or unpushed work here.
        </span>
      )}
      {seeTrees && stale && (
        <span className="km-devsay">
          The host’s checkout report is from {timeAgo(report!.reportedAt)}; the dispatcher has stopped posting, so
          uncommitted work may be out of date.
        </span>
      )}
    </div>
  );
}

function NowRow({ tone, icon, title, sub, tag, hint, onClick }: {
  tone: Tone; icon: 'terminal' | 'clock' | 'git-branch' | 'code'; title: string; sub: string; tag: string;
  hint?: string; onClick?: () => void;
}) {
  const body = (
    <>
      <span className="caret" />
      <span className={`km-branchico tone-${tone}`}><KitIcon name={icon} size={13} /></span>
      <span className="mid">
        <span className="top"><span className="br">{title}</span></span>
        <span className="sub">{sub}</span>
      </span>
      {tag && <span className={tone === 'neutral' || tone === 'info' ? 'k-tag' : `k-tag ${tone}`}>{tag}</span>}
    </>
  );
  return (
    <section className="km-branch">
      {onClick
        ? <button className="km-branchhead" onClick={onClick} title={hint}>{body}</button>
        : <div className="km-branchhead" title={hint}>{body}</div>}
    </section>
  );
}

// ---- ledger rows -----------------------------------------------------------

type RowProps = {
  open: boolean; onToggle: () => void;
  byId: Map<number, RoadmapItem>; onOpen: (it: RoadmapItem) => void;
};

function Refs({ ids, byId, onOpen }: { ids: number[]; byId: Map<number, RoadmapItem>; onOpen: (it: RoadmapItem) => void }) {
  const known = ids.filter((n) => byId.has(n)).slice(0, 4);
  return (
    <>
      {known.map((n) => {
        const it = byId.get(n)!;
        return (
          <span key={n} role="link" tabIndex={0} className="id" title={it.title}
            onClick={(e) => { e.stopPropagation(); onOpen(it); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onOpen(it); } }}>#{n}</span>
        );
      })}
    </>
  );
}

function SessionRow({ s, open, onToggle, byId, onOpen }: RowProps & { s: LedgerSession }) {
  const ids = refsIn(s.summary);
  const meta = [
    s.model && model(s.model),
    s.tokens > 0 && tok(s.tokens),
    s.messages !== null && `${s.messages} msg`,
    s.agentCalls > 0 && `${s.agentCalls} agent${s.agentCalls === 1 ? '' : 's'}`,
    s.filesTotal > 0 && `${s.filesTotal} file${s.filesTotal === 1 ? '' : 's'}`,
  ].filter(Boolean).join(' · ');
  return (
    <section className={`km-branch${open ? ' open' : ''}`}>
      <button className="km-branchhead" onClick={onToggle} aria-expanded={open}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className="km-branchico tone-info"><KitIcon name="terminal" size={13} /></span>
        <span className="mid">
          <span className="top">
            <span className="km-devtime">{clock(s.at)}</span>
            <span className="k-tag">{s.authored ? 'checkpoint' : 'session'}</span>
            {s.commit && <span className="br">{s.commit.slice(0, 7)}</span>}
            {s.branch && s.branch !== 'main' && <span className="br">{s.branch}</span>}
            <Refs ids={ids} byId={byId} onOpen={onOpen} />
          </span>
          <span className="sub km-devlede">{lede(s.summary) || '(no summary recorded)'}</span>
          {meta && <span className="sub">{meta}</span>}
        </span>
      </button>
      {open && (
        <div className="km-branchbody">
          {s.summary && <Markdown text={s.summary} />}
          {s.phase && <Field label="Phase">{s.phase}</Field>}
          {s.nextSteps.length > 0 && <Field label="Next"><ul>{s.nextSteps.map((n, i) => <li key={i}>{n}</li>)}</ul></Field>}
          {s.blockers.length > 0 && <Field label="Blockers"><ul>{s.blockers.map((n, i) => <li key={i}>{n}</li>)}</ul></Field>}
          {s.geminiNote && <Field label="✧ Gemini">{s.geminiNote}</Field>}
          {s.files.length > 0 && (
            <Field label="Files">
              <div className="commits">
                {s.files.map((f) => <div className="commit" key={f}><span className="msg">{shortPath(f)}</span></div>)}
                {s.filesTotal > s.files.length && <span className="km-devsay">… {s.filesTotal - s.files.length} more</span>}
              </div>
            </Field>
          )}
          {s.tools.length > 0 && (
            <Field label="Tools"><span className="km-devtags">{s.tools.map((t) => <span key={t} className="k-tag mono">{t}</span>)}</span></Field>
          )}
          {Object.keys(s.agentTypes).length > 0 && (
            <Field label="Agents">
              {Object.entries(s.agentTypes).map(([k, n]) => `${k} ×${n}`).join(', ')}
            </Field>
          )}
          {Object.keys(s.modelUsage).length > 1 && (
            <Field label="Models">{Object.keys(s.modelUsage).map(model).join(', ')}</Field>
          )}
          <Field label="Ended">{s.reason || 'unrecorded'}{s.sessionId ? ` · ${s.sessionId.slice(0, 8)}` : ''}</Field>
        </div>
      )}
    </section>
  );
}

function RunRow({ r, open, onToggle, byId, onOpen }: RowProps & { r: LedgerRun }) {
  const tone = OUTCOME_TONE[r.outcome] || 'neutral';
  const checks = r.checksFailing === null ? 'suite not run'
    : r.checksFailing === 0 ? 'checks green' : `${r.checksFailing} failing`;
  const meta = [
    `${r.commits} commit${r.commits === 1 ? '' : 's'}`,
    r.tokens > 0 && tok(r.tokens),
    r.costUsd > 0 && `$${r.costUsd.toFixed(2)}`,
    r.startedAt && `${Math.max(1, Math.round((Date.parse(r.at) - Date.parse(r.startedAt)) / 60_000))}m`,
  ].filter(Boolean).join(' · ');
  return (
    <section className={`km-branch${open ? ' open' : ''}`}>
      <button className="km-branchhead" onClick={onToggle} aria-expanded={open}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className={`km-branchico tone-${tone}`}><KitIcon name="clock" size={13} /></span>
        <span className="mid">
          <span className="top">
            <span className="km-devtime">{clock(r.at)}</span>
            <span className={tone === 'neutral' ? 'k-tag' : `k-tag ${tone}`}>autopilot · {r.outcome}</span>
            {r.itemId !== null && <Refs ids={[r.itemId]} byId={byId} onOpen={onOpen} />}
          </span>
          <span className="sub km-devlede">{r.itemTitle || lede(r.summary) || '(no summary recorded)'}</span>
          <span className="sub">{meta}</span>
        </span>
        <span className={r.checksFailing === null ? 'k-tag' : r.checksFailing === 0 ? 'k-tag success' : 'k-tag danger'}>{checks}</span>
        <span className="k-tag" title={r.reviewNote || 'No second-model review ran on this run.'}>
          {r.reviewVerdict ? `review: ${r.reviewVerdict}` : 'no review'}
        </span>
      </button>
      {open && (
        <div className="km-branchbody">
          {r.summary && <Markdown text={r.summary} />}
          {r.branch && <Field label="Branch">{r.branch}</Field>}
          {r.reviewNote && <Field label="Review">{r.reviewNote}</Field>}
          {r.architectVerdict && <Field label="Architect">{r.architectVerdict}{r.architectNote ? ` — ${r.architectNote}` : ''}</Field>}
          {r.autoVerdict && <Field label="Auto-verdict">{r.autoVerdict}</Field>}
        </div>
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="km-devfield">
      <span className="lbl">{label}</span>
      <div className="val">{children}</div>
    </div>
  );
}

// ---- branches (only when origin has any) -----------------------------------

type DevGroup = { key: string; label: string; tone: Tone; rows: ReportedBranch[]; say: string };

function groupBranches(list: ReportedBranch[]): DevGroup[] {
  const by: Record<string, ReportedBranch[]> = { conflict: [], land: [], unprobed: [], level: [] };
  for (const b of list) {
    if (b.ahead === 0) { by.level.push(b); continue; }
    const s = mergeStateOf(b);
    by[s === 'conflict' ? 'conflict' : isMergeable(s) ? 'land' : 'unprobed'].push(b);
  }
  const groups: DevGroup[] = [
    { key: 'conflict', label: 'Conflicts with main', tone: 'danger', rows: by.conflict, say: MERGE_STATE_META.conflict.hint },
    { key: 'land', label: 'Merges clean', tone: 'success', rows: by.land,
      say: 'The probe says these merge into main. That is not a verdict: they still need one.' },
    { key: 'unprobed', label: 'Unprobed', tone: 'neutral', rows: by.unprobed, say: MERGE_STATE_META.unprobed.hint },
    { key: 'level', label: 'Nothing ahead of main', tone: 'neutral', rows: by.level,
      say: 'Already landed, or never committed to. Nothing here would merge.' },
  ];
  return groups.filter((g) => g.rows.length > 0);
}

const TONE_ICON: Record<Tone, 'circle-alert' | 'clock' | 'circle-check' | 'git-branch'> = {
  danger: 'circle-alert', success: 'circle-check', warning: 'clock', info: 'git-branch', neutral: 'git-branch',
};

function BranchSection({ report, byId }: { report: BranchReport; byId: Map<number, RoadmapItem> }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      {groupBranches(report.branches).map((g) => (
        <div className="km-devgroup" key={g.key}>
          <div className="km-batchhead" title={g.say}>
            <span className={`lbl tone-${g.tone}`}>Branches · {g.label}</span>
            <span className="n">{g.rows.length}</span>
            <span className="rule" />
          </div>
          {g.rows.map((b) => (
            <BranchRow key={b.branch} row={b} tone={g.tone} title={b.itemId === null ? '' : byId.get(b.itemId)?.title || ''}
              open={open === b.branch} onToggle={() => setOpen(open === b.branch ? null : b.branch)} />
          ))}
        </div>
      ))}
    </>
  );
}

function BranchRow({ row, tone, title, open, onToggle }: {
  row: ReportedBranch; tone: Tone; title: string; open: boolean; onToggle: () => void;
}) {
  const parsed = parseBranch(row.branch);
  const state = row.ahead === 0 ? null : mergeStateOf(row);
  const ref = parsed.itemId !== null ? `#${parsed.itemId}` : parsed.bugKey;
  const more = row.files - row.topFiles.length;
  return (
    <section className={`km-branch${open ? ' open' : ''}`}>
      <button className="km-branchhead" onClick={onToggle} aria-expanded={open}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className={`km-branchico tone-${tone}`}><KitIcon name={TONE_ICON[tone]} size={13} /></span>
        <span className="mid">
          <span className="top">
            <span className="br">{row.branch}</span>
            {ref && <span className="id">{ref}</span>}
          </span>
          <span className="sub">{title || row.subject || '—'}</span>
        </span>
        <span className="delta" title="Commits ahead of / behind origin/main">↑{row.ahead} ↓{row.behind}</span>
        {row.files > 0 && (
          <span className="diff">
            <span className="add">+{row.adds}</span>
            <span className="del">−{row.dels}</span>
          </span>
        )}
        {state && (
          <span className={state === 'unprobed' ? 'k-tag' : `k-tag ${tone}`} title={MERGE_STATE_META[state].hint}>
            {MERGE_STATE_META[state].label}
          </span>
        )}
        <span className="age">{timeAgo(row.committedAt).replace(' ago', '')}</span>
      </button>
      {open && (
        <div className="km-branchbody">
          <div className="commits">
            <div className="commit"><span className="sha">tip</span><span className="msg">{row.subject || '(no subject)'}</span></div>
          </div>
          {row.topFiles.length > 0 && (
            <div className="commits">
              {row.topFiles.map((f) => (
                <div className="commit" key={f.path}>
                  <span className="sha">{f.binary ? 'bin' : `+${f.adds} −${f.dels}`}</span>
                  <span className="msg">{f.path}</span>
                </div>
              ))}
              {more > 0 && <span className="km-devsay">… {more} more file{more === 1 ? '' : 's'}</span>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
