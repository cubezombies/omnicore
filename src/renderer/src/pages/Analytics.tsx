import type { Business } from '../../../shared/business';
import { AnalyticsPanel } from '../components/AnalyticsPanel';

/** Performance for the active business only: objectives, audience and monetization progress. */
export function Analytics(props: { business: Business }) {
  const b = props.business;
  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Analytics</h1>
          <p className="muted">Results for {b.name}. Numbers from other businesses are never included.</p>
        </div>
      </header>
      <div className="card">
        <h2>Objectives</h2>
        {b.objectives ? <p className="prewrap">{b.objectives}</p> : <p className="muted">No objectives set. Add them in Business Settings.</p>}
        <p className="muted small">Revenue tracking isn't built yet, so progress toward revenue goals can't be measured here.</p>
      </div>
      {b.modules.includes('media') ? <AnalyticsPanel /> : <p className="muted">Audience analytics come with the Media module. Other modules' analytics aren't available yet.</p>}
    </section>
  );
}
