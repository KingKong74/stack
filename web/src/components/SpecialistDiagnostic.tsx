import { useCallback, useEffect, useRef, useState } from 'react';
import { getSpecialistRun, queueSpecialistRun, hangupAutopilotJob, type SpecialistRun } from '../store';
import { useAutoRefresh } from '../lib/autoRefresh';
import { SpecialistEvidence } from './SpecialistEvidence';
import { Modal } from './Modal';
export function SpecialistDiagnostic({ profileKey, name, project, projects, onClose }: { profileKey: string; name: string; project: string; projects: string[]; onClose: () => void }) {
  const [slug, setSlug] = useState(project);
  const [base, setBase] = useState(''), [head, setHead] = useState(''), [note, setNote] = useState('');
  const [paths, setPaths] = useState('');
  const [includeWorkingTree, setWorking] = useState(false);
  const [id, setId] = useState<string | null>(null), [run, setRun] = useState<SpecialistRun | null>(null);
  const pendingRequest = useRef<{ input: string; id: string } | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const load = useCallback(() => { if (id) getSpecialistRun(slug, id).then(setRun).catch(() => setError('Run status unavailable.')); }, [id, slug]);
  useEffect(load, [load]); useAutoRefresh(load, !!id && !['done', 'failed', 'paused'].includes(run?.status || ''));
  const queue = async () => {
    setBusy(true); setError('');
    const input = JSON.stringify({ slug, profileKey, base, head, paths, includeWorkingTree, note });
    if (pendingRequest.current?.input !== input) pendingRequest.current = { input, id: crypto.randomUUID() };
    try { const queued = await queueSpecialistRun(slug, { requestId: pendingRequest.current.id, profileKey, base, head, paths: paths.split(',').map(p => p.trim()).filter(Boolean), includeWorkingTree, note }); setId(queued.id); }
    catch (e) { setError((e as Error).message || 'Could not queue diagnostic.'); } finally { setBusy(false); }
  };
  return <Modal onClose={onClose} wide>
    <h3>Diagnostic pass · {name}</h3>
    <div className="confirm-body terminal-config-body">
      <p>A tool-free annotation over a captured diff, using native Claude. No code is built, tests executed or human verdict given. The pass is bounded to one turn and 90 seconds.</p>
      {error && <p role="alert">{error}</p>}
      {!id ? <>
        <label>Project <select className="sa-input" aria-label="Diagnostic project" value={slug} onChange={e => setSlug(e.target.value)}>{[...new Set([project, ...projects])].filter(Boolean).map(p => <option key={p}>{p}</option>)}</select></label>
        <label>Base commit <input className="sa-input" aria-label="Diagnostic base commit" value={base} onChange={e => setBase(e.target.value.trim())} /></label>
        <label>Head commit <input className="sa-input" aria-label="Diagnostic head commit" value={head} onChange={e => setHead(e.target.value.trim())} /></label>
        <p>Use the full hashes from git rev-parse HEAD^ and HEAD in the target checkout. The host refuses if HEAD changes before the pass starts.</p>
        <label><input type="checkbox" checked={includeWorkingTree} onChange={e => setWorking(e.target.checked)} /> Include uncommitted tracked changes</label>
        <label>File scope (optional, comma-separated) <input className="sa-input" aria-label="Diagnostic paths" value={paths} onChange={e => setPaths(e.target.value)} /></label>
        <label>Focus <textarea className="sa-input" aria-label="Diagnostic focus" value={note} maxLength={2000} onChange={e => setNote(e.target.value)} /></label>
      </> : <>
        <p>Job #{id} · {run?.status || 'Queued'} · {run?.detail}</p>
        {run ? <SpecialistEvidence run={run} /> : <p>No completed diagnostic read is available.</p>}
        {!['done', 'failed', 'paused'].includes(run?.status || '') && <button className="btn-cancel" onClick={() => { void hangupAutopilotJob(id).then(load).catch(() => setError('Could not pause the run.')); }}>Pause run</button>}
      </>}
    </div>
    <div className="modal-actions"><button className="btn-cancel" onClick={onClose}>Close</button>{!id && <button className="btn-submit" disabled={busy || !slug || !/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head)} onClick={() => void queue()}>Queue diagnostic</button>}</div>
  </Modal>;
}
