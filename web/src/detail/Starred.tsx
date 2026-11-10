// STARRED — the owner's shortlist inside a project: the cards, notes and docs
// they starred, one click from where each one lives. The rail row under For
// you; the server is routes/starred.js, whose header has the rules.
//
//  • THREE GROUPS, newest star first: Cards, Notes, Docs. Each row says where
//    the thing stands now (a card's state and slice, a doc's kind) and links to
//    its own screen, with `hl` naming it so that screen scrolls to it.
//  • A CARD LINKS TO WHERE `homeOf` DRAWS IT (lib/plan.ts): the board, or
//    Ideas & Icebox. A link to the board for an iced card would land on nothing.
//  • UNSTAR KEEPS THE ROW until you leave the screen, drawn faint with its star
//    empty, so a slip of the hand is one press to undo. Nothing here sorts,
//    ranks or runs work: a star is not priority.

import { useCallback, useEffect, useState } from 'react';
import type { Artifact, Milestone, RoadmapItem, Slice } from '../types';
import { getStarred, setStarred, type StarKind } from '../store';
import { homeOf, isBuilt } from '../lib/plan';
import { hrefTo } from '../lib/route';
import { timeAgo } from '../lib/ui';
import { StarButton } from '../components/Star';
import { KitIcon } from './kit/KitIcon';

type Row = { kind: StarKind; id: number; on: boolean };

/** Where a card stands, in the words the board uses. */
function cardState(it: RoadmapItem, slices: Slice[]): { label: string; tone: string; where: string } {
  const slice = it.sliceId != null ? slices.find((s) => s.id === it.sliceId) : null;
  const where = it.archived ? 'Archived' : slice ? slice.title : homeOf(it) === 'auto' ? 'Ideas, awaiting sign-off' : 'Icebox';
  if (it.done) return { label: 'Done', tone: 'ok', where };
  if (isBuilt(it)) return { label: 'Built, awaiting verdict', tone: 'info', where };
  if ((it.claimedBy || '').trim()) return { label: 'In progress', tone: 'warn', where };
  if (it.ready) return { label: 'Ready', tone: 'info', where };
  if (it.skipped) return { label: 'Parked', tone: 'neutral', where };
  return { label: 'To do', tone: 'neutral', where };
}

const DOC_LABEL: Record<string, string> = {
  doc: 'Doc', plan: 'Plan', design: 'Design', link: 'Link', file: 'File',
  charter: 'Charter', architecture: 'Architecture doc', design_doc: 'Design doc', adr: 'Decision',
};

/** A note's title is its first line (detail/Notes.tsx); a doc's is its title. */
function docTitle(a: Artifact): string {
  if (a.type === 'note' || !a.title.trim()) {
    const line = a.body.split('\n').find((l) => l.trim()) || '';
    return line.replace(/^\s*(#+|[-*]|\d+\.)\s*/, '').trim() || (a.type === 'note' ? 'Empty note' : `Untitled ${(DOC_LABEL[a.type] || 'doc').toLowerCase()}`);
  }
  return a.title;
}

/** The screen a doc lives on, with `hl` naming it there. */
function docHref(slug: string, a: Artifact): string {
  switch (a.type) {
    case 'note': return hrefTo.detail(slug, 'notes', `note-${a.id}`);
    case 'charter': return hrefTo.detail(slug, 'charter');
    case 'architecture': return hrefTo.detail(slug, 'architecture');
    case 'adr': return hrefTo.detail(slug, 'architecture', `doc-${a.id}`);
    case 'design_doc': return hrefTo.detail(slug, 'design');
    default: return hrefTo.detail(slug, 'artifacts', `doc-${a.id}`);
  }
}

export function Starred({ slug, slices, onChanged }: {
  slug: string; slices: Slice[]; milestones: Milestone[];
  /** Re-read the payload, which carries the rail's Starred count. */
  onChanged: () => void;
}) {
  const [data, setData] = useState<{ cards: RoadmapItem[]; docs: Artifact[] } | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());   // unstarred this visit, kept to undo
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    getStarred(slug).then(setData).catch((e) => setErr((e as Error)?.message || 'Could not read the starred list.'));
  }, [slug]);
  useEffect(() => { setData(null); setOff(new Set()); load(); }, [load]);

  const toggle = async ({ kind, id, on }: Row) => {
    setErr('');
    try {
      await setStarred(slug, kind, id, !on);
      setOff((s) => { const n = new Set(s); if (on) n.add(`${kind}:${id}`); else n.delete(`${kind}:${id}`); return n; });
      onChanged();
    } catch (e) { setErr((e as Error)?.message || 'Could not change the star.'); }
  };
  const isOn = (kind: StarKind, id: number) => !off.has(`${kind}:${id}`);

  const notes = data?.docs.filter((d) => d.type === 'note') ?? [];
  const docs = data?.docs.filter((d) => d.type !== 'note') ?? [];
  const total = data ? data.cards.length + data.docs.length : 0;
  // What is starred NOW: a row unstarred this visit stays on screen to undo,
  // but it is not counted, so this agrees with the rail's badge.
  const live = total - off.size;

  const group = (label: string, count: number, body: React.ReactNode) => count > 0 && (
    <section className="st-group" aria-label={label}>
      <div className="ms-grouphead"><span className="sp-eyebrow">{label}</span><span className="sp-when">{count}</span><span className="ms-hr" /></div>
      <div className="st-list">{body}</div>
    </section>
  );

  return (
    <div className="sp st">
      <div className="ms-intro">
        <span className="sp-when">{data ? `${live} starred` : 'Reading…'}</span>
        <p>Your shortlist for this project: the cards, notes and docs you want one click away. A star is just a
          bookmark. It does not change priority or what gets built.</p>
      </div>
      {err && <div className="km-err" role="alert">{err}</div>}

      {data && total === 0 && (
        <div className="st-empty">
          <KitIcon name="star" size={22} />
          <p>Nothing starred yet.</p>
          <span>Star a card from its menu or its zoomed view, a note from its footer, or a doc or decision from its header.
            It lands here.</span>
        </div>
      )}

      {data && group('Cards', data.cards.length, data.cards.map((it) => {
        const on = isOn('cards', it.id);
        const st = cardState(it, slices);
        const tab = homeOf(it) === 'board' ? 'roadmap' : 'auto';
        return (
          <div key={it.id} className={`st-row${on ? '' : ' off'}`}>
            <StarButton on={on} onToggle={() => toggle({ kind: 'cards', id: it.id, on })} what={`#${it.id}`} />
            <a className="st-main" href={hrefTo.detail(slug, tab, String(it.id))}>
              <span className="st-title"><span className="st-id">#{it.id}</span>{it.title}</span>
              <span className="st-sub">{st.where}</span>
            </a>
            <span className={`ms-chip ${st.tone === 'ok' ? 'ok' : st.tone === 'neutral' ? 'open' : st.tone}`}>{st.label}</span>
          </div>
        );
      }))}

      {data && group('Notes', notes.length, notes.map((a) => {
        const on = isOn('docs', a.id);
        const converted = a.tags.includes('converted');
        return (
          <div key={a.id} className={`st-row${on ? '' : ' off'}`}>
            <StarButton on={on} onToggle={() => toggle({ kind: 'docs', id: a.id, on })} what="this note" />
            <a className="st-main" href={docHref(slug, a)}>
              <span className="st-title">{docTitle(a)}</span>
              <span className="st-sub">{converted ? 'Turned into work' : 'Note'} · edited {timeAgo(a.updatedAt)}</span>
            </a>
          </div>
        );
      }))}

      {data && group('Docs', docs.length, docs.map((a) => {
        const on = isOn('docs', a.id);
        return (
          <div key={a.id} className={`st-row${on ? '' : ' off'}`}>
            <StarButton on={on} onToggle={() => toggle({ kind: 'docs', id: a.id, on })} what="this doc" />
            <a className="st-main" href={docHref(slug, a)}>
              <span className="st-title">{docTitle(a)}</span>
              <span className="st-sub">{DOC_LABEL[a.type] || 'Doc'}{a.type === 'adr' && a.status ? ` · ${a.status}` : ''} · edited {timeAgo(a.updatedAt)}</span>
            </a>
          </div>
        );
      }))}
    </div>
  );
}
