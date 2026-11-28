import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { MixProfile } from '../../shared/audioMix';

/** Sample rate of the ducking envelope file (resampled to 48 kHz in the mix; the envelope itself is smooth). */
export const ENVELOPE_RATE = 8000;

export interface SceneSpeech {
  /** Scene start on the video timeline (s). */
  offsetSec: number;
  durationSec: number;
  /** Length of the narration clip (s). */
  speechSec: number;
  /** Where the clip starts inside the scene (s). */
  leadSec?: number;
  /** Word timings relative to the clip start, when the voice provides them. */
  words?: { start: number; end: number }[];
}

/**
 * Where the narration is speaking, on the video timeline: words grouped into phrases, with pauses shorter than the
 * profile's hold gap bridged (so the music does not pump between words). Without word timings the whole clip counts.
 */
export function speechIntervals(scenes: SceneSpeech[], holdGapSec: number): [number, number][] {
  const raw: [number, number][] = [];
  for (const s of scenes) {
    const words = (s.words ?? []).filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start);
    const at = s.offsetSec + (s.leadSec ?? 0);
    if (words.length) for (const w of words) raw.push([at + Math.max(0, w.start), at + Math.min(s.speechSec, w.end)]);
    else if (s.speechSec > 0) raw.push([at, at + s.speechSec]);
  }
  raw.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of raw) {
    const last = out.at(-1);
    if (last && a - last[1] < holdGapSec) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * Music gain over time (linear, 1 = un-ducked): raised-cosine dips of profile.duckDb that reach full depth as each
 * phrase starts (attack before it) and recover after it ends (release). Deterministic, so QA can verify it exactly.
 */
export function duckEnvelope(intervals: [number, number][], totalSec: number, p: Pick<MixProfile, 'duckDb' | 'attackSec' | 'releaseSec'>, rate = ENVELOPE_RATE): Float32Array {
  const n = Math.max(1, Math.ceil(totalSec * rate));
  const depth = new Float32Array(n);
  const A = Math.max(0.01, p.attackSec);
  const R = Math.max(0.01, p.releaseSec);
  for (const [s, e] of intervals) {
    const from = Math.max(0, Math.floor((s - A) * rate));
    const to = Math.min(n, Math.ceil((e + R) * rate));
    for (let i = from; i < to; i++) {
      const t = i / rate;
      const d = t < s ? 0.5 - 0.5 * Math.cos((Math.PI * (t - (s - A))) / A) : t <= e ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (t - e)) / R);
      if (d > depth[i]) depth[i] = d;
    }
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.pow(10, (-p.duckDb * depth[i]) / 20);
  return out;
}

/** 16-bit mono PCM WAV. */
export function writeWav(file: string, samples: Float32Array, rate: number): void {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

export function ffmpegText(ffmpeg: string, args: string[], signal?: AbortSignal, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = spawn(ffmpeg, ['-hide_banner', '-nostdin', ...args], { windowsHide: true, cwd });
    let err = '';
    c.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-400_000)));
    c.stdout.resume();
    signal?.addEventListener('abort', () => c.kill(), { once: true });
    c.on('error', reject);
    c.on('close', () => resolve(err));
  });
}

export interface Loudness {
  /** Integrated loudness (LUFS); -Infinity for silence or clips too short to gate. */
  lufs: number;
  truePeakDb: number;
  /** Sample peak (dBFS). */
  peakDb: number;
}

/** Measured loudness and peaks of a file (EBU R128 plus sample peak). */
export async function measureLoudness(ffmpeg: string, file: string, signal?: AbortSignal): Promise<Loudness> {
  const out = await ffmpegText(ffmpeg, ['-i', file, '-vn', '-af', 'ebur128=peak=true+sample', '-f', 'null', '-'], signal);
  const s = out.slice(out.lastIndexOf('Summary:'));
  const num = (re: RegExp) => {
    const m = re.exec(s);
    return !m || m[1] === '-inf' ? -Infinity : Number(m[1]);
  };
  const tp = /True peak:\s*\n\s*Peak:\s+(-?[\d.]+|-inf)/.exec(s);
  const sp = /Sample peak:\s*\n\s*Peak:\s+(-?[\d.]+|-inf)/.exec(s);
  if (!s.includes('Summary:')) throw new Error(`Could not measure the loudness of ${file}.`);
  return {
    lufs: num(/I:\s+(-?[\d.]+|-inf) LUFS/),
    truePeakDb: !tp || tp[1] === '-inf' ? -Infinity : Number(tp[1]),
    peakDb: !sp || sp[1] === '-inf' ? -Infinity : Number(sp[1])
  };
}

/** Gain (dB) that brings a measured loudness to a target, limited so a near-silent file is never boosted into noise. */
export const gainTo = (measured: number, target: number, maxBoost = 18, maxCut = 30): number => (Number.isFinite(measured) ? Math.max(-maxCut, Math.min(maxBoost, target - measured)) : 0);

/** Integrated loudness above 200 Hz (what a phone speaker reproduces). */
export async function phoneBandLufs(ffmpeg: string, file: string, signal?: AbortSignal): Promise<number> {
  const out = await ffmpegText(ffmpeg, ['-i', file, '-vn', '-af', 'highpass=f=200,highpass=f=200,ebur128', '-f', 'null', '-'], signal);
  const m = /I:\s+(-?[\d.]+|-inf) LUFS/.exec(out.slice(out.lastIndexOf('Summary:')));
  return !m || m[1] === '-inf' ? -Infinity : Number(m[1]);
}
