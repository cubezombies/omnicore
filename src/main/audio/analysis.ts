import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AUDIO_GATE_CHECKS, AUDIO_GATE_ID, MUSIC_FADE_IN_SEC, MUSIC_FADE_OUT_SEC, mixProfile, type MixProfileId } from '../../shared/audioMix';
import type { QaFinding } from '../../shared/operations';
import { duckEnvelope, ffmpegText, measureLoudness, type Loudness } from './mix';

/** What the render step mixed, written next to the video as audio-mix.json. QA checks the decoded audio against it. */
export interface AudioMixRecord {
  version: number;
  profile: MixProfileId;
  totalSec: number;
  scenes: { offsetSec: number; durationSec: number }[];
  /** Speech phrases on the timeline (what the music ducks under). */
  speech: [number, number][];
  music: { trackId: number; title: string; origin: string; rightsStatus: string; embeddable: boolean; gainDb: number; measuredLufs: number };
  narrationGainDb: number[];
  /** One gain on every bus (final loudness normalisation) and the mix loudness it corrected. */
  masterGainDb?: number;
  premasterLufs?: number;
  /** Contextual effects approved for this production (usually none). */
  cues: { role: 'contextual'; atSec: number; trackId?: number }[];
  stems: { narration: string; music: string; musicDry: string; sfx: string };
  envelope: string;
}

export const MIX_RECORD = 'audio-mix.json';
const RATE = 48000;
const BLOCK = 0.1;
const SILENT = -120;

/** Decode a file's audio to mono 48 kHz float samples. */
export function decodeMono(ffmpeg: string, file: string, signal?: AbortSignal): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const c = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { windowsHide: true });
    const chunks: Buffer[] = [];
    let err = '';
    c.stdout.on('data', (d: Buffer) => chunks.push(d));
    c.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    signal?.addEventListener('abort', () => c.kill(), { once: true });
    c.on('error', reject);
    c.on('close', (code) => {
      const buf = Buffer.concat(chunks);
      if (code !== 0 || buf.length < 4) return reject(new Error(`Could not decode ${path.basename(file)}${err ? `: ${err.trim().slice(0, 300)}` : ''}`));
      const n = Math.floor(buf.length / 4);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
      resolve(out);
    });
  });
}

/** Phone-speaker band: 4th-order high-pass at 200 Hz (two Butterworth biquads). What a phone can actually play. */
export function phoneBand(x: Float32Array): Float32Array {
  const w = (2 * Math.PI * 200) / RATE;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b0 = (1 + cos) / 2 / a0;
  const b1 = -(1 + cos) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  let y = x;
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(y.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const v = b0 * y[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = y[i];
      y2 = y1;
      y1 = v;
      out[i] = v;
    }
    y = out;
  }
  return y;
}

/** RMS level (dBFS) of each 100 ms block. */
export function blockDb(x: Float32Array, blocks: number): number[] {
  const len = Math.round(BLOCK * RATE);
  const out: number[] = [];
  for (let b = 0; b < blocks; b++) {
    let s = 0;
    let k = 0;
    for (let i = b * len; i < Math.min(x.length, (b + 1) * len); i++, k++) s += x[i] * x[i];
    out.push(k && s > 0 ? 10 * Math.log10(s / k) : SILENT);
  }
  return out;
}

/** Energy-domain moving average over k blocks (centred). */
export function smooth(db: number[], k: number): number[] {
  const e = db.map((x) => Math.pow(10, x / 10));
  return db.map((_, i) => {
    const a = Math.max(0, i - Math.floor(k / 2));
    const b = Math.min(db.length, a + k);
    let s = 0;
    for (let j = a; j < b; j++) s += e[j];
    return 10 * Math.log10(s / (b - a) || 1e-12);
  });
}

const median = (xs: number[]): number => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);
const pct = (xs: number[], q: number): number => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] : NaN);
const energyDb = (x: Float32Array, from = 0, to = x.length): number => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return s > 0 ? 10 * Math.log10(s / Math.max(1, to - from)) : SILENT;
};

/** Sample offset that best aligns b to a (cross-correlation over a window, ±maxLag samples). */
export function bestLag(a: Float32Array, b: Float32Array, maxLag = 256): number {
  const start = Math.min(a.length, b.length) > RATE * 8 ? RATE * 2 : 0;
  const len = Math.min(RATE * 4, Math.min(a.length, b.length) - start - maxLag * 2);
  if (len <= 0) return 0;
  let best = 0;
  let bestV = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = start + maxLag; i < start + maxLag + len; i++) s += a[i] * (b[i + lag] ?? 0);
    if (s > bestV) {
      bestV = s;
      best = lag;
    }
  }
  return best;
}

export interface AudioAnalysis {
  durationSec: number;
  speechBlocks: number;
  separationDb: number;
  duckUnderSpeechDb: number;
  duckOpenDb: number | null;
  openBlocks: number;
  musicDryPhoneDb: number;
  musicCoverage: number;
  narrationSceneSpreadDb: number;
  maxMusicStepDb: number;
  maxDryStepDb: number;
  sfxFound: number;
  sfxExpected: number;
  sfxMaxDb: number;
  sfxOverSpeechDb: number;
  narrationSpeechDb: number;
  longestSilenceSec: number;
  residualWithMusicDb: number;
  residualWithoutMusicDb: number;
  final: Loudness & { lra: number };
}

type Gate = QaFinding & { repairAction?: undefined };
const gate = (checkId: string, passed: boolean, message: string, evidence: Record<string, unknown> = {}): Gate => ({ checkId, category: 'audio', severity: 'critical', passed, message, evidence, repair: passed ? '' : 'Fix the soundtrack/mix and re-render; this check cannot be waived.' });

/**
 * The mandatory audio gate, measured on the decoded final render and its stems. Any failure (including a failed
 * analysis) fails QA as critical, so the production cannot complete, reach review, be approved or be published.
 */
export async function audioGateFindings(o: { ffmpeg: string; dir: string; finalFile: string; audioCodec?: string; sampleRate?: number; durationSec: number; hasMusicAsset: boolean; signal?: AbortSignal }): Promise<{ findings: Gate[]; analysis: AudioAnalysis | null }> {
  const findings: Gate[] = [];
  const done = (analysis: AudioAnalysis | null) => {
    const failed = findings.filter((f) => !f.passed).map((f) => f.checkId);
    for (const id of AUDIO_GATE_CHECKS) if (!findings.some((f) => f.checkId === id)) findings.push(gate(id, false, 'Not checked: the audio could not be analysed.'));
    const allFailed = findings.filter((f) => !f.passed).map((f) => f.checkId);
    findings.push(gate(AUDIO_GATE_ID, allFailed.length === 0, allFailed.length ? `Audio gate FAILED (${allFailed.length}): ${[...new Set([...failed, ...allFailed])].join(', ')}. The video cannot complete, be approved or be published until these pass.` : 'Audio gate passed: approved music audible under clear, dominant narration; ducking, effects, levels and the final mix verified on the decoded render.', { failed: allFailed }));
    return { findings, analysis };
  };
  const recFile = path.join(o.dir, MIX_RECORD);
  if (!fs.existsSync(recFile)) {
    findings.push(gate('audio.analysis', false, 'No mix record: this video was rendered before the mandatory audio gate (or without a soundtrack). Re-render it.'));
    return done(null);
  }
  let rec: AudioMixRecord;
  let final: Float32Array, narr: Float32Array, mus: Float32Array, dry: Float32Array, sfx: Float32Array;
  let loud: Loudness & { lra: number };
  try {
    rec = JSON.parse(fs.readFileSync(recFile, 'utf8')) as AudioMixRecord;
    for (const f of Object.values(rec.stems)) if (!fs.existsSync(path.join(o.dir, f))) throw new Error(`stem ${f} is missing`);
    [final, narr, mus, dry, sfx] = await Promise.all([o.finalFile, ...[rec.stems.narration, rec.stems.music, rec.stems.musicDry, rec.stems.sfx].map((f) => path.join(o.dir, f))].map((f) => decodeMono(o.ffmpeg, f, o.signal)));
    const m = await measureLoudness(o.ffmpeg, o.finalFile, o.signal);
    const raw = await ffmpegText(o.ffmpeg, ['-i', o.finalFile, '-vn', '-af', 'ebur128', '-f', 'null', '-'], o.signal);
    const lra = Number(/LRA:\s+(-?[\d.]+) LU/.exec(raw.slice(raw.lastIndexOf('Summary:')))?.[1] ?? NaN);
    loud = { ...m, lra };
  } catch (e) {
    findings.push(gate('audio.analysis', false, `Audio analysis failed: ${e instanceof Error ? e.message : String(e)}`));
    return done(null);
  }
  const profile = mixProfile(rec.profile);
  const blocks = Math.floor(Math.min(rec.totalSec, final.length / RATE) / BLOCK);
  findings.push(gate('audio.analysis', blocks > 10, `Decoded the final render and 4 stems (${(final.length / RATE).toFixed(1)} s, ${blocks} blocks of 100 ms, phone band ≥ 200 Hz).`, { blocks }));

  // Encoding: the final file carries the mixed audio in the delivery format.
  const lenOk = Math.abs(final.length / RATE - rec.totalSec) <= 0.25;
  const encOk = (o.audioCodec ?? 'aac') === 'aac' && (o.sampleRate ?? RATE) === RATE && lenOk;
  findings.push(gate('audio.encoding', encOk, `Final audio ${o.audioCodec ?? '?'} ${o.sampleRate ?? '?'} Hz, ${(final.length / RATE).toFixed(2)} s (planned ${rec.totalSec.toFixed(2)} s).`, { codec: o.audioCodec, sampleRate: o.sampleRate, decodedSec: +(final.length / RATE).toFixed(2), plannedSec: rec.totalSec }));

  // Mix integrity: subtracting the music stem from the final must shrink the residual (the music is really in the file).
  const sum = new Float32Array(final.length);
  const noMus = new Float32Array(final.length);
  const lag = bestLag(final, (() => { const s = new Float32Array(Math.min(narr.length, final.length)); for (let i = 0; i < s.length; i++) s[i] = narr[i] + (mus[i] ?? 0) + (sfx[i] ?? 0); return s; })());
  for (let i = 0; i < final.length; i++) {
    const j = i + lag;
    const n = narr[j] ?? 0, m = mus[j] ?? 0, s = sfx[j] ?? 0;
    sum[i] = final[i] - n - m - s;
    noMus[i] = final[i] - n - s;
  }
  const usable = Math.max(1, Math.floor((rec.totalSec - MUSIC_FADE_OUT_SEC) * RATE));
  const rWith = energyDb(sum, Math.round(MUSIC_FADE_IN_SEC * RATE), usable);
  const rWithout = energyDb(noMus, Math.round(MUSIC_FADE_IN_SEC * RATE), usable);
  const integrity = rWith <= rWithout - 6;
  findings.push(gate('audio.mix-integrity', integrity, integrity ? `The final render contains the mixed music: removing the music stem lowers the residual from ${rWithout.toFixed(1)} to ${rWith.toFixed(1)} dB.` : `The music is NOT in the final render as planned: residual ${rWith.toFixed(1)} dB with the music stem removed vs ${rWithout.toFixed(1)} dB without (needs at least 6 dB difference).`, { residualWithMusicDb: +rWith.toFixed(1), residualWithoutMusicDb: +rWithout.toFixed(1), lagSamples: lag }));

  const pb = (x: Float32Array) => blockDb(phoneBand(x), blocks);
  const [F, N, M0, D0, S] = [final, narr, mus, dry, sfx].map(pb);
  // Music is judged on 400 ms windows (EBU momentary): a plucked note decaying inside one 100 ms block is not a level jump.
  const M = smooth(M0, 4);
  const D = smooth(D0, 4);
  const t = (b: number) => (b + 0.5) * BLOCK;
  const narrRef = pct(N.filter((x) => x > SILENT), 0.95);
  const speech = N.map((x) => x >= narrRef - 25 && x > -50);
  const inMusicBody = (b: number) => t(b) >= MUSIC_FADE_IN_SEC + 0.2 && t(b) <= rec.totalSec - MUSIC_FADE_OUT_SEC - 0.2;
  const speechIdx = [...speech.keys()].filter((b) => speech[b]);

  // Narration present, dominant and at the delivery loudness.
  const narrSpeechDb = median(speechIdx.map((b) => N[b]));
  const narrOk = speechIdx.length >= blocks * 0.35 && narrSpeechDb >= -35 && loud.lufs >= -17.5 && loud.lufs <= -14.5;
  findings.push(gate('audio.narration-present', narrOk, `Narration speaks in ${Math.round((speechIdx.length / blocks) * 100)}% of the video at ${narrSpeechDb.toFixed(1)} dB (phone band); final loudness ${loud.lufs.toFixed(1)} LUFS (target −16 ±1.5).`, { speechShare: +(speechIdx.length / blocks).toFixed(2), narrationSpeechDb: +narrSpeechDb.toFixed(1), finalLufs: loud.lufs }));

  // Narration consistency across scenes.
  const sceneLevels = rec.scenes.map((sc) => median(speechIdx.filter((b) => t(b) >= sc.offsetSec && t(b) < sc.offsetSec + sc.durationSec).map((b) => N[b]))).filter((x, i) => Number.isFinite(x) && speechIdx.filter((b) => t(b) >= rec.scenes[i].offsetSec && t(b) < rec.scenes[i].offsetSec + rec.scenes[i].durationSec).length >= 5);
  const spread = sceneLevels.length ? Math.max(...sceneLevels) - Math.min(...sceneLevels) : NaN;
  findings.push(gate('audio.narration-consistency', Number.isFinite(spread) && spread <= 4, `Narration level varies ${Number.isFinite(spread) ? spread.toFixed(1) : '?'} dB across ${sceneLevels.length} scenes (limit 4 dB).`, { sceneLevelsDb: sceneLevels.map((x) => +x.toFixed(1)), spreadDb: +spread.toFixed(1) }));

  // Music: an approved track, audible on a phone speaker, through the whole video.
  const body = [...M.keys()].filter(inMusicBody);
  const coverage = body.length ? body.filter((b) => M[b] >= -55).length / body.length : 0;
  const dryDb = median(body.map((b) => D[b]));
  const approved = rec.music.rightsStatus === 'approved' && rec.music.embeddable && o.hasMusicAsset;
  const musicOk = approved && coverage >= 0.97 && dryDb >= -38;
  findings.push(
    gate('audio.music-present', musicOk, `${approved ? `Approved soundtrack "${rec.music.title}" (${rec.music.origin})` : `Soundtrack "${rec.music.title}" is NOT approved (${rec.music.rightsStatus})`}: audible in ${(coverage * 100).toFixed(0)}% of the video (need 97%), ${dryDb.toFixed(1)} dB on a phone speaker between lines (need ≥ −38 dB).`, { trackId: rec.music.trackId, rightsStatus: rec.music.rightsStatus, coverage: +coverage.toFixed(3), musicOpenPhoneDb: +dryDb.toFixed(1) })
  );

  // Music under speech: present but subordinate.
  const sep = median(speechIdx.filter(inMusicBody).map((b) => N[b] - M[b]));
  const [lo, hi] = profile.separationDb;
  findings.push(gate('audio.music-under-speech', Number.isFinite(sep) && sep >= lo && sep <= hi, `Voice sits ${Number.isFinite(sep) ? sep.toFixed(1) : '?'} dB above the music while speaking (${profile.label}: ${lo}–${hi} dB; lower competes with the voice, higher makes the music inaudible).`, { separationDb: +sep.toFixed(1), range: profile.separationDb }));

  // Ducking: the measured dip (dry music minus mixed music, block by block) must follow the envelope expected from
  // the speech timings and the profile, rebuilt here independently of the envelope file the renderer used. This
  // verifies depth under speech, the attack before each phrase and the release after it, everywhere in the video.
  const env = duckEnvelope(rec.speech, rec.totalSec, profile, 1000);
  const expected = Array.from({ length: blocks }, (_, b) => {
    let s = 0;
    let k = 0;
    for (let i = b * 100; i < Math.min(env.length, (b + 1) * 100); i++, k++) s += env[i] * env[i];
    return k ? -10 * Math.log10(s / k) : 0;
  });
  // Dry and mixed music differ only by the envelope (fades are in both), so the comparison covers the whole video,
  // including the music-only intro and outro where the release is measured.
  const audibleBody = [...D0.keys()].filter((b) => b < blocks - 1 && D0[b] > -60);
  const errors = audibleBody.map((b) => Math.abs(D0[b] - M0[b] - expected[b]));
  const meanErr = errors.length ? errors.reduce((a, x) => a + x, 0) / errors.length : NaN;
  const p95Err = pct(errors, 0.95);
  const duckSpeech = median(speechIdx.filter(inMusicBody).map((b) => D0[b] - M0[b]));
  const released = audibleBody.filter((b) => expected[b] < 1);
  const duckOpen = released.length ? median(released.map((b) => D0[b] - M0[b])) : null;
  const recovery = Math.max(0, ...audibleBody.map((b) => profile.duckDb - expected[b]));
  const duckOk = Number.isFinite(duckSpeech) && Math.abs(duckSpeech - profile.duckDb) <= 2 && Number.isFinite(meanErr) && meanErr <= 1 && p95Err <= 2.5 && (duckOpen === null || duckOpen <= 1.5);
  findings.push(
    gate(
      'audio.ducking',
      duckOk,
      `Music dips ${Number.isFinite(duckSpeech) ? duckSpeech.toFixed(1) : '?'} dB under speech (target ${profile.duckDb} ±2) and follows the planned attack/release within ${Number.isFinite(meanErr) ? meanErr.toFixed(2) : '?'} dB on average (95th percentile ${Number.isFinite(p95Err) ? p95Err.toFixed(1) : '?'} dB; limits 1 and 2.5)${duckOpen === null ? '' : `; fully released in ${released.length} blocks at ${duckOpen.toFixed(1)} dB (limit 1.5)`}; largest recovery between phrases ${recovery.toFixed(1)} dB.`,
      { duckUnderSpeechDb: +duckSpeech.toFixed(1), envelopeMeanErrorDb: +meanErr.toFixed(2), envelopeP95ErrorDb: +p95Err.toFixed(2), releasedBlocks: released.length, releasedDb: duckOpen === null ? null : +duckOpen.toFixed(1), largestRecoveryDb: +recovery.toFixed(1), targetDb: profile.duckDb }
    )
  );

  // Smoothness: no abrupt level jumps in the music (ducking ramps, loop seams), and a steady overall mix.
  const steps = (x: number[]) => Math.max(0, ...body.slice(1).map((b) => (inMusicBody(b - 1) ? Math.abs(x[b] - x[b - 1]) : 0)));
  const mStep = steps(M);
  const dStep = steps(D);
  const smoothOk = mStep <= 7.5 && dStep <= 3.5 && Number.isFinite(loud.lra) && loud.lra <= 9;
  findings.push(gate('audio.smoothness', smoothOk, `Largest 100 ms music change ${mStep.toFixed(1)} dB (limit 7.5, ducking included), music bed itself ${dStep.toFixed(1)} dB (limit 3.5, no loop seams or dropouts); final loudness range ${Number.isFinite(loud.lra) ? loud.lra.toFixed(1) : '?'} LU (limit 9).`, { maxMusicStepDb: +mStep.toFixed(1), maxDryStepDb: +dStep.toFixed(1), lra: loud.lra }));

  // Effects: present at every cue, never louder than the voice.
  const found = rec.cues.filter((c) => {
    const b0 = Math.floor(c.atSec / BLOCK);
    return S.slice(b0, b0 + 9).some((x) => x >= -50);
  }).length;
  const sfxMax = Math.max(SILENT, ...S);
  const overSpeech = speechIdx.filter((b) => S[b] > -60);
  const sfxVsVoice = overSpeech.length ? median(overSpeech.map((b) => N[b] - S[b])) : Infinity;
  // Effects are optional; whatever was planned must be present, on time and never louder than the voice.
  const sfxOk = rec.cues.length === 0 ? sfxMax < -60 : found === rec.cues.length && sfxMax <= narrSpeechDb && sfxVsVoice >= 6;
  findings.push(gate('audio.sfx', sfxOk, rec.cues.length === 0 ? (sfxOk ? 'No sound effects planned, and none in the mix.' : `No sound effects were planned, but the effects stem carries sound (${sfxMax.toFixed(1)} dB).`) : `${found} of ${rec.cues.length} sound effects present (approved contextual effects); loudest effect ${sfxMax.toFixed(1)} dB vs voice ${narrSpeechDb.toFixed(1)} dB${Number.isFinite(sfxVsVoice) ? `; effects under speech sit ${sfxVsVoice.toFixed(1)} dB below the voice (need ≥ 6)` : ''}.`, { found, expected: rec.cues.length, sfxMaxDb: +sfxMax.toFixed(1), sfxUnderSpeechDb: Number.isFinite(sfxVsVoice) ? +sfxVsVoice.toFixed(1) : null }));

  // Peaks: no clipping, true peak under -1 dBTP.
  findings.push(gate('audio.peaks', loud.truePeakDb <= -1 && loud.peakDb <= -0.5, `True peak ${loud.truePeakDb.toFixed(1)} dBTP (limit −1.0), sample peak ${loud.peakDb.toFixed(1)} dBFS (limit −0.5): ${loud.truePeakDb <= -1 ? 'no clipping' : 'too hot'}.`, { truePeakDb: loud.truePeakDb, samplePeakDb: loud.peakDb }));

  // Unintended silence anywhere before the final fade.
  let run = 0;
  let longest = 0;
  for (let b = 0; b < blocks - 4; b++) {
    run = F[b] < -50 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  findings.push(gate('audio.silence', longest * BLOCK <= 0.5, `Longest near-silence ${(longest * BLOCK).toFixed(1)} s (limit 0.5 s).`, { longestSilenceSec: +(longest * BLOCK).toFixed(1) }));

  return done({
    durationSec: final.length / RATE,
    speechBlocks: speechIdx.length,
    separationDb: sep,
    duckUnderSpeechDb: duckSpeech,
    duckOpenDb: duckOpen,
    openBlocks: released.length,
    musicDryPhoneDb: dryDb,
    musicCoverage: coverage,
    narrationSceneSpreadDb: spread,
    maxMusicStepDb: mStep,
    maxDryStepDb: dStep,
    sfxFound: found,
    sfxExpected: rec.cues.length,
    sfxMaxDb: sfxMax,
    sfxOverSpeechDb: sfxVsVoice,
    narrationSpeechDb: narrSpeechDb,
    longestSilenceSec: longest * BLOCK,
    residualWithMusicDb: rWith,
    residualWithoutMusicDb: rWithout,
    final: loud
  });
}
