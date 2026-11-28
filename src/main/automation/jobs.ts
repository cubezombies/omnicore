import type { DatabaseSync } from 'node:sqlite';
import type { JobInitiator, JobKind, JobStatus, ProductionJob } from '../../shared/automation';

type Row = Record<string, unknown>;
const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

export class DuplicateJobError extends Error {
  constructor(readonly existing: ProductionJob) {
    super(`Production #${existing.productionNumber} already has an active job (#${existing.id}, ${existing.kind}, ${existing.status}).`);
    this.name = 'DuplicateJobError';
  }
}

const toJob = (r: Row): ProductionJob => ({
  id: Number(r.id),
  productionId: r.production_id === null ? null : Number(r.production_id),
  productionNumber: Number(r.production_number),
  businessId: r.business_id === null ? null : Number(r.business_id),
  kind: r.kind as JobKind,
  fromStep: (r.from_step as string) ?? null,
  initiator: r.initiator as JobInitiator,
  status: r.status as JobStatus,
  reason: String(r.reason ?? ''),
  error: String(r.error ?? ''),
  failureKind: String(r.failure_kind ?? ''),
  createdAt: String(r.created_at),
  startedAt: (r.started_at as string) ?? null,
  heartbeatAt: (r.heartbeat_at as string) ?? null,
  finishedAt: (r.finished_at as string) ?? null
});

/**
 * Production jobs: one row per requested run. A unique index allows only one queued or running job per production,
 * so duplicate runs are refused by the database itself, whichever route asked for them.
 */
export class JobRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(id: number): ProductionJob {
    const r = this.db.prepare('SELECT * FROM production_jobs WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new Error(`Job ${id} not found`);
    return toJob(r);
  }

  active(productionId: number): ProductionJob | null {
    const r = this.db.prepare("SELECT * FROM production_jobs WHERE production_id = ? AND status IN ('queued','running') ORDER BY id DESC LIMIT 1").get(productionId) as Row | undefined;
    return r ? toJob(r) : null;
  }

  latest(productionId: number): ProductionJob | null {
    const r = this.db.prepare('SELECT * FROM production_jobs WHERE production_id = ? ORDER BY id DESC LIMIT 1').get(productionId) as Row | undefined;
    return r ? toJob(r) : null;
  }

  /** Create a queued job. Throws DuplicateJobError when the production already has an active one. */
  create(j: { productionId: number; businessId: number; kind: JobKind; fromStep?: string | null; initiator: JobInitiator; reason?: string }): ProductionJob {
    const existing = this.active(j.productionId);
    if (existing) throw new DuplicateJobError(existing);
    try {
      const r = this.db
        .prepare('INSERT INTO production_jobs (production_id, production_number, business_id, kind, from_step, initiator, status, reason) VALUES (?,?,?,?,?,?,?,?)')
        .run(j.productionId, j.productionId, j.businessId, j.kind, j.fromStep ?? null, j.initiator, 'queued', j.reason ?? '');
      return this.get(Number(r.lastInsertRowid));
    } catch (e) {
      const again = this.active(j.productionId);
      if (again) throw new DuplicateJobError(again);
      throw e;
    }
  }

  start(id: number): void {
    this.db.prepare(`UPDATE production_jobs SET status = 'running', started_at = ${NOW}, heartbeat_at = ${NOW} WHERE id = ? AND status = 'queued'`).run(id);
  }

  heartbeat(id: number): void {
    this.db.prepare(`UPDATE production_jobs SET heartbeat_at = ${NOW} WHERE id = ? AND status = 'running'`).run(id);
  }

  /** Close an active job. Finished jobs are never reopened or rewritten. */
  finish(id: number, status: Exclude<JobStatus, 'queued' | 'running'>, error = '', failureKind = ''): void {
    this.db.prepare(`UPDATE production_jobs SET status = ?, error = ?, failure_kind = ?, finished_at = ${NOW} WHERE id = ? AND status IN ('queued','running')`).run(status, error.slice(0, 2000), failureKind, id);
  }

  list(businessId: number, limit = 50): ProductionJob[] {
    return (this.db.prepare('SELECT * FROM production_jobs WHERE business_id = ? ORDER BY id DESC LIMIT ?').all(businessId, limit) as Row[]).map(toJob);
  }

  /** Running jobs without a heartbeat for longer than maxSilentMs (stalled), and queued jobs older than maxQueuedMs (expired). */
  overdue(maxSilentMs: number, maxQueuedMs: number): { stalled: ProductionJob[]; expired: ProductionJob[] } {
    const iso = (ms: number) => new Date(Date.now() - ms).toISOString();
    return {
      stalled: (this.db.prepare("SELECT * FROM production_jobs WHERE status = 'running' AND heartbeat_at < ?").all(iso(maxSilentMs)) as Row[]).map(toJob),
      expired: (this.db.prepare("SELECT * FROM production_jobs WHERE status = 'queued' AND created_at < ?").all(iso(maxQueuedMs)) as Row[]).map(toJob)
    };
  }

  /** On startup: jobs left running were interrupted by a crash or exit. */
  runningAtStartup(): ProductionJob[] {
    return (this.db.prepare("SELECT * FROM production_jobs WHERE status = 'running'").all() as Row[]).map(toJob);
  }

  /** Scheduler retries of a production since its last user-requested run (for the bounded retry limit). */
  automaticRetries(productionId: number): number {
    const lastUser = this.db.prepare("SELECT max(id) m FROM production_jobs WHERE production_id = ? AND initiator = 'user'").get(productionId) as Row;
    return Number((this.db.prepare("SELECT count(*) n FROM production_jobs WHERE production_id = ? AND kind = 'retry' AND initiator IN ('scheduler','automation') AND id > ?").get(productionId, Number(lastUser.m ?? 0)) as Row).n);
  }
}
