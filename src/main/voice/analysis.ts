import fs from 'node:fs';

/**
 * Objective measurements of a narration recording, used by the voice benchmark and by QA.
 * None of this replaces listening; it makes regressions (new gaps, clicks, level jumps, flat delivery) visible.
 */

export interface Mono {
  samples: Float32Array;
  sampleRate: number;
}

/** Read a 16-bit PCM WAV as mono floats (first channel). */
export function readMono(file: string): Mono {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`Not a WAV file: ${file}`);
  let o = 12;
  let ch = 1;
  let sr = 0;
  let bits = 16;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4);
    const sz = b.readUInt32LE(o + 4);
    if (id === 'fmt ') {
      ch = b.readUInt16LE(o + 10);
      sr = b.readUInt32LE(o + 12);
      bits = b.readUInt16LE(o + 22);
    }
    if (id === 'data') {
      if (bits !== 16) throw new Error('Only 16-bit PCM WAV is supported.');
      const data = b.subarray(o + 8, Math.min(b.length, o + 8 + sz));
      const n = Math.floor(data.length / (2 * ch));
      const s = new Float32Array(n);
      for (let i = 0; i < n; i++) s[i] = data.readInt16LE(i * 2 * ch) / 32768;
      return { samples: s, sampleRate: sr };
    }
    o += 8 + sz + (sz & 1);
  }
  throw new Error(`WAV has no data chunk: ${file}`);
}

/** RMS per 10 ms frame. */
export function frameLevels(m: Mono, frameSec = 0.01): number[] {
  const len = Math.max(1, Math.round(m.sampleRate * frameSec));
  const out: number[] = [];
  for (let f = 0; f * len < m.samples.length; f++) {
    let sum = 0;
    const end = Math.min(m.samples.length, (f + 1) * len);
    for (let i = f * len; i < end; i++) sum += m.samples[i] * m.samples[i];
    out.push(Math.sqrt(sum / Math.max(1, end - f * len)));
  }
  return out;
}

export interface Pause {
  start: number;
  duration: number;
}

/** Silences inside the speech (not the leading/trailing silence), at least `minSec` long. */
export function pauses(m: Mono, minSec = 0.06): Pause[] {
  const lv = frameLevels(m);
  const peak = Math.max(1e-6, ...lv);
  const silent = lv.map((r) => r < peak * 0.03);
  const first = silent.indexOf(false);
  if (first < 0) return [];
  const last = silent.lastIndexOf(false);
  const out: Pause[] = [];
  for (let i = first; i <= last; ) {
    if (!silent[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j <= last && silent[j]) j++;
    if ((j - i) / 100 >= minSec) out.push({ start: i / 100, duration: (j - i) / 100 });
    i = j;
  }
  return out;
}

/** Fundamental frequency per 10 ms hop by normalised autocorrelation (null = unvoiced). */
export function pitchTrack(m: Mono, minHz = 70, maxHz = 400): (number | null)[] {
  const sr = m.sampleRate;
  const win = Math.round(sr * 0.04);
  const hop = Math.round(sr * 0.01);
  const lagMin = Math.floor(sr / maxHz);
  const lagMax = Math.ceil(sr / minHz);
  const lv = frameLevels(m);
  const peak = Math.max(1e-6, ...lv);
  const out: (number | null)[] = [];
  const x = m.samples;
  for (let s = 0; s + win + lagMax < x.length; s += hop) {
    const f = Math.floor(s / hop);
    if ((lv[f] ?? 0) < peak * 0.1) {
      out.push(null);
      continue;
    }
    let e0 = 0;
    for (let i = 0; i < win; i++) e0 += x[s + i] * x[s + i];
    let best = 0;
    let bestLag = 0;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let c = 0;
      let e1 = 0;
      for (let i = 0; i < win; i++) {
        c += x[s + i] * x[s + i + lag];
        e1 += x[s + i + lag] * x[s + i + lag];
      }
      const r = c / Math.sqrt(e0 * e1 + 1e-12);
      if (r > best) {
        best = r;
        bestLag = lag;
      }
    }
    out.push(best > 0.6 && bestLag ? sr / bestLag : null);
  }
  return out;
}

/** Sudden jumps out of near-silence: what a hard splice or a cut-off word sounds like. */
export function clicks(m: Mono): number[] {
  const x = m.samples;
  const near = Math.round(m.sampleRate * 0.002);
  const at: number[] = [];
  for (let i = near; i < x.length - near; i++) {
    if (Math.abs(x[i] - x[i - 1]) < 0.12) continue;
    let e = 0;
    for (let k = i - near; k < i - 1; k++) e += x[k] * x[k];
    if (Math.sqrt(e / (near - 1)) < 0.004) {
      at.push(i / m.sampleRate);
      i += near * 10;
    }
  }
  return at;
}

const pct = (v: number[], p: number) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
};
const st = (hz: number) => 12 * Math.log2(hz / 100);

export interface DeliveryMetrics {
  durationSec: number;
  speechSec: number;
  wordsPerSec: number;
  /** Pauses of 60 ms or more, and how many punctuation marks the text gives the voice to pause at. */
  pauseCount: number;
  punctuationSlots: number;
  /** Pauses of 250 ms or more beyond the sentence boundaries: gaps a listener notices inside sentences. */
  strayLongPauses: number;
  longestPauseSec: number;
  /** Mean of the n-1 longest pauses (n = sentences): the typical pause between sentences. */
  sentencePauseSec: number;
  /** Loudness spread over 1-second speech windows (dB); large values mean level jumps. */
  loudnessSpreadDb: number;
  /** Pitch: median and the 10th–90th percentile range in semitones (intonation variety). */
  pitchMedianHz: number;
  pitchRangeSt: number;
  clickCount: number;
}

export function deliveryMetrics(m: Mono, text: string): DeliveryMetrics {
  const words = text.split(/\s+/).filter(Boolean).length;
  const sentences = Math.max(1, (text.match(/[.!?]+(?=\s|$)/g) ?? []).length);
  const slots = (text.match(/[,;:.!?—]+(?=\s|$)/g) ?? []).length;
  const lv = frameLevels(m);
  const peak = Math.max(1e-6, ...lv);
  const speechFrames = lv.filter((r) => r >= peak * 0.03).length;
  const ps = pauses(m);
  const byLength = [...ps].sort((a, b) => b.duration - a.duration);
  const boundary = byLength.slice(0, sentences - 1);
  const stray = byLength.slice(sentences - 1).filter((p) => p.duration >= 0.25).length;
  const windows: number[] = [];
  for (let i = 0; i + 100 <= lv.length; i += 50) {
    const seg = lv.slice(i, i + 100).filter((r) => r >= peak * 0.05);
    if (seg.length > 50) windows.push(20 * Math.log10(Math.sqrt(seg.reduce((a, r) => a + r * r, 0) / seg.length)));
  }
  const f0 = pitchTrack(m).filter((v): v is number => v !== null);
  const dur = m.samples.length / m.sampleRate;
  return {
    durationSec: dur,
    speechSec: speechFrames / 100,
    wordsPerSec: words / Math.max(0.1, speechFrames / 100),
    pauseCount: ps.length,
    punctuationSlots: slots,
    strayLongPauses: stray,
    longestPauseSec: byLength[0]?.duration ?? 0,
    sentencePauseSec: boundary.length ? boundary.reduce((a, p) => a + p.duration, 0) / boundary.length : 0,
    loudnessSpreadDb: windows.length > 1 ? pct(windows, 90) - pct(windows, 10) : 0,
    pitchMedianHz: pct(f0, 50),
    pitchRangeSt: f0.length ? st(pct(f0, 90)) - st(pct(f0, 10)) : 0,
    clickCount: clicks(m).length
  };
}
