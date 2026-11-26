import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/main/db/database';
import { OperationsRepository } from '../src/main/db/operations';
import { ProductionRepository } from '../src/main/db/productions';
import { AuditLedger } from '../src/main/audit/ledger';
import { OperatingEngine } from '../src/main/autonomy/engine';
import { clusterItems, deriveTopic, discover, scoreCluster, type DiscoveredItem, type DiscoverySource } from '../src/main/autonomy/discovery';
import { FinancialAuthorizationRequired, requireFinancialAuthorization } from '../src/main/finance';
import { embeddable } from '../src/main/library';
import { buildClaims, buildEvidenceBrief } from '../src/main/research/evidence';
import { summarise } from '../src/main/qa/engine';
import { wordErrorRate } from '../src/main/qa/asr';
import { buildMetadata } from '../src/main/publishing/metadata';
import type { AudioTrack, Production } from '../src/shared/production';
import type { QaFinding } from '../src/shared/operations';
import { SOURCES } from './fixtures';

let db: DatabaseSync;
let ops: OperationsRepository;
let productions: ProductionRepository;
let audit: AuditLedger;
let brand: number;
let evidenceDir: string;

beforeEach(() => {
  db = openDatabase(':memory:');
  ops = new OperationsRepository(db);
  productions = new ProductionRepository(db);
  evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-ev-'));
  audit = new AuditLedger(db, evidenceDir);
  brand = ops.brandIds()[0];
});

describe('audit ledger', () => {
  it('chains events and verifies them', () => {
    audit.record({ actor: 'engine', type: 'a', data: { x: 1 } });
    audit.record({ actor: 'user', type: 'b', productionId: 3, data: { y: [1, 2] } });
    const ev = audit.events();
    expect(ev).toHaveLength(2);
    expect(audit.verify()).toMatchObject({ ok: true, events: 2 });
  });

  it('is append-only: updates and deletes are refused by the database', () => {
    audit.record({ actor: 'engine', type: 'a', data: {} });
    expect(() => db.exec("UPDATE audit_events SET type = 'forged'")).toThrow();
    expect(() => db.exec('DELETE FROM audit_events')).toThrow();
  });

  it('detects tampering even if the triggers are bypassed', () => {
    audit.record({ actor: 'engine', type: 'a', data: { v: 1 } });
    audit.record({ actor: 'engine', type: 'b', data: { v: 2 } });
    db.exec('DROP TRIGGER audit_no_update');
    db.exec(`UPDATE audit_events SET data = '{"v":99}' WHERE type = 'a'`);
    const v = audit.verify();
    expect(v.ok).toBe(false);
  });

  it('retains evidence content-addressed and de-duplicated', () => {
    const h1 = audit.retain('source-text', 'hello world', 'https://example.org', 'text/plain');
    const h2 = audit.retain('source-text', 'hello world', 'https://example.org', 'text/plain');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(audit.readEvidence(h1)).toMatchObject({ intact: true, sourceUrl: 'https://example.org' });
    expect(audit.readEvidence(h1)?.content.toString()).toBe('hello world');
  });

  it('writes a production report that states it is not a licence guarantee', () => {
    const p = productions.create(brand, 'Topic', null, '', 'news');
    audit.record({ actor: 'engine', type: 'asset.visual', productionId: p.id, data: { key: 'k', licence: 'CC BY 4.0' } });
    const r = audit.productionReport(p.id);
    expect(r.markdown).toMatch(/not a guarantee/i);
    expect((r.json as { events: unknown[] }).events.length).toBeGreaterThan(0);
  });
});

describe('accounts and destinations', () => {
  it('seeds private, account-less destinations with explicit blockers', () => {
    const d = ops.resolveDestinations(brand);
    expect(d.map((x) => x.platform)).toEqual(['tiktok']);
    expect(d[0].privacy).toBe('private');
    expect(d[0].blockers.join(' ')).toMatch(/no tiktok account is assigned/i);
  });

  it('never grants financial capability and never falls back to another account', () => {
    const a = ops.addAccount('tiktok', '@first');
    ops.addAccount('tiktok', '@second');
    ops.updateAccountAuth(a.id, { status: 'connected', capabilities: { canPublishPrivate: true, canPublishPublic: true, financial: true as false, restrictions: [] } });
    expect(ops.getAccount(a.id).capabilities.financial).toBe(false);
    // Connected accounts exist, but the brand destination has none assigned: still blocked.
    expect(ops.resolveDestinations(brand)[0].blockers.length).toBeGreaterThan(0);
    ops.setDestination(brand, 'tiktok', { accountId: a.id, enabled: true, privacy: 'private' });
    const [t] = ops.resolveDestinations(brand);
    expect(t.handle).toBe('@first');
    expect(t.blockers).toEqual([]);
    ops.disconnectAccount(a.id);
    expect(ops.getAccount(a.id).status).toBe('not_connected');
    expect(ops.readToken(a.id)).toBeNull();
    expect(ops.resolveDestinations(brand)[0].blockers.join(' ')).toMatch(/not connected/i);
  });

  it('keeps Kokoro Heart as the AI, Actually presenter regardless of global settings', () => {
    expect(ops.brandPresenter(brand)).toEqual({ engine: 'sherpa', voice: 'af_heart' });
  });

  it('refuses every financial action', () => {
    expect(() => requireFinancialAuthorization('boost post')).toThrow(FinancialAuthorizationRequired);
  });
});

const item = (title: string, publisher: string, hoursAgo: number, kind = 'news'): DiscoveredItem => ({
  title, url: `https://${publisher}.example/${encodeURIComponent(title)}`, publisher, kind, provider: 'test',
  publishedAt: new Date(Date.now() - hoursAgo * 3600_000).toISOString(), summary: title
});

describe('discovery and scoring', () => {
  const items = [
    item('OpenAI releases GPT-6 reasoning model', 'openai', 2, 'primary'),
    item('OpenAI GPT-6 launches with new reasoning model', 'verge', 4),
    item('GPT-6 from OpenAI: what the reasoning model can do', 'arstechnica', 6),
    item('Best laptop deals for Black Friday', 'deals', 1),
    item('Gardening tips for winter', 'garden', 3),
    item('The Download: AI power boom and a consciousness check', 'techreview', 2)
  ];

  it('clusters coverage of the same story', () => {
    const clusters = clusterItems(items);
    const big = clusters.find((c) => c.length === 3);
    expect(big).toBeTruthy();
    expect(deriveTopic(big!).topic).toMatch(/GPT-6|OpenAI/);
  });

  it('scores a fresh, multi-source, primary, on-niche story above a stale off-niche one', () => {
    const [big] = clusterItems(items).sort((a, b) => b.length - a.length);
    const good = scoreCluster(big, ['ai', 'model', 'openai'], []);
    const bad = scoreCluster([item('Gardening tips for winter', 'garden', 150)], ['ai', 'model'], []);
    expect(good.total).toBeGreaterThan(bad.total + 30);
    const repeat = scoreCluster(big, ['ai', 'model', 'openai'], ['OpenAI GPT-6 reasoning model']);
    expect(repeat.total).toBeLessThan(good.total);
  });

  it('drops commerce posts and survives a failing source', async () => {
    const ok: DiscoverySource = { id: 'ok', fetch: async () => items };
    const broken: DiscoverySource = { id: 'broken', fetch: async () => { throw new Error('offline'); } };
    const res = await discover([ok, broken], ['ai', 'model', 'openai'], [], new AbortController().signal);
    expect(res.candidates.some((c) => /deals|The Download/i.test(c.headline))).toBe(false);
    expect(res.sourceReports.find((r) => r.id === 'broken')?.ok).toBe(false);
    expect(res.candidates[0].topic).toMatch(/GPT-6|OpenAI/);
  });
});

function fakeRunner() {
  const queued: number[] = [];
  return { queued, busy: () => queued.length > 0, enqueue: (id: number) => queued.push(id), retry: (id: number) => queued.push(id) };
}

describe('operating engine', () => {
  const cand = (topic: string, score: number) => ({
    topic, headline: topic, mode: 'news' as const, score, fingerprint: topic.toLowerCase(),
    signals: [{ title: topic, url: 'https://x.example', publisher: 'x', kind: 'news', provider: 'test' }],
    scoreDetail: { freshness: 0, coverage: 0, primarySource: 0, nicheFit: 0, novelty: 0, total: score, notes: [] as string[] }
  });
  const make = (hour: number, runner = fakeRunner()) =>
    new OperatingEngine({
      ops, productions, audit, runner: runner as never, tickMs: 3600_000,
      now: () => new Date(2026, 10, 26, hour),
      discover: async () => ({ items: 3, candidates: [cand('Low story', 40), cand('Top story', 80), cand('Mid story', 60)], sourceReports: [{ id: 'fake', ok: true, items: 3 }] })
    });

  it('discovers, selects the best idea and creates a destination-assigned autonomous production', async () => {
    ops.saveAutonomy({ ...ops.getAutonomy(), enabled: true });
    const runner = fakeRunner();
    const engine = make(12, runner);
    engine.start();
    await engine.tick();
    await engine.stop('test');
    expect(runner.queued).toHaveLength(1);
    const p = productions.get(runner.queued[0]) as Production;
    expect(p.topic).toBe('Top story');
    expect(p.origin).toBe('autonomous');
    expect(p.destinations[0].platform).toBe('tiktok');
    expect(ops.listIdeas(brand, 'new').map((i) => i.topic)).toEqual(['Mid story', 'Low story']);
    expect(audit.events().map((e) => e.type)).toEqual(expect.arrayContaining(['discovery.run', 'idea.discovered', 'idea.selected', 'production.destination']));
    expect(audit.verify().ok).toBe(true);
  });

  it('respects active hours, the daily limit and the minimum score', async () => {
    ops.saveAutonomy({ ...ops.getAutonomy(), enabled: true, maxProductionsPerDay: 1 });
    const night = fakeRunner();
    await make(3, night).tick(true);
    expect(night.queued).toHaveLength(0);

    const day = fakeRunner();
    const engine = make(12, day);
    await engine.tick(true);
    expect(day.queued).toHaveLength(1);
    day.queued.length = 0; // pretend the first production finished
    expect(engine.maybeStartProduction(brand)).toBeNull(); // daily limit reached

    ops.saveAutonomy({ ...ops.getAutonomy(), maxProductionsPerDay: 5, minIdeaScore: 90 });
    expect(engine.maybeStartProduction(brand)).toBeNull(); // nothing scores 90
  });

  it('does nothing while disabled, recovers interrupted runs on start and stops cleanly', async () => {
    const runner = fakeRunner();
    const engine = make(12, runner);
    await engine.tick(); // not started and disabled
    expect(runner.queued).toHaveLength(0);
    const id = ops.startRun('discovery:1');
    engine.start();
    expect(engine.isRunning()).toBe(true);
    expect(ops.lastRun('discovery:1')?.status).toBe('interrupted');
    expect(id).toBeGreaterThan(0);
    await engine.stop('test');
    expect(engine.isRunning()).toBe(false);
    expect(audit.events().map((e) => e.type)).toEqual(expect.arrayContaining(['engine.recovered', 'engine.started', 'engine.stopped']));
  });
});

describe('QA, music and writer policy', () => {
  const f = (severity: QaFinding['severity'], passed: boolean): QaFinding => ({ checkId: `c${Math.random()}`, category: 'video', severity, passed, message: '', evidence: {}, repair: '' });

  it('blocks on critical, fails on major and passes otherwise', () => {
    expect(summarise([f('critical', false), f('major', true)]).status).toBe('blocked');
    expect(summarise([f('major', false)]).status).toBe('failed');
    expect(summarise([f('minor', false), f('info', false)]).status).toBe('passed');
  });

  it('measures word error rate for intelligibility', () => {
    expect(wordErrorRate('the model writes code', 'the model writes code')).toBe(0);
    expect(wordErrorRate('the model writes code', 'the motel writes')).toBeCloseTo(0.5);
  });

  it('only auto-selects music cleared for embedded commercial use', () => {
    const t = (usage: AudioTrack['usage'], commercialUse: AudioTrack['commercialUse']) => ({ usage, commercialUse }) as AudioTrack;
    expect(embeddable(t('embedded', 'yes'))).toBe(true);
    expect(embeddable(t('embedded', 'unknown'))).toBe(false);
    expect(embeddable(t('platform_native', 'yes'))).toBe(false);
  });

  it('never narrates first-person source text and respects the word budget', () => {
    const src = [{ ...SOURCES[0], text: 'We propose a new method for agents. Our results show gains. The model scored 91 percent on the benchmark, researchers said.' }];
    const claims = buildClaims(SOURCES[0].title, src as never, 'news');
    expect(claims.some((c) => /\b(we|our)\b/i.test(c.text))).toBe(false);
    const brief = buildEvidenceBrief(SOURCES[0].title, SOURCES, 'AI', 'explainer', 80);
    const words = brief.claims!.reduce((n, c) => n + c.text.split(/\s+/).length, 0);
    expect(words).toBeLessThanOrEqual(80);
  });

  it('builds platform metadata with AI disclosure and manual music steps', () => {
    const p = { id: 1, topic: 'GPT-6 launches', script: { title: 'GPT-6, actually', hook: 'h', scenes: [] }, brief: null, mode: 'news', sources: [], assets: [{ kind: 'music' }] } as unknown as Production;
    const m = buildMetadata(p, { platform: 'tiktok', accountId: null, handle: '', privacy: 'private', blockers: [] }, 'Music: generated', 'AI, Actually');
    expect(m.aiDisclosure).toBe(true);
    expect(m.caption.length).toBeLessThanOrEqual(2200);
    expect(m.manualSteps.join(' ')).toMatch(/no platform-native sound/i);
  });
});

describe('speech-to-text scoring', () => {
  it('treats typographic apostrophes as one word and names leniently', () => {
    expect(wordErrorRate('Nvidia’s code applies.', "NVIDIA's code applies")).toBe(0);
    expect(wordErrorRate('TechCrunch says Huang’s team agreed.', "TechCrunch says Wong's team agreed")).toBeCloseTo(0.5 / 5);
    expect(wordErrorRate('the model writes code', 'the motel writes code')).toBe(0.25);
  });
});
