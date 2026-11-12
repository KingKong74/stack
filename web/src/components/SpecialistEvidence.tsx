// Reports are annotations. Keep qualifications beside claims so a hypothesis
// never becomes a confirmed bug merely by losing fields during rendering.
import type { SpecialistRun } from '../store';
export function SpecialistEvidence({ run }: { run: SpecialistRun }) {
  const result = run.result;
  if (!result) return <p>No completed diagnostic evidence.</p>;
  if (result.skipped) return <p>Skipped: {result.reason}</p>;
  return <div className="specialist-evidence">
    <p>{result.summary}</p>
    {!!result.findings?.length && <p>Diagnostic annotations; reproduction and verification remain separate.</p>}
    {result.findings?.map((f, i) => <div key={i}>
      <p><strong>{f.title}</strong><br />{f.path} · {f.trigger}</p>
      <p>{f.evidence.join('; ')}</p>
      {f.expected && <p>Expected: {f.expected}</p>}
      {f.actual && <p>Reported actual: {f.actual}</p>}
    </div>)}
    {!!result.read?.length && <><h4>Supplied file scope</h4><ul>{result.read.map((r, i) => <li key={i}>{r}</li>)}</ul></>}
    {!!result.blind?.length && <><h4>Blind spots</h4><ul>{result.blind.map((b, i) => <li key={i}>{b}</li>)}</ul></>}
  </div>;
}
