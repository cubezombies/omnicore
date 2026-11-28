import { useEffect, useState } from 'react';
import type { ProductionFreeze } from '../../../shared/operations';
import { errorText } from './ProductionDetail';

/**
 * Production freeze while the audio pipeline is restored: why it is frozen, the verification render (real voice,
 * approved music, effects, the production mixer and the mandatory audio gate) and the release, which you decide.
 */
export function ProductionFreezeCard({ compact = false }: { compact?: boolean }) {
  const [f, setF] = useState<ProductionFreeze | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => {
    void window.api.productionFreeze().then(setF).catch((e: unknown) => setError(errorText(e)));
  }, []);
  if (!f) return error ? <div className="banner error" role="alert">{error}</div> : null;
  if (!f.frozen && compact) return null;
  const v = f.verification;
  const current = v && v.version === f.version;
  async function verify() {
    setBusy(true);
    setError(null);
    try {
      setF(await window.api.verifyAudioPipeline());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function release() {
    setError(null);
    try {
      setF(await window.api.releaseProduction(note));
    } catch (e) {
      setError(errorText(e));
    }
  }
  if (compact)
    return (
      <div className="banner error" role="status">
        <strong>Production is frozen.</strong> {f.reason} New productions, retries and re-runs are refused until it is released in Operations.
      </div>
    );
  return (
    <section className={`card freeze-card ${f.frozen ? 'freeze-on' : 'freeze-off'}`} aria-live="polite">
      <h2>{f.frozen ? 'Production is frozen' : 'Production released'}</h2>
      {f.frozen ? (
        <p>
          {f.reason} Nothing new can start, retry or re-run until a verification render passes the mandatory audio gate on audio pipeline v{f.version} and you release production here.
        </p>
      ) : (
        <p className="small">
          Released {f.release ? new Date(f.release.at).toLocaleString() : ''} after the verification render of {f.release?.verifiedAt ? new Date(f.release.verifiedAt).toLocaleString() : '—'}
          {f.release?.note ? ` · “${f.release.note}”` : ''}.
        </p>
      )}
      {error && <p className="field-error small" role="alert">{error}</p>}
      {v && (
        <details open={f.frozen}>
          <summary>
            Latest verification: <strong>{v.passed ? 'passed' : 'FAILED'}</strong> · {new Date(v.at).toLocaleString()} · {v.narration} · {v.track} · {v.durationSec.toFixed(1)} s{current ? '' : ` (pipeline v${v.version}, out of date)`}
          </summary>
          <ul className="qa-list">
            {v.findings.map((x) => (
              <li key={x.checkId} className={x.passed ? 'qa-pass' : `qa-fail qa-${x.severity}`}>
                <span className="qa-mark" aria-hidden="true">{x.passed ? '✓' : '✕'}</span> <span className="muted small">{x.checkId}</span> {x.message}
              </li>
            ))}
          </ul>
          <p className="muted small mono">{v.dir}</p>
        </details>
      )}
      {f.frozen && (
        <div className="prod-actions">
          <button className="secondary" disabled={busy} onClick={() => void verify()}>
            {busy ? 'Rendering and analysing the verification video…' : 'Run audio verification render'}
          </button>
          {current && v?.passed && (
            <>
              <input aria-label="Release note" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
              <button className="primary" onClick={() => void release()}>
                Release production
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
