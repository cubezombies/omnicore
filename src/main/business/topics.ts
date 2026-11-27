import type { DatabaseSync } from 'node:sqlite';
import type { Topic, TopicDraft } from '../../shared/business';
import { NotFoundError } from '../db/repository';

type Row = Record<string, unknown>;
const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
const arr = (v: unknown): string[] => {
  try {
    return typeof v === 'string' ? (JSON.parse(v) as string[]) : [];
  } catch {
    return [];
  }
};

const toTopic = (r: Row): Topic => ({
  id: Number(r.id),
  businessId: Number(r.business_id),
  parentId: r.parent_id === null ? null : Number(r.parent_id),
  name: String(r.name),
  description: String(r.description),
  keywords: arr(r.keywords),
  exclusions: arr(r.exclusions),
  priority: Number(r.priority),
  position: Number(r.position),
  enabled: Number(r.enabled) === 1,
  status: r.status as Topic['status'],
  origin: r.origin as Topic['origin'],
  researchPriority: r.research_priority as Topic['researchPriority'],
  discovery: String(r.discovery),
  objectives: String(r.objectives),
  autonomousOk: Number(r.autonomous_ok) === 1,
  approvalRequired: Number(r.approval_required) === 1,
  archivedAt: (r.archived_at as string) ?? null,
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at)
});

export class TopicError extends Error {}

/**
 * A business's topics. Every method takes the owning business and only ever touches that business's rows,
 * so a topic id from another business behaves exactly like a missing one.
 */
export class TopicRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(businessId: number, includeArchived = true): Topic[] {
    const rows = this.db.prepare(`SELECT * FROM topics WHERE business_id = ? ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY parent_id IS NOT NULL, parent_id, position, id`).all(businessId) as Row[];
    return rows.map(toTopic);
  }
  get(businessId: number, id: number): Topic {
    const r = this.db.prepare('SELECT * FROM topics WHERE id = ? AND business_id = ?').get(id, businessId) as Row | undefined;
    if (!r) throw new NotFoundError(`Topic ${id} not found in this business`);
    return toTopic(r);
  }

  create(businessId: number, d: TopicDraft, origin: Topic['origin'] = 'user'): Topic {
    if (d.parentId != null) this.get(businessId, d.parentId); // parent must belong to the same business
    const pos = Number((this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 p FROM topics WHERE business_id = ? AND parent_id IS ?').get(businessId, d.parentId ?? null) as Row).p);
    const res = this.db
      .prepare(
        'INSERT INTO topics (business_id, parent_id, name, description, keywords, exclusions, priority, position, enabled, status, origin, research_priority, discovery, objectives, autonomous_ok, approval_required) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        businessId,
        d.parentId ?? null,
        d.name.trim(),
        d.description ?? '',
        JSON.stringify(d.keywords ?? []),
        JSON.stringify(d.exclusions ?? []),
        d.priority ?? 3,
        pos,
        d.enabled === false ? 0 : 1,
        origin === 'agent' ? 'proposed' : 'active',
        origin,
        d.researchPriority ?? 'normal',
        d.discovery ?? '',
        d.objectives ?? '',
        d.autonomousOk === false ? 0 : 1,
        d.approvalRequired ? 1 : 0
      );
    return this.get(businessId, Number(res.lastInsertRowid));
  }

  update(businessId: number, id: number, p: Partial<TopicDraft>): Topic {
    const t = this.get(businessId, id);
    if (p.parentId !== undefined && p.parentId !== t.parentId && p.parentId !== null) {
      // No cycles: the new parent must not be this topic or one of its descendants.
      for (let cur: number | null = p.parentId; cur !== null; cur = this.get(businessId, cur).parentId) if (cur === id) throw new TopicError('A topic cannot be moved inside itself.');
    }
    this.db
      .prepare(
        `UPDATE topics SET parent_id=?, name=?, description=?, keywords=?, exclusions=?, priority=?, enabled=?, research_priority=?, discovery=?, objectives=?, autonomous_ok=?, approval_required=?, updated_at=${NOW} WHERE id=? AND business_id=?`
      )
      .run(
        p.parentId === undefined ? t.parentId : p.parentId,
        (p.name ?? t.name).trim(),
        p.description ?? t.description,
        JSON.stringify(p.keywords ?? t.keywords),
        JSON.stringify(p.exclusions ?? t.exclusions),
        p.priority ?? t.priority,
        (p.enabled ?? t.enabled) ? 1 : 0,
        p.researchPriority ?? t.researchPriority,
        p.discovery ?? t.discovery,
        p.objectives ?? t.objectives,
        (p.autonomousOk ?? t.autonomousOk) ? 1 : 0,
        (p.approvalRequired ?? t.approvalRequired) ? 1 : 0,
        id,
        businessId
      );
    return this.get(businessId, id);
  }

  /** Reorder siblings: `orderedIds` must be exactly the topic's siblings (same parent, same business). */
  reorder(businessId: number, parentId: number | null, orderedIds: number[]): Topic[] {
    const siblings = this.list(businessId).filter((t) => t.parentId === parentId).map((t) => t.id);
    if (siblings.length !== orderedIds.length || siblings.some((id) => !orderedIds.includes(id))) throw new TopicError('Reorder must list every topic at that level exactly once.');
    const upd = this.db.prepare(`UPDATE topics SET position = ?, updated_at = ${NOW} WHERE id = ? AND business_id = ?`);
    orderedIds.forEach((id, i) => upd.run(i, id, businessId));
    return this.list(businessId);
  }

  archive(businessId: number, id: number): Topic {
    this.get(businessId, id);
    this.db.prepare(`UPDATE topics SET archived_at = ${NOW}, updated_at = ${NOW} WHERE business_id = ? AND (id = ? OR parent_id = ?) AND archived_at IS NULL`).run(businessId, id, id);
    return this.get(businessId, id);
  }
  restore(businessId: number, id: number): Topic {
    const t = this.get(businessId, id);
    if (t.parentId !== null && this.get(businessId, t.parentId).archivedAt) throw new TopicError('Restore the parent topic first.');
    this.db.prepare(`UPDATE topics SET archived_at = NULL, updated_at = ${NOW} WHERE id = ? AND business_id = ?`).run(id, businessId);
    return this.get(businessId, id);
  }

  /** Delete is only allowed for an archived topic with no subtopics, so nothing disappears by accident. */
  delete(businessId: number, id: number): void {
    const t = this.get(businessId, id);
    if (!t.archivedAt) throw new TopicError('Archive the topic before deleting it.');
    if (this.db.prepare('SELECT 1 FROM topics WHERE parent_id = ? AND business_id = ?').get(id, businessId)) throw new TopicError('Delete or move its subtopics first.');
    this.db.prepare('DELETE FROM topics WHERE id = ? AND business_id = ?').run(id, businessId);
  }

  /** Accept or reject an agent-proposed topic. Rejecting deletes the proposal; it never touches active topics. */
  decideProposal(businessId: number, id: number, accept: boolean): Topic | null {
    const t = this.get(businessId, id);
    if (t.status !== 'proposed') throw new TopicError('That topic is not a proposal.');
    if (!accept) {
      this.db.prepare('DELETE FROM topics WHERE id = ? AND business_id = ?').run(id, businessId);
      return null;
    }
    this.db.prepare(`UPDATE topics SET status = 'active', updated_at = ${NOW} WHERE id = ? AND business_id = ?`).run(id, businessId);
    return this.get(businessId, id);
  }

  /** What autonomous discovery may use: enabled, active, unarchived topics that allow autonomous exploration. */
  discoveryProfile(businessId: number): { keywords: string[]; exclusions: string[]; approvalKeywords: string[] } {
    const live = this.list(businessId, false).filter((t) => t.enabled && t.status === 'active');
    const auto = live.filter((t) => t.autonomousOk);
    return {
      keywords: [...new Set(auto.flatMap((t) => [t.name, ...t.keywords]))],
      exclusions: [...new Set(live.flatMap((t) => t.exclusions))],
      approvalKeywords: [...new Set(live.filter((t) => t.approvalRequired).flatMap((t) => [t.name, ...t.keywords]))]
    };
  }
}
