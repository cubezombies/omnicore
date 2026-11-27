/**
 * Voice benchmark: the same fixed text (src/shared/voiceBenchmark.ts) through every engine/voice, using the real
 * narration providers exactly as productions do (one synthesis per passage, like one per scene).
 *
 *   npm run voice:bench -- <label> <engine:voice>[,<engine:voice>...]
 *
 * Recordings and metrics are kept in <data>/voice-benchmark/<label>/ so later engine changes can be compared;
 * <data>/voice-benchmark/index.html lists every run side by side.
 */
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'vitest';
import { BENCHMARK_TERMS, VOICE_BENCHMARK, VOICE_BENCHMARK_VERSION } from '../src/shared/voiceBenchmark';
import { DEFAULT_SETTINGS, type ProviderSettings } from '../src/shared/production';
import { narrator } from '../src/main/providers/registry';
import { SherpaWhisper, wordErrorRate } from '../src/main/qa/asr';
import { deliveryMetrics, readMono } from '../src/main/voice/analysis';
import type { NarrationProvider } from '../src/main/providers/types';

const DATA = process.env.AIMO_DATA_DIR ?? path.resolve('data');
const label = process.env.VOICE_BENCH_LABEL ?? 'run';
const voices = (process.env.VOICE_BENCH_VOICES ?? 'sherpa:af_heart').split(',').filter(Boolean);
const OUT = path.join(DATA, 'voice-benchmark');
const dirs = { toolsDir: path.join(DATA, 'tools'), tmpDir: path.join(DATA, 'tmp') };

function provider(spec: string, s: ProviderSettings): NarrationProvider {
  const [engine, ...rest] = spec.split(':');
  const voice = rest.join(':');
  if (engine === 'sherpa') return narrator({ ...s, narration: 'sherpa', sherpaVoice: voice as ProviderSettings['sherpaVoice'] }, dirs);
  if (engine === 'piper') return narrator({ ...s, narration: 'piper', piperVoice: path.join(dirs.toolsDir, 'piper', 'voices', `${voice}.onnx`), piperPath: path.join(dirs.toolsDir, 'piper', 'piper.exe') }, dirs);
  if (engine === 'sapi') return narrator({ ...s, narration: 'windows-sapi', voice }, dirs);
  if (engine === 'kokoro-gpu') return narrator({ ...s, narration: 'sherpa', kokoroBackend: 'gpu', sherpaVoice: voice as ProviderSettings['sherpaVoice'] }, dirs);
  throw new Error(`Unknown engine ${engine}`);
}

/** Join passages the way a render joins scenes: each followed by the scene pad, at one sample rate. */
function join(files: string[], pad: number, out: string): void {
  const parts = files.map(readMono);
  const sr = parts[0].sampleRate;
  const gap = new Float32Array(Math.round(pad * sr));
  const all = parts.flatMap((p) => [p.samples, gap]);
  const n = all.reduce((a, x) => a + x.length, 0);
  const data = Buffer.alloc(n * 2);
  let o = 0;
  for (const x of all) for (const v of x) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), (o++) * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(out, Buffer.concat([h, data]));
}

it('voice benchmark', { timeout: 3_600_000 }, async () => {
  const settings: ProviderSettings = { ...DEFAULT_SETTINGS, pronunciations: [] };
  const asr = new SherpaWhisper(dirs.toolsDir);
  const runDir = path.join(OUT, label);
  fs.mkdirSync(runDir, { recursive: true });
  const results: unknown[] = [];
  for (const spec of voices) {
    const n = provider(spec, settings);
    const st = await n.check(AbortSignal.timeout(60_000));
    if (!st.available) {
      results.push({ voice: spec, error: st.detail });
      console.log(`${spec}: unavailable (${st.detail})`);
      continue;
    }
    const vDir = path.join(runDir, spec.replace(/[^\w.-]+/g, '_'));
    fs.mkdirSync(vDir, { recursive: true });
    const passages: { id: string; genSec: number; heard: string; wer: number | null; metrics: ReturnType<typeof deliveryMetrics>; words: unknown }[] = [];
    for (const p of VOICE_BENCHMARK) {
      const wav = path.join(vDir, `${p.id}.wav`);
      const t0 = Date.now();
      const r = await n.synthesize(p.text, wav, AbortSignal.timeout(600_000));
      const genSec = (Date.now() - t0) / 1000;
      const heard = asr.available() ? await asr.transcribe(wav) : '';
      const m = deliveryMetrics(readMono(wav), p.text);
      passages.push({ id: p.id, genSec, heard: heard.trim(), wer: heard ? wordErrorRate(p.text, heard) : null, metrics: m, words: r.words });
    }
    join(
      VOICE_BENCHMARK.map((p) => path.join(vDir, `${p.id}.wav`)),
      0.35,
      path.join(vDir, 'benchmark.wav')
    );
    const heardAll = passages.map((p) => p.heard).join(' ');
    const terms = BENCHMARK_TERMS.map((t) => ({ term: t.term, heard: t.heardAs.test(heardAll) }));
    const sum = (k: keyof (typeof passages)[number]['metrics']) => passages.reduce((a, p) => a + Number(p.metrics[k]), 0);
    const speech = sum('speechSec');
    const summary = {
      voice: spec,
      genSec: passages.reduce((a, p) => a + p.genSec, 0),
      audioSec: sum('durationSec'),
      rtf: passages.reduce((a, p) => a + p.genSec, 0) / Math.max(0.1, sum('durationSec')),
      wordsPerSec: VOICE_BENCHMARK.reduce((a, p) => a + p.text.split(/\s+/).length, 0) / speech,
      wer: passages.reduce((a, p) => a + (p.wer ?? 0), 0) / passages.length,
      strayLongPauses: sum('strayLongPauses'),
      longestPauseSec: Math.max(...passages.map((p) => p.metrics.longestPauseSec)),
      sentencePauseSec: passages.map((p) => p.metrics.sentencePauseSec).filter(Boolean).reduce((a, b, _, arr) => a + b / arr.length, 0),
      loudnessSpreadDb: Math.max(...passages.map((p) => p.metrics.loudnessSpreadDb)),
      pitchRangeSt: passages.reduce((a, p) => a + p.metrics.pitchRangeSt, 0) / passages.length,
      clickCount: sum('clickCount'),
      termsHeard: `${terms.filter((t) => t.heard).length}/${terms.length}`,
      termsMissed: terms.filter((t) => !t.heard).map((t) => t.term)
    };
    fs.writeFileSync(path.join(vDir, 'results.json'), JSON.stringify({ benchmarkVersion: VOICE_BENCHMARK_VERSION, label, summary, passages }, null, 2));
    results.push(summary);
    console.log(JSON.stringify(summary));
  }
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify({ benchmarkVersion: VOICE_BENCHMARK_VERSION, label, at: new Date().toISOString(), results }, null, 2));
  writeIndex();
});

/** A local page listing every run with players, so voices can be compared by ear side by side. */
function writeIndex(): void {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);
  const runs = fs
    .readdirSync(OUT)
    .filter((d) => fs.existsSync(path.join(OUT, d, 'summary.json')))
    .map((d) => JSON.parse(fs.readFileSync(path.join(OUT, d, 'summary.json'), 'utf8')) as { label: string; at: string; results: Record<string, unknown>[] })
    .sort((a, b) => a.at.localeCompare(b.at));
  const rows = runs
    .flatMap((r) =>
      r.results.map((x) => {
        const dir = `${r.label}/${String(x.voice).replace(/[^\w.-]+/g, '_')}`;
        if (x.error) return `<tr><td>${esc(r.label)}</td><td>${esc(String(x.voice))}</td><td colspan="8">${esc(String(x.error))}</td></tr>`;
        const f = (k: string, d = 2) => Number(x[k]).toFixed(d);
        return `<tr><td>${esc(r.label)}</td><td>${esc(String(x.voice))}</td><td><audio controls preload="none" src="${dir}/benchmark.wav"></audio></td><td>${(Number(x.wer) * 100).toFixed(1)}%</td><td>${esc(String(x.termsHeard))}${(x.termsMissed as string[]).length ? ` <small>(missed ${esc((x.termsMissed as string[]).join(', '))})</small>` : ''}</td><td>${f('wordsPerSec')}</td><td>${f('sentencePauseSec')} s</td><td>${x.strayLongPauses}</td><td>${f('pitchRangeSt', 1)} st</td><td>${f('loudnessSpreadDb', 1)} dB</td><td>${x.clickCount}</td><td>${f('rtf')}</td></tr>`;
      })
    )
    .join('\n');
  const html = `<!doctype html><meta charset="utf-8"><title>Omnicore voice benchmark</title>
<style>body{font:14px system-ui;background:#111;color:#ddd;margin:24px}table{border-collapse:collapse}td,th{padding:6px 10px;border-bottom:1px solid #333;text-align:left;vertical-align:middle}th{color:#9ab}small{color:#999}audio{height:32px}</style>
<h1>Omnicore voice benchmark (v${VOICE_BENCHMARK_VERSION})</h1>
<p>Same text for every voice (src/shared/voiceBenchmark.ts). Word error rate and terms are from Whisper base.en. Stray long pauses: pauses of 250 ms or more inside sentences. Pitch range: 10th–90th percentile in semitones. Loudness spread: 10th–90th percentile over 1 s windows. RTF: generation time ÷ audio length.</p>
<table><tr><th>Run</th><th>Voice</th><th>Listen</th><th>WER</th><th>Terms heard</th><th>Words/s</th><th>Sentence pause</th><th>Stray long pauses</th><th>Pitch range</th><th>Loudness spread</th><th>Clicks</th><th>RTF</th></tr>
${rows}</table>`;
  fs.writeFileSync(path.join(OUT, 'index.html'), html);
}
