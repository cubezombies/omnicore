import { useEffect, useState } from 'react';
import type { DestinationStatus } from '../../../shared/publicationStatus';

/** Publication status per production and per content item for the active business (refreshes with `key`). */
export function usePublicationOverview(key: unknown): { byProduction: Map<number, DestinationStatus[]>; byContent: Map<number, DestinationStatus[]> } {
  const [data, setData] = useState<{ productionId: number; contentId: number | null; statuses: DestinationStatus[] }[]>([]);
  useEffect(() => {
    let live = true;
    void window.api
      .publicationOverview()
      .then((d) => live && setData(d))
      .catch(() => live && setData([]));
    return () => {
      live = false;
    };
  }, [key]);
  const byProduction = new Map(data.map((d) => [d.productionId, d.statuses]));
  const byContent = new Map<number, DestinationStatus[]>();
  // A content item shows the status of its most recent production.
  for (const d of [...data].sort((a, b) => a.productionId - b.productionId)) if (d.contentId !== null) byContent.set(d.contentId, d.statuses);
  return { byProduction, byContent };
}
