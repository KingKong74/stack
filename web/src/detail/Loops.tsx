// Real observation policies only. The existing dispatcher owns execution and
// all claim gates. Never present diagnostic output as a verdict or a fix.
import { useEffect, useState } from 'react';
import { createSpecialistLoop, evaluateSpecialistLoop, getAgentProfiles, getSpecialistLoops, getSpecialistRun, setSpecialistLoopEnabled } from '../store';
import type { SpecialistLoopPolicy, SpecialistRun } from '../store';
import type { AgentProfile } from '../types';
import { useAutoRefresh } from '../lib/autoRefresh';

export function Loops({ slug }: { slug: string }) {
  const [policies, setPolicies] = useState<SpecialistLoopPolicy[]>([]);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [profileKey, setProfileKey] = useState('');
  const [paths, setPaths] = useState('');
  const [interval, setIntervalMinutes] = useState(60);
  const [runs, setRuns] = useState(2);
  const [tokens, setTokens] = useState(150000);
  const [selected, setSelected] = useState('');
  const [base, setBase] = useState('');
  const [head, setHead] = useState('');
  const [evaluation, setEvaluation] = useState('');
  const [report, setReport] = useState<SpecialistRun | null>(null);
  const load = async () => {
    try { const rows = await getSpecialistLoops(slug); setPolicies(rows); setError(''); setLoaded(true); }
    catch (e) { setError((e as Error).message); }
  };
  useEffect(() => {
    let alive = true;
    setPolicies([]); setLoaded(false); setSelected(''); setReport(null); setEvaluation(''); setError('');
    Promise.all([getSpecialistLoops(slug), getAgentProfiles()]).then(([rows, room]) => {
      if (alive) { setPolicies(rows); setProfiles(room.profiles.filter(p => p.enabled && !['executor', 'stack-builder'].includes(p.key))); setLoaded(true); }
    }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [slug]);
  useAutoRefresh(() => { void load(); });
  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await fn(); } catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const policy = policies.find(p => String(p.id) === selected);
  return <section className="lp" aria-label="Observation loops">
    <header className="lp-head">
      <div className="lp-title"><h1>Observation loops</h1><span>Check new commits with a specialist, then leave the evidence for you.</span></div>
      <button className="lp-primary" onClick={() => setCreating(!creating)}>{creating ? 'Cancel new policy' : 'New observation policy'}</button>
    </header>
    <div className="lp-legend">New policies start disabled. Runs share the existing dispatcher, arm switch, quiet hours and claim gates. No tools, fixes, Ready changes or human verdicts.</div>
    {error && <p className="lp-loop-message" role="alert">{error}</p>}
    {creating && <form className="lp-detail lp-policy-form" onSubmit={e => { e.preventDefault(); void act(async () => {
      await createSpecialistLoop(slug, { name, profileKey, paths: paths.split('\n').map(p => p.trim()).filter(Boolean), intervalMinutes: interval, maxRunsDay: runs, maxTokensDay: tokens });
      setCreating(false); setName(''); await load();
    }); }}>
      <label>Policy name<input className="lp-text" required maxLength={120} value={name} onChange={e => setName(e.target.value)} /></label>
      <label>Specialist<select aria-label="Specialist profile" className="lp-select" required value={profileKey} onChange={e => setProfileKey(e.target.value)}><option value="">Choose a profile</option>{profiles.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}</select></label>
      <label>Literal file paths, one per line (optional, up to eight)<textarea className="lp-text" rows={3} value={paths} onChange={e => setPaths(e.target.value)} /></label>
      <label>Minimum minutes between passes<input className="lp-text" type="number" min={15} max={10080} required value={interval} onChange={e => setIntervalMinutes(Number(e.target.value))} /></label>
      <label>Maximum attempts in 24 hours<input className="lp-text" type="number" min={1} max={12} required value={runs} onChange={e => setRuns(Number(e.target.value))} /></label>
      <label>Token budget in 24 hours<input className="lp-text" type="number" min={1000} max={2000000} required value={tokens} onChange={e => setTokens(Number(e.target.value))} /></label>
      <p>Each pass reserves 60,000 tokens before starting. This is a start gate, not an exact per-call token ceiling. All project diagnostics count; missing usage holds the loop. A successful manual pass with matching profile, skills and model is required in the same 24-hour window.</p>
      <button className="lp-primary" disabled={busy}>Create disabled policy</button>
    </form>}
    <div className="lp-detail">
      {!loaded && !error && <p>Loading policies…</p>}
      {loaded && !policies.length && <p>No observation policies yet. Start with a manual diagnostic in Agents &amp; skills, then create a bounded policy here.</p>}
      {policies.map(p => <article className="lp-policy-card" key={p.id}>
        <div className="lp-detailhead"><div className="lp-names"><strong>{p.name}</strong><span>{p.profile_key} · every {p.interval_minutes} minutes when a new commit is available</span></div>
          <button className="lp-btn" disabled={busy} onClick={() => void act(async () => { await setSpecialistLoopEnabled(slug, String(p.id), !p.enabled); await load(); })}>{p.enabled ? 'Disable observations' : 'Enable observations'}</button>
        </div>
        <p>{p.enabled ? 'Enabled' : 'Disabled'} · {p.stop_reason || 'Awaiting host check'}</p>
        <p>{p.max_runs_day} attempts / 24h · {p.max_tokens_day.toLocaleString()} token budget · {p.paths.length ? p.paths.join(', ') : 'All changed tracked files'}</p>
        <div className="lp-acts"><button className="lp-btn" onClick={() => { setSelected(String(p.id)); setEvaluation(''); setReport(null); }}>Evaluate eligibility</button>
          {p.last_job_id && <button className="lp-btn" disabled={busy} onClick={() => void act(async () => { setSelected(String(p.id)); setReport(await getSpecialistRun(slug, String(p.last_job_id))); })}>Read latest run #{p.last_job_id}</button>}
        </div>
      </article>)}
      {policy && <form className="lp-policy-form" onSubmit={e => { e.preventDefault(); void act(async () => {
        const now = new Date(); const r = await evaluateSpecialistLoop(slug, selected, { base, head, connected: true, localMinutes: now.getHours() * 60 + now.getMinutes() });
        setEvaluation(`${r.hold || 'Eligible for the supplied revisions, subject to host and queue checks'}. ${r.usage.attempts} attempts; ${r.usage.spent === null ? 'usage unknown' : `${r.usage.spent} reported/reserved tokens`}.`);
      }); }}>
        <strong>Eligibility simulation · {policy.name}</strong><p>Uses the revisions you supply and assumes an available host. This does not enqueue a run or verify your checkout.</p>
        <label>Base commit<input className="lp-text" required pattern="[a-f0-9]{40}" value={base} onChange={e => setBase(e.target.value)} /></label>
        <label>Head commit<input className="lp-text" required pattern="[a-f0-9]{40}" value={head} onChange={e => setHead(e.target.value)} /></label>
        <button className="lp-btn" disabled={busy}>Evaluate without running</button>{evaluation && <p role="status">{evaluation}</p>}
      </form>}
      {report && <div className="lp-policy-card"><strong>Run #{report.id} · {report.status}</strong><p>{report.detail}</p><p>{report.result?.summary || report.result?.reason || 'No completed diagnostic evidence.'}</p>
        {report.result?.findings?.map((f, i) => <p key={i}>{f.title} · {f.path} · {f.trigger}</p>)}
        {report.result?.blind?.map((b, i) => <p key={i}>Blind spot: {b}</p>)}
      </div>}
    </div>
  </section>;
}
