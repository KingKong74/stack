// CHARTER AND ARCHITECTURE (#616, spine phase 2): what the project is for, and
// how it is built. Markdown first, structured later (the spec's order).
//
//  • THE CHARTER is one `charter` artifact per project (a unique index on the
//    server). It reads as Charter.dc.html, through the same conventions as
//    the architecture doc (lib/archDoc.ts). SessionStart injects its OPENING into every session, capped at
//    the server's CHARTER_SUMMARY_CAP, and the editor says so under the text:
//    the first paragraph is what an agent reads, so it should stand alone.
//  • THE ARCHITECTURE TAB has two parts:
//      - THE ARCHITECTURE DOC, one `architecture` artifact, the same editor.
//        It READS as the design's page (Architecture.dc.html): numbered
//        sections, a system map, cards and steps, drawn from markdown
//        conventions that lib/archDoc.ts's header lists. The text stays the
//        source; anything off-convention draws as plain markdown.
//      - THE DECISION LOG: `adr` artifacts, numbered by age (ADR-1 is the
//        oldest), each with a status (proposed → accepted → superseded) and
//        the slice it was decided for. A human gives the status; phase 4 lets
//        /checkpoint PROPOSE one, never accept it.
//
//  • THE DESIGN TAB is one `design_doc` artifact (unique per project, like
//    the other two): colours, type, UI and UX considerations. It reads through
//    the same conventions as the architecture doc, so a `## Colours` section
//    with a list of swatches draws as any other section does.
//
// Everything here is a human's write, through routes/artifacts.js.
// The board's areas are NOT drawn here (owner's call, 2026-11-09): they are
// the board's grouping and the automation's lane, not the system's components. Nothing is fetched into the project payload except the
// charter's capped opening.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { KitIcon } from './kit/KitIcon';
import { Markdown, block, inline } from '../components/Markdown';
import { ArchSections, SecHead, sectionId } from './ArchDoc';
import { parseArchDoc } from '../lib/archDoc';
import type { AdrStatus, Artifact, Milestone, Slice } from '../types';
import { getSpineDocs, createArtifact, patchArtifact, deleteArtifact, setStarred } from '../store';
import { StarButton } from '../components/Star';
import { liveSlices, sliceLabel } from './Spine';
import { timeAgo } from '../lib/ui';
import { useAutoRefresh } from '../lib/autoRefresh';

const CHARTER_TEMPLATE = `# Charter

What this project is for, in one paragraph. This opening is what every session is told, so it should stand on its own.

## Who it is for

## What success looks like

## Out of scope
`;
const ARCH_TEMPLATE = `# Architecture

## System map

## Data model

## How a change flows through it
`;
const DESIGN_TEMPLATE = `# Design

The look and feel in one paragraph: who it is for, the mood, and the one rule every screen keeps.

## Colours

- **Background** — hex value, and where it is used
- **Surface** — hex value, and where it is used
- **Text** — hex value, and where it is used
- **Accent** — hex value, and where it is used
- **Success / warning / danger** — hex value, and where it is used

## Typography

## Layout and spacing

## Components

## UX principles

## Accessibility

## Don'ts
`;
const ADR_TEMPLATE = `## Context

## Decision

## Consequences
`;

const STATUS: Record<AdrStatus, { label: string; tone: string; hint: string }> = {
  proposed: { label: 'Proposed', tone: 'warning', hint: 'Written down, not yet ruled on' },
  accepted: { label: 'Accepted', tone: 'success', hint: 'The way it is done now' },
  superseded: { label: 'Superseded', tone: '', hint: 'Replaced by a later decision; kept for the record' },
};

/** Load the spine's docs once per slug; `put` writes one back into the list. */
function useSpineDocs(slug: string) {
  const [docs, setDocs] = useState<Artifact[] | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    getSpineDocs(slug).then(setDocs).catch((e) => setErr((e as Error)?.message || 'Could not read these docs.'));
  }, [slug]);
  useEffect(() => { setDocs(null); load(); }, [load]);
  // RE-READ ON THE APP'S CADENCE, and at once on coming back to the tab. Read
  // once per slug, an open tab kept showing a charter that had been rewritten
  // elsewhere, and an Edit there started from that stale copy (2026-11-11).
  useAutoRefresh(load);
  // …and ALWAYS on coming back to the tab or window, whatever the Auto refresh
  // setting: one light read, at the moment a stale page would be acted on.
  useEffect(() => {
    const back = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('focus', back);
    return () => { document.removeEventListener('visibilitychange', back); window.removeEventListener('focus', back); };
  }, [load]);
  // The server's current version of one doc, for Save's stale check.
  const latestAt = useCallback(async (id: number) => (await getSpineDocs(slug)).find((x) => x.id === id)?.updatedAt ?? '', [slug]);
  const put = (a: Artifact) => setDocs((xs) => {
    const list = xs || [];
    return list.some((x) => x.id === a.id) ? list.map((x) => (x.id === a.id ? a : x)) : [...list, a];
  });
  const drop = (id: number) => setDocs((xs) => (xs || []).filter((x) => x.id !== id));
  return { docs, err, setErr, put, drop, latestAt };
}

/**
 * ONE MARKDOWN DOC, read or edited in place. Read mode renders it; Edit opens
 * a textarea with Save and Cancel. An empty doc offers its template, because
 * a blank page is where charters go to not get written.
 */
function DocEditor({ doc, template, emptyLine, footnote, onSave, view, latestAt }: {
  doc: Artifact | null; template: string; emptyLine: string; footnote?: string;
  /** The server's current `updatedAt` for a doc, asked at Save time. */
  latestAt: (id: number) => Promise<string>;
  onSave: (body: string) => Promise<void>;
  /** Draw the saved doc yourself; `edit` opens the editor on its text. */
  view?: (doc: Artifact, edit: () => void) => ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  // The version the edit started from. If the doc changes underneath (another
  // tab, a session, the API), Save refuses rather than overwrite the newer text.
  const [base, setBase] = useState('');
  const [stale, setStale] = useState(false);
  const start = (body: string) => { setText(body); setBase(doc?.updatedAt || ''); setStale(false); setEditing(true); };
  // ASKED OF THE SERVER, not of this tab's copy: the copy is exactly what may
  // be stale, so comparing against it would let the stale save through.
  const save = async () => {
    setBusy(true);
    try {
      if (doc && base && (await latestAt(doc.id)) !== base) { setStale(true); return; }
      await onSave(text); setEditing(false);
    } finally { setBusy(false); }
  };
  if (editing) {
    return (
      <div className="sp-doc editing">
        <textarea className="km-textarea sp-doctext" value={text} rows={18} autoFocus
          aria-label="Markdown" onChange={(e) => setText(e.target.value)} />
        {footnote && <span className="sp-foot">{footnote}</span>}
        {stale && (
          <div className="km-err" role="alert">
            This changed somewhere else after you opened it, so saving would overwrite the newer version.
            Copy anything you want to keep, then Cancel to see the latest and edit that.
          </div>
        )}
        <div className="sp-docacts">
          <button className="k-btn ghost sm" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
          <button className="k-btn sm" onClick={save} disabled={busy}>Save</button>
        </div>
      </div>
    );
  }
  if (!doc || !doc.body.trim()) {
    return (
      <div className="sp-doc empty">
        <span className="sp-empty">{emptyLine}</span>
        <div className="sp-docacts">
          <button className="k-btn sm secondary" onClick={() => start('')}>Write from blank</button>
          <button className="k-btn sm" onClick={() => start(template)}>Start from the outline</button>
        </div>
      </div>
    );
  }
  if (view) return <>{view(doc, () => start(doc.body))}</>;
  return (
    <div className="sp-doc">
      <div className="sp-docacts top">
        <span className="sp-when">Edited {timeAgo(doc.updatedAt)}</span>
        <button className="k-btn ghost sm" onClick={() => start(doc.body)}><KitIcon name="pencil" size={13} />Edit</button>
      </div>
      <div className="ar-md"><Markdown text={doc.body} /></div>
      {footnote && <span className="sp-foot">{footnote}</span>}
    </div>
  );
}

/** Create the one doc of a type, or patch it. */
async function upsertDoc(slug: string, doc: Artifact | null, type: 'charter' | 'architecture' | 'design_doc', title: string, body: string) {
  return doc ? patchArtifact(slug, doc.id, { body }) : createArtifact(slug, { type, title, body });
}

// `aside` is the milestone summary (detail/Milestones.tsx): milestones are real
// rows with their own tab, so the Charter shows them beside the doc and never
// keeps a copy of them in its text.
//
// THE LOOK is Charter.dc.html: an "On this page" list on the left (wide
// screens only), the doc in a reading column (eyebrow, the opening in display
// type, then numbered sections under rules), and a rail on the right: the
// milestone summary, then two fixed boxes that state how Stack treats every
// project (what an agent is told at session start, and who decides).
// The contents list scrolls in place, because a `#id` link would fight the
// hash router.
export function Charter({ slug, cap, aside }: { slug: string; cap: number; aside?: ReactNode }) {
  const { docs, err, setErr, put, latestAt } = useSpineDocs(slug);
  const charter = docs?.find((d) => d.type === 'charter') ?? null;
  const parsed = useMemo(() => parseArchDoc(charter?.body || ''), [charter?.body]);
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const showToc = !!charter?.body.trim() && parsed.sections.length > 0;
  return (
    <div className="ch">
      {showToc && (
        <nav className="ch-toc" aria-label="On this page">
          <span className="sp-eyebrow">On this page</span>
          <button onClick={() => jump('ch-overview')}>Overview</button>
          {parsed.sections.map((x) => <button key={x.n} onClick={() => jump(sectionId(x))}>{x.title}</button>)}
        </nav>
      )}
      <div className="sp doc-view ch-main">
        {err && <div className="km-err" role="alert">{err}</div>}
        {docs === null && !err && <span className="sp-empty">Reading…</span>}
        {docs !== null && (
          <DocEditor doc={charter} template={CHARTER_TEMPLATE} latestAt={latestAt}
            emptyLine="No charter yet. Every session starts by reading its opening, so a few lines here pay for themselves."
            footnote={`Every Claude session on this project is told the first ${cap} characters of this charter.`}
            onSave={async (body) => {
              try { setErr(''); put(await upsertDoc(slug, charter, 'charter', 'Charter', body)); }
              catch (e) { setErr((e as Error)?.message || 'Could not save the charter.'); throw e; }
            }}
            view={(doc, edit) => (
              <>
                <section className="ch-overview" id="ch-overview">
                  <div className="ch-metarow">
                    <div className="doc-meta">
                      <span className="doc-eyebrow">Charter</span>
                      <span className="doc-dot" />
                      <span className="sp-when">edited {timeAgo(doc.updatedAt)}</span>
                    </div>
                    <button className="k-btn ghost sm doc-edit" onClick={edit}><KitIcon name="pencil" size={13} />Edit</button>
                  </div>
                  <p className="ch-sub">Why this project exists, who it is for and what done looks like. The project's spine starts here.</p>
                  {parsed.lede.map((b, i) => b.k === 'p'
                    ? <p key={i} className="doc-ledep">{inline(b.text)}</p>
                    : <div key={i} className="md doc-md">{block(b, i)}</div>)}
                </section>
                <ArchSections sections={parsed.sections} ruled />
              </>
            )} />
        )}
      </div>
      <aside className="ch-rail" aria-label="Charter context">
        {aside}
        <div className="ch-box">
          <span className="sp-eyebrow">Agents get at session start</span>
          <div className="ch-kv">
            <div><span>Charter opening</span><span className="k">first {cap} chars</span></div>
            <div><span>Current milestone</span><span className="k">milestone</span></div>
            <div><span>Their slice</span><span className="k">slice</span></div>
            <div><span>Repo rules</span><span className="k strong">CLAUDE.md · AGENTS.md</span></div>
          </div>
        </div>
        <div className="ch-box">
          <span className="sp-eyebrow">Who decides</span>
          <div className="ch-who">
            <div>
              <span className="doc-label accent">Owner</span>
              <span>Verdicts</span><span>Milestones and slices</span><span>ADR status</span>
              <span>Every <span className="sp-mono">CLAUDE.md</span> save</span>
            </div>
            <div>
              <span className="doc-label dim">Agents</span>
              <span>Propose</span><span>Annotate</span><span className="dim">Never decide</span>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

export function Architecture({ slug, slices, milestones, highlightId, onStarred }: {
  slug: string; slices: Slice[]; milestones: Milestone[];
  /** `doc-<id>` from a Starred link: that decision opens. */
  highlightId?: string | null;
  /** Re-read the screen's Starred count after a star changes. */
  onStarred?: () => void;
}) {
  const { docs, err, setErr, put, drop, latestAt } = useSpineDocs(slug);
  const arch = docs?.find((d) => d.type === 'architecture') ?? null;
  const adrs = useMemo(() => (docs || []).filter((d) => d.type === 'adr'), [docs]);
  const guard = async (fn: () => Promise<void>) => {
    try { setErr(''); await fn(); } catch (e) { setErr((e as Error)?.message || 'Something went wrong.'); }
  };

  const parsed = useMemo(() => parseArchDoc(arch?.body || ''), [arch?.body]);
  const decisionsN = parsed.sections.length + 1;

  return (
    <div className="sp doc-view">
      {err && <div className="km-err" role="alert">{err}</div>}
      {docs === null && !err && <span className="sp-empty">Reading…</span>}
      {docs !== null && (
        <DocEditor doc={arch} template={ARCH_TEMPLATE} latestAt={latestAt}
          emptyLine="No architecture doc yet: the system map, the data model, how a change flows."
          onSave={async (body) => {
            try { setErr(''); put(await upsertDoc(slug, arch, 'architecture', 'Architecture', body)); }
            catch (e) { setErr((e as Error)?.message || 'Could not save it.'); throw e; }
          }}
          view={(doc, edit) => (
            <>
              <div className="doc-head">
                <div className="doc-lede">
                  <div className="doc-meta">
                    <span className="doc-eyebrow">Architecture doc</span>
                    <span className="doc-dot" />
                    <span className="sp-when">edited {timeAgo(doc.updatedAt)}</span>
                  </div>
                  {parsed.lede.map((b, i) => b.k === 'p'
                    ? <p key={i} className="doc-ledep">{inline(b.text)}</p>
                    : <div key={i} className="md doc-md">{block(b, i)}</div>)}
                </div>
                <button className="k-btn ghost sm doc-edit" onClick={edit}><KitIcon name="pencil" size={13} />Edit</button>
              </div>
              <ArchSections sections={parsed.sections} />
            </>
          )} />
      )}

      <section className="doc-sec doc-decisions">
        <SecHead n={decisionsN} title="Decisions">
          <span className="sp-dim">One per design call, oldest first. You rule on the status; a session may only propose.</span>
          <span className="sp-rule" />
          <button className="k-btn sm secondary" onClick={() => guard(async () => {
            put(await createArtifact(slug, { type: 'adr', title: 'Untitled decision', body: ADR_TEMPLATE, status: 'proposed' }));
          })}><KitIcon name="plus" size={13} />Decision</button>
        </SecHead>
        {docs !== null && adrs.length === 0 && <span className="sp-empty">No decisions recorded yet.</span>}
        {adrs.length > 0 && (
          <div className="doc-adrs">
            {adrs.map((d, i) => (
              <Adr key={d.id} n={i + 1} adr={d} slices={slices} milestones={milestones}
                opened={highlightId === `doc-${d.id}`}
                onStar={() => guard(async () => {
                  const r = await setStarred(slug, 'docs', d.id, !d.starredAt);
                  put({ ...d, starredAt: r.starredAt });
                  onStarred?.();
                })}
                onPatch={(patch) => guard(async () => { put(await patchArtifact(slug, d.id, patch)); })}
                onDelete={() => guard(async () => { await deleteArtifact(slug, d.id); drop(d.id); })} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Adr({ n, adr, slices, milestones, opened, onStar, onPatch, onDelete }: {
  n: number; adr: Artifact; slices: Slice[]; milestones: Milestone[];
  /** Open on mount (a Starred link named it). */
  opened?: boolean;
  /** Star or unstar it (the Starred tab; its own write, so "edited" stays put). */
  onStar: () => void;
  onPatch: (p: { title?: string; body?: string; status?: AdrStatus; sliceId?: number | null }) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(adr.title === 'Untitled decision' || !!opened);
  const [editing, setEditing] = useState(adr.title === 'Untitled decision');
  const [title, setTitle] = useState(adr.title);
  const [body, setBody] = useState(adr.body);
  const [confirming, setConfirming] = useState(false);
  const st = STATUS[(adr.status || 'proposed') as AdrStatus];
  const slice = slices.find((s) => s.id === adr.sliceId) || null;
  return (
    <div className={`sp-adr${open ? ' open' : ''}`} data-hl={`doc-${adr.id}`}>
      <div className="sp-adrhead" role="button" tabIndex={0} aria-expanded={open}
        onClick={() => !editing && setOpen(!open)}
        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && !editing) { e.preventDefault(); setOpen(!open); } }}>
        <span className="sp-adrn">ADR-{n}</span>
        <span className="sp-adrtitle">{adr.title}</span>
        {slice && <span className="sp-adrnote" title="The slice this was decided for">{sliceLabel(slice, milestones)}</span>}
        {/* #626 — a session's proposal says so: only the owner accepts one. */}
        {adr.origin.kind === 'checkpoint' && (
          <span className="sp-adrnote" title={`Proposed by a session${adr.origin.branch ? ` on ${adr.origin.branch}` : ''}. Deleting it dismisses it for good.`}>from a session</span>
        )}
        <span className={`k-tag ${st.tone}`.trim()} title={st.hint}>{st.label}</span>
        <StarButton on={!!adr.starredAt} onToggle={onStar} what={`ADR-${n}`} />
        <span className="sp-when sp-adrwhen">{timeAgo(adr.updatedAt)}</span>
      </div>
      {open && (
        <div className="sp-adrbody">
          <div className="sp-adrcontrols">
            <select className="k-select sm" aria-label={`Status of ADR-${n}`} value={adr.status || 'proposed'}
              onChange={(e) => onPatch({ status: e.target.value as AdrStatus })}>
              {(Object.keys(STATUS) as AdrStatus[]).map((k) => <option key={k} value={k}>{STATUS[k].label}</option>)}
            </select>
            <select className="k-select sm" aria-label={`Slice of ADR-${n}`} value={adr.sliceId === null ? '' : String(adr.sliceId)}
              onChange={(e) => onPatch({ sliceId: e.target.value === '' ? null : Number(e.target.value) })}>
              <option value="">No slice</option>
              {liveSlices(slices, milestones).map((s) => <option key={s.id} value={s.id}>{sliceLabel(s, milestones)}</option>)}
            </select>
            <span className="sp-rule" />
            {!editing && <button className="k-btn ghost sm" onClick={() => setEditing(true)}><KitIcon name="pencil" size={13} />Edit</button>}
            <button className="k-btn ghost sm danger" onClick={() => (confirming ? onDelete() : setConfirming(true))}>
              {confirming ? 'Really delete? Superseded keeps the record' : 'Delete'}
            </button>
          </div>
          {editing ? (
            <>
              <span className="searchbox km-input">
                <input value={title} aria-label={`Title of ADR-${n}`} onChange={(e) => setTitle(e.target.value)} />
              </span>
              <textarea className="km-textarea" rows={12} value={body} aria-label={`Body of ADR-${n}`} onChange={(e) => setBody(e.target.value)} />
              <div className="sp-docacts">
                <button className="k-btn ghost sm" onClick={() => { setTitle(adr.title); setBody(adr.body); setEditing(false); }}>Cancel</button>
                <button className="k-btn sm" disabled={!title.trim()}
                  onClick={() => { setEditing(false); onPatch({ title: title.trim(), body }); }}>Save</button>
              </div>
            </>
          ) : (
            <div className="ar-md"><Markdown text={adr.body} /></div>
          )}
        </div>
      )}
    </div>
  );
}

/** The Design view: one `design_doc`, read as the architecture doc reads. */
export function Design({ slug }: { slug: string }) {
  const { docs, err, setErr, put, latestAt } = useSpineDocs(slug);
  const design = docs?.find((d) => d.type === 'design_doc') ?? null;
  const parsed = useMemo(() => parseArchDoc(design?.body || ''), [design?.body]);
  return (
    <div className="sp doc-view">
      {err && <div className="km-err" role="alert">{err}</div>}
      {docs === null && !err && <span className="sp-empty">Reading…</span>}
      {docs !== null && (
        <DocEditor doc={design} template={DESIGN_TEMPLATE} latestAt={latestAt}
          emptyLine="No design doc yet: the colours, the type, and the UI and UX calls every screen should keep."
          onSave={async (body) => {
            try { setErr(''); put(await upsertDoc(slug, design, 'design_doc', 'Design', body)); }
            catch (e) { setErr((e as Error)?.message || 'Could not save it.'); throw e; }
          }}
          view={(doc, edit) => (
            <>
              <div className="doc-head">
                <div className="doc-lede">
                  <div className="doc-meta">
                    <span className="doc-eyebrow">Design doc</span>
                    <span className="doc-dot" />
                    <span className="sp-when">edited {timeAgo(doc.updatedAt)}</span>
                  </div>
                  {parsed.lede.map((b, i) => b.k === 'p'
                    ? <p key={i} className="doc-ledep">{inline(b.text)}</p>
                    : <div key={i} className="md doc-md">{block(b, i)}</div>)}
                </div>
                <button className="k-btn ghost sm doc-edit" onClick={edit}><KitIcon name="pencil" size={13} />Edit</button>
              </div>
              <ArchSections sections={parsed.sections} />
            </>
          )} />
      )}
    </div>
  );
}
