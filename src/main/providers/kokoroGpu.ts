import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { KOKORO_VOICES, type KokoroVoiceId, type Pronunciation, type ProviderStatus } from '../../shared/production';
import type { WordTiming } from '../media/captions';
import { CancelledError } from '../media/ffmpeg';
import { readWavPcm } from '../media/wav';
import { kokoroLengthScale } from './sherpa';
import { sentenceSegments, shapePauses, trimSilence, type PauseRules } from './speechTiming';
import { speechTokens, type SpeechToken } from './pronunciation';
import { ProviderUnavailableError, type NarrationProvider, type NarrationResult } from './types';

/**
 * Kokoro through its reference pipeline (PyTorch + misaki), on the GPU when there is one.
 *
 * Same Kokoro v1.0 model and voices as the sherpa-onnx engine, but: misaki is the American-English G2P the model was
 * trained with (gold US dictionary, espeak only for unknown words); a whole scene is spoken in one pass, so intonation
 * runs across its sentences instead of resetting at each one; dictionary entries with IPA are spoken from that IPA; and
 * the model reports when every word starts and ends, so captions follow the voice exactly.
 */

export const kokoroGpuPaths = (toolsDir: string) => {
  const root = path.join(toolsDir, 'kokoro-gpu');
  return { root, python: path.join(root, 'venv', 'Scripts', 'python.exe'), hf: path.join(root, 'hf'), worker: path.join(root, 'worker.py') };
};

// Long-lived worker: loads the model once, then synthesises one request per stdin line. Writes 24 kHz 16-bit WAV.
export const WORKER_PY = String.raw`import json, re, sys, os
os.environ.setdefault('HF_HUB_OFFLINE', '1')
import numpy as np, soundfile as sf, torch
from kokoro import KPipeline
dev = 'cuda' if torch.cuda.is_available() else 'cpu'
pipes = {}
def pipe(lang):
    if lang not in pipes:
        pipes[lang] = KPipeline(lang_code=lang, repo_id='hexgrad/Kokoro-82M', device=dev)
    return pipes[lang]
EDGE = re.compile(r'^([("\'“‘\[]*)(.*?)([)"\'”’\].,;:!?]*)$')
def phon(p, text):
    _, toks = p.g2p(text)
    return ' '.join(t.phonemes for t in toks if t.phonemes)
def markup(p, toks):
    out = []
    for t in toks:
        o = EDGE.match(t['orig']); lead, core, trail = o.group(1), o.group(2), o.group(3)
        if t.get('ph'):
            out.append(f"{lead}[{core}](/{t['ph']}/){trail}")
        elif t['spoken'] != t['orig'] and core:
            s = EDGE.match(t['spoken']).group(2)
            ph = phon(p, s)
            out.append(f"{lead}[{core}](/{ph}/){trail}" if ph else t['orig'])
        else:
            out.append(t['orig'])
    return ' '.join(out)
print(json.dumps({'ready': True, 'device': dev}), flush=True)
for line in sys.stdin:
    req = json.loads(line)
    try:
        p = pipe(req['lang'])
        text = markup(p, req['tokens'])
        audio, words, t = [], [], 0.0
        for r in p(text, voice=req['voice'], speed=req['speed'], split_pattern=None):
            a = r.audio.cpu().numpy()
            for tok in (r.tokens or []):
                if tok.start_ts is not None and tok.end_ts is not None:
                    words.append({'text': tok.text, 'start': t + tok.start_ts, 'end': t + tok.end_ts})
            audio.append(a); t += len(a) / 24000
        if not audio:
            raise RuntimeError('no audio produced')
        sf.write(req['out'], np.concatenate(audio), 24000, subtype='PCM_16')
        print(json.dumps({'id': req['id'], 'ok': True, 'words': words, 'phonemes': text}), flush=True)
    except Exception as e:
        print(json.dumps({'id': req['id'], 'ok': False, 'error': str(e)}), flush=True)
`;

interface WorkerWord {
  text: string;
  start: number;
  end: number;
}

/** One worker per Python install, shared by every narration (the model takes a few seconds to load); stops when idle. */
class Worker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private waiting = new Map<number, (r: Record<string, unknown>) => void>();
  private next = 1;
  private idle: NodeJS.Timeout | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  device = '';

  constructor(private readonly p: ReturnType<typeof kokoroGpuPaths>, private readonly tmpDir: string) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    fs.mkdirSync(this.p.root, { recursive: true });
    if (!fs.existsSync(this.p.worker) || fs.readFileSync(this.p.worker, 'utf8') !== WORKER_PY) fs.writeFileSync(this.p.worker, WORKER_PY, 'utf8');
    this.ready = new Promise<void>((resolve, reject) => {
      const child = spawn(this.p.python, ['-u', this.p.worker], {
        windowsHide: true,
        env: { ...process.env, HF_HOME: this.p.hf, HF_HUB_OFFLINE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf8', TEMP: this.tmpDir, TMP: this.tmpDir }
      });
      this.child = child;
      let err = '';
      child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-3000)));
      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (l) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(l) as Record<string, unknown>;
        } catch {
          return;
        }
        if (msg.ready) {
          this.device = String(msg.device);
          resolve();
        } else this.waiting.get(Number(msg.id))?.(msg);
      });
      child.on('error', (e) => reject(new ProviderUnavailableError(`Could not start Kokoro (GPU): ${e.message}`)));
      child.on('close', (code) => {
        const e = new Error(`Kokoro (GPU) stopped (exit ${code}): ${err.trim().split(/\r?\n/).slice(-2).join(' ')}`);
        reject(e);
        for (const w of this.waiting.values()) w({ ok: false, error: e.message });
        this.waiting.clear();
        this.child = null;
        this.ready = null;
      });
    });
    return this.ready;
  }

  /** Requests run one at a time (one GPU), in order. */
  run(req: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const job = this.queue.then(async () => {
      if (signal.aborted) throw new CancelledError();
      if (this.idle) clearTimeout(this.idle);
      await this.start();
      const id = this.next++;
      const res = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const onAbort = () => {
          this.stop();
          reject(new CancelledError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        this.waiting.set(id, (r) => {
          signal.removeEventListener('abort', onAbort);
          this.waiting.delete(id);
          resolve(r);
        });
        this.child!.stdin.write(`${JSON.stringify({ ...req, id })}\n`, 'utf8');
      });
      // Short hold: the local LLM (Strata) shares this GPU and stalls when it starts a request with no free memory.
      this.idle = setTimeout(() => this.stop(), 20_000);
      this.idle.unref?.();
      return res;
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
    this.ready = null;
  }
}

const workers = new Map<string, Worker>();
const workerFor = (p: ReturnType<typeof kokoroGpuPaths>, tmpDir: string) => {
  let w = workers.get(p.python);
  if (!w) workers.set(p.python, (w = new Worker(p, tmpDir)));
  return w;
};

/** Stop every worker (app shutdown). */
export const stopKokoroGpuWorkers = () => workers.forEach((w) => w.stop());

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Map the model's word timings (misaki tokens, punctuation separate) back onto the script's own words, in order.
 * Captions always show the original spelling.
 */
export function alignWords(tokens: SpeechToken[], model: WorkerWord[], durationSec: number): WordTiming[] {
  const words = model.filter((w) => norm(w.text));
  const out: WordTiming[] = [];
  let j = 0;
  for (const t of tokens) {
    const want = norm(t.orig);
    if (!want) continue;
    let got = '';
    let start: number | null = null;
    let end = 0;
    while (j < words.length && got.length < want.length) {
      if (start === null) start = words[j].start;
      got += norm(words[j].text);
      end = words[j].end;
      j++;
    }
    if (start === null) {
      const last = out[out.length - 1]?.end ?? 0;
      out.push({ text: t.orig, start: Math.min(last, durationSec), end: Math.min(durationSec, last + 0.2) });
    } else out.push({ text: t.orig, start, end });
  }
  return out;
}

/** Standard IPA → Kokoro/misaki phoneme symbols (diphthongs are single symbols there). */
export function ipaToKokoro(ipa: string): string {
  return ipa
    .trim()
    .replace(/^\/|\/$|^\[|\]$/g, '')
    .replace(/eɪ/g, 'A')
    .replace(/aɪ/g, 'I')
    .replace(/oʊ|əʊ/g, 'O')
    .replace(/aʊ/g, 'W')
    .replace(/ɔɪ/g, 'Y')
    .replace(/d͡?ʒ/g, 'ʤ')
    .replace(/t͡?ʃ/g, 'ʧ')
    .replace(/ɝ/g, 'ɜɹ')
    .replace(/ɚ/g, 'əɹ')
    .replace(/[ːˑ.]/g, '')
    .replace(/g/g, 'ɡ')
    .replace(/r/g, 'ɹ')
    .replace(/'/g, 'ˈ');
}

/** Pause limits for a sentence-pause setting (default 0.32 s): sentences 0.40 s, clauses 0.22 s, other gaps 0.09 s. */
export const kokoroPauseRules = (pauseSec: number): PauseRules => ({ sentence: pauseSec + 0.08, clause: Math.min(0.3, 0.1 + pauseSec * 0.38), word: 0.09, paragraph: pauseSec + 0.3 });

/** Indexes of the words that end a paragraph (a blank line follows). */
export function paragraphEnds(text: string): Set<number> {
  const out = new Set<number>();
  let n = 0;
  const paras = text.split(/\n\s*\n/).map((p) => p.split(/\s+/).filter(Boolean).length);
  paras.slice(0, -1).forEach((c) => {
    n += c;
    if (c) out.add(n - 1);
  });
  return out;
}

export class KokoroGpuNarration implements NarrationProvider {
  id = 'kokoro-gpu';
  label = 'Kokoro (GPU, reference pipeline)';
  costPerUnitUsd = 0;
  private readonly p: ReturnType<typeof kokoroGpuPaths>;

  constructor(
    toolsDir: string,
    private readonly voice: KokoroVoiceId,
    private readonly tmpDir: string,
    private readonly opts: { speechRate?: number; pauseSec?: number; pronunciations?: (Pronunciation & { ipa?: string })[] } = {}
  ) {
    this.p = kokoroGpuPaths(toolsDir);
  }

  private problem(): string | null {
    if (!fs.existsSync(this.p.python)) return 'Kokoro (GPU) is not installed. Install it in Studio → Providers → Narration.';
    if (!fs.existsSync(path.join(this.p.hf, 'hub', 'models--hexgrad--Kokoro-82M'))) return 'The Kokoro model has not been downloaded. Reinstall Kokoro (GPU).';
    if (!KOKORO_VOICES.some((v) => v.id === this.voice)) return `Unknown Kokoro voice: ${this.voice}`;
    return null;
  }

  async check(): Promise<ProviderStatus> {
    const base = { id: this.id, kind: 'narration' as const, label: this.label, costPerUnitUsd: 0, options: KOKORO_VOICES.map((v) => v.id) as string[] };
    const p = this.problem();
    return p ? { ...base, available: false, detail: p } : { ...base, available: true, detail: `Voice: ${KOKORO_VOICES.find((v) => v.id === this.voice)!.label}` };
  }

  async synthesize(text: string, outWav: string, signal: AbortSignal): Promise<NarrationResult> {
    const p = this.problem();
    if (p) throw new ProviderUnavailableError(p);
    const prons = this.opts.pronunciations ?? [];
    // misaki says acronyms, plurals and model numbers correctly itself ("GPUs", "RTX 5070"), so only dictionary,
    // built-in and number rules are applied here; dictionary entries with IPA are spoken from the IPA.
    const tokens = speechTokens(text.replace(/\s+/g, ' ').trim(), prons, { acronyms: 'native' });
    if (!tokens.length) throw new Error('Nothing to narrate.');
    const ipa = new Map(prons.filter((x) => x.ipa?.trim()).map((x) => [x.term.toLowerCase(), ipaToKokoro(x.ipa!)]));
    const core = (w: string) => w.replace(/^[("'“‘[]*|[)"'”’\].,;:!?]*$/g, '').toLowerCase();
    const req = {
      lang: this.voice.startsWith('b') ? 'b' : 'a',
      voice: this.voice,
      speed: 1 / kokoroLengthScale(this.opts.speechRate ?? 0),
      out: `${outWav}.raw.wav`,
      tokens: tokens.map((t) => ({ orig: t.orig, spoken: t.spoken, ph: ipa.get(core(t.orig)) }))
    };
    try {
      const r = await workerFor(this.p, this.tmpDir).run(req, signal);
      if (!r.ok) throw new Error(`Kokoro (GPU) failed: ${String(r.error)}`);
      const pcm = readWavPcm(req.out);
      const span = sentenceSegments(pcm, [1]);
      const trimmed = `${outWav}.trim.wav`;
      const { durationSec, segments } = trimSilence(pcm, span, trimmed);
      if (durationSec < 0.3) throw new Error('Kokoro produced an empty recording.');
      const shift = span[0].start - segments[0].start;
      const model = (r.words as WorkerWord[]).map((w) => ({ ...w, start: Math.max(0, w.start - shift), end: Math.max(0, w.end - shift) }));
      // Kokoro's own pauses run long and uneven at commas (0.5 s measured) and sometimes between words; shorten them to
      // what the punctuation calls for, cutting only inside the silence.
      const shaped = shapePauses(readWavPcm(trimmed), alignWords(tokens, model, durationSec), kokoroPauseRules(this.opts.pauseSec ?? 0.32), outWav, paragraphEnds(text));
      fs.rmSync(trimmed, { force: true });
      return { durationSec: shaped.durationSec, words: shaped.words, voice: `kokoro:${this.voice}` };
    } finally {
      fs.rmSync(req.out, { force: true });
    }
  }
}
