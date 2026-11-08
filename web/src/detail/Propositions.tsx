// THE PROPOSITIONS COLUMN — proposed packages of work (server/src/routes/
// propositions.js), drawn first on the board, before the delivery columns.
//
// A PROPOSITION IS NOT WORK. None of its nodes is a roadmap row, so nothing
// here is a card, takes a drop, counts toward progress or can be queued; the
// tile says "Proposed" until the owner decides. `homeOf` is untouched: an
// accepted node becomes an ordinary row in a new slice, and from then on lives
// on the board like any other, with the tile only pointing at it.
//
// The rules this screen says out loud rather than enforces (the server does):
//  • Accept is the owner's, for a selection. Ticking an item ticks its slice
//    and milestone, because the server refuses an orphan; unticking a parent
//    unticks its children. An accepted node shows its real row instead of a box.
//  • Accepting never sets Ready, commits a slice to a sprint or makes a
//    milestone current. The footer says so, and says where those choices live.
//  • Dismiss sticks: the same proposal will not come back by itself.
//  • EVERYTHING IN A PROPOSITION IS AGENT-AUTHORED TEXT. An external URL is
//    drawn as text with a Copy button, never an anchor (the root rule); an
//    artifact or item reference is an in-app link built from its id.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KitIcon } from './kit/KitIcon';
import { Markdown } from '../components/Markdown';
import type { Milestone, PropItem, PropMilestone, PropSlice, Proposition, PropositionLink } from '../types';
import { getPropositions, acceptProposition, dismissProposition, patchProposition } from '../store';
import { hrefTo } from '../lib/route';
import { timeAgo, ITEM_KIND_LABEL } from '../lib/ui';

const KIND_LABEL: Record<Proposition['kind'], string> = { milestone: 'Milestone plan', slices: 'Slice plan', empty: 'Empty' };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function stateOf(p: Proposition): { label: string; tone: string } {
  if (p.status === 'dismissed') return { label: 'Dismissed', tone: '' };
  if (p.status === 'accepted') return { label: 'Accepted', tone: 'success' };
  if (p.counts.accepted > 0) return { label: `Partly accepted · ${p.counts.accepted}/${p.counts.total}`, tone: 'info' };
  return { label: 'Proposed', tone: 'warning' };
}

/** The column itself. Fetches its own rows: propositions are not in the payload. */
export function PropositionsColumn({ slug, milestones, onAccepted }: {
  slug: string; milestones: Milestone[]; onAccepted: () => void;
}) {
  const [rows, setRows] = useState<Proposition[] | null>(null);
  const [err, setErr] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [settled, setSettled] = useState(false);
  const load = useCallback(() => {
    getPropositions(slug).then((r) => { setRows(r); setErr(''); })
      .catch((e) => setErr((e as Error)?.message || 'Could not read the propositions.'));
  }, [slug]);
  useEffect(() => { load(); }, [load]);
  const live = (rows || []).filter((p) => p.status === 'proposed');
  const done = (rows || []).filter((p) => p.status !== 'proposed');
  const open = (rows || []).find((p) => p.id === openId) || null;
  const put = (p: Proposition) => setRows((rs) => (rs || []).map((x) => (x.id === p.id ? p : x)));
  return (
    <section className="pp-col" aria-label="Propositions">
      <div className="km-colhead">
        <span className="nm">Propositions</span>
        <span className="lim">{live.length}</span>
      </div>
      <span className="pp-lede">Proposed work, not yet on the board. Open one to inspect it, then accept what you want.</span>
      {err && <div className="km-err" role="alert">{err}</div>}
      {rows === null && !err && <span className="km-colempty">Reading…</span>}
      {rows !== null && live.length === 0 && (
        <span className="km-colempty">No propositions. When an agent proposes a plan, it waits here for you.</span>
      )}
      {live.map((p) => <PropositionTile key={p.id} p={p} onOpen={() => setOpenId(p.id)} />)}
      {done.length > 0 && (
        <button className="km-clearpick pp-settled" aria-expanded={settled} onClick={() => setSettled(!settled)}>
          {settled ? 'Hide' : 'Show'} settled ({done.length})
        </button>
      )}
      {settled && done.map((p) => <PropositionTile key={p.id} p={p} onOpen={() => setOpenId(p.id)} />)}
      {open && (
        <PropositionDetail slug={slug} p={open} milestones={milestones}
          onClose={() => {
            const back = open.id;
            setOpenId(null);
            // Focus returns to the tile that opened it.
            requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-pp="${back}"]`)?.focus());
          }}
          onChanged={(next, madeWork) => { put(next); if (madeWork) onAccepted(); }} />
      )}
    </section>
  );
}

function PropositionTile({ p, onOpen }: { p: Proposition; onOpen: () => void }) {
  const st = stateOf(p);
  return (
    <button className={`pp-tile${p.status !== 'proposed' ? ' settled' : ''}`} onClick={onOpen} data-pp={p.id}
      aria-label={`Proposition: ${p.title}. ${st.label}. Open to inspect.`}>
      <span className="pp-tilehead">
        <span className="k-tag">{KIND_LABEL[p.kind]}</span>
        <span className={`k-tag ${st.tone}`}>{st.label}</span>
      </span>
      <span className="pp-title">{p.title}</span>
      {p.outcome && <span className="pp-outcome">{p.outcome}</span>}
      <span className="pp-counts">
        {[p.counts.milestones ? plural(p.counts.milestones, 'milestone') : '',
          plural(p.counts.slices, 'slice'), plural(p.counts.items, 'item')].filter(Boolean).join(' · ')}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// THE DETAIL
// ---------------------------------------------------------------------------

type Sel = Set<string>;

function LinkRow({ slug, l }: { slug: string; l: PropositionLink }) {
  const [copied, setCopied] = useState(false);
  if (l.kind === 'artifact') {
    return <a className="pp-link" href={hrefTo.detail(slug, 'artifacts', String(l.id))}>
      <KitIcon name="file-text" size={13} />{l.label || `Artifact #${l.id}`}<span className="sp-dim">artifact #{l.id}</span></a>;
  }
  if (l.kind === 'item') {
    return <a className="pp-link" href={hrefTo.detail(slug, 'roadmap', String(l.id))}>
      <KitIcon name="circle-check" size={13} />{l.label || `Item #${l.id}`}<span className="sp-dim">#{l.id}</span></a>;
  }
  return (
    <span className="pp-link pp-url">
      <KitIcon name="arrow-up-right" size={13} />
      {l.label && <span>{l.label}</span>}
      <code title="An agent wrote this link. Read it before you go there.">{l.url}</code>
      <button className="k-btn ghost sm" onClick={async () => {
        try { await navigator.clipboard.writeText(l.url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* selectable */ }
      }}>{copied ? 'Copied' : 'Copy'}</button>
    </span>
  );
}

const Links = ({ slug, links }: { slug: string; links: PropositionLink[] }) => (links.length ? (
  <div className="pp-links">{links.map((l, i) => <LinkRow key={i} slug={slug} l={l} />)}</div>
) : null);

function AcceptedRef({ slug, p, k }: { slug: string; p: Proposition; k: string }) {
  const a = p.accepted[k];
  if (!a) return null;
  const href = a.type === 'milestone' ? hrefTo.detail(slug, 'milestones')
    : a.type === 'item' ? hrefTo.detail(slug, 'roadmap', String(a.id)) : hrefTo.detail(slug, 'roadmap');
  return <a className="k-tag success pp-acc" href={href}>{a.existing ? 'Into existing' : 'Accepted'} → {a.type} #{a.id}</a>;
}

export function PropositionDetail({ slug, p, milestones, onClose, onChanged }: {
  slug: string; p: Proposition; milestones: Milestone[];
  onClose: () => void; onChanged: (p: Proposition, madeWork: boolean) => void;
}) {
  const live = p.status === 'proposed';
  const [sel, setSel] = useState<Sel>(new Set());
  const [into, setInto] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  const [editing, setEditing] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus(); }, []);
  // Escape closes wherever focus is (a pressed button can drop it to the body).
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, [onClose]);

  const tree = p.tree.milestones;
  const done = (k: string) => !!p.accepted[k];
  // Parents of a key, for the closure rule.
  const parents = useMemo(() => {
    const up = new Map<string, string[]>();
    for (const m of tree) for (const s of m.slices) {
      up.set(s.key, [m.key]);
      for (const i of s.items) up.set(i.key, [s.key, m.key]);
    }
    return up;
  }, [tree]);
  const kids = useMemo(() => {
    const down = new Map<string, string[]>();
    for (const m of tree) {
      down.set(m.key, m.slices.flatMap((s) => [s.key, ...s.items.map((i) => i.key)]));
      for (const s of m.slices) down.set(s.key, s.items.map((i) => i.key));
    }
    return down;
  }, [tree]);
  const toggle = (k: string) => setSel((cur) => {
    const next = new Set(cur);
    if (next.has(k)) { next.delete(k); for (const c of kids.get(k) || []) next.delete(c); }
    else { next.add(k); for (const u of parents.get(k) || []) if (!done(u)) next.add(u); }
    return next;
  });
  const remaining = useMemo(() => tree.flatMap((m) => [
    ...(m.milestoneId === null ? [m.key] : []),
    ...m.slices.flatMap((s) => [s.key, ...s.items.map((i) => i.key)]),
  ]).filter((k) => !done(k)), [tree, p.accepted]);
  const chosen = [...sel].filter((k) => !done(k));
  const titleOf = useMemo(() => {
    const t = new Map<string, string>();
    for (const m of tree) for (const s of m.slices) for (const i of s.items) t.set(i.key, i.title);
    return t;
  }, [tree]);

  const accept = async () => {
    setBusy(true); setErr(''); setNote('');
    try {
      const r = await acceptProposition(slug, p.id, chosen, into);
      const n = (t: string) => r.made.filter((x) => x.type === t).length;
      setNote(`Made ${plural(n('milestone'), 'milestone')}, ${plural(n('slice'), 'slice')} and ${plural(n('item'), 'item')}. `
        + 'None is in Ready or a sprint; queue them from the board when you choose.');
      setSel(new Set());
      onChanged(r, r.made.length > 0);
    } catch (e) { setErr((e as Error)?.message || 'Could not accept.'); }
    finally { setBusy(false); }
  };
  const dismiss = async () => {
    setBusy(true); setErr('');
    try { onChanged(await dismissProposition(slug, p.id), false); onClose(); }
    catch (e) { setErr((e as Error)?.message || 'Could not dismiss.'); setBusy(false); }
  };

  const st = stateOf(p);
  return (
    <div className="km-scrim pp-scrim" onClick={onClose}>
      <div className="km-dialog pp-dialog" role="dialog" aria-modal="true" aria-labelledby={`pp-t-${p.id}`}
        onClick={(e) => e.stopPropagation()}>
        <div className="pp-dhead">
          <div className="pp-dtitle">
            <span className="pp-tilehead">
              <span className="k-tag">{KIND_LABEL[p.kind]}</span>
              <span className={`k-tag ${st.tone}`}>{st.label}</span>
            </span>
            <h2 id={`pp-t-${p.id}`} className="sp-h">{p.title}</h2>
            {p.outcome && <span className="pp-outcome full">{p.outcome}</span>}
          </div>
          <button ref={closeRef} className="km-colbtn" aria-label="Close" onClick={onClose}><KitIcon name="x" size={16} /></button>
        </div>

        <div className="pp-prov sp-dim">
          Proposed by {p.proposedBy || 'an agent'} · {timeAgo(p.createdAt)}
          {p.updatedAt !== p.createdAt && <> · updated {timeAgo(p.updatedAt)}</>}
          {p.editedAt && <> · edited by you {timeAgo(p.editedAt)}</>}
          {' · '}<span className="sp-mono">{p.sourceKey}</span>
          {p.artifactId && <> · <a href={hrefTo.detail(slug, 'artifacts', String(p.artifactId))}>source artifact #{p.artifactId}</a></>}
          {p.origin.sessionId && <> · session <span className="sp-mono">{p.origin.sessionId}</span></>}
        </div>

        {err && <div className="km-err" role="alert">{err}</div>}
        {note && <div className="km-note" role="status">{note}</div>}

        {editing ? (
          <PropositionEditor p={p} onCancel={() => setEditing(false)} onSave={async (patch) => {
            setBusy(true); setErr('');
            try { onChanged(await patchProposition(slug, p.id, patch), false); setEditing(false); }
            catch (e) { setErr((e as Error)?.message || 'Could not save.'); }
            finally { setBusy(false); }
          }} busy={busy} />
        ) : <>
          {p.purpose && (
            <section className="sp-sec">
              <span className="sp-eyebrow">Purpose</span>
              <Markdown text={p.purpose} />
            </section>
          )}
          {p.links.length > 0 && (
            <section className="sp-sec">
              <span className="sp-eyebrow">Links</span>
              <Links slug={slug} links={p.links} />
            </section>
          )}
          <section className="sp-sec">
            <div className="sp-sechead">
              <span className="sp-eyebrow">Proposed structure</span>
              <span className="sp-rule" />
              {live && remaining.length > 0 && (
                <button className="k-btn ghost sm" onClick={() => setSel(new Set(remaining))}>Select all remaining</button>
              )}
              {live && chosen.length > 0 && <button className="k-btn ghost sm" onClick={() => setSel(new Set())}>Clear</button>}
            </div>
            <ul className="pp-tree" aria-label="Proposed milestones, slices and items">
              {tree.map((m) => (
                <MilestoneNode key={m.key} slug={slug} p={p} m={m} sel={sel} toggle={toggle} live={live}
                  milestones={milestones} into={into} setInto={setInto} titleOf={titleOf} />
              ))}
            </ul>
          </section>
        </>}

        {live && !editing && (
          <span className="sp-foot">Accepting creates the selected milestone (as upcoming, never current), slices and items. It
            does not add anything to Ready or a sprint, and gives no verdict: do those from the board when you choose.</span>
        )}
        {!editing && (
          <div className="km-dialog-foot pp-foot">
            {live && (
              <button className="k-btn danger km-dialog-left" disabled={busy}
                onClick={() => (confirmDismiss ? dismiss() : setConfirmDismiss(true))}>
                {confirmDismiss ? 'Dismiss for good? It will not be proposed again' : 'Dismiss'}
              </button>
            )}
            {live && <button className="k-btn secondary" disabled={busy} onClick={() => setEditing(true)}><KitIcon name="pencil" size={13} />Edit</button>}
            {live && (
              <button className="k-btn" disabled={busy || chosen.length === 0} onClick={accept}>
                Accept selected{chosen.length ? ` (${chosen.length})` : ''}
              </button>
            )}
            {!live && <button className="k-btn ghost" onClick={onClose}>Close</button>}
          </div>
        )}
      </div>
    </div>
  );
}

function Check({ k, label, sel, toggle }: { k: string; label: string; sel: Sel; toggle: (k: string) => void }) {
  return <input type="checkbox" className="pp-check" checked={sel.has(k)} onChange={() => toggle(k)} aria-label={`Accept ${label}`} />;
}

function MilestoneNode({ slug, p, m, sel, toggle, live, milestones, into, setInto, titleOf }: {
  slug: string; p: Proposition; m: PropMilestone; sel: Sel; toggle: (k: string) => void; live: boolean;
  milestones: Milestone[]; into: Record<string, number>; setInto: (f: (x: Record<string, number>) => Record<string, number>) => void;
  titleOf: Map<string, string>;
}) {
  const existing = m.milestoneId !== null ? milestones.find((x) => x.id === m.milestoneId) : null;
  const accepted = !!p.accepted[m.key];
  return (
    <li className="pp-node pp-ms">
      <div className="pp-row">
        {live && !accepted && m.milestoneId === null && <Check k={m.key} label={`milestone ${m.name}`} sel={sel} toggle={toggle} />}
        <span className="k-tag info">{m.milestoneId !== null ? 'Existing milestone' : 'Milestone'}</span>
        <span className="pp-name">{existing?.name || m.name || `Milestone #${m.milestoneId}`}</span>
        {m.targetOn && <span className="k-tag">by {m.targetOn}</span>}
        <AcceptedRef slug={slug} p={p} k={m.key} />
      </div>
      {m.goal && <div className="pp-body"><Markdown text={m.goal} /></div>}
      {live && !accepted && m.milestoneId === null && sel.has(m.key) && milestones.length > 0 && (
        <label className="pp-into">
          <span className="sp-dim">Accept as</span>
          <select className="k-select sm" value={into[m.key] ?? ''} aria-label={`Accept ${m.name} as`}
            onChange={(e) => { const v = e.target.value; setInto((x) => { const n = { ...x }; if (v) n[m.key] = Number(v); else delete n[m.key]; return n; }); }}>
            <option value="">a new milestone, “{m.name}” (upcoming)</option>
            {milestones.filter((x) => x.status !== 'done').map((x) => <option key={x.id} value={x.id}>slices into “{x.name}”</option>)}
          </select>
        </label>
      )}
      <ul className="pp-kids">
        {m.slices.map((s) => <SliceNode key={s.key} slug={slug} p={p} s={s} sel={sel} toggle={toggle} live={live} titleOf={titleOf} />)}
      </ul>
    </li>
  );
}

function SliceNode({ slug, p, s, sel, toggle, live, titleOf }: {
  slug: string; p: Proposition; s: PropSlice; sel: Sel; toggle: (k: string) => void; live: boolean; titleOf: Map<string, string>;
}) {
  const accepted = !!p.accepted[s.key];
  return (
    <li className="pp-node pp-slice">
      <div className="pp-row">
        {live && !accepted && <Check k={s.key} label={`slice ${s.title}`} sel={sel} toggle={toggle} />}
        <span className="k-tag">Slice</span>
        <span className="pp-name">{s.title}</span>
        {s.areas.map((a) => <span key={a} className="k-tag mono">{a}</span>)}
        <span className="sp-dim">{plural(s.items.length, 'item')}</span>
        <AcceptedRef slug={slug} p={p} k={s.key} />
      </div>
      {s.spec && (
        <details className="pp-spec"><summary>Slice spec</summary><Markdown text={s.spec} /></details>
      )}
      <Links slug={slug} links={s.links} />
      <ul className="pp-kids">
        {s.items.map((i) => <ItemNode key={i.key} slug={slug} p={p} i={i} sel={sel} toggle={toggle} live={live} titleOf={titleOf} />)}
      </ul>
    </li>
  );
}

function ItemNode({ slug, p, i, sel, toggle, live, titleOf }: {
  slug: string; p: Proposition; i: PropItem; sel: Sel; toggle: (k: string) => void; live: boolean; titleOf: Map<string, string>;
}) {
  const accepted = !!p.accepted[i.key];
  const sp = i.spec || {};
  const has = !!(sp.goal || sp.acceptance?.length || sp.outOfScope?.length || sp.files?.length || i.note || i.dependsOn.length || i.links.length);
  return (
    <li className="pp-node pp-item">
      <div className="pp-row">
        {live && !accepted && <Check k={i.key} label={`item ${i.title}`} sel={sel} toggle={toggle} />}
        <span className="k-tag">{ITEM_KIND_LABEL[i.kind] || 'Item'}</span>
        <span className="pp-name">{i.title}</span>
        {i.area && <span className="k-tag mono">{i.area}</span>}
        <AcceptedRef slug={slug} p={p} k={i.key} />
      </div>
      {has && (
        <details className="pp-spec">
          <summary>Details{sp.acceptance?.length ? ` · ${plural(sp.acceptance.length, 'acceptance criterion')}`.replace('criterions', 'criteria') : ''}</summary>
          {sp.goal && <p className="pp-p">{sp.goal}</p>}
          {i.note && <p className="pp-p">{i.note}</p>}
          {!!sp.acceptance?.length && <><span className="sp-eyebrow">Acceptance</span><ul className="pp-list">{sp.acceptance.map((a, n) => <li key={n}>{a}</li>)}</ul></>}
          {!!sp.outOfScope?.length && <><span className="sp-eyebrow">Out of scope</span><ul className="pp-list">{sp.outOfScope.map((a, n) => <li key={n}>{a}</li>)}</ul></>}
          {!!sp.files?.length && <><span className="sp-eyebrow">Files</span><ul className="pp-list">{sp.files.map((a, n) => <li key={n}><code>{a}</code></li>)}</ul></>}
          {i.dependsOn.length > 0 && <><span className="sp-eyebrow">Depends on</span>
            <ul className="pp-list">{i.dependsOn.map((k) => <li key={k}>{titleOf.get(k) || k}</li>)}</ul></>}
          <Links slug={slug} links={i.links} />
        </details>
      )}
    </li>
  );
}

// THE OWNER'S EDIT: the words, and which parts stay. Accepted parts are locked,
// because the real row is the truth for them now.
function PropositionEditor({ p, busy, onSave, onCancel }: {
  p: Proposition; busy: boolean; onCancel: () => void;
  onSave: (patch: Partial<Pick<Proposition, 'title' | 'outcome' | 'purpose' | 'tree'>>) => void;
}) {
  const [title, setTitle] = useState(p.title);
  const [outcome, setOutcome] = useState(p.outcome);
  const [purpose, setPurpose] = useState(p.purpose);
  const [tree, setTree] = useState<PropMilestone[]>(() => JSON.parse(JSON.stringify(p.tree.milestones)));
  const locked = (k: string) => !!p.accepted[k];
  const upd = (fn: (t: PropMilestone[]) => void) => setTree((t) => { const n: PropMilestone[] = JSON.parse(JSON.stringify(t)); fn(n); return n; });
  return (
    <div className="pp-edit">
      <label className="km-field"><span className="lbl">Title</span>
        <span className="searchbox km-input"><input value={title} onChange={(e) => setTitle(e.target.value)} /></span></label>
      <label className="km-field"><span className="lbl">Outcome</span>
        <span className="searchbox km-input"><input value={outcome} onChange={(e) => setOutcome(e.target.value)} /></span></label>
      <label className="km-field"><span className="lbl">Purpose</span>
        <textarea className="km-textarea" rows={4} value={purpose} onChange={(e) => setPurpose(e.target.value)} /></label>
      <span className="sp-eyebrow">Structure</span>
      <ul className="pp-tree">
        {tree.map((m, mi) => (
          <li key={m.key} className="pp-node pp-ms">
            <div className="pp-row">
              <span className="k-tag info">Milestone</span>
              {m.milestoneId === null
                ? <span className="searchbox km-input pp-ein"><input aria-label="Milestone name" value={m.name} disabled={locked(m.key)}
                    onChange={(e) => upd((t) => { t[mi].name = e.target.value; })} /></span>
                : <span className="pp-name">Existing milestone #{m.milestoneId}</span>}
            </div>
            <ul className="pp-kids">
              {m.slices.map((s, si) => (
                <li key={s.key} className="pp-node pp-slice">
                  <div className="pp-row">
                    <span className="k-tag">Slice</span>
                    <span className="searchbox km-input pp-ein"><input aria-label="Slice title" value={s.title} disabled={locked(s.key)}
                      onChange={(e) => upd((t) => { t[mi].slices[si].title = e.target.value; })} /></span>
                    {!locked(s.key) && !s.items.some((i) => locked(i.key)) && (
                      <button className="km-colbtn" aria-label={`Remove slice ${s.title}`}
                        onClick={() => upd((t) => { t[mi].slices.splice(si, 1); })}><KitIcon name="x" size={14} /></button>
                    )}
                  </div>
                  <ul className="pp-kids">
                    {s.items.map((i, ii) => (
                      <li key={i.key} className="pp-node pp-item">
                        <div className="pp-row">
                          <select className="k-select sm" aria-label="Kind" value={i.kind} disabled={locked(i.key)}
                            onChange={(e) => upd((t) => { t[mi].slices[si].items[ii].kind = e.target.value as PropItem['kind']; })}>
                            <option value="">Item</option><option value="story">Story</option><option value="task">Task</option>
                          </select>
                          <span className="searchbox km-input pp-ein"><input aria-label="Item title" value={i.title} disabled={locked(i.key)}
                            onChange={(e) => upd((t) => { t[mi].slices[si].items[ii].title = e.target.value; })} /></span>
                          {!locked(i.key) && (
                            <button className="km-colbtn" aria-label={`Remove item ${i.title}`}
                              onClick={() => upd((t) => { t[mi].slices[si].items.splice(ii, 1); })}><KitIcon name="x" size={14} /></button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <div className="km-dialog-foot">
        <button className="k-btn ghost" onClick={onCancel}>Cancel</button>
        <button className="k-btn" disabled={busy || !title.trim()} onClick={() => onSave({ title, outcome, purpose, tree: { milestones: tree } })}>Save</button>
      </div>
    </div>
  );
}
