// Real voice comparison: synthesises the same technical script with every working local
// engine/voice and writes WAVs + metrics. Gated: AIMO_VOICE_EVAL=1, AIMO_TOOLS_DIR=<tools dir>,
// AIMO_VOICE_EVAL_OUT=<output dir>. Nothing here is mocked.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SapiNarration } from '../src/main/providers/narration';
import { PiperNarration, installPiper } from '../src/main/providers/piper';
import { SherpaKokoroNarration } from '../src/main/providers/sherpa';
import { concatWavs } from '../src/main/media/wav';
import type { NarrationProvider } from '../src/main/providers/types';

const run = process.env.AIMO_VOICE_EVAL === '1' ? describe : describe.skip;

export const EVAL_SCRIPT =
  'NVIDIA says its new GPU delivers up to 30x faster inference for LLMs. ' +
  'Researchers on arXiv describe speculative decoding, where a small draft model proposes tokens and a larger model verifies them. ' +
  "The EU's AI Act now requires transparency for general-purpose AI models, and companies like OpenAI and Google DeepMind must document their training data.";

run('voice evaluation (real engines)', () => {
  it('synthesises the comparison set', async () => {
    const tools = process.env.AIMO_TOOLS_DIR!;
    const out = process.env.AIMO_VOICE_EVAL_OUT!;
    fs.mkdirSync(out, { recursive: true });
    const tmp = path.join(out, 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    const piperDir = path.join(tools, 'piper');
    await installPiper(tools, 'en_US-norman-medium', AbortSignal.timeout(600_000));
    const voices: [string, NarrationProvider][] = [
      ['sapi-david', new SapiNarration(tmp, 'Microsoft David Desktop', 0)],
      ['sapi-zira', new SapiNarration(tmp, 'Microsoft Zira Desktop', 0)],
      ['piper-john', new PiperNarration(path.join(piperDir, 'piper.exe'), path.join(piperDir, 'voices', 'en_US-john-medium.onnx'), tmp)],
      ['piper-norman', new PiperNarration(path.join(piperDir, 'piper.exe'), path.join(piperDir, 'voices', 'en_US-norman-medium.onnx'), tmp)],
      ['kokoro-am_michael-raw', new SherpaKokoroNarration(tools, 'am_michael', tmp, { rawText: true })],
      ...(['am_michael', 'am_fenrir', 'am_puck', 'am_onyx', 'af_heart', 'af_bella', 'af_nicole', 'bm_george', 'bf_emma'] as const).map(
        (v): [string, NarrationProvider] => [`kokoro-${v}`, new SherpaKokoroNarration(tools, v, tmp)]
      )
    ];
    const metrics: Record<string, unknown>[] = [];
    for (const [name, p] of voices) {
      const file = path.join(out, `${name}.wav`);
      const t0 = Date.now();
      try {
        const r = await p.synthesize(EVAL_SCRIPT, file, AbortSignal.timeout(300_000));
        const words = EVAL_SCRIPT.split(/\s+/).length;
        metrics.push({ name, file, durationSec: +r.durationSec.toFixed(2), wordsPerSec: +(words / r.durationSec).toFixed(2), synthSec: +((Date.now() - t0) / 1000).toFixed(2), timedWords: r.words.length });
      } catch (e) {
        metrics.push({ name, error: (e as Error).message });
      }
    }
    // Other sherpa-onnx models (CC0 Piper Joe, Apache-2.0 Kitten mini) run directly through the CLI for comparison.
    const exe = path.join(tools, 'sherpa', 'sherpa-onnx-v1.13.8-win-x64-shared-MD-Release', 'bin', 'sherpa-onnx-offline-tts.exe');
    const direct: [string, string, string[]][] = [
      ['sherpa-piper-joe', 'vits-piper-en_US-joe-medium', ['--vits-model=./en_US-joe-medium.onnx', '--vits-tokens=./tokens.txt', '--vits-data-dir=./espeak-ng-data']],
      ['sherpa-kitten-mini', 'kitten-mini-en-v0_8', ['--kitten-model=./model.onnx', '--kitten-voices=./voices.bin', '--kitten-tokens=./tokens.txt', '--kitten-data-dir=./espeak-ng-data', '--sid=0']]
    ];
    for (const [name, dir, args] of direct) {
      const file = path.join(out, `${name}.wav`);
      const t0 = Date.now();
      try {
        execFileSync(exe, [...args, '--num-threads=4', `--output-filename=${file}`, EVAL_SCRIPT], { cwd: path.join(tools, 'sherpa', 'models', dir), stdio: 'ignore' });
        const buf = fs.readFileSync(file);
        const dur = (buf.length - 44) / buf.readUInt32LE(28);
        metrics.push({ name, file, durationSec: +dur.toFixed(2), wordsPerSec: +(EVAL_SCRIPT.split(/\s+/).length / dur).toFixed(2), synthSec: +((Date.now() - t0) / 1000).toFixed(2) });
      } catch (e) {
        metrics.push({ name, error: (e as Error).message });
      }
    }
    fs.writeFileSync(path.join(out, 'metrics.json'), JSON.stringify(metrics, null, 2));
    expect(metrics.filter((m) => !m.error).length).toBeGreaterThanOrEqual(8);
  }, 1_800_000);
});

// Full-length narration of real Omnicore scripts, voiced scene by scene with production settings
// (sentence pause, scene padding), joined into one WAV per voice. Gated: AIMO_VOICE_FULL=1,
// AIMO_TOOLS_DIR, AIMO_VOICE_EVAL_OUT, AIMO_VOICE_SCRIPTS=<name>=<json file of scene narrations>;…
const runFull = process.env.AIMO_VOICE_FULL === '1' ? describe : describe.skip;
runFull('full narration samples (real engines)', () => {
  it('voices each script with each selected Kokoro voice', async () => {
    const tools = process.env.AIMO_TOOLS_DIR!;
    const out = process.env.AIMO_VOICE_EVAL_OUT!;
    const tmp = path.join(out, 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    const voices = (process.env.AIMO_VOICE_LIST ?? 'af_bella,bf_emma').split(',') as ('af_bella' | 'bf_emma')[];
    const scripts = (process.env.AIMO_VOICE_SCRIPTS ?? '').split(';').filter(Boolean).map((s) => s.split('=') as [string, string]);
    const metrics: Record<string, unknown>[] = [];
    for (const [name, file] of scripts) {
      const scenes = JSON.parse(fs.readFileSync(file, 'utf8')) as string[];
      const words = scenes.join(' ').split(/\s+/).length;
      for (const v of voices) {
        const k = new SherpaKokoroNarration(tools, v, tmp, { pauseSec: 0.32 });
        const t0 = Date.now();
        const clips: string[] = [];
        let narrated = 0;
        for (const [i, text] of scenes.entries()) {
          const clip = path.join(tmp, `${name}-${v}-${i}.wav`);
          narrated += (await k.synthesize(text, clip, AbortSignal.timeout(300_000))).durationSec;
          clips.push(clip);
        }
        const target = path.join(out, `full-${name}-${v}.wav`);
        const { durationSec } = concatWavs(clips, target, 0.35); // same pause as the renderer's scene padding
        for (const c of clips) fs.rmSync(c, { force: true });
        metrics.push({ name: `full-${name}-${v}`, file: target, voice: v, script: name, words, durationSec: +durationSec.toFixed(2), speechSec: +narrated.toFixed(2), wordsPerSec: +(words / narrated).toFixed(2), synthSec: +((Date.now() - t0) / 1000).toFixed(1), text: scenes.join(' ') });
      }
    }
    fs.writeFileSync(path.join(out, 'full-metrics.json'), JSON.stringify(metrics, null, 2));
    expect(metrics.length).toBe(scripts.length * voices.length);
  }, 1_800_000);
});
