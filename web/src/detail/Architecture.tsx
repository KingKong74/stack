// CHARTER AND ARCHITECTURE (#616, spine phase 2): what the project is for, and
// how it is built. Markdown first, structured later (the spec's order).
//
//  • THE CHARTER is one `charter` artifact per project (a unique index on the
//    server). SessionStart injects its OPENING into every session, capped at
//    the server's CHARTER_SUMMARY_CAP, and the editor says so under the text:
//    the first paragraph is what an agent reads, so it should stand alone.
//  • THE ARCHITECTURE TAB has three parts:
//      - COMPONENTS are the project's AREAS (owner's call, #608): a name and
//        colour from the board, plus a description and the code paths it
//        owns. The area LANE is still keyed by the name alone; paths gate
//        nothing yet, and the tab says so rather than imply otherwise.
//      - THE ARCHITECTURE DOC, one `architecture` artifact, the same editor.
//      - THE DECISION LOG: `adr` artifacts, numbered by age (ADR-1 is the
//        oldest), each with a status (proposed → accepted → superseded) and
//        the slice it was decided for. A human gives the status; phase 4 lets
//        /checkpoint PROPOSE one, never accept it.
//
// Everything here is a human's write, through routes/artifacts.js and the
// board's area routes. Nothing is fetched into the project payload except the
// charter's capped opening.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { KitIcon } from './kit/KitIcon';
import { Markdown } from '../components/Markdown';
import type { AdrStatus, Artifact, BoardArea, Milestone, RoadmapItem, Slice } from '../types';
import { getSpineDocs, createArtifact, patchArtifact, deleteArtifact, getBoardShape, patchArea } from '../store';
import { liveSlices, sliceLabel } from './Spine';
import { timeAgo } from '../lib/ui';

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
  const put = (a: Artifact) => setDocs((xs) => {
    const list = xs || [];
    return list.some((x) => x.id === a.id) ? list.map((x) => (x.id === a.id ? a : x)) : [...list, a];
  });
  const drop = (id: number) => setDocs((xs) => (xs || []).filter((x) => x.id !== id));
  return { docs, err, setErr, put, drop };
}

/**
 * ONE MARKDOWN DOC, read or edited in place. Read mode renders it; Edit opens
 * a textarea with Save and Cancel. An empty doc offers its template, because
 * a blank page is where charters go to not get written.
 */
function DocEditor({ doc, template, emptyLine, footnote, onSave }: {
  doc: Artifact | null; template: string; emptyLine: string; footnote?: string;
  onSave: (body: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const start = (body: string) => { setText(body); setEditing(true); };
  const save = async () => {
    setBusy(true);
    try { await onSave(text); setEditing(false); } finally { setBusy(false); }
  };
  if (editing) {
    return (
      <div className="sp-doc editing">
        <textarea className="km-textarea sp-doctext" value={text} rows={18} autoFocus
          aria-label="Markdown" onChange={(e) => setText(e.target.value)} />
        {footnote && <span className="sp-foot">{footnote}</span>}
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
async function upsertDoc(slug: string, doc: Artifact | null, type: 'charter' | 'architecture', title: string, body: string) {
  return doc ? patchArtifact(slug, doc.id, { body }) : createArtifact(slug, { type, title, body });
}

export function Charter({ slug, cap }: { slug: string; cap: number }) {
  const { docs, err, setErr, put } = useSpineDocs(slug);
  const charter = docs?.find((d) => d.type === 'charter') ?? null;
  return (
    <div className="sp">
      <div className="sp-lede">
        <h2 className="sp-h">Charter</h2>
        <span>Why this project exists, who it is for and what done looks like. The project's spine starts here.</span>
      </div>
      {err && <div className="km-err" role="alert">{err}</div>}
      {docs === null && !err && <span className="sp-empty">Reading…</span>}
      {docs !== null && (
        <DocEditor doc={charter} template={CHARTER_TEMPLATE}
          emptyLine="No charter yet. Every session starts by reading its opening, so a few lines here pay for themselves."
          footnote={`Every Claude session on this project is told the first ${cap} characters of this charter.`}
          onSave={async (body) => {
            try { setErr(''); put(await upsertDoc(slug, charter, 'charter', 'Charter', body)); }
            catch (e) { setErr((e as Error)?.message || 'Could not save the charter.'); throw e; }
          }} />
      )}
    </div>
  );
}

export function Architecture({ slug, items, slices, milestones }: {
  slug: string; items: RoadmapItem[]; slices: Slice[]; milestones: Milestone[];
}) {
  const { docs, err, setErr, put, drop } = useSpineDocs(slug);
  const [areas, setAreas] = useState<BoardArea[] | null>(null);
  useEffect(() => {
    getBoardShape(slug).then((s) => setAreas(s.areas)).catch((e) => setErr((e as Error)?.message || 'Could not read the components.'));
  }, [slug]);
  const arch = docs?.find((d) => d.type === 'architecture') ?? null;
  const adrs = useMemo(() => (docs || []).filter((d) => d.type === 'adr'), [docs]);
  const guard = async (fn: () => Promise<void>) => {
    try { setErr(''); await fn(); } catch (e) { setErr((e as Error)?.message || 'Something went wrong.'); }
  };

  return (
    <div className="sp">
      <div className="sp-lede">
        <h2 className="sp-h">Architecture</h2>
        <span>The system map, how it is built, and the decisions behind it. Slices name the components they touch.</span>
      </div>
      {err && <div className="km-err" role="alert">{err}</div>}

      <section className="sp-sec">
        <div className="sp-sechead">
          <span className="sp-eyebrow">Components</span>
          <span className="sp-dim">The board's areas. The automation's lane is still the area's name; paths are notes for now.</span>
        </div>
        {areas === null && <span className="sp-empty">Reading…</span>}
        {areas?.length === 0 && <span className="sp-empty">No areas yet. Make one from the board’s “New area”.</span>}
        <div className="sp-comps">
          {(areas || []).map((a) => (
            <Component key={a.name} area={a}
              open={items.filter((it) => !it.archived && !it.done && it.area.trim() === a.name).length}
              touchedBy={liveSlices(slices, milestones).filter((s) => s.areas.includes(a.name)).map((s) => sliceLabel(s, milestones))}
              onSave={(v) => guard(async () => { setAreas(await patchArea(slug, a.name, v)); })} />
          ))}
        </div>
      </section>

      <section className="sp-sec">
        <div className="sp-sechead"><span className="sp-eyebrow">Architecture doc</span></div>
        {docs !== null && (
          <DocEditor doc={arch} template={ARCH_TEMPLATE}
            emptyLine="No architecture doc yet: the system map, the data model, how a change flows."
            onSave={async (body) => {
              try { setErr(''); put(await upsertDoc(slug, arch, 'architecture', 'Architecture', body)); }
              catch (e) { setErr((e as Error)?.message || 'Could not save it.'); throw e; }
            }} />
        )}
      </section>

      <section className="sp-sec">
        <div className="sp-sechead">
          <span className="sp-eyebrow">Decisions</span>
          <span className="sp-dim">One per design call, oldest first. You rule on the status; a session may only propose.</span>
          <span className="sp-rule" />
          <button className="k-btn sm secondary" onClick={() => guard(async () => {
            put(await createArtifact(slug, { type: 'adr', title: 'Untitled decision', body: ADR_TEMPLATE, status: 'proposed' }));
          })}><KitIcon name="plus" size={13} />Decision</button>
        </div>
        {docs !== null && adrs.length === 0 && <span className="sp-empty">No decisions recorded yet.</span>}
        {adrs.map((d, i) => (
          <Adr key={d.id} n={i + 1} adr={d} slices={slices} milestones={milestones}
            onPatch={(patch) => guard(async () => { put(await patchArtifact(slug, d.id, patch)); })}
            onDelete={() => guard(async () => { await deleteArtifact(slug, d.id); drop(d.id); })} />
        ))}
      </section>
    </div>
  );
}

function Component({ area, open, touchedBy, onSave }: {
  area: BoardArea; open: number; touchedBy: string[];
  onSave: (v: { description: string; paths: string[] }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [desc, setDesc] = useState(area.description);
  const [paths, setPaths] = useState(area.paths.join('\n'));
  useEffect(() => { setDesc(area.description); setPaths(area.paths.join('\n')); }, [area]);
  return (
    <div className="sp-comp">
      <div className="sp-comphead">
        <span className="km-dot" style={{ background: area.dot }} />
        <span className="sp-compname">{area.name}</span>
        {!area.registered && <span className="k-tag" title="Named by a card or a slice, never registered on the board">unregistered</span>}
        <span className="sp-rule" />
        <span className="sp-dim">{open} open</span>
        {!editing && (
          <button className="km-colbtn" aria-label={`Edit component ${area.name}`} title="Describe this component"
            onClick={() => setEditing(true)}><KitIcon name="pencil" size={12} /></button>
        )}
      </div>
      {editing ? (
        <div className="sp-compedit">
          <textarea className="km-textarea" rows={3} value={desc} placeholder="What this component is and what it is responsible for."
            aria-label={`Description of ${area.name}`} onChange={(e) => setDesc(e.target.value)} />
          <textarea className="km-textarea sp-mono" rows={3} value={paths} placeholder={'Code it owns, one glob per line\nserver/src/routes/spine.js'}
            aria-label={`Paths owned by ${area.name}`} onChange={(e) => setPaths(e.target.value)} />
          <div className="sp-docacts">
            <button className="k-btn ghost sm" onClick={() => setEditing(false)}>Cancel</button>
            <button className="k-btn sm" onClick={() => { setEditing(false); onSave({ description: desc, paths: paths.split('\n') }); }}>Save</button>
          </div>
        </div>
      ) : (
        <>
          {area.description.trim()
            ? <p className="sp-compdesc">{area.description}</p>
            : <p className="sp-compdesc sp-dim">No description yet.</p>}
          {area.paths.length > 0 && <div className="sp-paths">{area.paths.map((p) => <code key={p}>{p}</code>)}</div>}
        </>
      )}
      {touchedBy.length > 0 && (
        <div className="sp-touched"><span className="sp-dim">Touched by</span>{touchedBy.map((t) => <span className="k-tag" key={t}>{t}</span>)}</div>
      )}
    </div>
  );
}

function Adr({ n, adr, slices, milestones, onPatch, onDelete }: {
  n: number; adr: Artifact; slices: Slice[]; milestones: Milestone[];
  onPatch: (p: { title?: string; body?: string; status?: AdrStatus; sliceId?: number | null }) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(adr.title === 'Untitled decision');
  const [editing, setEditing] = useState(adr.title === 'Untitled decision');
  const [title, setTitle] = useState(adr.title);
  const [body, setBody] = useState(adr.body);
  const [confirming, setConfirming] = useState(false);
  const st = STATUS[(adr.status || 'proposed') as AdrStatus];
  const slice = slices.find((s) => s.id === adr.sliceId) || null;
  return (
    <div className={`sp-adr${open ? ' open' : ''}`}>
      <div className="sp-adrhead" onClick={() => !editing && setOpen(!open)}>
        <KitIcon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
        <span className="sp-adrn">ADR-{n}</span>
        <span className="sp-adrtitle">{adr.title}</span>
        <span className={`k-tag ${st.tone}`.trim()} title={st.hint}>{st.label}</span>
        {/* #626 — a session's proposal says so: only the owner accepts one. */}
        {adr.origin.kind === 'checkpoint' && (
          <span className="k-tag" title={`Proposed by a session${adr.origin.branch ? ` on ${adr.origin.branch}` : ''}. Deleting it dismisses it for good.`}>from a session</span>
        )}
        {slice && <span className="k-tag" title="The slice this was decided for">{sliceLabel(slice, milestones)}</span>}
        <span className="sp-when">{timeAgo(adr.updatedAt)}</span>
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
