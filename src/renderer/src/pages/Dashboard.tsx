import { useEffect, useState } from 'react';
import { STAGES, STAGE_LABELS, type StageCounts } from '../../../shared/domain';
import type { PageProps } from '../App';
import { ContentList, useContent } from '../components/ContentList';

export function Dashboard({ channel, refreshKey, openEditor }: PageProps) {
  const [counts, setCounts] = useState<StageCounts | null>(null);
  const { items } = useContent(channel.id, undefined, refreshKey);

  useEffect(() => {
    void window.api.stageCounts(channel.id).then(setCounts);
  }, [channel.id, refreshKey]);

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">
            {channel.name} · {channel.niche} · {channel.platforms.join(', ')}
          </p>
        </div>
        <button className="primary" onClick={() => openEditor('new')}>
          New idea
        </button>
      </header>

      <div className="stat-row" aria-label="Content by stage">
        {STAGES.map((s) => (
          <div key={s} className={`stat stage-${s}`}>
            <span className="stat-value">{counts?.counts[s] ?? '–'}</span>
            <span className="stat-label">{STAGE_LABELS[s]}</span>
          </div>
        ))}
      </div>

      <h2>Recently updated</h2>
      <ContentList
        items={items && items.slice(0, 8)}
        empty="No content yet. Create your first idea to start the pipeline."
        onOpen={openEditor}
      />
    </section>
  );
}
