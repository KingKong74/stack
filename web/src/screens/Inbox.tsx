// THE INBOX — everything waiting on the human, across every project, in one
// place (server/src/routes/inbox.js is the read). Top to bottom:
//
//   1. THE LOOP: whether the automation is building, and if not, the one
//      sentence saying why. `seen: false` is "Stack cannot see the
//      dispatcher", never "nothing to do". The arm switch, the mode and each
//      project's automode are switchable here, because a loop you cannot turn
//      on from the screen that says it is off is a dead end.
//   2. BUILT, AWAITING YOUR VERDICT: each row carries what was built and the
//      evidence (spec, run, checks, both second-model reads). An empty read is
//      NO REVIEW, never clean, and an agent's read is drawn in the accent,
//      never a verdict tone (CLAUDE.md). The verdict buttons are the human's.
//   3. PLANS AWAITING APPROVAL: held pieces a planning run filed, under their
//      parent. Approve & queue is the one press that turns a plan into work the
//      loop will build.
//   4. IDEAS: every other held row nobody has worked.
//
// Writes go through the existing routes; nothing here decides anything the
// server would not.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { TopBar } from '../components/TopBar';
import { hrefTo } from '../lib/route';
import { useAutoRefresh } from '../lib/autoRefresh';
import {
  getInbox, patchRoadmapItem, deleteRoadmapItem, queueMerge, startRefine, addToReady,
  patchSettings, patchProject, AuthError,
} from '../store';
import type { InboxData, InboxItem, InboxRun, ItemSpec } from '../types';

// A claim the merge button can act on: a real branch the runner or a session
// pushed. A terminal claim names a tmux session, not a branch.
const branchOf = (it: InboxItem, run: InboxRun | null): string => {
  const claim = it.claimedBy.trim();
  if (claim && !claim.startsWith('term:') && claim !== 'main') return claim;
  return run?.branch || '';
};

function SpecBlock({ spec }: { spec: ItemSpec }) {
  if (!spec.goal && !spec.acceptance?.length) return null;
  return (
    <div className="ib-spec">
      {spec.goal && <div className="ib-goal">{spec.goal}</div>}
      {!!spec.acceptance?.length && (
        <ul className="ib-accept">{spec.acceptance.map((a, i) => <li key={i}>{a}</li>)}</ul>
      )}
      {!!spec.files?.length && <div className="ib-files">{spec.files.join(' · ')}</div>}
    </div>
  );
}

function Read({ label, verdict, note }: { label: string; verdict: string; note: string }) {
  return (
    <div className="ib-read">
      <span className="ib-readlbl">{label}</span>
      {verdict
        ? <span className="ib-readcall">{verdict}</span>
        : <span className="ib-noreview">NO REVIEW</span>}
      {verdict && note && <span className="ib-readnote">{note}</span>}
    </div>
  );
}

function RunLine({ run }: { run: InboxRun | null }) {
  if (!run) return <div className="ib-run">No run on the ledger: built outside the autopilot.</div>;
  const checks = run.checksFailing == null ? 'no checks ran'
    : run.checksFailing === 0 ? 'checks green' : `${run.checksFailing} check(s) failing`;
  return (
    <>
      <div className="ib-run">
        <span>{run.outcome}</span>
        <span>{run.commits} commit(s)</span>
        <span className={run.checksFailing ? 'ib-bad' : ''}>{checks}</span>
        <span>~{Math.round(run.tokens / 1000)}k tokens{run.costUsd ? ` · $${run.costUsd.toFixed(2)}` : ''}</span>
        <span>{run.when}</span>
      </div>
      <Read label="Reviewer" verdict={run.reviewVerdict} note={run.reviewNote} />
      <Read label="Architect" verdict={run.architectVerdict} note={run.architectNote} />
      {run.autoVerdict && <div className="ib-run">Auto-verdict evidence: {run.autoVerdict}</div>}
    </>
  );
}

export function Inbox() {
  const [data, setData] = useState<InboxData | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [sendBack, setSendBack] = useState<{ id: number; text: string } | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());

  const load = useCallback(() => {
    getInbox()
      .then((d) => { setData(d); setError(''); })
      .catch((e) => { if (!(e instanceof AuthError)) setError((e as Error)?.message || 'Failed to load the inbox.'); });
  }, []);
  useEffect(() => { load(); }, [load]);
  useAutoRefresh(load);

  const act = async (fn: () => Promise<string | void>) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const said = await fn();
      if (said) setNote(said);
      load();
    } catch (e) {
      if (!(e instanceof AuthError)) setError((e as Error)?.message || 'That did not go through.');
    } finally { setBusy(false); }
  };

  const verdict = (it: InboxItem, tag: 'solid' | 'rethink') =>
    act(async () => {
      await patchRoadmapItem(it.projectSlug, it.id, { review_tag: tag });
      return tag === 'solid' ? `#${it.id} approved.` : `#${it.id} rejected: marked rethink.`;
    });
  const approveAndMerge = (it: InboxItem, branch: string) =>
    act(async () => {
      // The merge goes first: if the server refuses it (another job is open),
      // no verdict is written and the row stays here to try again.
      await queueMerge(it.projectSlug, branch, it.id);
      await patchRoadmapItem(it.projectSlug, it.id, { review_tag: 'solid' });
      return `#${it.id} approved; a merge of ${branch} is queued. A conflict aborts it rather than forcing anything.`;
    });
  const doSendBack = (it: InboxItem, text: string) =>
    act(async () => {
      // A refine round continues the item's branch (#274). The claim is
      // released so the runner may take the item; the branch is read off the
      // built note, which keeps it.
      await patchRoadmapItem(it.projectSlug, it.id, { refine_note: text, claimed_by: '' });
      await startRefine(it.projectSlug, it.id);
      setSendBack(null);
      return `#${it.id} sent back. A refine round is queued on its branch.`;
    });

  const plansByParent = useMemo(() => {
    const m = new Map<string, InboxData['plans']>();
    for (const p of data?.plans || []) {
      const k = `${p.projectSlug}|${p.parentId ?? 0}`;
      m.set(k, [...(m.get(k) || []), p]);
    }
    return [...m.values()];
  }, [data]);

  const approvePicked = (queue: boolean) =>
    act(async () => {
      const rows = (data?.plans || []).filter((p) => picked.has(p.id));
      for (const r of rows) await patchRoadmapItem(r.projectSlug, r.id, { reviewed: true, committed: true });
      if (queue) {
        const bySlug = new Map<string, number[]>();
        for (const r of rows) bySlug.set(r.projectSlug, [...(bySlug.get(r.projectSlug) || []), r.id]);
        for (const [slug, ids] of bySlug) await addToReady(slug, ids);
      }
      setPicked(new Set());
      return `${rows.length} piece(s) approved${queue ? ' and queued to build' : ''}.`;
    });
  const dismiss = (it: InboxItem) =>
    act(async () => { await deleteRoadmapItem(it.projectSlug, it.id); return `#${it.id} dismissed. It will not be re-created.`; });
  const promote = (it: InboxItem) =>
    act(async () => {
      await patchRoadmapItem(it.projectSlug, it.id, { reviewed: true, committed: true, parentId: null });
      return `#${it.id} is on the board.`;
    });

  const loop = data?.loop;
  const total = data ? data.built.length + data.plans.length + data.ideas.length : 0;

  return (
    <div>
      <TopBar crumb={[{ label: 'Projects', href: hrefTo.dashboard }, { label: 'Inbox', href: hrefTo.inbox }]} />
      <div className="page detail">
        <div className="dash-head" style={{ marginBottom: 20 }}>
          <div>
            <div className="dash-title">Inbox</div>
            <div className="dash-count">{data ? `${total} waiting on you, across every project.` : 'Everything waiting on you.'}</div>
          </div>
        </div>
        {error && <div className="action-error">{error}</div>}
        {note && <div className="ib-note">{note}</div>}

        {!data ? (!error && <div className="empty-state"><div className="big">Loading…</div></div>) : (
          <>
            <section className="panel ib-loop">
              <div className="ib-looptop">
                <span className={`ib-dot${loop?.seen && !loop.hold ? ' on' : ''}`} />
                <span className="ib-loopsay">
                  {!loop?.seen ? loop?.hold
                    : loop.hold ? `Not building: ${loop.hold}.`
                    : loop.running ? `Building: ${loop.running} running, ${loop.queued} queued.`
                    : loop.ready ? 'Ready to build; the next poll picks up the queue.'
                    : 'Running, and the Ready queue is empty.'}
                </span>
                <span className="ib-loopn">{loop?.ready ?? 0} ready</span>
              </div>
              <div className="ib-controls">
                <label className="ib-switch">
                  <input type="checkbox" checked={!!loop?.armed} disabled={busy}
                    onChange={(e) => act(async () => { await patchSettings({ autopilotEnabled: e.target.checked }); })} />
                  Autopilot on
                </label>
                <span className="ib-seg" role="group" aria-label="Loop mode">
                  {(['continuous', 'nightly'] as const).map((m) => (
                    <button key={m} className={loop?.mode === m ? 'on' : ''} disabled={busy}
                      onClick={() => act(async () => { await patchSettings({ autopilotMode: m }); })}>
                      {m === 'continuous' ? 'Whenever there is budget' : 'Nightly'}
                    </button>
                  ))}
                </span>
              </div>
              <div className="ib-projects">
                {data.projects.map((p) => (
                  <label key={p.slug} className="ib-switch" title="Automode: the loop may build this project's Ready queue and plan its sprint.">
                    <input type="checkbox" checked={p.automode} disabled={busy}
                      onChange={(e) => act(async () => { await patchProject(p.slug, { automode: e.target.checked }); })} />
                    {p.name}{p.ready ? ` · ${p.ready} ready` : ''}
                  </label>
                ))}
              </div>
            </section>

            <h2 className="ib-h">Built, awaiting your verdict <span>{data.built.length}</span></h2>
            {data.built.length === 0 && <div className="ib-empty">Nothing built is waiting on you.</div>}
            {data.built.map((it) => {
              const branch = branchOf(it, it.run);
              return (
                <article className="panel ib-card" key={`b${it.id}`}>
                  <div className="ib-cardhead">
                    <a className="ib-proj" href={hrefTo.detail(it.projectSlug, 'roadmap', String(it.id))}>{it.projectName}</a>
                    <span className="ib-title">#{it.id} {it.title}</span>
                    {branch && <span className="k-tag mono">{branch}</span>}
                  </div>
                  <SpecBlock spec={it.spec} />
                  {it.builtNote && <p className="ib-built">{it.builtNote}</p>}
                  <RunLine run={it.run} />
                  {sendBack?.id === it.id ? (
                    <div className="ib-sendback">
                      <textarea value={sendBack.text} placeholder="What should change? The refine round builds this on top of the branch."
                        onChange={(e) => setSendBack({ id: it.id, text: e.target.value })} />
                      <div className="ib-actions">
                        <button className="btn-accent" disabled={busy || !sendBack.text.trim()}
                          onClick={() => doSendBack(it, sendBack.text.trim())}>Send back</button>
                        <button className="btn-cancel" onClick={() => setSendBack(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div className="ib-actions">
                      {branch && !it.done && (
                        <button className="btn-accent" disabled={busy} onClick={() => approveAndMerge(it, branch)}
                          title={`Gives the verdict and queues a merge of ${branch} into main.`}>Approve &amp; merge</button>
                      )}
                      <button className={branch && !it.done ? 'btn-repo' : 'btn-accent'} disabled={busy}
                        onClick={() => verdict(it, 'solid')}>Approve</button>
                      <button className="btn-repo" disabled={busy} onClick={() => setSendBack({ id: it.id, text: '' })}>Send back…</button>
                      <button className="btn-repo" disabled={busy} onClick={() => verdict(it, 'rethink')}>Reject</button>
                    </div>
                  )}
                </article>
              );
            })}

            <h2 className="ib-h">Plans awaiting approval <span>{data.plans.length}</span></h2>
            {data.plans.length === 0 && <div className="ib-empty">No planned pieces are waiting. Planning runs file them from the sprint in progress.</div>}
            {data.plans.length > 0 && (
              <div className="ib-actions ib-bulk">
                <button className="btn-accent" disabled={busy || picked.size === 0} onClick={() => approvePicked(true)}>
                  Approve &amp; queue to build ({picked.size})
                </button>
                <button className="btn-repo" disabled={busy || picked.size === 0} onClick={() => approvePicked(false)}>Approve only</button>
                <button className="btn-repo" disabled={busy}
                  onClick={() => setPicked(picked.size === data.plans.length ? new Set() : new Set(data.plans.map((p) => p.id)))}>
                  {picked.size === data.plans.length ? 'Select none' : 'Select all'}
                </button>
              </div>
            )}
            {plansByParent.map((group) => (
              <article className="panel ib-card" key={`g${group[0].projectSlug}-${group[0].parentId}`}>
                <div className="ib-cardhead">
                  <a className="ib-proj" href={hrefTo.detail(group[0].projectSlug, 'roadmap', String(group[0].parentId ?? ''))}>{group[0].projectName}</a>
                  <span className="ib-title">{group[0].parentTitle ? `Pieces of #${group[0].parentId} ${group[0].parentTitle}` : 'Planned pieces'}</span>
                </div>
                {group.map((p) => (
                  <div className="ib-piece" key={p.id}>
                    <label className="ib-pick">
                      <input type="checkbox" checked={picked.has(p.id)}
                        onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(p.id); else n.delete(p.id); return n; })} />
                      <span className="ib-title">#{p.id} {p.title}</span>
                    </label>
                    <SpecBlock spec={p.spec} />
                    <div className="ib-actions">
                      <button className="btn-repo" disabled={busy} onClick={() => dismiss(p)}>Dismiss</button>
                    </div>
                  </div>
                ))}
              </article>
            ))}

            <h2 className="ib-h">Ideas awaiting sign-off <span>{data.ideas.length}</span></h2>
            {data.ideas.length === 0 && <div className="ib-empty">No held ideas.</div>}
            {data.ideas.map((it) => (
              <article className="panel ib-card ib-idea" key={`i${it.id}`}>
                <div className="ib-cardhead">
                  <a className="ib-proj" href={hrefTo.detail(it.projectSlug, 'auto', String(it.id))}>{it.projectName}</a>
                  <span className="ib-title">#{it.id} {it.title}</span>
                </div>
                {it.note && <p className="ib-built">{it.note}</p>}
                <div className="ib-actions">
                  <button className="btn-repo" disabled={busy} onClick={() => promote(it)}>Promote to board</button>
                  <button className="btn-repo" disabled={busy} onClick={() => dismiss(it)}>Dismiss</button>
                </div>
              </article>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
