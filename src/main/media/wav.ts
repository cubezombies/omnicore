import fs from 'node:fs';

/** Duration of a PCM WAV file in seconds, read from its RIFF header. */
export function wavDurationSec(file: string): number {
  const buf = fs.readFileSync(file);
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`Not a WAV file: ${file}`);
  }
  let off = 12;
  let byteRate = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(off + 16);
    if (id === 'data') {
      if (!byteRate) throw new Error(`WAV has no fmt chunk: ${file}`);
      const dataSize = Math.min(size, buf.length - off - 8);
      return dataSize / byteRate;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`WAV has no data chunk: ${file}`);
}

/** Write a mono 16-bit PCM WAV (used by tests and silent padding). */
export function writeWav(file: string, samples: Float32Array, sampleRate = 22050): void {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

export interface Pcm {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  data: Buffer;
}

/** Read a PCM WAV's format and raw sample data. */
export function readWavPcm(file: string): Pcm {
  const buf = fs.readFileSync(file);
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`Not a WAV file: ${file}`);
  let off = 12;
  let fmt: Omit<Pcm, 'data'> | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      if (buf.readUInt16LE(off + 8) !== 1) throw new Error(`Only PCM WAV is supported: ${file}`);
      fmt = { channels: buf.readUInt16LE(off + 10), sampleRate: buf.readUInt32LE(off + 12), bitsPerSample: buf.readUInt16LE(off + 22) };
    }
    if (id === 'data') {
      if (!fmt) throw new Error(`WAV has no fmt chunk: ${file}`);
      return { ...fmt, data: buf.subarray(off + 8, off + 8 + Math.min(size, buf.length - off - 8)) };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`WAV has no data chunk: ${file}`);
}

/** Concatenate same-format PCM clips with optional silence between them. */
export function concatWavs(files: string[], out: string, gapSec = 0): { durationSec: number; clipDurations: number[] } {
  if (!files.length) throw new Error('Nothing to concatenate.');
  const clips = files.map(readWavPcm);
  const f = clips[0];
  for (const c of clips) {
    if (c.sampleRate !== f.sampleRate || c.channels !== f.channels || c.bitsPerSample !== f.bitsPerSample) throw new Error('Clips have different audio formats.');
  }
  const frame = (f.channels * f.bitsPerSample) / 8;
  const gap = Buffer.alloc(Math.round(gapSec * f.sampleRate) * frame);
  const parts: Buffer[] = [];
  clips.forEach((c, i) => {
    if (i > 0 && gap.length) parts.push(gap);
    parts.push(c.data);
  });
  const data = Buffer.concat(parts);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(f.channels, 22);
  h.writeUInt32LE(f.sampleRate, 24);
  h.writeUInt32LE(f.sampleRate * frame, 28);
  h.writeUInt16LE(frame, 32);
  h.writeUInt16LE(f.bitsPerSample, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(out, Buffer.concat([h, data]));
  const bytesPerSec = f.sampleRate * frame;
  return { durationSec: data.length / bytesPerSec, clipDurations: clips.map((c) => c.data.length / bytesPerSec) };
}
