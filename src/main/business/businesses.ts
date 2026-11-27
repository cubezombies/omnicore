import type { DatabaseSync } from 'node:sqlite';
import { BUSINESS_TYPES, isModuleId, type Business, type BusinessDraft, type BusinessPatch } from '../../shared/business';
import { NotFoundError } from '../db/repository';

type Row = Record<string, unknown>;
const j = <T>(v: unknown, d: T): T => {
  try {
    return typeof v === 'string' && v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
};

export const toBusiness = (r: Row): Business => ({
  id: Number(r.id),
  name: String(r.name),
  slug: String(r.slug),
  niche: String(r.niche ?? ''),
  platforms: j(r.platforms, [] as string[]),
  createdAt: String(r.created_at),
  businessType: (r.business_type as Business['businessType']) ?? 'media',
  modules: j(r.modules, [] as string[]).filter(isModuleId),
  description: String(r.description ?? ''),
  objectives: String(r.objectives ?? ''),
  instructions: String(r.instructions ?? ''),
  accent: String(r.accent ?? '#5eead4'),
  archivedAt: (r.archived_at as string) ?? null,
  presenterEngine: r.presenter_engine === undefined ? undefined : String(r.presenter_engine),
  presenterVoice: r.presenter_voice === undefined ? undefined : String(r.presenter_voice),
  editorial: j(r.editorial, {} as { keywords?: string[] })
});

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'business';

/** Businesses (the channels table). Archiving hides a business and stops its automation; it never deletes data. */
export class BusinessRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(includeArchived = false): Business[] {
    const rows = this.db.prepare(`SELECT * FROM channels ${includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY archived_at IS NOT NULL, id`).all() as Row[];
    return rows.map(toBusiness);
  }
  get(id: number): Business {
    const r = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new NotFoundError(`Business ${id} not found`);
    return toBusiness(r);
  }
  exists(id: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM channels WHERE id = ?').get(id);
  }

  create(d: BusinessDraft): Business {
    const base = slugify(d.name);
    let slug = base;
    for (let n = 2; this.db.prepare('SELECT 1 FROM channels WHERE slug = ?').get(slug); n++) slug = `${base}-${n}`;
    const modules = BUSINESS_TYPES[d.businessType].modules;
    const media = modules.includes('media');
    this.db.exec('BEGIN');
    try {
      const res = this.db
        .prepare('INSERT INTO channels (name, slug, niche, platforms, business_type, modules, description, objectives, accent) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(d.name.trim(), slug, d.niche?.trim() ?? '', JSON.stringify(media ? ['tiktok', 'youtube', 'instagram'] : []), d.businessType, JSON.stringify(modules), d.description?.trim() ?? '', d.objectives?.trim() ?? '', d.accent ?? '#93c5fd');
      const id = Number(res.lastInsertRowid);
      // Media businesses start with disabled, unassigned publishing destinations (nothing publishes until set up).
      if (media) {
        const ins = this.db.prepare("INSERT INTO brand_destinations (brand_id, platform, is_default, enabled, privacy) VALUES (?, ?, 1, 0, 'private')");
        for (const p of ['tiktok', 'youtube', 'instagram']) ins.run(id, p);
      }
      this.db.exec('COMMIT');
      return this.get(id);
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  update(id: number, p: BusinessPatch): Business {
    const b = this.get(id);
    this.db
      .prepare('UPDATE channels SET name=?, description=?, objectives=?, instructions=?, niche=?, accent=?, modules=?, business_type=? WHERE id=?')
      .run(p.name ?? b.name, p.description ?? b.description, p.objectives ?? b.objectives, p.instructions ?? b.instructions, p.niche ?? b.niche, p.accent ?? b.accent, JSON.stringify(p.modules ?? b.modules), p.businessType ?? b.businessType, id);
    return this.get(id);
  }

  archive(id: number): Business {
    this.get(id);
    this.db.prepare(`UPDATE channels SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND archived_at IS NULL`).run(id);
    return this.get(id);
  }
  restore(id: number): Business {
    this.get(id);
    this.db.prepare('UPDATE channels SET archived_at = NULL WHERE id = ?').run(id);
    return this.get(id);
  }
}
