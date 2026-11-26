import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CancelledError } from '../media/ffmpeg';
import { downloadTo } from '../providers/http';
import { sherpaPaths } from '../providers/sherpa';

// Independent speech recognition for QA: Whisper base.en (MIT) through the same sherpa-onnx
// runtime used for Kokoro. It checks what the narration actually says, not what the script says.
export const ASR_DIRNAME = 'sherpa-onnx-whisper-base.en';
export const ASR_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${ASR_DIRNAME}.tar.bz2`;

export const asrPaths = (toolsDir: string) => {
  const p = sherpaPaths(toolsDir);
  const dir = path.join(p.root, 'models', ASR_DIRNAME);
  return {
    exe: path.join(path.dirname(p.exe), 'sherpa-onnx-offline.exe'),
    encoder: path.join(dir, 'base.en-encoder.int8.onnx'),
    decoder: path.join(dir, 'base.en-decoder.int8.onnx'),
    tokens: path.join(dir, 'base.en-tokens.txt'),
    dir
  };
};

export interface Transcriber {
  available(): boolean;
  transcribe(wav: string, signal?: AbortSignal): Promise<string>;
}

export class SherpaWhisper implements Transcriber {
  private readonly p: ReturnType<typeof asrPaths>;
  constructor(toolsDir: string) {
    this.p = asrPaths(toolsDir);
  }
  available(): boolean {
    return [this.p.exe, this.p.encoder, this.p.decoder, this.p.tokens].every((f) => fs.existsSync(f));
  }
  transcribe(wav: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new CancelledError());
      const c = spawn(this.p.exe, [`--whisper-encoder=${this.p.encoder}`, `--whisper-decoder=${this.p.decoder}`, `--tokens=${this.p.tokens}`, '--num-threads=4', wav], { windowsHide: true });
      let out = '';
      c.stdout.on('data', (d: Buffer) => (out += d.toString()));
      c.stderr.on('data', (d: Buffer) => (out += d.toString()));
      const onAbort = () => c.kill();
      signal?.addEventListener('abort', onAbort, { once: true });
      c.on('error', (e) => reject(new Error(`Could not start speech recognition: ${e.message}`)));
      c.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) return reject(new CancelledError());
        const m = /"text":\s*"((?:[^"\\]|\\.)*)"/.exec(out);
        if (code !== 0 || !m) return reject(new Error(`Speech recognition failed (exit ${code}).`));
        resolve(JSON.parse(`"${m[1]}"`) as string);
      });
    });
  }
}

/** Download Whisper base.en for sherpa-onnx, keeping only the int8 files (~100 MB on disk). */
export async function installAsr(toolsDir: string, signal: AbortSignal): Promise<void> {
  const p = asrPaths(toolsDir);
  if (fs.existsSync(p.encoder) && fs.existsSync(p.decoder)) return;
  const modelsDir = path.dirname(p.dir);
  fs.mkdirSync(modelsDir, { recursive: true });
  const file = path.join(modelsDir, `${ASR_DIRNAME}.tar.bz2`);
  await downloadTo(ASR_URL, file, { signal, timeoutMs: 1_800_000 });
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  await new Promise<void>((resolve, reject) => {
    const c = spawn(fs.existsSync(tar) ? tar : 'tar', ['-xf', file, '-C', modelsDir], { windowsHide: true });
    c.on('error', (e) => reject(e));
    c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Unpacking the speech model failed (exit ${code}).`))));
  });
  fs.rmSync(file, { force: true });
  for (const f of ['base.en-encoder.onnx', 'base.en-decoder.onnx']) fs.rmSync(path.join(p.dir, f), { force: true });
  fs.rmSync(path.join(p.dir, 'test_wavs'), { recursive: true, force: true });
}

const NUM: Record<string, string> = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', twenty: '20', thirty: '30', forty: '40', fifty: '50', hundred: '100' };
/** Normalise for word comparison: case, punctuation, common ASR spellings of acronyms and numbers. */
export function normaliseWords(s: string): string[] {
  return s
    .replace(/[’‘ʼ]/g, "'")
    .toLowerCase()
    .replace(/(\d)x\b/g, '$1 times')
    .replace(/%/g, ' percent')
    .replace(/\b([a-z])\.(?=[a-z]\.)/g, '$1')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/'/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => NUM[w] ?? w);
}

/**
 * Word error rate (Levenshtein over words). Mid-sentence capitalised words (names) cost half on substitution:
 * a recogniser cannot be expected to spell "Huang" (heard, correctly pronounced, as "Wong").
 */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const r: { w: string; name: boolean }[] = [];
  let sentenceStart = true;
  for (const tok of reference.split(/\s+/).filter(Boolean)) {
    const name = !sentenceStart && /^[("'“‘]*\p{Lu}/u.test(tok);
    for (const w of normaliseWords(tok)) r.push({ w, name });
    sentenceStart = /[.!?:]["'”’)]*$/.test(tok);
  }
  const h = normaliseWords(hypothesis);
  if (!r.length) return h.length ? 1 : 0;
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    const sub = r[i - 1].name ? 0.5 : 1;
    for (let j = 1; j <= h.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1].w === h[j - 1] ? 0 : sub));
    prev = cur;
  }
  return prev[h.length] / r.length;
}
