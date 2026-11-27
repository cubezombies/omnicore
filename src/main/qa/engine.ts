import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { QaCategory, QaFinding, Severity } from '../../shared/operations';
import { PRODUCTION_FORMATS, type Production } from '../../shared/production';
import { verifyVisualAssets } from '../media/assetPolicy';
import { buildCues, type WordTiming } from '../media/captions';
import { probe } from '../media/ffmpeg';
import { PLATFORM_LIMITS } from '../publishing/metadata';
import { groundingProblems, validateStoryboard } from '../providers/text';
import { isRelevantFile } from '../providers/visuals';
import { claimProblems } from '../providers/writers';
import { wordErrorRate, type Transcriber } from './asr';

/** Which pipeline steps a repair re-runs. */
export type RepairAction = 'rescript' | 'shorten' | 'revisuals' | 'recaptions' | 'rerender' | 'metadata';

export interface QaContext {
  production: Production;
  dir: string;
  ffmpeg: string;
  allowShareAlike: boolean;
  asr?: Transcriber;
  signal?: AbortSignal;
}

export interface QaCheckResult extends QaFinding {
  /** Automatic repair that can fix this failure, if any. */
  repairAction?: RepairAction;
}

const BAIT = /\b(shocking|you won'?t believe|destroys|insane|mind-?blowing|this changes everything|secret they|exposed)\b/i;

function finding(checkId: string, category: QaCategory, severity: Severity, passed: boolean, message: string, evidence: Record<string, unknown> = {}, repairAction?: RepairAction): QaCheckResult {
  return { checkId, category, severity, passed, message, evidence, repair: passed ? '' : repairAction ?? '', repairAction: passed ? undefined : repairAction };
}

function runFfmpegCapture(ffmpeg: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = spawn(ffmpeg, ['-hide_banner', '-nostdin', ...args], { windowsHide: true });
    let err = '';
    c.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-200_000)));
    c.stdout.resume();
    signal?.addEventListener('abort', () => c.kill(), { once: true });
    c.on('error', reject);
    c.on('close', () => resolve(err));
  });
}

/** True when the MP4's moov atom precedes mdat (streamable / "faststart"). */
export function isFastStart(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(1 << 16);
    fs.readSync(fd, head, 0, head.length, 0);
    const moov = head.indexOf('moov');
    const mdat = head.indexOf('mdat');
    return moov >= 0 && (mdat < 0 || moov < mdat);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Independent quality assurance. Every check re-derives its verdict from stored
 * evidence and the rendered file — it does not trust flags set by the generation steps.
 */
export async function runQaChecks(ctx: QaContext): Promise<QaCheckResult[]> {
  const p = ctx.production;
  const out: QaCheckResult[] = [];
  const sb = p.storyboard;
  const claims = p.brief?.claims ?? [];

  // ---- facts ------------------------------------------------------------------
  if (!sb) {
    out.push(finding('facts.storyboard', 'facts', 'critical', false, 'No storyboard exists.', {}, 'rescript'));
  } else {
    try {
      validateStoryboard(sb, p.sources);
      out.push(finding('facts.storyboard', 'facts', 'critical', true, 'Storyboard structure and citations are valid.'));
    } catch (e) {
      out.push(finding('facts.storyboard', 'facts', 'critical', false, (e as Error).message, {}, 'rescript'));
    }
    const cp = claims.length ? claimProblems(sb, claims) : [];
    out.push(finding('facts.claims', 'facts', 'critical', cp.length === 0, cp.length ? cp.join(' ') : `Every fact scene states a known claim with the required attribution (${claims.length} claims).`, { problems: cp }, 'rescript'));
    const gp = groundingProblems(sb, p.sources, { allowed: `${p.topic} AI, Actually` });
    out.push(finding('facts.grounding', 'facts', 'critical', gp.length === 0, gp.length ? gp.join(' ') : 'All numbers, names and key words are supported by the cited sources.', { problems: gp }, 'rescript'));
  }

  // ---- research ---------------------------------------------------------------
  const groups = new Set(p.sources.map((s) => s.group ?? s.id));
  out.push(finding('research.sources', 'research', 'major', p.sources.length >= 2, `${p.sources.length} sources from ${groups.size} independent group(s).`, { sources: p.sources.length, groups: groups.size }));
  if (p.mode === 'news') {
    const newsKinds = p.sources.filter((s) => ['reporting', 'company', 'official'].includes(s.kind ?? '')).length;
    out.push(finding('research.news-basis', 'research', 'major', newsKinds > 0, newsKinds ? `${newsKinds} news source(s) (reporting, announcement or official).` : 'News production has no news source.', { newsKinds }));
  }
  const factScenes = sb?.scenes.filter((s) => s.role === 'fact') ?? [];
  const citedGroups = new Set(factScenes.flatMap((s) => s.sourceIds).map((id) => p.sources.find((x) => x.id === id)?.group ?? id));
  out.push(finding('research.independence', 'research', 'minor', citedGroups.size >= 2 || factScenes.length <= 1, `Fact scenes draw on ${citedGroups.size} independent source group(s).`, { citedGroups: citedGroups.size }));

  // ---- editorial --------------------------------------------------------------
  if (sb) {
    const titleProblems = groundingProblems({ title: sb.title, writer: sb.writer, scenes: [{ index: 0, role: 'hook', narration: sb.title, onScreenText: '', visualQuery: '', sourceIds: [] }] }, p.sources, { allowed: `${p.topic} AI, Actually` });
    out.push(finding('editorial.title', 'editorial', 'major', titleProblems.length === 0, titleProblems.length ? `Title states something the sources do not support: ${titleProblems.join(' ')}` : 'Title is supported by the sources.', { title: sb.title }, 'rescript'));
    const bait = [sb.title, sb.scenes[0]?.narration ?? ''].find((t) => BAIT.test(t));
    out.push(finding('editorial.clickbait', 'editorial', 'major', !bait, bait ? `Sensational phrasing in title/hook: "${bait}"` : 'No sensational or misleading phrasing in title or hook.', {}, 'rescript'));
  }

  // ---- rights -----------------------------------------------------------------
  const images = p.assets.filter((a) => a.kind === 'image');
  const lic = verifyVisualAssets(images, { allowShareAlike: ctx.allowShareAlike });
  out.push(finding('rights.visuals', 'rights', 'critical', lic.length === 0, lic.length ? lic.join(' ') : `All ${images.length} visuals have a verified licence or are generated.`, { problems: lic }, 'revisuals'));
  const external = images.filter((a) => a.provider === 'wikimedia-commons');
  const missingEvidence = external.filter((a) => !a.meta.evidenceHash);
  out.push(finding('rights.evidence', 'rights', 'major', missingEvidence.length === 0, missingEvidence.length ? `${missingEvidence.length} licensed image(s) have no retained licence evidence.` : `Licence evidence retained for ${external.length} external image(s).`, { missing: missingEvidence.map((a) => a.sceneIndex) }, 'revisuals'));
  const sounds = p.assets.filter((a) => a.kind === 'music' || a.kind === 'sfx');
  const badSounds = sounds.filter((a) => !a.license || a.meta.commercialUse === 'no' || a.meta.usage === 'platform_native');
  out.push(finding('rights.audio', 'audio', 'critical', badSounds.length === 0, badSounds.length ? `Music/effects without commercial embedded-use permission: ${badSounds.map((a) => a.attribution).join('; ')}` : sounds.length ? `${sounds.length} music/effect track(s) licensed for embedded commercial use.` : 'No music or effects used.', { sounds: sounds.map((s) => s.license) }, 'rerender'));

  // ---- visuals ----------------------------------------------------------------
  const irrelevant = external.filter((a) => !isRelevantFile(String(a.meta.key ?? ''), p.topic, '') && !String(a.meta.via ?? '').startsWith('article:'));
  out.push(finding('visuals.relevance', 'visuals', 'minor', irrelevant.length === 0, irrelevant.length ? `${irrelevant.length} image(s) may not relate to the topic.` : 'Images come from cited articles or match the topic.', { scenes: irrelevant.map((a) => a.sceneIndex) }));
  const unlabelledAi = images.filter((a) => a.provider === 'comfyui' && !a.meta.aiGenerated);
  out.push(finding('visuals.ai-label', 'visuals', 'critical', unlabelledAi.length === 0, unlabelledAi.length ? 'AI illustration not marked for on-screen labelling.' : 'No unlabelled AI imagery.', {}, 'revisuals'));

  // ---- narration ----------------------------------------------------------------
  const narration = p.assets.filter((a) => a.kind === 'narration').sort((a, b) => (a.sceneIndex ?? 0) - (b.sceneIndex ?? 0));
  const speech = narration.reduce((n, a) => n + Number(a.meta.durationSec ?? 0), 0);
  const words = sb ? sb.scenes.reduce((n, s) => n + s.narration.split(/\s+/).length, 0) : 0;
  const wps = speech ? words / speech : 0;
  out.push(finding('narration.pacing', 'narration', 'major', wps >= 1.7 && wps <= 3.3, `Speaking pace ${wps.toFixed(2)} words/s (natural range 1.7–3.3).`, { wordsPerSec: +wps.toFixed(2) }));
  if (ctx.asr?.available() && sb) {
    const per: { scene: number; wer: number; heard: string }[] = [];
    for (const a of narration) {
      const scene = sb.scenes.find((s) => s.index === a.sceneIndex);
      if (!scene) continue;
      const heard = await ctx.asr.transcribe(path.join(ctx.dir, a.path), ctx.signal);
      per.push({ scene: scene.index + 1, wer: +wordErrorRate(scene.narration, heard).toFixed(3), heard });
    }
    const overall = per.length ? per.reduce((n, x) => n + x.wer, 0) / per.length : 0;
    const worst = per.reduce((m, x) => (x.wer > m.wer ? x : m), { scene: 0, wer: 0, heard: '' });
    out.push(
      finding(
        'narration.intelligibility',
        'narration',
        'major',
        overall <= 0.15 && worst.wer <= 0.35,
        `Independent speech recognition: average word error ${(overall * 100).toFixed(1)}%, worst scene ${worst.scene} at ${(worst.wer * 100).toFixed(1)}%.`,
        { perScene: per }
      )
    );
  } else {
    out.push(finding('narration.intelligibility', 'narration', 'info', true, 'Skipped: speech-recognition model not installed (install Kokoro to add it).'));
  }

  // ---- captions -----------------------------------------------------------------
  if (sb && narration.length) {
    let offset = 0;
    const timeline = narration.map((a) => {
      const d = Math.max(1, Math.round((Number(a.meta.durationSec) + 0.35) * 30)) / 30;
      const t = { offset, duration: d, words: (a.meta.words as WordTiming[]) ?? [] };
      offset += d;
      return t;
    });
    const cues = buildCues(timeline);
    const captionWords = cues.flatMap((c) => c.text.split(/\s+/)).join(' ').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '');
    const scriptWords = sb.scenes.map((s) => s.narration).join(' ').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '');
    const coverage = 1 - wordErrorRate(scriptWords, captionWords);
    out.push(finding('captions.coverage', 'captions', 'critical', coverage >= 0.98, `Captions contain ${(coverage * 100).toFixed(1)}% of the narration words.`, { coverage: +coverage.toFixed(3) }, 'recaptions'));
    const overlaps = cues.filter((c, i) => i > 0 && c.start < cues[i - 1].end - 0.001).length;
    const outside = cues.filter((c) => c.end > offset + 0.05 || c.start < 0).length;
    out.push(finding('captions.sync', 'captions', 'major', overlaps === 0 && outside === 0, `${cues.length} cues; ${overlaps} overlapping, ${outside} outside the video.`, { cues: cues.length, overlaps, outside }, 'recaptions'));
  }

  // ---- video + audio ------------------------------------------------------------
  const video = p.assets.find((a) => a.kind === 'video');
  const file = video ? path.join(ctx.dir, video.path) : '';
  if (!video || !fs.existsSync(file)) {
    out.push(finding('video.exists', 'video', 'critical', false, 'Rendered video is missing.', {}, 'rerender'));
  } else {
    const info = await probe(ctx.ffmpeg, file);
    const specOk = info.video?.codec === 'h264' && info.video.width === 1080 && info.video.height === 1920 && info.audio?.codec === 'aac';
    out.push(finding('video.spec', 'video', 'critical', !!specOk, `${info.video?.codec ?? 'no video'} ${info.video?.width}×${info.video?.height}, audio ${info.audio?.codec ?? 'none'} ${info.audio?.sampleRate ?? ''} Hz.`, { ...info }, 'rerender'));
    const fmt = PRODUCTION_FORMATS[ctx.production.format ?? 'short'];
    out.push(finding('video.duration', 'video', 'major', info.durationSec >= fmt.minSec && info.durationSec <= fmt.maxSec, `Duration ${info.durationSec.toFixed(1)} s (target ${fmt.minSec}–${fmt.maxSec} s for ${fmt.label}).`, { durationSec: info.durationSec, format: ctx.production.format ?? 'short' }, info.durationSec > fmt.maxSec ? 'shorten' : undefined));
    const decodeErr = (await runFfmpegCapture(ctx.ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-'], ctx.signal)).trim();
    out.push(finding('video.integrity', 'video', 'critical', decodeErr === '', decodeErr ? `Decoding errors: ${decodeErr.slice(0, 300)}` : 'Full decode completed without errors.', {}, 'rerender'));
    out.push(finding('video.faststart', 'video', 'minor', isFastStart(file), isFastStart(file) ? 'Streamable (moov before mdat).' : 'Not streamable (moov after mdat).', {}, 'rerender'));
    const ebu = await runFfmpegCapture(ctx.ffmpeg, ['-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'], ctx.signal);
    const summary = ebu.slice(ebu.lastIndexOf('Summary:'));
    const lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]);
    const peak = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1]);
    out.push(finding('audio.loudness', 'audio', 'major', Number.isFinite(lufs) && lufs >= -19 && lufs <= -13, `Integrated loudness ${Number.isFinite(lufs) ? lufs.toFixed(1) : '?'} LUFS (target −16 ±3).`, { lufs }, 'rerender'));
    out.push(finding('audio.clipping', 'audio', 'major', Number.isFinite(peak) && peak <= -0.5, `True peak ${Number.isFinite(peak) ? peak.toFixed(1) : '?'} dBTP (must stay below −0.5).`, { truePeak: peak }, 'rerender'));
  }

  // ---- metadata + destinations -----------------------------------------------------
  if (!p.destinations.length) out.push(finding('metadata.destination', 'metadata', 'critical', false, 'No publishing destination is assigned to this production.'));
  else out.push(finding('metadata.destination', 'metadata', 'critical', true, `Destinations: ${p.destinations.map((d) => `${d.platform} ${d.handle ?? '(unassigned account)'}`).join(', ')}.`));
  for (const d of p.destinations) {
    const m = p.metadata[d.platform];
    const lim = PLATFORM_LIMITS[d.platform];
    if (!m) {
      out.push(finding(`metadata.${d.platform}`, 'metadata', 'major', false, `No ${d.platform} metadata generated.`, {}, 'metadata'));
      continue;
    }
    const issues: string[] = [];
    if (!m.title.trim() || m.title.length > lim.title) issues.push(`title length ${m.title.length} (max ${lim.title})`);
    if (m.caption.length > lim.caption) issues.push(`caption length ${m.caption.length} (max ${lim.caption})`);
    if (m.hashtags.length > lim.hashtags) issues.push(`${m.hashtags.length} hashtags (max ${lim.hashtags})`);
    if (!m.credits.includes('Sources:')) issues.push('credits missing sources');
    out.push(finding(`metadata.${d.platform}`, 'metadata', 'major', issues.length === 0, issues.length ? issues.join('; ') : `${d.platform} metadata within platform limits.`, {}, 'metadata'));
    out.push(finding(`metadata.${d.platform}.ai-disclosure`, 'metadata', 'critical', m.aiDisclosure && /AI-generated/.test(m.caption), m.aiDisclosure ? 'AI-generated content disclosed.' : 'AI disclosure missing.', {}, 'metadata'));
  }
  return out;
}

export function summarise(findings: QaFinding[]): { status: 'passed' | 'failed' | 'blocked'; critical: number; major: number; minor: number } {
  const failed = findings.filter((f) => !f.passed);
  const critical = failed.filter((f) => f.severity === 'critical').length;
  const major = failed.filter((f) => f.severity === 'major').length;
  const minor = failed.filter((f) => f.severity === 'minor').length;
  return { status: critical ? 'blocked' : major ? 'failed' : 'passed', critical, major, minor };
}
