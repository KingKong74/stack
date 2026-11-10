// ARTIFACTS: a plain list of what THIS project keeps beside its work (docs,
// plans, designs, links, files), and the one picked, read or edited. Wired to
// routes/artifacts.js, which scopes every read and write to the project in the
// URL, so nothing from another project can show here. Kept deliberately
// basic (owner's call, 2026-11-08): no type tabs, grouping, tags, item links
// or keyboard shortcuts. Rows still carry `tags` and `links`; this screen
// just doesn't draw or write them.
//
// THREE RULES WORTH THE INK:
//
//  1. THE BYTES ARE FETCHED APART. The list never carries a file; an image is
//     fetched (getArtifactFileUrl) only while it is on screen.
//  2. TYPING SAVES ITSELF, DEBOUNCED, AND THE SCREEN NEVER RE-READS UNDER YOU.
//     A PATCH answer is not merged back, or a slow reply would roll back the
//     letters typed since. Pending saves flush when the tab closes.
//  3. DELETE IS REAL, so a row with anything in it asks first.
//
// Every body reads through components/Markdown.tsx (plan-mode plans are
// Claude's markdown, and a hand-written doc reads fine through it too).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Artifact as Art } from '../types';
import { ConfirmModal } from '../components/ConfirmModal';
import { Markdown } from '../components/Markdown';
import {
  getArtifacts, createArtifact, patchArtifact, deleteArtifact, uploadArtifactFile,
  getArtifactFileUrl, downloadArtifactFile, ARTIFACT_FILE_CAP, setStarred,
} from '../store';
import { StarButton, StarMark } from '../components/Star';

type Fields = Partial<Pick<Art, 'title' | 'body' | 'url'>>;

const LABEL: Record<string, string> = { doc: 'Doc', plan: 'Plan', design: 'Design', link: 'Link', file: 'File' };
const labelOf = (a: Art) => LABEL[a.type] || 'Doc';
const PREVIEWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const atOf = (a: Art) => Date.parse(a.updatedAt) || 0;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const untitled = (a: Art) => `Untitled ${labelOf(a).toLowerCase()}`;
const isBlank = (a: Art) => !a.title.trim() && !a.body.trim() && !a.url.trim() && !a.file;
const fmtSize = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);
const ago = (ms: number) => {
  const d = Date.now() - ms;
  if (d < 60e3) return 'just now';
  if (d < 3_600_000) return `${Math.round(d / 60e3)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
};
/** A plan opens on its own `# Title`, which the page already draws. */
const dropTitle = (a: Art) => {
  const m = a.body.match(/^\s*#\s+(.*)\n?/);
  return m && m[1].replace(/[#*`]/g, '').trim() === a.title.trim() ? a.body.slice(m[0].length) : a.body;
};

/** An image, fetched as a blob: URL for as long as it is on screen. */
function ArtImage({ slug, a }: { slug: string; a: Art }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const ver = `${a.id}:${a.file?.name}:${a.file?.size}`;
  useEffect(() => {
    let live = true;
    let url: string | null = null;
    setSrc(null); setFailed(false);
    getArtifactFileUrl(slug, a.id)
      .then((u) => { if (live) { url = u; setSrc(u); } else URL.revokeObjectURL(u); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [slug, ver]); // eslint-disable-line react-hooks/exhaustive-deps
  if (src) return <img src={src} alt={a.title || 'Image'} />;
  return <span className="ar-wellempty">{failed ? 'The image could not be loaded.' : 'Loading…'}</span>;
}

/** `highlightId` is `doc-<id>` from a Starred link: open that one. `onStarred`
 *  lets the screen re-read its Starred count after a star changes. */
export function Artifacts({ slug, highlightId, onStarred }: { slug: string; highlightId?: string | null; onStarred?: () => void }) {
  const [arts, setArts] = useState<Art[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(0);
  const [sel, setSel] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState<Art | null>(null);
  const artsRef = useRef<Art[]>([]);
  artsRef.current = arts ?? [];

  useEffect(() => {
    let live = true;
    setArts(null); setSel(null); setEditing(false);
    getArtifacts(slug)
      .then((xs) => {
        if (!live) return;
        setArts(xs);
        const want = Number(String(highlightId || '').replace(/^doc-/, ''));
        if (String(highlightId || '').startsWith('doc-') && xs.some((x) => x.id === want)) setSel(want);
      })
      .catch((e) => { if (live) { setArts([]); setErr(errText(e)); } });
    return () => { live = false; };
  }, [slug]);

  // Saves, debounced per artifact and merged, so a word typed is one PATCH.
  const pending = useRef(new Map<number, { patch: Fields; t: number }>());
  const flush = useCallback((id: number) => {
    const p = pending.current.get(id);
    if (!p) return;
    window.clearTimeout(p.t);
    pending.current.delete(id);
    patchArtifact(slug, id, p.patch).catch((e) => setErr(`Not saved: ${errText(e)}`));
  }, [slug]);
  useEffect(() => () => { [...pending.current.keys()].forEach(flush); }, [flush]);
  const upd = (id: number, patch: Fields) => {
    setArts((xs) => (xs ?? []).map((x) => (x.id === id ? { ...x, ...patch, updatedAt: new Date().toISOString() } : x)));
    const prev = pending.current.get(id);
    if (prev) window.clearTimeout(prev.t);
    pending.current.set(id, { patch: { ...prev?.patch, ...patch }, t: window.setTimeout(() => flush(id), 600) });
  };
  // The owner's star (routes/starred.js): its own write, so "edited" stays put.
  const star = (a: Art) => void work(async () => {
    const r = await setStarred(slug, 'docs', a.id, !a.starredAt);
    setArts((xs) => (xs ?? []).map((x) => (x.id === a.id ? { ...x, starredAt: r.starredAt } : x)));
    onStarred?.();
  });
  const work = async (fn: () => Promise<void>) => {
    setBusy((n) => n + 1);
    try { await fn(); } catch (e) { setErr(errText(e)); } finally { setBusy((n) => n - 1); }
  };

  const addDoc = () => void work(async () => {
    const a = await createArtifact(slug, { type: 'doc' });
    setArts((xs) => [a, ...(xs ?? [])]);
    setSel(a.id); setEditing(true);
  });
  // One at a time: a create then an upload, and a failed upload takes its
  // empty row back out rather than leaving "Untitled file".
  const addFiles = (files: FileList | null) => {
    const list = [...(files || [])];
    if (!list.length) return;
    void work(async () => {
      for (const f of list) {
        if (f.size > ARTIFACT_FILE_CAP) { setErr(`${f.name} is over the ${ARTIFACT_FILE_CAP / 1048576} MB cap.`); continue; }
        const img = PREVIEWABLE.has(f.type);
        const a = await createArtifact(slug, { type: img ? 'design' : 'file', title: img ? f.name.replace(/\.[^.]+$/, '') : f.name });
        try {
          const up = await uploadArtifactFile(slug, a.id, f);
          setArts((xs) => [up, ...(xs ?? [])]);
          setSel(up.id); setEditing(false);
        } catch (e) { await deleteArtifact(slug, a.id).catch(() => {}); throw e; }
      }
    });
  };
  const remove = (a: Art) => {
    setConfirming(null);
    const t = pending.current.get(a.id);
    if (t) { window.clearTimeout(t.t); pending.current.delete(a.id); }
    void work(async () => {
      await deleteArtifact(slug, a.id);
      setArts((xs) => (xs ?? []).filter((x) => x.id !== a.id));
      setSel(null); setEditing(false);
    });
  };

  const list = [...(arts ?? [])].sort((a, b) => atOf(b) - atOf(a));
  const cur = list.find((a) => a.id === sel) ?? list[0] ?? null;

  return (
    <div className="ar">
      <section className="ar-list">
        <div className="ar-listhead">
          <div className="ar-titlerow">
            <div className="ar-title">
              <h1>Artifacts</h1>
              <span>{arts ? `${list.length} in this project` : 'Loading…'}{busy ? ' · saving…' : ''}</span>
            </div>
            <label className="ar-edit" style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
              Upload
              <input type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
            </label>
            <button className="ar-new" onClick={addDoc}><span className="plus">+</span>New doc</button>
          </div>
          {err && (
            <div className="ar-err" role="alert">
              <span>{err}</span>
              <button aria-label="Dismiss" onClick={() => setErr('')}>✕</button>
            </div>
          )}
        </div>
        <div className="ar-rows" style={{ paddingTop: 'var(--space-3)' }}>
          {list.map((a) => (
            <button key={a.id} className={`ar-row${a.id === cur?.id ? ' on' : ''}`} data-hl={`doc-${a.id}`}
              onClick={() => { setSel(a.id); setEditing(false); }}>
              <span className="ar-badge">{labelOf(a).slice(0, 3).toUpperCase()}</span>
              <span className="main"><span className="t">{a.title || untitled(a)}</span></span>
              <span className="meta">{a.starredAt && <StarMark size={11} />}<span>{ago(atOf(a))}</span></span>
            </button>
          ))}
          {arts && list.length === 0 && (
            <div className="ar-empty">
              <span className="l">No artifacts in this project yet</span>
              <span>Use New doc or Upload.</span>
            </div>
          )}
        </div>
      </section>

      <section className="ar-view">
        {cur ? (<>
          <div className="ar-viewbar">
            <span className="when">{labelOf(cur)} · edited {ago(atOf(cur))}</span>
            <span className="rc-grow" />
            <StarButton on={!!cur.starredAt} onToggle={() => star(cur)} what="this doc" />
            <button className="ar-discard" onClick={() => (isBlank(cur) ? remove(cur) : setConfirming(cur))}>Delete</button>
            <button className={`ar-edit${editing ? ' on' : ''}`} onClick={() => setEditing(!editing)}>
              {editing ? 'Done' : 'Edit'}
            </button>
          </div>
          <div className="ar-scroll">
            <article className="ar-doc">
              {editing ? (
                <div className="ar-edithead">
                  <textarea className="ar-titlein" rows={1} value={cur.title} autoFocus
                    placeholder={untitled(cur)} aria-label="Title"
                    onChange={(e) => upd(cur.id, { title: e.target.value })} />
                </div>
              ) : (
                <div className="ar-readhead">
                  <h2 className={cur.title ? '' : 'untitled'}>{cur.title || untitled(cur)}</h2>
                </div>
              )}

              {cur.file?.image && (
                <div className="ar-well"><ArtImage slug={slug} a={cur} /></div>
              )}
              {cur.file && !cur.file.image && (
                <div className="ar-card">
                  <div className="main">
                    <span className="fname">{cur.file.name}</span>
                    <span className="path">{fmtSize(cur.file.size)}</span>
                  </div>
                  <button className="ar-open" onClick={() => { const f = cur.file!; void work(() => downloadArtifactFile(slug, cur.id, f.name)); }}>
                    Download ↓
                  </button>
                </div>
              )}
              {cur.type === 'link' && (
                editing ? (
                  <input className="ar-urlin" value={cur.url} placeholder="https://" aria-label="URL"
                    onChange={(e) => upd(cur.id, { url: e.target.value })} />
                ) : /^https?:\/\//.test(cur.url) ? (
                  <a className="ar-open" href={cur.url} target="_blank" rel="noopener noreferrer">{cur.url} ↗</a>
                ) : null
              )}

              {editing ? (
                <div className="ar-bodyedit">
                  <textarea rows={18} value={cur.body} placeholder="Write it up… (Markdown)" aria-label="Body"
                    onChange={(e) => upd(cur.id, { body: e.target.value })} />
                </div>
              ) : cur.body.trim() ? (
                <div className="ar-md"><Markdown text={dropTitle(cur)} /></div>
              ) : (
                <div className="ar-body"><span className="none">Nothing written yet. Press Edit.</span></div>
              )}
            </article>
          </div>
        </>) : (
          <div className="ar-pick">{arts ? 'Nothing here yet.' : 'Loading…'}</div>
        )}
      </section>

      {confirming && (
        <ConfirmModal title={`Delete ${confirming.title || untitled(confirming)}?`} danger confirmLabel="Delete"
          body={confirming.file ? 'It is deleted with its file, and there is no undo.' : 'It is deleted, and there is no undo.'}
          onConfirm={() => remove(confirming)} onCancel={() => setConfirming(null)} />
      )}
    </div>
  );
}
