import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/main/db/database';
import { ProductionRepository } from '../src/main/db/productions';
import { OperationsRepository } from '../src/main/db/operations';
import { AuditLedger } from '../src/main/audit/ledger';
import { ProductionRunner } from '../src/main/pipeline/runner';
import { DuplicateJobError, JobRepository } from '../src/main/automation/jobs';
import { CircuitBreakers } from '../src/main/automation/circuit';
import { OperatingEngine } from '../src/main/autonomy/engine';
import { TopicRepository } from '../src/main/business/topics';
import { resolveFfmpeg } from '../src/main/media/ffmpeg';
import { DEFAULT_SETTINGS } from '../src/shared/production';
import type { ProductionActionEvent } from '../src/shared/automation';

let db: DatabaseSync;
let repo: ProductionRepository;
let ops: OperationsRepository;
let audit: AuditLedger;
let jobs: JobRepository;
let dir: string;
let frozen: string | null;

// Research that finds nothing: the production stops at the evidence gate (a content failure).
const noSources = { id: 'wikipedia', label: 'Wikipedia', category: 'background', healthUrl: 'http://127.0.0.1:9/', search: async () => [] };
const makeRunner = () =>
  new ProductionRunner({
    repo,
    jobs,
    audit,
    ops,
    productionsDir: dir,
    settings: () => ({ ...DEFAULT_SETTINGS, researchProviders: ['wikipedia'] }),
    providers: () => ({ research: [noSources], writer: null, narration: null, visuals: [] }) as never,
    ffmpeg: () => resolveFfmpeg(''),
    channel: () => ({ name: 'AI, Actually', niche: 'AI' }),
    emit: () => {},
    frozen: () => frozen
  });
const actions = (pid: number) =>
  (db.prepare("SELECT actor, data FROM audit_events WHERE type = 'production.action' AND production_id = ? ORDER BY id").all(pid) as { actor: string; data: string }[]).map((r) => JSON.parse(r.data) as ProductionActionEvent);

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = new ProductionRepository(db);
  ops = new OperationsRepository(db);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-'));
  audit = new AuditLedger(db, path.join(dir, 'evidence'));
  jobs = new JobRepository(db);
  frozen = null;
});

describe('audit of every production action', () => {
  it('records queue, start and failure with initiator, job id, stage and the state before and after', async () => {
    const runner = makeRunner();
    const p = repo.create(1, 'a topic with no sources', null, '');
    runner.enqueue(p.id, 'user', 'test run');
    await runner.idle();
    const a = actions(p.id);
    expect(a.map((x) => [x.action, x.initiator, x.outcome])).toEqual([
      ['queue', 'user', 'requested'],
      ['start', 'user', 'started'],
      ['fail', 'user', 'failed']
    ]);
    const jobId = a[0].jobId!;
    expect(a.every((x) => x.jobId === jobId)).toBe(true);
    expect(a[2]).toMatchObject({ stage: 'research', failureKind: 'content', reason: 'no-sources', resulting: { status: 'failed' } });
    expect(a[1].previous).toMatchObject({ status: 'queued' });
    expect(jobs.get(jobId)).toMatchObject({ status: 'failed', failureKind: 'content', initiator: 'user', kind: 'produce' });
    // Events carry the production's business and are part of the tamper-evident chain.
    const row = db.prepare("SELECT business_id FROM audit_events WHERE type = 'production.action' AND production_id = ? LIMIT 1").get(p.id) as { business_id: number };
    expect(row.business_id).toBe(1);
    expect(audit.verify().ok).toBe(true);
  });

  it('records retries, re-runs, cancellations, refusals and deletions; a retry re-runs the failed gate', async () => {
    const runner = makeRunner();
    const p = repo.create(1, 'still no sources', null, '');
    runner.enqueue(p.id);
    await runner.idle();
    runner.retry(p.id, 'scheduler', 'automatic retry 1');
    await runner.idle();
    expect(repo.get(p.id)).toMatchObject({ status: 'failed', failure: { kind: 'content', code: 'no-sources' } }); // gate evaluated again, not bypassed
    runner.rerun(p.id, 'research', 'user');
    await runner.idle();
    frozen = 'audio pipeline not verified';
    expect(() => runner.retry(p.id, 'user')).toThrow(/frozen/);
    frozen = null;
    runner.delete(p.id);
    const a = actions(p.id).map((x) => `${x.action}:${x.initiator}:${x.outcome}`);
    expect(a).toEqual(expect.arrayContaining(['retry:scheduler:requested', 'start:scheduler:started', 'fail:scheduler:failed', 'rerun:user:requested', 'refuse:user:refused', 'delete:user:succeeded']));
    expect(jobs.list(1).map((j) => `${j.kind}:${j.initiator}:${j.status}`)).toEqual(['rerun:user:failed', 'retry:scheduler:failed', 'produce:user:failed']);
  });
});

describe('duplicate-run prevention', () => {
  it('refuses a second active job before anything is reset, at the app and at the database level', () => {
    const runner = makeRunner();
    const p = repo.create(1, 'busy', null, '');
    repo.update(p.id, { status: 'failed', error: 'x' });
    repo.update(p.id, { storyboard: { title: 'kept', scenes: [] } as never });
    const active = jobs.create({ productionId: p.id, businessId: 1, kind: 'retry', initiator: 'scheduler' });
    expect(() => runner.rerun(p.id, 'script', 'user')).toThrow(/already has an active job/);
    expect(repo.get(p.id).storyboard).toMatchObject({ title: 'kept' }); // nothing was discarded
    expect(() => jobs.create({ productionId: p.id, businessId: 1, kind: 'produce', initiator: 'user' })).toThrow(DuplicateJobError);
    expect(() => db.prepare("INSERT INTO production_jobs (production_id, production_number, business_id, kind, initiator, status) VALUES (?, ?, 1, 'produce', 'user', 'queued')").run(p.id, p.id)).toThrow(/UNIQUE/);
    expect(actions(p.id).at(-1)).toMatchObject({ action: 'refuse', outcome: 'refused' });
    jobs.finish(active.id, 'failed', 'x');
    expect(jobs.create({ productionId: p.id, businessId: 1, kind: 'rerun', initiator: 'user' }).status).toBe('queued');
  });
});

describe('recovery, stalls and expiry', () => {
  it('closes jobs interrupted by a crash, marks the production retryable and keeps its history', () => {
    const runner = makeRunner();
    const p = repo.create(1, 'crashed', null, '');
    const j = jobs.create({ productionId: p.id, businessId: 1, kind: 'produce', initiator: 'automation' });
    jobs.start(j.id);
    repo.update(p.id, { status: 'running', currentStep: 'script', storyboard: { title: 'kept', scenes: [] } as never });
    const r = runner.recoverAfterRestart();
    expect(r.interrupted).toEqual([p.id]);
    expect(jobs.get(j.id)).toMatchObject({ status: 'interrupted', failureKind: 'transient' });
    expect(repo.get(p.id)).toMatchObject({ status: 'failed', failure: { kind: 'transient', code: 'interrupted' }, storyboard: { title: 'kept' } });
    expect(actions(p.id).at(-1)).toMatchObject({ action: 'interrupt', initiator: 'recovery', jobId: j.id });
  });

  it('marks a production unsafe when its last job had already ended but it still claims to be running', () => {
    const runner = makeRunner();
    const p = repo.create(1, 'inconsistent', null, '');
    const j = jobs.create({ productionId: p.id, businessId: 1, kind: 'produce', initiator: 'user' });
    jobs.finish(j.id, 'succeeded');
    repo.update(p.id, { status: 'running', currentStep: 'render' });
    expect(runner.recoverAfterRestart().unsafe).toEqual([p.id]);
    expect(repo.get(p.id).failure).toEqual({ kind: 'unsafe', code: 'inconsistent-state' });
  });

  it('expires queued jobs that never started and records stalled jobs', () => {
    const runner = makeRunner();
    const a = repo.create(1, 'waiting', null, '');
    const ja = jobs.create({ productionId: a.id, businessId: 1, kind: 'produce', initiator: 'user' });
    db.prepare("UPDATE production_jobs SET created_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(ja.id);
    const b = repo.create(1, 'stuck', null, '');
    const jb = jobs.create({ productionId: b.id, businessId: 1, kind: 'produce', initiator: 'user' });
    jobs.start(jb.id);
    db.prepare("UPDATE production_jobs SET heartbeat_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(jb.id);
    const r = runner.checkOverdue({ stallMs: 60_000, queuedExpiryMs: 3_600_000 });
    expect(r).toEqual({ stalled: [jb.id], expired: [ja.id] });
    expect(jobs.get(ja.id).status).toBe('expired');
    expect(repo.get(a.id)).toMatchObject({ status: 'cancelled' });
    expect(jobs.get(jb.id).status).toBe('stalled');
    expect(actions(a.id).at(-1)).toMatchObject({ action: 'expire', initiator: 'system' });
  });
});

describe('scheduler: bounded retries and gate halts', () => {
  const engineFor = (retries: number[]) => {
    const topics = new TopicRepository(db);
    const runner = {
      busy: () => false,
      enqueue: () => undefined,
      retry: (id: number, initiator: string) => {
        retries.push(id);
        const j = jobs.create({ productionId: id, businessId: 1, kind: 'retry', initiator: initiator as 'scheduler' });
        jobs.finish(j.id, 'failed', 'again', 'transient');
      }
    };
    let now = new Date('2026-11-28T12:00:00Z').getTime();
    const engine = new OperatingEngine({ ops, productions: repo, runner: runner as never, audit, topics, jobs, now: () => new Date(now), tickMs: 3_600_000, discover: async () => ({ items: 0, candidates: [], sourceReports: [] }) });
    return { engine, advance: (ms: number) => (now += ms) };
  };
  const autonomous = (failure: { kind: string; code: string }) => {
    const { idea } = ops.upsertIdea({ brandId: 1, topic: 'AI story', headline: 'AI story', mode: 'news', signals: [{ title: 'AI story', url: 'https://x/1', publisher: 'x', kind: 'reporting', provider: 't' }], score: 90, scoreDetail: { freshness: 1, coverage: 1, primarySource: 1, nicheFit: 1, novelty: 1, total: 90, notes: [] }, fingerprint: `f${Math.random()}` });
    const p = repo.create(1, 'AI story', null, '', 'news', { origin: 'autonomous', ideaId: idea.id });
    ops.decideIdea(idea.id, 'selected', 'test', p.id);
    repo.update(p.id, { status: 'failed', error: 'x', failure: failure as never });
    db.prepare("UPDATE productions SET updated_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(p.id);
    return { p, idea };
  };

  it('retries a transient failure at most the configured number of times, then gives up', () => {
    ops.saveReliability({ ...ops.getReliability(), maxAutomaticRetries: 2, retryBackoffMinutes: 1 });
    const retries: number[] = [];
    const { engine, advance } = engineFor(retries);
    const { p, idea } = autonomous({ kind: 'transient', code: 'error' });
    for (let i = 0; i < 6; i++) {
      engine.retryFailed(1);
      db.prepare("UPDATE productions SET updated_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(p.id);
      advance(3_600_000);
    }
    expect(retries).toEqual([p.id, p.id]);
    expect(ops.getIdea(idea.id)).toMatchObject({ status: 'failed' });
    expect(ops.getIdea(idea.id).decision).toMatch(/gave up after 2 automatic retries/);
  });

  for (const kind of ['rights', 'content', 'audio', 'unsafe']) {
    it(`a ${kind} gate failure is never retried and halts automation for the business`, async () => {
      const retries: number[] = [];
      const { engine } = engineFor(retries);
      const { p } = autonomous({ kind, code: 'gate' });
      engine.retryFailed(1);
      expect(retries).toEqual([]);
      expect(ops.getAutomationHalt(1)).toMatchObject({ productionId: p.id, failureKind: kind });
      const types = (db.prepare('SELECT type FROM audit_events').all() as { type: string }[]).map((r) => r.type);
      expect(types).toContain('automation.halted');
      // While halted, a scheduling pass starts and retries nothing.
      ops.saveAutonomy(1, { ...ops.getAutonomy(1), enabled: true });
      const before = repo.list(1).length;
      await engine.tick(true);
      expect(repo.list(1).length).toBe(before);
      expect(retries).toEqual([]);
    });
  }
});

describe('circuit breakers', () => {
  it('open after repeated failures, allow one trial after the cooldown, and close on success', () => {
    let now = 0;
    const changes: string[] = [];
    const b = new CircuitBreakers(() => ({ threshold: 3, cooldownMs: 1000 }), (s, st) => changes.push(`${s}:${st}`), () => now);
    b.failure('comfyui', 'oom');
    b.failure('comfyui', 'oom');
    expect(b.allows('comfyui')).toBe(true);
    b.failure('comfyui', 'oom');
    expect(b.allows('comfyui')).toBe(false);
    now = 1500;
    expect(b.state('comfyui')).toBe('half-open');
    b.failure('comfyui', 'still failing');
    expect(b.allows('comfyui')).toBe(false); // a failed trial re-opens it
    now = 3000;
    b.success('comfyui');
    expect(b.state('comfyui')).toBe('closed');
    expect(changes).toEqual(['comfyui:open', 'comfyui:open', 'comfyui:closed']);
  });
});

describe('script length calibration (Production 23)', () => {
  it('measures the current voice speaking rate from recent narration; falls back when there is too little history', () => {
    const runner = makeRunner();
    expect(runner.measuredWordsPerSec(1)).toBeNull();
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
    for (const [voice, w, secs] of [['kokoro:af_heart', 140, 49.28], ['kokoro:af_heart', 137, 48.2], ['piper:old', 200, 100]] as const) {
      const p = repo.create(1, `t ${voice} ${w}`, null, '');
      repo.update(p.id, { storyboard: { title: 't', scenes: [{ index: 0, role: 'fact', narration: words(w) }] } as never });
      repo.addAsset(p.id, { kind: 'narration', sceneIndex: 0, path: 'a.wav', provider: 'x', meta: { durationSec: secs, voice } });
      if (voice === 'piper:old') db.prepare("UPDATE productions SET updated_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(p.id);
    }
    // Only the current voice (the most recent production's) counts: (140+137) / (49.28+48.2) ≈ 2.84 words/s.
    expect(runner.measuredWordsPerSec(1)).toBeCloseTo(2.84, 2);
  });
});
