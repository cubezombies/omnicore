import { useState } from 'react';
import { STAGES, STAGE_LABELS, isStage, type Stage } from '../../../shared/domain';
import type { PageProps } from '../App';
import { ContentList, useContent } from '../components/ContentList';
import { usePublicationOverview } from '../components/usePublicationOverview';

export function Library({ channel, refreshKey, openEditor }: PageProps) {
  const [filter, setFilter] = useState<Stage | 'all'>('all');
  const [query, setQuery] = useState('');
  const { items } = useContent(channel.id, filter === 'all' ? undefined : [filter], refreshKey);
  const { byContent } = usePublicationOverview(`${channel.id}:${refreshKey}:${items?.length ?? 0}`);
  const q = query.trim().toLowerCase();
  const shown = items && (q ? items.filter((i) => `${i.title} ${i.summary}`.toLowerCase().includes(q)) : items);

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Content Library</h1>
          <p className="muted">Every piece of content for {channel.name}.</p>
        </div>
        <button className="primary" onClick={() => openEditor('new')}>
          New idea
        </button>
      </header>
      <div className="toolbar">
        <input
          type="search"
          placeholder="Search titles and summaries"
          aria-label="Search content"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="Filter by stage"
          value={filter}
          onChange={(e) => setFilter(isStage(e.target.value) ? e.target.value : 'all')}
        >
          <option value="all">All stages</option>
          {STAGES.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABELS[s]}
            </option>
          ))}
        </select>
      </div>
      <ContentList items={shown} empty="No matching content." onOpen={openEditor} publication={byContent} />
    </section>
  );
}
