import { useEffect, useState } from 'react';
import { getAgents, patchAgent, type TabAgent, type TabAgentKey, type TabAgentsData } from '../store';

// ---------------------------------------------------------------------------
// #361 — the AGENTS room: every agent, and the one place they are controlled
// from.
//
// Each is bound to exactly ONE surface — the Auditor to the Quality tab, the
// Curator to Roadmap, Polaris to Futures, and (#364, #375) the Merge agent and
// the Foreman to their Mission Control rooms — and that binding is the server's
// registry, not a setting. So this room deliberately does NOT offer to move an
// agent to another surface or to hand it another agent's ops: those are the
// restriction the feature is about, and a control that could edit them would
// be a control that could dissolve it. What the owner tunes is what an agent
// is LIKE — off or on, which model it thinks with, what standing steer it
// carries, and which of its own ops are live.
//
// The room reads its own data (like Review does) rather than riding the
// control payload: agent config is app-wide and changes only when someone
// changes it here, so folding it into the fleet poll would be a fetch per
// refresh for a row that almost never moves.
//
// One thing this screen must never do is imply an agent is working when it
// cannot: with the host daemon offline every switch here is honest but inert,
// and the header says so before any card claims otherwise. Same rule as a NULL
// review verdict — no pass ran is not "nothing found".
// ---------------------------------------------------------------------------

const relative = (iso: string | null): string => {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return 'never';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

export function AgentsRoom() {
  const [data, setData] = useState<TabAgentsData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');            // '<key>:<what>' while a write is in flight
  const [draft, setDraft] = useState<Record<string, string>>({});  // unsaved guidance, per agent

  const load = () => {
    getAgents()
      .then((d) => { setData(d); setError(''); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the agents.'));
  };
  useEffect(load, []);

  // Every write is the same shape: PATCH one agent, splice the row it returns
  // back in. The server is the authority on what the agent now looks like —
  // re-rendering from the response rather than from what we sent means a
  // rejected value (a model name that didn't validate) shows as rejected.
  const write = async (key: TabAgentKey, what: string, patch: Parameters<typeof patchAgent>[1]) => {
    setBusy(`${key}:${what}`);
    try {
      const updated = await patchAgent(key, patch);
      setData((d) => (d ? { ...d, agents: d.agents.map((a) => (a.key === key ? updated : a)) } : d));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That change did not save.');
    } finally {
      setBusy('');
    }
  };

  const liveCount = (data?.agents ?? []).filter((a) => a.enabled).length;

  return (
    <div className="mc-agentsroom">
      <div className="mc14-room-head">
        <span className="title">Agents</span>
        <span className="meta">
          {!data ? 'loading…' : `${liveCount} of ${data.agents.length} on · one per surface`}
        </span>
      </div>

      {error && <div className="mc-agerr">{error}</div>}

      {/* The frame, before any card: a key-less server runs no agent at all,
          whatever its switch says. Stated once, at the top, rather than three
          times as a badge that would read as three separate faults. */}
      {data && !data.hostReady && (
        <div className="mc-agnokey">
          <b>The host daemon is not connected.</b> These agents run Claude on the host — the same CLI
          the overnight autopilot uses — so the switches below still save, but nothing runs until the
          daemon is back: an agent that is <em>on</em> here is on and idle. The Auditor's deep-audit
          prompt is the one op that works regardless, because it asks no model at all — it composes
          the prompt for a Claude session you drive yourself.
        </div>
      )}

      {data && (
        <div className="mc-aglist">
          {data.agents.map((a) => (
            <AgentCard
              key={a.key}
              agent={a}
              models={data.models}
              defaultModel={data.defaultModel}
              hostReady={data.hostReady}
              busy={busy}
              draft={draft[a.key]}
              onDraft={(v) => setDraft((d) => ({ ...d, [a.key]: v }))}
              onWrite={write}
            />
          ))}
        </div>
      )}

      {data && (
        <p className="mc-agfoot">
          An agent works on its own surface and nowhere else — the binding is in the server's
          registry, not on this screen, so nothing here can hand one another's work. They all
          annotate only: what they return arrives as a suggestion the human keeps or drops. The
          Auditor's findings land in the review inbox rather than on the bug list, and the
          Foreman's call on a change is a recommendation — the verdict is still a press.
        </p>
      )}
    </div>
  );
}

function AgentCard({
  agent, models, defaultModel, hostReady, busy, draft, onDraft, onWrite,
}: {
  agent: TabAgent;
  models: { model: string; label: string }[];
  defaultModel: string;
  hostReady: boolean;
  busy: string;
  draft: string | undefined;
  onDraft: (v: string) => void;
  onWrite: (key: TabAgentKey, what: string, patch: Parameters<typeof patchAgent>[1]) => void;
}) {
  const [open, setOpen] = useState(false);
  const offOps = agent.ops.filter((o) => !o.enabled).length;
  const guidance = draft ?? agent.guidance;
  const dirty = guidance !== agent.guidance;
  const failing = agent.lastOutcome !== '' && agent.lastOutcome !== 'ok';

  return (
    <div className={`mc-agcard ${agent.enabled ? '' : 'off'}`}>
      <div className="cap">
        <span className="nm">{agent.name}</span>
        {/* The surface is the agent's identity, not a setting — so it reads as
            a fact on the card, and there is no control beside it. It is also
            not a link: a tab agent works on EVERY project's Quality tab, so a
            single destination would be a lie about which project it belongs to.
            #375 — and it says tab or ROOM, because two of these are bound to
            Mission Control rooms and "Merge tab" is not a screen. */}
        <span className="tab">{agent.tabLabel} {agent.surface ?? 'tab'}</span>
        <div style={{ flex: 1 }} />
        {agent.enabled && !hostReady && <span className="tag idle">IDLE</span>}
        {!agent.enabled && <span className="tag off">OFF</span>}
        <button
          role="switch"
          aria-checked={agent.enabled}
          aria-label={`${agent.name} on or off`}
          className={`switch sm ${agent.enabled ? 'on' : ''}`}
          disabled={busy === `${agent.key}:enabled`}
          onClick={() => onWrite(agent.key, 'enabled', { enabled: !agent.enabled })}
        >
          <span className="switch-knob" />
        </button>
      </div>

      <p className="blurb">{agent.blurb}</p>

      <div className="ledger">
        <span>{agent.runs === 0 ? 'never asked' : `${agent.runs} run${agent.runs === 1 ? '' : 's'}`}</span>
        {agent.runs > 0 && <span>· last {relative(agent.lastRunAt)}{agent.lastOp ? ` (${agent.lastOp})` : ''}</span>}
        {/* An agent that keeps failing says so here. The last outcome is kept
            verbatim: "quota used up for now" and "timed out" are different
            problems with different answers, and a green tick would hide both. */}
        {failing && <span className="bad">· last answer failed: {agent.lastOutcome}</span>}
        {offOps > 0 && <span className="quiet">· {offOps} op{offOps === 1 ? '' : 's'} switched off</span>}
      </div>

      <div className="tune">
        <label>
          <span className="k">Model</span>
          <select className="field-input sm" value={agent.model}
            disabled={busy === `${agent.key}:model`}
            onChange={(e) => onWrite(agent.key, 'model', { model: e.target.value })}>
            {models.map((m) => (
              <option key={m.model || 'default'} value={m.model}>
                {m.model === '' ? `${m.label} (${defaultModel})` : m.label}
              </option>
            ))}
            {/* A model set by hand (or by an older catalogue) stays selectable
                rather than silently snapping to the default on first render. */}
            {agent.model && !models.some((m) => m.model === agent.model) && (
              <option value={agent.model}>{agent.model}</option>
            )}
          </select>
        </label>
        <span className="why">
          Free-tier quotas are per model, so a heavy agent on its own model stops eating the others'.
        </span>
      </div>

      <div className="steer">
        <div className="k">Standing guidance</div>
        <textarea
          className="field-area sm"
          rows={2}
          placeholder={`What should the ${agent.name} always keep in mind? (e.g. "we run on mobile first — weigh small-screen breakage heavily")`}
          value={guidance}
          onChange={(e) => onDraft(e.target.value)}
        />
        <div className="row">
          <span className="why">Prefixed to every prompt this agent sends, in front of the op's own instructions.</span>
          <div style={{ flex: 1 }} />
          {dirty && (
            <>
              <button className="btn-repo sm" onClick={() => onDraft(agent.guidance)}>Discard</button>
              <button className="btn-accent sm" disabled={busy === `${agent.key}:guidance`}
                onClick={() => onWrite(agent.key, 'guidance', { guidance })}>
                {busy === `${agent.key}:guidance` ? 'Saving…' : 'Save guidance'}
              </button>
            </>
          )}
        </div>
      </div>

      <button className="mc-agops-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} what it may do ({agent.ops.length} op{agent.ops.length === 1 ? '' : 's'}
        {offOps > 0 ? `, ${offOps} off` : ''})
      </button>
      {open && (
        <div className="mc-agops">
          {agent.ops.map((o) => (
            <div key={o.op} className={`op ${o.enabled ? '' : 'off'}`}>
              <div className="txt">
                <div className="lb">
                  {o.label}
                  {/* The one op that asks no model is worth marking: it is why
                      the Auditor is still useful with the host offline. */}
                  {!o.needsModel && <span className="free">no model needed</span>}
                </div>
                <div className="hint">{o.hint}</div>
              </div>
              <button
                role="switch"
                aria-checked={o.enabled}
                aria-label={`${o.label} on or off`}
                className={`switch sm ${o.enabled ? 'on' : ''}`}
                disabled={busy === `${agent.key}:${o.op}`}
                onClick={() => onWrite(agent.key, o.op, { op: o.op, opEnabled: !o.enabled })}
              >
                <span className="switch-knob" />
              </button>
            </div>
          ))}
          <p className="scope">
            This list is the whole of what the {agent.name} can do. It is fixed by the server's
            registry: {agent.remit}. Anything outside that belongs to another agent.
          </p>
        </div>
      )}
    </div>
  );
}
