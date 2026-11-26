import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AuditEvent, AuditVerification } from '../../shared/operations';

const GENESIS = '0'.repeat(64);
const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

/** Canonical JSON (sorted keys) so the same event always hashes the same. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v as Record<string, unknown>)
    .sort()
    .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

const eventHash = (e: Omit<AuditEvent, 'id' | 'hash'>) =>
  sha256(canonical({ ts: e.ts, actor: e.actor, type: e.type, subjectType: e.subjectType, subjectId: e.subjectId, productionId: e.productionId, data: e.data, prevHash: e.prevHash }));

export interface AuditInput {
  actor: string;
  type: string;
  subjectType?: string;
  subjectId?: string | number;
  productionId?: number | null;
  data?: Record<string, unknown>;
}

/**
 * Append-only, hash-chained audit ledger plus content-addressed evidence store.
 * It proves what Omnicore checked and relied on at the time — it does not prove a
 * third-party licence was valid.
 */
export class AuditLedger {
  constructor(
    private readonly db: DatabaseSync,
    private readonly evidenceDir: string
  ) {}

  record(e: AuditInput): AuditEvent {
    const last = this.db.prepare('SELECT hash FROM audit_events ORDER BY id DESC LIMIT 1').get() as { hash: string } | undefined;
    const base = {
      ts: new Date().toISOString(),
      actor: e.actor,
      type: e.type,
      subjectType: e.subjectType ?? '',
      subjectId: e.subjectId === undefined ? '' : String(e.subjectId),
      productionId: e.productionId ?? null,
      data: e.data ?? {},
      prevHash: last?.hash ?? GENESIS
    };
    const hash = eventHash(base);
    const res = this.db
      .prepare('INSERT INTO audit_events (ts, actor, type, subject_type, subject_id, production_id, data, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(base.ts, base.actor, base.type, base.subjectType, base.subjectId, base.productionId, canonical(base.data), base.prevHash, hash);
    return { id: Number(res.lastInsertRowid), ...base, hash };
  }

  events(filter: { productionId?: number; subjectType?: string; subjectId?: string; limit?: number } = {}): AuditEvent[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.productionId !== undefined) (where.push('production_id = ?'), args.push(filter.productionId));
    if (filter.subjectType) (where.push('subject_type = ?'), args.push(filter.subjectType));
    if (filter.subjectId) (where.push('subject_id = ?'), args.push(filter.subjectId));
    const rows = this.db
      .prepare(`SELECT * FROM audit_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id ${filter.limit ? `DESC LIMIT ${Math.floor(filter.limit)}` : ''}`)
      .all(...args) as Record<string, unknown>[];
    const out = rows.map((r) => ({
      id: Number(r.id),
      ts: String(r.ts),
      actor: String(r.actor),
      type: String(r.type),
      subjectType: String(r.subject_type),
      subjectId: String(r.subject_id),
      productionId: r.production_id === null ? null : Number(r.production_id),
      data: JSON.parse(String(r.data)) as Record<string, unknown>,
      prevHash: String(r.prev_hash),
      hash: String(r.hash)
    }));
    return filter.limit ? out.reverse() : out;
  }

  /** Recompute every hash and the chain links. Any edit, deletion or reordering is detected. */
  verify(): AuditVerification {
    const rows = this.events();
    let prev = GENESIS;
    for (const e of rows) {
      if (e.prevHash !== prev) return { ok: false, events: rows.length, firstBadId: e.id, reason: `Event ${e.id} does not link to the previous event (chain broken).` };
      if (eventHash(e) !== e.hash) return { ok: false, events: rows.length, firstBadId: e.id, reason: `Event ${e.id} was modified after it was recorded.` };
      prev = e.hash;
    }
    return { ok: true, events: rows.length, firstBadId: null, reason: 'All events verified.' };
  }

  /** Store evidence (licence metadata, source text, script versions) content-addressed; returns its sha256. */
  retain(kind: string, content: string | Buffer, sourceUrl = '', mediaType = 'application/json'): string {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const hash = sha256(buf);
    const rel = path.join(hash.slice(0, 2), hash);
    const file = path.join(this.evidenceDir, rel);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
    }
    this.db.prepare('INSERT OR IGNORE INTO evidence (sha256, kind, source_url, media_type, path, bytes) VALUES (?,?,?,?,?,?)').run(hash, kind, sourceUrl, mediaType, rel.split(path.sep).join('/'), buf.length);
    return hash;
  }

  readEvidence(hash: string): { kind: string; sourceUrl: string; content: Buffer; intact: boolean } | null {
    const r = this.db.prepare('SELECT * FROM evidence WHERE sha256 = ?').get(hash) as Record<string, unknown> | undefined;
    if (!r) return null;
    const content = fs.readFileSync(path.join(this.evidenceDir, String(r.path)));
    return { kind: String(r.kind), sourceUrl: String(r.source_url), content, intact: sha256(content) === hash };
  }

  /** Reverse lookup: every production (and event) that used a given asset key or evidence hash. */
  assetUsage(key: string): { productionId: number | null; type: string; ts: string }[] {
    const like = `%${key.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    return (this.db.prepare(`SELECT production_id, type, ts FROM audit_events WHERE data LIKE ? ESCAPE '\\' AND type LIKE 'asset.%' ORDER BY id`).all(like) as Record<string, unknown>[]).map((r) => ({
      productionId: r.production_id === null ? null : Number(r.production_id),
      type: String(r.type),
      ts: String(r.ts)
    }));
  }

  /** Production-level audit report (Markdown + machine-readable JSON). */
  productionReport(productionId: number): { markdown: string; json: Record<string, unknown> } {
    const events = this.events({ productionId });
    const verification = this.verify();
    const lines = [
      `# Audit report — production ${productionId}`,
      '',
      `Ledger integrity: ${verification.ok ? 'verified' : `FAILED — ${verification.reason}`} (${verification.events} events in ledger).`,
      'This report records what Omnicore checked and relied on. It is not a guarantee that third-party licences are valid.',
      '',
      '| # | Time (UTC) | Actor | Event | Details |',
      '|---|---|---|---|---|',
      ...events.map((e) => `| ${e.id} | ${e.ts.replace('T', ' ').slice(0, 19)} | ${e.actor} | ${e.type} | ${summarise(e.data).replace(/\|/g, '\\|')} |`)
    ];
    return { markdown: `${lines.join('\n')}\n`, json: { productionId, verification, events } };
  }
}

function summarise(d: Record<string, unknown>): string {
  return Object.entries(d)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .slice(0, 6)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v).slice(0, 80) : String(v).slice(0, 80)}`)
    .join('; ');
}
