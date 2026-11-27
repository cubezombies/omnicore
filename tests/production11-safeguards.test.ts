import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/main/db/database';
import { OperationsRepository } from '../src/main/db/operations';
import { ProductionRepository } from '../src/main/db/productions';
import { AuditLedger } from '../src/main/audit/ledger';
import { TopicRepository } from '../src/main/business/topics';
import { OperatingEngine } from '../src/main/autonomy/engine';
import { scoreCluster, type DiscoveredItem } from '../src/main/autonomy/discovery';
import { nicheAnchors, topicRelevance } from '../src/main/autonomy/relevance';

// Production 11: an off-topic war story reached AI, Actually through the generic keyword "attack", was produced
// manually without any warning, and its number was reused by three different productions.

const AI_KEYWORDS = ['GPU', 'chip', 'NVIDIA', 'cybersecurity', 'security', 'attack', 'vulnerability', 'law', 'app', 'tool', 'model', 'release'];
const anchors = nicheAnchors('AI and technology');

describe('topic relevance', () => {
  it('does not let generic keywords make a story about AI', () => {
    const r = topicRelevance('Ukraine downs Russian jet-drone with cheap high-powered laser; the attack used a Shahed', AI_KEYWORDS, anchors);
    expect(r.onTopic).toBe(false);
    expect(r.keywordHits).toEqual(['attack']);
    expect(r.reason).toMatch(/only generic keywords \(attack\) and no AI term/);
    expect(topicRelevance('New delidding tool helps CPU temperatures', AI_KEYWORDS, anchors).onTopic).toBe(false);
  });

  it('accepts stories that name an AI term, and matches "AI" only as a word', () => {
    expect(topicRelevance('Hackers used an AI model to find a security vulnerability', AI_KEYWORDS, anchors)).toMatchObject({ onTopic: true, anchorHits: ['AI'] });
    expect(topicRelevance('OpenAI releases a coding agent', AI_KEYWORDS, anchors).onTopic).toBe(true);
    expect(topicRelevance('NVIDIA chip sales rise as large language models grow', AI_KEYWORDS, anchors).onTopic).toBe(true);
    expect(topicRelevance('Thailand train timetable and Mainland rail', AI_KEYWORDS, anchors).onTopic).toBe(false); // "ai" inside words
  });

  it('keeps keyword-only relevance for businesses whose niche is not AI', () => {
    expect(nicheAnchors('small-business bookkeeping')).toEqual([]);
    expect(topicRelevance('New tax law for sole traders', ['tax', 'law'], []).onTopic).toBe(true);
  });

  it('gives an off-topic cluster no niche fit, so it scores below on-topic stories', () => {
    const item = (title: string): DiscoveredItem => ({ title, summary: '', url: `https://x/${title.length}`, publisher: "Tom's Hardware", kind: 'reporting', provider: 'tech-press', publishedAt: new Date().toISOString() }) as DiscoveredItem;
    const off = scoreCluster([item('Ukraine downs Russian jet-drone in laser attack')], AI_KEYWORDS, [], Date.now(), anchors);
    const on = scoreCluster([item('AI model finds security vulnerability in attack tooling')], AI_KEYWORDS, [], Date.now(), anchors);
    expect(off.nicheFit).toBe(0);
    expect(off.notes).toContain('no AI term (off topic)');
    expect(on.nicheFit).toBeGreaterThan(0);
    expect(on.total).toBeGreaterThan(off.total);
  });
});

function setup() {
  const db = openDatabase(':memory:');
  const ops = new OperationsRepository(db);
  const productions = new ProductionRepository(db);
  const audit = new AuditLedger(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ev-')));
  const topics = new TopicRepository(db);
  const brand = Number((db.prepare("SELECT id FROM channels ORDER BY id LIMIT 1").get() as { id: number }).id);
  db.prepare("UPDATE channels SET niche = 'AI and technology' WHERE id = ?").run(brand);
  return { db, ops, productions, audit, topics, brand };
}

describe('autonomous selection', () => {
  it('never starts an off-topic idea, even with the highest score', async () => {
    const { ops, productions, audit, topics, brand } = setup();
    const signal = (title: string) => [{ title, url: `https://x/${title.length}`, publisher: 'x', kind: 'reporting' as const, provider: 'test' }];
    const detail = (total: number) => ({ freshness: 1, coverage: 1, primarySource: 1, nicheFit: 1, novelty: 1, total, notes: [] });
    ops.upsertIdea({ brandId: brand, topic: 'Ukraine downs Russian jet-drone', headline: 'Ukraine downs Russian jet-drone in laser attack', mode: 'news', signals: signal('Ukraine downs Russian jet-drone in laser attack'), score: 95, scoreDetail: detail(95), fingerprint: 'off' });
    ops.upsertIdea({ brandId: brand, topic: 'OpenAI agent release', headline: 'OpenAI releases an AI agent', mode: 'news', signals: signal('OpenAI releases an AI agent'), score: 70, scoreDetail: detail(70), fingerprint: 'on' });
    ops.saveAutonomy(brand, { ...ops.getAutonomy(brand), enabled: true, minIdeaScore: 65 });
    const queued: number[] = [];
    const engine = new OperatingEngine({
      ops, productions, audit, topics, tickMs: 3600_000,
      runner: { busy: () => queued.length > 0, enqueue: (id: number) => queued.push(id), retry: () => undefined } as never,
      now: () => new Date(2026, 10, 27, 12),
      discover: async () => ({ items: 0, candidates: [], sourceReports: [] })
    });
    const id = engine.maybeStartProduction(brand);
    expect(id).not.toBeNull();
    expect(productions.get(id!).topic).toBe('OpenAI agent release');
    const off = ops.listIdeas(brand).find((i) => i.topic.startsWith('Ukraine'))!;
    expect(engine.ideaRelevance(off.id).onTopic).toBe(false);
  });
});

describe('production numbers and deletion', () => {
  it('never reuses a production number, even after the newest is deleted', () => {
    const { productions, brand } = setup();
    const a = productions.create(brand, 'one', null, '');
    const b = productions.create(brand, 'two', null, '');
    productions.delete(b.id);
    const c = productions.create(brand, 'three', null, '');
    expect(c.id).toBe(b.id + 1);
    expect(a.id).toBeLessThan(b.id);
  });

  it('refuses an insert that would reuse a number', () => {
    const { db, productions, brand } = setup();
    const a = productions.create(brand, 'one', null, '');
    productions.delete(a.id);
    expect(() => db.prepare('INSERT INTO productions (id, channel_id, topic) VALUES (?, ?, ?)').run(a.id, brand, 'reused')).toThrow(/never reused/);
  });

  it('seeds the high-water mark from production numbers seen only in the audit log', () => {
    const { db } = setup();
    // The migration takes the largest of productions, audit_events and ideas; simulate an audit-only number.
    db.exec("UPDATE id_high_water SET max_id = MAX(max_id, 11) WHERE name = 'productions'");
    const { ProductionRepository: PR } = { ProductionRepository };
    const brand = Number((db.prepare('SELECT id FROM channels ORDER BY id LIMIT 1').get() as { id: number }).id);
    expect(new PR(db).create(brand, 'next', null, '').id).toBe(12);
  });
});

describe('idea relevance uses what discovery read', () => {
  it('accepts an idea whose AI term was only in the article summary, but not an old idea without one', () => {
    const { ops, productions, audit, topics, brand } = setup();
    const sig = (title: string) => [{ title, url: `https://x/${title.length}`, publisher: 'x', kind: 'reporting' as const, provider: 'test' }];
    const mk = (topic: string, notes: string[]) => ops.upsertIdea({ brandId: brand, topic, headline: topic, mode: 'news', signals: sig(topic), score: 70, scoreDetail: { freshness: 1, coverage: 1, primarySource: 1, nicheFit: 1, novelty: 1, total: 70, notes }, fingerprint: topic }).idea;
    const engine = new OperatingEngine({ ops, productions, audit, topics, tickMs: 3600_000, runner: { busy: () => false, enqueue: () => undefined, retry: () => undefined } as never, discover: async () => ({ items: 0, candidates: [], sourceReports: [] }) });
    expect(engine.ideaRelevance(mk('Denny touts chip maker CEO', ['AI terms: machine learning']).id)).toMatchObject({ onTopic: true, reason: 'AI terms: machine learning (in the article summaries)' });
    expect(engine.ideaRelevance(mk('Ukraine downs Russian jet-drone', ['brand keywords: attack']).id).onTopic).toBe(false);
  });
});
