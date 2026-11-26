import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/main/db/database';
import { ProductionRepository } from '../src/main/db/productions';
import { GENERATED_LICENSE, SoundLibrary } from '../src/main/library';
import { probe, resolveFfmpeg } from '../src/main/media/ffmpeg';
import { buildRenderArgs, transitionTimes } from '../src/main/media/render';
import { concatWavs, readWavPcm, writeWav } from '../src/main/media/wav';
import { resolveLibraryPath } from '../src/main/paths';
import { ProductionRunner } from '../src/main/pipeline/runner';
import { estimateWordTimings, lengthScaleFor, PiperNarration, splitForSpeech } from '../src/main/providers/piper';
import { TitleCardVisuals } from '../src/main/providers/visuals';
import { ExtractiveWriter } from '../src/main/providers/writers';
import * as v from '../src/main/validation';
import { DEFAULT_SETTINGS, type ProviderSettings } from '../src/shared/production';
import { SOURCES } from './fixtures';

const ffmpeg = resolveFfmpeg('');
let tmp: string;
let db: DatabaseSync;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aimo-snd-'));
  db = openDatabase(':memory:');
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
const tone = (file: string, sec: number, sr = 22050) => writeWav(file, new Float32Array(Math.round(sec * sr)).map((_, i) => 0.2 * Math.sin(i / 5)), sr);

describe('Piper narration helpers', () => {
  it('splits narration into sentences', () => {
    expect(splitForSpeech(' One idea.  Two ideas!\nThree? ')).toEqual(['One idea.', 'Two ideas!', 'Three?']);
  });
  it('estimates word timings inside exact sentence boundaries', () => {
    const w = estimateWordTimings(['Hello big world.', 'Bye.'], [1.2, 0.5], 0.2);
    expect(w.map((x) => x.text)).toEqual(['Hello', 'big', 'world.', 'Bye.']);
    expect(w[0].start).toBeGreaterThan(0);
    expect(w[2].end).toBeLessThanOrEqual(1.2);
    expect(w[3].start).toBeGreaterThanOrEqual(1.4); // second sentence starts after clip 1 + gap
    for (let i = 1; i < w.length; i++) expect(w[i].start).toBeGreaterThanOrEqual(w[i - 1].end);
  });
  it('maps speech rate to Piper length scale within bounds', () => {
    expect(lengthScaleFor(0)).toBe(1);
    expect(lengthScaleFor(4)).toBeCloseTo(0.8);
    expect(lengthScaleFor(-50)).toBe(1.6);
  });
  it('concatenates same-format clips with gaps and rejects mixed formats', () => {
    tone(path.join(tmp, 'a.wav'), 1);
    tone(path.join(tmp, 'b.wav'), 0.5);
    const r = concatWavs([path.join(tmp, 'a.wav'), path.join(tmp, 'b.wav')], path.join(tmp, 'out.wav'), 0.25);
    expect(r.durationSec).toBeCloseTo(1.75, 2);
    expect(r.clipDurations.map((d) => +d.toFixed(2))).toEqual([1, 0.5]);
    expect(readWavPcm(path.join(tmp, 'out.wav')).sampleRate).toBe(22050);
    tone(path.join(tmp, 'c.wav'), 0.5, 16000);
    expect(() => concatWavs([path.join(tmp, 'a.wav'), path.join(tmp, 'c.wav')], path.join(tmp, 'x.wav'))).toThrow(/different audio formats/);
  });
  it('reports a missing Piper install honestly', async () => {
    const p = new PiperNarration(path.join(tmp, 'nope', 'piper.exe'), '', tmp);
    const st = await p.check();
    expect(st.available).toBe(false);
    expect(st.detail).toMatch(/Piper is not installed .*Install it in Studio/);
    await expect(p.synthesize('Hi.', path.join(tmp, 'x.wav'), new AbortController().signal)).rejects.toThrow(/not installed/);
    fs.mkdirSync(path.join(tmp, 'p'));
    fs.writeFileSync(path.join(tmp, 'p', 'piper.exe'), '');
    expect((await new PiperNarration(path.join(tmp, 'p', 'piper.exe'), '', tmp).check()).detail).toMatch(/No Piper voice is installed/);
    // A voice trained with newer Piper (multi-codepoint phonemes) is flagged instead of crashing piper.exe.
    fs.writeFileSync(path.join(tmp, 'p', 'new.onnx'), 'x');
    fs.writeFileSync(path.join(tmp, 'p', 'new.onnx.json'), JSON.stringify({ phoneme_id_map: { a: [1], 'aɪ': [2] } }));
    expect((await new PiperNarration(path.join(tmp, 'p', 'piper.exe'), '', tmp).check()).detail).toMatch(/needs a newer Piper/);
  });
});

describe('Sound Library', () => {
  it('generates rights-free music and effects with real durations', async () => {
    const lib = new SoundLibrary(db, path.join(tmp, 'lib'), () => ffmpeg);
    const pad = await lib.generate('ambient-pad');
    const whoosh = await lib.generate('whoosh');
    expect(pad).toMatchObject({ kind: 'music', origin: 'generated', license: GENERATED_LICENSE });
    expect(pad.durationSec).toBeGreaterThan(55);
    expect(whoosh.tags).toContain('transition');
    expect((await probe(ffmpeg, lib.pathOf(whoosh))).audio?.codec).toBe('aac');
    expect(lib.list('music').map((t) => t.id)).toEqual([pad.id]);
  }, 60_000);

  it('imports user files, keeps their licence and refuses non-audio', async () => {
    const lib = new SoundLibrary(db, path.join(tmp, 'lib'), () => ffmpeg);
    const src = path.join(tmp, 'My Song.wav');
    tone(src, 2);
    const t = await lib.import(src, 'music', { license: 'CC BY 4.0', attribution: 'Jane Doe' });
    expect(t).toMatchObject({ title: 'My Song', license: 'CC BY 4.0', origin: 'imported', file: 'My_Song.wav' });
    expect((await lib.import(src, 'music')).file).toBe('My_Song-2.wav');
    fs.writeFileSync(path.join(tmp, 'notes.txt'), 'x');
    await expect(lib.import(path.join(tmp, 'notes.txt'), 'music')).rejects.toThrow(/Choose an audio file/);
    lib.delete(t.id);
    expect(fs.existsSync(path.join(tmp, 'lib', 'My_Song.wav'))).toBe(false);
  });

  it('picks music and transition effects from settings, generating them if the library is empty', async () => {
    const lib = new SoundLibrary(db, path.join(tmp, 'lib'), () => ffmpeg);
    const s = (o: Partial<ProviderSettings>) => ({ ...DEFAULT_SETTINGS, ...o });
    expect(await lib.pick(s({}), 1)).toEqual({ music: null, sfx: null });
    const auto = await lib.pick(s({ musicMode: 'auto', sfxTransitions: true }), 1);
    expect(auto.music?.origin).toBe('generated');
    expect(auto.sfx?.tags).toContain('transition');
    await expect(lib.pick(s({ musicMode: 'track', musicTrackId: auto.sfx!.id }), 1)).rejects.toThrow(/sound effect, not music/);
  }, 60_000);

  it('serves only files directly inside the library folder', () => {
    const root = path.resolve('/lib-root');
    expect(resolveLibraryPath(root, 'omnicore-media://lib/whoosh.m4a')).toBe(path.join(root, 'whoosh.m4a'));
    for (const u of ['omnicore-media://lib/..%2Fsecret.db', 'omnicore-media://lib/a/b.m4a', 'omnicore-media://lib/C%3A%5Cx', 'omnicore-media://p/whoosh.m4a', 'omnicore-media://lib/..']) {
      expect(resolveLibraryPath(root, u), u).toBeNull();
    }
  });
});

describe('render with music and transition effects', () => {
  it('places one effect per cut and mixes it with the ducked music bed', () => {
    const scenes = [
      { image: 'a.png', audio: 'a.wav', durationSec: 2 },
      { image: 'b.png', audio: 'b.wav', durationSec: 3 },
      { image: 'c.png', audio: 'c.wav', durationSec: 1 }
    ];
    expect(transitionTimes({ scenes })).toEqual([1.7, 4.7]);
    const args = buildRenderArgs({ scenes, captions: 'c.ass', output: 'o.mp4', music: { path: 'm.m4a', volume: 0.1 }, sfx: { path: 'w.m4a', volume: 0.3, atSec: [1.7, 4.7] } });
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toContain('[7:a]aresample'); // sfx input after 3 images + 3 audio + music
    expect(fc).toContain('asplit=2[sx0][sx1]');
    expect(fc).toContain('[sx1]adelay=4700|4700[sd1]');
    expect(fc).toContain('[bed][sd0][sd1]amix=inputs=3');
  });

  it('renders a production with library music + whoosh and credits them', async () => {
    const repo = new ProductionRepository(db);
    const lib = new SoundLibrary(db, path.join(tmp, 'lib'), () => ffmpeg);
    const settings = { ...DEFAULT_SETTINGS, writer: 'extractive' as const, visuals: ['title-card' as const], musicMode: 'auto' as const, sfxTransitions: true };
    const runner = new ProductionRunner({
      repo,
      productionsDir: path.join(tmp, 'prod'),
      settings: () => settings,
      library: lib,
      providers: () => ({
        research: [{ id: 'r', label: 'r', costPerUnitUsd: 0, check: async () => ({ id: 'r', kind: 'research', label: 'r', available: true, detail: '', costPerUnitUsd: 0 }), research: async () => SOURCES }],
        writer: new ExtractiveWriter(),
        narration: {
          id: 'n', label: 'n', costPerUnitUsd: 0,
          check: async () => ({ id: 'n', kind: 'narration', label: 'n', available: true, detail: '', costPerUnitUsd: 0 }),
          synthesize: async (text, out) => {
            tone(out, 1);
            return { durationSec: 1, voice: 'Fake', words: text.split(' ').slice(0, 3).map((t, i) => ({ text: t, start: i * 0.3, end: i * 0.3 + 0.25 })) };
          }
        },
        visuals: [new TitleCardVisuals(() => ffmpeg)]
      }),
      ffmpeg: () => ffmpeg,
      channel: () => ({ name: 'AI, Actually', niche: 'AI' }),
      emit: () => {}
    });
    const p = repo.create(1, 'large language models', null, '');
    runner.enqueue(p.id);
    await runner.idle();
    const r = repo.get(p.id);
    expect(r.error).toBeNull();
    expect(r.assets.filter((a) => a.kind === 'music' || a.kind === 'sfx').map((a) => a.kind).sort()).toEqual(['music', 'sfx']);
    const credits = fs.readFileSync(path.join(runner.dirFor(p.id), 'credits.txt'), 'utf8');
    expect(credits).toMatch(/Music: Ambient pad \(generated\), Generated by Omnicore/);
    expect(credits).toMatch(/Sound effect: Whoosh/);
    // Re-render keeps the shared library files intact.
    runner.rerun(p.id, 'render');
    await runner.idle();
    expect(repo.get(p.id).status).toBe('completed');
    expect(lib.list().every((t) => fs.existsSync(lib.pathOf(t)))).toBe(true);
  }, 120_000);
});

describe('settings validation for Piper and sound', () => {
  it('accepts Piper/music settings and rejects bad values', () => {
    const ok = { ...DEFAULT_SETTINGS, narration: 'piper', piperVoice: 'F:\\v\\en_US-john-medium.onnx', musicMode: 'track', musicTrackId: 3, sfxTransitions: true };
    expect(v.settings(ok)).toMatchObject({ narration: 'piper', musicMode: 'track', musicTrackId: 3 });
    expect(() => v.settings({ ...ok, narration: 'elevenlabs' })).toThrow(/narration/);
    expect(() => v.settings({ ...ok, piperVoice: 'voice.onnx' })).toThrow(/absolute/);
    expect(() => v.settings({ ...ok, musicTrackId: 0 })).toThrow(/Music track/);
    expect(() => v.settings({ ...ok, musicMode: 'spotify' })).toThrow(/music mode/);
    expect(() => v.piperVoiceId('en_US-ryan-high')).toThrow(/Unknown Piper voice/); // non-commercial voice not offered
    expect(v.trackPatch({ tags: ['Transition', ' '] })).toEqual({ tags: ['transition'] });
    expect(() => v.trackPatch({ sourceUrl: 'javascript:alert(1)' })).toThrow(/URL/);
  });
});
