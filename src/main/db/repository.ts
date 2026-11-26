import type { DatabaseSync } from 'node:sqlite';
import {
  STAGES,
  canTransition,
  type Channel,
  type ContentDraft,
  type ContentItem,
  type ContentPatch,
  type Stage,
  type StageCounts
} from '../../shared/domain';

interface ContentRow {
  id: number;
  channel_id: number;
  title: string;
  summary: string;
  research_notes: string;
  script: string;
  stage: Stage;
  created_at: string;
  updated_at: string;
}
interface ChannelRow {
  id: number;
  name: string;
  slug: string;
  niche: string;
  platforms: string;
  created_at: string;
}

const toItem = (r: ContentRow): ContentItem => ({
  id: r.id,
  channelId: r.channel_id,
  title: r.title,
  summary: r.summary,
  researchNotes: r.research_notes,
  script: r.script,
  stage: r.stage,
  createdAt: r.created_at,
  updatedAt: r.updated_at
});

const toChannel = (r: ChannelRow): Channel => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  niche: r.niche,
  platforms: JSON.parse(r.platforms) as string[],
  createdAt: r.created_at
});

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

export class NotFoundError extends Error {}
export class WorkflowError extends Error {}

const PATCH_COLUMNS: Record<keyof ContentPatch, string> = {
  title: 'title',
  summary: 'summary',
  researchNotes: 'research_notes',
  script: 'script'
};

export class Repository {
  constructor(private readonly db: DatabaseSync) {}

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  listChannels(): Channel[] {
    return (this.db.prepare('SELECT * FROM channels ORDER BY id').all() as unknown as ChannelRow[]).map(toChannel);
  }

  private requireChannel(id: number): void {
    if (!this.db.prepare('SELECT 1 FROM channels WHERE id = ?').get(id)) {
      throw new NotFoundError(`Channel ${id} not found`);
    }
  }

  listContent(channelId: number, stages?: Stage[]): ContentItem[] {
    const filter = stages?.length ? ` AND stage IN (${stages.map(() => '?').join(',')})` : '';
    const rows = this.db
      .prepare(`SELECT * FROM content_items WHERE channel_id = ?${filter} ORDER BY updated_at DESC, id DESC`)
      .all(channelId, ...(stages ?? [])) as unknown as ContentRow[];
    return rows.map(toItem);
  }

  getContent(id: number): ContentItem | null {
    const row = this.db.prepare('SELECT * FROM content_items WHERE id = ?').get(id) as ContentRow | undefined;
    return row ? toItem(row) : null;
  }

  private requireContent(id: number): ContentItem {
    const item = this.getContent(id);
    if (!item) throw new NotFoundError(`Content ${id} not found`);
    return item;
  }

  createContent(channelId: number, d: ContentDraft): ContentItem {
    this.requireChannel(channelId);
    const id = this.tx(() => {
      const res = this.db
        .prepare('INSERT INTO content_items (channel_id, title, summary, research_notes, script) VALUES (?,?,?,?,?)')
        .run(channelId, d.title, d.summary ?? '', d.researchNotes ?? '', d.script ?? '');
      const newId = Number(res.lastInsertRowid);
      this.db.prepare(`INSERT INTO stage_history (content_id, from_stage, to_stage) VALUES (?, NULL, 'idea')`).run(newId);
      return newId;
    });
    return this.requireContent(id);
  }

  updateContent(id: number, p: ContentPatch): ContentItem {
    this.requireContent(id);
    const keys = (Object.keys(PATCH_COLUMNS) as (keyof ContentPatch)[]).filter((k) => p[k] !== undefined);
    if (keys.length) {
      const set = keys.map((k) => `${PATCH_COLUMNS[k]} = ?`).join(', ');
      this.db
        .prepare(`UPDATE content_items SET ${set}, updated_at = ${NOW} WHERE id = ?`)
        .run(...keys.map((k) => p[k] as string), id);
    }
    return this.requireContent(id);
  }

  moveContent(id: number, to: Stage): ContentItem {
    const item = this.requireContent(id);
    if (!canTransition(item.stage, to)) {
      throw new WorkflowError(`Cannot move from ${item.stage} to ${to}`);
    }
    this.tx(() => {
      this.db.prepare(`UPDATE content_items SET stage = ?, updated_at = ${NOW} WHERE id = ?`).run(to, id);
      this.db
        .prepare('INSERT INTO stage_history (content_id, from_stage, to_stage) VALUES (?,?,?)')
        .run(id, item.stage, to);
    });
    return this.requireContent(id);
  }

  deleteContent(id: number): void {
    this.requireContent(id);
    this.db.prepare('DELETE FROM content_items WHERE id = ?').run(id);
  }

  stageHistory(id: number): { from: Stage | null; to: Stage; at: string }[] {
    const rows = this.db
      .prepare('SELECT from_stage, to_stage, changed_at FROM stage_history WHERE content_id = ? ORDER BY id')
      .all(id) as unknown as { from_stage: Stage | null; to_stage: Stage; changed_at: string }[];
    return rows.map((r) => ({ from: r.from_stage, to: r.to_stage, at: r.changed_at }));
  }

  stageCounts(channelId: number): StageCounts {
    const counts = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
    const rows = this.db
      .prepare('SELECT stage, COUNT(*) AS n FROM content_items WHERE channel_id = ? GROUP BY stage')
      .all(channelId) as unknown as { stage: Stage; n: number }[];
    let total = 0;
    for (const r of rows) {
      counts[r.stage] = Number(r.n);
      total += Number(r.n);
    }
    return { channelId, counts, total };
  }
}
