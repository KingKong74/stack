// ARTIFACTS IS A MOCKUP, from the Claude Design project's "Roadmap Canvas"
// (its `artifacts` view, 2026-10-12). It reads nothing and writes nothing: the
// rows are the design's own sample docs, plans, designs, links and files, and
// the ideas they link to are the design's sample notes, not this project's.
// The rail row wears the Mock chip for exactly that reason.
//
// EVERYTHING HERE IS COMPONENT STATE AND DIES WITH THE TAB. The design kept it
// in localStorage; store.ts is the only module allowed device storage, and a
// mockup that remembered edits across reloads would read as a feature that
// saved them. Wiring it means an artifact store first: an image or a file in a
// roadmap row would ride the payload the SessionStart hook reads (the same
// reason the Roadmap canvas left out the design's image well).

import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';

const H = 3_600_000;

type ArtType = 'doc' | 'plan' | 'design' | 'link' | 'file';
type Group = 'recent' | 'area' | 'idea';

interface Artifact {
  id: number;
  type: ArtType;
  title: string;
  tags: string[];
  links: number[];
  body: string;
  at: number;
  url: string;
  img: string | null;
  file: { name: string; size: number } | null;
}

// The design's sample areas and ideas, verbatim — this project's are not read.
const AREAS = [
  { key: 'board', label: 'project/board', color: 'var(--lime-600)' },
  { key: 'plans', label: 'plans', color: 'var(--red-500)' },
  { key: 'roadmap', label: 'roadmap', color: 'var(--blue-400)' },
  { key: 'foryou', label: 'for you', color: 'var(--amber-500)' },
  { key: 'quality', label: 'quality', color: 'var(--lime-700)' },
];
const areaOf = (k: string) => AREAS.find((a) => a.key === k);

type Stage = 'raw' | 'exploring' | 'shaped' | 'promoted';
const STAGE_TINT: Record<Stage, { bg: string; fg: string }> = {
  raw: { bg: 'var(--surface-card)', fg: 'var(--text-tertiary)' },
  exploring: { bg: 'var(--status-info-bg)', fg: 'var(--status-info-fg)' },
  shaped: { bg: 'var(--status-success-bg)', fg: 'var(--status-success-fg)' },
  promoted: { bg: 'var(--surface-raised)', fg: 'var(--text-tertiary)' },
};
const IDEAS: { id: number; title: string; stage: Stage; taskId?: string }[] = [
  { id: 1, title: 'Lane holder as an avatar, not a term id', stage: 'exploring' },
  { id: 2, title: 'Drag ideas between areas on the board', stage: 'raw' },
  { id: 3, title: 'Plans could auto-draft from a shaped idea', stage: 'exploring' },
  { id: 4, title: 'Flaky test heatmap?', stage: 'raw' },
  { id: 5, title: 'Quality gate summary on merge', stage: 'shaped' },
  { id: 6, title: 'For you: what changed since your last visit', stage: 'exploring' },
  { id: 7, title: 'Keyboard nav across board columns', stage: 'shaped' },
  { id: 8, title: 'Morning digest of overnight runs', stage: 'raw' },
  { id: 9, title: 'Batch keep / dismiss in Auto-ideas', stage: 'raw' },
  { id: 10, title: 'Retry a failed overnight worker from its card', stage: 'raw' },
  { id: 11, title: 'Sprint burndown on Plans', stage: 'raw' },
  { id: 14, title: 'Area colour picker', stage: 'promoted', taskId: '#523' },
  { id: 15, title: 'Run log inline on the board card', stage: 'raw' },
];
const ideaOf = (id: number) => IDEAS.find((n) => n.id === id);

const TYPES: { key: ArtType; label: string; plural: string; hint: string; ph: string; badge: string; fg: string }[] = [
  { key: 'doc', label: 'Doc', plural: 'Docs', hint: 'Write-up, spec or research', ph: 'Write it up…', badge: 'DOC', fg: 'var(--blue-300)' },
  { key: 'plan', label: 'Plan', plural: 'Plans', hint: 'Steps from idea to shipped', ph: 'Goal, steps, risks…', badge: 'PLN', fg: 'var(--lime-500)' },
  { key: 'design', label: 'Design', plural: 'Designs', hint: 'Mockup, sketch or screenshot', ph: 'What to look at, what is still open…', badge: 'DSN', fg: 'var(--amber-500)' },
  { key: 'link', label: 'Link', plural: 'Links', hint: 'A PR, a thread, a Figma file', ph: 'Why this is worth keeping…', badge: 'URL', fg: 'var(--blue-400)' },
  { key: 'file', label: 'File', plural: 'Files', hint: '', ph: 'What this file is for…', badge: 'FIL', fg: 'var(--grey-300)' },
];
const typeOf = (k: ArtType) => TYPES.find((t) => t.key === k) || TYPES[0];

function seed(): Artifact[] {
  const now = Date.now();
  const A = (id: number, type: ArtType, title: string, tags: string[], links: number[], body: string, hrs: number, x: Partial<Artifact> = {}): Artifact =>
    ({ id, type, title, tags, links, body, at: now - hrs * H, url: '', img: null, file: null, ...x });
  return [
    A(1, 'doc', 'Lane holder: names instead of term ids', ['roadmap'], [1], 'Problem\nThe lane header shows the raw term id (term:stack-term-111cee94). Nobody reads it.\n\nProposal\nShow the holder\'s avatar and short name. Full id on hover, copy on click.\n\nOpen questions\n- Do bots get an avatar?\n- What shows when the holder has left?', 3),
    A(2, 'plan', 'Quality gate summary: rollout', ['quality'], [5], 'Goal\nOne summary card per PR: what ran, what failed, who signed off.\n\nSteps\n- [x] Summary card component\n- [ ] Link from the board item\n- [ ] Backfill the last 30 days of PRs\n\nRisks\n- Sign-off data lives in two places.', 20),
    A(3, 'design', 'Board card with inline run log', ['board', 'quality'], [15, 10], 'Two states: collapsed (last line only) and expanded (last 40 lines, scrolls).', 30),
    A(4, 'link', 'Keyboard shortcut conventions', ['board'], [7], 'Reference for j/k, h/l and Enter. Check against what Plans already binds.', 50, { url: 'https://github.com/stack/stack/discussions/412' }),
    A(5, 'doc', 'Overnight runs: what people asked for', ['foryou'], [8, 9, 10], 'Collected from standups this month.\n\n- What finished while I was asleep?\n- Let me retry from the card, not the log.\n- Keep or dismiss ten ideas at once.', 72),
    A(6, 'plan', 'Q4 roadmap', ['roadmap'], [], 'Now\n- Lane holder names\n- Quality gate summary\n\nNext\n- Keyboard nav on the board\n- Morning digest\n\nLater\n- Plans auto-draft', 120),
    A(7, 'file', 'area-colours.json', ['board'], [14], 'Palette export used by routes/board.js.', 160, { file: { name: 'area-colours.json', size: 1840 } }),
  ];
}

// A short line on its own is a heading; `- ` a bullet; `- [ ]` a step.
type Block = { k: 'h' | 'p' | 'li' | 'check'; text: string; done?: boolean; line?: number };
function parseBody(body: string): Block[] {
  const L = (body || '').split('\n');
  const out: Block[] = [];
  L.forEach((ln, i) => {
    const t = ln.trim();
    if (!t) return;
    const m = t.match(/^- \[( |x)\] ?(.*)$/i);
    if (m) out.push({ k: 'check', text: m[2], done: m[1].toLowerCase() === 'x', line: i });
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
const extOf = (a: Artifact) => (((a.file?.name || a.title).match(/\.([^.]+)$/) || [])[1] || 'file').toUpperCase();
const untitled = (a: Artifact) => `Untitled ${typeOf(a.type).label.toLowerCase()}`;
const excerpt = (a: Artifact) => {
  if (a.type === 'link') return hostOf(a.url)[0];
  if (a.type === 'file') return extOf(a) + (a.file ? ` · ${fmtSize(a.file.size)}` : '');
  const b = parseBody(a.body).find((x) => x.k !== 'h');
  return b ? b.text : a.type === 'design' ? (a.img ? 'Mockup attached' : 'No mockup yet') : 'Nothing written yet';
};
const readImage = (f: File, then: (src: string) => void) => {
  const r = new FileReader();
  r.onload = () => then(String(r.result));
  r.readAsDataURL(f);
};

export function Artifacts() {
  const [arts, setArts] = useState<Artifact[]>(seed);
  const [nextId, setNextId] = useState(8);
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

  const upd = (id: number, fn: (a: Artifact) => Partial<Artifact>) =>
    setArts((xs) => xs.map((a) => (a.id === id ? { ...a, ...fn(a), at: Date.now() } : a)));
  const add = (t: ArtType, x: Partial<Artifact> = {}, focus = true) => {
    const id = nextId;
    setNextId((n) => n + 1);
    setArts((xs) => [{ id, type: t, title: '', tags: [], links: [], body: '', at: Date.now(), url: '', img: null, file: null, ...x }, ...xs]);
    focusTitle.current = focus;
    setSel(id); setEditing(focus); setMenu(false); setLinkOpen(false); setType('all'); setQuery('');
  };
  // Ids are handed out one per file up front: a FileReader answers later, and
  // two images read in one drop must not both take the same next id.
  const addFiles = (files: FileList | null) => {
    const list = [...(files || [])];
    if (!list.length) return;
    const base = nextId;
    setNextId((n) => n + list.length);
    list.forEach((f, i) => {
      const id = base + i;
      const put = (x: Partial<Artifact>) =>
        setArts((xs) => [{ id, type: 'file', title: '', tags: [], links: [], body: '', at: Date.now(), url: '', img: null, file: null, ...x }, ...xs]);
      if (f.type.startsWith('image/')) readImage(f, (src) => put({ type: 'design', title: f.name.replace(/\.[^.]+$/, ''), img: src }));
      else put({ type: 'file', title: f.name, file: { name: f.name, size: f.size } });
    });
  };
  const setImg = (files: FileList | null, id: number) => {
    const f = [...(files || [])].find((x) => x.type.startsWith('image/'));
    if (f) readImage(f, (src) => upd(id, () => ({ img: src })));
  };

  const q = query.trim().toLowerCase();
  const pre = arts.filter((a) => !q || `${a.title} ${a.body} ${a.url}`.toLowerCase().includes(q));
  const shown = pre.filter((a) => type === 'all' || a.type === type).sort((a, b) => b.at - a.at);
  const selId = shown.some((a) => a.id === sel) ? sel : shown[0]?.id ?? null;
  const cur = selId != null ? arts.find((a) => a.id === selId) ?? null : null;

  const groups = useMemo(() => {
    const keyOf = (a: Artifact): [number, string] => {
      if (group === 'area') {
        const x = a.tags[0] ? areaOf(a.tags[0]) : undefined;
        return x ? [AREAS.indexOf(x), x.label] : [99, 'No area'];
      }
      if (group === 'idea') {
        const n = a.links.map(ideaOf).find(Boolean);
        return n ? [n.id, `#${n.id}  ${n.title}`] : [1e9, 'Not linked to an idea'];
      }
      const d = Date.now() - a.at;
      return d < 24 * H ? [0, 'Today'] : d < 7 * 24 * H ? [1, 'This week'] : [2, 'Earlier'];
    };
    const m = new Map<number, { k: number; label: string; rows: Artifact[] }>();
    shown.forEach((a) => {
      const [k, label] = keyOf(a);
      if (!m.has(k)) m.set(k, { k, label, rows: [] });
      m.get(k)!.rows.push(a);
    });
    return [...m.values()].sort((x, y) => (group === 'idea' ? Number(x.k === 1e9) - Number(y.k === 1e9) : x.k - y.k));
  }, [shown, group]);
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

  const linkedCount = arts.filter((a) => a.links.length).length;
  const blocks = cur ? parseBody(cur.body) : [];

  return (
    <div className="ar" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <section className="ar-list">
        <div className="ar-listhead">
          <div className="ar-titlerow">
            <div className="ar-title">
              <h1>Artifacts</h1>
              <span>{arts.length} kept · {linkedCount} linked to ideas</span>
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
                      <span>{ageMs(a.at)}</span>
                      <span>{a.links.slice(0, 2).map((i) => `#${i}`).join(' ')}{a.links.length > 2 ? ` +${a.links.length - 2}` : ''}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
          {shown.length === 0 && (
            <div className="ar-empty">
              <span className="l">{arts.length ? 'Nothing matches' : 'No artifacts yet'}</span>
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
          const tags = cur.tags.map(areaOf).filter((x): x is (typeof AREAS)[number] => !!x);
          return (<>
            <div className="ar-viewbar">
              <span className="ar-badge" style={{ color: t.fg }}>{t.badge}</span>
              <span className="when">{t.label} · edited {ageMs(cur.at)}</span>
              <span className="rc-grow" />
              <button className="ar-discard" onClick={() => { setArts((xs) => xs.filter((a) => a.id !== cur.id)); setSel(null); setEditing(false); }}>
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
                      {AREAS.map((a) => {
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
                    {cur.img
                      ? <img src={cur.img} alt={cur.title || 'Mockup'} />
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
                      <span className="path">{cur.file ? fmtSize(cur.file.size) : ''}</span>
                    </div>
                  </div>
                )}

                {editing ? (
                  <div className="ar-bodyedit">
                    <textarea rows={18} value={cur.body} placeholder={t.ph} aria-label="Body"
                      onChange={(e) => { const v = e.target.value; upd(cur.id, () => ({ body: v })); }} />
                    <span className="hint">A short line on its own becomes a heading. Start a line with - for a bullet, - [ ] for a step.</span>
                  </div>
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
                    {cur.links.map(ideaOf).filter((n): n is (typeof IDEAS)[number] => !!n).map((n) => (
                      <div key={n.id} className="ar-idea" style={{ background: STAGE_TINT[n.stage].bg }}>
                        <div className="top">
                          <span className="stage" style={{ color: STAGE_TINT[n.stage].fg }}>{n.stage}</span>
                          <span className="rc-grow" />
                          <button className="x" title="Unlink" aria-label={`Unlink #${n.id}`}
                            onClick={() => upd(cur.id, (x) => ({ links: x.links.filter((i) => i !== n.id) }))}>✕</button>
                        </div>
                        <span className="t">{n.title}</span>
                        <span className="ref">#{n.id}{n.taskId ? `  → ${n.taskId}` : ''}</span>
                      </div>
                    ))}
                  </div>
                  {cur.links.length === 0 && <span className="ar-nolinks">Not linked to an idea yet.</span>}
                  {linkOpen && (
                    <div className="ar-linkopts">
                      {IDEAS.filter((n) => !cur.links.includes(n.id)).map((n) => (
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
    </div>
  );
}
