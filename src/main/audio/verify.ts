import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MixProfile } from '../../shared/audioMix';
import { DEFAULT_SOUND_PROFILE, type ProviderSettings } from '../../shared/production';
import type { QaFinding } from '../../shared/operations';
import type { SoundLibrary } from '../library';
import { embeddable } from '../library';
import { buildAss, buildCues } from '../media/captions';
import { probe, runFfmpeg } from '../media/ffmpeg';
import { buildRenderArgs, totalDuration, type RenderPlan } from '../media/render';
import { narrationTimeline } from '../media/timeline';
import type { NarrationProvider } from '../providers/types';
import { audioGateFindings, type AudioAnalysis } from './analysis';
import { prepareMix } from './plan';
import { resolveEffects } from './effects';
import type { ContextualEffect } from '../../shared/audioMix';

/** Five short scenes: enough for an intro accent, three transitions and an outro accent. */
export const VERIFICATION_LINES = [
  'This is an Omnicore audio check. The music should sit softly under this voice.',
  'Each sentence is measured, and every scene should sound equally loud.',
  'Between lines, the music rises gently, then dips again when the voice returns.',
  'A short sound effect marks each change of scene, below the level of the voice.',
  'If everything is balanced, this check passes and production can resume.'
];

/** Test seams: break one part of the mix (after planning, or after rendering) to prove the gate catches it. */
export interface TamperHooks {
  audio?: (audio: RenderPlan['audio'], dir: string) => void;
  final?: (file: string, dir: string) => Promise<void>;
}

export interface VerificationResult {
  passed: boolean;
  findings: QaFinding[];
  analysis: AudioAnalysis | null;
  file: string;
  sha256: string;
  durationSec: number;
  track: string;
  narration: string;
}

/**
 * A real end-to-end render through the production audio path: real narration from the configured voice, the
 * library's approved soundtrack and effects, prepareMix (measured gains + ducking envelope), the production renderer,
 * then the mandatory audio gate on the decoded result. Nothing about a production is created or changed.
 */
export async function renderAudioVerification(o: { ffmpeg: string; dir: string; narration: NarrationProvider; library: SoundLibrary; settings: ProviderSettings; profile: MixProfile; signal?: AbortSignal; mood?: 'calm' | 'upbeat'; tamper?: TamperHooks; effects?: ContextualEffect[] }): Promise<VerificationResult> {
  const signal = o.signal ?? new AbortController().signal;
  fs.mkdirSync(path.join(o.dir, 'audio'), { recursive: true });
  fs.mkdirSync(path.join(o.dir, 'images'), { recursive: true });
  const colors = ['0x1e293b', '0x312e81', '0x14532d', '0x7c2d12', '0x3b0764'];
  const clips: { audio: string; durationSec: number; words: { text: string; start: number; end: number }[] }[] = [];
  let voice = '';
  for (let i = 0; i < VERIFICATION_LINES.length; i++) {
    const rel = `audio/scene-${String(i + 1).padStart(2, '0')}.wav`;
    const r = await o.narration.synthesize(VERIFICATION_LINES[i], path.join(o.dir, rel), signal);
    voice = `${o.narration.label}: ${r.voice}`;
    clips.push({ audio: rel, durationSec: r.durationSec, words: r.words });
    await runFfmpeg(o.ffmpeg, ['-y', '-f', 'lavfi', '-i', `color=c=${colors[i % colors.length]}:s=1080x1920:d=1`, '-frames:v', '1', path.join(o.dir, 'images', `scene-${i + 1}.png`)], { signal });
  }
  const timeline = narrationTimeline(clips);
  fs.writeFileSync(path.join(o.dir, 'captions.ass'), buildAss(buildCues(timeline), []), 'utf8');
  const profile = { ...DEFAULT_SOUND_PROFILE, autoDiscover: false, mixProfile: o.profile.id };
  const sel = await o.library.select(o.settings, 0, { mood: o.mood ?? 'calm', platforms: ['tiktok'], profile, signal });
  if (!sel.music) throw new Error('The sound library could not provide an approved soundtrack.');
  const total = timeline.reduce((t, x) => t + x.duration, 0);
  const effects = resolveEffects(o.library, o.effects ?? [], total);
  const { audio } = await prepareMix({
    ffmpeg: o.ffmpeg,
    dir: o.dir,
    scenes: timeline.map((t) => ({ audio: t.audio, durationSec: t.duration, speechSec: t.speechSec, leadSec: t.leadSec, words: t.clipWords })),
    music: { track: sel.music, file: o.library.pathOf(sel.music), embeddable: embeddable(sel.music) },
    effects: effects.map((e) => ({ trackId: e.track.id, path: e.path, atSec: e.atSec })),
    profile: o.profile,
    signal
  });
  o.tamper?.audio?.(audio, o.dir);
  const plan: RenderPlan = {
    scenes: timeline.map((t, i) => ({ image: `images/scene-${i + 1}.png`, audio: t.audio, durationSec: t.duration, audioDelaySec: t.leadSec, motion: 'still', ...(i > 0 ? { transition: 'fade' as const } : {}) })),
    captions: 'captions.ass',
    output: 'final.mp4',
    audio
  };
  await runFfmpeg(o.ffmpeg, buildRenderArgs(plan), { cwd: o.dir, signal, totalSec: totalDuration(plan) });
  const file = path.join(o.dir, 'final.mp4');
  if (o.tamper?.final) await o.tamper.final(file, o.dir);
  const info = await probe(o.ffmpeg, file);
  const g = await audioGateFindings({ ffmpeg: o.ffmpeg, dir: o.dir, finalFile: file, audioCodec: info.audio?.codec, sampleRate: info.audio?.sampleRate, durationSec: info.durationSec, hasMusicAsset: true, signal });
  return {
    passed: g.findings.every((f) => f.passed),
    findings: g.findings,
    analysis: g.analysis,
    file,
    sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    durationSec: info.durationSec,
    track: sel.music.title,
    narration: voice
  };
}
