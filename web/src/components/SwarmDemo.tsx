import { useCallback, useEffect, useRef, useState } from 'react';
import { StackMark } from './Brandmark';
import { GIT_BASH_THEME as A, TERM_FONT } from '../lib/termWire';

// "SHOW ME HOW IT WORKS" — the title card's walkthrough.
//
// Claude Design project 62ed3498, "Stack Login" (Stack Login.dc.html). Four
// agents spawn, each takes a task into its own git worktree, works it, commits,
// and the sessions close into an orbit of branches ready for review.
//
// THE SESSIONS ARE DRAWN AS TMUX, NOT AS CARDS. The design floated each session
// in its own rounded window; the owner asked for them to look like the real
// thing (2026-11-15), because a real Stack session IS a tmux pane in an xterm.
// So this follows tmux's own rules, and they are not decoration:
//
//  · ONE terminal, split into panes. A split is instant (tmux never animates a
//    layout), and the fourth spawn re-tiles like `select-layout tiled`.
//  · Pane borders are one character cell wide. `pane-border-status top` puts a
//    title line above every pane: index (reversed when active), then the title.
//    Only the ACTIVE pane's border is green, and only the active pane has a
//    cursor.
//  · The status line is tmux's default: green, `[session] 0:window*` on the
//    left, `"pane title" %H:%M %d-%b-%y` on the right.
//  · Colours are the real terminal's: GIT_BASH_THEME and TERM_FONT from
//    lib/termWire.ts, never Stack's UI palette. The UI palette is only the
//    chrome around the terminal (header, orbit, chips).

type Seg = { text: string; color: string };
type Kind = 'cmd' | 'out' | 'dim' | 'add' | 'del' | 'ok' | 'err';
type Step = [Kind, string, number?];
type Sched = { type: Kind | 'prompt'; text?: string; at: number; segs: Seg[] };
type Agent = { name: string; task: string; title: string; branch: string; offset: number; lines: Step[]; sched: Sched[]; end: number; commit: string };

const SCRIPT: Omit<Agent, 'sched' | 'end' | 'commit'>[] = [
  { name: 'claude-1', task: '#412', title: 'Session refresh', branch: 'feat/412-session-refresh', offset: 0, lines: [
    ['cmd', 'git worktree add ../wt/412 -b feat/412-session-refresh'],
    ['out', "Preparing worktree (new branch 'feat/412-session-refresh')"],
    ['dim', 'HEAD is now at a3f9c21 bump deps', 500],
    ['cmd', 'claude "add token refresh to auth middleware"'],
    ['out', '● Reading src/auth/middleware.ts', 600],
    ['out', '● Reading src/auth/session.ts', 700],
    ['out', '● Editing src/auth/session.ts', 500],
    ['del', '-   // TODO: refresh expired tokens'],
    ['add', '+ export async function refresh(token: Token) {'],
    ['add', '+   const next = await issue(token.sub)'],
    ['add', '+   return { ...next, rotatedFrom: token.id }', 600],
    ['cmd', 'pnpm test auth'],
    ['dim', ' RUN  v2.1.4 /wt/412', 1400],
    ['ok', '✓ 14 passed (1.21s)', 500],
    ['ok', '● Committed 7c1e0b4 · moved to In Review'],
  ] },
  { name: 'codex', task: '#415', title: 'Paginate projects API', branch: 'feat/415-projects-pages', offset: 450, lines: [
    ['cmd', 'git worktree add ../wt/415 -b feat/415-projects-pages'],
    ['out', "Preparing worktree (new branch 'feat/415-projects-pages')", 500],
    ['cmd', 'codex "cursor pagination for GET /projects"'],
    ['out', '● Reading api/routes/projects.go', 800],
    ['out', '● Reading api/store/page.go', 600],
    ['out', '● Editing api/routes/projects.go', 500],
    ['add', '+ cursor := r.URL.Query().Get("cursor")'],
    ['add', '+ rows, next := store.Page(ctx, cursor, 50)'],
    ['add', '+ w.Header().Set("X-Next-Cursor", next)', 700],
    ['cmd', 'go test ./api/...'],
    ['dim', '=== RUN   TestProjectsPage', 1100],
    ['ok', 'ok   api/routes  0.84s', 400],
    ['ok', '● Committed 2b8d911 · moved to In Review'],
  ] },
  { name: 'claude-2', task: '#418', title: 'Swarm empty state', branch: 'ui/418-swarm-empty', offset: 200, lines: [
    ['cmd', 'git worktree add ../wt/418 -b ui/418-swarm-empty'],
    ['out', "Preparing worktree (new branch 'ui/418-swarm-empty')", 500],
    ['cmd', 'claude "empty state for the swarm view"'],
    ['out', '● Reading web/src/swarm/SwarmView.tsx', 900],
    ['out', '● Creating web/src/swarm/EmptyState.tsx', 700],
    ['add', '+ export function EmptyState({ onSpawn }) {'],
    ['add', '+   return <Panel title="No sessions yet">'],
    ['add', '+     <Button onClick={onSpawn}>Spawn agent</Button>', 700],
    ['cmd', 'pnpm build'],
    ['dim', 'vite v6.0.3 building for production…', 1500],
    ['ok', '✓ built in 3.41s', 400],
    ['ok', '● Committed e40a5f2 · moved to In Review'],
  ] },
  { name: 'qa', task: '#420', title: 'Flaky login e2e', branch: 'fix/420-e2e-login', offset: 700, lines: [
    ['cmd', 'git worktree add ../wt/420 -b fix/420-e2e-login'],
    ['out', "Preparing worktree (new branch 'fix/420-e2e-login')", 500],
    ['cmd', 'claude "fix the flaky login e2e"'],
    ['out', '● Running e2e/login.spec.ts ×20', 1300],
    ['err', '✗ 3/20 failed · timeout waiting for "Unlock"', 700],
    ['out', '● Editing e2e/login.spec.ts', 500],
    ['add', '+ await expect(unlock).toBeEnabled()', 600],
    ['cmd', 'pnpm playwright test login --repeat-each 20'],
    ['dim', 'Running 20 tests using 4 workers', 1500],
    ['ok', '✓ 20 passed (9.8s)', 400],
    ['ok', '● Committed 91d3c7a · moved to In Review'],
  ] },
];

// ---- colour: the sixteen ANSI colours, as a real shell would print them ----
const C = {
  green: A.green, lgreen: A.brightGreen, red: A.brightRed, yellow: A.yellow, lyellow: A.brightYellow,
  blue: A.brightBlue, cyan: A.cyan, lcyan: A.brightCyan, magenta: A.magenta, lmagenta: A.brightMagenta,
  fg: A.foreground, bright: A.brightWhite, dim: A.brightBlack,
};
const seg = (text: string, color: string): Seg => ({ text, color });

function hl(text: string, rules: [RegExp, string][], base: string): Seg[] {
  const re = new RegExp(rules.map((r) => '(' + r[0].source + ')').join('|'), 'g');
  const out: Seg[] = [];
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!m[0].length) { re.lastIndex++; continue; }
    if (m.index > i) out.push(seg(text.slice(i, m.index), base));
    out.push(seg(m[0], rules[m.slice(1).findIndex((x) => x !== undefined)][1]));
    i = m.index + m[0].length;
  }
  if (i < text.length) out.push(seg(text.slice(i), base));
  return out;
}

const VERB: Record<string, string> = { Reading: C.blue, Editing: C.yellow, Creating: C.green, Running: C.magenta };

function colorize(type: Kind, text: string): Seg[] {
  switch (type) {
    case 'cmd': {
      const sp = text.indexOf(' ');
      return [seg(text.slice(0, sp), C.bright), ...hl(text.slice(sp), [[/"[^"]*"/, C.yellow], [/ --?[\w-]+/, C.cyan], [/[\w.~-]*\/[\w./-]*/, C.lcyan], [/\b\d+\b/, C.lmagenta]], C.fg)];
    }
    case 'out': {
      const m = text.match(/^● (\w+) (.*)$/);
      if (m) return [seg('● ', VERB[m[1]] || C.blue), seg(m[1] + ' ', C.bright), ...hl(m[2], [[/×\d+/, C.lmagenta], [/[\w./-]+\.\w+/, C.lcyan]], C.fg)];
      return hl(text, [[/'[^']*'/, C.cyan]], C.fg);
    }
    case 'add': return [seg('+', C.green), ...hl(text.slice(1), [[/'[^']*'|"[^"]*"/, C.yellow], [/\b(?:export|async|function|const|return|await|let)\b/, C.lmagenta], [/<\/?[A-Z]\w*|\/?>/, C.cyan], [/\b\w+(?=\()/, C.blue], [/:=/, C.lmagenta]], C.lgreen)];
    case 'del': return [seg(text, C.red)];
    case 'ok': return hl(text, [[/● Committed/, C.lgreen], [/\b[0-9a-f]{7}\b/, C.yellow], [/In Review/, C.blue], [/✓|\bok\b/, C.lgreen], [/\d+ passed/, C.lgreen], [/\([\d.]+s\)|[\d.]+s\b/, C.dim], [/api\/\w+/, C.lcyan]], C.fg);
    case 'err': return hl(text, [[/✗/, C.red], [/\d+\/\d+ failed/, C.red], [/"[^"]*"/, C.bright]], C.lyellow);
    default: return hl(text, [[/RUN|===/, C.cyan], [/v[\d.]+/, C.lmagenta], [/\/wt\/\d+/, C.lcyan]], C.dim);
  }
}

// The git-bash prompt, which is what Stack's terminals present.
const promptSegs = (path: string, branch: string) => [
  seg('dev@stack ', C.green), seg('MINGW64 ', C.magenta), seg(path + ' ', C.yellow), seg('(' + branch + ')', C.cyan),
];

const CHAR = 22; // ms per typed character

function schedule(a: Omit<Agent, 'sched' | 'end' | 'commit'>): Agent {
  let c = a.offset;
  let cmds = 0;
  const sched: Sched[] = [];
  for (const [type, text, wait] of a.lines) {
    if (type === 'cmd') {
      sched.push({ type: 'prompt', at: c, segs: cmds ? promptSegs('/wt/' + a.task.slice(1), a.branch) : promptSegs('~/stack', 'main') });
      cmds++;
    }
    sched.push({ type, text, at: c, segs: colorize(type, text) });
    c += type === 'cmd' ? text.length * CHAR + 380 : (wait || 260);
  }
  const commit = (a.lines[a.lines.length - 1][1].match(/Committed (\w+)/) || [])[1] || '';
  return { ...a, sched, end: c, commit };
}

const AGENTS = SCRIPT.map(schedule);

// ---- tmux layouts: [left, top, width, height] in % of the window ----
const LAYOUTS: number[][][] = [
  [],
  [[0, 0, 100, 100]],
  [[0, 0, 50, 100], [50, 0, 50, 100]],
  [[0, 0, 50, 100], [50, 0, 50, 50], [50, 50, 50, 50]],
  [[0, 0, 50, 50], [50, 0, 50, 50], [0, 50, 50, 50], [50, 50, 50, 50]], // select-layout tiled
];

const EXIT = 1000;
const RX = 30, RY = 22, CY = 44, W = 0.00022;
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const tmuxClock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}-${MON[d.getMonth()]}-${pad(d.getFullYear() % 100)}`;
const RULE = '─'.repeat(600);

type Line = { segs: Seg[]; cursor?: boolean; blink?: boolean };

export function SwarmDemo({ onClose, sessions = 4, speed = 1 }: { onClose: () => void; sessions?: 3 | 4; speed?: number }) {
  const [{ t, exitAt }, setClock] = useState<{ t: number; exitAt: number | null }>({ t: 0, exitAt: null });
  const raf = useRef(0);
  const exitRef = useRef<number | null>(null);
  const tRef = useRef(0);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const play = useCallback(() => {
    cancelAnimationFrame(raf.current);
    let last = performance.now();
    let now = 0;
    exitRef.current = null;
    const tick = (ts: number) => {
      now += (ts - last) * speed;
      last = ts;
      tRef.current = now;
      const ex = exitRef.current;
      if (ex != null && now - ex > EXIT) { closeRef.current(); return; }
      setClock({ t: now, exitAt: ex });
      raf.current = requestAnimationFrame(tick);
    };
    setClock({ t: 0, exitAt: null });
    raf.current = requestAnimationFrame(tick);
  }, [speed]);

  const close = useCallback(() => {
    if (exitRef.current == null) exitRef.current = tRef.current;
  }, []);

  useEffect(() => {
    play();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => { cancelAnimationFrame(raf.current); window.removeEventListener('keydown', onKey); };
  }, [play, close]);

  // ---- the timeline ----
  const n = sessions;
  const agents = AGENTS.slice(0, n);
  const spawnAt = (i: number) => 400 + i * 450;
  const workStart = spawnAt(n - 1) + 1100;
  const end = workStart + Math.max(...agents.map((a) => a.end));
  const minStart = end + 900;
  const orbitStart = minStart + 700;
  const done = t > minStart + 500;
  const ep = exitAt == null ? 0 : clamp((t - exitAt) / EXIT);
  const pull = easeInOut(clamp(ep / 0.55));
  const reveal = easeInOut(clamp((ep - 0.45) / 0.55));
  const blinkOn = Math.floor(t / 530) % 2 === 0;
  const local = t - workStart;

  const count = agents.filter((_, i) => t >= spawnAt(i)).length;
  const layout = LAYOUTS[count] || [];

  // The active pane follows the newest output, the way a watcher would
  // select-pane onto whatever just moved. Before work starts it is the
  // newest split, as tmux leaves it.
  let active = count - 1;
  let latest = -1;
  agents.forEach((a, i) => {
    const vis = a.sched.filter((l) => l.at <= local);
    if (vis.length && local < a.end && vis[vis.length - 1].at > latest) { latest = vis[vis.length - 1].at; active = i; }
  });

  const panes = agents.slice(0, count).map((a, i) => {
    const vis = local >= 0 ? a.sched.filter((l) => l.at <= local) : [];
    const status = local < a.offset ? 'spawning' : local < a.end ? 'working' : 'in review';
    const lines: Line[] = [{ segs: [seg('[stack] ', C.lgreen), seg(`attached ${a.name} · pane `, C.dim), seg('%' + i, C.lmagenta)] }];
    for (const l of vis) {
      if (l.type === 'prompt') { lines.push({ segs: l.segs }); continue; }
      let segs = l.segs;
      let cursor = false;
      if (l.type === 'cmd' && l.text) {
        let k = Math.floor((local - l.at) / CHAR);
        if (k < l.text.length) {
          cursor = true;
          segs = [];
          for (const s of l.segs) { if (k <= 0) break; segs.push(seg(s.text.slice(0, k), s.color)); k -= s.text.length; }
        }
        segs = [seg('$ ', C.fg), ...segs];
      }
      lines.push({ segs, cursor });
    }
    if (!lines[lines.length - 1].cursor) {
      const started = vis.some((l) => l.type === 'cmd');
      if (started && local < a.end) lines.push({ segs: [], cursor: true, blink: true });
      else lines.push(
        { segs: started ? promptSegs('/wt/' + a.task.slice(1), a.branch) : promptSegs('~/stack', 'main') },
        { segs: [seg('$ ', C.fg)], cursor: true, blink: true },
      );
    }
    const [left, top, width, height] = layout[i];
    return { a, i, lines, status, left, top, width, height };
  });

  const act = panes[active];
  // A separator is drawn by the pane to its right; it is green when either
  // pane it divides is the active one (tmux colours the active pane's edge).
  const sepActive = (p: typeof panes[number]) => p.i === active || (!!act &&
    Math.abs(act.left + act.width - p.left) < 0.01 && act.top < p.top + p.height && p.top < act.top + act.height);

  const tmuxOpacity = 1 - clamp((t - minStart) / 700);
  const showOrbit = t > minStart + 300;
  const base = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const angle = (i: number) => base(i) + Math.max(0, t - orbitStart) * W;
  const pulse = (t % 2400) / 2400;

  const narration = count < n || t < workStart - 500 ? `Spawning ${n} agents, one tmux pane each`
    : t < minStart ? 'Each agent works in its own git worktree'
    : !done ? 'Sessions closing'
    : `${n} branches ready for review`;

  return (
    <div className="swarm" style={{ opacity: Math.min(1, t / 250) * (1 - reveal) }} role="dialog" aria-label="How Stack works">
      <div className="swarm-head">
        <StackMark size={22} />
        <span className="swarm-head-name">Swarm</span>
        <span className="swarm-head-count">{count} sessions</span>
        <span className="swarm-head-narr" aria-live="polite">{narration}</span>
        {done && <button type="button" className="swarm-ghost" onClick={play}>Replay</button>}
        <button type="button" className="swarm-primary" onClick={close}>Back to sign in</button>
      </div>

      <div className="swarm-stage">
        <div className="swarm-term" style={{ opacity: tmuxOpacity, background: A.background, color: A.foreground, fontFamily: TERM_FONT }}>
          <div className="swarm-win">
            {panes.map((p) => {
              const on = p.i === active;
              const edge = on ? A.green : A.foreground;
              return (
                <div key={p.a.name} className="swarm-pane"
                  style={{ left: p.left + '%', top: p.top + '%', width: p.width + '%', height: p.height + '%' }}>
                  {p.left > 0 && <div className="swarm-sep" style={{ color: sepActive(p) ? A.green : A.foreground }} />}
                  <div className="swarm-pane-main">
                    {/* pane-border-status top: '#{?pane_active,#[reverse],}#{pane_index}#[default] "#{pane_title}"' */}
                    <div className="swarm-rule" style={{ color: edge }}>
                      {'─'}
                      <span style={on ? { background: A.green, color: A.background } : undefined}>{p.i}</span>
                      <span style={{ color: on ? A.brightWhite : A.foreground }}>{` "${p.a.name} ${p.a.task} ${p.a.title}" `}</span>
                      <span style={{ color: p.status === 'in review' ? A.brightGreen : p.status === 'working' ? A.brightYellow : A.brightBlack }}>{`[${p.status}]`}</span>
                      {' '}{RULE}
                    </div>
                    <div className="swarm-body">
                      {p.lines.map((l, k) => (
                        <div key={k} className="swarm-line">
                          {l.segs.map((s, j) => <span key={j} style={{ color: s.color }}>{s.text}</span>)}
                          {l.cursor && on && (!l.blink || blinkOn) && <span className="swarm-cur" style={{ background: A.cursor }} />}
                          {'​'}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {/* tmux's default status line */}
          <div className="swarm-status" style={{ background: A.green, color: A.background }}>
            <span>{'[stack] 0:swarm*'}</span>
            <span className="swarm-status-fill" />
            <span>{`"${act ? `${act.a.name} ${act.a.task}` : 'stack'}" ${tmuxClock(new Date())}`}</span>
          </div>
        </div>

        {showOrbit && (
          <div className="swarm-orbit" onClick={close} title="Back to sign in" style={{ opacity: clamp((t - minStart - 300) / 600) }}>
            <div className="swarm-ring" />
            <div className="swarm-ring dashed" />
            <div className="swarm-logo" style={{ transform: `translate(-50%, -50%) scale(${1 + 0.12 * Math.sin(Math.PI * clamp(ep / 0.5)) - 0.33 * reveal})` }}>
              <div className="swarm-pulse" style={{ transform: `scale(${1 + pulse * 0.6})`, opacity: 1 - pulse }} />
              <StackMark size={96} />
            </div>
            <div className="swarm-ready" style={{ opacity: 1 - clamp(ep / 0.3) }}>
              <span className="swarm-ready-title">{n} branches ready for review</span>
              <span className="swarm-ready-commits">{agents.map((a) => a.commit).join(' · ')}</span>
              <span className="swarm-ready-back">Click to return to sign in</span>
            </div>
            {agents.map((a, i) => {
              const ang = angle(i) + pull * 1.2;
              const depth = (Math.sin(ang) + 1) / 2;
              const k = 1 - pull;
              return (
                <div key={a.name} className="swarm-chip" style={{
                  left: 50 + RX * k * Math.cos(ang) + '%',
                  top: CY + RY * k * Math.sin(ang) + '%',
                  transform: `translate(-50%, -50%) scale(${(0.82 + 0.18 * depth) * (1 - 0.7 * pull)})`,
                  opacity: clamp((t - minStart - i * 110 - 550) / 400) * (0.55 + 0.45 * depth) * (1 - clamp((ep - 0.25) / 0.3)),
                  zIndex: depth > 0.5 ? 60 : 10,
                }}>
                  <div className="swarm-chip-row">
                    <span className="swarm-dot" />
                    <span className="swarm-chip-name">{a.name}</span>
                    <span className="swarm-chip-task">{a.task}</span>
                    <span className="swarm-status-fill" />
                    <span className="swarm-chip-badge">in review</span>
                  </div>
                  <div className="swarm-chip-meta">
                    <span>⎇ {a.branch}</span>
                    <span className="swarm-chip-commit">{a.commit}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
