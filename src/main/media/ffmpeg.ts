import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';

export class FfmpegError extends Error {
  constructor(message: string, readonly stderrTail = '') {
    super(message);
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
  }
}

/**
 * Locate FFmpeg: an explicit path from settings wins, then the bundled
 * ffmpeg-static binary (unpacked from the asar in packaged builds).
 */
export function resolveFfmpeg(configured: string): string {
  if (configured) {
    if (!fs.existsSync(configured)) throw new FfmpegError(`FFmpeg not found at the configured path: ${configured}`);
    return configured;
  }
  let bundled: string | null = null;
  try {
    bundled = createRequire(__filename)('ffmpeg-static') as string | null;
  } catch {
    bundled = null;
  }
  if (bundled) {
    const unpacked = bundled.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    if (fs.existsSync(unpacked)) return unpacked;
    if (fs.existsSync(bundled)) return bundled;
  }
  throw new FfmpegError('FFmpeg is not available. Reinstall the app or set an FFmpeg path in Studio → Providers.');
}

export interface RunOptions {
  cwd?: string;
  signal?: AbortSignal;
  /** Total output duration, used to turn -progress output into a 0..1 fraction. */
  totalSec?: number;
  onProgress?: (fraction: number) => void;
}

/** Run FFmpeg; resolves on exit code 0, rejects with the stderr tail otherwise. */
export function runFfmpeg(ffmpeg: string, args: string[], o: RunOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) return reject(new CancelledError());
    const full = ['-hide_banner', '-nostdin', '-y', ...(o.onProgress ? ['-progress', 'pipe:1', '-nostats'] : []), ...args];
    const child = spawn(ffmpeg, full, { cwd: o.cwd, windowsHide: true });
    let stderr = '';
    let buf = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-6000);
    });
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && o.totalSec && o.onProgress) o.onProgress(Math.min(1, Number(m[1]) / 1e6 / o.totalSec));
      }
    });
    const onAbort = () => child.kill();
    o.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      o.signal?.removeEventListener('abort', onAbort);
      reject(new FfmpegError(`Could not start FFmpeg: ${e.message}`));
    });
    child.on('close', (code) => {
      o.signal?.removeEventListener('abort', onAbort);
      if (o.signal?.aborted) return reject(new CancelledError());
      if (code === 0) return resolve();
      const tail = stderr.trim().split(/\r?\n/).slice(-6).join('\n');
      reject(new FfmpegError(`FFmpeg failed (exit ${code}): ${tail}`, tail));
    });
  });
}

export interface ProbeResult {
  durationSec: number;
  video: { codec: string; width: number; height: number } | null;
  audio: { codec: string; sampleRate: number } | null;
}

/** Minimal media probe using `ffmpeg -i` (avoids shipping ffprobe). */
export function probe(ffmpeg: string, file: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-i', file], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', (e) => reject(new FfmpegError(`Could not start FFmpeg: ${e.message}`)));
    child.on('close', () => {
      const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
      if (!d) return reject(new FfmpegError(`Not a readable media file: ${file}`));
      const v = /Stream #\S+.*Video: (\w+).*?, (\d{2,5})x(\d{2,5})/.exec(err);
      const a = /Stream #\S+.*Audio: (\w+).*?, (\d+) Hz/.exec(err);
      resolve({
        durationSec: Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]),
        video: v ? { codec: v[1], width: Number(v[2]), height: Number(v[3]) } : null,
        audio: a ? { codec: a[1], sampleRate: Number(a[2]) } : null
      });
    });
  });
}
