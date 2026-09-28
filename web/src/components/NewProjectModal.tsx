import { useState } from 'react';
import type { ProjectStatus, Project, SpaceArea } from '../types';
import { Modal } from './Modal';

// One modal for every way the Projects page makes or edits something: a new
// app, a new hub, a new workflow inside a hub, an edit of a project's details,
// and "Start →" on a wishlist idea (which is a new project, prefilled, whose
// idea is deleted once it exists — the page does that, not this).

export type ModalType = 'app' | 'hub' | 'workflow';
export type ModalInit = {
  mode: 'new' | 'edit';
  type?: ModalType;
  area?: string;
  hub?: string;
  name?: string;
  pitch?: string;
  status?: ProjectStatus;
  slug?: string;        // edit: the project being edited
  fromIdea?: number;    // new: the wishlist idea it starts from
};
export type ModalValue = {
  type: ModalType; name: string; pitch: string; area: string; hub: string; status: ProjectStatus;
};

const STATUSES: { key: ProjectStatus; label: string }[] = [
  { key: 'live', label: 'Live' },
  { key: 'building', label: 'Building' },
  { key: 'paused', label: 'Paused' },
];
const TYPES: { key: ModalType; label: string; desc: string }[] = [
  { key: 'app', label: 'App', desc: 'Has a UI and a preview' },
  { key: 'hub', label: 'Hub', desc: 'Hosts small workflows' },
  { key: 'workflow', label: 'Workflow', desc: 'Runs inside a hub' },
];
// The server's slugify, so the hint shows the name that will actually land.
const slugOf = (n: string) => n.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function NewProjectModal({ init, areas, hubs, onClose, onSubmit, onNewArea }: {
  init: ModalInit;
  areas: SpaceArea[];
  hubs: Project[];
  onClose: () => void;
  onSubmit: (v: ModalValue) => void;
  onNewArea: (name: string) => Promise<string | null>;
}) {
  const isEdit = init.mode === 'edit';
  const [type, setType] = useState<ModalType>(init.type || 'app');
  const [name, setName] = useState(init.name || '');
  const [pitch, setPitch] = useState(init.pitch || '');
  const [area, setArea] = useState(init.area || 'personal');
  const [hub, setHub] = useState(init.hub || hubs[0]?.id || '');
  const [status, setStatus] = useState<ProjectStatus>(init.status || 'building');
  const [newArea, setNewArea] = useState<string | null>(null);

  const slug = slugOf(name);
  // A workflow with no hub to run in can't be made; say so rather than grey out.
  const noHub = type === 'workflow' && !hub;
  const ready = !!slug && !noHub;
  const noun = isEdit ? 'project' : type === 'app' ? 'project' : type;
  const submit = () => { if (ready) onSubmit({ type, name, pitch, area, hub, status }); };

  return (
    <Modal onClose={onClose}>
      <div className="sp-modal" onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (e.target as HTMLElement).tagName === 'INPUT')) submit();
      }}>
        <div className="sp-modal-h">
          <h3>{isEdit ? 'Edit project' : init.fromIdea ? 'Start from idea' : `New ${noun}`}</h3>
          <span className="hint">{isEdit ? `editing ${init.name}` : init.fromIdea ? 'removes it from the wishlist' : ''}</span>
        </div>
        <div className="sp-modal-body">
          <label className="sp-field">
            <span className="sp-eyebrow">Name</span>
            <input className="sp-input mono" autoFocus value={name} placeholder="e.g. lighthouse"
              onChange={(e) => setName(e.target.value)} />
            {!!slug && slug !== name && <span className="sp-slug">→ {slug}</span>}
          </label>
          <label className="sp-field">
            <span className="sp-eyebrow">What is it? <span className="opt">optional</span></span>
            <input className="sp-input" value={pitch} placeholder="One line — the elevator pitch"
              onChange={(e) => setPitch(e.target.value)} />
          </label>
          {!isEdit && (
            <div className="sp-field">
              <span className="sp-eyebrow">Type</span>
              <div className="sp-types">
                {TYPES.map((t) => (
                  <button key={t.key} type="button" className={`sp-type${type === t.key ? ' on' : ''}`} onClick={() => setType(t.key)}>
                    <span className="l">{t.label}</span>
                    <span className="d">{t.desc}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {type === 'workflow' && !isEdit && (
            <div className="sp-field">
              <span className="sp-eyebrow">Runs under</span>
              {hubs.length ? (
                <div className="sp-chips">
                  {hubs.map((h) => (
                    <button key={h.id} type="button" className={`sp-chip mono${hub === h.id ? ' on' : ''}`} onClick={() => setHub(h.id)}>{h.name}</button>
                  ))}
                </div>
              ) : <span className="sp-slug">No hubs yet. Make a hub first, then add workflows to it.</span>}
            </div>
          )}
          {type !== 'workflow' && (
            <div className="sp-field">
              <span className="sp-eyebrow">Area</span>
              <div className="sp-chips">
                {areas.map((a) => (
                  <button key={a.key} type="button" className={`sp-chip${area === a.key ? ' on' : ''}`} onClick={() => setArea(a.key)}>{a.name}</button>
                ))}
                {newArea === null ? (
                  <button type="button" className="sp-chip dashed" onClick={() => setNewArea('')}>+ New area</button>
                ) : (
                  // Its own Enter: the modal's Enter would submit the project.
                  <input className="sp-chip-input" autoFocus value={newArea} placeholder="Area name — Enter"
                    onChange={(e) => setNewArea(e.target.value)}
                    onBlur={() => { if (!newArea.trim()) setNewArea(null); }}
                    onKeyDown={async (e) => {
                      e.stopPropagation();
                      if (e.key === 'Escape') { e.preventDefault(); setNewArea(null); }
                      if (e.key === 'Enter' && newArea.trim()) {
                        const k = await onNewArea(newArea.trim());
                        if (k) { setArea(k); setNewArea(null); }
                      }
                    }} />
                )}
              </div>
            </div>
          )}
          <div className="sp-field">
            <span className="sp-eyebrow">Status</span>
            <div className="sp-chips">
              {STATUSES.map((s) => (
                <button key={s.key} type="button" className={`sp-chip st-${s.key}${status === s.key ? ' on' : ''}`} onClick={() => setStatus(s.key)}>{s.label}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="sp-modal-f">
          <span className="hint">esc to cancel · ⌘↵ to save</span>
          <div className="btns">
            <button type="button" className="sp-btn" onClick={onClose}>Cancel</button>
            <button type="button" className="sp-btn primary" disabled={!ready} onClick={submit}>
              {isEdit ? 'Save changes' : `Create ${noun}`}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
