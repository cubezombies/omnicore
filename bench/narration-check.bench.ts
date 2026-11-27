/**
 * Check a production's narration before rendering: per scene, what Whisper hears against the script, pauses, clicks
 * and level; plus the joins between scenes (level and pitch either side), as heard in the joined track.
 *   NARRATION_CHECK_PRODUCTION=10 npx vitest run -c vitest.bench.config.ts --reporter=dot bench/narration-check.bench.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { it } from 'vitest';
import { SherpaWhisper, wordErrorRate } from '../src/main/qa/asr';
import { deliveryMetrics, frameLevels, pitchTrack, readMono } from '../src/main/voice/analysis';
import { BENCHMARK_TERMS } from '../src/shared/voiceBenchmark';

const DATA = process.env.AIMO_DATA_DIR ?? path.resolve('data');
const id = Number(process.env.NARRATION_CHECK_PRODUCTION ?? 0);

it('narration check', { timeout: 1_800_000 }, async () => {
  const db = new DatabaseSync(path.join(DATA, 'ai-media-operations.db'), { readOnly: true });
  const p = db.prepare('SELECT storyboard FROM productions WHERE id = ?').get(id) as { storyboard: string };
  const scenes = (JSON.parse(p.storyboard) as { scenes: { index: number; narration: string }[] }).scenes;
  const dir = path.join(DATA, 'productions', String(id), 'audio');
  const asr = new SherpaWhisper(path.join(DATA, 'tools'));
  const edge = (file: string, end: boolean) => {
    const m = readMono(file);
    const lv = frameLevels(m).filter((r) => r > 0.01);
    const part = end ? lv.slice(-80) : lv.slice(0, 80);
    const f0 = pitchTrack(m).filter((x): x is number => x !== null);
    const fp = end ? f0.slice(-40) : f0.slice(0, 40);
    return { db: 20 * Math.log10(part.reduce((a, b) => a + b, 0) / Math.max(1, part.length)), hz: fp.sort((a, b) => a - b)[Math.floor(fp.length / 2)] ?? 0 };
  };
  const rows = [];
  let heardAll = '';
  for (const sc of scenes) {
    const f = path.join(dir, `scene-${String(sc.index + 1).padStart(2, '0')}.wav`);
    const heard = (await asr.transcribe(f)).trim();
    heardAll += ` ${heard}`;
    const m = deliveryMetrics(readMono(f), sc.narration);
    rows.push({ scene: sc.index + 1, wer: Number(wordErrorRate(sc.narration, heard).toFixed(3)), dur: Number(m.durationSec.toFixed(2)), wps: Number(m.wordsPerSec.toFixed(2)), strayLongPauses: m.strayLongPauses, longestPause: m.longestPauseSec, sentencePause: Number(m.sentencePauseSec.toFixed(2)), clicks: m.clickCount, pitchRangeSt: Number(m.pitchRangeSt.toFixed(1)), heard });
  }
  const joins = scenes.slice(1).map((sc) => {
    const a = edge(path.join(dir, `scene-${String(sc.index).padStart(2, '0')}.wav`), true);
    const b = edge(path.join(dir, `scene-${String(sc.index + 1).padStart(2, '0')}.wav`), false);
    return { join: `${sc.index}->${sc.index + 1}`, levelJumpDb: Number((b.db - a.db).toFixed(1)), endHz: Math.round(a.hz), startHz: Math.round(b.hz) };
  });
  const script = scenes.map((s) => s.narration).join(' ');
  const terms = BENCHMARK_TERMS.filter((t) => new RegExp(t.term.split(' ')[0].replace(/s$/, ''), 'i').test(script)).map((t) => ({ term: t.term, heard: t.heardAs.test(heardAll) }));
  for (const r of rows) console.log(`SCENE ${JSON.stringify(r)}`);
  console.log(`JOINS ${JSON.stringify(joins)}`);
  console.log(`TERMS ${JSON.stringify(terms)}`);
  fs.writeFileSync(path.join(DATA, 'tmp', `narration-check-${id}.json`), JSON.stringify({ rows, joins, terms }, null, 2));
});
