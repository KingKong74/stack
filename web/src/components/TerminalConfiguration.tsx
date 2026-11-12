import { useCallback, useEffect, useState } from 'react';
import type { AgentProfile, SessionConfiguration } from '../types';
import { getAgentProfiles, getTerminalConfiguration } from '../store';
import { useAutoRefresh } from '../lib/autoRefresh';
import { Modal } from './Modal';

export function TerminalProfilePicker({ value, onChange, runtime }: { value: string[]; onChange: (keys: string[]) => void; runtime: string }) {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { getAgentProfiles().then(r => setProfiles(r.profiles)).catch(() => setError('Profile catalogue unavailable.')); }, []);
  return <div className="grp">
    <span className="cap">Spawn profiles for new Claude sessions</span>
    <span className="tv-dim">{runtime === 'claude' ? 'Selected profiles are available for delegation; a builder is included. Existing sessions keep their launch configuration.' : 'Codex receives compatible skills; Stack spawn profiles are supported by Claude only.'}</span>
    {error && <span className="tv-dim">{error}</span>}
    {runtime === 'claude' && profiles.filter(p => p.enabled).map(p => <label key={p.key} className="tv-dim">
      <input type="checkbox" checked={value.includes(p.key)} disabled={!value.includes(p.key) && value.length >= 6}
        onChange={() => onChange(value.includes(p.key) ? value.filter(k => k !== p.key) : [...value, p.key])} /> {p.name}
    </label>)}
    {value.length > 0 && <button className="tv-btn sm" onClick={() => onChange([])}>Clear profile selection</button>}
  </div>;
}

export function TerminalConfiguration({ snapshot, name, onClose }: { snapshot?: SessionConfiguration | null; name?: string; onClose: () => void }) {
  const [changes, setChanges] = useState<string[] | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const load = useCallback(() => {
    if (!snapshot || snapshot.state === 'unknown') return;
    getTerminalConfiguration(snapshot.id).then(r => { setChanges(r.changes); setConnected(r.connected); }).catch(() => { setChanges(null); setConnected(null); });
  }, [snapshot]);
  useEffect(() => { setChanges(null); load(); }, [load]);
  useAutoRefresh(load);
  return <Modal onClose={onClose} wide>
    <h3>Session configuration</h3>
    <div className="confirm-body terminal-config-body">
      {!snapshot ? <p>{name ? 'Stack has no recorded launch configuration for this session. External and older sessions remain unknown.' : 'Select a session to inspect its launch configuration.'}</p> : <>
        <p>Supplied at launch · {new Date(snapshot.createdAt).toLocaleString()}. This records configuration delivery, not skill invocation or model usage.</p>
        <dl className="terminal-config-facts">
          <dt>Runtime</dt><dd>{snapshot.runtimeVersion || snapshot.runtime}</dd>
          <dt>Project</dt><dd>{snapshot.project || 'Unknown'}</dd>
          <dt>Checkout</dt><dd>{snapshot.checkout}</dd>
          <dt>Working directory</dt><dd>{snapshot.cwd}</dd>
          <dt>Branch / revision</dt><dd>{snapshot.branch || 'Unknown'} · {snapshot.head?.slice(0, 12) || 'Unknown'}</dd>
          <dt>Working tree at launch</dt><dd>{snapshot.dirty === null ? 'Unknown' : snapshot.dirty ? 'Uncommitted changes present' : 'Clean'}</dd>
          <dt>Starting context</dt><dd>{snapshot.contextDelivery}</dd>
        </dl>
        <p>{snapshot.state === 'unknown' ? 'Stack launch configuration was unknown.' : changes === null ? 'Current library comparison unavailable.' : changes.length ? 'Library changed since launch. This snapshot is unchanged; runtime discovery may reflect newer files. Start a new session for a fresh launch snapshot.' : 'Supplied profile and skill revisions still match the library.'} {connected === false ? 'Stack cannot see the terminal host.' : ''}</p>
        {changes?.length ? <ul>{changes.map(c => <li key={c}>{c}</li>)}</ul> : null}
        <h4>Supplied profiles</h4>
        {!snapshot.profiles.length && <p>No Stack spawn profiles supplied.</p>}
        {snapshot.profiles.map(p => <p key={p.key}>{p.key} · {p.model || 'CLI default'} · <code>{p.revision.slice(0, 12)}</code><br />Tools: {p.tools.join(', ')}</p>)}
        <h4>Confirmed skill files</h4>
        {!snapshot.skills.length && <p>No managed skills confirmed for this launch.</p>}
        {snapshot.skills.map(s => <p key={s.id}>{s.name} · <code>{s.revision.slice(0, 12)}</code><br />{s.path}</p>)}
        {!!snapshot.blind.length && <><h4>What Stack could not confirm</h4><ul>{snapshot.blind.map(b => <li key={b}>{b}</li>)}</ul></>}
      </>}
    </div>
    <div className="modal-actions"><button className="btn-cancel" onClick={onClose}>Close</button></div>
  </Modal>;
}
