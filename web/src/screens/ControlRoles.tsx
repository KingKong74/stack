import { patchSettings, type ControlData, type FleetRoleAssignment, type FleetRoleWorth } from '../store';
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
// ---------------------------------------------------------------------------

const fmtUsd = (n: number) => (n >= 0.005 ? `$${n.toFixed(2)}` : n > 0 ? '<$0.01' : '$0.00');
const fmtTok = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

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
      text: `${advisorLabel} configured but never consulted in ${a.runs} run${a.runs === 1 ? '' : 's'}`,
      tone: 'warn',
    };
  }
  return { text: `matches the policy · last run ${a.lastRun}`, tone: 'ok' };
};

// The "was the advice worth it" lines. Arithmetic over the same runs, phrased
// as observation rather than conclusion — with the sample size on the face of
// it, because at these run counts a landed-rate difference is a hint and not a
// finding, and the line should not pretend otherwise.
const worthLines = (w: FleetRoleWorth, days: number): { tag: string; tone: 'good' | 'warn' | 'quiet'; text: string }[] => {
  const out: { tag: string; tone: 'good' | 'warn' | 'quiet'; text: string }[] = [];
  const rate = (landed: number, runs: number) => (runs > 0 ? Math.round((landed / runs) * 100) : 0);
  if (w.advisedRuns === 0 && w.plainRuns === 0) {
    return [{
      tag: 'NO DATA', tone: 'quiet',
      text: `Nothing in the last ${days} days recorded a per-model breakdown, so there is no advised-versus-unadvised comparison to make yet.`,
    }];
  }
  if (w.advisedRuns > 0) {
    out.push({
      tag: 'ADVISED', tone: 'good',
      text: `${w.advisedLanded} of ${w.advisedRuns} run${w.advisedRuns === 1 ? '' : 's'} landed (${rate(w.advisedLanded, w.advisedRuns)}%) when the advisor was actually consulted.`,
    });
  }
  if (w.plainRuns > 0) {
    out.push({
      tag: 'ALONE', tone: 'quiet',
      text: `${w.plainLanded} of ${w.plainRuns} run${w.plainRuns === 1 ? '' : 's'} landed (${rate(w.plainLanded, w.plainRuns)}%) with the executor working unadvised.`,
    });
  }
  if (w.advCostUsd > 0) {
    out.push({
      tag: 'COST', tone: 'quiet',
      text: `The advice came to ${fmtUsd(w.advCostUsd)} — ${Math.round(w.advShare)}% of the ${fmtUsd(w.totalCostUsd)} attributed this week, averaging ${fmtUsd(w.avgAdvPerRun)} on each run that used it.`,
    });
  }
  // The honest caveat, and it is not decoration: two handfuls of nights cannot
  // separate the advisor's effect from which items happened to be easy.
  const n = w.advisedRuns + w.plainRuns;
  if (n < 12) {
    out.push({
      tag: 'CAVEAT', tone: 'warn',
      text: `${n} run${n === 1 ? '' : 's'} is too few to attribute the difference to the advice — the items each night were not the same difficulty. Read it as a hint, and let it accumulate.`,
    });
  }
  return out;
};

export function RolesRoom({ data, onReload, onConfigure }: {
  data: ControlData;
  onReload: () => void;
  onConfigure: () => void;
}) {
  const roles = data.roles;
  const policy = data.fleet?.roles;
  const advisorLabel = policy?.advisor?.label ?? 'An advisor';

  const setAdvisor = async (model: string) => {
    try {
      await patchSettings({ autopilotAdvisorModel: model });
      onReload();
    } catch { /* the room re-reads on the next tick; a failed PATCH changes nothing */ }
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
  const lines = worthLines(worth, roles.days);

  return (
    <div className="mc-rolesroom">
      <div className="mc14-room-head">
        <span className="title">Roles</span>
        <span className="meta">
          {models.length === 0
            ? `nothing recorded a per-model breakdown in ${roles.days} days`
            : `${models.length} model${models.length === 1 ? '' : 's'} across ${assignments.filter((a) => a.runs > 0).length} project${assignments.filter((a) => a.runs > 0).length === 1 ? '' : 's'} · last ${roles.days} days`}
        </span>
        <div style={{ flex: 1 }} />
        <button className="btn-repo sm" onClick={onConfigure}>Edit the policy</button>
      </div>

      {/* ---- the model cards: which model is doing what ---- */}
      {models.length > 0 ? (
        <div className="mc-rolecards">
          {models.map((m) => (
            <div className={`mc-rolecard ${m.role || 'other'}`} key={m.model}>
              <div className="top">
                <span className={`sw ${m.role || 'other'}`} />
                <span className="nm" title={m.model}>{m.label}</span>
                <span className={`tag ${m.role || 'other'}`}>{ROLE_LABEL[m.role]}</span>
              </div>
              <div className="big">
                <b>{m.runs}</b>
                <span>run{m.runs === 1 ? '' : 's'} used it</span>
              </div>
              <div className="line">
                <span className="k">last 24h</span>
                <span className="v">{fmtTok(m.todayTokens)} tok</span>
                <span className="c">{m.todayCostUsd > 0 ? fmtUsd(m.todayCostUsd) : '—'}</span>
              </div>
              <div className="bar"><i className={m.role || 'other'} style={{ width: `${m.share}%` }} /></div>
              <span className="note">
                {Math.round(m.share)}% of the week{m.costUsd > 0 ? ` · ${fmtUsd(m.costUsd)}` : ''} · last seen {m.lastSeen}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="mc14-empty">
          No run in the last {roles.days} days recorded a per-model breakdown, so there is
          nothing to attribute yet. The breakdown arrives with each finished item — one
          night's runs will fill this in.
        </div>
      )}

      {/* ---- who is doing what: the policy beside what actually ran ---- */}
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
                <span className="runs">{a.runs > 0 ? `${a.runs} run${a.runs === 1 ? '' : 's'}` : ''}</span>
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

      {/* ---- was the advice worth it · the advisor's share ---- */}
      <div className="mc-rolefoot">
        <div className="worth">
          <span className="cap">WAS THE ADVICE WORTH IT</span>
          {lines.map((l, i) => (
            <div className="wl" key={i}>
              <span className={`tag ${l.tone}`}>{l.tag}</span>
              <span className="t">{l.text}</span>
            </div>
          ))}
        </div>

        <div className="share">
          <span className="cap">ADVISOR SHARE</span>
          <div className="big">
            <b>{Math.round(worth.advShare)}%</b>
            <span>of the week's {worth.costBasis ? fmtUsd(worth.totalCostUsd) : `${fmtTok(worth.advCostUsd > 0 ? worth.totalCostUsd : 0)} tokens`}</span>
          </div>
          <div className="bar"><i style={{ width: `${Math.min(100, worth.advShare)}%` }} /></div>
          <span className="copy">
            {/* Deliberately NOT called an allowance. Nothing enforces a ceiling —
                the runner has no advisor budget — and a meter drawn as a cap
                would be inventing a control that does not exist. */}
            This is what the advisor actually cost, not a cap — nothing enforces a ceiling.
            The two controls below are the real ones: they change the policy from the next
            session onwards.
          </span>
          <div className="acts">
            <button className="btn-repo sm" disabled={policy?.advisor?.model === 'sonnet'}
              onClick={() => void setAdvisor('sonnet')}>
              Drop to Sonnet
            </button>
            <button className="btn-repo sm" disabled={!policy?.advisor}
              onClick={() => void setAdvisor('')}>
              Advisor off
            </button>
          </div>
        </div>
      </div>

      <div className="mc-rolenote">
        {drifting.length > 0
          ? `${drifting.length} project${drifting.length === 1 ? '' : 's'} above ${drifting.length === 1 ? 'does' : 'do'} not match the current policy. That is usually innocent — the policy changed after those runs, or a session was started on the host with its own --executor-model — but it is the only place you would ever see a night that quietly ran on the wrong model.`
          : 'Every project that ran this week used the models the policy names. Roles are recorded per run, so this comparison is against what actually executed, not against the settings read back to you.'}
      </div>
    </div>
  );
}
