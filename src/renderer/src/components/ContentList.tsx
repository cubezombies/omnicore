import { useEffect, useState } from 'react';
import { STAGE_LABELS, type ContentItem, type Stage } from '../../../shared/domain';
import { DestinationBadges } from './PublicationStatus';
import type { DestinationStatus } from '../../../shared/publicationStatus';

export function useContent(channelId: number, stages: Stage[] | undefined, refreshKey: number) {
  const [items, setItems] = useState<ContentItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stageKey = stages?.join(',') ?? '';
  useEffect(() => {
    let live = true;
    window.api
      .listContent(channelId, stages)
      .then((list) => live && setItems(list))
      .catch((e: unknown) => live && setError(String(e)));
    return () => {
      live = false;
    };
    // stageKey stands in for the stages array identity
  }, [channelId, stageKey, refreshKey]);
  return { items, error };
}

export function StageBadge({ stage }: { stage: Stage }) {
  return <span className={`badge stage-${stage}`}>{STAGE_LABELS[stage]}</span>;
}

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function ContentList({
  items,
  empty,
  onOpen,
  publication
}: {
  items: ContentItem[] | null;
  empty: string;
  onOpen: (item: ContentItem) => void;
  /** Publication status per content item (from its latest production). */
  publication?: Map<number, DestinationStatus[]>;
}) {
  if (items === null) return <p className="muted">Loading…</p>;
  if (items.length === 0) return <p className="empty">{empty}</p>;
  return (
    <ul className="content-list">
      {items.map((it) => (
        <li key={it.id}>
          <button className="content-row" onClick={() => onOpen(it)}>
            <span className="row-main">
              <span className="row-title">{it.title}</span>
              {it.summary && <span className="row-summary">{it.summary}</span>}
            </span>
            <StageBadge stage={it.stage} />
            {publication?.get(it.id) && <DestinationBadges statuses={publication.get(it.id)!} />}
            <span className="row-date">{fmt(it.updatedAt)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
