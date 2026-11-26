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
import { buildAss, buildCues, type SceneTiming, type WordTiming } from '../media/captions';
import { CancelledError, probe, runFfmpeg } from '../media/ffmpeg';
import { buildRenderArgs, frameAlign, SCENE_PAD_SEC, totalDuration, transitionTimes, VIDEO_H, VIDEO_W, type RenderPlan } from '../media/render';
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
import { maxWordsForVoice } from '../providers/writers';
import type { PlatformMetadata } from '../../shared/operations';
import type { KokoroVoiceId } from '../../shared/production';
import { runResearch, type EngineOptions } from '../research/engine';
import type { RawSource } from '../research/dedupe';
import { CLAIM_KIND_LABELS, SOURCE_KIND_LABELS } from '../../shared/production';

export interface RunnerDeps {
  repo: ProductionRepository;
  productionsDir: string;
  settings: () => ProviderSettings;
  providers: (s: ProviderSettings) => Providers;
  ffmpeg: (s: ProviderSettings) => string;
  channel: (channelId: number) => { name: string; niche: string };
  emit: (productionId: number) => void;
  /** Music & Sound Library (optional: without it, renders have narration only). */
  library?: SoundLibrary;
  /** Called after the script step (e.g. to copy the script into the linked content item). */
  onScript?: (productionId: number, storyboard: Storyboard) => void;
  /** 0.5: brands/destinations, audit ledger, independent speech recognition for QA. */
  ops?: OperationsRepository;
  audit?: AuditLedger;
  asr?: Transcriber;
  /** Test seam for research article fetching. */
  fetchPage?: EngineOptions['fetchPage'];
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
export function sceneTimeline(storyboard: Storyboard, narration: ProductionAsset[]): (SceneTiming & { audio: string })[] {
  let offset = 0;
  return storyboard.scenes.map((sc) => {
    const a = narration.find((n) => n.sceneIndex === sc.index);
    if (!a) throw new Error(`Scene ${sc.index + 1} has no narration. Re-run the narration step.`);
    const dur = Number(a.meta.durationSec);
    const duration = frameAlign(dur + SCENE_PAD_SEC);
    const t = { offset, duration, words: (a.meta.words as WordTiming[]) ?? [], audio: a.path };
    offset += duration;
    return t;
  });
}

export class ProductionRunner {
  private active: { id: number; ctrl: AbortController } | null = null;
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
  enqueue(id: number): void {
    this.d.repo.update(id, { status: 'queued', error: null });
    this.d.emit(id);
    void this.kick();
  }

  /** Resume a failed/cancelled production from its first unfinished step. */
  retry(id: number): void {
    const p = this.d.repo.get(id);
    if (p.status === 'running' || p.status === 'queued') throw new Error('This production is already running or queued.');
    for (const s of p.steps) if (s.status !== 'done') this.d.repo.resetStep(id, s.step);
    this.enqueue(id);
  }

  /** Re-run from a given step, discarding that step's and all later outputs. */
  rerun(id: number, from: StepName): void {
    const p = this.d.repo.get(id);
    if (p.status === 'running' || p.status === 'queued') throw new Error('This production is already running or queued.');
    const startIdx = PRODUCTION_STEPS.indexOf(from);
    for (const step of PRODUCTION_STEPS.slice(startIdx)) {
      this.d.repo.resetStep(id, step);
      for (const kind of STEP_ASSETS[step] ?? []) this.removeAssets(id, kind);
    }
    if (startIdx <= PRODUCTION_STEPS.indexOf('research')) this.d.repo.update(id, { sources: [] });
    if (startIdx <= PRODUCTION_STEPS.indexOf('brief')) this.d.repo.update(id, { brief: null });
    if (startIdx <= PRODUCTION_STEPS.indexOf('script')) this.d.repo.update(id, { storyboard: null });
    this.d.repo.update(id, { outputPath: null, durationSec: null });
    this.enqueue(id);
  }

  cancel(id: number): void {
    if (this.active?.id === id) {
      this.active.ctrl.abort();
      return;
    }
    const p = this.d.repo.get(id);
    if (p.status === 'queued') {
      this.d.repo.update(id, { status: 'cancelled', error: 'Cancelled before it started.' });
      this.d.emit(id);
    }
  }

  delete(id: number): void {
    this.cancel(id);
    this.d.repo.delete(id);
    const dir = this.dirFor(id);
    if (path.dirname(dir) === path.resolve(this.d.productionsDir)) fs.rmSync(dir, { recursive: true, force: true });
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
    repo.update(id, { status: 'running', error: null });
    this.d.emit(id);
    let current: StepName | null = null;
    try {
      const settings = this.brandSettings(repo.get(id).channelId);
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
            this.emitThrottled(id);
          },
          cost: (usd) => usd && repo.updateStep(id, step, { addCostUsd: usd }),
          budgetScale: 1
        };
        await this.steps[step](ctx);
        if (ctrl.signal.aborted) throw new CancelledError();
        repo.updateStep(id, step, { status: 'done', progress: 1, finished: true });
        this.emitThrottled(id, true);
      }
      repo.update(id, { status: 'completed', currentStep: null });
      this.audit({ type: 'production.completed', productionId: id, data: { approval: repo.get(id).approval } });
    } catch (e) {
      const cancelled = e instanceof CancelledError || ctrl.signal.aborted;
      const msg = cancelled ? 'Cancelled.' : errMsg(e);
      if (current) repo.updateStep(id, current, { status: 'failed', error: msg, finished: true });
      repo.update(id, {
        status: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? 'Cancelled. Retry to resume.' : `${current ? STEP_LABELS[current] : 'Setup'}: ${msg}`
      });
      this.audit({ type: cancelled ? 'production.cancelled' : 'production.failed', productionId: id, data: { step: current, error: msg } });
    } finally {
      this.active = null;
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
        throw new Error(
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
      const maxWords = Math.round(maxWordsForVoice(effectiveWordsPerSec(c.settings)) * c.budgetScale);
      const brief = buildEvidenceBrief(p.topic, p.sources, this.d.channel(p.channelId).niche, p.mode, maxWords);
      this.d.repo.update(c.id, { brief });
      this.audit({ type: 'evidence.claims', productionId: c.id, data: { maxWords, claims: (brief.claims ?? []).map((cl) => ({ id: cl.id, kind: cl.kind, sources: cl.sourceIds, independent: cl.independentSources, attribution: cl.attribution })) } });
      const kinds = new Map<string, number>();
      for (const cl of brief.claims ?? []) kinds.set(CLAIM_KIND_LABELS[cl.kind], (kinds.get(CLAIM_KIND_LABELS[cl.kind]) ?? 0) + 1);
      c.progress(1, `${brief.claims?.length ?? 0} evidence claims (${[...kinds].map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ')}) · ~${brief.targetSeconds}s`);
    },

    script: async (c) => {
      const p = this.d.repo.get(c.id);
      if (!p.brief) throw new Error('No brief. Re-run from Brief.');
      const input = { brief: p.brief, sources: p.sources, channelName: this.d.channel(p.channelId).name };
      const primary = c.providers.writer;
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
      c.progress(1, `${scenes.length} clips · ${total.toFixed(1)}s · ${n.label}${total > 62 ? ' · over 60 s: shorten the script rather than speeding up the voice' : ''}${fallbackNote}`);
    },

    visuals: async (c) => {
      const p = this.d.repo.get(c.id);
      if (!p.storyboard || !p.brief) throw new Error('No storyboard. Re-run from Script.');
      if (!c.providers.visuals.length) throw new Error('No visual providers are enabled. Enable at least one in Studio → Providers.');
      fs.mkdirSync(path.join(c.dir, 'images'), { recursive: true });
      const existing = this.d.repo.assets(c.id, 'image');
      const used = new Set(existing.map((a) => String(a.meta.key ?? '')));
      const scenes = p.storyboard.scenes;
      for (const sc of scenes) {
        const have = existing.find((a) => a.sceneIndex === sc.index);
        if (have && fs.existsSync(path.join(c.dir, have.path))) continue;
        c.progress(sc.index / scenes.length, `Finding a visual for scene ${sc.index + 1} of ${scenes.length}`);
        const errors: string[] = [];
        let done = false;
        for (const v of c.providers.visuals) {
          try {
            const r = await v.fetch(
              { scene: sc, brief: p.brief, sources: p.sources, sceneCount: scenes.length, outBase: path.join(c.dir, 'images', `scene-${pad2(sc.index)}`), usedKeys: used },
              c.signal
            );
            if (!r) {
              errors.push(`${v.label}: nothing suitable found`);
              continue;
            }
            c.cost(v.costPerUnitUsd);
            used.add(r.key);
            const lic = r.meta?.licenseRecord as Record<string, unknown> | undefined;
            const evidenceHash = lic ? this.retain('licence-record', JSON.stringify({ key: r.key, ...lic }), r.sourceUrl) : undefined;
            const fileHash = createHash('sha256').update(fs.readFileSync(r.file)).digest('hex');
            this.audit({ type: 'asset.visual', productionId: c.id, subjectType: 'asset', subjectId: r.key, data: { scene: sc.index + 1, provider: v.id, key: r.key, sourceUrl: r.sourceUrl, license: r.license, attribution: r.attribution, sha256: fileHash, licenceEvidence: evidenceHash, aiGenerated: !!r.meta?.aiGenerated } });
            this.d.repo.addAsset(c.id, {
              kind: 'image',
              sceneIndex: sc.index,
              path: path.relative(c.dir, r.file).split(path.sep).join('/'),
              provider: v.id,
              sourceUrl: r.sourceUrl,
              license: r.license,
              attribution: r.attribution,
              meta: { ...r.meta, key: r.key, sha256: fileHash, ...(evidenceHash ? { evidenceHash } : {}) }
            });
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
      for (const a of this.d.repo.assets(c.id, 'image')) counts.set(a.provider, (counts.get(a.provider) ?? 0) + 1);
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
      if (licenceProblems.length) throw new Error(`Visual licence check failed, so this video cannot be rendered: ${licenceProblems.join(' ')}`);
      const timeline = sceneTimeline(p.storyboard, this.d.repo.assets(c.id, 'narration'));
      const plan: RenderPlan = {
        scenes: timeline.map((t, i) => {
          const img = images.find((a) => a.sceneIndex === i);
          if (!img) throw new Error(`Scene ${i + 1} has no visual. Re-run Visuals.`);
          return { image: img.path, audio: t.audio, durationSec: t.duration };
        }),
        captions: 'captions.ass',
        output: 'render.tmp.mp4'
      };
      if (!fs.existsSync(path.join(c.dir, plan.captions))) throw new Error('Captions are missing. Re-run Captions.');
      this.removeAssets(c.id, 'music');
      this.removeAssets(c.id, 'sfx');
      if (this.d.library && (c.settings.musicMode !== 'none' || c.settings.sfxTransitions)) {
        const lib = this.d.library;
        const { music, sfx } = await lib.pick(c.settings, c.id, c.signal, this.d.repo.get(c.id).mode === 'news' ? 'upbeat' : 'calm');
        if (music) plan.music = { path: lib.pathOf(music), volume: c.settings.musicVolume };
        if (sfx) plan.sfx = { path: lib.pathOf(sfx), volume: c.settings.sfxVolume, atSec: transitionTimes(plan) };
        for (const t of [music, sfx]) {
          if (!t) continue;
          this.d.repo.addAsset(c.id, {
            kind: t.kind === 'music' ? 'music' : 'sfx',
            sceneIndex: null,
            path: `library:${t.file}`,
            provider: 'sound-library',
            sourceUrl: t.sourceUrl,
            license: t.license,
            attribution: `${t.title}${t.attribution ? ` by ${t.attribution}` : ''}${t.license ? `, ${t.license}` : ''}`,
            meta: { trackId: t.id, usage: t.usage, commercialUse: t.commercialUse, licenceEvidence: this.retain('audio-licence', JSON.stringify({ title: t.title, license: t.license, attribution: t.attribution, sourceUrl: t.sourceUrl, origin: t.origin, usage: t.usage, commercialUse: t.commercialUse, restrictions: t.restrictions })) }
          });
        }
      }
      const total = totalDuration(plan);
      const args = buildRenderArgs(plan);
      c.progress(0, `Rendering ${total.toFixed(1)}s at ${VIDEO_W}×${VIDEO_H}`);
      const onProgress = (f: number) => c.progress(f * 0.97, `Rendering ${Math.round(f * 100)}%`);
      if (this.d.render) await this.d.render(args, c.dir, c.signal, onProgress, total);
      else await runFfmpeg(ffmpeg, args, { cwd: c.dir, signal: c.signal, totalSec: total, onProgress });

      const tmp = path.join(c.dir, plan.output);
      const info = await probe(ffmpeg, tmp);
      if (!info.video || info.video.width !== VIDEO_W || info.video.height !== VIDEO_H) {
        throw new Error(`Render produced ${info.video ? `${info.video.width}×${info.video.height}` : 'no video'}, expected ${VIDEO_W}×${VIDEO_H}.`);
      }
      if (!info.audio) throw new Error('Render produced no audio track.');
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
      const maxRounds = this.d.ops?.getAutonomy().maxRepairRounds ?? 2;
      const done: string[] = [];
      const plan: Record<RepairAction, StepName[]> = {
        rescript: ['script', 'narration', 'visuals', 'captions', 'render'],
        shorten: ['brief', 'script', 'narration', 'visuals', 'captions', 'render'],
        revisuals: ['visuals', 'captions', 'render'],
        recaptions: ['captions', 'render'],
        rerender: ['render'],
        metadata: []
      };
      for (let round = 1; ; round++) {
        this.refreshPublishing(c);
        c.progress(Math.min(0.9, round * 0.3), `QA round ${round}: inspecting…`);
        const p = this.d.repo.get(c.id);
        const results = await runQaChecks({ production: p, dir: c.dir, ffmpeg: this.d.ffmpeg(c.settings), allowShareAlike: c.settings.allowShareAlike, asr: this.d.asr, signal: c.signal });
        const sum = summarise(results);
        const repairs = [...new Set(results.filter((r) => !r.passed && r.repairAction && (r.severity === 'critical' || r.severity === 'major')).map((r) => r.repairAction!))];
        const canRepair = repairs.length > 0 && round <= maxRounds;
        this.d.ops?.saveQaRun(c.id, round, sum.status, { critical: sum.critical, major: sum.major, minor: sum.minor, checks: results.length, repairs: canRepair ? repairs : [] }, results);
        this.audit({ type: 'qa.run', productionId: c.id, data: { round, status: sum.status, critical: sum.critical, major: sum.major, minor: sum.minor, failed: results.filter((r) => !r.passed).map((r) => `${r.severity}:${r.checkId}`), repairs: canRepair ? repairs : [] } });
        if (sum.status === 'passed' || !canRepair) {
          const approval = sum.status === 'blocked' ? 'blocked' : 'awaiting_review';
          this.d.repo.update(c.id, { approval });
          this.audit({ type: 'publishing.readiness', productionId: c.id, data: { approval, destinations: this.d.repo.get(c.id).destinations } });
          c.progress(1, `${sum.status === 'passed' ? 'Passed' : sum.status === 'blocked' ? 'BLOCKED (critical failures)' : 'Issues need review'} · ${results.length} checks · ${sum.critical} critical, ${sum.major} major, ${sum.minor} minor${done.length ? ` · repaired: ${done.join(', ')}` : ''}`);
          return;
        }
        // Automatic repair: the most upstream action covers the others.
        const order: RepairAction[] = ['shorten', 'rescript', 'revisuals', 'recaptions', 'rerender', 'metadata'];
        const action = order.find((a) => repairs.includes(a))!;
        c.progress(Math.min(0.9, round * 0.3), `QA round ${round}: repairing (${action})…`);
        if (action === 'shorten') c.budgetScale *= 0.8;
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
    if (pres.engine === 'sherpa') return { ...s, narration: 'sherpa', sherpaVoice: pres.voice as KokoroVoiceId };
    if (pres.engine === 'windows-sapi') return { ...s, narration: 'windows-sapi', voice: pres.voice };
    return s;
  }

  private audit(e: { type: string; productionId?: number; subjectType?: string; subjectId?: string; data?: Record<string, unknown> }): void {
    this.d.audit?.record({ actor: 'pipeline', ...e });
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
