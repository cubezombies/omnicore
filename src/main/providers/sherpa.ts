import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { KOKORO_VOICES, type KokoroVoiceId, type Pronunciation, type ProviderStatus } from '../../shared/production';
import { CancelledError } from '../media/ffmpeg';
import { readWavPcm } from '../media/wav';
import { downloadTo } from './http';
import { splitForSpeech } from './piper';
import { speechTokens, spokenText, spokenWeight } from './pronunciation';
import { sentenceSegments, tokenTimings, trimSilence } from './speechTiming';
import { ProviderUnavailableError, type NarrationProvider, type NarrationResult } from './types';

/** 1.x keeps espeak-ng for words missing from Kokoro's lexicon; 2.x silently drops them (verified: "delivers", "tokens", "30" vanished). */
export const SHERPA_VERSION = 'v1.13.8';
export const SHERPA_DIRNAME = `sherpa-onnx-${SHERPA_VERSION}-win-x64-shared-MD-Release`;
export const SHERPA_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/${SHERPA_VERSION}/${SHERPA_DIRNAME}.tar.bz2`;
export const KOKORO_DIRNAME = 'kokoro-multi-lang-v1_0';
export const KOKORO_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${KOKORO_DIRNAME}.tar.bz2`;

export const sherpaPaths = (toolsDir: string) => {
  const root = path.join(toolsDir, 'sherpa');
  return {
    root,
    exe: path.join(root, SHERPA_DIRNAME, 'bin', 'sherpa-onnx-offline-tts.exe'),
    kokoro: path.join(root, 'models', KOKORO_DIRNAME)
  };
};

/** Kokoro speed: rate -10..10 maps to a gentle 0.87x–1.15x range so narration never becomes rushed. */
/**
 * Kokoro's own pause model scales every punctuation pause (commas, colons, sentence ends) by --tts-silence-scale.
 * Measured on Heart: 0.4 gives about 0.31 s between sentences and 0.12 s at commas, a natural reading rhythm.
 * The sentence-pause setting picks the scale, so pauses stay where the model put them instead of being spliced in.
 */
export const kokoroSilenceScale = (pauseSec: number): number => Math.max(0.1, Math.min(1.2, pauseSec / 0.8));

/**
 * espeak-ng's "en" is British English. US voices must use "en-us" (verified: with "en", Heart said "wɔːtə", "təmɑːtəʊ"
 * and "kɑːnt"; with "en-us", "wɔːɾɚ", "təmeɪɾoʊ" and "kænt").
 */
export const kokoroLang = (voice: string): string => (voice.startsWith('b') ? 'en-gb' : 'en-us');

export const kokoroLengthScale = (speechRate: number): number => Math.max(0.87, Math.min(1.15, 1 - speechRate * 0.025));

export class SherpaKokoroNarration implements NarrationProvider {
  id = 'sherpa';
  label = 'Kokoro (sherpa-onnx, local neural voice)';
  costPerUnitUsd = 0;
  private readonly p: ReturnType<typeof sherpaPaths>;

  constructor(
    toolsDir: string,
    private readonly voice: KokoroVoiceId,
    private readonly tmpDir: string,
    private readonly opts: { speechRate?: number; pauseSec?: number; pronunciations?: Pronunciation[]; threads?: number; /** Skip pronunciation handling (for A/B evaluation). */ rawText?: boolean } = {}
  ) {
    this.p = sherpaPaths(toolsDir);
  }

  private problem(): string | null {
    if (!fs.existsSync(this.p.exe)) return 'Kokoro is not installed. Install it in Studio → Providers → Narration (free, ~375 MB download).';
    for (const f of ['model.onnx', 'voices.bin', 'tokens.txt', 'lexicon-us-en.txt', 'espeak-ng-data']) {
      if (!fs.existsSync(path.join(this.p.kokoro, f))) return `Kokoro model file missing: ${f}. Reinstall Kokoro in Studio → Providers.`;
    }
    if (!KOKORO_VOICES.some((v) => v.id === this.voice)) return `Unknown Kokoro voice: ${this.voice}`;
    return null;
  }

  async check(): Promise<ProviderStatus> {
    const base = { id: this.id, kind: 'narration' as const, label: this.label, costPerUnitUsd: 0, options: KOKORO_VOICES.map((v) => v.id) as string[] };
    const p = this.problem();
    return p ? { ...base, available: false, detail: p } : { ...base, available: true, detail: `Voice: ${KOKORO_VOICES.find((v) => v.id === this.voice)!.label}` };
  }

  private run(text: string, out: string, signal: AbortSignal): Promise<void> {
    const sid = KOKORO_VOICES.find((v) => v.id === this.voice)!.sid;
    const lexicon = this.voice.startsWith('b') ? 'lexicon-gb-en.txt' : 'lexicon-us-en.txt';
    const args = [
      `--kokoro-model=./model.onnx`,
      `--kokoro-voices=./voices.bin`,
      `--kokoro-tokens=./tokens.txt`,
      `--kokoro-lexicon=./${lexicon}`,
      `--kokoro-data-dir=./espeak-ng-data`,
      `--kokoro-lang=${kokoroLang(this.voice)}`,
      `--tts-silence-scale=${kokoroSilenceScale(this.opts.pauseSec ?? 0.32).toFixed(3)}`,
      `--kokoro-length-scale=${kokoroLengthScale(this.opts.speechRate ?? 0).toFixed(3)}`,
      `--num-threads=${this.opts.threads ?? 4}`,
      `--sid=${sid}`,
      `--output-filename=${out}`,
      text
    ];
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new CancelledError());
      const child = spawn(this.p.exe, args, { cwd: this.p.kokoro, windowsHide: true, env: { ...process.env, TEMP: this.tmpDir, TMP: this.tmpDir } });
      let err = '';
      child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
      child.stdout.resume();
      const onAbort = () => child.kill();
      signal.addEventListener('abort', onAbort, { once: true });
      child.on('error', (e) => reject(new ProviderUnavailableError(`Could not start sherpa-onnx: ${e.message}`)));
      child.on('close', (code) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) return reject(new CancelledError());
        if (code !== 0 || !fs.existsSync(out)) {
          const msg = err.split(/\r?\n/).filter((l) => l && !/parse-options/.test(l)).slice(-2).join(' ');
          return reject(new Error(`Kokoro failed (exit ${code}): ${msg || 'no output written'}`));
        }
        resolve();
      });
    });
  }

  async synthesize(text: string, outWav: string, signal: AbortSignal): Promise<NarrationResult> {
    const p = this.problem();
    if (p) throw new ProviderUnavailableError(p);
    const sentences = splitForSpeech(text).map((s) =>
      this.opts.rawText ? s.split(/\s+/).filter(Boolean).map((w) => ({ orig: w, spoken: w })) : speechTokens(s, this.opts.pronunciations, { acronyms: 'dotted' })
    );
    if (!sentences.length) throw new Error('Nothing to narrate.');
    const raw = `${outWav}.raw.wav`;
    try {
      await this.run(sentences.map(spokenText).join(' '), raw, signal);
      const pcm = readWavPcm(raw);
      const weights = sentences.map((toks) => toks.reduce((a, t) => a + spokenWeight(t), 0));
      const segs = sentenceSegments(pcm, weights);
      // The recording is kept as the model spoke it (no cutting and re-spacing): only the leading and trailing silence is trimmed.
      const { durationSec, segments } = trimSilence(pcm, segs, outWav);
      if (durationSec < 0.3) throw new Error('Kokoro produced an empty recording.');
      return { durationSec, words: tokenTimings(sentences, segments), voice: `kokoro:${this.voice}` };
    } finally {
      fs.rmSync(raw, { force: true });
    }
  }
}

/** One-click install of the sherpa-onnx runtime and the Kokoro v1.0 model into <data>/tools/sherpa. */
export async function installKokoro(toolsDir: string, signal: AbortSignal, onStatus: (m: string) => void = () => {}): Promise<void> {
  const p = sherpaPaths(toolsDir);
  fs.mkdirSync(path.join(p.root, 'models'), { recursive: true });
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const unpack = (file: string, dest: string) =>
    new Promise<void>((resolve, reject) => {
      const c = spawn(fs.existsSync(tar) ? tar : 'tar', ['-xf', file, '-C', dest], { windowsHide: true });
      c.on('error', (e) => reject(new Error(`Could not unpack ${path.basename(file)}: ${e.message}`)));
      c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Unpacking ${path.basename(file)} failed (exit ${code}).`))));
    });
  const steps: [boolean, string, string, string][] = [
    [fs.existsSync(p.exe), SHERPA_URL, p.root, 'sherpa-onnx runtime'],
    [fs.existsSync(path.join(p.kokoro, 'model.onnx')), KOKORO_URL, path.join(p.root, 'models'), 'Kokoro v1.0 model']
  ];
  for (const [done, url, dest, label] of steps) {
    if (done) continue;
    onStatus(`Downloading ${label}…`);
    const file = path.join(p.root, path.basename(url));
    await downloadTo(url, file, { signal, timeoutMs: 1_800_000 });
    onStatus(`Unpacking ${label}…`);
    await unpack(file, dest);
    fs.rmSync(file, { force: true });
  }
  if (!fs.existsSync(p.exe) || !fs.existsSync(path.join(p.kokoro, 'model.onnx'))) throw new Error('Kokoro install finished but files are missing.');
}
