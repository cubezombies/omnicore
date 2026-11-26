import { useEffect, useState } from 'react';
import { BUSINESS_GOALS, type AppInfo } from '../../../shared/domain';
import type { PageProps } from '../App';

const usd = (n: number) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function Business({ channel }: PageProps) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void window.api.appInfo().then(setInfo);
  }, []);

  const collected = 0; // Revenue tracking is not built yet.
  const goals = [
    { label: 'Cumulative collected revenue', target: BUSINESS_GOALS.cumulativeRevenueTarget, current: collected },
    { label: 'Annual business profit (provisional)', target: BUSINESS_GOALS.annualProfitTarget, current: 0 },
    { label: 'Employment income to replace', target: BUSINESS_GOALS.incomeToReplace, current: 0 }
  ];

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Business</h1>
          <p className="muted">Targets for the business. Revenue tracking is not built yet, so every figure shows $0.</p>
        </div>
      </header>
      <div className="goal-grid">
        {goals.map((g) => {
          const pct = Math.min(100, (g.current / g.target) * 100);
          return (
            <div key={g.label} className="goal">
              <span className="goal-label">{g.label}</span>
              <span className="goal-value">
                {usd(g.current)} <span className="muted">of {usd(g.target)}</span>
              </span>
              <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={g.label}>
                <div className="meter-fill" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      <h2>Channel</h2>
      <dl className="facts">
        <dt>Name</dt>
        <dd>{channel.name}</dd>
        <dt>Niche</dt>
        <dd>{channel.niche}</dd>
        <dt>Platforms</dt>
        <dd>{channel.platforms.join(', ')}</dd>
        <dt>Starting budget</dt>
        <dd>$0</dd>
      </dl>
      {info && (
        <p className="muted small">
          v{info.version} · data: {info.dataDir}
        </p>
      )}
    </section>
  );
}
