import { useState } from 'react';
import { Modal } from './Modal';
import {
  DIRECTIVES, buildBrief, briefFilename, downloadText, estimateTokens, tightenBrief,
  type BriefInput,
} from '../lib/brief';
import { getBriefPrefs, setBriefPrefs, AuthError } from '../store';

// The curate-then-export flow for the resume brief, in two steps:
//   1. options — detail level + the session preferences written into it
//   2. tinker  — the generated markdown in an editable textarea, with a token
//      estimate, a deterministic Tighten pass (saves tokens, no AI API),
//      copy-to-clipboard and download.
// Choices persist on this device. `loadInput` supplies the project data —
// immediate on the detail screen, a fetch on the deck hero.
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
  const [step, setStep] = useState<'options' | 'tinker'>('options');
  const [text, setText] = useState('');
  const [slug, setSlug] = useState('');
  const [copied, setCopied] = useState(false);

  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key); else next.add(key);
    setSelected(next);
  };

  const toTinker = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    const directives = DIRECTIVES.map((d) => d.key).filter((k) => selected.has(k));
    setBriefPrefs({ compact, directives });
    try {
      const input = await loadInput();
      setText(buildBrief(input, { compact, directives }));
      setSlug(input.project.id);
      setStep('tinker');
    } catch (e) {
      if (e instanceof AuthError) return; // global handler routes to the gate
      setError((e as Error)?.message || "Couldn't load the project data.");
    }
    setBusy(false);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Couldn't copy — your browser blocked clipboard access.");
    }
  };

  const download = () => {
    downloadText(briefFilename(slug), text);
    onClose();
  };

  if (step === 'tinker') {
    return (
      <Modal onClose={onClose} wide>
        <h3>Tinker, then export</h3>
        <div className="brief-tokenbar">
          <span className="brief-tokens">≈ {estimateTokens(text)} tokens</span>
          <button className="brief-tighten" onClick={() => setText(tightenBrief(text))}
            title="Strip markdown decoration and the footer — same content, fewer tokens">
            Tighten · save tokens
          </button>
        </div>
        <textarea className="brief-edit" value={text} spellCheck={false}
          onChange={(e) => setText(e.target.value)} />
        {error && <div className="action-error">{error}</div>}
        <div className="modal-actions split">
          <button className="btn-cancel" onClick={() => setStep('options')}>← Back</button>
          <span style={{ display: 'flex', gap: 10 }}>
            <button className="btn-cancel" onClick={copy}>{copied ? '✓ Copied' : 'Copy'}</button>
            <button className="btn-submit" onClick={download}>Download ↓</button>
          </span>
        </div>
      </Modal>
    );
  }

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
        <button className="btn-submit" onClick={toTinker} disabled={busy}>
          {busy ? 'Building…' : 'Preview & edit →'}
        </button>
      </div>
    </Modal>
  );
}
