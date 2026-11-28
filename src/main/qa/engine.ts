import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { QaCategory, QaFinding, Severity } from '../../shared/operations';
import { PRODUCTION_FORMATS, type Production, type PronunciationFinding } from '../../shared/production';
import { verifyVisualAssets } from '../media/assetPolicy';
import { buildCues, type WordTiming } from '../media/captions';
import { probe } from '../media/ffmpeg';
import { PLATFORM_LIMITS } from '../publishing/metadata';
import { groundingProblems, validateStoryboard } from '../providers/text';
import { isRelevantFile } from '../providers/visuals';
import { claimProblems } from '../providers/writers';
import { wordErrorRate, type Transcriber } from './asr';
import { allowedFor } from '../audio/sound';
import { audioGateFindings } from '../audio/analysis';
import { AUDIO_GATE_ID } from '../../shared/audioMix';
import { narrationTimeline } from '../media/timeline';

/** Which pipeline steps a repair re-runs. */
export type RepairAction = 'rescript' | 'shorten' | 'lengthen' | 'revisuals' | 'recaptions' | 'rerender' | 'metadata';

export interface QaContext {
  production: Production;
  dir: string;
  ffmpeg: string;
  allowShareAlike: boolean;
  asr?: Transcriber;
  signal?: AbortSignal;
  /** Pronunciation check of the script (terms nobody has confirmed are listed for review). */
  pronunciation?: PronunciationFinding[];
  /** Background music is required unless the business turned it off (default: required). */
  musicRequired?: boolean;
  /** Live rights check of a library sound (approved, present). Without it, non-generated sounds fail (fail closed). */
  soundRights?: (trackId: number) => { ok: boolean; reason: string };
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
/**
 * Generated graphics must credit a source the scene actually cites (never a made-up or wrong publisher), and long
 * scenes should not sit on one static card.
 */
export function graphicFindings(p: Production): QaCheckResult[] {
  const out: QaCheckResult[] = [];
  const scenes = p.storyboard?.scenes ?? [];
  const graphics = p.assets.filter((a) => a.kind === 'image' && a.provider === 'graphics');
  const wrong = graphics.filter((a) => {
    const credited = a.meta.creditedTo as string | undefined;
    if (!credited || credited === 'the cited source') return false;
    const sc = scenes.find((s) => s.index === a.sceneIndex);
    const cited = p.sources.filter((src) => sc?.sourceIds.includes(src.id)).map((src) => src.publisher);
    const claimAttr = (p.brief?.claims ?? []).filter((c) => sc?.claimIds?.includes(c.id)).map((c) => c.attribution);
    return ![...cited, ...claimAttr].includes(credited);
  });
  out.push(finding('visuals.attribution', 'visuals', 'major', wrong.length === 0, wrong.length ? `Graphics credit a source the scene doesn't cite: ${wrong.map((a) => `scene ${(a.sceneIndex ?? 0) + 1} (${a.meta.creditedTo})`).join('; ')}.` : 'Every graphic credits a source cited in its scene.', { scenes: wrong.map((a) => a.sceneIndex) }, 'revisuals'));
  const narr = new Map(p.assets.filter((a) => a.kind === 'narration').map((a) => [a.sceneIndex, Number(a.meta.durationSec ?? 0)]));
  const still = graphics.filter((a) => (narr.get(a.sceneIndex) ?? 0) > 9 && !(Array.isArray(a.meta.frames) && a.meta.frames.length > 1));
  out.push(finding('visuals.static', 'visuals', 'minor', still.length === 0, still.length ? `Long scenes on a single static graphic: ${still.map((a) => `scene ${(a.sceneIndex ?? 0) + 1} (${(narr.get(a.sceneIndex) ?? 0).toFixed(0)} s)`).join(', ')}.` : 'No long scene sits on one static graphic.', { scenes: still.map((a) => a.sceneIndex) }));
  return out;
}

/** Pixel spread (standard deviation of a tiny greyscale thumbnail); near zero means a blank or flat image. */
function imageSpread(ffmpeg: string, file: string, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-v', 'error', '-i', file, '-vf', 'scale=16:28,format=gray', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      const px = Buffer.concat(chunks);
      if (code !== 0 || !px.length) return reject(new Error('could not read image'));
      const mean = px.reduce((s, v) => s + v, 0) / px.length;
      resolve(Math.sqrt(px.reduce((s, v) => s + (v - mean) ** 2, 0) / px.length));
    });
  });
}

/**
 * Visual quality gates: every scene has a picture, title-card fallbacks stay rare, the same treatment isn't
 * repeated scene after scene, enough different kinds of visual are used, and no image is reused.
 */
export function visualVarietyFindings(images: Production['assets'], sceneCount: number, exists: (a: Production['assets'][number]) => boolean = () => true): QaCheckResult[] {
  const out: QaCheckResult[] = [];
  const byScene = new Map(images.map((a) => [a.sceneIndex, a]));
  const missing = Array.from({ length: sceneCount }, (_, i) => i).filter((i) => !byScene.has(i) || !exists(byScene.get(i)!));
  out.push(finding('visuals.coverage', 'visuals', 'critical', missing.length === 0, missing.length ? `Scenes without a picture: ${missing.map((i) => i + 1).join(', ')}.` : `All ${sceneCount} scenes have a picture.`, { missing }, 'revisuals'));
  const kindOf = (i: number) => {
    const a = byScene.get(i);
    return a ? String(a.meta.visualKind ?? (a.provider === 'title-card' ? 'title-card' : a.provider === 'graphics' ? 'graphic' : 'photo')) : 'none';
  };
  const kinds = Array.from({ length: sceneCount }, (_, i) => kindOf(i));
  const cards = images.filter((a) => a.provider === 'title-card').length;
  const maxCards = Math.max(1, Math.floor(sceneCount * 0.15));
  out.push(finding('visuals.title-cards', 'visuals', 'major', cards <= maxCards, `${cards} of ${sceneCount} scenes use a plain title card (at most ${maxCards}).`, { cards, maxCards }, 'revisuals'));
  let run = 1;
  let longest = sceneCount ? 1 : 0;
  for (let i = 1; i < kinds.length; i++) {
    run = kinds[i] === kinds[i - 1] ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  const distinct = new Set(kinds.filter((k) => k !== 'none')).size;
  const needDistinct = sceneCount >= 6 ? 3 : sceneCount >= 3 ? 2 : 1;
  out.push(
    finding('visuals.variety', 'visuals', 'major', longest <= 2 && distinct >= needDistinct, `${distinct} kinds of visual (${[...new Set(kinds)].join(', ')}); longest run of the same kind: ${longest} scenes (limit 2, at least ${needDistinct} kinds).`, { kinds, longest, distinct }, 'revisuals')
  );
  // Quote, source and title cards all read as "text on a dark background"; too many of them is monotony
  // even when the card types alternate. Judged on the body scenes (the hook title and outro roll are expected).
  const family = (k: string) => (k === 'photo' ? 'photo' : k === 'stat' || k === 'compare' ? 'data' : k === 'steps' ? 'diagram' : 'text');
  const body = kinds.slice(1, -1).filter((k) => k !== 'none');
  const textShare = body.length ? body.filter((k) => family(k) === 'text').length / body.length : 0;
  if (sceneCount >= 6) {
    out.push(
      finding('visuals.monotony', 'visuals', 'major', textShare <= 0.75, `${Math.round(textShare * 100)}% of the body scenes are text cards (limit 75%); families: ${[...new Set(body.map(family))].join(', ')}.`, { textShare: +textShare.toFixed(2) }, 'revisuals')
    );
  }
  const hashes = images.map((a) => String(a.meta.sha256 ?? '')).filter(Boolean);
  const dup = hashes.length - new Set(hashes).size;
  out.push(finding('visuals.duplicates', 'visuals', 'major', dup === 0, dup ? `${dup} image(s) are repeated in more than one scene.` : 'No image is used twice.', { duplicates: dup }, 'revisuals'));
  return out;
}

/** RMS level (dB) of a stretch of the final mix. */
async function rmsDb(ffmpeg: string, file: string, start: number, dur: number, signal?: AbortSignal): Promise<number> {
  const out = await runFfmpegCapture(ffmpeg, ['-ss', start.toFixed(3), '-t', dur.toFixed(3), '-i', file, '-vn', '-af', 'astats=measure_perchannel=none:measure_overall=RMS_level', '-f', 'null', '-'], signal);
  const m = /RMS level dB:\s*(-?[\d.]+|-inf)/.exec(out);
  return !m || m[1] === '-inf' ? -120 : Number(m[1]);
}


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
      validateStoryboard(sb, p.sources, PRODUCTION_FORMATS[p.format ?? 'short'].maxScenes);
      out.push(finding('facts.storyboard', 'facts', 'critical', true, 'Storyboard structure and citations are valid.'));
      // A script from the deterministic fallback writer is never passed silently: it is a major finding until the
      // script is rewritten by the configured writer.
      out.push(
        finding(
          'script.fallback',
          'facts',
          'major',
          !sb.fallbackReason,
          sb.fallbackReason ? `The script was written by the deterministic fallback writer because the configured writer failed (${sb.fallbackReason}). Rewrite it when the LLM is available.` : `Written by ${sb.writer}.`,
          sb.fallbackReason ? { reason: sb.fallbackReason } : {},
          'rescript'
        )
      );
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
  const external = images.filter((a) => a.provider === 'wikimedia-commons' || a.provider === 'openverse');
  const missingEvidence = external.filter((a) => !a.meta.evidenceHash);
  out.push(finding('rights.evidence', 'rights', 'major', missingEvidence.length === 0, missingEvidence.length ? `${missingEvidence.length} licensed image(s) have no retained licence evidence.` : `Licence evidence retained for ${external.length} external image(s).`, { missing: missingEvidence.map((a) => a.sceneIndex) }, 'revisuals'));
  const sounds = p.assets.filter((a) => a.kind === 'music' || a.kind === 'sfx');
  const badSounds = sounds.filter((a) => !a.license || a.meta.commercialUse === 'no' || a.meta.usage === 'platform_native');
  // Music is part of every faceless video: missing music is a failure unless the business explicitly turned it off.
  const hasMusic = sounds.some((a) => a.kind === 'music');
  const required = ctx.musicRequired !== false;
  out.push(finding('audio.music-present', 'audio', required ? 'major' : 'minor', hasMusic || !required, hasMusic ? `Background music: ${sounds.find((a) => a.kind === 'music')!.attribution}.` : required ? 'No background music. Every video needs licensed music.' : 'No background music (turned off for this business).', {}, 'rerender'));
  // A track limited to some platforms (or attached only on a platform) must never reach a destination outside them.
  const dests = [...new Set(p.destinations.map((d) => d.platform))];
  const misrouted = sounds.flatMap((a) => {
    const r = allowedFor({ usage: (a.meta.usage as 'embedded' | 'platform_native') ?? 'embedded', restrictions: (a.meta.restrictions as { platforms?: string[] }) ?? {} }, dests);
    return r.ok ? [] : [`${a.attribution} is not licensed for ${r.blocked.join(', ')}`];
  });
  out.push(finding('rights.audio-platforms', 'rights', 'critical', misrouted.length === 0, misrouted.length ? misrouted.join('; ') : `All music and effects are licensed for ${dests.join(', ') || 'every destination'}.`, { destinations: dests }, 'rerender'));
  const imported = sounds.filter((a) => !String(a.license).startsWith('Generated by Omnicore'));
  const noEvidence = imported.filter((a) => !a.meta.licenceEvidence || !(a.meta.rights as { evidenceSha256?: string } | undefined)?.evidenceSha256);
  out.push(finding('rights.audio-evidence', 'rights', 'major', noEvidence.length === 0, noEvidence.length ? `No licence evidence for: ${noEvidence.map((a) => a.attribution).join('; ')}` : imported.length ? `Licence evidence retained for ${imported.length} licensed track(s).` : 'All sounds are Omnicore-generated.', {}, 'rerender'));
  const needCredit = sounds.filter((a) => (a.meta.rights as { attributionRequired?: boolean } | undefined)?.attributionRequired);
  const uncredited = needCredit.filter((a) => p.destinations.some((d) => !String(p.metadata[d.platform]?.caption ?? '').includes(a.attribution)));
  out.push(finding('rights.audio-attribution', 'rights', 'major', uncredited.length === 0, uncredited.length ? `Credit missing from the description for: ${uncredited.map((a) => a.attribution).join('; ')}` : needCredit.length ? 'Music credit is in every platform description.' : 'No music needs a credit.', {}, 'metadata'));
  // Rights are re-checked against the library now, not taken from what was recorded at render time.
  const revoked = sounds.flatMap((a) => {
    const id = Number(a.meta.trackId);
    if (String(a.license).startsWith('Generated by Omnicore') && !ctx.soundRights) return [];
    if (!ctx.soundRights || !Number.isFinite(id)) return [`${a.attribution}: rights cannot be verified`];
    const r = ctx.soundRights(id);
    return r.ok ? [] : [r.reason];
  });
  out.push(finding('rights.audio-revalidated', 'rights', 'critical', revoked.length === 0, revoked.length ? `Sound rights no longer verified: ${revoked.join('; ')}` : sounds.length ? `All ${sounds.length} sound(s) re-verified against the rights gate.` : 'No sounds used.', { revoked }, 'rerender'));
  out.push(finding('rights.audio', 'audio', 'critical', badSounds.length === 0, badSounds.length ? `Music/effects without commercial embedded-use permission: ${badSounds.map((a) => a.attribution).join('; ')}` : sounds.length ? `${sounds.length} music/effect track(s) licensed for embedded commercial use.` : 'No music or effects used.', { sounds: sounds.map((s) => s.license) }, 'rerender'));

  // ---- visuals ----------------------------------------------------------------
  // 0.6.1 assets carry the relevance verdict recorded when they were chosen; older ones fall back to the file-name check.
  const irrelevant = external.filter((a) => (a.meta.plan ? a.meta.relevant !== true : !isRelevantFile(String(a.meta.key ?? ''), p.topic, '') && !String(a.meta.via ?? '').startsWith('article:')));
  out.push(finding('visuals.relevance', 'visuals', 'major', irrelevant.length === 0, irrelevant.length ? `${irrelevant.length} image(s) do not match the topic or scene: scenes ${irrelevant.map((a) => (a.sceneIndex ?? 0) + 1).join(', ')}.` : 'Every external image matched the topic and scene when it was chosen.', { scenes: irrelevant.map((a) => a.sceneIndex) }, 'revisuals'));
  out.push(...visualVarietyFindings(images, sb?.scenes.length ?? 0, (a) => fs.existsSync(path.join(ctx.dir, a.path))));
  out.push(...graphicFindings(p));
  for (const a of images) {
    const file = path.join(ctx.dir, a.path);
    if (!fs.existsSync(file)) continue;
    const sd = await imageSpread(ctx.ffmpeg, file, ctx.signal).catch(() => null);
    if (sd !== null && sd < 4) out.push(finding('visuals.blank', 'visuals', 'major', false, `Scene ${(a.sceneIndex ?? 0) + 1} looks empty (an almost uniform image).`, { scene: a.sceneIndex, spread: +sd.toFixed(2) }, 'revisuals'));
  }
  const unlabelledAi = images.filter((a) => a.provider === 'comfyui' && !a.meta.aiGenerated);
  out.push(finding('visuals.ai-label', 'visuals', 'critical', unlabelledAi.length === 0, unlabelledAi.length ? 'AI illustration not marked for on-screen labelling.' : 'No unlabelled AI imagery.', {}, 'revisuals'));

  // ---- pronunciation ----------------------------------------------------------------
  if (ctx.pronunciation) {
    const unsure = ctx.pronunciation.filter((f) => f.status === 'uncertain');
    out.push(
      finding(
        'narration.pronunciation',
        'narration',
        'minor',
        unsure.length === 0,
        unsure.length ? `Check how these are said (not in the dictionary): ${unsure.map((f) => `${f.term} (scene ${f.scenes.map((s) => s + 1).join(', ')})`).join('; ')}.` : `All ${ctx.pronunciation.length} names and technical terms are in the dictionary or follow a known rule.`,
        { uncertain: unsure.map((f) => ({ term: f.term, spoken: f.spoken, scenes: f.scenes })) }
      )
    );
  }

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
    const timeline = narrationTimeline(narration.map((a) => ({ audio: a.path, durationSec: Number(a.meta.durationSec), words: (a.meta.words as WordTiming[]) ?? [] })));
    const offset = timeline.reduce((t, x) => t + x.duration, 0);
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
    out.push(finding(AUDIO_GATE_ID, 'audio', 'critical', false, 'Audio gate FAILED: there is no rendered video to analyse.'));
  } else {
    const info = await probe(ctx.ffmpeg, file);
    const specOk = info.video?.codec === 'h264' && info.video.width === 1080 && info.video.height === 1920 && info.audio?.codec === 'aac';
    out.push(finding('video.spec', 'video', 'critical', !!specOk, `${info.video?.codec ?? 'no video'} ${info.video?.width}×${info.video?.height}, audio ${info.audio?.codec ?? 'none'} ${info.audio?.sampleRate ?? ''} Hz.`, { ...info }, 'rerender'));
    const fmt = PRODUCTION_FORMATS[ctx.production.format ?? 'short'];
    out.push(finding('video.duration', 'video', 'major', info.durationSec >= fmt.minSec && info.durationSec <= fmt.maxSec, `Duration ${info.durationSec.toFixed(1)} s (target ${fmt.minSec}–${fmt.maxSec} s for ${fmt.label}).`, { durationSec: info.durationSec, format: ctx.production.format ?? 'short' }, info.durationSec > fmt.maxSec ? 'shorten' : info.durationSec < fmt.minSec && (ctx.production.format ?? 'short') === 'standard' ? 'lengthen' : undefined));
    const decodeErr = (await runFfmpegCapture(ctx.ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-'], ctx.signal)).trim();
    out.push(finding('video.integrity', 'video', 'critical', decodeErr === '', decodeErr ? `Decoding errors: ${decodeErr.slice(0, 300)}` : 'Full decode completed without errors.', {}, 'rerender'));
    out.push(finding('video.faststart', 'video', 'minor', isFastStart(file), isFastStart(file) ? 'Streamable (moov before mdat).' : 'Not streamable (moov after mdat).', {}, 'rerender'));
    const ebu = await runFfmpegCapture(ctx.ffmpeg, ['-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'], ctx.signal);
    const summary = ebu.slice(ebu.lastIndexOf('Summary:'));
    const lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]);
    const peak = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1]);
    out.push(finding('audio.loudness', 'audio', 'major', Number.isFinite(lufs) && lufs >= -19 && lufs <= -13, `Integrated loudness ${Number.isFinite(lufs) ? lufs.toFixed(1) : '?'} LUFS (target −16 ±3).`, { lufs }, 'rerender'));
    out.push(finding('audio.clipping', 'audio', 'major', Number.isFinite(peak) && peak <= -0.5, `True peak ${Number.isFinite(peak) ? peak.toFixed(1) : '?'} dBTP (must stay below −0.5).`, { truePeak: peak }, 'rerender'));
    // The mandatory audio gate: measured on the decoded final render and its stems, never on database records.
    const tail = await rmsDb(ctx.ffmpeg, file, Math.max(0, info.durationSec - 0.12), 0.12, ctx.signal);
    out.push(finding('audio.ending', 'audio', 'minor', tail <= -35, `Last 0.12 s at ${tail.toFixed(0)} dB (${tail <= -35 ? 'fades out' : 'ends abruptly'}).`, { tailDb: tail }, 'rerender'));
    const g = await audioGateFindings({ ffmpeg: ctx.ffmpeg, dir: ctx.dir, finalFile: file, audioCodec: info.audio?.codec, sampleRate: info.audio?.sampleRate, durationSec: info.durationSec, hasMusicAsset: p.assets.some((a) => a.kind === 'music'), signal: ctx.signal });
    out.push(...g.findings);
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
