import fs from 'node:fs';
import type { WordTiming } from '../media/captions';
import type { Pcm } from '../media/wav';
import { spokenWeight, type SpeechToken } from './pronunciation';

export interface Segment {
  start: number;
  end: number;
}

/** Per-10ms RMS of the first channel (16-bit PCM). */
export function frameRms(pcm: Pcm, frameSec = 0.01): number[] {
  if (pcm.bitsPerSample !== 16) throw new Error('Only 16-bit PCM is supported for timing analysis.');
  const frameLen = Math.max(1, Math.round(pcm.sampleRate * frameSec));
  const step = pcm.channels * 2;
  const total = Math.floor(pcm.data.length / step);
  const out: number[] = [];
  for (let f = 0; f * frameLen < total; f++) {
    let sum = 0;
    let n = 0;
    for (let i = f * frameLen; i < Math.min(total, (f + 1) * frameLen); i++) {
      const v = pcm.data.readInt16LE(i * step);
      sum += v * v;
      n++;
    }
    out.push(Math.sqrt(sum / Math.max(1, n)));
  }
  return out;
}

/**
 * Split one synthesized clip into `n` sentence segments using its pauses:
 * the n-1 longest internal silences become boundaries. If the audio does not
 * contain enough clear pauses, fall back to splitting by spoken length.
 */
export function sentenceSegments(pcm: Pcm, weights: number[], frameSec = 0.01): Segment[] {
  const rms = frameRms(pcm, frameSec);
  const dur = rms.length * frameSec;
  const peak = Math.max(1, ...rms);
  const silent = rms.map((r) => r < peak * 0.04);
  let first = silent.findIndex((s) => !s);
  let last = silent.length - 1 - [...silent].reverse().findIndex((s) => !s);
  if (first < 0) return weights.map(() => ({ start: 0, end: 0 }));
  if (last < first) last = silent.length - 1;
  const n = weights.length;
  const proportional = (): Segment[] => {
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const span = (last - first + 1) * frameSec;
    let t = first * frameSec;
    return weights.map((w) => {
      const s = { start: t, end: t + (w / total) * span };
      t = s.end;
      return s;
    });
  };
  if (n === 1) return [{ start: first * frameSec, end: (last + 1) * frameSec }];
  const runs: { a: number; b: number }[] = [];
  for (let i = first; i <= last; ) {
    if (!silent[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j <= last && silent[j]) j++;
    if ((j - i) * frameSec >= 0.12) runs.push({ a: i, b: j });
    i = j;
  }
  if (runs.length < n - 1) return proportional();
  const cuts = [...runs].sort((x, y) => y.b - y.a - (x.b - x.a)).slice(0, n - 1).sort((x, y) => x.a - y.a);
  // Sanity: each segment should be roughly proportional to its text (within 3x); otherwise trust text length.
  const segs: Segment[] = [];
  let start = first;
  for (const c of cuts) {
    segs.push({ start: start * frameSec, end: c.a * frameSec });
    start = c.b;
  }
  segs.push({ start: start * frameSec, end: Math.min(dur, (last + 1) * frameSec) });
  const totalW = weights.reduce((a, b) => a + b, 0) || 1;
  const totalD = segs.reduce((a, s) => a + (s.end - s.start), 0) || 1;
  const off = segs.some((s, i) => {
    const ratio = (s.end - s.start) / totalD / (weights[i] / totalW);
    return ratio > 3 || ratio < 1 / 3;
  });
  return off ? proportional() : segs;
}

/** Rebuild a clip so sentences are separated by exactly `pauseSec` of silence. Returns new segment times. */
export function respace(pcm: Pcm, segs: Segment[], pauseSec: number, outFile: string, edgeSec = 0.05): { durationSec: number; segments: Segment[] } {
  const frame = pcm.channels * (pcm.bitsPerSample / 8);
  const bytesPerSec = pcm.sampleRate * frame;
  const slice = (a: number, b: number) => {
    const s = Math.max(0, Math.floor(a * pcm.sampleRate)) * frame;
    const e = Math.min(pcm.data.length, Math.ceil(b * pcm.sampleRate) * frame);
    return pcm.data.subarray(s, Math.max(s, e));
  };
  const lead = Buffer.alloc(Math.round(edgeSec * pcm.sampleRate) * frame);
  const gap = Buffer.alloc(Math.round(pauseSec * pcm.sampleRate) * frame);
  const parts: Buffer[] = [lead];
  const out: Segment[] = [];
  let t = lead.length / bytesPerSec;
  segs.forEach((s, i) => {
    if (i > 0) {
      parts.push(gap);
      t += gap.length / bytesPerSec;
    }
    const chunk = slice(s.start, s.end);
    parts.push(chunk);
    out.push({ start: t, end: t + chunk.length / bytesPerSec });
    t += chunk.length / bytesPerSec;
  });
  parts.push(lead);
  const data = Buffer.concat(parts);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(pcm.channels, 22);
  h.writeUInt32LE(pcm.sampleRate, 24);
  h.writeUInt32LE(bytesPerSec, 28);
  h.writeUInt16LE(frame, 32);
  h.writeUInt16LE(pcm.bitsPerSample, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(outFile, Buffer.concat([h, data]));
  return { durationSec: data.length / bytesPerSec, segments: out };
}

/** Word timings inside known sentence segments, weighted by how long each word takes to say; captions show the original words. */
export function tokenTimings(sentences: SpeechToken[][], segs: Segment[]): WordTiming[] {
  const out: WordTiming[] = [];
  sentences.forEach((toks, i) => {
    const seg = segs[i];
    if (!seg || !toks.length) return;
    const w = toks.map(spokenWeight);
    const total = w.reduce((a, b) => a + b, 0) || 1;
    const span = Math.max(0.05, seg.end - seg.start);
    let cursor = seg.start;
    toks.forEach((t, j) => {
      const len = (w[j] / total) * span;
      out.push({ text: t.orig, start: cursor, end: cursor + len * 0.92 });
      cursor += len;
    });
  });
  return out;
}
