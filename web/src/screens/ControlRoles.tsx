import { useState } from 'react';
import { patchSettings, type ControlData, type FleetRoleAssignment, type FleetRoleModel, type FleetRoleWorth, type FleetEveryModel } from '../store';
import { FALLBACK_ADVISORS, FALLBACK_EXECUTORS, modelLabel } from '../lib/ui';
import { go } from '../lib/route';

// ---------------------------------------------------------------------------
// #281 (design 23b) — the ROLES room: roles across the fleet.
//
// The Now room's lanes (#280) answer "who is on this session". This room
// answers the fleet-wide question: which model is doing what, what the
// advisors are costing, and — the part that only exists because the two are
// kept separate — WHERE THE POLICY IS BEING IGNORED.
//
// That last one is the reason this room reads the run ledger instead of the
// settings. The policy is one pair of models in Settings; what actually ran is
// whatever each night's `model_usage` recorded. They diverge in ordinary ways
// (the policy changed after the runs; a host-side --executor-model override;
// an advisor configured but never actually consulted), and a screen that
// rendered the policy back at you would never show any of it.
//
// #288 (design 1b) — ORGANISED BY JOB, NOT BY MODEL. The room used to open on
// one card per model, then a table, then a worth panel and a share meter: four
// widgets from which you assembled the finding yourself. There are only ever
// two jobs — someone writes the code, someone reviews it before it lands — so
// the room now opens on exactly two cards, each stating its own disagreement
// between policy and runs, and each carrying the write that resolves it. The
// model-by-model view is still here, demoted to evidence under a fold: it
// answers "what did this cost", which is a second question and reads better
// as the receipt than as the headline.
// ---------------------------------------------------------------------------

const fmtUsd = (n: number) => (n >= 0.005 ? `$${n.toFixed(2)}` : n > 0 ? '<$0.01' : '$0.00');
const fmtTok = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
const pc = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

const ROLE_LABEL: Record<string, string> = { exec: 'EXEC', adv: 'ADV', '': 'OFF-POLICY' };

// What a drifting row says for itself. Deliberately explains the innocent
// causes too: most drift here is a policy that changed after the runs, not
// something going wrong, and calling that a fault would train the eye to
// ignore the row that actually matters.
const driftNote = (a: FleetRoleAssignment, advisorLabel: string): { text: string; tone: 'ok' | 'warn' | 'quiet' } => {
  if (a.drift === 'no-runs') {
    return { text: a.automode ? 'automode on · no runs this week' : 'no runs this week', tone: 'quiet' };
  }
  if (a.drift === 'off-policy') {
    return {
      text: `ran on ${a.driftModel} — neither current role names it`,
      tone: 'warn',
    };
  }
  if (a.drift === 'advisor-unused') {
    return {
      text: `${advisorLabel} configured but never consulted in ${plural(a.runs, 'run')}`,
      tone: 'warn',
    };
  }
  return { text: `matches the policy · last run ${a.lastRun}`, tone: 'ok' };
};

// The advisor card's paragraph. Arithmetic over the same runs, phrased as
// observation rather than conclusion — every branch names its own sample size,
// because at these run counts a landed-rate difference is a hint and not a
// finding, and the sentence should not pretend otherwise.
function advisorRead(w: FleetRoleWorth, days: number): string {
  const planRuns = w.planRuns ?? 0;
  const advisedPlan = w.advisedPlanRuns ?? 0;
  const cost = w.advCostUsd > 0
    ? ` The advice came to ${fmtUsd(w.advCostUsd)} — ${Math.round(w.advShare)}% of what was attributed this week, averaging ${fmtUsd(w.avgAdvPerRun)} on each run that used it.`
    : '';
  if (w.advisedRuns === 0 && w.plainRuns === 0) {
    // A week of nothing but plan nights is the case that used to read as an
    // idle advisor. It is the opposite: the advisor ran every one of them, and
    // there is simply no build to rate it against.
    if (advisedPlan > 0) {
      return `The advisor ran ${advisedPlan === planRuns ? 'every' : `${advisedPlan} of ${planRuns}`} `
        + `${plural(planRuns, 'plan night')} this week and no build night ran at all. A plan night writes a design and commits nothing, `
        + `so there is no landed rate to read here yet.${cost}`;
    }
    if (planRuns > 0) {
      return `The only runs in the last ${days} days were ${plural(planRuns, 'plan night')}, and none of them ran on the advisor — `
        + `with no advisor configured a plan night falls back to the executor model.`;
    }
    return `Nothing in the last ${days} days recorded a per-model breakdown, so there is no advised-versus-unadvised comparison to make yet.`;
  }
  const planNote = planRuns > 0
    ? ` ${plural(planRuns, 'plan night')} sat out — a plan night commits nothing by design, so it cannot land.`
    : '';
  if (w.advisedRuns === 0) {
    return `Every build run went with the executor working unadvised — and ${w.plainLanded} of ${w.plainRuns} landed clean. `
      + `${plural(w.plainRuns, 'run')} is too few to credit the absence of advice; treat it as a hint, not a result.${planNote}`;
  }
  if (w.plainRuns === 0) {
    return `Every build run this week was advised: ${w.advisedLanded} of ${w.advisedRuns} landed `
      + `(${pc(w.advisedLanded, w.advisedRuns)}%). There is no unadvised run to compare it against.${cost}${planNote}`;
  }
  return `${w.advisedLanded} of ${w.advisedRuns} advised ${w.advisedRuns === 1 ? 'run' : 'runs'} landed `
    + `(${pc(w.advisedLanded, w.advisedRuns)}%), against ${w.plainLanded} of ${w.plainRuns} unadvised `
    + `(${pc(w.plainLanded, w.plainRuns)}%).${cost}${planNote}`;
}

// The colour a model wears in the executor split. Role decides it — the model
// the policy names is the calm one, anything else is the accent — so the bar
// reads as compliance rather than as a palette you have to learn. Second and
// later off-policy models step down to the amber so they stay distinguishable
// without each claiming to be the headline.
const modelTone = (m: FleetRoleModel, offIndex: number) =>
  m.role === 'exec' ? 'var(--sage)' : offIndex === 0 ? 'var(--accent)' : 'var(--building)';

export function RolesRoom({ data, onReload, onConfigure }: {
  data: ControlData;
  onReload: () => void;
  onConfigure: () => void;
}) {
  const [evidence, setEvidence] = useState(true);
  const [busy, setBusy] = useState('');
  const roles = data.roles;
  const policy = data.fleet?.roles;
  const advisorLabel = policy?.advisor?.label ?? 'An advisor';
  const execCat = data.models?.executors ?? FALLBACK_EXECUTORS;
  const advCat = data.models?.advisors ?? FALLBACK_ADVISORS;

  // The one write this room makes. Both cards route through it so a failed
  // PATCH leaves the room showing what the ledger still says, never an
  // optimistic policy that was never saved.
  const setPolicy = async (patch: Record<string, string>, tag: string) => {
    setBusy(tag);
    try {
      await patchSettings(patch);
      onReload();
    } catch { /* the room re-reads on the next tick; a failed PATCH changes nothing */ }
    setBusy('');
  };

  if (!roles) {
    return (
      <div className="mc14-empty">
        This server has not sent the fleet roles block — it pre-dates #281. Redeploy the
        server and the room fills in from the run ledger that is already there.
      </div>
    );
  }

  const { models, assignments, worth } = roles;
  const drifting = assignments.filter((a) => a.drift && a.drift !== 'no-runs');
  const ranProjects = assignments.filter((a) => a.runs > 0);

  // Run-level counts (#288). A server that pre-dates them still knows how many
  // runs recorded a breakdown, but not how many of those runs were off-policy —
  // so the card says which MODELS were off-policy instead of inventing a count.
  const totalRuns = roles.runs ? roles.runs.total : worth.advisedRuns + worth.plainRuns;
  const offRuns = roles.runs ? roles.runs.offPolicy : null;
  const noBreakdown = roles.runs ? roles.runs.noBreakdown : 0;
  const planRuns = roles.runs?.plan ?? worth.planRuns ?? 0;

  // The receipt is the merged list where the server sends one, and the
  // autopilot-only list where it doesn't — an older server still renders
  // exactly what it always did rather than an empty panel.
  const manual = roles.manual;
  const evRows: FleetEveryModel[] = roles.everyModel
    ?? models.map((m) => ({ ...m, source: 'autopilot' as const, sessions: 0 }));
  // Only worth explaining the basis when the two populations are actually
  // mixed; on an autopilot-only week the cost column IS the basis.
  const mergedShares = evRows.some((m) => m.source !== 'autopilot')
    && evRows.some((m) => m.source !== 'manual');

  // The executor's slot: the model the policy names, plus anything that ran
  // that neither role claims. The advisor's models are a different job and sit
  // on the other card.
  const execModels = models.filter((m) => m.role === 'exec');
  const offModels = models.filter((m) => m.role === '');
  const advModels = models.filter((m) => m.role === 'adv');
  // Toned once, here, so the bar and its legend can never disagree about which
  // colour a model is wearing.
  let offSeen = -1;
  const execSlot = [...execModels, ...offModels].map((m) => {
    if (m.role === '') offSeen += 1;
    return { m, tone: modelTone(m, offSeen) };
  });
  const slotRuns = execSlot.reduce((n, e) => n + e.m.runs, 0);

  const offPolicy = offRuns != null ? offRuns > 0 : offModels.length > 0;
  const execState = totalRuns === 0 ? 'quiet' : offPolicy ? 'off' : 'ok';
  // Only ONE off-policy model can be offered for adoption without asking which:
  // two models both running outside the policy is a question, not a button.
  const adoptable = offModels.length === 1 && offModels[0].adoptExec ? offModels[0] : null;

  // A plan night counts as the advisor having been used — it is the one session
  // kind that runs on the advisor and nothing else, so a week of them is the
  // last thing that should wear an UNUSED badge.
  const advSeenRuns = worth.advisedRuns + (worth.advisedPlanRuns ?? 0);
  const advState = !policy?.advisor ? 'off' : advSeenRuns > 0 ? 'used' : 'unused';
  const advBasis = worth.costBasis ? fmtUsd(worth.totalCostUsd) : `${fmtTok(worth.advCostUsd > 0 ? worth.totalCostUsd : 0)} tokens`;
  const sampled = worth.advisedRuns + worth.plainRuns;

  return (
    <div className="mc-rolesroom">
      <div className="mc14-room-head">
        <span className="title">Roles</span>
        {ranProjects.length === 1 && <span className="mc-roleon">{ranProjects[0].name}</span>}
        <span className="meta">
          {totalRuns === 0
            ? `nothing recorded a per-model breakdown in ${roles.days} days`
            : `${plural(totalRuns, 'run')}${worth.costBasis ? ` · ${fmtUsd(worth.totalCostUsd)}` : ''} · last ${roles.days} days`}
        </span>
        <div style={{ flex: 1 }} />
        <button className="btn-repo sm" onClick={onConfigure}>Edit the policy</button>
      </div>

      {/* ---- two roles, two cards. Each owns its own disagreement and its own fix ---- */}
      <div className="mc-role2">

        {/* ===== executor ===== */}
        <div className={`mc-role2card exec ${execState}`}>
          <div className="cap">
            <span className="k">EXECUTOR · WRITES THE CODE</span>
            <span className={`tag ${execState}`}>
              {execState === 'quiet' ? 'NO RUNS' : execState === 'off' ? 'OFF POLICY' : 'ON POLICY'}
            </span>
          </div>

          <div className="read">
            <div className="side">
              <span className="lab">assigned</span>
              <span className="mdl">{policy ? policy.executor.label : '—'}</span>
            </div>
            <span className="arrow">→</span>
            <div className="side">
              {/* NOT "the executor ran on X". An unattributed model is by
                  definition one neither role claims, and which seat it sat in
                  is not recorded — the room's whole rule is that it does not
                  guess. So the label names the fact (the policy does not name
                  it) and the copy below carries the caveat. */}
              <span className="lab">{execState === 'off' ? 'not in the policy' : execState === 'ok' ? 'on policy' : 'recorded'}</span>
              <span className="big">
                {totalRuns === 0
                  ? 'no runs'
                  : offRuns != null
                    ? `${execState === 'off' ? offRuns : totalRuns - offRuns} of ${totalRuns} runs`
                    : execState === 'off'
                      ? `${plural(offModels.length, 'model')} off policy`
                      : `${plural(totalRuns, 'run')} clean`}
              </span>
            </div>
          </div>

          {execSlot.length > 0 ? (
            <div className="split">
              <div className="bar">
                {execSlot.map(({ m, tone }) => (
                  <i key={m.model} style={{ flex: Math.max(1, m.runs), background: tone }} />
                ))}
              </div>
              <div className="legend">
                {execSlot.map(({ m, tone }) => (
                  <span key={m.model} className={m.role === 'exec' ? 'on' : 'offp'}>
                    <i style={{ background: tone }} />
                    <b>{m.runs}</b> {m.label}
                    {m.costUsd > 0 && <em> · {fmtUsd(m.costUsd)}</em>}
                  </span>
                ))}
              </div>
              {/* The legend counts RUNS THAT USED each model, which can sum
                  past the run total — one run using two models is in both. Say
                  so once rather than let the arithmetic read as broken. */}
              {slotRuns > totalRuns && totalRuns > 0 && (
                <span className="foot">runs that used each model — one run can use several, so these sum past {totalRuns}</span>
              )}
            </div>
          ) : (
            <div className="bar empty" />
          )}

          <p className="copy">
            {execState === 'off'
              ? <>Usually innocent: the policy changed after those runs, or a session started on the host
                  with its own <code>--executor-model</code>. Which seat {offModels.length === 1 ? 'it' : 'they'} sat
                  in is not recorded — an unattributed model is exactly one neither role claims — but this is
                  still the only place a night quietly runs on the wrong model.</>
              : execState === 'ok'
                ? <>Every run that recorded a breakdown used the model the policy names. That is what
                    executed — not the setting read back to you.</>
                : <>No run in the last {roles.days} days recorded a per-model breakdown, so there is
                    nothing to hold the policy against yet.</>}
          </p>

          <div className="acts">
            {adoptable && (
              <button className="btn-accent sm" disabled={busy !== ''}
                onClick={() => void setPolicy({ autopilotExecutorModel: adoptable.adoptExec! }, 'adopt')}>
                {busy === 'adopt' ? 'Saving…' : `Adopt ${modelLabel(execCat, adoptable.adoptExec!)}`}
              </button>
            )}
            <button className="btn-repo sm" onClick={onConfigure}>
              {adoptable ? 'Keep the policy' : 'Change the executor'}
            </button>
            {execState === 'off' && !adoptable && offModels.length > 0 && (
              <span className="hint">
                {offModels.length > 1
                  ? `${offModels.length} models ran outside the policy — pick one by hand`
                  : `the executor catalogue names no ${offModels[0].label}`}
              </span>
            )}
          </div>
        </div>

        {/* ===== advisor ===== */}
        <div className={`mc-role2card adv ${advState}`}>
          <div className="cap">
            <span className="k">ADVISOR · REVIEWS BEFORE LANDING</span>
            <span className={`tag ${advState}`}>
              {advState === 'off' ? 'NONE SET' : advState === 'unused' ? 'UNUSED' : 'IN USE'}
            </span>
          </div>

          <div className="read">
            <div className="side">
              <span className="lab">assigned</span>
              <span className="mdl">{policy?.advisor ? policy.advisor.label : 'none'}</span>
            </div>
            <span className="arrow">→</span>
            <div className="side">
              <span className="lab">of the week's spend</span>
              <span className="big pct">{Math.round(worth.advShare)}%</span>
            </div>
          </div>

          <div className="split">
            <div className="bar">
              <i style={{ flex: Math.max(0.001, worth.advShare), background: 'var(--accent)' }} />
              <i style={{ flex: Math.max(0.001, 100 - worth.advShare), background: 'var(--line-3)' }} />
            </div>
            <div className="legend">
              <span className="offp">
                <i style={{ background: 'var(--accent)' }} />
                <b>{fmtUsd(worth.advCostUsd)}</b> advice
                {advModels.length > 0 && <em> · {advModels.map((m) => m.label).join(', ')}</em>}
              </span>
              <span className="on">
                <i style={{ background: 'var(--line-3)' }} />
                <b>{advBasis}</b> <em>attributed in all</em>
              </span>
            </div>
          </div>

          <p className="copy">{advisorRead(worth, roles.days)}</p>

          {sampled > 0 && sampled < 12 && (
            <div className="caveat">
              <span className="chip">SMALL SAMPLE</span>
              <span>{plural(sampled, 'run')} — revisit at ~12</span>
            </div>
          )}

          <div className="acts">
            {advState === 'off' ? (
              <button className="btn-accent sm" disabled={busy !== ''}
                onClick={() => void setPolicy({ autopilotAdvisorModel: 'claude-opus-5' }, 'adv-on')}>
                {busy === 'adv-on' ? 'Saving…' : `Turn on ${modelLabel(advCat, 'claude-opus-5')}`}
              </button>
            ) : (
              <>
                <button className="btn-repo sm" disabled={busy !== '' || policy?.advisor?.model === 'sonnet'}
                  onClick={() => void setPolicy({ autopilotAdvisorModel: 'sonnet' }, 'adv-son')}>
                  {busy === 'adv-son' ? 'Saving…' : 'Drop to Sonnet'}
                </button>
                <button className="btn-repo sm" disabled={busy !== ''}
                  onClick={() => void setPolicy({ autopilotAdvisorModel: '' }, 'adv-off')}>
                  {busy === 'adv-off' ? 'Saving…' : 'Advisor off'}
                </button>
              </>
            )}
            {/* Deliberately NOT called an allowance. Nothing enforces a ceiling —
                the runner has no advisor budget — so the meter above reports a
                cost, and the sentence says which way the buttons actually bite. */}
            <span className="hint">applies from the next session — nothing caps the spend</span>
          </div>
        </div>
      </div>

      {/* ---- evidence: what each model did. The receipt, not the headline ----
           Nights and the human's own sessions in ONE list, because "what ran
           this week" is one question. What does NOT merge is the judgement
           above: a manual row carries no role, so it is never toned or tagged
           as off-policy — the policy governs the autopilot, and a model picked
           by hand in a terminal was never under it. */}
      <div className="mc-roleev">
        <button className="evhead" onClick={() => setEvidence((v) => !v)}>
          <span className="tw">{evidence ? '▾' : '▸'}</span>
          <span className="k">EVERY MODEL THAT RAN</span>
          <span className="n">
            {evRows.length === 0 ? 'nothing recorded' : plural(evRows.length, 'model')}
            {manual && manual.sessions > 0 && ` · ${plural(manual.sessions, 'session')}`}
            {planRuns > 0 && ` · ${plural(planRuns, 'plan night')}`}
            {noBreakdown > 0 && ` · ${plural(noBreakdown, 'run')} recorded no breakdown`}
          </span>
        </button>
        {evidence && (evRows.length > 0 ? (
          <div className="evrows">
            {evRows.map((m) => {
              // Tone follows the ROLE for a night and the source for a session.
              // A manual row must not wear the amber the off-policy rows wear.
              const tone = m.source === 'manual' ? 'manual' : (m.role || 'other');
              return (
                <div className={`evr ${tone}`} key={m.model}>
                  <span className="sw" />
                  <span className="nm" title={m.model}>{m.label}</span>
                  <span className={`tag ${tone}`}>
                    {m.source === 'manual' ? 'MANUAL' : ROLE_LABEL[m.role]}
                  </span>
                  <span className="runs">
                    {m.runs > 0 ? plural(m.runs, 'run') : ''}
                    {m.runs > 0 && m.sessions > 0 ? ' · ' : ''}
                    {m.sessions > 0 ? `${m.sessions}s` : ''}
                  </span>
                  <div className="bar"><i className={tone} style={{ width: `${m.share}%` }} /></div>
                  <span className="pct">{Math.round(m.share)}%</span>
                  <span className="day">{fmtTok(m.todayTokens)} tok/24h</span>
                  {/* A transcript carries no cost, so a manual-only row shows
                      none rather than a zero that reads as "it was free". */}
                  <span className="cost">{m.costUsd > 0 ? fmtUsd(m.costUsd) : '—'}</span>
                  <span className="seen">{m.lastSeen}</span>
                </div>
              );
            })}
            {mergedShares && (
              <div className="evnote">
                Shares are token-based across both — a transcript records no cost, so it is
                the one basis a night and a session share.
              </div>
            )}
            {manual && manual.sessions > manual.sessionsWithUsage && (
              <div className="evnote">
                {plural(manual.sessions - manual.sessionsWithUsage, 'session')} of {manual.sessions} recorded
                no per-model breakdown — sessions from before the hook sent one, or whose
                transcript could not be read.
              </div>
            )}
          </div>
        ) : (
          <div className="mc14-quiet" style={{ padding: '4px 12px 12px' }}>
            Nothing in the last {roles.days} days recorded a per-model breakdown — no run, and no
            interactive session either. The breakdown arrives with each finished item and with
            each session the SessionEnd hook records.
          </div>
        ))}
      </div>

      {/* ---- delegations. A COUNT and never a cost: the parent transcript
           records the Agent call and its result but never the subagent's own
           usage, so there is nothing to price and the line says so. ---- */}
      {manual && manual.agentCalls > 0 && (
        <div className="mc-roledeleg">
          <span className="k">DELEGATED</span>
          <span className="v">
            {plural(manual.agentCalls, 'Agent call')} across {plural(manual.delegatedSessions, 'session')}
            {manual.agentTypes.length > 0 && ' — '}
            {manual.agentTypes.map((t, i) => (
              <span key={t.type}>
                {i > 0 && ', '}<b>{t.type}</b> ×{t.count}
              </span>
            ))}
          </span>
          <span className="hint">subagent tokens are not recorded in the transcript</span>
        </div>
      )}

      {/* ---- who is doing what: the policy beside what actually ran, per project ---- */}
      <div className="mc-roletable">
        <div className="head">
          <span className="title">Who is doing what</span>
          <span className="sub">what the runs actually used — not what the settings say</span>
          <div style={{ flex: 1 }} />
          <span className="policy">
            policy: {policy?.executor.label ?? '—'}
            {policy?.advisor ? ` → ${policy.advisor.label}` : ' · no advisor'}
          </span>
        </div>
        <div className="rows">
          {assignments.map((a) => {
            const note = driftNote(a, advisorLabel);
            return (
              <div className={`ra ${a.drift || 'ok'}`} key={a.slug}>
                <span className="dot" style={{ background: a.tint || 'var(--line-3)' }} />
                <button className="nm" onClick={() => go.detail(a.slug)}>{a.name}</button>
                <span className="mdl" title={a.execExtra > 0 ? `${a.execExtra} other executor model${a.execExtra === 1 ? '' : 's'} also ran here` : undefined}>
                  {a.exec || <em>—</em>}
                  {a.execExtra > 0 && <u>+{a.execExtra}</u>}
                </span>
                <span className={`mdl ${a.adv ? '' : 'quiet'}`} title={a.advExtra > 0 ? `${a.advExtra} other advisor model${a.advExtra === 1 ? '' : 's'} also ran here` : undefined}>
                  {a.adv || <em>none</em>}
                  {a.advExtra > 0 && <u>+{a.advExtra}</u>}
                </span>
                <span className={`note ${note.tone}`}>{note.text}</span>
                <span className="runs">{a.runs > 0 ? plural(a.runs, 'run') : ''}</span>
              </div>
            );
          })}
          {assignments.length === 0 && (
            <div className="mc14-quiet" style={{ padding: '10px 10px 4px' }}>
              No project is in automode and none has run this week — there are no assignments to show.
            </div>
          )}
        </div>
      </div>

      <div className="mc-rolenote">
        {drifting.length > 0
          ? `${plural(drifting.length, 'project')} above ${drifting.length === 1 ? 'does' : 'do'} not match the current policy. That is usually innocent — the policy changed after those runs, or a session was started on the host with its own --executor-model — but it is the only place you would ever see a night that quietly ran on the wrong model.`
          : 'Every project that ran this week used the models the policy names. Roles are recorded per run, so this comparison is against what actually executed, not against the settings read back to you.'}
      </div>
    </div>
  );
}
