import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getInstructions, createInstructionFile, patchInstructionFile, deleteInstructionFile,
  adoptInstructionFile, draftRuleChange, scanInstructions, getProjects, AuthError,
  type InstructionFile, type InstructionOnDisk, type InstructionReport, type ScribeState,
  type RuleDiff, type ScanFinding,
} from '../store';
import type { Project } from '../types';
import { hrefTo } from '../lib/route';
import {
  parseInstructions, setRuleFlags, moveRule, removeRule, addRule,
  mergeContext, mergeTokens, fileStats, precedenceRank,
  type Rule,
} from '../lib/instructions';

// THE INSTRUCTIONS TAB — the CLAUDE.md tree, as a place you can see.
//
// Third tab on the Settings screen, beside Mission Control, because that is
// where the things governing the whole house live: Mission Control runs the
// fleet, Settings shapes the sessions, and this is what every one of them is
// told before it starts. It is deliberately NOT a project tab — the personal
// file and the repo files are one tree, and the question the tab exists to
// answer ("which of these wins, and what does the merged thing cost?") cannot
// be asked from inside a single project.
//
// Everything here is DERIVED from one string per file. `lib/instructions.ts`
// parses it; nothing on this screen stores a rule, an order, a scope or a
// switch anywhere else. That is what lets the structured view, the raw
// textarea and the merge preview be three renderings of one truth instead of
// three copies that drift — and it is why every edit below goes through the
// splice helpers rather than rebuilding a file from what is on screen.
//
// Three rules the surface itself has to keep:
//
//  • **Unmanaged is not absent.** A CLAUDE.md the host found and Stack does not
//    manage is Claude's real context and has to be in the tree, greyed, with
//    Adopt beside it. Hiding it would make the merge preview a lie.
//  • **NO PASS RAN is not a clean bill.** The Scribe's card says a pass has not
//    run rather than showing nothing, the same rule as a NULL review verdict.
//  • **Nothing the agent returns is applied.** A model editing its own
//    instructions unread is the one thing this surface must not do.

type Mode = 'editor' | 'map';
type View = 'structured' | 'raw' | 'preview';
type Dock = 'claude' | 'gemini';
type Msg = { role: 'user' | 'scribe'; text: string };

const PASSES = [
  { key: 'contradictions', title: 'Find contradictions', desc: 'Rules that fight across the file tree.' },
  { key: 'missing', title: 'Suggest what is missing', desc: 'Conventions your files assume but never state.' },
  { key: 'tighten', title: 'Tighten wording', desc: 'Vague rules Claude has to guess at.' },
  { key: 'budget', title: 'Token budget', desc: 'What the merged context costs, line by line.' },
];

// Starter rules. A local catalogue, not a server table: these are wording, and
// wording that would have to be migrated the moment it is improved. Clicking
// one appends it to the open file's current section — a first draft to edit,
// never something that arrives switched on and unread.
const LIBRARY = [
  { title: 'Test before commit', section: 'Commands', text: 'Run the full suite before proposing a change; watch mode hangs in CI.' },
  { title: 'No raw hex values', section: 'Code style', text: 'Colours, spacing and type come from the design tokens. Never write a raw hex value in a component.' },
  { title: 'Conventional commits', section: 'Workflow', text: 'Commit messages are `type(scope): summary`, imperative mood, under 60 characters.' },
  { title: 'Ask before large refactors', section: 'Workflow', text: 'Show a plan first for anything touching more than three files.' },
  { title: 'Prefer editing over creating', section: 'Code style', text: 'Never create a file when an edit will do.' },
  { title: 'Name the non-obvious', section: 'Code style', text: 'Keep comments for what the code cannot say. Do not narrate what it already says.' },
  { title: 'No secrets in the repo', section: 'Project', text: 'Secrets load at runtime from the environment. Nothing credential-shaped is ever committed.' },
];

const relTime = (iso: string | null): string => {
  if (!iso) return '';
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 90) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 48 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
};

/** A place in the tree, managed or not — the left rail's row model. */
type Place = {
  key: string;
  scope: 'global' | 'project';
  slug: string;
  dir: string;
  path: string;
  file: InstructionFile | null;     // null = on disk, nobody manages it
  disk: InstructionOnDisk | null;   // null = in the library, not on disk yet
  body: string;
  rank: number;
};

// The tree for one project: the personal file, that project's files, and every
// unmanaged CLAUDE.md the host reported in the same places. Weakest precedence
// first, which is the order everything downstream depends on.
function buildTree(
  files: InstructionFile[], report: InstructionReport, slug: string,
): Place[] {
  const out = new Map<string, Place>();
  const key = (scope: string, s: string, dir: string) => `${scope}:${scope === 'project' ? s : ''}:${dir}`;

  for (const d of report.files) {
    if (d.scope === 'project' && d.slug !== slug) continue;
    const k = key(d.scope, d.slug, d.dir);
    out.set(k, {
      key: k, scope: d.scope, slug: d.slug, dir: d.dir, path: d.path.split('/').slice(-3).join('/'),
      file: null, disk: d, body: d.body, rank: precedenceRank(d.scope, d.dir),
    });
  }
  for (const f of files) {
    if (f.scope === 'project' && f.slug !== slug) continue;
    const k = key(f.scope, f.slug, f.dir);
    const disk = out.get(k)?.disk ?? null;
    out.set(k, {
      key: k, scope: f.scope, slug: f.slug, dir: f.dir, path: f.path,
      file: f, disk, body: f.body, rank: precedenceRank(f.scope, f.dir),
    });
  }
  // The path shown for an unmanaged file comes off disk and can be absolute;
  // normalise it to the same spelling a managed one uses so the two rails read
  // as one tree rather than as two sources.
  for (const p of out.values()) {
    if (!p.file) p.path = p.scope === 'global' ? '~/.claude/CLAUDE.md' : `${p.dir ? `${p.dir}/` : ''}CLAUDE.md`;
  }
  return [...out.values()].sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path));
}

export function InstructionsPanel({ initialSlug }: { initialSlug?: string }) {
  const [files, setFiles] = useState<InstructionFile[]>([]);
  const [report, setReport] = useState<InstructionReport>({ files: [], repos: [], detail: '', when: null });
  const [agent, setAgent] = useState<ScribeState>({ enabled: true, ops: [], opsReady: [] });
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [slug, setSlug] = useState(initialSlug || '');
  const [mode, setMode] = useState<Mode>('editor');
  const [view, setView] = useState<View>('structured');
  const [activeKey, setActiveKey] = useState('');
  const [node, setNode] = useState('');

  // The unsaved body of the open file, keyed by file id. A draft rather than a
  // write-through: toggling six rules and then deciding against them must not
  // leave six versions on the host, and the host writes what is saved.
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);

  // The dock.
  const [dockOpen, setDockOpen] = useState(true);
  const [dock, setDock] = useState<Dock>('claude');
  const [log, setLog] = useState<Msg[]>([]);
  const [ask, setAsk] = useState('');
  const [thinking, setThinking] = useState(false);
  const [diff, setDiff] = useState<RuleDiff | null>(null);
  const [pass, setPass] = useState('contradictions');
  const [scan, setScan] = useState<{ title: string; meta: string; items: ScanFinding[] } | null>(null);
  const [scanning, setScanning] = useState(false);

  const [picking, setPicking] = useState(false);
  const [pickedPath, setPickedPath] = useState('');
  const [librarySearch, setLibrarySearch] = useState('');
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [newRule, setNewRule] = useState('');
  const [scopeEdit, setScopeEdit] = useState<number | null>(null);
  const dragFrom = useRef<number | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([getInstructions(), getProjects()])
      .then(([data, ps]) => {
        setFiles(data.files);
        setReport(data.report);
        setAgent(data.agent);
        setProjects(ps);
        setError('');
      })
      .catch((e) => { if (!(e instanceof AuthError)) setError((e as Error)?.message || 'Could not read the instructions tree.'); })
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  // A bare '#/instructions' should open something, not an empty picker — and
  // it should open a project that HAS a tree. Landing on whichever project
  // sorts first shows an almost-empty screen to somebody who has files in the
  // next one down, which reads as "Stack found nothing" rather than "you
  // picked the wrong project".
  useEffect(() => {
    if (slug || !projects.length) return;
    const withFiles = projects.find((p) => files.some((f) => f.slug === p.id));
    setSlug(initialSlug || withFiles?.id || projects[0].id);
  }, [projects, files, slug, initialSlug]);

  const tree = useMemo(() => buildTree(files, report, slug), [files, report, slug]);
  // Opening on the PROJECT ROOT rather than the first row: the personal file
  // sorts first because it is weakest, but it is not what somebody opening a
  // project's tree came to read, and it is the one file that does not change
  // when they switch projects.
  const active = useMemo(() => tree.find((p) => p.key === activeKey)
    || tree.find((p) => p.scope === 'project' && !p.dir && p.file)
    || tree.find((p) => p.file) || tree[0] || null,
  [tree, activeKey]);

  // The body being edited: the unsaved draft if there is one, else what was saved.
  const body = active?.file ? (drafts[active.file.id] ?? active.file.body) : (active?.body ?? '');
  const dirty = !!(active?.file && drafts[active.file.id] !== undefined
    && drafts[active.file.id] !== active.file.body);
  const readOnly = !active?.file;

  const parsed = useMemo(() => parseInstructions(body), [body]);
  const stats = useMemo(() => fileStats(body), [body]);
  // The merge preview reads the DRAFT for the open file and the saved body for
  // the rest — "what Claude sees" has to include the change you are looking at,
  // or the view answers a question you did not ask.
  const mergeFiles = useMemo(() => tree.map((p) => ({
    label: p.scope === 'global' ? '~/.claude' : (p.dir ? `${p.dir}/` : 'CLAUDE.md'),
    body: p.key === active?.key ? body : p.body,
  })), [tree, active, body]);
  const preview = useMemo(() => mergeContext(mergeFiles), [mergeFiles]);
  const totalTokens = useMemo(() => mergeTokens(mergeFiles), [mergeFiles]);

  const edit = (next: string) => {
    if (!active?.file) return;
    setDrafts((d) => ({ ...d, [active.file!.id]: next }));
  };

  const fail = (e: unknown, fallback: string) => {
    if (!(e instanceof AuthError)) setError((e as Error)?.message || fallback);
  };

  const save = async () => {
    if (!active?.file || !dirty) return;
    setSaving(true);
    try {
      const saved = await patchInstructionFile(active.file.id, { body });
      setFiles((fs) => fs.map((f) => (f.id === saved.id ? saved : f)));
      setDrafts((d) => { const { [saved.id]: _drop, ...rest } = d; return rest; });
      setNotice('Saved. The host writes it on its next sync (within five minutes).');
      setError('');
    } catch (e) { fail(e, 'Could not save.'); } finally { setSaving(false); }
  };

  const adopt = async (p: Place) => {
    try {
      const file = await adoptInstructionFile({ scope: p.scope, slug: p.slug, dir: p.dir });
      setFiles((fs) => [...fs, file]);
      setActiveKey(p.key);
      setNotice(`Stack now manages ${file.path}. It writes the managed marker into it on the next sync.`);
      setError('');
    } catch (e) { fail(e, 'Could not adopt that file.'); }
  };

  const addFile = async (dir: string) => {
    if (!slug) return;
    setPicking(false);
    try {
      const seed = dir
        ? `# ${dir}\n\nRules for everything under \`${dir}/\`. The closest file to an edit wins.\n`
        : `# ${projects.find((p) => p.id === slug)?.name || slug}\n\n## Project\n\n`;
      const file = await createInstructionFile({ scope: 'project', slug, dir, body: seed });
      setFiles((fs) => [...fs, file]);
      setActiveKey(`project:${slug}:${dir}`);
      setView('structured');
      setError('');
    } catch (e) { fail(e, 'Could not add that file.'); }
  };

  // The DESTINATIONS a new file can go in, from what the host actually found in
  // the repo — not a text box the owner has to remember a path for. Directories
  // that already hold a CLAUDE.md are excluded (there is nothing to add there),
  // and the root is offered only when it is free.
  const repoDirs = report.repos.find((r) => r.slug === slug) || null;
  const taken = new Set(tree.filter((p) => p.scope === 'project').map((p) => p.dir));
  const destinations = (repoDirs?.dirs || []).filter((d) => !taken.has(d.dir));
  const rootFree = !taken.has('');

  const removeFile = async (p: Place) => {
    if (!p.file) return;
    try {
      await deleteInstructionFile(p.file.id);
      setFiles((fs) => fs.filter((f) => f.id !== p.file!.id));
      setNotice(p.file.adopted
        ? 'Out of the library. The file itself stays on disk — an adopted file goes back to being yours.'
        : 'Out of the library. The host removes the file it planted on its next sync.');
      setError('');
    } catch (e) { fail(e, 'Could not remove that file.'); }
  };

  // ---- the Scribe -----------------------------------------------------------

  const canDraft = agent.enabled && agent.opsReady.includes('ruledraft');
  const canScan = agent.enabled && agent.opsReady.includes('rulescan');

  const send = async () => {
    const question = ask.trim();
    if (!question || thinking) return;
    const history = log.slice(-6);
    setLog((l) => [...l, { role: 'user', text: question }]);
    setAsk('');
    setThinking(true);
    setDiff(null);
    try {
      const out = await draftRuleChange(slug, question, history);
      setLog((l) => [...l, { role: 'scribe', text: out.reply || 'No answer came back.' }]);
      setDiff(out.diff);
    } catch (e) {
      if (!(e instanceof AuthError)) {
        setLog((l) => [...l, { role: 'scribe', text: (e as Error)?.message || 'The Scribe could not answer.' }]);
      }
    } finally { setThinking(false); }
  };

  // Apply a proposal — CLIENT-SIDE, through the same splice helpers every other
  // edit uses, and only into the draft. Nothing is written until Save, so a
  // proposal you dislike costs one undo and never reaches the host.
  const applyDiff = () => {
    if (!diff) return;
    const target = tree.find((p) => p.path === diff.path);
    if (!target?.file) {
      setNotice(`${diff.path} is not a file Stack manages — adopt it first.`);
      return;
    }
    let next = target.file.id === active?.file?.id ? body : (drafts[target.file.id] ?? target.file.body);
    for (const text of diff.remove) {
      // Match on the rule's own wording rather than an index: the model is
      // quoting a file it read a moment ago, and an index would apply the
      // change to the wrong line the instant anything else moved.
      const found = parseInstructions(next).rules
        .find((r) => r.text === text || r.text.includes(text.slice(0, 60)));
      if (found) next = removeRule(next, found.index);
    }
    for (const text of diff.add) next = addRule(next, diff.section, text);
    setDrafts((d) => ({ ...d, [target.file!.id]: next }));
    setActiveKey(target.key);
    setView('structured');
    setDiff(null);
    setLog((l) => [...l, { role: 'scribe', text: `Applied to ${diff.path}. Nothing is on the host until you press Save changes.` }]);
  };

  const runPass = async (key: string) => {
    setPass(key);
    setScanning(true);
    try {
      const out = await scanInstructions(slug, key);
      setScan({ title: out.title, meta: out.meta, items: out.items });
      setError('');
    } catch (e) { fail(e, 'The pass could not run.'); setScan(null); } finally { setScanning(false); }
  };

  // ---- rule edits -----------------------------------------------------------

  const toggleRule = (r: Rule, on: boolean) => edit(setRuleFlags(body, r.index, { on }));
  const toggleOverrides = (r: Rule) => edit(setRuleFlags(body, r.index, { overrides: !r.overrides }));
  const commitScope = (r: Rule, scope: string) => {
    edit(setRuleFlags(body, r.index, { scope: scope.trim() }));
    setScopeEdit(null);
  };
  const onDrop = (r: Rule) => {
    if (dragFrom.current === null || dragFrom.current === r.index) return;
    edit(moveRule(body, dragFrom.current, r.index));
    dragFrom.current = null;
  };

  // ---- the map --------------------------------------------------------------

  const MAP_CAP = 6;
  const nested = tree.filter((p) => p.scope === 'project' && p.dir);
  const drawn = nested.slice(0, MAP_CAP);
  const root = tree.find((p) => p.scope === 'project' && !p.dir) || null;
  const global = tree.find((p) => p.scope === 'global') || null;
  const nodeOf = (key: string) => tree.find((p) => p.key === key) || null;
  const selected = nodeOf(node) || root || global || tree[0] || null;
  const nestedY = (i: number) => 96 + i * 74;

  const projectName = projects.find((p) => p.id === slug)?.name || slug;

  if (loading) return <div className="empty-state"><div className="big">Reading the tree…</div></div>;

  return (
    <div className="ins">
      {/* ---- the bar: whose tree, which mode, and the save ---- */}
      <div className="ins-bar">
        <div className="ins-bar-left">
          <label className="ins-pick">
            <span className="lbl">Project</span>
            <select value={slug} onChange={(e) => { setSlug(e.target.value); setActiveKey(''); setNode(''); setScan(null); }}>
              {!projects.length && <option value="">no projects yet</option>}
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <span className="ins-bar-note">
            {report.when
              ? <>host synced {relTime(report.when)} · <span className="mono">{report.detail || '—'}</span></>
              : <>the host has not reported yet — nothing here has been checked against disk</>}
          </span>
        </div>
        <div className="ins-bar-right">
          <div className="seg-control sm" role="tablist" aria-label="View mode">
            {(['editor', 'map'] as Mode[]).map((m) => (
              <button key={m} role="tab" aria-selected={mode === m}
                className={`seg-opt ${mode === m ? 'on' : ''}`} onClick={() => setMode(m)}>
                {m === 'editor' ? 'Editor' : 'Map'}
              </button>
            ))}
          </div>
          {/* Quiet when there is nothing to save: a solid accent button that
              does nothing reads as the thing you are supposed to press. */}
          <button className={dirty || saving ? 'btn-accent' : 'ins-save-idle'}
            onClick={save} disabled={!dirty || saving}>
            {saving ? 'Saving…' : dirty ? 'Save changes' : 'No unsaved changes'}
          </button>
        </div>
      </div>

      {error && <div className="action-error">{error}</div>}
      {notice && <div className="ins-notice" onClick={() => setNotice('')}>{notice}</div>}

      {/* ---- the Scribe's dock — editor only ----
          Not on the map. The map is a reading surface for one question ("which
          file wins where?") and it needs the height; the dock is where you go
          to change something, which is the editor's job. */}
      {mode === 'editor' && (
      <div className="ins-dock">
        <div className="ins-dock-head">
          <div className="seg-control sm" role="tablist" aria-label="Which agent">
            {(['claude', 'gemini'] as Dock[]).map((d) => (
              <button key={d} role="tab" aria-selected={dock === d}
                className={`seg-opt ${dock === d ? 'on' : ''}`} onClick={() => setDock(d)}>
                {d === 'claude' ? 'Scribe · Claude' : 'Quick passes · Gemini'}
              </button>
            ))}
          </div>
          <span className="ins-dock-blurb">
            {dock === 'claude'
              ? 'Answers as a diff you accept — it never writes to a file itself.'
              : 'Read-only passes over the whole tree. Nothing is written, ever.'}
          </span>
          <span className="ins-dock-right">
            <span className="mono ins-faint">
              {active ? <>writes to {active.path}</> : 'no file open'}
            </span>
            <button className="ins-chev" onClick={() => setDockOpen((o) => !o)}
              title={dockOpen ? 'Collapse' : 'Expand'}>{dockOpen ? '▾' : '▴'}</button>
          </span>
        </div>

        {dockOpen && !agent.enabled && (
          <div className="ins-dock-off">
            The Scribe is switched off. <a href={hrefTo.control('agents')}>Mission Control → Agents</a> turns it back on.
          </div>
        )}

        {dockOpen && agent.enabled && dock === 'claude' && (
          <div className="ins-chat">
            <div className="ins-chat-log">
              {!log.length && (
                <div className="ins-chat-empty">
                  Ask for a change to these files in your own words — “split the test rule, people run
                  watch mode all day locally”. What comes back is a diff you accept or discard.
                </div>
              )}
              {log.map((m, i) => (
                <div key={i} className={`ins-msg ${m.role}`}>
                  {/* The Scribe's mark is drawn, not typed. A glyph here has to
                      render on whatever font the viewer's browser falls back
                      to, and the round ones that read well in a mono column
                      are exactly the ones that go missing. */}
                  <span className="mk">{m.role === 'user' ? '›' : <i className="ins-mk-dot" />}</span>
                  <span className="txt">{m.text}</span>
                </div>
              ))}
              {thinking && (
                <div className="ins-msg scribe">
                  <span className="mk"><i className="ins-mk-dot" /></span>
                  <span className="txt ins-faint">Reading the tree…</span>
                </div>
              )}

              {diff && (
                <div className="ins-msg scribe">
                  <span className="mk" />
                  <div className="ins-diff">
                    <div className="ins-diff-head">
                      <span className="mono">{diff.path}{diff.section ? ` · ## ${diff.section}` : ''}</span>
                      <span className="mono ins-faint">+{diff.add.length} −{diff.remove.length}</span>
                    </div>
                    <div className="ins-diff-body">
                      {diff.remove.map((t, i) => <div key={`r${i}`} className="ins-diff-line minus">− {t}</div>)}
                      {diff.add.map((t, i) => <div key={`a${i}`} className="ins-diff-line plus">+ {t}</div>)}
                    </div>
                    <div className="ins-diff-foot">
                      <button className="btn-accent sm" onClick={applyDiff}>Apply to file</button>
                      <button className="ins-btn-quiet" onClick={() => setDiff(null)}>Discard</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="ins-chat-input">
              <span className="mono ins-accent">›</span>
              <input value={ask} onChange={(e) => setAsk(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void send(); } }}
                disabled={!canDraft || thinking}
                placeholder={canDraft
                  ? 'Ask the Scribe to change these instructions…'
                  : 'The host daemon is offline, so the Scribe cannot run.'} />
              <span className="ins-chat-actions">
                <span className="ins-kbd">⏎ send</span>
                <button className="btn-dark" onClick={send} disabled={!canDraft || thinking || !ask.trim()}>Run</button>
              </span>
            </div>
          </div>
        )}

        {dockOpen && agent.enabled && dock === 'gemini' && (
          <div className="ins-passes">
            <div className="ins-pass-list">
              <div className="lbl">Quick passes</div>
              {PASSES.map((p) => (
                <button key={p.key} className={`ins-pass ${pass === p.key ? 'on' : ''}`}
                  disabled={!canScan || scanning} onClick={() => runPass(p.key)}>
                  <span className="t">{p.title}</span>
                  <span className="d">{p.desc}</span>
                </button>
              ))}
            </div>
            <div className="ins-pass-out">
              {!canScan ? (
                <div className="ins-absent">
                  Gemini is not configured on this server, so the read-only passes cannot run. They are
                  the only part of this tab that uses it; everything else runs on your own Claude.
                </div>
              ) : scanning ? (
                <div className="ins-absent">Reading {tree.length} file{tree.length === 1 ? '' : 's'}…</div>
              ) : !scan ? (
                // NO PASS RAN — deliberately not rendered as a clean bill.
                <div className="ins-absent">No pass has run yet. That is not the same as nothing being wrong.</div>
              ) : (
                <>
                  <div className="ins-pass-head">
                    <span className="h">{scan.title}</span>
                    <span className="mono ins-faint">{scan.meta}</span>
                  </div>
                  {!scan.items.length ? (
                    <div className="ins-absent">
                      Nothing found on this pass — an empty answer is a real one, and this tree may
                      simply be fine for it.
                    </div>
                  ) : scan.items.map((f, i) => (
                    <div key={i} className="ins-finding">
                      <span className="body">
                        <span className="t">{f.text}</span>
                        <span className="mono w">{f.where}</span>
                      </span>
                      {f.action && <span className="tag">{f.action}</span>}
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        )}
      </div>
      )}

      {/* ---- EDITOR ---- */}
      {mode === 'editor' && (
        <div className="ins-cols">
          {/* ---- left rail: the tree, and what wins ---- */}
          <div className="ins-rail">
            <div className="ins-card">
              <div className="lbl">Files in scope</div>
              <div className="ins-files">
                {!tree.length && <div className="ins-absent sm">No CLAUDE.md anywhere in this project yet.</div>}
                {tree.map((p) => (
                  <button key={p.key} className={`ins-file ${p.key === active?.key ? 'on' : ''} ${p.file ? '' : 'unmanaged'}`}
                    onClick={() => { setActiveKey(p.key); setNode(p.key); }}>
                    <span className={`dot ${p.scope === 'global' ? 'global' : p.dir ? 'nested' : 'root'}`} />
                    <span className="main">
                      <span className="mono path">{p.path}</span>
                      <span className="meta">
                        {p.scope === 'global' ? 'Personal' : p.dir ? 'Nested' : 'Project root'}
                        {p.file ? ` · ${fileStats(p.file.body).on} of ${fileStats(p.file.body).rules} rules on` : ' · not managed'}
                        {p.file && !p.file.installedAt ? ' · not on disk yet' : ''}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
              <div className="ins-files-foot">
                {slug && (
                  <button className="ins-add" onClick={() => { setPickedPath(''); setPicking(true); }}>
                    + New CLAUDE.md
                  </button>
                )}
              </div>
            </div>

            <div className="ins-card panelish">
              <div className="lbl">Precedence</div>
              {/* Strongest first: "which file wins?" is the question, and a list
                  that answers it from the bottom up makes the reader do the
                  inversion themselves. */}
              <div className="ins-prec">
                {[...tree].reverse().map((p, i) => (
                  <div key={p.key} className="row">
                    <span className="mono n">{i + 1}</span>
                    <span className="t">
                      {p.scope === 'global' ? <>Your personal <span className="mono">~/.claude</span></>
                        : p.dir ? <>Nested — <span className="mono">{p.dir}/</span></>
                          : 'Project root'}
                    </span>
                  </div>
                ))}
                {!tree.length && <div className="ins-absent sm">Nothing to order yet.</div>}
              </div>
              <button className="ins-see-map" onClick={() => setMode('map')}>See the map →</button>
            </div>
          </div>

          {/* ---- centre: the file ---- */}
          <div className="ins-editor">
            <div className="ins-editor-head">
              <div className="ins-editor-title">
                <span className="mono path">{active?.path || '—'}</span>
                <span className="meta">
                  {active
                    ? <>{stats.on} of {stats.rules} rules on · ~{stats.tokens} tokens{dirty ? ' · unsaved' : ''}
                      {active.file?.updatedAt && !dirty ? ` · saved ${relTime(active.file.updatedAt)}` : ''}</>
                    : 'nothing open'}
                </span>
              </div>
              <div className="seg-control sm" role="tablist" aria-label="How to read the file">
                {(['structured', 'raw', 'preview'] as View[]).map((v) => (
                  <button key={v} role="tab" aria-selected={view === v}
                    className={`seg-opt ${view === v ? 'on' : ''}`} onClick={() => setView(v)}>
                    {v === 'structured' ? 'Structured' : v === 'raw' ? 'Raw' : 'Claude sees'}
                  </button>
                ))}
              </div>
            </div>

            {readOnly && active && (
              <div className="ins-readonly">
                <span>
                  Claude reads this file, and Stack does not manage it — so nothing here can be
                  edited. Adopting it writes Stack's marker into the file and hands the editing to you.
                </span>
                <button className="btn-accent sm" onClick={() => adopt(active)}>Adopt this file</button>
              </div>
            )}

            {view === 'structured' && (
              <div className="ins-rules">
                {!parsed.rules.length && (
                  <div className="ins-absent">
                    {active ? 'This file has no rules in it yet.' : 'Pick a file on the left.'}
                  </div>
                )}
                {parsed.sections.map((section) => (
                  <div key={section.name || '(unnamed)'} className="ins-section">
                    <div className="ins-section-head">
                      <span className="h">{section.name || 'Ungrouped'}</span>
                      <span className="rule" />
                      <span className="mono n">{section.rules.length} rule{section.rules.length === 1 ? '' : 's'}</span>
                    </div>
                    {section.rules.map((r) => (
                      <div key={r.index} className={`ins-rule ${r.on ? '' : 'off'}`}
                        draggable={!readOnly}
                        onDragStart={() => { dragFrom.current = r.index; }}
                        onDragOver={(e) => { if (!readOnly) e.preventDefault(); }}
                        onDrop={() => onDrop(r)}>
                        <span className="grip" title="Drag to reorder within this section">⠿</span>
                        <span className="main">
                          <span className="txt">{r.text}</span>
                          <span className="chips">
                            {scopeEdit === r.index ? (
                              <input className="ins-scope-input" autoFocus defaultValue={r.scope}
                                placeholder="a glob, e.g. api/**"
                                onBlur={(e) => commitScope(r, e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') commitScope(r, (e.target as HTMLInputElement).value);
                                  if (e.key === 'Escape') setScopeEdit(null);
                                }} />
                            ) : (
                              <button className="ins-chip mono" disabled={readOnly}
                                onClick={() => setScopeEdit(r.index)}
                                title="Which files this rule applies to">
                                {r.scope || 'all files'}
                              </button>
                            )}
                            {/* Only where an override is a thing that can be
                                true. The personal file is the weakest in the
                                tree — a rule in it overrides nothing, and
                                offering the chip there is offering a claim
                                that cannot be made. */}
                            {((active?.rank ?? 0) > 0 || r.overrides) && (
                              <button className={`ins-chip ov ${r.overrides ? 'on' : ''}`} disabled={readOnly}
                                onClick={() => toggleOverrides(r)}
                                title="Declared, never guessed — two rules in one section are not automatically in conflict">
                                overrides root
                              </button>
                            )}
                            <span className="mono ins-faint">~{r.tokens} tok</span>
                          </span>
                        </span>
                        <button className={`switch ${r.on ? 'on' : ''}`} disabled={readOnly}
                          aria-label={`${r.on ? 'Disable' : 'Enable'} this rule`}
                          onClick={() => toggleRule(r, !r.on)}>
                          <span className="switch-knob" />
                        </button>
                        <button className="ins-x" disabled={readOnly} title="Remove this rule"
                          onClick={() => edit(removeRule(body, r.index))}>×</button>
                      </div>
                    ))}
                    {!readOnly && (addingTo === section.name ? (
                      <div className="ins-newrule">
                        <input autoFocus value={newRule} onChange={(e) => setNewRule(e.target.value)}
                          placeholder="One instruction, plainly stated"
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') { setAddingTo(null); setNewRule(''); }
                            if (e.key === 'Enter' && newRule.trim()) {
                              edit(addRule(body, section.name, newRule));
                              setNewRule(''); setAddingTo(null);
                            }
                          }} />
                        <button className="ins-btn-quiet" onClick={() => { setAddingTo(null); setNewRule(''); }}>Cancel</button>
                      </div>
                    ) : (
                      <button className="ins-add-rule" onClick={() => { setAddingTo(section.name); setNewRule(''); }}>
                        + Add a rule to {section.name || 'this group'}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {view === 'raw' && (
              <textarea className="ins-raw" value={body} spellCheck={false} readOnly={readOnly}
                onChange={(e) => edit(e.target.value)} />
            )}

            {view === 'preview' && (
              <div className="ins-preview">
                <div className="ins-preview-note">
                  <span>
                    The assembled context for an edit in this project — {tree.length} file
                    {tree.length === 1 ? '' : 's'} merged, switched-off rules dropped, your unsaved
                    changes included.
                  </span>
                  <span className="mono">~{totalTokens.toLocaleString()} tokens</span>
                </div>
                <div className="ins-preview-lines">
                  {preview.map((l, i) => (
                    <div key={i} className="row">
                      <span className={`mono src ${l.src === '~/.claude' ? 'global' : l.src.endsWith('/') ? 'nested' : 'root'}`}>{l.src}</span>
                      <span className={`mono line ${l.line.startsWith('#') ? 'head' : ''}`}>{l.line || ' '}</span>
                    </div>
                  ))}
                  {!preview.length && <div className="ins-absent">Nothing is switched on anywhere in this tree.</div>}
                </div>
              </div>
            )}
          </div>

          {/* ---- right rail: what to do next, and what to reach for ---- */}
          <div className="ins-rail">
            <div className="ins-card suggest">
              <div className="ins-suggest-head">
                <span className="dot" />
                <span className="lbl">The Scribe suggests</span>
              </div>
              {scan?.items.length ? (
                <>
                  <div className="t">{scan.items[0].text}</div>
                  <div className="mono w">{scan.items[0].where}</div>
                  <div className="acts">
                    <button className="btn-accent sm" onClick={() => { setDock('gemini'); setDockOpen(true); }}>
                      See all {scan.items.length}
                    </button>
                    <button className="ins-btn-quiet" onClick={() => setScan(null)}>Dismiss</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="t">
                    No pass has read this tree yet — so there is nothing to say about it, which is not
                    the same as there being nothing to fix.
                  </div>
                  <div className="acts">
                    <button className="btn-accent sm" disabled={!canScan}
                      onClick={() => { setDock('gemini'); setDockOpen(true); void runPass('contradictions'); }}>
                      Run a pass
                    </button>
                  </div>
                </>
              )}
            </div>

            <div className="ins-card">
              <div className="ins-lib-head">
                <span className="lbl">Rule library</span>
                <span className="mono ins-faint">{LIBRARY.length}</span>
              </div>
              <div className="searchbox">
                <span className="glass" />
                <input value={librarySearch} onChange={(e) => setLibrarySearch(e.target.value)}
                  placeholder="Search snippets" />
              </div>
              <div className="ins-lib">
                {LIBRARY
                  .filter((s) => !librarySearch
                    || `${s.title} ${s.text}`.toLowerCase().includes(librarySearch.toLowerCase()))
                  .map((s) => (
                    <button key={s.title} className="ins-lib-row" disabled={readOnly}
                      title={readOnly ? 'Adopt this file before editing it' : `Adds to ## ${s.section}`}
                      onClick={() => { edit(addRule(body, s.section, s.text)); setView('structured'); }}>
                      <span className="main">
                        <span className="t">{s.title}</span>
                        <span className="d">{s.text}</span>
                      </span>
                      <span className="plus">+</span>
                    </button>
                  ))}
              </div>
              <div className="ins-lib-foot">
                A first draft to edit, not a rule that arrives switched on and unread.
              </div>
            </div>

            {active?.file && (
              <div className="ins-card">
                <div className="lbl">This file</div>
                <div className="ins-facts">
                  <div className="row"><span>On disk</span><b>{active.file.installedAt ? relTime(active.file.installedAt) : 'not yet'}</b></div>
                  <div className="row"><span>Managed</span><b>{active.file.adopted ? 'adopted' : 'planted by Stack'}</b></div>
                  <div className="row"><span>Rules on</span><b>{stats.on} of {stats.rules}</b></div>
                  <div className="row"><span>Declared overrides</span><b>{stats.overrides}</b></div>
                </div>
                <button className="ins-remove" onClick={() => removeFile(active)}>
                  Remove from the library
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---- MAP ---- */}
      {mode === 'map' && (
        <div className="ins-map-card">
          <div className="ins-map-head">
            <span>Every CLAUDE.md in {projectName} and the paths it reaches. Click a node to inspect it.</span>
            <span className="legend">
              <span className="k"><i className="line" />inherits</span>
              <span className="k"><i className="line accent" />declares an override</span>
            </span>
          </div>

          <div className="ins-map">
            <svg viewBox="0 0 1060 540" preserveAspectRatio="xMinYMin meet">
              {global && root && (
                <path d="M165 116 C165 170, 185 170, 185 216" fill="none"
                  stroke="var(--keyline)" strokeWidth="1.5" />
              )}
              {root && drawn.map((p, i) => {
                const y = nestedY(i) + 44;
                const on = node === p.key;
                const overrides = fileStats(p.body).overrides > 0;
                return (
                  <path key={p.key} d={`M310 266 C400 266, 400 ${y}, 480 ${y}`} fill="none"
                    stroke={on || overrides ? 'var(--accent)' : 'var(--keyline)'}
                    strokeWidth={on ? 2.2 : 1.4} />
                );
              })}
            </svg>

            {global && (
              <button className={`ins-node global ${node === global.key ? 'on' : ''}`}
                style={{ left: 60, top: 56 }} onClick={() => setNode(global.key)}>
                <span className="mono p">~/.claude/CLAUDE.md</span>
                <span className="m">Personal · {fileStats(global.body).on} rules · every project</span>
              </button>
            )}
            {root && (
              <button className={`ins-node root ${node === root.key ? 'on' : ''}`}
                style={{ left: 60, top: 216 }} onClick={() => setNode(root.key)}>
                <span className="mono p">CLAUDE.md</span>
                <span className="m">Project root · {fileStats(root.body).rules} rules · {fileStats(root.body).on} on</span>
                <span className="mono r">{root.disk && root.disk.reach >= 0 ? `reaches ${root.disk.reach} files` : 'reach unknown — the host has not counted'}</span>
              </button>
            )}
            {drawn.map((p, i) => (
              <button key={p.key} className={`ins-node nested ${node === p.key ? 'on' : ''} ${p.file ? '' : 'unmanaged'}`}
                style={{ left: 480, top: nestedY(i) }} onClick={() => setNode(p.key)}>
                <span className="mono p">{p.dir}/CLAUDE.md</span>
                <span className="m">
                  {fileStats(p.body).rules} rules · {fileStats(p.body).overrides} declare an override
                </span>
                <span className="mono r">
                  {p.disk && p.disk.reach >= 0 ? `reaches ${p.disk.reach} files` : 'reach unknown'}
                </span>
              </button>
            ))}
            {!root && !global && !drawn.length && (
              <div className="ins-map-empty">No CLAUDE.md anywhere in this project yet.</div>
            )}
            {nested.length > MAP_CAP && (
              <div className="ins-map-cut">
                Showing {MAP_CAP} of {nested.length} nested files — the rest are in the editor's list.
              </div>
            )}

            {selected && (
              <div className="ins-map-sel">
                <div className="lbl">Selected</div>
                <div className="mono p">{selected.path}</div>
                <div className="b">
                  {selected.scope === 'global'
                    ? 'Applies to every repo you open. Weakest precedence — any project file can restate a rule and win.'
                    : selected.dir
                      ? <>Wins over the root file inside <span className="mono">{selected.dir}/</span>. {fileStats(selected.body).overrides} of its {fileStats(selected.body).rules} rules declare an override.</>
                      : 'The baseline for this project. Read on every edit unless a nested file restates the same rule.'}
                  {!selected.file && ' Stack does not manage this file — it is read-only here.'}
                </div>
                <div className="acts">
                  <button className="btn-accent sm" onClick={() => { setActiveKey(selected.key); setMode('editor'); setView('structured'); }}>Open editor</button>
                  <button className="ins-btn-quiet" onClick={() => { setActiveKey(selected.key); setMode('editor'); setView('preview'); }}>Preview merge</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---- where does a new CLAUDE.md go ----
          A picker over REAL directories, not a text box. The host already walks
          the repo, so it reports which directories exist and how many tracked
          files each one governs; asking the owner to recall a path from memory
          was asking them to do work the host had already done — and a typo went
          in silently as a file for a directory that is not there.
          The typed row stays for the two cases the list cannot cover: a
          directory deeper than the offer depth, and a host that could not ask
          git at all. */}
      {picking && (
        <div className="overlay" onClick={() => setPicking(false)}>
          <div className="modal wide ins-dest" onClick={(e) => e.stopPropagation()}>
            <h3>Where does this CLAUDE.md go?</h3>
            <div className="ins-dest-sub">
              Claude reads the file closest to the edit, so a nested file governs its own
              directory and everything under it. These are the directories the host found in
              <span className="mono"> {projectName}</span>
              {repoDirs?.known && repoDirs.root >= 0
                ? <> — {repoDirs.root.toLocaleString()} tracked files in all.</>
                : '.'}
            </div>

            <div className="ins-dest-list">
              {rootFree && (
                <button className="ins-dest-row root" onClick={() => addFile('')}>
                  <span className="main">
                    <span className="mono p">CLAUDE.md</span>
                    <span className="d">The repo root — the baseline every edit reads.</span>
                  </span>
                  <span className="mono n">
                    {repoDirs?.known && repoDirs.root >= 0 ? `${repoDirs.root} files` : 'whole repo'}
                  </span>
                </button>
              )}

              {destinations.map((d) => (
                <button key={d.dir} className="ins-dest-row" onClick={() => addFile(d.dir)}>
                  <span className="main">
                    <span className="mono p">{d.dir}/CLAUDE.md</span>
                    <span className="d">Governs everything under <span className="mono">{d.dir}/</span></span>
                  </span>
                  <span className="mono n">{d.files} file{d.files === 1 ? '' : 's'}</span>
                </button>
              ))}

              {/* Absent is not empty. A host that could not read the repo has to
                  say so, or "no directories" reads as a fact about the repo. */}
              {!repoDirs && (
                <div className="ins-absent sm">
                  The host has not reported this repo yet, so Stack cannot say which directories
                  it has. The sync runs every five minutes — or type a path below.
                </div>
              )}
              {repoDirs && !repoDirs.known && (
                <div className="ins-absent sm">
                  The host could not read this repo with git (is it cloned at
                  <span className="mono"> $STACK_AUTOPILOT_ROOT/{slug}</span>?), so there are no
                  directories to offer. Type a path below.
                </div>
              )}
              {repoDirs?.known && !destinations.length && !rootFree && (
                <div className="ins-absent sm">
                  Every directory the host offers already has a CLAUDE.md. Type a path below for
                  somewhere deeper.
                </div>
              )}
            </div>

            <div className="ins-dest-other">
              <span className="lbl">Somewhere else</span>
              <div className="row">
                <input value={pickedPath} onChange={(e) => setPickedPath(e.target.value)}
                  placeholder="a path relative to the repo root, e.g. packages/ui"
                  onKeyDown={(e) => { if (e.key === 'Enter' && pickedPath.trim()) void addFile(pickedPath.trim()); }} />
                <button className="btn-accent" disabled={!pickedPath.trim()}
                  onClick={() => addFile(pickedPath.trim())}>Create</button>
              </div>
            </div>

            <div className="modal-actions">
              <button className="btn-cancel" onClick={() => setPicking(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
