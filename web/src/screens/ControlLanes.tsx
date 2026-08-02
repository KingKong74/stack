import { useState } from 'react';
import { go, hrefTo } from '../lib/route';
import { ConfirmModal } from '../components/ConfirmModal';
import { killDetachedSession, type ControlData, type FleetSlot, type AutopilotJob } from '../store';

// ---------------------------------------------------------------------------
// #283 (design 22a) — ONE LANE LIST over both sources.
//
// "What is running" used to be two widgets fed by two unrelated paths: the
// fleet strip (autopilot_jobs, polled with the control payload) and a chip
// strip of terminal sessions (the relay's live socket). Answering "what is
// happening right now" meant reading both and holding the union in your head.
//
// This is the union, as rows, sorted by who needs you. The sources stay
// honestly different where they ARE different — an autopilot lane can be
// attached only over tmux on the host, a terminal lane has no per-model record
// to put in the role column — and that difference is stated in the row rather
// than smoothed over into a uniform-looking list that lies about half of it.
// ---------------------------------------------------------------------------

const fmtTok = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M tok` : n >= 1000 ? `${Math.round(n / 1000)}k tok` : `${n} tok`;
const fmtUsd = (n: number) => (n >= 0.005 ? `$${n.toFixed(2)}` : n > 0 ? '<$0.01' : '$0.00');

const age = (startedAt: number) => {
  const min = Math.max(0, Math.round((Date.now() - startedAt) / 60_000));
  return min < 1 ? 'just opened' : min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`;
};
const homely = (cwd: string) => cwd.replace(/^\/home\/[^/]+\/?/, '') || '~';

// #280 — the read on one lane's role split: was the advice worth what it cost?
// Pure arithmetic over what the session has BANKED — no API, no model, and
// nothing asserted that the numbers don't already say. The order matters: a
// lane with no advisor, or nothing banked, has no split to judge, and saying so
// is more honest than rendering a 0% bar as if it were a finding.
const roleRead = (s: FleetSlot): { tag: string; tone: 'good' | 'warn' | 'quiet'; text: string } => {
  const banked = (s.spend ?? []).length > 0;
  if (!s.adv) {
    return {
      tag: 'SINGLE MODEL', tone: 'quiet',
      text: 'No advisor is configured, so nothing was consulted — every token on this lane is the executor\'s own.',
    };
  }
  if (!banked) {
    return {
      tag: 'NOTHING BANKED YET', tone: 'quiet',
      text: 'The first item is still in flight. A run row lands when an item finishes — that is when the split becomes real, and until then there is nothing to divide.',
    };
  }
  if (!s.advisorSeen) {
    return {
      tag: 'ADVISOR UNUSED', tone: 'warn',
      text: `${s.adv.label} is configured, but its model has not appeared in anything this session banked — the counsel is policy on paper, not in the work.`,
    };
  }
  const pct = Math.round(s.advShare ?? 0);
  const total = (s.execCostUsd ?? 0) + (s.advCostUsd ?? 0);
  const basis = total > 0 ? `of the ${fmtUsd(total)} banked` : 'of the tokens banked';
  if (pct >= 50) {
    return {
      tag: 'ADVICE HEAVY', tone: 'warn',
      text: `The advisor is ${pct}% ${basis} — counsel is costing more than the hands it is advising. Worth a cheaper advisor unless these sessions are genuinely getting stuck.`,
    };
  }
  if (pct >= 20) {
    return {
      tag: 'IN PROPORTION', tone: 'good',
      text: `The advisor is ${pct}% ${basis} — a strong mind consulted at the decisions, with the labour left to the cheap hands. That is the arrangement working.`,
    };
  }
  return {
    tag: 'CHEAP COUNSEL', tone: 'good',
    text: `The advisor is ${pct}% ${basis} — barely consulted. Cheap, but worth checking the executor actually asks when it gets stuck rather than guessing.`,
  };
};
export type LaneSort = 'needs' | 'newest';

type Origin = 'autopilot' | 'web' | 'detached';

interface Lane {
  key: string;
  origin: Origin;
  cls: string;            // extra row classes (claude / shell / away / …)
  name: string;
  where: string;
  phase: string;
  phaseTone: 'live' | 'warn' | 'quiet';
  tail: string;
  startedAt: number | null;
  elapsed: string;
  burn: string;
  burnTitle: string;
  // "who needs you" — lower sorts first. Documented at the sort itself.
  needs: number;
  attachHref: string | null;   // a real jump-in, when one exists
  attachLabel: string;
  tmuxHint: string;            // when the session is host-only, the command to reach it
  slug: string;
  slot?: FleetSlot;            // autopilot only — carries #280's roles + spend
  detachedName?: string;       // detached only — the kill target
  flag?: { text: string; tone: 'warn' | 'quiet' };
}

// The order is the argument the list makes, so it is worth stating: a claude
// session running on the host with NOBODY watching is the thing most likely to
// be stuck and waiting on a human — that is #121's whole rationale for the
// presence pill, applied to the ordering. An autopilot lane is unattended BY
// DESIGN, so it ranks below that. A session already open in a browser tab
// ranks last: you are, by definition, already there.
// (design 2a) The list is GROUPED BY PROJECT now — the grouping is the layout,
// not a sort option, because "how many sessions is this project running" is the
// first question a shared checkout raises and a flat list buries it. What the
// chips still choose is the order INSIDE a group, and the order of the groups
// themselves (a group leads with its most-needy lane).
const SORTS: { key: LaneSort; label: string; title: string }[] = [
  { key: 'needs', label: 'needs you', title: 'Unattended claude first (running with nobody watching), then the autopilot, then sessions you already have open. Shells last.' },
  { key: 'newest', label: 'newest', title: 'Most recently started first.' },
];

function buildLanes(data: ControlData): Lane[] {
  const projectNameOf = (cwd: string) => {
    const seg = homely(cwd).split('/')[0];
    return data.projects.find((p) => p.slug === seg)?.name ?? (seg === '~' ? 'home' : seg);
  };
  const slugOf = (cwd: string) => {
    const seg = homely(cwd).split('/')[0];
    return data.projects.some((p) => p.slug === seg) ? seg : '';
  };
  const lanes: Lane[] = [];

  // ---- autopilot workers -------------------------------------------------
  for (const s of data.fleet?.slots ?? []) {
    lanes.push({
      key: `job${s.jobId}`,
      origin: 'autopilot',
      cls: `auto ${s.sessionKind}`,
      name: s.name,
      where: s.branch || (s.kind === 'nightly' ? 'general night — no claim yet' : `${s.kind} job`),
      phase: s.status === 'claimed' ? 'STARTING' : 'RUNNING',
      phaseTone: 'live',
      tail: s.itemId
        ? `#${s.itemId} ${s.itemTitle || 'item'}`
        : s.kind === 'nightly' ? 'general night — picks as it goes' : `${s.kind} job`,
      startedAt: s.startedAt ? new Date(s.startedAt).getTime() : null,
      elapsed: s.since,
      burn: s.tokens > 0 ? fmtTok(s.tokens) : 'nothing banked',
      burnTitle: 'Tokens banked by items this session has already finished — the item in flight is not counted until it lands',
      needs: 2,
      // Autopilot sessions are NOT browser-attachable: the terminal daemon
      // advertises stack-term-* only, and these run in stack-auto-*.
      attachHref: null,
      attachLabel: '',
      tmuxHint: s.tmux,
      slug: s.slug,
      slot: s,
    });
  }

  // ---- terminal sessions attached in a browser ---------------------------
  for (const s of data.terminal?.sessions ?? []) {
    lanes.push({
      key: `sid${s.sid}`,
      origin: 'web',
      cls: s.cmd,
      name: projectNameOf(s.cwd),
      where: `~/${homely(s.cwd)}`,
      phase: s.cmd === 'claude' ? 'ATTACHED' : 'SHELL',
      phaseTone: s.cmd === 'claude' ? 'live' : 'quiet',
      tail: s.label || `${s.cmd} session, open in a tab`,
      startedAt: s.startedAt,
      elapsed: age(s.startedAt),
      burn: '—',
      burnTitle: 'Stack records no per-session token usage for terminal sessions — the meter on the Terminal screen is a daily total from the transcripts, not this session alone',
      needs: s.cmd === 'claude' ? 4 : 5,
      attachHref: hrefTo.terminal(s.cwd === '~' ? undefined : s.cwd, s.tmux || undefined),
      attachLabel: 'Jump in',
      tmuxHint: '',
      slug: slugOf(s.cwd),
    });
  }

  // ---- tmux survivors with no browser attached here ----------------------
  // A web session's own tmux name would double up with its row above.
  const webTmux = new Set((data.terminal?.sessions ?? []).map((s) => s.tmux).filter(Boolean));
  for (const d of data.terminal?.detached ?? []) {
    if (webTmux.has(d.name)) continue;
    lanes.push({
      key: `det${d.name}`,
      origin: 'detached',
      cls: d.attached ? 'away' : 'detached',
      name: projectNameOf(d.cwd || '~'),
      where: d.cwd ? `~/${d.cwd}` : '~',
      phase: d.attached ? 'ELSEWHERE' : 'UNATTENDED',
      phaseTone: d.attached ? 'quiet' : 'warn',
      tail: d.label || `claude running in tmux ${d.name}`,
      startedAt: d.created || null,
      elapsed: d.created ? age(d.created) : '—',
      burn: '—',
      burnTitle: 'Stack records no per-session token usage for terminal sessions',
      // Unattended ranks first; mirrored elsewhere is someone else's screen.
      needs: d.attached ? 3 : 1,
      attachHref: hrefTo.terminal(d.cwd || undefined, d.name),
      attachLabel: d.attached ? 'Mirror' : 'Jump in',
      tmuxHint: '',
      slug: slugOf(d.cwd || ''),
      detachedName: d.name,
      flag: d.attached
        ? { text: 'attached on another device', tone: 'quiet' }
        : { text: 'nobody watching', tone: 'warn' },
    });
  }
  return lanes;
}

const sortLanes = (lanes: Lane[], sort: LaneSort) => [...lanes].sort((a, b) =>
  sort === 'newest' ? (b.startedAt ?? 0) - (a.startedAt ?? 0)
  : a.needs - b.needs || (b.startedAt ?? 0) - (a.startedAt ?? 0));

// One entry per project with something running. A group leads with its most
// needy lane, so a project holding a blocked session sorts above one quietly
// working — the same ordering rule the lanes themselves use, one level up.
interface LaneGroup { key: string; slug: string; name: string; where: string; lanes: Lane[]; needs: number }
function groupLanes(lanes: Lane[]): LaneGroup[] {
  const groups = new Map<string, LaneGroup>();
  for (const l of lanes) {
    const key = l.slug || l.name;
    if (!groups.has(key)) {
      groups.set(key, { key, slug: l.slug, name: l.name, where: l.where, lanes: [], needs: 9 });
    }
    const g = groups.get(key)!;
    g.lanes.push(l);
    g.needs = Math.min(g.needs, l.needs);
    // The shortest path in the group is the checkout they share; a worktree
    // hanging off it is deeper and would misdescribe the rest.
    if (l.where && l.where.length < g.where.length) g.where = l.where;
  }
  return [...groups.values()].sort((a, b) => a.needs - b.needs || a.name.localeCompare(b.name));
}

export function SessionLanes({ data, labelBusy, onLabel, onConfigureRoles, onReload }: {
  data: ControlData;
  labelBusy: boolean;
  onLabel: () => void;
  onConfigureRoles: () => void;
  onReload: () => void;
}) {
  const [sort, setSort] = useState<LaneSort>('needs');
  const [open, setOpen] = useState('');
  const [killing, setKilling] = useState<string | null>(null);
  // Copy-to-clipboard state for the tmux attach command, keyed by lane —
  // several lanes can be expanded at once, so a single boolean would light up
  // the wrong one. A '!' prefix marks a failed copy.
  const [copied, setCopied] = useState('');
  // Which project groups are folded away. Names, not indexes — a group that
  // finishes and disappears must not fold whichever one takes its place.
  const [shut, setShut] = useState<Set<string>>(() => new Set());

  const lanes = sortLanes(buildLanes(data), sort);
  const groups = groupLanes(lanes);
  const capacity = data.fleet?.capacity ?? 1;
  const autoLanes = lanes.filter((l) => l.origin === 'autopilot').length;
  // #268's contract survives the merge: idle autopilot capacity is RENDERED,
  // never omitted — an empty slot has to read as idle, not as absent. Terminal
  // sessions have no capacity to be idle against, so they add no slots.
  const idle = Math.max(0, capacity - autoLanes);

  // What is behind the lanes: queued autopilot work. Paused/limit-held jobs
  // keep their own strip (#142) — they have controls these rows do not.
  const queued = data.jobs.filter((j) => j.status === 'queued'
    && !(j.kind === 'resume' && j.notBefore));

  const unattended = lanes.filter((l) => l.origin === 'detached' && !l.flag?.text.includes('another')).length;

  const doKill = async () => {
    const name = killing;
    setKilling(null);
    if (!name) return;
    try { await killDetachedSession(name); } finally { onReload(); }
  };

  // The reachable version of "deep-link to its tmux session": there is
  // nothing in the browser to attach to (stack-auto-* is host-only), so a
  // click copies the command instead, ready to paste into an ssh session.
  const copyTmux = async (key: string, cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(key);
    } catch {
      setCopied(`!${key}`);
    }
    setTimeout(() => setCopied((cur) => (cur === key || cur === `!${key}` ? '' : cur)), 1500);
  };

  return (
    <div className="mc-fleet" aria-label="Running sessions">
      {killing && (
        <ConfirmModal
          title={`Kill ${killing}?`}
          danger
          confirmLabel="Kill the session"
          onCancel={() => setKilling(null)}
          onConfirm={() => void doKill()}
          body={<>This ends the claude process on the host. Anything it has not committed is lost,
            and a session attached on another device will drop too. The daemon refuses names that
            are not actually detached, so a session someone is watching here cannot be killed this way.</>}
        />
      )}

      <div className="mc-fleet-head">
        <span className="cap">SESSIONS</span>
        <span className="hair" />
        <span className="sum">
          {lanes.length === 0
            ? `nothing running · ${capacity} autopilot slot${capacity === 1 ? '' : 's'} idle`
            : `${lanes.length} live · ${groups.length} project${groups.length === 1 ? '' : 's'} · ${autoLanes} of ${capacity} autopilot slot${capacity === 1 ? '' : 's'}${unattended > 0 ? ` · ${unattended} unattended` : ''}`}
        </span>
        <span className="mc-lane-sorts" role="tablist" aria-label="Sort the lanes">
          {SORTS.map((s) => (
            <button key={s.key} role="tab" aria-selected={sort === s.key} title={s.title}
              className={`mc14-filter ${sort === s.key ? 'on' : ''}`} onClick={() => setSort(s.key)}>
              {s.label}
            </button>
          ))}
        </span>
        <button className="btn-repo sm" onClick={onLabel} disabled={labelBusy}
          title="Ask Gemini again what each running terminal session is doing">
          {labelBusy ? 'Labelling…' : '✧ Re-label'}
        </button>
      </div>

      {/* #280's role policy, still stated once — it governs the autopilot lanes */}
      {data.fleet?.roles && autoLanes > 0 && (
        <div className="mc-roles" aria-label="Session roles">
          <span className="cap">ROLES</span>
          <span className="mc-role-chip exec">
            <em>EXEC</em><b>{data.fleet.roles.executor.label}</b><i>runs the session · owns every commit</i>
          </span>
          {data.fleet.roles.advisor ? (
            <span className="mc-role-chip adv">
              <em>ADV</em><b>{data.fleet.roles.advisor.label}</b><i>read-only counsel</i>
            </span>
          ) : (
            <span className="mc-role-chip off"><em>ADV</em><b>Off</b><i>nothing is consulted</i></span>
          )}
          <div style={{ flex: 1 }} />
          <span className="note">autopilot lanes only — terminal sessions run on whatever your CLI is set to</span>
        </div>
      )}

      <div className="mc-fleet-lanes">
        {/* (design 2a) The column header. Four words above a table of rows is
            the cheapest way to make a dense list readable, and this list had
            grown dense enough to need it. */}
        {groups.length > 0 && (
          <div className="lane-cols" aria-hidden>
            <span>project</span><span>doing</span><span>age</span><span />
          </div>
        )}
        {groups.map((g) => {
          const shutG = shut.has(g.key);
          // What this project's group is dealing with, in the header rather
          // than only inside the rows: a blocked session and a file collision
          // are the two facts you would collapse the group and miss.
          const blockedN = (data.attention ?? [])
            .filter((a) => a.kind === 'permission' && (a.slug || a.name) === (g.slug || g.name)).length;
          const clashN = (data.conflicts ?? []).filter((c) => c.slug === g.slug).length;
          const branches = data.projects.find((p) => p.slug === g.slug)?.live?.branches ?? [];
          const summary = [
            blockedN > 0 && `${blockedN} blocked`,
            clashN > 0 && `${clashN} conflict${clashN === 1 ? '' : 's'}`,
            branches.join(' · '),
          ].filter(Boolean).join(' · ');
          return (
        <div className={`lane-group${shutG ? ' shut' : ''}`} key={g.key}>
          <div className="lane-grouphead" role="button" tabIndex={0} aria-expanded={!shutG}
            onClick={() => setShut((cur) => {
              const next = new Set(cur);
              if (next.has(g.key)) next.delete(g.key); else next.add(g.key);
              return next;
            })}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}>
            <span className="caret" aria-hidden>{shutG ? '▸' : '▾'}</span>
            <span className="nm">{g.name}</span>
            <span className="x">×{g.lanes.length}</span>
            <span className="path" title={g.where}>{g.where}</span>
            <span className={`sum${blockedN || clashN ? ' flag' : ''}`}>{summary}</span>
            <span className="act">{shutG ? 'Expand' : 'Collapse'}</span>
          </div>
        {!shutG && g.lanes.map((l) => {
          const isOpen = open === l.key;
          const s = l.slot;
          const spend = s?.spend ?? [];
          const execShare = spend.filter((m) => m.role === 'exec').reduce((n, m) => n + m.share, 0);
          const advSh = s?.advShare ?? 0;
          const other = Math.max(0, 100 - execShare - advSh);
          const toggle = () => setOpen(isOpen ? '' : l.key);
          return (
            <div key={l.key} className={`mc-lane ${l.cls}${isOpen ? ' open' : ''}`}>
              <div className="lane-head" role="button" tabIndex={0} aria-expanded={isOpen}
                onClick={toggle}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}>
                <span className={`tintdot ${l.origin}`} style={l.slot?.tint ? { background: l.slot.tint } : undefined} />
                <span className="who">
                  <b>{l.name}</b>
                  <i title={l.where}>{l.where}</i>
                </span>

                {/* the role column — real for autopilot, honestly empty otherwise */}
                <span className="lane-roles">
                  {s ? (<>
                    <span className="r"><em className="tag exec">EXEC</em><span className="m">{s.exec?.label ?? '—'}</span></span>
                    <span className={`r ${s.adv ? (s.advisorSeen ? '' : 'idle') : 'off'}`}>
                      <em className={`tag adv${s.adv ? (s.advisorSeen ? '' : ' idle') : ' off'}`}>ADV</em>
                      <span className="m">{s.adv ? s.adv.label : 'none'}</span>
                    </span>
                  </>) : (
                    <span className="r none"
                      title="Stack records no per-model usage for terminal sessions — there is no run ledger behind them, so the roles are genuinely unknown rather than empty.">
                      no model record
                    </span>
                  )}
                </span>

                <span className={`state ${l.phaseTone}`}>{l.phase}</span>

                <span className="lane-tail">
                  {/* #268's fleet strip already names the item a slot is building;
                     naming it isn't enough on its own, so an occupied slot's item
                     is also the deep-link to that roadmap row. A general night
                     with no claim yet has no item to link to, so it stays text. */}
                  <span className="what" title={s?.itemId ? `#${s.itemId} — open it on the roadmap` : l.tail}>
                    {s?.itemId ? (
                      <button className="link" onClick={(e) => { e.stopPropagation(); go.detail(s.slug, 'roadmap', s.itemId); }}>
                        {l.tail}
                      </button>
                    ) : l.tail}
                  </span>
                  {s ? (
                    <span className="split">
                      <span className="bar" aria-hidden>
                        <i className="ex" style={{ width: `${execShare}%` }} />
                        <i className="ad" style={{ width: `${advSh}%` }} />
                        <i className="ot" style={{ width: `${other}%` }} />
                      </span>
                      <span className="note">
                        {spend.length === 0 ? 'nothing banked yet'
                          : advSh > 0 ? `advice ${Math.round(advSh)}% of ${fmtUsd((s.execCostUsd ?? 0) + (s.advCostUsd ?? 0))}`
                          : 'all executor'}
                      </span>
                    </span>
                  ) : l.flag && (
                    <span className="split"><span className={`note ${l.flag.tone}`}>{l.flag.text}</span></span>
                  )}
                </span>

                <span className="lane-burn">
                  <b>{l.elapsed}</b>
                  <i title={l.burnTitle}>{l.burn}</i>
                </span>

                <span className="lane-go" onClick={(e) => e.stopPropagation()}>
                  {l.attachHref && <a className="btn-repo sm" href={l.attachHref}>{l.attachLabel}</a>}
                  {l.detachedName && !l.flag?.text.includes('another') && (
                    <button className="mc-lane-kill" title={`Kill this session on the host (tmux ${l.detachedName})`}
                      onClick={() => setKilling(l.detachedName!)}>×</button>
                  )}
                </span>
                <span className="caret" aria-hidden>{isOpen ? '▾' : '▸'}</span>
              </div>

              {isOpen && (
                <div className="lane-body">
                  {s ? (<>
                    {/* #280's role panel, unchanged for autopilot lanes */}
                    <div className="lane-ledger">
                      <span className="cap">ROLE LEDGER</span>
                      {(s.ledger ?? []).map((e, i) => (
                        <div className="lx" key={`${e.itemId}·${i}`}>
                          <span className="at">{e.when}</span>
                          <span className="tags">
                            {e.models.length > 0 ? e.models.map((m) => (
                              <em key={m.model} className={`tag ${m.role || 'other'}`}
                                title={`${m.label} — ${fmtTok(m.tokens)}${m.costUsd > 0 ? ` · ${fmtUsd(m.costUsd)}` : ''}`}>
                                {m.role === 'adv' ? 'ADV' : m.role === 'exec' ? 'EXEC' : '?'}
                              </em>
                            )) : <em className="tag other">—</em>}
                          </span>
                          <span className="what">
                            {e.itemId ? (
                              <button className="link" onClick={() => go.detail(s.slug, 'roadmap', e.itemId)}>
                                #{e.itemId} {e.itemTitle || 'item'}
                              </button>
                            ) : <span className="plain">{e.itemTitle || 'an item'}</span>}
                            <i>{e.outcome} · {fmtUsd(e.costUsd)}{e.advCostUsd > 0 && ` · advice ${fmtUsd(e.advCostUsd)}`}</i>
                          </span>
                        </div>
                      ))}
                      {(s.ledger ?? []).length === 0 && (
                        <div className="lane-none">
                          Nothing banked yet — a run row lands per finished item, so this session's
                          first item is still in flight.
                        </div>
                      )}
                      <div className="lane-spend">
                        <span className="cap">SPEND</span>
                        <span className="bar" aria-hidden>
                          {spend.map((m) => <i key={m.model} className={m.role || 'other'} style={{ width: `${m.share}%` }} />)}
                          {spend.length === 0 && <i className="none" style={{ width: '100%' }} />}
                        </span>
                        <span className="legend">
                          {spend.map((m) => (
                            <span className="sw" key={m.model}>
                              <i className={m.role || 'other'} />
                              <b>{m.label}</b>
                              <em>{m.costUsd > 0 ? fmtUsd(m.costUsd) : fmtTok(m.tokens)}</em>
                              {m.inferred && <u title="Inferred: the executor is on the CLI default and this was the only model running">inferred</u>}
                            </span>
                          ))}
                          {spend.length === 0 && <span className="sw quiet">no banked usage to split</span>}
                        </span>
                      </div>
                    </div>
                    <div className="lane-side">
                      {(() => {
                        // #280's read on the split — kept when the panel moved
                        // into the merged lane list.
                        const read = roleRead(s);
                        return (
                          <div className={`lane-read ${read.tone}`}>
                            <span className="tag">{read.tag}</span>
                            <span className="txt">{read.text}</span>
                          </div>
                        );
                      })()}
                      <div className="lane-read quiet">
                        <span className="tag">ON THE HOST</span>
                        <span className="txt">
                          Autopilot sessions are not attachable from the browser — the terminal daemon
                          carries <code>stack-term-*</code> only. Watch this one over ssh:
                        </span>
                        {l.tmuxHint && (() => {
                          const cmd = `tmux attach -t ${l.tmuxHint}`;
                          const isCopied = copied === l.key;
                          const isFailed = copied === `!${l.key}`;
                          return (
                            <button type="button"
                              className={`tmux${isCopied ? ' ok' : ''}${isFailed ? ' fail' : ''}`}
                              title="Copy this command — autopilot sessions live on the host, not in the browser"
                              onClick={() => void copyTmux(l.key, cmd)}>
                              {isCopied ? 'copied' : isFailed ? 'could not copy — select it by hand' : cmd}
                            </button>
                          );
                        })()}
                      </div>
                      <div className="lane-acts">
                        <button className="btn-repo sm" onClick={onConfigureRoles}>Change the roles</button>
                        <button className="btn-repo sm" onClick={() => go.detail(l.slug)}>Open project</button>
                      </div>
                    </div>
                  </>) : (
                    // A terminal session. Stack keeps no action log for one, and
                    // the design's LAST FIVE ACTIONS has nothing behind it here —
                    // so the panel says what it knows and names what it does not.
                    <>
                      <div className="lane-ledger">
                        <span className="cap">THIS SESSION</span>
                        <div className="lane-facts">
                          <div><span>where</span><b>{l.where}</b></div>
                          <div><span>started</span><b>{l.startedAt ? new Date(l.startedAt).toLocaleString() : 'unknown'}</b></div>
                          <div><span>state</span><b>{l.phase.toLowerCase()}</b></div>
                          {l.detachedName && <div><span>tmux</span><b>{l.detachedName}</b></div>}
                        </div>
                        <div className="lane-none">
                          Stack records no action log and no token usage for a terminal session — the
                          relay carries its output, not its history. The line above the fold is
                          Gemini's read of the recent output, refreshed by ✧ Re-label.
                        </div>
                      </div>
                      <div className="lane-side">
                        <div className="lane-acts">
                          {l.attachHref && <a className="btn-repo sm" href={l.attachHref}>{l.attachLabel}</a>}
                          {l.slug && <button className="btn-repo sm" onClick={() => go.detail(l.slug)}>Open project</button>}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
        </div>
          );
        })}

        {Array.from({ length: idle }, (_, i) => (
          <div className="mc-lane idle" key={`idle${i}`}>
            <div className="lane-head">
              <span className="tintdot idle" />
              <span className="who">
                <b className="quiet">Autopilot slot {autoLanes + i + 1}</b>
                <i>nothing in flight</i>
              </span>
              <div style={{ flex: 1 }} />
              <span className="state quiet">IDLE</span>
            </div>
          </div>
        ))}

        {lanes.length === 0 && idle === 0 && (
          <div className="mc14-quiet">Nothing is running, and the fleet has no slots configured.</div>
        )}

        {/* queued behind the lanes */}
        {queued.length > 0 && (<>
          <div className="mc-lane-queuedhead">
            <span className="cap">QUEUED BEHIND THE LANES</span>
            <span className="hair" />
          </div>
          {queued.map((j: AutopilotJob) => (
            <div className="mc-lane queued" key={j.id}>
              <div className="lane-head">
                <span className="tintdot queued" />
                <span className="who">
                  <b className="quiet">{j.name}</b>
                  <i>{j.itemId ? `#${j.itemId} ${j.itemTitle || 'item'}` : `${j.kind} job`}</i>
                </span>
                <span className="lane-tail">
                  <span className="what quiet">
                    {autoLanes >= capacity
                      ? 'waiting for a slot — the dispatcher runs one job at a time'
                      : 'queued — the host picks it up within a minute'}
                  </span>
                </span>
                <span className="lane-burn"><b>{j.when}</b></span>
              </div>
            </div>
          ))}
        </>)}
      </div>

      <div className="mc-lane-note">
        One list over both sources: the autopilot's own workers and every terminal session the host
        daemon can see — web tabs, tmux survivors, and sessions attached from another device. They
        differ where they really differ: an autopilot lane carries its role split and is reachable
        only over tmux on the host, a terminal lane can be jumped into but has no model record behind it.
      </div>
    </div>
  );
}
