import { useCallback, useEffect, useState } from 'react';
import type { AnalyticsReport, MonetizationRequirement } from '../../../shared/operations';

const n = (v: number | null) => (v === null ? '—' : v.toLocaleString());
const PLATFORM: Record<string, string> = { tiktok: 'TikTok', youtube: 'YouTube', instagram: 'Instagram' };

function Requirement({ r }: { r: MonetizationRequirement }) {
  const pct = r.current === null ? 0 : Math.min(100, (r.current / r.target) * 100);
  return (
    <li className="req">
      <span className="small">
        {r.label}: <strong>{n(r.current)}</strong> <span className="muted">of {r.target.toLocaleString()}</span>
        {r.current === null && <span className="muted"> · not available</span>}
      </span>
      <div className="meter thin" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={r.label}>
        <div className="meter-fill" style={{ width: `${pct}%` }} />
      </div>
    </li>
  );
}

/** Real audience numbers from connected accounts and progress toward each monetization programme. */
export function AnalyticsPanel() {
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    window.api
      .getAnalytics()
      .then(setReport, (e) => setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(refresh, [refresh]);

  return (
    <>
      <div className="page-head">
        <h2>Audience</h2>
        <button className="secondary" onClick={refresh} disabled={loading}>
          {loading ? (
            <>
              <span className="spinner" aria-hidden="true" /> Refreshing…
            </>
          ) : (
            'Refresh'
          )}
        </button>
      </div>
      {error && <p className="field-error small" role="alert">{error}</p>}
      {report && !report.platforms.length && <p className="muted small">No connected accounts. Connect one in Accounts.</p>}
      {report?.platforms.map((p) => (
        <div key={p.platform + p.handle} className="analytics-card">
          <div className="analytics-head">
            <strong>
              {PLATFORM[p.platform]} · {p.handle}
            </strong>
            {p.available && (
              <span className="small">
                {n(p.followers)} followers · {n(p.totalViews)} views
              </span>
            )}
          </div>
          {p.detail && <p className={`small ${p.available ? 'muted' : 'field-error'}`}>{p.detail}</p>}
          {p.videos.length > 0 && (
            <table className="analytics-table">
              <thead>
                <tr>
                  <th scope="col">Video</th>
                  <th scope="col">Visibility</th>
                  <th scope="col">Views</th>
                  <th scope="col">Likes</th>
                  <th scope="col">Comments</th>
                </tr>
              </thead>
              <tbody>
                {p.videos.map((v) => (
                  <tr key={v.publicationId}>
                    <td>{v.url ? <a href={v.url} target="_blank" rel="noreferrer">{v.title}</a> : v.title}</td>
                    <td>{v.privacy || '—'}</td>
                    <td>{n(v.views)}</td>
                    <td>{n(v.likes)}</td>
                    <td>{n(v.comments)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}

      <h2>Monetization progress</h2>
      <div className="goal-grid">
        {report?.programs.map((pg) => {
          const solo = pg.requirements.filter((r) => !r.either);
          const either = pg.requirements.filter((r) => r.either);
          return (
            <div key={pg.id} className="goal">
              <span className="goal-label">{pg.name}</span>
              <span className={`small ${pg.eligible ? '' : 'muted'}`}>{pg.eligible ? 'Requirements met: apply on the platform' : 'Not yet eligible'}</span>
              <ul className="req-list">
                {solo.map((r) => <Requirement key={r.label} r={r} />)}
              </ul>
              {either.length > 0 && (
                <>
                  <span className="muted small">and either</span>
                  <ul className="req-list">
                    {either.map((r) => <Requirement key={r.label} r={r} />)}
                  </ul>
                </>
              )}
              <span className="muted small">
                {pg.note}{' '}
                <a href={pg.source} target="_blank" rel="noreferrer">Programme rules</a>
              </span>
            </div>
          );
        })}
      </div>
      {report && <p className="muted small">Updated {new Date(report.capturedAt).toLocaleString()}. Thresholds are each platform's published criteria; the platform decides eligibility.</p>}
    </>
  );
}
