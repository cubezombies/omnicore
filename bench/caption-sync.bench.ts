/**
 * Caption sync check against a finished video: the captions burned into the MP4's timeline are compared with what
 * the MP4's own audio says in the same time windows (Whisper). If captions drift, words fall outside their window
 * and the error rises; the best time shift estimates the drift.
 *
 *   CAPTION_SYNC_PRODUCTION=10 npx vitest run -c vitest.bench.config.ts --reporter=dot bench/caption-sync.bench.ts
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ffmpegPath from 'ffmpeg-static';
import { it } from 'vitest';
import { SherpaWhisper, wordErrorRate } from '../src/main/qa/asr';

const DATA = process.env.AIMO_DATA_DIR ?? path.resolve('data');
const id = Number(process.env.CAPTION_SYNC_PRODUCTION ?? 0);

const toSec = (t: string) => {
  const [h, m, s] = t.split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
};

/** Word timings a narration engine reported for a benchmark recording, scored the same way (no video needed). */
async function benchSync(spec: string) {
  const vDir = path.join(DATA, 'voice-benchmark', spec);
  const r = JSON.parse(fs.readFileSync(path.join(vDir, 'results.json'), 'utf8')) as { passages: { id: string; words: { text: string; start: number; end: number }[] }[] };
  const asr = new SherpaWhisper(path.join(DATA, 'tools'));
  const out = path.join(DATA, 'tmp', 'sync-bench');
  fs.mkdirSync(out, { recursive: true });
  const shifts = [-0.3, 0, 0.3];
  const byShift: Record<string, number[]> = Object.fromEntries(shifts.map((x) => [x, []]));
  for (const p of r.passages) {
    // Windows of about 2 s, cut at word boundaries the engine reported.
    const wins: { start: number; end: number; text: string }[] = [];
    for (const w of p.words) {
      const last = wins[wins.length - 1];
      if (last && last.end - last.start < 2) {
        last.end = w.end;
        last.text += ` ${w.text}`;
      } else wins.push({ start: w.start, end: w.end, text: w.text });
    }
    for (const shift of shifts)
      for (const [k, w] of wins.entries()) {
        const clip = path.join(out, `${p.id}-${k}.wav`);
        spawnSync(ffmpegPath as unknown as string, ['-y', '-v', 'error', '-ss', String(Math.max(0, w.start + shift - 0.04)), '-to', String(w.end + shift + 0.04), '-i', path.join(vDir, `${p.id}.wav`), '-ar', '16000', clip]);
        byShift[shift].push(wordErrorRate(w.text, await asr.transcribe(clip)));
      }
  }
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  console.log(`SYNCBENCH ${JSON.stringify({ spec, windows: byShift[0].length, werByShift: Object.fromEntries(shifts.map((x) => [x, Number(mean(byShift[x]).toFixed(3))])) })}`);
}

it('caption sync', { timeout: 1_800_000 }, async () => {
  if (process.env.CAPTION_SYNC_BENCH) {
    for (const spec of process.env.CAPTION_SYNC_BENCH.split(',')) await benchSync(spec);
    return;
  }
  const db = new DatabaseSync(path.join(DATA, 'ai-media-operations.db'), { readOnly: true });
  const row = db.prepare('SELECT output_path FROM productions WHERE id = ?').get(id) as { output_path: string } | undefined;
  if (!row?.output_path) throw new Error(`Production ${id} has no video`);
  const dir = path.join(DATA, 'productions', String(id));
  const ass = fs.readdirSync(dir, { recursive: true }).map(String).find((f) => f.endsWith('.ass'));
  if (!ass) throw new Error('No caption file found');
  const cues = fs
    .readFileSync(path.join(dir, ass), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.startsWith('Dialogue:'))
    .map((l) => {
      const f = l.slice(10).split(',');
      return { start: toSec(f[1]), end: toSec(f[2]), style: f[3].trim(), text: f.slice(9).join(',').replace(/\{[^}]*\}/g, '').replace(/\\N/g, ' ').trim() };
    });
  const styles = [...new Set(cues.map((c) => c.style))];
  const spoken = cues.filter((c) => /^(cap|caption|word|default)/i.test(c.style) && c.text);
  const out = path.join(DATA, 'tmp', `sync-${id}`);
  fs.mkdirSync(out, { recursive: true });
  const wav = path.join(out, 'audio.wav');
  spawnSync(ffmpegPath as unknown as string, ['-y', '-v', 'error', '-i', row.output_path, '-ac', '1', '-ar', '16000', wav]);
  // Windows of whole cues, at least 2.5 s long.
  const windows: { start: number; end: number; text: string }[] = [];
  for (const c of spoken) {
    const w = windows[windows.length - 1];
    if (w && w.end - w.start < 2.5 && c.start - w.end < 0.6) {
      w.end = c.end;
      w.text += ` ${c.text}`;
    } else windows.push({ start: c.start, end: c.end, text: c.text });
  }
  const asr = new SherpaWhisper(path.join(DATA, 'tools'));
  const shifts = [-0.6, -0.3, 0, 0.3, 0.6];
  const results: Record<string, number[]> = {};
  for (const shift of shifts) {
    results[shift] = [];
    for (const [k, w] of windows.entries()) {
      const clip = path.join(out, `w${k}.wav`);
      spawnSync(ffmpegPath as unknown as string, ['-y', '-v', 'error', '-ss', String(Math.max(0, w.start + shift - 0.05)), '-to', String(w.end + shift + 0.05), '-i', wav, clip]);
      const heard = await asr.transcribe(clip);
      results[shift].push(wordErrorRate(w.text, heard));
      if (shift === 0) console.log(`SYNC ${w.start.toFixed(2)}-${w.end.toFixed(2)} | ${w.text} | heard: ${heard.trim()}`);
    }
  }
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const best = shifts.reduce((b, s) => (mean(results[s]) < mean(results[b]) ? s : b), 0);
  const summary = {
    production: id,
    styles,
    cues: spoken.length,
    windows: windows.length,
    werAt0: mean(results[0]),
    werByShift: Object.fromEntries(shifts.map((s) => [s, Number(mean(results[s]).toFixed(3))])),
    bestShiftSec: best,
    windowsUnder25pct: results[0].filter((x) => x < 0.25).length,
    lastCueEnd: spoken[spoken.length - 1]?.end
  };
  console.log(`SYNCSUMMARY ${JSON.stringify(summary)}`);
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
});
