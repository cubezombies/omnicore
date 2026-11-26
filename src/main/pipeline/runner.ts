import fs from 'node:fs';
import path from 'node:path';
import {
  PRODUCTION_STEPS,
  STEP_LABELS,
  type AssetKind,
  type ProductionAsset,
  type ProviderSettings,
  type Source,
  type StepName,
  type Storyboard
} from '../../shared/production';
import type { ProductionRepository } from '../db/productions';
import { buildAss, buildCues, type SceneTiming, type WordTiming } from '../media/captions';
import { CancelledError, probe, runFfmpeg } from '../media/ffmpeg';
import { buildRenderArgs, frameAlign, SCENE_PAD_SEC, totalDuration, VIDEO_H, VIDEO_W, type RenderPlan } from '../media/render';
import { notesSource } from '../providers/research';
import { buildBrief } from '../providers/text';
import type { Providers } from '../providers/types';

export interface RunnerDeps {
  repo: ProductionRepository;
  productionsDir: string;
  settings: () => ProviderSettings;
  providers: (s: ProviderSettings) => Providers;
  ffmpeg: (s: ProviderSettings) => string;
  channel: (channelId: number) => { name: string; niche: string };
  emit: (productionId: number) => void;
  /** Called after the script step (e.g. to copy the script into the linked content item). */
  onScript?: (productionId: number, storyboard: Storyboard) => void;
  /** Test seam: replaces the FFmpeg render call. */
  render?: (args: string[], cwd: string, signal: AbortSignal, onProgress: (f: number) => void, totalSec: number) => Promise<void>;
}

const STEP_ASSETS: Partial<Record<StepName, AssetKind[]>> = {
  narration: ['narration'],
  visuals: ['image'],
  captions: ['captions'],
  render: ['video', 'credits']
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
    for (const a of this.d.repo.deleteAssets(id, kind)) fs.rmSync(path.join(dir, a.path), { force: true });
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
      const settings = this.d.settings();
      const providers = this.d.providers(settings);
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
          cost: (usd) => usd && repo.updateStep(id, step, { addCostUsd: usd })
        };
        await this.steps[step](ctx);
        if (ctrl.signal.aborted) throw new CancelledError();
        repo.updateStep(id, step, { status: 'done', progress: 1, finished: true });
        this.emitThrottled(id, true);
      }
      repo.update(id, { status: 'completed', currentStep: null });
    } catch (e) {
      const cancelled = e instanceof CancelledError || ctrl.signal.aborted;
      const msg = cancelled ? 'Cancelled.' : errMsg(e);
      if (current) repo.updateStep(id, current, { status: 'failed', error: msg, finished: true });
      repo.update(id, {
        status: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? 'Cancelled. Retry to resume.' : `${current ? STEP_LABELS[current] : 'Setup'}: ${msg}`
      });
    } finally {
      this.active = null;
      this.d.emit(id);
    }
  }

  // ---- steps --------------------------------------------------------------
  private steps: Record<StepName, (c: Ctx) => Promise<void>> = {
    research: async (c) => {
      const p = this.d.repo.get(c.id);
      const sources: Source[] = [];
      const notes = notesSource(this.d.repo.userNotes(c.id));
      if (notes) sources.push(notes);
      const errors: string[] = [];
      for (const r of c.providers.research) {
        c.progress(0.2, `Searching ${r.label}…`);
        try {
          sources.push(...(await r.research(p.topic, c.signal)));
          c.cost(r.costPerUnitUsd);
        } catch (e) {
          if (e instanceof CancelledError) throw e;
          errors.push(`${r.label}: ${errMsg(e)}`);
        }
      }
      if (!sources.length) {
        if (!c.providers.research.length) {
          throw new Error('No research sources: Wikipedia research is turned off and this production has no research notes. Enable Wikipedia in Studio → Providers or start the production from a content item with research notes.');
        }
        throw new Error(
          `No usable sources found for "${p.topic}". ${errors.length ? errors.join(' ') : 'Try a more specific or differently worded topic.'}`
        );
      }
      this.d.repo.update(c.id, { sources });
      c.progress(1, `${sources.length} source${sources.length === 1 ? '' : 's'}: ${sources.map((s) => s.publisher).join(', ')}`);
    },

    brief: async (c) => {
      const p = this.d.repo.get(c.id);
      const brief = buildBrief(p.topic, p.sources, this.d.channel(p.channelId).niche);
      this.d.repo.update(c.id, { brief });
      c.progress(1, `${brief.keyFacts.length} sourced facts · ~${brief.targetSeconds}s`);
    },

    script: async (c) => {
      const p = this.d.repo.get(c.id);
      if (!p.brief) throw new Error('No brief. Re-run from Brief.');
      c.progress(0.1, `Writing with ${c.providers.writer.label}…`);
      const { storyboard, units } = await c.providers.writer.write(
        { brief: p.brief, sources: p.sources, channelName: this.d.channel(p.channelId).name },
        c.signal
      );
      c.cost(units * c.providers.writer.costPerUnitUsd);
      this.d.repo.update(c.id, { storyboard });
      this.d.onScript?.(c.id, storyboard);
      c.progress(1, `${storyboard.scenes.length} scenes · ${storyboard.writer}`);
    },

    narration: async (c) => {
      const p = this.d.repo.get(c.id);
      if (!p.storyboard) throw new Error('No storyboard. Re-run from Script.');
      const n = c.providers.narration;
      fs.mkdirSync(path.join(c.dir, 'audio'), { recursive: true });
      const existing = this.d.repo.assets(c.id, 'narration');
      const scenes = p.storyboard.scenes;
      for (const sc of scenes) {
        const have = existing.find((a) => a.sceneIndex === sc.index);
        if (have && fs.existsSync(path.join(c.dir, have.path))) continue;
        c.progress(sc.index / scenes.length, `Voicing scene ${sc.index + 1} of ${scenes.length}`);
        const rel = `audio/scene-${pad2(sc.index)}.wav`;
        const r = await n.synthesize(sc.narration, path.join(c.dir, rel), c.signal);
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
      c.progress(1, `${scenes.length} clips · ${total.toFixed(1)}s · ${n.label}`);
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
            this.d.repo.addAsset(c.id, {
              kind: 'image',
              sceneIndex: sc.index,
              path: path.relative(c.dir, r.file).split(path.sep).join('/'),
              provider: v.id,
              sourceUrl: r.sourceUrl,
              license: r.license,
              attribution: r.attribution,
              meta: { ...r.meta, key: r.key }
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
      fs.writeFileSync(path.join(c.dir, 'captions.ass'), buildAss(cues), 'utf8');
      this.d.repo.addAsset(c.id, { kind: 'captions', sceneIndex: null, path: 'captions.ass', provider: 'omnicore', meta: { cues: cues.length } });
      c.progress(1, `${cues.length} caption cues`);
    },

    render: async (c) => {
      const p = this.d.repo.get(c.id);
      if (!p.storyboard || !p.brief) throw new Error('No storyboard. Re-run from Script.');
      const ffmpeg = this.d.ffmpeg(c.settings);
      const images = this.d.repo.assets(c.id, 'image');
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
      const music = c.settings.musicPath.trim();
      if (music) {
        if (!fs.existsSync(music)) throw new Error(`Background music file not found: ${music}. Fix or clear it in Studio → Providers.`);
        plan.music = { path: music, volume: c.settings.musicVolume };
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
      c.progress(1, `${info.durationSec.toFixed(1)}s · ${info.video.width}×${info.video.height} · ${info.video.codec}/${info.audio.codec}`);
    }
  };

  /** Description-ready credits: sources, image licences, voice. Required for CC-BY images. */
  credits(id: number): string {
    const p = this.d.repo.get(id);
    const lines = [p.storyboard?.title ?? p.topic, '', 'Sources:'];
    for (const s of p.sources) lines.push(`- ${s.title} (${s.publisher})${s.url ? ` ${s.url}` : ''}`);
    const imgs = p.assets.filter((a) => a.kind === 'image');
    if (imgs.length) {
      lines.push('', 'Visuals:');
      for (const a of imgs) lines.push(`- Scene ${(a.sceneIndex ?? 0) + 1}: ${a.attribution}${a.sourceUrl ? ` ${a.sourceUrl}` : ''}`);
    }
    const voice = p.assets.find((a) => a.kind === 'narration');
    if (voice) lines.push('', `Narration: synthetic voice (${String(voice.meta.voice ?? voice.provider)})`);
    return `${lines.join('\n')}\n`;
  }
}
