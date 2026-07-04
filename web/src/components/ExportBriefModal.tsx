import { useState } from 'react';
import { Modal } from './Modal';
import { DIRECTIVES, downloadBrief, type BriefInput } from '../lib/brief';
import { getBriefPrefs, setBriefPrefs, AuthError } from '../store';

// The curate-then-export step for the resume brief: pick the detail level and
// the session preferences to write into it. Choices persist on this device.
// `loadInput` supplies the project data — immediate on the detail screen, a
// fetch on the deck hero — so the modal owns the busy/failed states.
export function ExportBriefModal({
  projectName, loadInput, onClose,
}: {
  projectName: string;
  loadInput: () => Promise<BriefInput>;
  onClose: () => void;
}) {
  const [prefs] = useState(getBriefPrefs);
  const [compact, setCompact] = useState(prefs.compact);
  const [selected, setSelected] = useState<Set<string>>(new Set(prefs.directives));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key); else next.add(key);
    setSelected(next);
  };

  const doExport = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    const directives = DIRECTIVES.map((d) => d.key).filter((k) => selected.has(k));
    setBriefPrefs({ compact, directives });
    try {
      const input = await loadInput();
      downloadBrief(input, { compact, directives });
      onClose();
    } catch (e) {
      if (e instanceof AuthError) return; // global handler routes to the gate
      setError((e as Error)?.message || "Couldn't load the project data.");
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <h3>Export resume brief</h3>
      <div className="confirm-body" style={{ marginBottom: 18 }}>
        A markdown brief for starting straight back into <b>{projectName}</b> — paste it at the top of a session.
      </div>

      <div className="lbl" style={{ marginBottom: 9 }}>Detail</div>
      <div className="seg-control" role="tablist" aria-label="Brief detail" style={{ marginBottom: 6 }}>
        <button role="tab" aria-selected={!compact} className={`seg-opt ${!compact ? 'on' : ''}`} onClick={() => setCompact(false)}>Full</button>
        <button role="tab" aria-selected={compact} className={`seg-opt ${compact ? 'on' : ''}`} onClick={() => setCompact(true)}>Compact</button>
      </div>
      <div className="brief-blurb">
        {compact
          ? 'Essentials only, tightly capped — the cheapest brief to feed an agent.'
          : 'The full picture — working-well list and recent pushes included.'}
      </div>

      <div className="lbl" style={{ marginBottom: 4 }}>Session preferences</div>
      <div className="brief-blurb">Written into the brief so the next session works the way you want.</div>
      <div className="brief-rows">
        {DIRECTIVES.map((d) => (
          <div className="brief-row" key={d.key}>
            <div>
              <div className="brief-row-label">{d.label}</div>
              <div className="brief-row-hint">{d.hint}</div>
            </div>
            <button role="switch" aria-checked={selected.has(d.key)} aria-label={d.label}
              className={`switch ${selected.has(d.key) ? 'on' : ''}`} onClick={() => toggle(d.key)}>
              <span className="switch-knob" />
            </button>
          </div>
        ))}
      </div>

      {error && <div className="action-error">{error}</div>}

      <div className="modal-actions">
        <button className="btn-cancel" onClick={onClose}>Cancel</button>
        <button className="btn-submit" onClick={doExport} disabled={busy}>
          {busy ? 'Exporting…' : 'Export brief ↓'}
        </button>
      </div>
    </Modal>
  );
}
