import { useEffect, useState } from 'react';
import type { HistoryEntry } from '../../../shared/rights';
import { RIGHTS_STATUS } from '../../../shared/rights';
import { errorText } from '../components/ProductionDetail';

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

/**
 * Rights & Compliance history: the one place where incidents are told in full (what happened, which assets and
 * productions, what was verified, what was done, and whether it is still open). Read-only; for the active business.
 */
export function RightsCompliance({ anchor }: { anchor?: string }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void window.api.rightsHistory().then(setEntries).catch((e: unknown) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    if (anchor && entries) document.getElementById(`rights-${anchor}`)?.scrollIntoView({ block: 'start' });
  }, [anchor, entries]);
  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Rights &amp; Compliance</h1>
          <p className="muted">The full record of rights incidents for this business. Sound Library cards show only each track's current status.</p>
        </div>
      </header>
      {error && <div className="banner error" role="alert">{error}</div>}
      {entries === null ? (
        <p className="muted">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="empty">No rights incidents are recorded for this business.</p>
      ) : (
        entries.map((e) => (
          <article key={e.key} id={`rights-${e.key}`} className={`card rights-incident ${anchor === e.key ? 'rights-incident-focus' : ''}`}>
            <h2>
              {e.title} <span className={`badge ${e.status === 'open' ? 'prod-failed' : 'prod-completed'}`}>{e.status === 'open' ? 'Open' : 'Resolved'}</span>
            </h2>
            <p className="muted small">{when(e.date)}</p>
            <h3>What happened</h3>
            <p>{e.whatHappened}</p>
            {e.assets.length > 0 && (
              <>
                <h3>Affected assets</h3>
                <table className="rights-table small">
                  <thead>
                    <tr>
                      <th scope="col">Track</th>
                      <th scope="col">Creator</th>
                      <th scope="col">Finding</th>
                      <th scope="col">Status now</th>
                      <th scope="col">Incident</th>
                    </tr>
                  </thead>
                  <tbody>
                    {e.assets.map((a) => (
                      <tr key={a.trackId}>
                        <td>{a.title}</td>
                        <td>{a.creator}</td>
                        <td>{a.category === 'known paid track' ? 'Known paid track (Jamendo Licensing)' : a.category === 'licensing unverified' ? 'Licensing unverified at the source' : '—'}</td>
                        <td>{RIGHTS_STATUS[a.status as keyof typeof RIGHTS_STATUS]?.label ?? a.status}</td>
                        <td>{a.incidentIds.length ? a.incidentIds.map((i) => `#${i}`).join(', ') : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <h3>Why they were quarantined</h3>
                <ul className="small">
                  {[...new Set(e.assets.map((a) => a.reason).filter(Boolean))].map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </>
            )}
            {e.verification.length > 0 && (
              <>
                <h3>Verification performed</h3>
                <ul className="small">
                  {e.verification.map((v) => (
                    <li key={v}>{v}</li>
                  ))}
                </ul>
              </>
            )}
            <h3>Affected productions and renders</h3>
            {e.productions.length === 0 ? (
              <p className="muted small">None recorded for this business.</p>
            ) : (
              <ul className="small">
                {e.productions.map((p) => (
                  <li key={p.productionNumber}>
                    <strong>Production {p.productionNumber}</strong>
                    {p.topic ? ` · “${p.topic}”` : ''}
                    {p.deleted ? ' · deleted' : ''}
                    <ul>
                      {p.renders.map((r) => (
                        <li key={r.sha256 + r.at}>
                          Render {when(r.at)} · <span className="mono">{r.sha256.slice(0, 12)}…</span>
                        </li>
                      ))}
                      {p.publications.map((x) => (
                        <li key={x.id}>
                          Publication attempt #{x.id} · {x.platform} · {x.status} ({x.privacy || 'visibility not reported'}){x.deletedAt ? ` · deleted ${when(x.deletedAt)}` : ''}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
            {e.correctiveActions.length > 0 && (
              <>
                <h3>Corrective action</h3>
                <ul className="small">
                  {e.correctiveActions.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </>
            )}
            <h3>Incident records</h3>
            <ul className="small">
              {e.incidents.map((i) => (
                <li key={i.id}>
                  #{i.id} · {i.status} · opened {when(i.createdAt)}
                  {i.resolvedAt ? ` · resolved ${when(i.resolvedAt)}` : ''} · {i.description}
                </li>
              ))}
              {e.incidents.length === 0 && <li className="muted">No incident record (only rights decisions).</li>}
            </ul>
          </article>
        ))
      )}
    </section>
  );
}
