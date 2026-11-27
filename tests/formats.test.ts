import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/main/db/database';
import { ProductionRepository } from '../src/main/db/productions';
import { buildMessages, ExtractiveWriter, lengthProblem, wordBudget } from '../src/main/providers/writers';
import { validateStoryboard } from '../src/main/providers/text';
import { buildEvidenceBrief } from '../src/main/research/evidence';
import { newProduction } from '../src/main/validation';
import { PRODUCTION_FORMATS, type Storyboard } from '../src/shared/production';
import { SOURCES } from './fixtures';

const sb = (words: number): Storyboard => ({ title: 't', writer: 'w', scenes: [{ index: 0, role: 'fact', narration: Array(words).fill('word').join(' '), onScreenText: '', visualQuery: '', sourceIds: [] }] }) as unknown as Storyboard;

describe('production formats', () => {
  it('sizes the standard format for 65–120 s at the voice’s natural speed and keeps shorts under a minute', () => {
    const short = wordBudget('short', 2.15);
    const std = wordBudget('standard', 2.15);
    expect(short.maxWords / 2.15).toBeLessThan(60);
    expect(std.minWords / 2.15).toBeGreaterThanOrEqual(65);
    expect(std.maxWords / 2.15).toBeLessThanOrEqual(110); // leaves room for pauses and scene padding under 120 s
  });

  it('rejects scripts outside the format’s word range, telling the writer never to pad', () => {
    expect(lengthProblem(sb(200), 140)).toMatch(/at most 140 .* under 60 seconds/);
    expect(lengthProblem(sb(100), 230, 142, 'standard')).toMatch(/at least 142 .* 65–120 seconds.*never pad/);
    expect(lengthProblem(sb(180), 230, 142, 'standard')).toBeNull();
  });

  it('briefs and prompts the writer for the standard format', () => {
    const brief = buildEvidenceBrief(SOURCES[0].title, SOURCES, 'AI', 'explainer', 230, 'standard', 142);
    expect(brief).toMatchObject({ format: 'standard', minWords: 142, maxWords: 230 });
    const prompt = buildMessages({ brief, sources: SOURCES, channelName: 'AI, Actually' }).map((m) => m.content).join('\n');
    expect(prompt).toMatch(/65-120 second/);
    expect(prompt).toMatch(/Total narration 142-220 words/);
    expect(prompt).toMatch(/5 to 8 fact scenes/);
    const shortPrompt = buildMessages({ brief: buildEvidenceBrief(SOURCES[0].title, SOURCES, 'AI', 'explainer', 140), sources: SOURCES, channelName: 'AI, Actually' }).map((m) => m.content).join('\n');
    expect(shortPrompt).toMatch(/45-60 second/);
    expect(shortPrompt).toMatch(/under 60 seconds/);
  });

  it('lets a standard storyboard use up to 12 scenes (hook, up to 10 claims, outro) and keeps shorts at 10', async () => {
    const brief = buildEvidenceBrief(SOURCES[0].title, SOURCES, 'AI', 'explainer', 300, 'standard', 142);
    const sb = (await new ExtractiveWriter().write({ brief, sources: SOURCES, channelName: 'AI, Actually' })).storyboard;
    expect(sb.scenes.length).toBeLessThanOrEqual(12);
    const scenes = (n: number) => ({ title: 't', writer: 'w', scenes: Array.from({ length: n }, (_, i) => ({ index: i, role: i === 0 ? 'hook' : i === n - 1 ? 'outro' : 'fact', narration: 'x', onScreenText: '', visualQuery: '', sourceIds: i === 0 || i === n - 1 ? [] : [SOURCES[0].id] })) }) as unknown as Storyboard;
    expect(() => validateStoryboard(scenes(11), SOURCES)).toThrow(/3–10 scenes/);
    expect(() => validateStoryboard(scenes(11), SOURCES, PRODUCTION_FORMATS.standard.maxScenes)).not.toThrow(/scenes/);
  });

  it('requires more evidence for the standard format', () => {
    expect(PRODUCTION_FORMATS.standard.minClaims).toBeGreaterThan(PRODUCTION_FORMATS.short.minClaims);
    expect(PRODUCTION_FORMATS.standard.minSources).toBeGreaterThanOrEqual(3);
  });

  it('stores the format; existing productions default to short', () => {
    const dir = fs.mkdtempSync(path.join(process.env.AIMO_TEST_TMP ?? os.tmpdir(), 'fmt-'));
    const db = openDatabase(path.join(dir, 'x.db'));
    const repo = new ProductionRepository(db);
    const a = repo.create(1, 'a', null, '');
    const b = repo.create(1, 'b', null, '', 'news', { format: 'standard' });
    expect(repo.get(a.id).format).toBe('short');
    expect(repo.get(b.id).format).toBe('standard');
    db.close();
    expect(newProduction({ topic: 'x', format: 'standard' }).format).toBe('standard');
    expect(() => newProduction({ topic: 'x', format: 'long' })).toThrow(/short or standard/);
  });
});
