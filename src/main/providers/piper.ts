import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PIPER_VOICES, type PiperVoiceId, type ProviderStatus } from '../../shared/production';
import type { WordTiming } from '../media/captions';
import { CancelledError } from '../media/ffmpeg';
import { concatWavs } from '../media/wav';
import { downloadTo } from './http';
import { ProviderUnavailableError, type NarrationProvider, type NarrationResult } from './types';

/** Pause inserted between sentences (Piper clips are synthesised per sentence for exact boundaries). */
export const SENTENCE_GAP_SEC = 0.18;

export function splitForSpeech(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Piper reports no word timings. Sentence boundaries are exact (one clip per
 * sentence); inside a sentence, word times are estimated by letter count, with
 * a small allowance for the silence Piper puts at clip edges.
 */
export function estimateWordTimings(sentences: string[], clipDurations: number[], gapSec: number): WordTiming[] {
  const out: WordTiming[] = [];
  let t = 0;
  sentences.forEach((s, i) => {
    const dur = clipDurations[i] ?? 0;
    const edge = Math.min(0.12, dur * 0.08);
    const words = s.split(/\s+/).filter(Boolean);
    const weights = words.map((w) => w.replace(/[^\p{L}\p{N}]/gu, '').length + 2 + (/[,;:]$/.test(w) ? 3 : 0));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const span = Math.max(0.05, dur - 2 * edge);
    let cursor = t + edge;
    words.forEach((w, j) => {
      const len = (weights[j] / total) * span;
      out.push({ text: w, start: cursor, end: cursor + len * 0.92 });
      cursor += len;
    });
    t += dur + (i < sentences.length - 1 ? gapSec : 0);
  });
  return out;
}

export const lengthScaleFor = (speechRate: number): number => Math.max(0.6, Math.min(1.6, 1 - speechRate * 0.05));

/** The standalone piper.exe only understands single-codepoint phonemes; newer voices use multi-codepoint ones. */
export function voiceIncompatibility(configPath: string): string | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { phoneme_id_map?: Record<string, unknown> };
    const multi = Object.keys(cfg.phoneme_id_map ?? {}).filter((k) => [...k].length > 1);
    return multi.length ? `Voice ${path.basename(configPath, '.onnx.json')} needs a newer Piper than the bundled piper.exe (multi-character phonemes). Install another voice.` : null;
  } catch {
    return `Piper voice config is unreadable: ${configPath}`;
  }
}

export function installedVoices(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.onnx') && fs.existsSync(path.join(dir, `${f}.json`)))
    .map((f) => path.join(dir, f));
}

export class PiperNarration implements NarrationProvider {
  id = 'piper';
  label = 'Piper (local neural voice)';
  costPerUnitUsd = 0;

  constructor(
    private readonly piperExe: string,
    private readonly voice: string,
    private readonly tmpDir: string,
    private readonly speechRate = 0
  ) {}

  private resolveVoice(): string {
    if (this.voice) return this.voice;
    const found = installedVoices(path.dirname(this.piperExe))[0] ?? installedVoices(path.join(path.dirname(this.piperExe), 'voices'))[0];
    if (!found) throw new ProviderUnavailableError('No Piper voice is installed. Install one in Studio → Providers → Narration.');
    return found;
  }

  private problems(): string | null {
    if (!fs.existsSync(this.piperExe)) return `Piper is not installed (looked for ${this.piperExe}). Install it in Studio → Providers → Narration.`;
    try {
      const v = this.resolveVoice();
      if (!fs.existsSync(v)) return `Piper voice not found: ${v}`;
      if (!fs.existsSync(`${v}.json`)) return `Piper voice config missing: ${v}.json`;
      const incompatible = voiceIncompatibility(`${v}.json`);
      if (incompatible) return incompatible;
    } catch (e) {
      return (e as Error).message;
    }
    return null;
  }

  async check(): Promise<ProviderStatus> {
    const base = { id: this.id, kind: 'narration' as const, label: this.label, costPerUnitUsd: 0 };
    const problem = this.problems();
    const voices = [...installedVoices(path.dirname(this.piperExe)), ...installedVoices(path.join(path.dirname(this.piperExe), 'voices'))];
    if (problem) return { ...base, available: false, detail: problem, options: voices };
    return { ...base, available: true, detail: `Voice: ${path.basename(this.resolveVoice(), '.onnx')}`, options: voices };
  }

  async synthesize(text: string, outWav: string, signal: AbortSignal): Promise<NarrationResult> {
    const problem = this.problems();
    if (problem) throw new ProviderUnavailableError(problem);
    const voice = this.resolveVoice();
    const sentences = splitForSpeech(text);
    if (!sentences.length) throw new Error('Nothing to narrate.');
    const partsDir = `${outWav}.parts`;
    fs.mkdirSync(partsDir, { recursive: true });
    const parts = sentences.map((_, i) => path.join(partsDir, `${i}.wav`));
    const lines = sentences.map((s, i) => JSON.stringify({ text: s, output_file: parts[i] })).join('\n') + '\n';
    try {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(new CancelledError());
        const child = spawn(
          this.piperExe,
          ['--model', voice, '--json-input', '--length_scale', lengthScaleFor(this.speechRate).toFixed(2), '--sentence_silence', '0'],
          { cwd: path.dirname(this.piperExe), windowsHide: true, env: { ...process.env, TEMP: this.tmpDir, TMP: this.tmpDir } }
        );
        let err = '';
        child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-3000)));
        child.stdout.resume();
        const onAbort = () => child.kill();
        signal.addEventListener('abort', onAbort, { once: true });
        child.on('error', (e) => reject(new ProviderUnavailableError(`Could not start Piper: ${e.message}`)));
        child.on('close', (code) => {
          signal.removeEventListener('abort', onAbort);
          if (signal.aborted) return reject(new CancelledError());
          if (code !== 0) return reject(new Error(`Piper failed (exit ${code}): ${err.trim().split(/\r?\n/).slice(-3).join(' ')}`));
          resolve();
        });
        child.stdin.end(lines, 'utf8');
      });
      const missing = parts.find((p) => !fs.existsSync(p));
      if (missing) throw new Error('Piper finished without writing every sentence clip.');
      const { durationSec, clipDurations } = concatWavs(parts, outWav, SENTENCE_GAP_SEC);
      if (durationSec < 0.2) throw new Error('Piper produced an empty recording.');
      return { durationSec, words: estimateWordTimings(sentences, clipDurations, SENTENCE_GAP_SEC), voice: path.basename(voice, '.onnx') };
    } finally {
      fs.rmSync(partsDir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// One-click install of Piper + a commercially usable voice into the data dir.

export const PIPER_RELEASE = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip';
export const VOICE_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';

export async function installPiper(
  toolsDir: string,
  voiceId: PiperVoiceId,
  signal: AbortSignal,
  onStatus: (msg: string) => void = () => {}
): Promise<{ piperPath: string; voicePath: string }> {
  const voice = PIPER_VOICES.find((v) => v.id === voiceId);
  if (!voice) throw new Error(`Unknown Piper voice: ${voiceId}`);
  const piperDir = path.join(toolsDir, 'piper');
  const piperExe = path.join(piperDir, 'piper.exe');
  fs.mkdirSync(toolsDir, { recursive: true });
  if (!fs.existsSync(piperExe)) {
    onStatus('Downloading Piper…');
    const zip = path.join(toolsDir, 'piper_windows_amd64.zip');
    await downloadTo(PIPER_RELEASE, zip, { signal, timeoutMs: 300000 });
    onStatus('Unpacking Piper…');
    // Windows 10+ ships bsdtar, which extracts zip archives.
    await new Promise<void>((resolve, reject) => {
      // Use Windows' own bsdtar explicitly: a GNU tar earlier on PATH (e.g. Git Bash) misreads "F:\…" as a remote host.
      const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
      const c = spawn(fs.existsSync(tar) ? tar : 'tar', ['-xf', zip, '-C', toolsDir], { windowsHide: true });
      c.on('error', (e) => reject(new Error(`Could not unpack Piper: ${e.message}`)));
      c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Unpacking Piper failed (exit ${code}).`))));
    });
    fs.rmSync(zip, { force: true });
    if (!fs.existsSync(piperExe)) throw new Error('The Piper download did not contain piper.exe.');
  }
  const voicesDir = path.join(piperDir, 'voices');
  fs.mkdirSync(voicesDir, { recursive: true });
  const onnx = path.join(voicesDir, `${voice.id}.onnx`);
  if (!fs.existsSync(onnx) || !fs.existsSync(`${onnx}.json`)) {
    onStatus(`Downloading voice ${voice.label}…`);
    await downloadTo(`${VOICE_BASE}/${voice.path}/${voice.id}.onnx.json`, `${onnx}.json`, { signal, timeoutMs: 60000 });
    await downloadTo(`${VOICE_BASE}/${voice.path}/${voice.id}.onnx`, onnx, { signal, timeoutMs: 600000 });
  }
  return { piperPath: piperExe, voicePath: onnx };
}
