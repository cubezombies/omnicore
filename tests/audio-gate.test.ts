import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/main/db/database';
import { ProductionRepository } from '../src/main/db/productions';
import { ProductionRunner } from '../src/main/pipeline/runner';
import { OperationsRepository } from '../src/main/db/operations';
import { SoundLibrary } from '../src/main/library';
import { resolveFfmpeg, runFfmpeg } from '../src/main/media/ffmpeg';
import { buildRenderArgs } from '../src/main/media/render';
import { duckEnvelope, measureLoudness, speechIntervals } from '../src/main/audio/mix';
import { renderAudioVerification, type TamperHooks, type VerificationResult } from '../src/main/audio/verify';
import { audioGateFindings } from '../src/main/audio/analysis';
import { AUDIO_GATE_ID, AUDIO_PIPELINE_VERSION, MIX_PROFILES, mixProfile } from '../src/shared/audioMix';
import { DEFAULT_SETTINGS, DEFAULT_SOUND_PROFILE } from '../src/shared/production';
import { reviewGate } from '../src/shared/review';
import type { ContextualEffect } from '../src/shared/audioMix';
import { resolveEffects } from '../src/main/audio/effects';
import { isRetryable } from '../src/shared/failures';
import { ProductionFailure } from '../src/main/pipeline/failures';
import type { NarrationProvider } from '../src/main/providers/types';
import type { QaFinding } from '../src/shared/operations';

const ff = resolveFfmpeg('');

/**
 * A speech-like voice with exact word timings: voiced harmonics (140 Hz fundamental up to 2.3 kHz) in syllable-shaped
 * bursts. Real narration is exercised by the AIMO_E2E_AUDIO test below; this keeps the regression suite fast.
 */
function syntheticVoice(level = 0.22): NarrationProvider {
  return {
    id: 'synthetic',
    label: 'Synthetic voice',
    costPerUnitUsd: 0,
    async synthesize(text: string, outWav: string, signal: AbortSignal) {
      const n = text.split(/\s+/).filter(Boolean).length;
      const step = 0.38;
      const dur = 0.05 + n * step;
      const m = `mod(t-0.05,${step})`;
      const env = `gte(t,0.05)*lt(${m},0.3)*pow(sin(PI*${m}/0.3),2)`;
      const voiced = `(sin(2*PI*140*t)+0.7*sin(2*PI*280*t)+0.5*sin(2*PI*420*t)+0.4*sin(2*PI*700*t)+0.3*sin(2*PI*1100*t)+0.2*sin(2*PI*2300*t))`;
      await runFfmpeg(ff, ['-f', 'lavfi', '-i', `aevalsrc=exprs='${level}*${env}*${voiced}':s=24000:d=${dur.toFixed(3)}`, outWav], { signal });
      return { durationSec: dur, voice: 'synthetic', words: Array.from({ length: n }, (_, i) => ({ text: text.split(/\s+/)[i], start: 0.05 + i * step, end: 0.05 + i * step + 0.3 })) };
    }
  } as unknown as NarrationProvider;
}

let lib: SoundLibrary;
let root: string;
let libDb: ReturnType<typeof openDatabase>;
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-gate-'));
  libDb = openDatabase(':memory:');
  lib = new SoundLibrary(libDb, path.join(root, 'library'), () => ff);
  // The phone-audible generated bed, plus two library effects used only by the contextual-effect tests.
  await lib.generate('soft-keys');
  for (const id of ['riser', 'pop'] as const) await lib.generate(id); // explicit generation only, never automatic
}, 180_000);

const render = (name: string, extra: { tamper?: TamperHooks; voice?: NarrationProvider; profile?: string; effects?: ContextualEffect[] } = {}): Promise<VerificationResult> =>
  renderAudioVerification({ ffmpeg: ff, dir: path.join(root, name), narration: extra.voice ?? syntheticVoice(), library: lib, settings: DEFAULT_SETTINGS, profile: mixProfile(extra.profile ?? 'balanced'), tamper: extra.tamper, effects: extra.effects });
const riserId = () => lib.list('sfx').find((t) => t.title === 'Riser (generated)')!.id;
const failed = (r: VerificationResult) => r.findings.filter((f) => !f.passed).map((f) => f.checkId);

describe('defaults and planning (pure)', () => {
  it('music is on and required by default, with the Balanced mix profile', () => {
    expect(DEFAULT_SOUND_PROFILE.music).toBe('required');
    expect(DEFAULT_SOUND_PROFILE.mixProfile).toBe('balanced');
    expect(DEFAULT_SETTINGS.musicMode).toBe('auto');
    expect(Object.keys(MIX_PROFILES)).toEqual(['balanced', 'voice-forward', 'music-forward']);
    for (const p of Object.values(MIX_PROFILES)) expect(p.musicOpenLufs).toBeLessThan(-16 - 5); // the voice always leads
  });

  it('groups words into phrases and ducks with smooth raised-cosine ramps to the exact depth', () => {
    const sp = speechIntervals([{ offsetSec: 0, durationSec: 3, speechSec: 2.5, words: [{ start: 0.1, end: 0.5 }, { start: 0.6, end: 1.0 }, { start: 2.0, end: 2.4 }] }], 0.45);
    expect(sp).toEqual([[0.1, 1.0], [2.0, 2.4]]);
    const env = duckEnvelope(sp, 4, { duckDb: 9, attackSec: 0.25, releaseSec: 0.7 }, 1000);
    const db = (i: number) => 20 * Math.log10(env[i]);
    expect(db(500)).toBeCloseTo(-9, 3); // fully ducked mid-phrase
    expect(db(3900)).toBeCloseTo(0, 3); // released after the last phrase
    let maxStep = 0;
    for (let i = 1; i < env.length; i++) maxStep = Math.max(maxStep, Math.abs(db(i) - db(i - 1)));
    expect(maxStep).toBeLessThan(0.07); // per millisecond: no clicks or jumps
  });

  it('refuses to build a render without a soundtrack', () => {
    expect(() => buildRenderArgs({ scenes: [{ image: 'a.png', audio: 'a.wav', durationSec: 1 }], captions: 'c.ass', output: 'o.mp4' } as never)).toThrow(/No soundtrack/);
  });

  it('audio failures are permanent (never auto-retried into the same result)', () => {
    expect(isRetryable({ kind: 'audio', code: 'audio-gate' })).toBe(false);
  });
});

describe('approval and publishing gate', () => {
  const run = (gatePassed: boolean | null, status: 'passed' | 'failed' | 'blocked' = 'passed') => ({
    status,
    findings: gatePassed === null ? [] : ([{ checkId: AUDIO_GATE_ID, category: 'audio', severity: 'critical', passed: gatePassed, message: gatePassed ? 'Audio gate passed' : 'Audio gate FAILED (1): audio.music-present', evidence: {}, repair: '' }] as QaFinding[])
  });
  it('approval requires a passed audio gate in the latest QA run', () => {
    expect(reviewGate('awaiting_review', run(true)).canApprove).toBe(true);
    expect(reviewGate('awaiting_review', run(false, 'blocked')).canApprove).toBe(false);
    // A run that passed before the audio gate existed can never approve.
    const old = reviewGate('awaiting_review', run(null));
    expect(old).toMatchObject({ canApprove: false, state: 'needs_fixes' });
    expect(old.reason).toMatch(/predates the mandatory audio gate/);
  });
});

describe('production freeze', () => {
  it('starts frozen, refuses release without a passed verification on this pipeline version, then releases', () => {
    const ops = new OperationsRepository(openDatabase(':memory:'));
    expect(ops.productionFreeze().frozen).toBe(true);
    expect(() => ops.releaseProduction('go')).toThrow(/stays frozen/);
    const v = { version: AUDIO_PIPELINE_VERSION, at: new Date().toISOString(), passed: false, profile: 'balanced', track: 't', narration: 'n', durationSec: 20, findings: [], dir: '', renderSha256: '' };
    ops.recordAudioVerification(v);
    expect(() => ops.releaseProduction('go')).toThrow(/stays frozen/);
    ops.recordAudioVerification({ ...v, passed: true, version: AUDIO_PIPELINE_VERSION - 1 });
    expect(() => ops.releaseProduction('go')).toThrow(/stays frozen/);
    ops.recordAudioVerification({ ...v, passed: true });
    expect(ops.releaseProduction('verified').frozen).toBe(false);
  });

  it('a stored business profile with the old accents switched on reads as off (retired)', () => {
    const db = openDatabase(':memory:');
    const ops = new OperationsRepository(db);
    db.prepare("INSERT INTO settings (key, value) VALUES ('business:1:sound', ?)").run(JSON.stringify({ ...DEFAULT_SOUND_PROFILE, introAccent: true, transitions: true, outroAccent: true }));
    expect(ops.getSoundProfile(1)).toMatchObject({ introAccent: false, transitions: false, outroAccent: false, music: 'required' });
  });
});

describe('production freeze in the runner (every route)', () => {
  it('refuses to queue, retry, re-run or re-voice while frozen, and changes nothing', () => {
    const db = openDatabase(':memory:');
    const repo = new ProductionRepository(db);
    const p = repo.create(1, 'frozen topic', null, '');
    repo.update(p.id, { status: 'failed', error: 'x' });
    const runner = new ProductionRunner({ repo, productionsDir: path.join(root, 'frozen'), settings: () => DEFAULT_SETTINGS, providers: () => ({}) as never, ffmpeg: () => ff, channel: () => ({ name: 'n', niche: 'n' }), emit: () => {}, frozen: () => 'audio pipeline not verified' });
    const before = JSON.stringify(repo.get(p.id));
    expect(() => runner.enqueue(p.id)).toThrow(/Production is frozen: audio pipeline not verified/);
    expect(() => runner.retry(p.id)).toThrow(/frozen/);
    expect(() => runner.rerun(p.id, 'qa')).toThrow(/frozen/);
    expect(() => runner.renarrateScenes(p.id, [0])).toThrow(/frozen/);
    expect(JSON.stringify(repo.get(p.id))).toBe(before);
    expect(repo.queued()).toEqual([]);
  });
});

describe('contextual effects are explicit and rights-checked', () => {
  it('blocks quarantined, unverified, music or out-of-range effects; accepts an approved one', async () => {
    const pop = lib.list('sfx').find((t) => t.title === 'Pop (generated)')!;
    expect(resolveEffects(lib, [{ trackId: pop.id, atSec: 1, note: 'ok' }], 10)).toHaveLength(1);
    expect(() => resolveEffects(lib, [{ trackId: pop.id, atSec: 12, note: 'late' }], 10)).toThrow(/outside the video/);
    const music = lib.list('music')[0];
    expect(() => resolveEffects(lib, [{ trackId: music.id, atSec: 1, note: 'x' }])).toThrow(/music, not a sound effect/);
    libDb.prepare("UPDATE audio_library SET rights_status = 'unverified' WHERE id = ?").run(pop.id);
    expect(() => resolveEffects(lib, [{ trackId: pop.id, atSec: 1, note: 'x' }])).toThrow(/Contextual effect blocked/);
    libDb.prepare("UPDATE audio_library SET rights_status = 'quarantined' WHERE id = ?").run(pop.id);
    expect(() => resolveEffects(lib, [{ trackId: pop.id, atSec: 1, note: 'x' }])).toThrow(/Contextual effect blocked/);
    libDb.prepare("UPDATE audio_library SET rights_status = 'approved' WHERE id = ?").run(pop.id);
  });

  it('the default profile and selection add no effects, and nothing is generated besides music', async () => {
    expect(DEFAULT_SOUND_PROFILE).toMatchObject({ introAccent: false, transitions: false, outroAccent: false });
    const fresh = new SoundLibrary(openDatabase(':memory:'), path.join(root, 'fresh-lib'), () => ff);
    const sel = await fresh.select(DEFAULT_SETTINGS, 1, { mood: 'calm', platforms: ['tiktok'], profile: { ...DEFAULT_SOUND_PROFILE, introAccent: true, outroAccent: true, autoDiscover: false } });
    expect(sel.music?.title).toBe('Soft keys 75 BPM (generated)');
    expect(Object.keys(sel).sort()).toEqual(['discovered', 'music', 'refused']);
    expect(fresh.list('sfx')).toEqual([]); // even a stored "on" toggle generates nothing
  }, 120_000);
});

describe('soundtrack selection (real files)', () => {
  it('never selects the legacy beds that are inaudible on phone speakers, and generates an audible one', async () => {
    const pad = await lib.generate('ambient-pad');
    expect((await lib.phoneAudibility(pad)).ok).toBe(false);
    const sel = await lib.select(DEFAULT_SETTINGS, 1, { mood: 'calm', platforms: ['tiktok'], profile: { ...DEFAULT_SOUND_PROFILE, autoDiscover: false } });
    expect(sel.music?.title).toBe('Soft keys 75 BPM (generated)');
    // Choosing the inaudible bed explicitly is a hard failure, not a silent render.
    await expect(lib.select(DEFAULT_SETTINGS, 1, { mood: 'calm', platforms: ['tiktok'], profile: DEFAULT_SOUND_PROFILE, override: { mode: 'track', trackId: pad.id } })).rejects.toMatchObject({ kind: 'audio', code: 'music-inaudible' });
  }, 120_000);

  it('rights quarantine stays effective: a quarantined track cannot be chosen even if it is audible', async () => {
    const t = await lib.generate('bright-pulse');
    libDb.prepare("UPDATE audio_library SET rights_status = 'quarantined', quarantine_reason = 'test: rights incident' WHERE id = ?").run(t.id);
    await expect(lib.select(DEFAULT_SETTINGS, 1, { mood: 'upbeat', platforms: ['tiktok'], profile: DEFAULT_SOUND_PROFILE, override: { mode: 'track', trackId: t.id } })).rejects.toBeInstanceOf(ProductionFailure);
    const auto = await lib.select(DEFAULT_SETTINGS, 1, { mood: 'upbeat', platforms: ['tiktok'], profile: { ...DEFAULT_SOUND_PROFILE, autoDiscover: false } });
    expect(auto.music?.id).not.toBe(t.id);
  }, 120_000);
});

describe('mandatory audio gate on real renders', () => {
  let good: VerificationResult;
  beforeAll(async () => {
    good = await render('good');
  }, 240_000);

  it('a balanced mix passes every check, measured on the decoded render', async () => {
    expect(failed(good)).toEqual([]);
    const a = good.analysis!;
    expect(a.separationDb).toBeGreaterThanOrEqual(11);
    expect(a.separationDb).toBeLessThanOrEqual(23);
    expect(Math.abs(a.duckUnderSpeechDb - 9)).toBeLessThanOrEqual(2.5);
    expect(a.residualWithMusicDb).toBeLessThan(a.residualWithoutMusicDb - 6);
    expect(a.sfxFound).toBe(a.sfxExpected);
    expect(a.final.truePeakDb).toBeLessThanOrEqual(-1);
    expect(a.final.lufs).toBeGreaterThan(-17.5);
    expect(a.final.lufs).toBeLessThan(-14.5);
  });

  it('fails when the music is too loud for the voice (incorrect balance)', async () => {
    const r = await render('loud-music', { tamper: { audio: (a) => (a.music.gainDb += 12) } });
    expect(failed(r)).toContain('audio.music-under-speech');
    expect(r.passed).toBe(false);
  }, 120_000);

  it('fails when the music is nearly inaudible (the root cause of the silent videos)', async () => {
    const r = await render('buried-music', { tamper: { audio: (a) => (a.music.gainDb -= 20) } });
    expect(failed(r)).toEqual(expect.arrayContaining(['audio.music-present', 'audio.music-under-speech']));
  }, 120_000);

  it('fails when ducking is broken (flat envelope)', async () => {
    const r = await render('no-duck', {
      tamper: { audio: (_a, dir) => writeFlat(path.join(dir, 'stems', 'duck-envelope.wav')) }
    });
    expect(failed(r)).toContain('audio.ducking');
  }, 120_000);

  it('plans and generates no decorative effects by default: the effects stem is silent', async () => {
    const rec = JSON.parse(fs.readFileSync(path.join(path.dirname(good.file), 'audio-mix.json'), 'utf8')) as { cues: unknown[] };
    expect(rec.cues).toEqual([]);
    expect(good.findings.find((f) => f.checkId === 'audio.sfx')).toMatchObject({ passed: true, message: 'No sound effects planned, and none in the mix.' });
    const { decodeMono } = await import('../src/main/audio/analysis');
    const sfx = await decodeMono(ff, path.join(path.dirname(good.file), 'stems', 'sfx.flac'));
    let peak = 0;
    for (const x of sfx) peak = Math.max(peak, Math.abs(x));
    expect(peak).toBe(0);
    expect(lib.list('sfx').map((t) => t.title)).not.toContain('Whoosh (generated)');
  });

  it('mixes an explicitly approved contextual effect at its time and checks it', async () => {
    const r = await render('contextual', { effects: [{ trackId: riserId(), atSec: 3, note: 'test: rising tension before the reveal' }] });
    expect(failed(r)).toEqual([]);
    expect(r.findings.find((f) => f.checkId === 'audio.sfx')?.message).toMatch(/^1 of 1 sound effects present \(approved contextual effects\)/);
    const rec = JSON.parse(fs.readFileSync(path.join(path.dirname(r.file), 'audio-mix.json'), 'utf8')) as { cues: { role: string; atSec: number }[] };
    expect(rec.cues).toMatchObject([{ role: 'contextual', atSec: 3 }]);
  }, 120_000);

  it('fails when an approved contextual effect is missing from the mix', async () => {
    const r = await render('no-sfx', { effects: [{ trackId: riserId(), atSec: 3, note: 'test' }], tamper: { audio: (a) => a.sfx.forEach((x) => (x.gainDb = -120)) } });
    expect(failed(r)).toContain('audio.sfx');
  }, 120_000);

  it('fails on clipping', async () => {
    const r = await render('clipped', { tamper: { final: (file, dir) => remux(file, dir, ['-af', 'volume=14dB']) } });
    expect(failed(r)).toContain('audio.peaks');
  }, 120_000);

  it('fails when the soundtrack is assigned but missing from the final mix', async () => {
    // Rebuild the final from narration + effects only: every database record still says the music is there.
    const r = await render('music-dropped', {
      tamper: {
        final: async (file, dir) => {
          const tmp = path.join(dir, 'dropped.mp4');
          await runFfmpeg(ff, ['-i', file, '-i', 'stems/narration.flac', '-i', 'stems/sfx.flac', '-filter_complex', '[1:a][2:a]amix=inputs=2:normalize=0[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', tmp], { cwd: dir });
          fs.renameSync(tmp, file);
        }
      }
    });
    expect(failed(r)).toContain('audio.mix-integrity');
  }, 120_000);

  it('fails when the audio encoding failed (no audio stream)', async () => {
    const r = await render('no-audio', { tamper: { final: (file, dir) => remux(file, dir, ['-an']) } });
    expect(failed(r)).toEqual(expect.arrayContaining(['audio.analysis']));
    expect(r.findings.find((f) => f.checkId === AUDIO_GATE_ID)?.passed).toBe(false);
  }, 120_000);

  it('fails hard on missing narration and on a silent soundtrack (before rendering)', async () => {
    const silentVoice = { ...syntheticVoice(0), id: 'silent' } as NarrationProvider;
    await expect(render('no-narration', { voice: silentVoice })).rejects.toMatchObject({ kind: 'audio', code: 'missing-narration' });
    const silent = await lib.import(await silenceFile(), 'music', { title: 'Silence', license: 'Generated by Omnicore (no third-party rights)', commercialUse: 'yes', usage: 'embedded' } as never).catch(() => null);
    if (silent) {
      // A silent file can never be approved as audible music; the measured check refuses it.
      expect((await lib.phoneAudibility(silent)).ok).toBe(false);
    }
  }, 120_000);

  it('a mix record from a render before the gate fails the gate', async () => {
    const dir = path.join(root, 'legacy');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(good.file, path.join(dir, 'final.mp4'));
    const g = await audioGateFindings({ ffmpeg: ff, dir, finalFile: path.join(dir, 'final.mp4'), durationSec: good.durationSec, hasMusicAsset: true });
    expect(g.findings.find((f) => f.checkId === AUDIO_GATE_ID)?.passed).toBe(false);
  });

  it('measures the final loudness independently of the gate', async () => {
    const m = await measureLoudness(ff, good.file);
    expect(m.truePeakDb).toBeLessThanOrEqual(-1);
  });
});

/** Real narration end to end (Kokoro/sherpa from the data tools folder). Run with AIMO_E2E_AUDIO=1. */
const real = process.env.AIMO_E2E_AUDIO === '1' ? describe : describe.skip;
real('real narration end to end', () => {
  it('renders a verification video with the real voice that passes the gate', async () => {
    const { buildProviders } = await import('../src/main/providers/registry');
    const tools = process.env.AIMO_TOOLS_DIR ?? 'F:/Projects/AIMediaOperations/data/tools';
    const settings = { ...DEFAULT_SETTINGS, narration: (process.env.AIMO_E2E_NARRATION ?? 'sherpa') as never, kokoroBackend: (process.env.AIMO_E2E_KOKORO ?? 'sherpa') as never };
    const providers = buildProviders(settings, { tmpDir: path.join(root, 'tmp'), toolsDir: tools });
    const r = await renderAudioVerification({ ffmpeg: ff, dir: process.env.AIMO_E2E_AUDIO_DIR ?? path.join(root, 'real'), narration: providers.narration, library: lib, settings, profile: mixProfile('balanced') });
    console.log(JSON.stringify({ file: r.file, sha: r.sha256, voice: r.narration, track: r.track, failed: failed(r), analysis: r.analysis }, null, 1));
    expect(failed(r)).toEqual([]);
  }, 600_000);
});

function writeFlat(file: string): void {
  const n = 8000 * 120;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(32767, i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24);
  h.writeUInt32LE(16000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

async function remux(file: string, dir: string, audioArgs: string[]): Promise<void> {
  const tmp = path.join(dir, 'remux.mp4');
  await runFfmpeg(ff, ['-i', file, '-map', '0:v', ...(audioArgs.includes('-an') ? [] : ['-map', '0:a']), '-c:v', 'copy', ...audioArgs, ...(audioArgs.includes('-an') ? [] : ['-c:a', 'aac', '-b:a', '192k']), tmp], { cwd: dir });
  fs.renameSync(tmp, file);
}

async function silenceFile(): Promise<string> {
  const f = path.join(root, 'silence.m4a');
  await runFfmpeg(ff, ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '60', '-c:a', 'aac', f]);
  return f;
}
