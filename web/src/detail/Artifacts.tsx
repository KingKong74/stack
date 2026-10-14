// ARTIFACTS: what a project keeps beside its work — docs, plans, designs,
// links and files. Imported from the Claude Design project's "Roadmap Canvas"
// (its `artifacts` view, 2026-10-12) and wired to routes/artifacts.js; the
// screen keeps the design's layout, keys and copy.
//
// FOUR DECISIONS WORTH THE INK:
//
//  1. ITS OWN TABLE, NEVER THE PAYLOAD. An image or a file in a roadmap row
//     would ride the project payload the SessionStart hook reads on every
//     session, so artifacts are fetched here, on their own, and the bytes are
//     fetched apart again (getArtifactFileUrl), only for the one on screen.
//  2. AREAS ARE THE PROJECT'S AREAS (getBoardShape), and an artifact's tags are
//     area NAMES, free strings like roadmap_items.area. A tag whose area was
//     deleted still shows, with no colour, rather than vanishing.
//  3. "FROM THE ROADMAP" LINKS ARE THIS PROJECT'S ROWS. The picker offers the
//     Roadmap's kept ideas (homeOf 'roadmap'); a linked idea promoted since
//     stays linked and reads "promoted · on the board", as on the canvas.
//  4. TYPING SAVES ITSELF, DEBOUNCED; THE SCREEN NEVER RE-READS UNDER YOU. A
//     PATCH answer is not merged back into the row being typed in, or a slow
//     reply would roll back the letters typed since. Pending saves flush when
//     the tab closes. Discard is a real delete, so a row with anything in it
//     asks first.
//
// APPROVED PLAN-MODE PLANS LAND HERE AS DOCS (hook/stack-plan.mjs → POST
// /plans; `origin.kind` 'plan-mode'). They are Claude's markdown, so they read
// through components/Markdown.tsx rather than the design's line parser, which
// would draw fences and tables as loose text; editing one is the same textarea.

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { Artifact as Art, ArtifactType as ArtType, RoadmapItem } from '../types';
import { homeOf, isBoardWork } from '../lib/plan';
import { ConfirmModal } from '../components/ConfirmModal';
import { Markdown } from '../components/Markdown';
import {
  getArtifacts, createArtifact, patchArtifact, deleteArtifact, uploadArtifactFile,
  getArtifactFileUrl, downloadArtifactFile, getBoardShape, ARTIFACT_FILE_CAP,
} from '../store';

const H = 3_600_000;

type Group = 'recent' | 'area' | 'idea';
type Fields = Partial<Pick<Art, 'type' | 'title' | 'body' | 'url' | 'tags' | 'links'>>;
type AreaTag = { key: string; label: string; color: string };

type Stage = 'raw' | 'exploring' | 'shaped' | 'promoted';
const STAGE_TINT: Record<Stage, { bg: string; fg: string }> = {
  raw: { bg: 'var(--surface-card)', fg: 'var(--text-tertiary)' },
  exploring: { bg: 'var(--status-info-bg)', fg: 'var(--status-info-fg)' },
  shaped: { bg: 'var(--status-success-bg)', fg: 'var(--status-success-fg)' },
  promoted: { bg: 'var(--surface-raised)', fg: 'var(--text-tertiary)' },
};
const stageOf = (it: RoadmapItem): Stage => (isBoardWork(it) ? 'promoted' : it.canvas?.stage ?? 'raw');

const TYPES: { key: ArtType; label: string; plural: string; hint: string; ph: string; badge: string; fg: string }[] = [
  { key: 'doc', label: 'Doc', plural: 'Docs', hint: 'Write-up, spec or research', ph: 'Write it up…', badge: 'DOC', fg: 'var(--blue-300)' },
  { key: 'plan', label: 'Plan', plural: 'Plans', hint: 'Steps from idea to shipped', ph: 'Goal, steps, risks…', badge: 'PLN', fg: 'var(--lime-500)' },
  { key: 'design', label: 'Design', plural: 'Designs', hint: 'Mockup, sketch or screenshot', ph: 'What to look at, what is still open…', badge: 'DSN', fg: 'var(--amber-500)' },
  { key: 'link', label: 'Link', plural: 'Links', hint: 'A PR, a thread, a Figma file', ph: 'Why this is worth keeping…', badge: 'URL', fg: 'var(--blue-400)' },
  { key: 'file', label: 'File', plural: 'Files', hint: '', ph: 'What this file is for…', badge: 'FIL', fg: 'var(--grey-300)' },
];
const typeOf = (k: ArtType) => TYPES.find((t) => t.key === k) || TYPES[0];
// The raster types the server serves inline; anything else is a file.
const PREVIEWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const atOf = (a: Art) => Date.parse(a.updatedAt) || 0;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// A short line on its own is a heading; `- ` a bullet; `- [ ]` a step.
type Block = { k: 'h' | 'p' | 'li' | 'check'; text: string; done?: boolean; line?: number };
function parseBody(body: string): Block[] {
  const L = (body || '').split('\n');
  const out: Block[] = [];
  L.forEach((ln, i) => {
    const t = ln.trim();
    if (!t) return;
    const m = t.match(/^- \[( |x)\] ?(.*)$/i);
    const hd = t.match(/^#{1,6}\s+(.*)$/);
    if (hd) out.push({ k: 'h', text: hd[1] });
    else if (m) out.push({ k: 'check', text: m[2], done: m[1].toLowerCase() === 'x', line: i });
    else if (t.startsWith('- ')) out.push({ k: 'li', text: t.slice(2) });
    else if ((i === 0 || !L[i - 1].trim()) && L[i + 1] && L[i + 1].trim() && t.length < 40 && !/[.?!:,]$/.test(t)) out.push({ k: 'h', text: t });
    else out.push({ k: 'p', text: t });
  });
  return out;
}

const ageMs = (ms: number) => {
  const d = Date.now() - ms;
  if (d < 60e3) return 'just now';
  if (d < H) return `${Math.round(d / 60e3)}m ago`;
  if (d < 24 * H) return `${Math.round(d / H)}h ago`;
  return `${Math.round(d / (24 * H))}d ago`;
};
const hostOf = (u: string): [string, string] => {
  try { const x = new URL(u); return [x.hostname.replace(/^www\./, ''), x.pathname.replace(/\/$/, '')]; }
  catch { return [u || 'No URL yet', '']; }
};
const fmtSize = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);
const extOf = (a: Art) => (((a.file?.name || a.title).match(/\.([^.]+)$/) || [])[1] || 'file').toUpperCase();
const untitled = (a: Art) => `Untitled ${typeOf(a.type).label.toLowerCase()}`;
const excerpt = (a: Art) => {
  if (a.type === 'link') return hostOf(a.url)[0];
  if (a.type === 'file') return extOf(a) + (a.file ? ` · ${fmtSize(a.file.size)}` : '');
  const b = parseBody(a.body).find((x) => x.k !== 'h');
  return b ? b.text : a.type === 'design' ? (a.file ? 'Mockup attached' : 'No mockup yet') : 'Nothing written yet';
};
/** "plan mode on main @ 1a2b3c4", for a plan the hook filed; '' otherwise. */
const fromPlan = (a: Art) => {
  const o = a.origin;
  if (o?.kind !== 'plan-mode') return '';
  return ['plan mode', o.branch && `on ${o.branch}`, o.commit && `@ ${o.commit.slice(0, 7)}`].filter(Boolean).join(' ');
};
/** A plan opens on its own `# Title`, which the page already draws. */
const dropTitle = (a: Art) => {
  const m = a.body.match(/^\s*#\s+(.*)\n?/);
  return m && m[1].replace(/[#*`]/g, '').trim() === a.title.trim() ? a.body.slice(m[0].length) : a.body;
};
const isBlank = (a: Art) => !a.title.trim() && !a.body.trim() && !a.url.trim() && !a.file && !a.links.length;

/** The mockup, fetched as a blob: URL for as long as it is on screen. */
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
  if (src) return <img src={src} alt={a.title || 'Mockup'} />;
  return <span className="ar-wellempty">{failed ? 'The mockup could not be loaded.' : 'Loading the mockup…'}</span>;
}

export function Artifacts({ slug, items }: {
  slug: string;
  /** The project payload's roadmap, flattened: what "From the roadmap" links to. */
  items: RoadmapItem[];
}) {
  const [arts, setArts] = useState<Art[] | null>(null);
  const [areas, setAreas] = useState<AreaTag[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(0);
  const [confirming, setConfirming] = useState<Art | null>(null);
  const [type, setType] = useState<ArtType | 'all'>('all');
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<Group>('recent');
  const [sel, setSel] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const focusTitle = useRef(false);
  const artsRef = useRef<Art[]>([]);
  artsRef.current = arts ?? [];

  useEffect(() => {
    let live = true;
    setArts(null);
    getArtifacts(slug).then((xs) => { if (live) setArts(xs); }).catch((e) => { if (live) { setArts([]); setErr(errText(e)); } });
    getBoardShape(slug)
      .then((sh) => { if (live) setAreas(sh.areas.map((x) => ({ key: x.name, label: x.name, color: x.dot || 'var(--text-tertiary)' }))); })
      .catch(() => { /* no areas offered; tags still show */ });
    return () => { live = false; };
  }, [slug]);

  const areaOf = (k: string): AreaTag => areas.find((x) => x.key === k) ?? { key: k, label: k, color: 'var(--border-strong)' };
  const byId = useMemo(() => new Map(items.map((it) => [it.id, it])), [items]);
  const ideaOf = (id: number) => byId.get(id);
  const ideas = useMemo(() => items.filter((it) => homeOf(it) === 'roadmap'), [items]);

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
  const upd = (id: number, fn: (a: Art) => Fields) => {
    const a = artsRef.current.find((x) => x.id === id);
    if (!a) return;
    const patch = fn(a);
    setArts((xs) => (xs ?? []).map((x) => (x.id === id ? { ...x, ...patch, updatedAt: new Date().toISOString() } : x)));
    const prev = pending.current.get(id);
    if (prev) window.clearTimeout(prev.t);
    const typed = 'title' in patch || 'body' in patch || 'url' in patch;
    pending.current.set(id, { patch: { ...prev?.patch, ...patch }, t: window.setTimeout(() => flush(id), typed ? 600 : 0) });
  };
  const put = (a: Art) => setArts((xs) => [a, ...(xs ?? []).filter((x) => x.id !== a.id)]);
  // An upload's answer carries the new `file`, and only that is taken from it.
  const withFile = (a: Art) => setArts((xs) => (xs ?? []).map((x) => (x.id === a.id ? { ...x, file: a.file, updatedAt: a.updatedAt } : x)));
  const work = async (fn: () => Promise<void>) => {
    setBusy((n) => n + 1);
    try { await fn(); } catch (e) { setErr(errText(e)); } finally { setBusy((n) => n - 1); }
  };

  const add = (t: ArtType) => {
    setMenu(false); setLinkOpen(false); setType('all'); setQuery('');
    void work(async () => {
      const a = await createArtifact(slug, { type: t });
      put(a);
      focusTitle.current = true;
      setSel(a.id); setEditing(true);
    });
  };
  // One at a time, in order: each is a create then an upload, and a failed
  // upload takes its empty row back out rather than leaving "Untitled file".
  const addFiles = (files: FileList | null) => {
    const list = [...(files || [])];
    if (!list.length) return;
    void work(async () => {
      for (const f of list) {
        if (f.size > ARTIFACT_FILE_CAP) { setErr(`${f.name} is over the ${ARTIFACT_FILE_CAP / 1048576} MB cap.`); continue; }
        const img = PREVIEWABLE.has(f.type);
        const a = await createArtifact(slug, { type: img ? 'design' : 'file', title: img ? f.name.replace(/\.[^.]+$/, '') : f.name });
        try { put(await uploadArtifactFile(slug, a.id, f)); }
        catch (e) { await deleteArtifact(slug, a.id).catch(() => {}); throw e; }
      }
    });
  };
  const setImg = (files: FileList | null, id: number) => {
    const f = [...(files || [])].find((x) => x.type.startsWith('image/'));
    if (!f) return;
    if (!PREVIEWABLE.has(f.type)) { setErr('A mockup previews as PNG, JPEG, GIF or WebP. Upload anything else as a file.'); return; }
    void work(async () => { withFile(await uploadArtifactFile(slug, id, f)); });
  };
  const discard = (a: Art) => {
    setConfirming(null);
    const t = pending.current.get(a.id);
    if (t) { window.clearTimeout(t.t); pending.current.delete(a.id); }
    void work(async () => {
      await deleteArtifact(slug, a.id);
      setArts((xs) => (xs ?? []).filter((x) => x.id !== a.id));
      setSel(null); setEditing(false);
    });
  };

  const q = query.trim().toLowerCase();
  const pre = (arts ?? []).filter((a) => !q || `${a.title} ${a.body} ${a.url}`.toLowerCase().includes(q));
  const shown = pre.filter((a) => type === 'all' || a.type === type).sort((a, b) => atOf(b) - atOf(a));
  const selId = shown.some((a) => a.id === sel) ? sel : shown[0]?.id ?? null;
  const cur = selId != null ? (arts ?? []).find((a) => a.id === selId) ?? null : null;

  const groups = useMemo(() => {
    const keyOf = (a: Art): [number, string] => {
      if (group === 'area') {
        if (!a.tags[0]) return [1e9, 'No area'];
        const i = areas.findIndex((x) => x.key === a.tags[0]);
        return [i < 0 ? 1e6 + a.tags[0].charCodeAt(0) : i, a.tags[0]];
      }
      if (group === 'idea') {
        const n = a.links.map(ideaOf).find(Boolean);
        return n ? [n.id, `#${n.id}  ${n.title}`] : [1e9, 'Not linked to an idea'];
      }
      const d = Date.now() - atOf(a);
      return d < 24 * H ? [0, 'Today'] : d < 7 * 24 * H ? [1, 'This week'] : [2, 'Earlier'];
    };
    const m = new Map<number, { k: number; label: string; rows: Art[] }>();
    shown.forEach((a) => {
      const [k, label] = keyOf(a);
      if (!m.has(k)) m.set(k, { k, label, rows: [] });
      m.get(k)!.rows.push(a);
    });
    return [...m.values()].sort((x, y) => (group === 'idea' ? Number(x.k === 1e9) - Number(y.k === 1e9) : x.k - y.k));
  }, [shown, group, areas, byId]); // eslint-disable-line react-hooks/exhaustive-deps
  const order = groups.flatMap((g) => g.rows.map((a) => a.id));

  // The design's keys: ↑↓ (or j/k) move, e edits, / searches, Esc backs out.
  // Never while typing, so a title with a "j" in it stays a title.
  const keys = useRef({ order, selId, editing });
  keys.current = { order, selId, editing };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable) {
        if (e.key === 'Escape') el?.blur();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const { order: o, selId: cur, editing: ed } = keys.current;
      if (e.key === 'Escape') { if (ed) setEditing(false); else { setMenu(false); setLinkOpen(false); } return; }
      const i = cur == null ? -1 : o.indexOf(cur);
      const go = (id: number | undefined) => { if (id != null) { setSel(id); setEditing(false); setLinkOpen(false); } };
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); go(o[Math.min(o.length - 1, i + 1)]); }
      if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); go(o[Math.max(0, i - 1)]); }
      if (e.key === 'e' && cur != null) { e.preventDefault(); focusTitle.current = !ed; setEditing(!ed); }
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  // The title grows with its text, and takes the focus when an edit opens.
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
    if (focusTitle.current) { focusTitle.current = false; el.focus(); }
  });

  const onDragOver = (e: DragEvent) => { e.preventDefault(); if (!dropping) setDropping(true); };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDropping(false); addFiles(e.dataTransfer.files); };

  const all = arts ?? [];
  const linkedCount = all.filter((a) => a.links.length).length;
  const blocks = cur ? parseBody(cur.body) : [];

  return (
    <div className="ar" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <section className="ar-list">
        <div className="ar-listhead">
          <div className="ar-titlerow">
            <div className="ar-title">
              <h1>Artifacts</h1>
              <span>{arts ? `${all.length} kept · ${linkedCount} linked to ideas` : 'Loading…'}{busy ? ' · saving…' : ''}</span>
            </div>
            <div className="ar-newwrap">
              <button className="ar-new" onClick={() => setMenu((m) => !m)} aria-expanded={menu}>
                <span className="plus">+</span>New
              </button>
              {menu && (
                <div className="ar-menu">
                  {TYPES.filter((t) => t.key !== 'file').map((t) => (
                    <button key={t.key} className="ar-menuopt" onClick={() => add(t.key)}>
                      <span className="ar-badge" style={{ color: t.fg }}>{t.badge}</span>
                      <span className="tx"><span className="l">{t.label}</span><span className="h">{t.hint}</span></span>
                    </button>
                  ))}
                  <span className="ar-menusep" />
                  <label className="ar-menuopt">
                    <span className="ar-badge up">↑</span>
                    <span className="tx"><span className="l">Upload files</span><span className="h">Images become designs</span></span>
                    <input type="file" multiple hidden
                      onChange={(e) => { addFiles(e.target.files); e.target.value = ''; setMenu(false); }} />
                  </label>
                </div>
              )}
            </div>
          </div>
          {err && (
            <div className="ar-err" role="alert">
              <span>{err}</span>
              <button aria-label="Dismiss" onClick={() => setErr('')}>✕</button>
            </div>
          )}
          <div className="ar-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
            </svg>
            <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Search titles and contents" aria-label="Search artifacts" />
            <kbd>/</kbd>
          </div>
          <div className="ar-types" role="tablist">
            {[{ key: 'all' as const, plural: 'All' }, ...TYPES].map((t) => (
              <button key={t.key} role="tab" aria-selected={type === t.key}
                className={`ar-type${type === t.key ? ' on' : ''}`} onClick={() => setType(t.key)}>
                {t.plural}<span className="n">{t.key === 'all' ? pre.length : pre.filter((a) => a.type === t.key).length}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="ar-groupby">
          <span className="lbl">Group by</span>
          {([['recent', 'Recent'], ['area', 'Area'], ['idea', 'Idea']] as [Group, string][]).map(([k, label]) => (
            <button key={k} className={`ar-gb${group === k ? ' on' : ''}`} onClick={() => setGroup(k)}>{label}</button>
          ))}
        </div>
        <div className="ar-rows">
          {groups.map((g) => (
            <div key={g.k}>
              <div className="ar-grouphead"><span className="l">{g.label}</span><span className="n">{g.rows.length}</span></div>
              {g.rows.map((a) => {
                const t = typeOf(a.type);
                return (
                  <button key={a.id} className={`ar-row${a.id === selId ? ' on' : ''}`}
                    onClick={() => { setSel(a.id); setEditing(false); setLinkOpen(false); setMenu(false); }}>
                    <span className="ar-badge" style={{ color: t.fg }}>{t.badge}</span>
                    <span className="main">
                      <span className="t">{a.title || untitled(a)}</span>
                      <span className="s">{excerpt(a)}</span>
                    </span>
                    <span className="meta">
                      <span>{ageMs(atOf(a))}</span>
                      <span>{a.links.slice(0, 2).map((i) => `#${i}`).join(' ')}{a.links.length > 2 ? ` +${a.links.length - 2}` : ''}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
          {shown.length === 0 && (
            <div className="ar-empty">
              <span className="l">{!arts ? 'Loading…' : all.length ? 'Nothing matches' : 'No artifacts yet'}</span>
              <span>Drop files here, or use New.</span>
            </div>
          )}
        </div>
        <div className="ar-foot">
          <span>Drop files anywhere to add them</span>
          <span className="k">↑↓ move · e edit</span>
        </div>
      </section>

      <section className="ar-view">
        {cur ? (() => {
          const t = typeOf(cur.type);
          const [host, path] = hostOf(cur.url);
          const tags = cur.tags.map(areaOf);
          return (<>
            <div className="ar-viewbar">
              <span className="ar-badge" style={{ color: t.fg }}>{t.badge}</span>
              <span className="when">
                {t.label}{fromPlan(cur) ? ` · ${fromPlan(cur)}` : ''} · edited {ageMs(atOf(cur))}
              </span>
              <span className="rc-grow" />
              <button className="ar-discard" onClick={() => (isBlank(cur) ? discard(cur) : setConfirming(cur))}>
                Discard
              </button>
              <button className={`ar-edit${editing ? ' on' : ''}`}
                onClick={() => { focusTitle.current = !editing; setEditing(!editing); setSel(cur.id); }}>
                {editing ? 'Done' : 'Edit'}
              </button>
            </div>
            <div className="ar-scroll">
              <article className="ar-doc">
                {editing ? (
                  <div className="ar-edithead">
                    <textarea ref={titleRef} className="ar-titlein" rows={1} value={cur.title}
                      placeholder={untitled(cur)} aria-label="Title"
                      onChange={(e) => { const v = e.target.value; upd(cur.id, () => ({ title: v })); }} />
                    <div className="ar-tagbtns">
                      {[...areas, ...cur.tags.filter((k) => !areas.some((x) => x.key === k)).map(areaOf)].map((a) => {
                        const on = cur.tags.includes(a.key);
                        return (
                          <button key={a.key} className={`ar-tagbtn${on ? ' on' : ''}`} aria-pressed={on}
                            onClick={() => upd(cur.id, (x) => ({ tags: on ? x.tags.filter((k) => k !== a.key) : [...x.tags, a.key] }))}>
                            <span className="dot" style={{ background: a.color }} />{a.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="ar-readhead">
                    <h2 className={cur.title ? '' : 'untitled'}>{cur.title || untitled(cur)}</h2>
                    <div className="ar-tags">
                      {tags.map((x) => <span key={x.key}><span className="dot" style={{ background: x.color }} />{x.label}</span>)}
                      {!tags.length && <span className="none">No area</span>}
                    </div>
                  </div>
                )}

                {cur.type === 'design' && (
                  <label className="ar-well" onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setDropping(false); setImg(e.dataTransfer.files, cur.id); }}>
                    {cur.file?.image
                      ? <ArtImage slug={slug} a={cur} />
                      : cur.file
                      ? <span className="ar-wellempty">{cur.file.name} can't be previewed. Drop a PNG, JPEG, GIF or WebP to replace it.</span>
                      : <span className="ar-wellempty"><span className="plus">+</span>Drop a mockup, or click to pick an image</span>}
                    <input type="file" accept="image/*" hidden
                      onChange={(e) => { setImg(e.target.files, cur.id); e.target.value = ''; }} />
                  </label>
                )}
                {cur.type === 'link' && (
                  <div className="ar-linkwrap">
                    <div className="ar-card">
                      <div className="main">
                        <span className="host">{host}</span>
                        <span className="path">{path}</span>
                      </div>
                      {/* The design's own sample URL; a real one would be
                          reduced to something safe before it was ever a link. */}
                      {/^https?:\/\//.test(cur.url) && (
                        <a className="ar-open" href={cur.url} target="_blank" rel="noopener noreferrer">Open ↗</a>
                      )}
                    </div>
                    {editing && (
                      <input className="ar-urlin" value={cur.url} placeholder="https://" aria-label="URL"
                        onChange={(e) => { const v = e.target.value; upd(cur.id, () => ({ url: v })); }} />
                    )}
                  </div>
                )}
                {cur.type === 'file' && (
                  <div className="ar-card">
                    <span className="ar-fileicon">{extOf(cur)}</span>
                    <div className="main">
                      <span className="fname">{cur.file?.name || cur.title}</span>
                      <span className="path">{cur.file ? fmtSize(cur.file.size) : 'No file attached'}</span>
                    </div>
                    {cur.file && (
                      <button className="ar-open" onClick={() => { const f = cur.file!; void work(() => downloadArtifactFile(slug, cur.id, f.name)); }}>
                        Download ↓
                      </button>
                    )}
                  </div>
                )}

                {editing ? (
                  <div className="ar-bodyedit">
                    <textarea rows={18} value={cur.body} placeholder={t.ph} aria-label="Body"
                      onChange={(e) => { const v = e.target.value; upd(cur.id, () => ({ body: v })); }} />
                    <span className="hint">A short line on its own becomes a heading. Start a line with - for a bullet, - [ ] for a step.</span>
                  </div>
                ) : cur.origin.kind === 'plan-mode' ? (
                  <div className="ar-md"><Markdown text={dropTitle(cur)} /></div>
                ) : (
                  <div className="ar-body">
                    {blocks.map((b, i) => {
                      if (b.k === 'h') return <span key={i} className="h">{b.text}</span>;
                      if (b.k === 'li') return <span key={i} className="li"><span className="dash">–</span><span>{b.text}</span></span>;
                      if (b.k === 'check') {
                        return (
                          <span key={i} className={`ck${b.done ? ' done' : ''}`}>
                            <button className="box" aria-pressed={!!b.done} aria-label={b.done ? 'Mark not done' : 'Mark done'}
                              onClick={() => upd(cur.id, (x) => {
                                const L = x.body.split('\n');
                                L[b.line!] = L[b.line!].replace(/\[( |x)\]/i, b.done ? '[ ]' : '[x]');
                                return { body: L.join('\n') };
                              })}>{b.done ? '✓' : ''}</button>
                            <span className="tx">{b.text}</span>
                          </span>
                        );
                      }
                      return <span key={i} className="p">{b.text}</span>;
                    })}
                    {!cur.body.trim() && <span className="none">Nothing written yet. Press Edit, or e.</span>}
                  </div>
                )}

                <div className="ar-links">
                  <div className="ar-linkshead">
                    <span className="eyebrow">From the roadmap</span>
                    <span className="n">{cur.links.length}</span>
                    <span className="rc-grow" />
                    <button className="ar-linkbtn" onClick={() => setLinkOpen((o) => !o)} aria-expanded={linkOpen}>+ Link an idea</button>
                  </div>
                  <div className="ar-linkgrid">
                    {cur.links.map(ideaOf).filter((n): n is RoadmapItem => !!n).map((n) => { const st = stageOf(n); return (
                      <div key={n.id} className="ar-idea" style={{ background: STAGE_TINT[st].bg }}>
                        <div className="top">
                          <span className="stage" style={{ color: STAGE_TINT[st].fg }}>{st}</span>
                          <span className="rc-grow" />
                          <button className="x" title="Unlink" aria-label={`Unlink #${n.id}`}
                            onClick={() => upd(cur.id, (x) => ({ links: x.links.filter((i) => i !== n.id) }))}>✕</button>
                        </div>
                        <span className="t">{n.title}</span>
                        <span className="ref">#{n.id}{st === 'promoted' ? '  · on the board' : ''}</span>
                      </div>
                    ); })}
                  </div>
                  {cur.links.length === 0 && <span className="ar-nolinks">Not linked to an idea yet.</span>}
                  {linkOpen && (
                    <div className="ar-linkopts">
                      {!ideas.some((n) => !cur.links.includes(n.id)) && (
                        <span className="ar-nolinks">No kept ideas left to link. Ideas live on the Roadmap.</span>
                      )}
                      {ideas.filter((n) => !cur.links.includes(n.id)).map((n) => (
                        <button key={n.id} onClick={() => { upd(cur.id, (x) => ({ links: [...x.links, n.id] })); setLinkOpen(false); }}>
                          <span className="ref">#{n.id}</span><span className="t">{n.title}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </article>
            </div>
          </>);
        })() : (
          <div className="ar-pick">Pick an artifact, or drop files here.</div>
        )}
      </section>

      {dropping && <div className="ar-drop">Drop to add. Images become designs.</div>}
      {confirming && (
        <ConfirmModal title={`Discard ${confirming.title || untitled(confirming)}?`} danger confirmLabel="Discard"
          body={confirming.file ? 'It is deleted with its file, and there is no undo.' : 'It is deleted, and there is no undo.'}
          onConfirm={() => discard(confirming)} onCancel={() => setConfirming(null)} />
      )}
    </div>
  );
}
