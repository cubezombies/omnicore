import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, migrate, openDatabase } from '../src/main/db/database';
import { OperationsRepository } from '../src/main/db/operations';
import { ProductionRepository } from '../src/main/db/productions';
import { AuditLedger } from '../src/main/audit/ledger';
import { reviewGate } from '../src/shared/review';
import { classifyFailure, ProductionFailure } from '../src/main/pipeline/failures';
import { InvalidStoryboardError } from '../src/main/providers/text';
import { NoRecentNewsError } from '../src/main/research/engine';
import { isRetryable } from '../src/shared/failures';
import type { QaFinding } from '../src/shared/operations';

const finding = (checkId: string, passed: boolean, severity: QaFinding['severity'] = 'major', message = checkId): QaFinding => ({ checkId, category: 'video', severity, passed, message, evidence: {}, repair: '' });
const summary = { critical: 0, major: 1, minor: 0, checks: 2, repairs: [] };

function setup() {
  const db = openDatabase(':memory:');
  const ops = new OperationsRepository(db);
  const productions = new ProductionRepository(db);
  const audit = new AuditLedger(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ev-')));
  const brand = Number((db.prepare('SELECT id FROM channels ORDER BY id LIMIT 1').get() as { id: number }).id);
  return { db, ops, productions, audit, brand };
}

describe('review gate (Production 21: QA failed but it read "Ready for your review")', () => {
  const failed = { status: 'failed' as const, findings: [finding('video.duration', false, 'major', 'Duration 60.5 s (target 61–90 s)'), finding('visuals.static', false, 'minor'), finding('audio.loudness', true)] };
  it('a failed QA reads "Needs fixes before approval", names the failing check and cannot be approved', () => {
    const g = reviewGate('awaiting_review', failed);
    expect(g.state).toBe('needs_fixes');
    expect(g.label).toBe('Needs fixes before approval');
    expect(g.canApprove).toBe(false);
    expect(g.failing.map((f) => f.checkId)).toEqual(['video.duration']); // minor findings do not block
    expect(g.reason).toContain('Duration 60.5 s (target 61–90 s)');
  });
  it('only a passed QA reads "Ready for your review"', () => {
    expect(reviewGate('awaiting_review', { status: 'passed', findings: [finding('audio.gate', true, 'critical')] })).toMatchObject({ state: 'ready', label: 'Ready for your review', canApprove: true });
    expect(reviewGate('awaiting_review', undefined)).toMatchObject({ state: 'needs_fixes', canApprove: false });
    expect(reviewGate('blocked', { status: 'blocked', findings: [finding('rights.audio-revalidated', false, 'critical')] })).toMatchObject({ state: 'blocked', canApprove: false });
    expect(reviewGate('approved', { status: 'passed', findings: [] })).toMatchObject({ state: 'approved', canApprove: false });
  });
});

describe('typed failure classification', () => {
  it('classifies by error type, not wording', () => {
    expect(classifyFailure(new ProductionFailure('content', 'insufficient-evidence', 'whatever'))).toEqual({ kind: 'content', code: 'insufficient-evidence' });
    expect(classifyFailure(new InvalidStoryboardError('Storyboard needs at least two fact scenes.'))).toEqual({ kind: 'writer', code: 'invalid-script' });
    expect(classifyFailure(new NoRecentNewsError('x'))).toEqual({ kind: 'content', code: 'no-news-coverage' });
    expect(classifyFailure(new Error('Not enough evidence · never fall back · BLOCKED · not licensed'))).toEqual({ kind: 'transient', code: 'error' });
    expect(classifyFailure(new Error('x'), true)).toEqual({ kind: 'cancelled', code: 'cancelled' });
  });
  it('only content and rights failures are permanent', () => {
    expect(isRetryable({ kind: 'content', code: 'x' })).toBe(false);
    expect(isRetryable({ kind: 'rights', code: 'x' })).toBe(false);
    for (const kind of ['writer', 'transient', 'cancelled'] as const) expect(isRetryable({ kind, code: 'x' })).toBe(true);
    expect(isRetryable(null)).toBe(true);
  });
});

describe('QA history survives production deletion (v15)', () => {
  it('keeps runs, findings, render hash and audit link when the production is deleted, and never reuses a run id', () => {
    const { db, ops, productions, audit, brand } = setup();
    const p19 = productions.create(brand, 'build maintain agentic evaluation', null, '');
    audit.record({ actor: 'pipeline', type: 'render.output', productionId: p19.id, data: { sha256: 'e424bef2', durationSec: 65.63 } });
    const run = ops.saveQaRun(p19.id, 1, 'passed', summary, [finding('video.duration', true), finding('visuals.static', false, 'minor')]);
    const ev = audit.record({ actor: 'pipeline', type: 'qa.run', productionId: p19.id, data: { qaRunId: run.id, round: 1, status: 'passed' } });
    ops.linkQaAudit(run.id, ev.id);
    expect(run).toMatchObject({ productionId: p19.id, productionNumber: p19.id, productionTopic: 'build maintain agentic evaluation', renderSha256: 'e424bef2', productionDeletedAt: null });

    productions.delete(p19.id);
    const kept = ops.qaHistory(brand);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ id: run.id, productionId: null, productionNumber: p19.id, productionTopic: 'build maintain agentic evaluation', renderSha256: 'e424bef2', auditEventId: ev.id, status: 'passed' });
    expect(kept[0].productionDeletedAt).toBeTruthy();
    expect(kept[0].findings).toHaveLength(2);

    // The next production's QA run gets a new id (production 21's runs reused 37 and 38 before v15).
    const p21 = productions.create(brand, 'Has vibe coding open', null, '');
    const next = ops.saveQaRun(p21.id, 1, 'failed', summary, [finding('video.duration', false)]);
    expect(next.id).toBeGreaterThan(run.id);
    expect(ops.qaRuns(p21.id).map((r) => r.id)).toEqual([next.id]);
    expect(ops.qaRuns(p19.id)).toEqual([]);
    db.close();
  });

  it('migrates v14 QA history without losing a finding, backfills snapshots and seeds the id sequence from the audit log', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v15-')), 'old.db');
    const old = new DatabaseSync(file);
    old.exec('PRAGMA foreign_keys = ON');
    for (let v = 0; v < 14; v++) old.exec(MIGRATIONS[v]);
    old.exec('PRAGMA user_version = 14');
    const ch = Number((old.prepare('SELECT id FROM channels LIMIT 1').get() as { id: number }).id);
    const pid = Number(old.prepare("INSERT INTO productions (channel_id, topic) VALUES (?, 'Has vibe coding open')").run(ch).lastInsertRowid);
    const ev = (ts: string, type: string, data: unknown) => Number(old.prepare("INSERT INTO audit_events (ts, actor, type, production_id, data, prev_hash, hash) VALUES (?, 'pipeline', ?, ?, ?, 'x', ?)").run(ts, type, pid, JSON.stringify(data), `${type}-${ts}`).lastInsertRowid);
    ev('2026-11-28T00:09:00Z', 'render.output', { sha256: '23dc6f73' });
    // Three earlier runs of a since-deleted production were saved (and audited) and then cascaded away.
    for (const t of ['01', '02', '03']) ev(`2026-11-27T23:00:${t}Z`, 'qa.run', { round: 1 });
    const qaEv = ev('2026-11-28T00:09:40Z', 'qa.run', { round: 1, status: 'failed' });
    old.prepare("INSERT INTO qa_runs (id, production_id, round, status, summary, started_at, finished_at) VALUES (1, ?, 1, 'failed', '{}', '2026-11-28T00:09:30Z', '2026-11-28T00:09:40Z')").run(pid);
    for (let i = 0; i < 5; i++) old.prepare("INSERT INTO qa_findings (qa_run_id, check_id, category, severity, passed, message) VALUES (1, ?, 'video', 'major', 0, 'm')").run(`c${i}`);
    migrate(old);
    expect(Number((old.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(16);
    expect(Number((old.prepare('SELECT COUNT(*) n FROM qa_findings').get() as { n: number }).n)).toBe(5);
    expect(old.prepare('SELECT production_number, production_topic, render_sha256, audit_event_id, business_id FROM qa_runs WHERE id = 1').get()).toMatchObject({ production_number: pid, production_topic: 'Has vibe coding open', render_sha256: '23dc6f73', audit_event_id: qaEv, business_id: ch });
    expect(old.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'qa_runs'").get()).toMatchObject({ seq: 4 });
    expect((old.prepare('PRAGMA foreign_key_check').all() as unknown[]).length).toBe(0);
    expect(old.prepare("SELECT sql FROM sqlite_master WHERE name = 'qa_findings'").get()).toMatchObject({ sql: expect.stringContaining('REFERENCES "qa_runs"') });
    const next = Number(old.prepare("INSERT INTO qa_runs (production_id, round, status) VALUES (?, 2, 'passed')").run(pid).lastInsertRowid);
    expect(next).toBe(5);
    old.close();
  });
});
