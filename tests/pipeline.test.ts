import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/main/db/database';
import { ProductionRepository } from '../src/main/db/productions';
import { CancelledError, probe, resolveFfmpeg } from '../src/main/media/ffmpeg';
import { writeWav } from '../src/main/media/wav';
import { ProductionRunner } from '../src/main/pipeline/runner';
import type { NarrationProvider, Providers, VisualProvider, Writer } from '../src/main/providers/types';
import type { ResearchAdapter } from '../src/main/research/adapters';
import { GraphicsVisuals, TitleCardVisuals, type Rasterizer } from '../src/main/providers/visuals';
import { runFfmpeg } from '../src/main/media/ffmpeg';

// Stands in for the app's offscreen renderer: a real, non-blank 1080×1920 PNG per graphic.
const fakeRaster: Rasterizer = (html, out, signal) =>
  runFfmpeg(resolveFfmpeg(''), ['-f', 'lavfi', '-i', `testsrc2=s=1080x1920:r=1:d=1,hue=h=${html.length % 360}`, '-frames:v', '1', '-update', '1', out], { signal });
import { ExtractiveWriter, OpenAICompatibleWriter } from '../src/main/providers/writers';
import { DEFAULT_SETTINGS, type ProviderSettings } from '../src/shared/production';
import { SOURCES } from './fixtures';

const ffmpeg = resolveFfmpeg('');
const status = { available: true, detail: '', costPerUnitUsd: 0 };

function fakeResearch(calls: { n: number }, fail = false): ResearchAdapter {
  return {
    id: 'wikipedia', label: 'Fake research', category: 'background', healthUrl: 'http://127.0.0.1:9/',
    search: async () => {
      calls.n++;
      if (fail) throw new Error('offline');
      return SOURCES.map(({ id: _id, ...s }) => ({ ...s, kind: 'background' as const, provider: 'wikipedia', contentLevel: 'full' as const }));
    }
  };
}

/** Writes a short tone per scene with evenly spaced word timings (no TTS needed). */
function fakeNarration(o: { calls: number; failOnCall?: number; cost?: number; delayMs?: number } = { calls: 0 }): NarrationProvider {
  return {
    id: 'fake-voice', label: 'Fake voice', costPerUnitUsd: o.cost ?? 0,
    check: async () => ({ ...status, id: 'fake-voice', kind: 'narration', label: 'Fake voice' }),
    synthesize: async (text, out, signal) => {
      o.calls++;
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      if (signal.aborted) throw new CancelledError();
      if (o.failOnCall === o.calls) throw new Error('voice engine crashed');
      const words = text.split(/\s+/).slice(0, 6);
      const dur = 0.25 * words.length + 0.2;
      const sr = 22050;
      const samples = new Float32Array(Math.round(dur * sr)).map((_, i) => 0.2 * Math.sin((2 * Math.PI * 220 * i) / sr));
      writeWav(out, samples, sr);
      return { durationSec: dur, voice: 'Fake', words: words.map((t, i) => ({ text: t, start: i * 0.25, end: i * 0.25 + 0.22 })) };
    }
  };
}

const failingVisual = (msg: string): VisualProvider => ({
  id: 'broken', label: 'Broken visuals', costPerUnitUsd: 0,
  check: async () => ({ ...status, id: 'broken', kind: 'visuals', label: 'Broken visuals' }),
  fetch: async () => {
    throw new Error(msg);
  }
});
const emptyVisual: VisualProvider = { ...failingVisual(''), id: 'empty', label: 'Empty visuals', fetch: async () => null };

let db: DatabaseSync;
let repo: ProductionRepository;
let dir: string;
let providers: Providers;
let settings: ProviderSettings;
let emitted: number[];

function makeRunner(over: Partial<ConstructorParameters<typeof ProductionRunner>[0]> = {}) {
  return new ProductionRunner({
    repo,
    productionsDir: dir,
    settings: () => settings,
    providers: () => providers,
    ffmpeg: () => ffmpeg,
    channel: () => ({ name: 'AI, Actually', niche: 'AI and technology' }),
    emit: (id) => emitted.push(id),
    ...over
  });
}

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = new ProductionRepository(db);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimo-prod-'));
  settings = { ...DEFAULT_SETTINGS, visuals: ['graphics', 'title-card'] };
  emitted = [];
  providers = {
    research: [fakeResearch({ n: 0 })],
    writer: new ExtractiveWriter(),
    narration: fakeNarration(),
    visuals: [new GraphicsVisuals(fakeRaster), new TitleCardVisuals(() => ffmpeg)]
  };
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('production pipeline', () => {
  it('turns a topic into a playable 1080x1920 MP4 with narration, visuals, captions and credits', async () => {
    const runner = makeRunner();
    const p = repo.create(1, 'large language models', null, '');
    runner.enqueue(p.id);
    await runner.idle();
    const done = repo.get(p.id);
    expect(done.error).toBeNull();
    expect(done.status).toBe('completed');
    expect(done.steps.every((s) => s.status === 'done')).toBe(true);
    // Generation steps ran once; QA may legitimately repair captions/render (this fake voice only times 6 words per scene).
    expect(done.steps.filter((s) => ['research', 'brief', 'script', 'narration', 'visuals'].includes(s.step)).every((s) => s.attempts === 1)).toBe(true);
    const out = done.outputPath!;
    const info = await probe(ffmpeg, out);
    expect(info.video).toMatchObject({ codec: 'h264', width: 1080, height: 1920 });
    expect(info.audio?.codec).toBe('aac');
    expect(info.durationSec).toBeGreaterThan(3);
    const scenes = done.storyboard!.scenes.length;
    expect(done.assets.filter((a) => a.kind === 'narration')).toHaveLength(scenes);
    expect(done.assets.filter((a) => a.kind === 'image')).toHaveLength(scenes);
    const ass = fs.readFileSync(path.join(runner.dirFor(p.id), 'captions.ass'), 'utf8');
    expect(ass.match(/^Dialogue:/gm)!.length).toBeGreaterThan(scenes);
    const credits = fs.readFileSync(path.join(runner.dirFor(p.id), 'credits.txt'), 'utf8');
    expect(credits).toContain('https://en.wikipedia.org/wiki/Large_language_model');
    expect(done.costUsd).toBe(0);
    expect(emitted).toContain(p.id);
  }, 120_000);

  it('fails at research with an actionable message when no sources are available', async () => {
    providers.research = [];
    const runner = makeRunner();
    const p = repo.create(1, 'anything', null, '');
    runner.enqueue(p.id);
    await runner.idle();
    const r = repo.get(p.id);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/^Research: No research sources: every research provider is turned off/);
    expect(r.steps.find((s) => s.step === 'research')!.status).toBe('failed');
    expect(r.steps.find((s) => s.step === 'brief')!.status).toBe('pending');
  });

  it('reports provider errors when research is unreachable, but uses research notes when present', async () => {
    providers.research = [fakeResearch({ n: 0 }, true)];
    const runner = makeRunner();
    const a = repo.create(1, 'topic', null, '');
    runner.enqueue(a.id);
    await runner.idle();
    expect(repo.get(a.id).error).toContain('Fake research: offline');

    const notes = SOURCES[0].excerpt + ' ' + SOURCES[1].excerpt;
    providers.research = [];
    const b = repo.create(1, 'large language models', null, notes);
    runner.enqueue(b.id);
    await runner.idle();
    const pb = repo.get(b.id);
    expect(pb.sources.map((s) => s.id)).toEqual(['N1']);
    expect(pb.status).toBe('completed');
  }, 120_000);

  it('re-voices only the scenes with a corrected word and keeps visuals and other clips', async () => {
    const runner = makeRunner();
    const p = repo.create(1, 'large language models', null, '');
    runner.enqueue(p.id);
    await runner.idle();
    const before = repo.get(p.id);
    const imagesBefore = before.assets.filter((a) => a.kind === 'image').map((a) => a.id);
    const otherClip = before.assets.find((a) => a.kind === 'narration' && a.sceneIndex === 0)!.id;
    const voice = { calls: 0 };
    let visualCalls = 0;
    providers.narration = fakeNarration(voice);
    const gfx = new GraphicsVisuals(fakeRaster);
    providers.visuals = [{ ...failingVisual(''), id: 'graphics', fetch: (r, s) => (visualCalls++, gfx.fetch(r, s)) }];
    runner.renarrateScenes(p.id, [1]);
    await runner.idle();
    const after = repo.get(p.id);
    expect(after.status).toBe('completed');
    expect(voice.calls).toBe(1); // only scene 2 was re-voiced
    expect(visualCalls).toBe(0); // visuals kept
    expect(after.assets.filter((a) => a.kind === 'image').map((a) => a.id)).toEqual(imagesBefore);
    expect(after.assets.find((a) => a.kind === 'narration' && a.sceneIndex === 0)!.id).toBe(otherClip);
    expect(after.outputPath).toBeTruthy();
    expect(() => runner.renarrateScenes(p.id, [99])).toThrow(/None of those scenes/);
  }, 120_000);

  it('falls back to the next visual provider, and explains when all of them fail', async () => {
    providers.visuals = [failingVisual('rate limited'), emptyVisual, new TitleCardVisuals(() => ffmpeg)];
    const runner = makeRunner();
    const p = repo.create(1, 'large language models', null, '');
    runner.enqueue(p.id);
    await runner.idle();
    expect(repo.get(p.id).assets.filter((a) => a.kind === 'image').every((a) => a.provider === 'title-card')).toBe(true);

    providers.visuals = [failingVisual('rate limited'), emptyVisual];
    settings = { ...settings, visuals: ['wikimedia-commons'] };
    runner.rerun(p.id, 'visuals');
    await runner.idle();
    const r = repo.get(p.id);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/Visuals: No visual for scene 1\. Broken visuals: rate limited · Empty visuals: nothing suitable found/);
    expect(r.error).toContain('Title cards');
  }, 120_000);

  it('retries from the failed step without redoing finished work', async () => {
    const research = { n: 0 };
    const voice = { calls: 0, failOnCall: 3 };
    providers.research = [fakeResearch(research)];
    providers.narration = fakeNarration(voice);
    const runner = makeRunner();
    const p = repo.create(1, 'large language models', null, '');
    runner.enqueue(p.id);
    await runner.idle();
    let r = repo.get(p.id);
    expect(r.status).toBe('failed');
    expect(r.error).toBe('Narration: voice engine crashed');
    expect(r.assets.filter((a) => a.kind === 'narration')).toHaveLength(2);

    runner.retry(p.id);
    await runner.idle();
    r = repo.get(p.id);
    expect(r.status).toBe('completed');
    expect(research.n).toBe(1); // research not repeated
    expect(voice.calls).toBe(r.storyboard!.scenes.length + 1); // only the failed + remaining scenes re-voiced
    expect(r.steps.find((s) => s.step === 'narration')!.attempts).toBe(2);
    expect(r.steps.find((s) => s.step === 'research')!.attempts).toBe(1);
  }, 120_000);

  it('cancels a running production and resumes on retry', async () => {
    providers.narration = fakeNarration({ calls: 0, delayMs: 150 });
    const runner = makeRunner();
    const p = repo.create(1, 'large language models', null, '');
    runner.enqueue(p.id);
    while (repo.get(p.id).currentStep !== 'narration') await new Promise((r) => setTimeout(r, 10));
    runner.cancel(p.id);
    await runner.idle();
    expect(repo.get(p.id).status).toBe('cancelled');
    runner.retry(p.id);
    await runner.idle();
    expect(repo.get(p.id).status).toBe('completed');
  }, 120_000);

  it('runs one production at a time and cancels queued ones', async () => {
    const runner = makeRunner({ render: async () => { throw new Error('render disabled in this test'); } });
    const a = repo.create(1, 'large language models', null, '');
    const b = repo.create(1, 'large language models', null, '');
    runner.enqueue(a.id);
    runner.enqueue(b.id);
    expect(repo.get(b.id).status).toBe('queued');
    runner.cancel(b.id);
    await runner.idle();
    expect(repo.get(a.id).error).toBe('Render: render disabled in this test');
    expect(repo.get(b.id).status).toBe('cancelled');
  }, 120_000);

  it('tracks provider costs per step', async () => {
    providers.narration = fakeNarration({ calls: 0, cost: 0.0001 });
    const runner = makeRunner({ render: async () => { throw new Error('stop'); } });
    const p = repo.create(1, 'large language models', null, '');
    runner.enqueue(p.id);
    await runner.idle();
    const r = repo.get(p.id);
    const chars = r.storyboard!.scenes.reduce((s, x) => s + x.narration.length, 0);
    expect(r.steps.find((s) => s.step === 'narration')!.costUsd).toBeCloseTo(chars * 0.0001);
    expect(r.costUsd).toBeCloseTo(chars * 0.0001);
  }, 120_000);

  it('fails the script step clearly when the local LLM server is down', async () => {
    providers.writer = new OpenAICompatibleWriter({ baseUrl: 'http://127.0.0.1:9', model: '', timeoutMs: 5000 }) as Writer;
    const runner = makeRunner();
    const p = repo.create(1, 'large language models', null, '');
    runner.enqueue(p.id);
    await runner.idle();
    expect(repo.get(p.id).error).toMatch(/^Script & storyboard: The script writer failed \(.*No LLM server is answering at http:\/\/127\.0\.0\.1:9.*Start the writer and retry/);
  }, 60_000);

  it('falls back to the deterministic writer and records why when the LLM is down', async () => {
    providers.writer = new OpenAICompatibleWriter({ baseUrl: 'http://127.0.0.1:9', model: '', timeoutMs: 5000 }) as Writer;
    providers.fallbackWriter = new ExtractiveWriter();
    const runner = makeRunner({ render: async () => { throw new Error('stop'); } });
    const p = repo.create(1, 'large language models', null, '');
    runner.enqueue(p.id);
    await runner.idle();
    const r = repo.get(p.id);
    expect(r.storyboard!.writer).toBe('extractive (fallback)');
    expect(r.storyboard!.fallbackReason).toMatch(/No LLM server is answering/);
    expect(r.steps.find((s) => s.step === 'script')!.detail).toContain('fallback');
  }, 60_000);

  it('never falls back for an autonomous production: it stops with the writer error', async () => {
    providers.writer = new OpenAICompatibleWriter({ baseUrl: 'http://127.0.0.1:9', model: '', timeoutMs: 5000 }) as Writer;
    providers.fallbackWriter = new ExtractiveWriter();
    const runner = makeRunner();
    const p = repo.create(1, 'large language models', null, '', 'explainer', { origin: 'autonomous' });
    runner.enqueue(p.id);
    await runner.idle();
    const r = repo.get(p.id);
    expect(r.status).toBe('failed');
    expect(r.storyboard).toBeNull();
    expect(r.error).toMatch(/never fall back to the deterministic writer/);
  }, 60_000);

  it('flags a fallback script as a major QA finding instead of passing it silently', async () => {
    const { runQaChecks } = await import('../src/main/qa/engine');
    providers.writer = new OpenAICompatibleWriter({ baseUrl: 'http://127.0.0.1:9', model: '', timeoutMs: 5000 }) as Writer;
    providers.fallbackWriter = new ExtractiveWriter();
    const runner = makeRunner({ render: async () => { throw new Error('stop'); } });
    const p = repo.create(1, 'large language models', null, '');
    runner.enqueue(p.id);
    await runner.idle();
    const checks = await runQaChecks({ production: repo.get(p.id), dir, ffmpeg, allowShareAlike: false });
    const f = checks.find((c) => c.checkId === 'script.fallback')!;
    expect(f).toMatchObject({ severity: 'major', passed: false, repairAction: 'rescript' });
    expect(f.message).toMatch(/deterministic fallback writer/);
  }, 60_000);

  it('rerun from a step clears that step and later outputs', async () => {
    const runner = makeRunner();
    const p = repo.create(1, 'large language models', null, '');
    runner.enqueue(p.id);
    await runner.idle();
    const voice = { calls: 0 };
    let visualCalls = 0;
    const gfx = new GraphicsVisuals(fakeRaster);
    providers.narration = fakeNarration(voice);
    providers.visuals = [{ ...failingVisual(''), id: 'graphics', fetch: (r, s) => (visualCalls++, gfx.fetch(r, s)) }];
    runner.rerun(p.id, 'visuals');
    expect(repo.get(p.id).assets.filter((a) => ['image', 'captions', 'video'].includes(a.kind))).toHaveLength(0);
    expect(repo.get(p.id).outputPath).toBeNull();
    await runner.idle();
    const after = repo.get(p.id);
    expect(after.status).toBe('completed');
    expect(voice.calls).toBe(0); // narration kept
    expect(visualCalls).toBe(after.storyboard!.scenes.length); // visuals regenerated
  }, 120_000);

  it('marks productions interrupted by an app exit as failed and retryable', () => {
    const p = repo.create(1, 't', null, '');
    repo.update(p.id, { status: 'running', currentStep: 'narration' });
    expect(repo.markInterrupted()).toBe(1);
    const r = repo.get(p.id);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/Interrupted/);
  });
});

describe('production deletion', () => {
  it('records the deletion and keeps every earlier audit event for that production number', async () => {
    const { AuditLedger } = await import('../src/main/audit/ledger');
    const audit = new AuditLedger(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ev-')));
    const runner = makeRunner({ audit });
    const p = repo.create(1, 'deleted topic', null, '');
    audit.record({ actor: 'test', businessId: 1, type: 'production.started', productionId: p.id, data: {} });
    runner.delete(p.id);
    const rows = db.prepare('SELECT type, actor, data FROM audit_events WHERE production_id = ? ORDER BY id').all(p.id) as { type: string; actor: string; data: string }[];
    expect(rows.map((r) => r.type)).toEqual(['production.started', 'production.deleted']);
    expect(rows[1].actor).toBe('user');
    expect(JSON.parse(rows[1].data)).toMatchObject({ topic: 'deleted topic', status: 'queued' });
    expect(() => repo.get(p.id)).toThrow();
    expect(audit.verify().ok).toBe(true);
  });
});
