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
//  4. THE FILE EXCHANGE (2026-11-13; server/src/routes/files.js). The list
//     is three sections: For sessions (shared IN, mirrored by the host daemon
//     into ~/.stack/files/<slug>/inbox), From sessions (handed back OUT
//     through the outbox) and Docs & files (kept here). The drop zone shares;
//     Upload keeps. Whether the host can see a share is only what the daemon
//     last said: no recent sync reads "Stack cannot see the host", never as
//     delivered. The list re-reads on the auto-refresh so a session's file
//     appears, but a row with a pending save keeps the local copy (rule 2).
//
// Every body reads through components/Markdown.tsx (plan-mode plans are
// Claude's markdown, and a hand-written doc reads fine through it too).

import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import type { Artifact as Art, FilesStatus } from '../types';
import { ConfirmModal } from '../components/ConfirmModal';
import { Markdown } from '../components/Markdown';
import {
  getArtifacts, createArtifact, patchArtifact, deleteArtifact, uploadArtifactFile,
  getArtifactFileUrl, downloadArtifactFile, ARTIFACT_FILE_CAP, setStarred, getFilesStatus,
} from '../store';
import { useAutoRefresh } from '../lib/autoRefresh';
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
type Lane = 'in' | 'out' | 'kept';
const laneOf = (a: Art): Lane => (a.exchange === 'in' ? 'in' : a.exchange === 'out' ? 'out' : 'kept');
const hostDir = (slug: string, lane: 'in' | 'out') => `~/.stack/files/${slug}/${lane === 'in' ? 'inbox' : 'outbox'}`;
const hasDragFiles = (e: ReactDragEvent) => [...e.dataTransfer.types].includes('Files');

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
  const [sync, setSync] = useState<FilesStatus | 'unknown' | null>(null);
  const [over, setOver] = useState(false);
  const [copied, setCopied] = useState('');
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

  const readSync = useCallback(() => {
    getFilesStatus().then(setSync).catch(() => setSync('unknown'));
  }, []);
  useEffect(readSync, [readSync]);
  // A session's file arriving, or a share being picked up. A row with a save
  // still pending keeps the local copy, so nothing typed is rolled back.
  useAutoRefresh(() => {
    readSync();
    getArtifacts(slug).then((xs) => setArts((cur) => {
      if (!cur) return xs;
      const mine = new Map(cur.map((x) => [x.id, x]));
      return xs.map((x) => (pending.current.has(x.id) ? mine.get(x.id) ?? x : x));
    })).catch(() => { /* the next tick tries again */ });
  });

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
  const addFiles = (files: FileList | null, exchange: '' | 'in' = '') => {
    const list = [...(files || [])];
    if (!list.length) return;
    void work(async () => {
      for (const f of list) {
        if (f.size > ARTIFACT_FILE_CAP) { setErr(`${f.name} is over the ${ARTIFACT_FILE_CAP / 1048576} MB cap.`); continue; }
        const img = PREVIEWABLE.has(f.type);
        const a = await createArtifact(slug, { type: img ? 'design' : 'file', title: img ? f.name.replace(/\.[^.]+$/, '') : f.name, exchange });
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

  const share = (a: Art, on: boolean) => void work(async () => {
    const up = await patchArtifact(slug, a.id, { exchange: on ? 'in' : '' });
    setArts((xs) => (xs ?? []).map((x) => (x.id === a.id ? up : x)));
  });
  const copyPath = (p: string) => {
    void navigator.clipboard?.writeText(p).then(() => { setCopied(p); window.setTimeout(() => setCopied(''), 1500); })
      .catch(() => setErr('The browser would not copy that. Select the path and copy it by hand.'));
  };
  const onDrop = (e: ReactDragEvent) => {
    e.preventDefault(); setOver(false);
    addFiles(e.dataTransfer.files, 'in');
  };

  const sorted = [...(arts ?? [])].sort((a, b) => atOf(b) - atOf(a));
  const lanes: Record<Lane, Art[]> = { in: [], out: [], kept: [] };
  for (const a of sorted) lanes[laneOf(a)].push(a);
  const list = [...lanes.in, ...lanes.out, ...lanes.kept];
  const cur = list.find((a) => a.id === sel) ?? list[0] ?? null;
  const live = sync !== null && sync !== 'unknown' && sync.live;

  const row = (a: Art) => (
    <button key={a.id} className={`ar-row${a.id === cur?.id ? ' on' : ''}`} data-hl={`doc-${a.id}`}
      onClick={() => { setSel(a.id); setEditing(false); }}>
      <span className="ar-badge">{labelOf(a).slice(0, 3).toUpperCase()}</span>
      <span className="main">
        <span className="t">{a.title || untitled(a)}</span>
        {a.file && laneOf(a) !== 'kept' && <span className="s">{a.hostName || a.file.name} · {fmtSize(a.file.size)}</span>}
      </span>
      <span className="meta">{a.starredAt && <StarMark size={11} />}<span>{ago(atOf(a))}</span></span>
    </button>
  );

  return (
    // A file let go anywhere else on the screen must not navigate the tab to it.
    <div className="ar" onDragOver={(e) => { if (hasDragFiles(e)) e.preventDefault(); }}
      onDrop={(e) => { if (hasDragFiles(e)) { e.preventDefault(); setOver(false); } }}>
      <section className="ar-list">
        <div className="ar-listhead">
          <div className="ar-titlerow">
            <div className="ar-title">
              <h1>Artifacts</h1>
              <span>{arts ? `${list.length} in this project` : 'Loading…'}{busy ? ' · saving…' : ''}</span>
            </div>
            <label className="ar-edit" style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
              Upload
              <input type="file" multiple hidden onChange={(e) => { addFiles(e.target.files, ''); e.target.value = ''; }} />
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
        <div className="ar-rows">
          <div className="ar-grouphead"><span className="l">For sessions</span><span className="n">{lanes.in.length}</span></div>
          <label className={`ar-dropzone${over ? ' over' : ''}`} data-hl="files"
            onDragEnter={(e) => { if (hasDragFiles(e)) { e.preventDefault(); setOver(true); } }}
            onDragOver={(e) => { if (hasDragFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
            onDrop={onDrop}>
            <span className="l">{over ? 'Drop to share' : 'Drop files for sessions'}</span>
            <span className="h">or click to choose · up to {ARTIFACT_FILE_CAP / 1048576} MB each</span>
            <input type="file" multiple hidden onChange={(e) => { addFiles(e.target.files, 'in'); e.target.value = ''; }} />
          </label>
          <div className={`ar-sync${sync !== null && !live ? ' warn' : ''}`} role="status">
            {sync === null ? 'Checking the host…'
              : live ? <>Sessions read them from <code>{hostDir(slug, 'in')}</code></>
                : <>Stack cannot see the host: the terminal daemon {sync !== 'unknown' && sync.lastSyncAt ? `last synced ${ago(Date.parse(sync.lastSyncAt))}` : 'has not synced since the server started'}. Shared files wait here until it does.</>}
          </div>
          {lanes.in.map(row)}

          <div className="ar-grouphead"><span className="l">From sessions</span><span className="n">{lanes.out.length}</span></div>
          {lanes.out.map(row)}
          {lanes.out.length === 0 && (
            <div className="ar-sync">A session hands you a file by writing it into <code>{hostDir(slug, 'out')}</code>. It shows up here to download.</div>
          )}

          <div className="ar-grouphead"><span className="l">Docs &amp; files</span><span className="n">{lanes.kept.length}</span></div>
          {lanes.kept.map(row)}
          {arts && lanes.kept.length === 0 && (
            <div className="ar-sync">Nothing kept here yet. Use New doc or Upload.</div>
          )}
        </div>
      </section>

      <section className="ar-view">
        {cur ? (<>
          <div className="ar-viewbar">
            <span className="when">
              {laneOf(cur) === 'in' ? 'Shared with sessions' : laneOf(cur) === 'out' ? 'From a session' : labelOf(cur)} · {laneOf(cur) === 'out' ? 'written' : 'edited'} {ago(atOf(cur))}
            </span>
            <span className="rc-grow" />
            {cur.file && (laneOf(cur) === 'in'
              ? <button className="ar-edit" onClick={() => share(cur, false)} title="Take it out of the sessions' inbox; it stays here">Stop sharing</button>
              : <button className="ar-edit" onClick={() => share(cur, true)} title="Copy it into this project's sessions' inbox">Share with sessions</button>)}
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
              {cur.file && (
                <div className="ar-card">
                  <div className="main">
                    <span className="fname">{cur.file.name}</span>
                    <span className="path">{fmtSize(cur.file.size)}</span>
                    {laneOf(cur) !== 'kept' && cur.hostName && (() => {
                      const p = `${hostDir(slug, laneOf(cur) as 'in' | 'out')}/${cur.hostName}`;
                      return (
                        <span className="path">
                          {laneOf(cur) === 'in' ? (live ? 'On the host at ' : 'Will land on the host at ') : 'Written by a session at '}
                          <code>{p}</code>{' '}
                          <button className="ar-copy" onClick={() => copyPath(p)}>{copied === p ? 'Copied' : 'Copy path'}</button>
                        </span>
                      );
                    })()}
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
