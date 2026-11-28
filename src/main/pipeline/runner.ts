import fs from 'node:fs';
import path from 'node:path';
import {
  PRODUCTION_STEPS,
  STEP_LABELS,
  type AssetKind,
  type ProductionAsset,
  type ProviderSettings,
  type StepName,
  type Storyboard
} from '../../shared/production';
import type { ProductionRepository } from '../db/productions';
import type { SoundLibrary } from '../library';
import { buildAss, buildCues, type WordTiming } from '../media/captions';
import { CancelledError, probe, runFfmpeg } from '../media/ffmpeg';
import { buildRenderArgs, totalDuration, VIDEO_H, VIDEO_W, type Motion, type RenderAudio, type RenderPlan, type Transition } from '../media/render';
import { AI_GENERATED_LABEL, verifyVisualAssets } from '../media/assetPolicy';
import { notesSource } from '../providers/research';
import { ProviderUnavailableError, type NarrationProvider, type Providers } from '../providers/types';
import { buildEvidenceBrief } from '../research/evidence';
import { createHash } from 'node:crypto';
import type { AuditLedger } from '../audit/ledger';
import type { OperationsRepository } from '../db/operations';
import { buildMetadata } from '../publishing/metadata';
import type { Transcriber } from '../qa/asr';
import { runQaChecks, summarise, type RepairAction } from '../qa/engine';
import { effectiveWordsPerSec } from '../providers/registry';
import { planScene, type VisualKind } from '../media/visualPlan';
import { wordBudget } from '../providers/writers';
import type { PlatformMetadata } from '../../shared/operations';
import { storyMood } from '../audio/sound';
import { resolveEffects } from '../audio/effects';
import { DEFAULT_SOUND_PROFILE, PRODUCTION_FORMATS, type MusicOverride, type SoundProfile, type KokoroVoiceId, type PreviewEngine, type Production, type Pronunciation, type PronunciationFinding } from '../../shared/production';
import { runResearch, type EngineOptions } from '../research/engine';
import type { RawSource } from '../research/dedupe';
import { CLAIM_KIND_LABELS, SOURCE_KIND_LABELS } from '../../shared/production';
import { stopKokoroGpuWorkers } from '../providers/kokoroGpu';
import { ProductionFailure, classifyFailure } from './failures';
import { DuplicateJobError, type JobRepository } from '../automation/jobs';
import type { CircuitBreakers } from '../automation/circuit';
import type { JobInitiator, JobKind, ProductionActionEvent, ProductionJob, ProductionStateSnapshot } from '../../shared/automation';
import { prepareMix } from '../audio/plan';
import { AUDIO_GATE_ID, mixProfile } from '../../shared/audioMix';
import { embeddable } from '../library';
import { InvalidStoryboardError } from '../providers/text';
import { narrationTimeline, type TimelineScene } from '../media/timeline';
import { renderAudioVerification, type VerificationResult } from '../audio/verify';
import type { ContextualEffect } from '../../shared/audioMix';

export interface RunnerDeps {
  /** Production jobs (one active job per production, with initiator, lifecycle and heartbeat). */
  jobs?: JobRepository;
  /** Circuit breakers for services automation depends on. */
  breakers?: CircuitBreakers;
  /** Contextual effects approved for a production (none unless you chose some). */
  productionEffects?: (productionId: number) => ContextualEffect[];
  /** Why production is frozen (null = running is allowed). Checked by every route that starts or resumes work. */
  frozen?: () => string | null;
  repo: ProductionRepository;
  productionsDir: string;
  settings: () => ProviderSettings;
  providers: (s: ProviderSettings) => Providers;
  ffmpeg: (s: ProviderSettings) => string;
  channel: (channelId: number) => { name: string; niche: string; instructions?: string; keywords?: string[] };
  emit: (productionId: number) => void;
  /** Music & Sound Library (optional: without it, renders have narration only). */
  library?: SoundLibrary;
  /** Called after the script step (e.g. to copy the script into the linked content item). */
  onScript?: (productionId: number, storyboard: Storyboard) => void;
  /** Called after a production completes (e.g. to bring its idea's status in line after a manual retry). */
  onCompleted?: (productionId: number) => void;
  /** 0.5: brands/destinations, audit ledger, independent speech recognition for QA. */
  ops?: OperationsRepository;
  audit?: AuditLedger;
  asr?: Transcriber;
  /** Test seam for research article fetching. */
  fetchPage?: EngineOptions['fetchPage'];
  /** The business's resolved pronunciation dictionary for an engine (0.7). */
  pronunciations?: (businessId: number, engine: PreviewEngine) => Pronunciation[];
  /** Terms in a script whose pronunciation nobody has confirmed (0.7). */
  pronunciationCheck?: (p: Production) => PronunciationFinding[];
  /** The business's sound profile (music required, moods, accents, discovery). */
  soundProfile?: (businessId: number) => SoundProfile;
  /** A manual music choice for one production, if any (set from the production page, audited). */
  musicOverride?: (productionId: number) => MusicOverride | null;
  /** Music tracks the business used most recently (for variety). */
  recentMusic?: (businessId: number, beforeProductionId: number) => number[];
  /** Test seam: replaces the FFmpeg render call. */
  render?: (args: string[], cwd: string, signal: AbortSignal, onProgress: (f: number) => void, totalSec: number) => Promise<void>;
}

const STEP_ASSETS: Partial<Record<StepName, AssetKind[]>> = {
  narration: ['narration'],
  visuals: ['image'],
  captions: ['captions'],
  render: ['video', 'credits', 'music', 'sfx']
};

const pad2 = (n: number) => String(n + 1).padStart(2, '0');
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Ctx {
  id: number;
  dir: string;
  settings: ProviderSettings;
  providers: Providers;
  signal: AbortSignal;
  progress: (fraction: number, detail?: string) => void;
  cost: (usd: number) => void;
  /** Script budget multiplier (QA "shorten" repairs lower it). */
  budgetScale: number;
}

/** Scene durations/offsets derived from narration, shared by captions and render so they stay in sync. */
export function sceneTimeline(storyboard: Storyboard, narration: ProductionAsset[]): TimelineScene[] {
  return narrationTimeline(
    storyboard.scenes.map((sc) => {
      const a = narration.find((n) => n.sceneIndex === sc.index);
      if (!a) throw new Error(`Scene ${sc.index + 1} has no narration. Re-run the narration step.`);
      return { audio: a.path, durationSec: Number(a.meta.durationSec), words: (a.meta.words as WordTiming[]) ?? [] };
    })
  );
}

/** Camera move and transition per scene: photos pan or push, graphics hold nearly still; transitions vary with content. */
export function sceneMotion(images: ProductionAsset[], i: number): { motion: Motion; transition?: Transition } {
  const kind = (k: number) => String(images.find((a) => a.sceneIndex === k)?.meta.visualKind ?? 'photo');
  const photoMoves: Motion[] = ['in', 'left', 'out', 'right'];
  const k = kind(i);
  const motion: Motion = k === 'photo' ? photoMoves[i % photoMoves.length] : k === 'title-card' ? 'in' : 'still';
  if (i === 0) return { motion };
  const prev = kind(i - 1);
  const graphicMoves: Transition[] = ['smoothleft', 'smoothup', 'slideleft'];
  const transition: Transition = prev === 'photo' || k === 'photo' ? 'fade' : k === 'sources' ? 'circleopen' : graphicMoves[i % graphicMoves.length];
  return { motion, transition };
}

export class ProductionRunner {
  private active: { id: number; ctrl: AbortController } | null = null;
  private activeJob: number | null = null;
  /** Jobs the watchdog stopped for lack of progress (their run ends as "stalled", not "cancelled"). */
  private readonly stalled = new Set<number>();
  private kicking = false;
  private lastEmit = new Map<number, number>();

  constructor(private readonly d: RunnerDeps) {}

  dirFor(id: number): string {
    return path.join(this.d.productionsDir, String(id));
  }

  /** True while a production is running or waiting in the queue. */
  busy(): boolean {
    return !!this.active || this.kicking || this.d.repo.queued().length > 0;
  }

    isActive(id: number): boolean {
    return this.active?.id === id;
  }

  /** Queue a production; it starts as soon as nothing else is rendering. */
  /**
   * Render the audio verification video (real voice, approved soundtrack and effects, the production mixer and the
   * audio gate) into dataDir/audio-verification/<time>. Creates no production. Refused while anything is rendering.
   */
  async verifyAudioPipeline(channelId: number, profileId: string | undefined, signal: AbortSignal): Promise<VerificationResult & { dir: string }> {
    if (this.busy()) throw new Error('A production is running; verify the audio pipeline when nothing is rendering.');
    if (!this.d.library) throw new Error('No sound library is configured.');
    // The business's own voice (its presenter overrides the global narration), exactly as its productions use it.
    const settings = this.brandSettings(channelId);
    const providers = this.d.providers(settings);
    const dir = path.join(path.dirname(path.resolve(this.d.productionsDir)), 'audio-verification', new Date().toISOString().replace(/[:.]/g, '-'));
    try {
      const r = await renderAudioVerification({ ffmpeg: this.d.ffmpeg(settings), dir, narration: providers.narration, library: this.d.library, settings, profile: mixProfile(profileId), signal });
      return { ...r, dir };
    } finally {
      stopKokoroGpuWorkers();
    }
  }

  /**
   * The speaking rate of the business's current voice, measured from its most recent narration (words per second over
   * up to 8 productions voiced by the same voice). Null when there is too little history (the estimate is used).
   */
  measuredWordsPerSec(channelId: number): number | null {
    try {
      const full = this.d.repo
        .list(channelId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 20)
        .map((x) => this.d.repo.get(x.id))
        .filter((x) => x.storyboard && x.assets.some((a) => a.kind === 'narration'));
      const voiceOf = (x: Production) => String(x.assets.find((a) => a.kind === 'narration')?.meta.voice ?? '');
      const voice = full.length ? voiceOf(full[0]) : '';
      let words = 0;
      let secs = 0;
      for (const x of full.filter((r) => voiceOf(r) === voice).slice(0, 8)) {
        words += x.storyboard!.scenes.reduce((n, sc) => n + sc.narration.split(/\s+/).filter(Boolean).length, 0);
        secs += x.assets.filter((a) => a.kind === 'narration').reduce((n, a) => n + Number(a.meta.durationSec ?? 0), 0);
      }
      return words >= 200 && secs > 30 ? Math.max(1.6, Math.min(3.6, words / secs)) : null;
    } catch {
      return null;
    }
  }


  /** Throws while production is frozen (e.g. until the repaired audio pipeline is verified). */
  assertNotFrozen(): void {
    const why = this.d.frozen?.();
    if (why) throw new Error(`Production is frozen: ${why}`);
  }

  /** The state recorded before and after every action. */
  snapshot(id: number): ProductionStateSnapshot | null {
    try {
      const p = this.d.repo.get(id);
      return { status: p.status, step: p.currentStep, approval: p.approval };
    } catch {
      return null;
    }
  }

  /** One `production.action` audit event: who did what to which production, with the state before and after. */
  act(id: number, e: Omit<ProductionActionEvent, 'previous' | 'resulting'> & { previous?: ProductionStateSnapshot | null }): void {
    const { previous, ...rest } = e;
    this.d.audit?.record({ actor: e.initiator, businessId: this.businessOf(id) ?? undefined, type: 'production.action', productionId: id, data: { ...rest, previous: previous ?? null, resulting: this.snapshot(id) } as unknown as Record<string, unknown> });
  }

  private businessOf(id: number): number | null {
    try {
      return this.d.repo.get(id).channelId;
    } catch {
      return null;
    }
  }

  /**
   * Every route that starts work goes through here: the freeze, the current state and the one-active-job rule are
   * checked and the job is created BEFORE anything is reset, so a refused request changes nothing. Refusals are audited.
   */
  private request(id: number, kind: JobKind, initiator: JobInitiator, fromStep: string | null, reason = ''): ProductionJob | null {
    const action = kind === 'produce' ? 'queue' : kind;
    const previous = this.snapshot(id);
    const refuse = (why: string): never => {
      this.act(id, { action: 'refuse', initiator, outcome: 'refused', stage: fromStep, jobId: null, previous, reason: `${action}: ${why}` });
      throw new Error(why);
    };
    const frozen = this.d.frozen?.();
    if (frozen) refuse(`Production is frozen: ${frozen}`);
    const p = this.d.repo.get(id);
    // A newly created production starts as "queued" with no job yet: its first run is allowed (once).
    const firstRun = kind === 'produce' && p.status === 'queued' && !this.d.jobs?.active(id);
    if (p.status === 'running' || (p.status === 'queued' && !firstRun)) refuse('This production is already running or queued.');
    if (!this.d.jobs) return null;
    try {
      return this.d.jobs.create({ productionId: id, businessId: p.channelId, kind, fromStep, initiator, reason });
    } catch (e) {
      if (e instanceof DuplicateJobError) refuse(e.message);
      throw e;
    }
  }

  private queueRequested(id: number, job: ProductionJob | null, kind: JobKind, initiator: JobInitiator, fromStep: string | null, previous: ProductionStateSnapshot | null, reason = ''): void {
    this.d.repo.update(id, { status: 'queued', error: null });
    this.act(id, { action: kind === 'produce' ? 'queue' : kind, initiator, outcome: 'requested', stage: fromStep, jobId: job?.id ?? null, previous, ...(reason ? { reason } : {}) });
    this.d.emit(id);
    void this.kick();
  }

  enqueue(id: number, initiator: JobInitiator = 'user', reason = ''): void {
    const previous = this.snapshot(id);
    const job = this.request(id, 'produce', initiator, null, reason);
    this.queueRequested(id, job, 'produce', initiator, null, previous, reason);
  }

  /**
   * The research and evidence gate a production would run, without creating one: is there enough independent
   * evidence for this topic in this format? Used to set aside single-source ideas before they become failed productions.
   */
  async evidencePrecheck(topic: string, mode: 'news' | 'explainer', channelId: number, format: 'short' | 'standard', signal: AbortSignal): Promise<{ ok: boolean; reason: string }> {
    const settings = this.d.settings();
    const providers = this.d.providers(settings);
    const result = await runResearch({ topic, mode, windowDays: settings.newsWindowDays }, providers.research, [], signal, { fetchPage: this.d.fetchPage });
    if (!result.sources.length) return { ok: false, reason: `no usable sources found (${mode})` };
    const budget = wordBudget(format, this.measuredWordsPerSec(channelId) ?? effectiveWordsPerSec(settings));
    const brief = buildEvidenceBrief(topic, result.sources, this.d.channel(channelId).niche, mode, budget.maxWords, format, budget.minWords);
    const fmt = PRODUCTION_FORMATS[format];
    const used = new Set((brief.claims ?? []).flatMap((cl) => cl.sourceIds)).size;
    const claims = brief.claims?.length ?? 0;
    const ok = claims >= fmt.minClaims && used >= fmt.minSources;
    return { ok, reason: `${claims} claims from ${used} independent sources (${fmt.label} needs ${fmt.minClaims} from ${fmt.minSources})` };
  }

  /** Resume a failed/cancelled production from its first unfinished step. Gates run again; nothing is skipped. */
  retry(id: number, initiator: JobInitiator = 'user', reason = ''): void {
    const previous = this.snapshot(id);
    const job = this.request(id, 'retry', initiator, null, reason);
    const p = this.d.repo.get(id);
    for (const s of p.steps) if (s.status !== 'done') this.d.repo.resetStep(id, s.step);
    this.queueRequested(id, job, 'retry', initiator, p.steps.find((s) => s.status !== 'done')?.step ?? null, previous, reason);
  }

  /** Re-run from a given step, discarding that step's and all later outputs. */
  rerun(id: number, from: StepName, initiator: JobInitiator = 'user', reason = ''): void {
    const previous = this.snapshot(id);
    const job = this.request(id, 'rerun', initiator, from, reason);
    const startIdx = PRODUCTION_STEPS.indexOf(from);
    for (const step of PRODUCTION_STEPS.slice(startIdx)) {
      this.d.repo.resetStep(id, step);
      for (const kind of STEP_ASSETS[step] ?? []) this.removeAssets(id, kind);
    }
    if (startIdx <= PRODUCTION_STEPS.indexOf('research')) this.d.repo.update(id, { sources: [] });
    if (startIdx <= PRODUCTION_STEPS.indexOf('brief')) this.d.repo.update(id, { brief: null });
    if (startIdx <= PRODUCTION_STEPS.indexOf('script')) this.d.repo.update(id, { storyboard: null });
    // Only a re-render replaces the video; re-running QA keeps the finished file linked.
    if (startIdx <= PRODUCTION_STEPS.indexOf('render')) this.d.repo.update(id, { outputPath: null, durationSec: null });
    this.queueRequested(id, job, 'rerun', initiator, from, previous, reason);
  }

  /**
   * Re-voice only the scenes that contain a corrected word, then rebuild captions, render and QA. Visuals,
   * script and the other scenes' narration are kept, so the rest of the video is not regenerated.
   */
  renarrateScenes(id: number, scenes: number[], initiator: JobInitiator = 'user'): void {
    const previous = this.snapshot(id);
    const frozen = this.d.frozen?.();
    if (frozen) {
      this.act(id, { action: 'refuse', initiator, outcome: 'refused', stage: 'narration', jobId: null, previous, reason: `revoice: Production is frozen: ${frozen}` });
      throw new Error(`Production is frozen: ${frozen}`);
    }
    const p = this.d.repo.get(id);
    // Validate before the job exists, so a refused request leaves nothing behind.
    if (!p.storyboard) throw new Error('This production has no script yet.');
    const valid = [...new Set(scenes)].filter((i) => p.storyboard!.scenes.some((s) => s.index === i));
    if (!valid.length) throw new Error('None of those scenes exist in this production.');
    const reason = `scenes ${valid.map((x) => x + 1).join(', ')}`;
    const job = this.request(id, 'revoice', initiator, 'narration', reason);
    const dir = this.dirFor(id);
    for (const a of this.d.repo.deleteSceneAssets(id, 'narration', valid)) fs.rmSync(path.join(dir, a.path), { force: true });
    for (const step of ['narration', 'captions', 'render', 'qa'] as const) this.d.repo.resetStep(id, step);
    for (const kind of [...(STEP_ASSETS.captions ?? []), ...(STEP_ASSETS.render ?? [])]) this.removeAssets(id, kind);
    this.d.repo.update(id, { outputPath: null, durationSec: null });
    this.audit({ type: 'narration.revoice', productionId: id, data: { scenes: valid.map((i) => i + 1) } });
    this.queueRequested(id, job, 'revoice', initiator, 'narration', previous, reason);
  }


  cancel(id: number, initiator: JobInitiator = 'user'): void {
    const previous = this.snapshot(id);
    const job = this.d.jobs?.active(id) ?? null;
    this.act(id, { action: 'cancel', initiator, outcome: 'requested', stage: previous?.step ?? null, jobId: job?.id ?? null, previous });
    if (this.active?.id === id) {
      this.active.ctrl.abort();
      return;
    }
    const p = this.d.repo.get(id);
    if (p.status === 'queued') {
      this.d.repo.update(id, { status: 'cancelled', error: 'Cancelled before it started.' });
      if (job) this.d.jobs?.finish(job.id, 'cancelled', 'Cancelled before it started.');
      this.act(id, { action: 'cancel', initiator, outcome: 'cancelled', stage: null, jobId: job?.id ?? null, previous });
      this.d.emit(id);
    }
  }

  delete(id: number, actor = 'user'): void {
    const p = this.d.repo.get(id);
    this.cancel(id);
    // Recorded before the row goes; the audit log keeps every earlier event for this production number.
    this.d.audit?.record({
      actor,
      businessId: p.channelId,
      type: 'production.deleted',
      productionId: id,
      data: { topic: p.topic, status: p.status, origin: p.origin, ideaId: p.ideaId, format: p.format, approval: p.approval, publishStatus: p.publishStatus, outputPath: p.outputPath, durationSec: p.durationSec, createdAt: p.createdAt, assets: p.assets.length }
    });
    this.act(id, { action: 'delete', initiator: actor === 'user' ? 'user' : 'system', outcome: 'succeeded', stage: null, jobId: null, previous: this.snapshot(id) });
    this.d.repo.delete(id);
    const dir = this.dirFor(id);
    if (path.dirname(dir) === path.resolve(this.d.productionsDir)) fs.rmSync(dir, { recursive: true, force: true });
  }

  /**
   * On startup: runs left "running" were interrupted by a crash or exit. Their jobs are closed as interrupted and the
   * productions marked failed (retryable), each with an audit event from the recovery process. A production whose
   * job record disagrees with it is marked unsafe for a person to look at. Nothing historical is rewritten.
   */
  recoverAfterRestart(): { interrupted: number[]; unsafe: number[] } {
    const out = { interrupted: [] as number[], unsafe: [] as number[] };
    const jobs = this.d.jobs?.runningAtStartup() ?? [];
    for (const j of jobs) {
      this.d.jobs!.finish(j.id, 'interrupted', 'Interrupted because the app was closed or crashed.', 'transient');
      if (j.productionId !== null) {
        const previous = this.snapshot(j.productionId);
        if (previous?.status === 'running') out.interrupted.push(j.productionId);
        this.act(j.productionId, { action: 'interrupt', initiator: 'recovery', outcome: 'failed', stage: previous?.step ?? null, jobId: j.id, previous, error: 'Interrupted because the app was closed or crashed.', failureKind: 'transient', reason: 'interrupted' });
      }
    }
    for (const id of this.d.repo.running()) {
      const previous = this.snapshot(id);
      const hadJob = jobs.some((j) => j.productionId === id);
      const everHadJob = this.d.jobs?.latest(id) ?? null;
      // Running with a job that is not running (finished jobs disagree with the production): inconsistent.
      if (this.d.jobs && !hadJob && everHadJob) {
        this.d.repo.markFailed(id, 'Inconsistent state after restart: the production was running but its last job had already ended.', { kind: 'unsafe', code: 'inconsistent-state' });
        out.unsafe.push(id);
        this.act(id, { action: 'interrupt', initiator: 'recovery', outcome: 'failed', stage: previous?.step ?? null, jobId: everHadJob.id, previous, error: 'inconsistent state', failureKind: 'unsafe', reason: 'inconsistent-state' });
      } else {
        this.d.repo.markFailed(id, 'Interrupted because the app was closed. Retry to resume.', { kind: 'transient', code: 'interrupted' });
        if (!hadJob) {
          out.interrupted.push(id);
          this.act(id, { action: 'interrupt', initiator: 'recovery', outcome: 'failed', stage: previous?.step ?? null, jobId: null, previous, error: 'Interrupted because the app was closed.', failureKind: 'transient', reason: 'interrupted' });
        }
      }
    }
    return out;
  }

  /**
   * Watchdog (called every minute): a running job without progress for the stall limit is stopped and recorded as
   * stalled; a queued job older than the expiry limit is expired. Both are audited by the system.
   */
  checkOverdue(limits: { stallMs: number; queuedExpiryMs: number }): { stalled: number[]; expired: number[] } {
    const out = { stalled: [] as number[], expired: [] as number[] };
    if (!this.d.jobs) return out;
    const { stalled, expired } = this.d.jobs.overdue(limits.stallMs, limits.queuedExpiryMs);
    for (const j of stalled) {
      if (j.productionId !== null && this.active?.id === j.productionId && this.activeJob === j.id) {
        this.stalled.add(j.id);
        this.active.ctrl.abort();
      } else {
        this.d.jobs.finish(j.id, 'stalled', 'No heartbeat; the run is no longer active.', 'transient');
        if (j.productionId !== null) this.act(j.productionId, { action: 'stall', initiator: 'system', outcome: 'failed', stage: null, jobId: j.id, previous: this.snapshot(j.productionId), error: 'stalled', failureKind: 'transient', reason: 'stalled' });
      }
      out.stalled.push(j.id);
    }
    for (const j of expired) {
      if (j.productionId === null || this.active?.id === j.productionId) continue;
      const previous = this.snapshot(j.productionId);
      this.d.jobs.finish(j.id, 'expired', `Queued for longer than ${Math.round(limits.queuedExpiryMs / 3_600_000)} h without starting.`);
      if (previous?.status === 'queued') this.d.repo.update(j.productionId, { status: 'cancelled', error: 'The queued job expired before it started. Queue it again to run it.' });
      this.act(j.productionId, { action: 'expire', initiator: 'system', outcome: 'cancelled', stage: null, jobId: j.id, previous, reason: 'expired' });
      this.d.emit(j.productionId);
      out.expired.push(j.id);
    }
    return out;
  }

  /** Resolves when the queue is empty (used by tests and smoke runs). */
  async idle(): Promise<void> {
    while (this.active || this.kicking || this.d.repo.queued().length) await new Promise((r) => setTimeout(r, 50));
  }

  private removeAssets(id: number, kind: AssetKind): void {
    const dir = this.dirFor(id);
    for (const a of this.d.repo.deleteAssets(id, kind)) {
      if (a.path.startsWith('library:')) continue; // shared library file, not owned by this production
      fs.rmSync(path.join(dir, a.path), { force: true });
    }
  }

  private async kick(): Promise<void> {
    if (this.active || this.kicking) return;
    if (this.d.frozen?.()) return; // queued work waits; nothing starts while production is frozen
    this.kicking = true;
    try {
      let next: number | undefined;
      while (!this.active && (next = this.d.repo.queued()[0]) !== undefined) {
        await this.run(next);
      }
    } finally {
      this.kicking = false;
    }
  }

  private emitThrottled(id: number, force = false): void {
    const now = Date.now();
    if (!force && now - (this.lastEmit.get(id) ?? 0) < 250) return;
    this.lastEmit.set(id, now);
    this.d.emit(id);
  }

  private async run(id: number): Promise<void> {
    const ctrl = new AbortController();
    this.active = { id, ctrl };
    const repo = this.d.repo;
    const dir = this.dirFor(id);
    fs.mkdirSync(dir, { recursive: true });
    // The job this run belongs to (a production queued before jobs existed gets one now, recorded as system).
    let job = this.d.jobs?.active(id) ?? null;
    if (this.d.jobs && !job) job = this.d.jobs.create({ productionId: id, businessId: repo.get(id).channelId, kind: 'produce', initiator: 'system', reason: 'queued without a job record' });
    const jobId = job?.id ?? null;
    if (job) this.d.jobs!.start(job.id);
    this.activeJob = jobId;
    const previous = this.snapshot(id);
    repo.update(id, { status: 'running', error: null });
    this.act(id, { action: 'start', initiator: job?.initiator ?? 'system', outcome: 'started', stage: null, jobId, previous });
    this.d.emit(id);
    let current: StepName | null = null;
    let lastBeat = 0;
    const beat = () => {
      if (jobId === null || Date.now() - lastBeat < 10_000) return;
      lastBeat = Date.now();
      this.d.jobs!.heartbeat(jobId);
    };
    try {
      const prod = repo.get(id);
      const brand = this.brandSettings(prod.channelId);
      // Autonomous productions always carry licensed music (cleared tracks or Omnicore-generated beds).
      const settings = prod.origin === 'autonomous' && brand.musicMode === 'none' ? { ...brand, musicMode: 'auto' as const } : brand;
      const providers = this.d.providers(settings);
      this.audit({ type: 'production.started', productionId: id, data: { narration: settings.narration, voice: settings.narration === 'sherpa' ? settings.sherpaVoice : settings.narration === 'piper' ? settings.piperVoice : settings.voice, writer: settings.writer, visuals: settings.visuals, musicMode: settings.musicMode, research: settings.researchProviders } });
      for (const step of PRODUCTION_STEPS) {
        if (repo.steps(id).find((s) => s.step === step)?.status === 'done') continue;
        current = step;
        repo.update(id, { currentStep: step });
        repo.updateStep(id, step, { status: 'running', progress: 0, error: null, detail: '', incrementAttempts: true, started: true });
        this.emitThrottled(id, true);
        const ctx: Ctx = {
          id,
          dir,
          settings,
          providers,
          signal: ctrl.signal,
          progress: (fraction, detail) => {
            repo.updateStep(id, step, { progress: fraction, ...(detail !== undefined ? { detail } : {}) });
            beat();
            this.emitThrottled(id);
          },
          cost: (usd) => usd && repo.updateStep(id, step, { addCostUsd: usd }),
          budgetScale: 1
        };
        beat();
        await this.steps[step](ctx);
        if (ctrl.signal.aborted) throw new CancelledError();
        if (step === 'script') this.d.breakers?.success('writer');
        repo.updateStep(id, step, { status: 'done', progress: 1, finished: true });
        this.emitThrottled(id, true);
      }
      repo.update(id, { status: 'completed', currentStep: null });
      this.audit({ type: 'production.completed', productionId: id, data: { approval: repo.get(id).approval } });
      if (jobId !== null) this.d.jobs!.finish(jobId, 'succeeded');
      this.act(id, { action: 'complete', initiator: job?.initiator ?? 'system', outcome: 'succeeded', stage: null, jobId, previous });
      try {
        this.d.onCompleted?.(id);
      } catch {
        // reconciliation is best-effort; the scheduler repeats it on its next pass
      }
    } catch (e) {
      const stalled = jobId !== null && this.stalled.has(jobId);
      const cancelled = !stalled && (e instanceof CancelledError || ctrl.signal.aborted);
      const msg = stalled ? `No progress for longer than the stall limit; the run was stopped.` : cancelled ? 'Cancelled.' : errMsg(e);
      // Classified by the error's type where it was thrown, never by its wording.
      const failure = stalled ? { kind: 'transient' as const, code: 'stalled' } : classifyFailure(e, cancelled);
      if (current) repo.updateStep(id, current, { status: 'failed', error: msg, finished: true });
      repo.update(id, {
        status: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? 'Cancelled. Retry to resume.' : `${current ? STEP_LABELS[current] : 'Setup'}: ${msg}`,
        failure
      });
      this.audit({ type: cancelled ? 'production.cancelled' : 'production.failed', productionId: id, data: { step: current, error: msg, failureKind: failure.kind, failureCode: failure.code } });
      if (failure.kind === 'writer') this.d.breakers?.failure('writer', msg);
      if (jobId !== null) this.d.jobs!.finish(jobId, stalled ? 'stalled' : cancelled ? 'cancelled' : 'failed', msg, failure.kind);
      this.act(id, { action: stalled ? 'stall' : cancelled ? 'cancel' : 'fail', initiator: job?.initiator ?? 'system', outcome: cancelled ? 'cancelled' : 'failed', stage: current, jobId, previous, error: msg, failureKind: failure.kind, reason: failure.code });
    } finally {
      this.active = null;
      this.activeJob = null;
      if (jobId !== null) this.stalled.delete(jobId);
      this.d.emit(id);
    }
  }

  // ---- steps --------------------------------------------------------------
  private steps: Record<StepName, (c: Ctx) => Promise<void>> = {
    research: async (c) => {
      const p = this.d.repo.get(c.id);
      const notes = notesSource(this.d.repo.userNotes(c.id));
      const extra: RawSource[] = notes ? [{ ...notes, kind: 'user', provider: 'notes', contentLevel: 'notes' }] : [];
      if (!c.providers.research.length && !extra.length) {
        throw new Error('No research sources: every research provider is turned off and this production has no research notes. Enable providers in Studio → Providers or start the production from a content item with research notes.');
      }
      const result = await runResearch({ topic: p.topic, mode: p.mode, windowDays: c.settings.newsWindowDays }, c.providers.research, extra, c.signal, {
        onProgress: (m) => c.progress(0.3, m),
        fetchPage: this.d.fetchPage
      });
      const failed = result.reports.filter((r) => r.status === 'failed');
      if (!result.sources.length) {
        throw new ProductionFailure(
          'content',
          'no-sources',
          `No usable sources found for "${p.topic}" (${p.mode} mode). ${failed.map((r) => `${r.label}: ${r.error}`).join(' · ')}${result.dropped.length ? ` · ${result.dropped.length} candidates were off-topic, unreadable or too old` : ''}. Try a more specific topic or the other mode.`
        );
      }
      this.d.repo.update(c.id, { sources: result.sources });
      this.audit({
        type: 'research.completed',
        productionId: c.id,
        data: {
          topic: p.topic,
          mode: p.mode,
          providers: result.reports.map((r) => ({ id: r.id, status: r.status, found: r.found, error: r.error })),
          dropped: result.dropped.length,
          sources: result.sources.map((s) => ({ id: s.id, url: s.url, publisher: s.publisher, kind: s.kind, publishedAt: s.publishedAt, group: s.group, derivedFrom: s.derivedFrom, evidence: this.retain('source-text', JSON.stringify({ url: s.url, title: s.title, excerpt: s.excerpt, retrievedAt: s.retrievedAt }), s.url) }))
        }
      });
      const kinds = new Map<string, number>();
      for (const s of result.sources) kinds.set(SOURCE_KIND_LABELS[s.kind ?? 'other'], (kinds.get(SOURCE_KIND_LABELS[s.kind ?? 'other']) ?? 0) + 1);
      const answered = result.reports.filter((r) => r.status !== 'failed' && r.id !== 'notes').length;
      c.progress(
        1,
        `${result.sources.length} sources (${[...kinds].map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ')}) · ${answered}/${c.providers.research.length} providers answered${failed.length ? ` · unavailable: ${failed.map((f) => `${f.label} (${f.error})`).join('; ')}` : ''}`
      );
    },

    brief: async (c) => {
      const p = this.d.repo.get(c.id);
      // The voice's measured speaking rate (recent narration of this business), so "about a minute" really is.
      const wps = this.measuredWordsPerSec(p.channelId) ?? effectiveWordsPerSec(c.settings);
      const budget = wordBudget(p.format, wps);
      const maxWords = Math.round(budget.maxWords * c.budgetScale);
      const minWords = Math.round(budget.minWords * Math.max(1, c.budgetScale));
      const brief = buildEvidenceBrief(p.topic, p.sources, this.d.channel(p.channelId).niche, p.mode, maxWords, p.format, Math.min(minWords, maxWords - 20));
      const fmt = PRODUCTION_FORMATS[p.format];
      // Editorial standard: a longer video needs more independent evidence, never padding.
      const usedSources = new Set((brief.claims ?? []).flatMap((cl) => cl.sourceIds)).size;
      if ((brief.claims?.length ?? 0) < fmt.minClaims || usedSources < fmt.minSources)
        throw new ProductionFailure('content', 'insufficient-evidence', `Not enough evidence for a ${fmt.label} video: ${brief.claims?.length ?? 0} claims from ${usedSources} sources (needs ${fmt.minClaims} claims from ${fmt.minSources} sources). Produce it as a Short, or add sources.`);
      this.d.repo.update(c.id, { brief });
      this.audit({ type: 'evidence.claims', productionId: c.id, data: { maxWords, minWords, wordsPerSec: +wps.toFixed(2), claims: (brief.claims ?? []).map((cl) => ({ id: cl.id, kind: cl.kind, sources: cl.sourceIds, independent: cl.independentSources, attribution: cl.attribution })) } });
      const kinds = new Map<string, number>();
      for (const cl of brief.claims ?? []) kinds.set(CLAIM_KIND_LABELS[cl.kind], (kinds.get(CLAIM_KIND_LABELS[cl.kind]) ?? 0) + 1);
      c.progress(1, `${brief.claims?.length ?? 0} evidence claims (${[...kinds].map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ')}) · ~${brief.targetSeconds}s`);
    },

    script: async (c) => {
      const p = this.d.repo.get(c.id);
      if (!p.brief) throw new Error('No brief. Re-run from Brief.');
      const ch = this.d.channel(p.channelId);
      const input = { brief: p.brief, sources: p.sources, channelName: ch.name, instructions: ch.instructions };
      const primary = c.providers.writer;
      // The LLM shares the GPU with the Kokoro voice: free it before writing so the LLM never starts out of memory.
      stopKokoroGpuWorkers();
      // Detect a crashed or unloaded LLM before sending a request (a clear error, and no fallback for autonomous work).
      const health = await primary.check(c.signal);
      if (!health.available && (p.origin === 'autonomous' || !c.providers.fallbackWriter)) throw new ProductionFailure('writer', 'writer-unavailable', `The script writer failed (${primary.label}: ${health.detail}). ${p.origin === 'autonomous' ? 'Autonomous productions never fall back to the deterministic writer; fix' : 'Start'} the writer and retry.`);
      c.progress(0.1, `Writing with ${primary.label}…`);
      let storyboard: Storyboard;
      try {
        const r = await primary.write(input, c.signal);
        c.cost(r.units * primary.costPerUnitUsd);
        storyboard = r.storyboard;
      } catch (e) {
        const fb = c.providers.fallbackWriter;
        if (e instanceof CancelledError || c.signal.aborted || !fb) throw e;
        const reason = `${primary.label}: ${errMsg(e)}`;
        // Autonomous productions never use the deterministic fallback: they stop with the writer's error.
        if (p.origin === 'autonomous')
          throw new ProductionFailure('writer', e instanceof InvalidStoryboardError ? 'invalid-script' : 'writer-error', `The script writer failed (${reason}). Autonomous productions never fall back to the deterministic writer; fix the writer and retry.`, { cause: e });
        c.progress(0.6, `Falling back to ${fb.label}…`);
        storyboard = { ...(await fb.write(input, c.signal)).storyboard, fallbackReason: reason };
        storyboard.writer = `${storyboard.writer} (fallback)`;
      }
      this.d.repo.update(c.id, { storyboard });
      this.audit({ type: 'script.version', productionId: c.id, data: { writer: storyboard.writer, fallbackReason: storyboard.fallbackReason, scenes: storyboard.scenes.length, words: storyboard.scenes.reduce((n, s) => n + s.narration.split(/\s+/).length, 0), evidence: this.retain('script', JSON.stringify(storyboard)) } });
      this.d.onScript?.(c.id, storyboard);
      c.progress(1, `${storyboard.scenes.length} scenes · ${storyboard.writer}${storyboard.fallbackReason ? ` · ${storyboard.fallbackReason}` : ''}`);
    },

    narration: async (c) => {
      const p = this.d.repo.get(c.id);
      if (!p.storyboard) throw new Error('No storyboard. Re-run from Script.');
      let n: NarrationProvider = c.providers.narration;
      let fallbackNote = '';
      fs.mkdirSync(path.join(c.dir, 'audio'), { recursive: true });
      const existing = this.d.repo.assets(c.id, 'narration');
      const scenes = p.storyboard.scenes;
      for (const sc of scenes) {
        const have = existing.find((a) => a.sceneIndex === sc.index);
        if (have && fs.existsSync(path.join(c.dir, have.path))) continue;
        c.progress(sc.index / scenes.length, `Voicing scene ${sc.index + 1} of ${scenes.length}`);
        const rel = `audio/scene-${pad2(sc.index)}.wav`;
        let r;
        try {
          r = await n.synthesize(sc.narration, path.join(c.dir, rel), c.signal);
        } catch (e) {
          // Never mix voices in one video: only fall back before any clip exists.
          const fb = c.providers.fallbackNarration;
          if (!(e instanceof ProviderUnavailableError) || !fb || this.d.repo.assets(c.id, 'narration').length) throw e;
          fallbackNote = ` · ${n.label} unavailable (${errMsg(e)}), used ${fb.label}`;
          n = fb;
          r = await n.synthesize(sc.narration, path.join(c.dir, rel), c.signal);
        }
        c.cost(sc.narration.length * n.costPerUnitUsd);
        this.d.repo.addAsset(c.id, {
          kind: 'narration',
          sceneIndex: sc.index,
          path: rel,
          provider: n.id,
          attribution: `Voice: ${r.voice}`,
          meta: { durationSec: r.durationSec, words: r.words, voice: r.voice }
        });
      }
      const total = this.d.repo.assets(c.id, 'narration').reduce((s, a) => s + Number(a.meta.durationSec), 0);
      this.audit({ type: 'narration.completed', productionId: c.id, data: { provider: n.id, voice: this.d.repo.assets(c.id, 'narration')[0]?.meta.voice, seconds: +total.toFixed(2), fallback: fallbackNote || undefined } });
      // Give the GPU back to the local LLM straight away (the next production's script needs it).
      stopKokoroGpuWorkers();
      c.progress(1, `${scenes.length} clips · ${total.toFixed(1)}s · ${n.label}${total > PRODUCTION_FORMATS[this.d.repo.get(c.id).format].maxSec + 2 ? ` · over ${PRODUCTION_FORMATS[this.d.repo.get(c.id).format].maxSec} s: shorten the script rather than speeding up the voice` : ''}${fallbackNote}`);
    },

    visuals: async (c) => {
      const p = this.d.repo.get(c.id);
      if (!p.storyboard || !p.brief) throw new Error('No storyboard. Re-run from Script.');
      if (!c.providers.visuals.length) throw new Error('No visual providers are enabled. Enable at least one in Studio → Providers.');
      fs.mkdirSync(path.join(c.dir, 'images'), { recursive: true });
      const existing = this.d.repo.assets(c.id, 'image');
      const used = new Set(existing.map((a) => String(a.meta.key ?? '')));
      const usedTitles = new Set(existing.map((a) => String(a.attribution.match(/^"([^"]+)"/)?.[1] ?? '')).filter(Boolean));
      const scenes = p.storyboard.scenes;
      const channelInfo = this.d.channel(p.channelId);
      const channelName = channelInfo.name;
      const contextTerms = [...(channelInfo.keywords ?? []), channelInfo.niche].filter(Boolean);
      // Real licensed photos first; an AI illustration (ComfyUI) only when no photo fits, and always labelled.
      const PHOTO = new Set(['wikimedia-commons', 'openverse']);
      let prev: VisualKind | null = null;
      for (const sc of scenes) {
        const have = existing.find((a) => a.sceneIndex === sc.index);
        if (have && fs.existsSync(path.join(c.dir, have.path))) {
          prev = (have.meta.visualKind as VisualKind | undefined) ?? null;
          continue;
        }
        c.progress(sc.index / scenes.length, `Finding a visual for scene ${sc.index + 1} of ${scenes.length}`);
        // Plan what the scene should show, then try the providers that fit that plan first.
        const plan = planScene(sc, p.brief, p.sources, channelName, prev);
        const photos = c.providers.visuals.filter((v) => PHOTO.has(v.id));
        const graphics = c.providers.visuals.filter((v) => v.id === 'graphics');
        const ai = c.providers.visuals.filter((v) => v.id === 'comfyui');
        const rest = c.providers.visuals.filter((v) => !PHOTO.has(v.id) && v.id !== 'graphics' && v.id !== 'comfyui');
        const order = plan.kind === 'photo' ? [...photos, ...ai, ...graphics, ...rest] : [...graphics, ...photos, ...ai, ...rest];
        const errors: string[] = [];
        let done = false;
        for (const v of order) {
          try {
            const r = await v.fetch(
              { scene: sc, brief: p.brief, sources: p.sources, sceneCount: scenes.length, outBase: path.join(c.dir, 'images', `scene-${pad2(sc.index)}`), usedKeys: used, usedTitles, contextTerms, plan, productionId: c.id, businessId: p.channelId, jobId: this.activeJob },
              c.signal
            );
            if (!r) {
              errors.push(`${v.label}: nothing suitable found`);
              continue;
            }
            c.cost(v.costPerUnitUsd);
            used.add(r.key);
            const t = r.attribution.match(/^"([^"]+)"/)?.[1];
            if (t) usedTitles.add(t);
            const visualKind: VisualKind | 'title-card' = v.id === 'graphics' ? plan.graphic.kind : PHOTO.has(v.id) ? 'photo' : 'title-card';
            const lic = r.meta?.licenseRecord as Record<string, unknown> | undefined;
            const evidenceHash = lic ? this.retain('licence-record', JSON.stringify({ key: r.key, ...lic }), r.sourceUrl) : undefined;
            const fileHash = createHash('sha256').update(fs.readFileSync(r.file)).digest('hex');
            this.audit({ type: 'asset.visual', productionId: c.id, subjectType: 'asset', subjectId: r.key, data: { scene: sc.index + 1, provider: v.id, key: r.key, visualKind, plan: plan.kind, planReason: plan.reason, relevance: r.meta?.relevance, sourceUrl: r.sourceUrl, license: r.license, attribution: r.attribution, sha256: fileHash, licenceEvidence: evidenceHash, aiGenerated: !!r.meta?.aiGenerated, generated: !!r.meta?.generated } });
            this.d.repo.addAsset(c.id, {
              kind: 'image',
              sceneIndex: sc.index,
              path: path.relative(c.dir, r.file).split(path.sep).join('/'),
              provider: v.id,
              sourceUrl: r.sourceUrl,
              license: r.license,
              attribution: r.attribution,
              meta: { ...r.meta, ...(Array.isArray(r.meta?.frames) ? { frames: (r.meta.frames as string[]).map((f) => path.relative(c.dir, f).split(path.sep).join('/')) } : {}), key: r.key, sha256: fileHash, visualKind, plan: plan.kind, planReason: plan.reason, ...(evidenceHash ? { evidenceHash } : {}) }
            });
            prev = visualKind === 'title-card' ? 'title' : visualKind;
            done = true;
            break;
          } catch (e) {
            if (e instanceof CancelledError || c.signal.aborted) throw new CancelledError();
            errors.push(`${v.label}: ${errMsg(e)}`);
          }
        }
        if (!done) {
          throw new Error(
            `No visual for scene ${sc.index + 1}. ${errors.join(' · ')}${c.settings.visuals.includes('title-card') ? '' : ' Tip: enable "Title cards" as a local fallback.'}`
          );
        }
      }
      const counts = new Map<string, number>();
      for (const a of this.d.repo.assets(c.id, 'image')) counts.set(String(a.meta.visualKind ?? a.provider), (counts.get(String(a.meta.visualKind ?? a.provider)) ?? 0) + 1);
      c.progress(1, [...counts].map(([k, v]) => `${k} ×${v}`).join(' · '));
    },

    captions: async (c) => {
      const p = this.d.repo.get(c.id);
      if (!p.storyboard) throw new Error('No storyboard. Re-run from Script.');
      const timeline = sceneTimeline(p.storyboard, this.d.repo.assets(c.id, 'narration'));
      const cues = buildCues(timeline);
      if (!cues.length) throw new Error('Narration has no word timings, so captions cannot be synchronised. Re-run Narration.');
      this.removeAssets(c.id, 'captions');
      // AI illustrations are always labelled on screen so they are never mistaken for photos or screenshots.
      const aiScenes = new Set(this.d.repo.assets(c.id, 'image').filter((a) => a.meta.aiGenerated).map((a) => a.sceneIndex));
      const labels = timeline.filter((_, i) => aiScenes.has(i)).map((t) => ({ start: t.offset, end: t.offset + t.duration, text: AI_GENERATED_LABEL }));
      fs.writeFileSync(path.join(c.dir, 'captions.ass'), buildAss(cues, labels), 'utf8');
      this.d.repo.addAsset(c.id, { kind: 'captions', sceneIndex: null, path: 'captions.ass', provider: 'omnicore', meta: { cues: cues.length } });
      c.progress(1, `${cues.length} caption cues`);
    },

    render: async (c) => {
      const p = this.d.repo.get(c.id);
      if (!p.storyboard || !p.brief) throw new Error('No storyboard. Re-run from Script.');
      const ffmpeg = this.d.ffmpeg(c.settings);
      const images = this.d.repo.assets(c.id, 'image');
      const licenceProblems = verifyVisualAssets(images, { allowShareAlike: c.settings.allowShareAlike });
      if (licenceProblems.length) throw new ProductionFailure('rights', 'visual-provenance', `Visual licence or provenance check failed, so this video cannot be rendered: ${licenceProblems.join(' ')}`);
      const timeline = sceneTimeline(p.storyboard, this.d.repo.assets(c.id, 'narration'));
      const plan: Omit<RenderPlan, 'audio'> & { audio?: RenderAudio } = {
        scenes: timeline.map((t, i) => {
          const img = images.find((a) => a.sceneIndex === i);
          if (!img) throw new Error(`Scene ${i + 1} has no visual. Re-run Visuals.`);
          return { image: img.path, audio: t.audio, durationSec: t.duration, audioDelaySec: t.leadSec, ...sceneMotion(images, i), ...(Array.isArray(img.meta.frames) && img.meta.frames.length > 1 ? { frames: img.meta.frames as string[] } : {}) };
        }),
        captions: 'captions.ass',
        output: 'render.tmp.mp4'
      };
      if (!fs.existsSync(path.join(c.dir, plan.captions))) throw new Error('Captions are missing. Re-run Captions.');
      // Captions are rebuilt from the same timeline as the audio, so they can never drift from a re-timed render.
      {
        const cuesNow = buildCues(timeline);
        const aiScenes = new Set(images.filter((a) => a.meta.aiGenerated).map((a) => a.sceneIndex));
        const labels = timeline.filter((_, i) => aiScenes.has(i)).map((t) => ({ start: t.offset, end: t.offset + t.duration, text: AI_GENERATED_LABEL }));
        fs.writeFileSync(path.join(c.dir, plan.captions), buildAss(cuesNow, labels), 'utf8');
      }
      this.removeAssets(c.id, 'music');
      this.removeAssets(c.id, 'sfx');
      // Every video carries approved music. No library, no selection or an inaudible track is a hard failure.
      if (!this.d.library) throw new ProductionFailure('audio', 'no-sound-library', 'No sound library is configured, so this video would have no music. Every video must carry approved music.');
      {
        const lib = this.d.library;
        const prod = this.d.repo.get(c.id);
        // Without a business profile (tests, tools), nothing is downloaded: discovery is a business choice.
        const profile = this.d.soundProfile ? { ...DEFAULT_SOUND_PROFILE, ...this.d.soundProfile(prod.channelId) } : { ...DEFAULT_SOUND_PROFILE, autoDiscover: false };
        // Music is mandatory for every production; a stored "off" no longer silences a video.
        profile.music = 'required';
        profile.introAccent = profile.transitions = profile.outroAccent = false; // no automatic effects
        const override = this.d.musicOverride?.(c.id) ?? (c.settings.musicMode === 'track' && c.settings.musicTrackId ? { mode: 'track' as const, trackId: c.settings.musicTrackId } : null);
        // Mood follows the story (subject first, then pace), within the business's preferred moods.
        const narr = this.d.repo.assets(c.id, 'narration');
        const words = p.storyboard.scenes.reduce((s, sc) => s + sc.narration.split(/\s+/).filter(Boolean).length, 0);
        const secs = narr.reduce((s, a) => s + Number(a.meta.durationSec ?? 0), 0);
        const mood = storyMood(p.storyboard, prod.mode, secs > 0 ? words / secs : 0, profile.preferredMoods);
        const platforms = [...new Set(prod.destinations.map((d) => d.platform))];
        const sel = await lib.select(c.settings, c.id, { mood, platforms, profile, override, recentTrackIds: this.d.recentMusic?.(prod.channelId, c.id) ?? [], signal: c.signal });
        for (const t of sel.discovered) this.audit({ type: 'audio.discovered', productionId: c.id, subjectType: 'audio', subjectId: String(t.id), data: { title: t.title, license: t.license, attribution: t.attribution, rights: t.rights } });
        if (sel.refused.length) this.audit({ type: 'audio.refused', productionId: c.id, data: { mood, refused: sel.refused } });
        const durations = plan.scenes.map((s) => s.durationSec);
        const effects = resolveEffects(lib, this.d.productionEffects?.(c.id) ?? [], durations.reduce((a, b) => a + b, 0));
        if (!sel.music) {
          this.audit({ type: 'audio.missing', productionId: c.id, data: { mood, override: override ?? null, refused: sel.refused } });
          throw new ProductionFailure('audio', 'missing-soundtrack', `No approved, phone-audible soundtrack is available${override?.mode === 'none' ? ' (music was switched off for this production)' : ''}. Every video must carry approved music; choose a track in Sound Library.${sel.refused.length ? ` Refused: ${sel.refused.slice(0, 3).join('; ')}` : ''}`);
        }
        this.audit({ type: 'audio.selected', productionId: c.id, data: { mood, platforms, override: override ?? null, music: sel.music ? { id: sel.music.id, title: sel.music.title, license: sel.music.license } : null, contextualEffects: effects.map((e) => ({ trackId: e.track.id, title: e.track.title, atSec: e.atSec, note: e.note })) } });
        for (const t of [sel.music, ...effects.map((e) => e.track)]) {
          if (!t) continue;
          this.d.repo.addAsset(c.id, {
            kind: t.kind === 'music' ? 'music' : 'sfx',
            sceneIndex: null,
            path: `library:${t.file}`,
            provider: 'sound-library',
            sourceUrl: t.sourceUrl,
            license: t.license,
            attribution: `${t.title}${t.attribution ? ` by ${t.attribution}` : ''}${t.license ? `, ${t.license}` : ''}`,
            meta: { trackId: t.id, role: t === sel.music ? 'music' : 'contextual', mood: t === sel.music ? mood : undefined, usage: t.usage, commercialUse: t.commercialUse, restrictions: t.restrictions, rights: t.rights, platforms, licenceEvidence: this.retain('audio-licence', JSON.stringify({ title: t.title, license: t.license, attribution: t.attribution, sourceUrl: t.sourceUrl, origin: t.origin, usage: t.usage, commercialUse: t.commercialUse, restrictions: t.restrictions, rights: t.rights, platforms })) }
          });
        }
        // ---- the mix: measured gains, deterministic ducking, stems for QA (audio/plan.ts) ------------------------
        const { audio, record } = await prepareMix({
          ffmpeg: this.d.ffmpeg(c.settings),
          dir: c.dir,
          scenes: timeline.map((t) => ({ audio: t.audio, durationSec: t.duration, speechSec: t.speechSec, leadSec: t.leadSec, words: t.clipWords })),
          music: { track: sel.music, file: lib.pathOf(sel.music), embeddable: embeddable(sel.music) },
          effects: effects.map((e) => ({ trackId: e.track.id, path: e.path, atSec: e.atSec })),
          profile: mixProfile(profile.mixProfile),
          signal: c.signal
        });
        plan.audio = audio;
        this.audit({ type: 'audio.mix', productionId: c.id, data: { profile: record.profile, track: record.music.title, musicGainDb: +audio.music.gainDb.toFixed(2), musicLufs: record.music.measuredLufs, narrationGainDb: record.narrationGainDb.map((g) => +g.toFixed(2)), phrases: record.speech.length, cues: record.cues.length } });
      }
      const total = totalDuration(plan as RenderPlan);
      const args = buildRenderArgs(plan as RenderPlan);
      c.progress(0, `Rendering ${total.toFixed(1)}s at ${VIDEO_W}×${VIDEO_H}`);
      const onProgress = (f: number) => c.progress(f * 0.97, `Rendering ${Math.round(f * 100)}%`);
      if (this.d.render) await this.d.render(args, c.dir, c.signal, onProgress, total);
      else await runFfmpeg(ffmpeg, args, { cwd: c.dir, signal: c.signal, totalSec: total, onProgress });

      const tmp = path.join(c.dir, plan.output);
      const info = await probe(ffmpeg, tmp);
      if (!info.video || info.video.width !== VIDEO_W || info.video.height !== VIDEO_H) {
        throw new Error(`Render produced ${info.video ? `${info.video.width}×${info.video.height}` : 'no video'}, expected ${VIDEO_W}×${VIDEO_H}.`);
      }
      if (!info.audio) throw new ProductionFailure('audio', 'encoding-failed', 'Render produced no audio track.');
      for (const f of Object.values(plan.audio!.stems)) if (!fs.existsSync(path.join(c.dir, f))) throw new ProductionFailure('audio', 'encoding-failed', `The render did not write the ${f} stem, so the mix cannot be verified.`);
      if (Math.abs(info.durationSec - total) > 1) throw new Error(`Render length ${info.durationSec.toFixed(1)}s does not match the plan (${total.toFixed(1)}s).`);

      this.removeAssets(c.id, 'video');
      this.removeAssets(c.id, 'credits');
      const finalRel = 'final.mp4';
      fs.renameSync(tmp, path.join(c.dir, finalRel));
      fs.writeFileSync(path.join(c.dir, 'credits.txt'), this.credits(c.id), 'utf8');
      this.d.repo.addAsset(c.id, { kind: 'video', sceneIndex: null, path: finalRel, provider: 'ffmpeg', meta: { ...info } });
      this.d.repo.addAsset(c.id, { kind: 'credits', sceneIndex: null, path: 'credits.txt', provider: 'omnicore' });
      this.d.repo.update(c.id, { outputPath: path.join(c.dir, finalRel), durationSec: info.durationSec });
      for (const a of this.d.repo.assets(c.id).filter((x) => x.kind === 'music' || x.kind === 'sfx')) {
        this.audit({ type: 'asset.audio', productionId: c.id, subjectType: 'asset', subjectId: a.path, data: { kind: a.kind, license: a.license, attribution: a.attribution, usage: a.meta.usage, commercialUse: a.meta.commercialUse, licenceEvidence: a.meta.licenceEvidence } });
      }
      this.audit({ type: 'render.output', productionId: c.id, data: { file: finalRel, sha256: createHash('sha256').update(fs.readFileSync(path.join(c.dir, finalRel))).digest('hex'), durationSec: info.durationSec, width: info.video?.width, height: info.video?.height } });
      c.progress(1, `${info.durationSec.toFixed(1)}s · ${info.video.width}×${info.video.height} · ${info.video.codec}/${info.audio.codec}`);
    },

    qa: async (c) => {
      const maxRounds = this.d.ops?.getAutonomy(this.d.repo.get(c.id).channelId).maxRepairRounds ?? 2;
      const done: string[] = [];
      const plan: Record<RepairAction, StepName[]> = {
        rescript: ['script', 'narration', 'visuals', 'captions', 'render'],
        shorten: ['brief', 'script', 'narration', 'visuals', 'captions', 'render'],
        lengthen: ['brief', 'script', 'narration', 'visuals', 'captions', 'render'],
        revisuals: ['visuals', 'captions', 'render'],
        recaptions: ['captions', 'render'],
        rerender: ['render'],
        metadata: []
      };
      for (let round = 1; ; round++) {
        this.refreshPublishing(c);
        c.progress(Math.min(0.9, round * 0.3), `QA round ${round}: inspecting…`);
        const p = this.d.repo.get(c.id);
        const results = await runQaChecks({ production: p, dir: c.dir, ffmpeg: this.d.ffmpeg(c.settings), allowShareAlike: c.settings.allowShareAlike, asr: this.d.asr, signal: c.signal, pronunciation: this.d.pronunciationCheck?.(p), musicRequired: this.musicRequired(p), soundRights: this.d.library ? (id) => this.d.library!.revalidate(id) : undefined });
        const sum = summarise(results);
        const repairs = [...new Set(results.filter((r) => !r.passed && r.repairAction && (r.severity === 'critical' || r.severity === 'major')).map((r) => r.repairAction!))];
        const canRepair = repairs.length > 0 && round <= maxRounds;
        const run = this.d.ops?.saveQaRun(c.id, round, sum.status, { critical: sum.critical, major: sum.major, minor: sum.minor, checks: results.length, repairs: canRepair ? repairs : [] }, results);
        const qaEvent = this.audit({ type: 'qa.run', productionId: c.id, data: { qaRunId: run?.id, renderSha256: run?.renderSha256, round, status: sum.status, critical: sum.critical, major: sum.major, minor: sum.minor, failed: results.filter((r) => !r.passed).map((r) => `${r.severity}:${r.checkId}`), repairs: canRepair ? repairs : [] } });
        if (run && qaEvent) this.d.ops?.linkQaAudit(run.id, qaEvent.id);
        // The mandatory audio gate: a failure stops the production here. It does not complete, never reaches review,
        // and cannot be approved or published. There is no automatic repair: the soundtrack or mix must be fixed.
        const audioGate = results.find((r) => r.checkId === AUDIO_GATE_ID);
        if (!audioGate?.passed) {
          const failedChecks = results.filter((r) => r.category === 'audio' && r.severity === 'critical' && !r.passed && r.checkId !== AUDIO_GATE_ID);
          this.d.repo.update(c.id, { approval: 'blocked' });
          this.audit({ type: 'audio.gate.failed', productionId: c.id, data: { qaRunId: run?.id, failed: failedChecks.map((r) => ({ check: r.checkId, message: r.message })) } });
          throw new ProductionFailure(
            'audio',
            'audio-gate',
            `Audio gate failed (${failedChecks.length || 1} check${failedChecks.length === 1 ? '' : 's'}): ${failedChecks.length ? failedChecks.map((r) => `${r.checkId}: ${r.message}`).join(' | ') : (audioGate?.message ?? 'the audio gate did not run')}`
          );
        }
        if (sum.status === 'passed' || !canRepair) {
          const approval = sum.status === 'blocked' ? 'blocked' : 'awaiting_review';
          this.d.repo.update(c.id, { approval });
          this.audit({ type: 'publishing.readiness', productionId: c.id, data: { approval, destinations: this.d.repo.get(c.id).destinations } });
          c.progress(1, `${sum.status === 'passed' ? 'Passed' : sum.status === 'blocked' ? 'BLOCKED (critical failures)' : 'Needs fixes before approval'} · ${results.length} checks · ${sum.critical} critical, ${sum.major} major, ${sum.minor} minor${done.length ? ` · repaired: ${done.join(', ')}` : ''}`);
          return;
        }
        // Automatic repair: the most upstream action covers the others.
        const order: RepairAction[] = ['shorten', 'lengthen', 'rescript', 'revisuals', 'recaptions', 'rerender', 'metadata'];
        const action = order.find((a) => repairs.includes(a))!;
        c.progress(Math.min(0.9, round * 0.3), `QA round ${round}: repairing (${action})…`);
        if (action === 'shorten') c.budgetScale *= 0.8;
        if (action === 'lengthen') c.budgetScale = Math.min(1.6, c.budgetScale * 1.2);
        for (const step of plan[action]) await this.rerunInline(c, step);
        done.push(action);
        this.audit({ type: 'qa.repair', productionId: c.id, data: { round, action, steps: plan[action] } });
      }
    }
  };

  /** Brand presenter (e.g. AI, Actually → Kokoro Heart) overrides the global narration settings for that brand's productions. */
  private brandSettings(channelId: number): ProviderSettings {
    const s = this.d.settings();
    if (!this.d.ops) return s;
    const pres = this.d.ops.brandPresenter(channelId);
    const b: ProviderSettings = pres.engine === 'sherpa' ? { ...s, narration: 'sherpa', sherpaVoice: pres.voice as KokoroVoiceId } : pres.engine === 'windows-sapi' ? { ...s, narration: 'windows-sapi', voice: pres.voice } : s;
    // Each business narrates with its own dictionary (plus shared entries), resolved for the engine actually speaking.
    return this.d.pronunciations ? { ...b, pronunciations: this.d.pronunciations(channelId, b.narration) } : b;
  }

  /** Whether this production must carry music (business profile; manual productions honour "no music" in settings). */
  /** Music is mandatory for every production (the audio gate fails without it). */
  private musicRequired(_p: Production): boolean {
    return true;
  }


  private audit(e: { type: string; productionId?: number; subjectType?: string; subjectId?: string; data?: Record<string, unknown> }): { id: number } | undefined {
    const businessId = e.productionId !== undefined ? (this.businessOf(e.productionId) ?? undefined) : undefined;
    return this.d.audit?.record({ actor: 'pipeline', businessId, ...e });
  }

  private retain(kind: string, content: string, url = ''): string | undefined {
    return this.d.audit?.retain(kind, content, url);
  }

  /** Re-run one step inside the current run (used by QA repairs). */
  private async rerunInline(c: Ctx, step: StepName): Promise<void> {
    for (const kind of STEP_ASSETS[step] ?? []) this.removeAssets(c.id, kind);
    this.d.repo.updateStep(c.id, step, { status: 'running', progress: 0, error: null, incrementAttempts: true, started: true });
    await this.steps[step]({ ...c, progress: (f, d) => this.d.repo.updateStep(c.id, step, { progress: f, ...(d !== undefined ? { detail: d } : {}) }) });
    this.d.repo.updateStep(c.id, step, { status: 'done', progress: 1, finished: true });
  }

  private refreshPublishing(c: Ctx): void {
    const p = this.d.repo.get(c.id);
    const destinations = this.d.ops ? (p.destinations.length ? this.d.ops.resolveDestinations(p.channelId, p.destinations.map((d) => ({ platform: d.platform, accountId: d.accountId }))) : this.d.ops.resolveDestinations(p.channelId)) : p.destinations;
    const credits = fs.existsSync(path.join(c.dir, 'credits.txt')) ? fs.readFileSync(path.join(c.dir, 'credits.txt'), 'utf8') : this.credits(c.id);
    const metadata: Record<string, PlatformMetadata> = {};
    for (const d of destinations) metadata[d.platform] = buildMetadata({ ...p, destinations }, d, credits, this.d.channel(p.channelId).name);
    this.d.repo.update(c.id, { destinations, metadata });
  }

  /** Description-ready credits: sources, image licences, voice. Required for CC-BY images. */
  credits(id: number): string {
    const p = this.d.repo.get(id);
    const lines = [p.storyboard?.title ?? p.topic, '', 'Sources:'];
    for (const s of p.sources) {
      const meta = [s.publisher, s.kind ? SOURCE_KIND_LABELS[s.kind] : '', s.authors?.length ? s.authors.slice(0, 3).join(', ') : '', s.publishedAt ? s.publishedAt.slice(0, 10) : '']
        .filter(Boolean)
        .join(' · ');
      lines.push(`- [${s.id}] ${s.title} (${meta})${s.url ? ` ${s.url}` : ''}${s.derivedFrom ? ` [repeats ${s.derivedFrom}]` : ''}`);
    }
    if (p.brief?.claims?.length) {
      lines.push('', 'Claims used:');
      for (const cl of p.brief.claims) lines.push(`- [${cl.id}] ${CLAIM_KIND_LABELS[cl.kind]}${cl.kind === 'confirmed' ? '' : ` (${cl.attribution})`} · sources ${cl.sourceIds.join(', ')} · ${cl.independentSources} independent`);
    }
    const imgs = p.assets.filter((a) => a.kind === 'image');
    if (imgs.length) {
      lines.push('', 'Visuals:');
      for (const a of imgs) {
        const lic = a.meta.licenseRecord as { license?: string; licenseUrl?: string } | undefined;
        lines.push(`- Scene ${(a.sceneIndex ?? 0) + 1}: ${a.attribution}${a.sourceUrl ? ` ${a.sourceUrl}` : ''}${lic?.licenseUrl ? ` (licence: ${lic.licenseUrl})` : ''}`);
      }
    }
    const sounds = p.assets.filter((a) => a.kind === 'music' || a.kind === 'sfx');
    if (sounds.length) {
      lines.push('', 'Music & sound:');
      for (const a of sounds) lines.push(`- ${a.kind === 'music' ? 'Music' : 'Sound effect'}: ${a.attribution}${a.sourceUrl ? ` ${a.sourceUrl}` : ''}`);
    }
    const voice = p.assets.find((a) => a.kind === 'narration');
    if (voice) lines.push('', `Narration: synthetic voice (${String(voice.meta.voice ?? voice.provider)})`);
    return `${lines.join('\n')}\n`;
  }
}
