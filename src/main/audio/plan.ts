import fs from 'node:fs';
import path from 'node:path';
import { AUDIO_PIPELINE_VERSION, NARRATION_LUFS, type MixProfile } from '../../shared/audioMix';
import type { AudioTrack } from '../../shared/production';
import { buildMixMeasureArgs, type RenderAudio, type RenderPlan } from '../media/render';
import { ProductionFailure } from '../pipeline/failures';
import { MIX_RECORD, type AudioMixRecord } from './analysis';
import { duckEnvelope, ENVELOPE_RATE, ffmpegText, gainTo, measureLoudness, speechIntervals, writeWav } from './mix';

export interface MixScene {
  /** Narration clip, relative to dir. */
  audio: string;
  durationSec: number;
  speechSec: number;
  /** Where the clip starts inside the scene (music intro). */
  leadSec?: number;
  /** Word timings relative to the clip. */
  words?: { start: number; end: number }[];
}

export interface MixInputs {
  ffmpeg: string;
  /** Working directory of the render (stems, envelope and the mix record are written here). */
  dir: string;
  scenes: MixScene[];
  music: { track: Pick<AudioTrack, 'id' | 'title' | 'origin' | 'rightsStatus'>; file: string; embeddable: boolean };
  /** Contextual effects approved for this production (usually none). */
  effects: { trackId: number; path: string; atSec: number }[];
  profile: MixProfile;
  signal?: AbortSignal;
}

/**
 * Measure every input and build the soundtrack of a render: narration matched scene by scene to -16 LUFS, the
 * music brought to the profile's level and ducked by an exact envelope under every phrase, effects at their role's
 * peak level, and stems requested next to the video. Writes the ducking envelope and audio-mix.json for QA.
 * Silent narration, a silent soundtrack or a silent effect is a hard failure.
 */
export async function prepareMix(o: MixInputs): Promise<{ audio: RenderAudio; record: AudioMixRecord }> {
  const narrationGainDb: number[] = [];
  for (const sc of o.scenes) {
    const m = await measureLoudness(o.ffmpeg, path.join(o.dir, sc.audio), o.signal);
    if (!Number.isFinite(m.lufs) || m.lufs < -60) throw new ProductionFailure('audio', 'missing-narration', `Narration for a scene is silent or missing (${sc.audio}, ${Number.isFinite(m.lufs) ? m.lufs.toFixed(1) : '−∞'} LUFS). Re-run Narration.`);
    narrationGainDb.push(gainTo(m.lufs, NARRATION_LUFS, 15, 20));
  }
  const musicLoud = await measureLoudness(o.ffmpeg, o.music.file, o.signal);
  if (!Number.isFinite(musicLoud.lufs) || musicLoud.lufs < -60)
    throw new ProductionFailure('audio', 'silent-soundtrack', `The soundtrack "${o.music.track.title}" is silent (${Number.isFinite(musicLoud.lufs) ? musicLoud.lufs.toFixed(1) : '−∞'} LUFS) even though it is assigned. Choose another track.`);
  const offsets: number[] = [];
  const totalSec = o.scenes.reduce((t, sc) => (offsets.push(t), t + sc.durationSec), 0);
  const speech = speechIntervals(
    o.scenes.map((sc, i) => ({ offsetSec: offsets[i], durationSec: sc.durationSec, speechSec: sc.speechSec, leadSec: sc.leadSec ?? 0, words: sc.words ?? [] })),
    o.profile.holdGapSec
  );
  fs.mkdirSync(path.join(o.dir, 'stems'), { recursive: true });
  const envelope = 'stems/duck-envelope.wav';
  writeWav(path.join(o.dir, envelope), duckEnvelope(speech, totalSec, o.profile), ENVELOPE_RATE);
  const sfxGain = async (file: string, peak: number) => {
    const m = await measureLoudness(o.ffmpeg, file, o.signal);
    if (!Number.isFinite(m.peakDb)) throw new ProductionFailure('audio', 'silent-sfx', `A sound effect is silent: ${path.basename(file)}.`);
    return peak - m.peakDb;
  };
  const stems = { narration: 'stems/narration.flac', music: 'stems/music.flac', musicDry: 'stems/music-dry.flac', sfx: 'stems/sfx.flac' };
  for (const f of Object.values(stems)) fs.rmSync(path.join(o.dir, f), { force: true });
  const audio: RenderAudio = {
    narrationGainDb,
    music: { path: o.music.file, gainDb: gainTo(musicLoud.lufs, o.profile.musicOpenLufs, 24, 30), envelope },
    sfx: await Promise.all(
      [...new Set(o.effects.map((e) => e.path))].map(async (file) => ({ role: 'contextual' as const, path: file, gainDb: await sfxGain(file, o.profile.effectPeakDb), atSec: o.effects.filter((e) => e.path === file).map((e) => e.atSec) }))
    ),
    stems
  };
  // Final loudness normalisation: measure the finished mix (same graph, audio only) and apply one master gain to
  // every bus, so the delivered file sits at -16 LUFS whatever the speech/music balance of the story, and the stems
  // stay exactly what was mixed.
  const measurePlan = { scenes: o.scenes.map((sc) => ({ image: '', audio: sc.audio, durationSec: sc.durationSec, audioDelaySec: sc.leadSec ?? 0 })), captions: '', output: '', audio } as RenderPlan;
  const out = await ffmpegText(o.ffmpeg, buildMixMeasureArgs(measurePlan), o.signal, o.dir);
  const summary = out.slice(out.lastIndexOf('Summary:'));
  const mixLufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]);
  if (!Number.isFinite(mixLufs)) throw new ProductionFailure('audio', 'mix-measure-failed', `The mix could not be measured before rendering: ${out.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300)}`);
  audio.masterGainDb = Math.max(-6, Math.min(6, NARRATION_LUFS - mixLufs));
  const record: AudioMixRecord = {
    version: AUDIO_PIPELINE_VERSION,
    profile: o.profile.id,
    totalSec,
    scenes: o.scenes.map((sc, i) => ({ offsetSec: offsets[i], durationSec: sc.durationSec })),
    speech,
    music: { trackId: o.music.track.id, title: o.music.track.title, origin: o.music.track.origin, rightsStatus: o.music.track.rightsStatus, embeddable: o.music.embeddable, gainDb: audio.music.gainDb, measuredLufs: musicLoud.lufs },
    narrationGainDb,
    masterGainDb: audio.masterGainDb,
    premasterLufs: mixLufs,
    cues: o.effects.map((e) => ({ role: 'contextual' as const, atSec: e.atSec, trackId: e.trackId })),
    stems,
    envelope
  };
  fs.writeFileSync(path.join(o.dir, MIX_RECORD), JSON.stringify(record, null, 1), 'utf8');
  return { audio, record };
}
