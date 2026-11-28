import { useCallback, useEffect, useState } from 'react';
import type { AuditEvent } from '../../../shared/operations';
import type { AutomationHalt, BreakerStatus, ProductionActionEvent, ProductionJob, ReliabilitySettings } from '../../../shared/automation';
import { errorText } from './ProductionDetail';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' }) : '—');
const state = (s: ProductionActionEvent['previous']) => (s ? `${s.status}${s.step ? `/${s.step}` : ''}` : '—');

/** Automation reliability for the active business: halt, breakers, limits, jobs and the production activity log. */
export function AutomationPanel() {
  const [st, setSt] = useState<{ halt: AutomationHalt | null; breakers: BreakerStatus[]; jobs: ProductionJob[]; reliability: ReliabilitySettings } | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [rel, setRel] = useState<ReliabilitySettings | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    void Promise.all([window.api.automationStatus(), window.api.productionActivity(60)])
      .then(([s, e]) => {
        setSt(s);
        setRel((r) => r ?? s.reliability);
        setEvents(e);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    load();
    const off = window.api.onProductionChanged(() => load());
    const t = setInterval(load, 15_000);
    return () => (off(), clearInterval(t));
  }, [load]);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(errorText(e));
    }
  };
  if (!st) return error ? <div className="banner error" role="alert">{error}</div> : null;
  return (
    <section className="card">
      <h2>Automation reliability</h2>
      {error && <p className="field-error small" role="alert">{error}</p>}
      {st.halt ? (
        <div className="banner error" role="status">
          <strong>Automation halted.</strong> {st.halt.reason} ({when(st.halt.at)}). Nothing is started or retried for this business until you resume it.
          <div className="prod-actions">
            <input aria-label="Resume note" placeholder="What did you check? (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="secondary" onClick={() => void act(() => window.api.clearAutomationHalt(note))}>
              Resume automation
            </button>
          </div>
        </div>
      ) : (
        <p className="small muted">No automation halt. A failed rights, evidence, audio or safety gate halts automation for this business until you resume it.</p>
      )}
      {st.breakers.length > 0 && (
        <p className="small">
          Services:{' '}
          {st.breakers.map((b) => (
            <span key={b.service} className={`badge ${b.state === 'closed' ? 'prod-completed' : 'prod-failed'}`} title={b.lastError}>
              {b.service}: {b.state}
              {b.failures ? ` (${b.failures} failures)` : ''}
            </span>
          ))}
        </p>
      )}
      {rel && (
        <details>
          <summary>Retry and recovery limits</summary>
          <div className="prod-actions small">
            {(
              [
                ['maxAutomaticRetries', 'Automatic retries'],
                ['retryBackoffMinutes', 'Back-off (min, doubles)'],
                ['stallMinutes', 'Stall after (min)'],
                ['queuedExpiryHours', 'Queued expiry (h)'],
                ['circuitFailureThreshold', 'Breaker opens after'],
                ['circuitCooldownMinutes', 'Breaker cooldown (min)']
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="field">
                <span>{label}</span>
                <input type="number" value={rel[k]} onChange={(e) => setRel({ ...rel, [k]: Number(e.target.value) })} style={{ width: 90 }} />
              </label>
            ))}
            <button className="secondary" onClick={() => void act(async () => setRel(await window.api.saveReliability(rel)))}>
              Save limits
            </button>
          </div>
        </details>
      )}
      <details>
        <summary>Jobs ({st.jobs.filter((j) => j.status === 'queued' || j.status === 'running').length} active)</summary>
        <table className="rights-table small">
          <thead>
            <tr>
              <th scope="col">Job</th>
              <th scope="col">Production</th>
              <th scope="col">Kind</th>
              <th scope="col">Started by</th>
              <th scope="col">Status</th>
              <th scope="col">Created</th>
              <th scope="col">Error</th>
            </tr>
          </thead>
          <tbody>
            {st.jobs.map((j) => (
              <tr key={j.id}>
                <td>#{j.id}</td>
                <td>#{j.productionNumber}</td>
                <td>{j.kind}{j.fromStep ? ` from ${j.fromStep}` : ''}</td>
                <td>{j.initiator}</td>
                <td>{j.status}</td>
                <td>{when(j.createdAt)}</td>
                <td>{j.error ? `${j.failureKind ? `${j.failureKind}: ` : ''}${j.error.slice(0, 140)}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <details open>
        <summary>Production activity</summary>
        {events.length === 0 ? (
          <p className="muted small">No production actions recorded yet.</p>
        ) : (
          <table className="rights-table small">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Production</th>
                <th scope="col">Action</th>
                <th scope="col">By</th>
                <th scope="col">Outcome</th>
                <th scope="col">State</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => {
                const d = e.data as unknown as ProductionActionEvent;
                return (
                  <tr key={e.id}>
                    <td>{when(e.ts)}</td>
                    <td>#{e.productionId}</td>
                    <td>
                      {d.action}
                      {d.stage ? ` (${d.stage})` : ''}
                    </td>
                    <td>{d.initiator}</td>
                    <td>{d.outcome}</td>
                    <td>
                      {state(d.previous)} → {state(d.resulting)}
                    </td>
                    <td>{[d.jobId ? `job #${d.jobId}` : '', d.failureKind ? `${d.failureKind}` : '', d.error ?? d.reason ?? ''].filter(Boolean).join(' · ').slice(0, 200)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </details>
    </section>
  );
}
