import type { ProviderSettings, ProviderStatus } from '../../shared/production';
import { resolveFfmpeg } from '../media/ffmpeg';
import path from 'node:path';
import { adapterById, checkAdapter } from '../research/adapters';
import { RESEARCH_PROVIDERS } from '../../shared/production';
import { SapiNarration } from './narration';
import { SherpaKokoroNarration } from './sherpa';
import { PiperNarration } from './piper';
import type { NarrationProvider, Providers, VisualProvider } from './types';
import { CommonsVisuals, ComfyVisuals, GraphicsVisuals, OpenverseVisuals, TitleCardVisuals, type Rasterizer } from './visuals';
import { ExtractiveWriter, maxWordsForVoice, OpenAICompatibleWriter } from './writers';

const llmWriter = (s: ProviderSettings) =>
  new OpenAICompatibleWriter({ baseUrl: s.llmBaseUrl, model: s.llmModel, timeoutMs: s.llmTimeoutSec * 1000, maxWords: maxWordsForVoice(effectiveWordsPerSec(s)) });

/** Measured speed of the selected voice; until a sample is generated, the engine's speed from the 0.4 voice evaluation. */
export const effectiveWordsPerSec = (s: ProviderSettings): number =>
  s.voiceWordsPerSec || (s.narration === 'sherpa' ? 2.15 : s.narration === 'piper' ? 2.05 : 2.25);

export interface ProviderDirs {
  tmpDir: string;
  /** Draws generated graphics (Electron offscreen renderer); absent outside the app. */
  rasterize?: Rasterizer;
  /** Where in-app installed tools (Piper) live: <data dir>/tools. */
  toolsDir: string;
}

export const piperExePath = (s: ProviderSettings, dirs: ProviderDirs): string => s.piperPath || path.join(dirs.toolsDir, 'piper', 'piper.exe');

const kokoro = (s: ProviderSettings, dirs: ProviderDirs) =>
  new SherpaKokoroNarration(dirs.toolsDir, s.sherpaVoice, dirs.tmpDir, { speechRate: s.speechRate, pauseSec: s.sentencePauseSec, pronunciations: s.pronunciations });

export const narrator = (s: ProviderSettings, dirs: ProviderDirs): NarrationProvider =>
  s.narration === 'piper'
    ? new PiperNarration(piperExePath(s, dirs), s.piperVoice, dirs.tmpDir, s.speechRate)
    : s.narration === 'sherpa'
      ? kokoro(s, dirs)
      : new SapiNarration(dirs.tmpDir, s.voice, s.speechRate);

/** Build the provider set from the user's settings. */
export function buildProviders(s: ProviderSettings, dirs: ProviderDirs): Providers {
  const ffmpeg = () => resolveFfmpeg(s.ffmpegPath);
  const visualById: Record<string, () => VisualProvider> = {
    'wikimedia-commons': () => new CommonsVisuals({ allowShareAlike: s.allowShareAlike }),
    openverse: () => new OpenverseVisuals({ allowShareAlike: s.allowShareAlike }),
    graphics: () => new GraphicsVisuals(dirs.rasterize),
    comfyui: () => new ComfyVisuals(s.comfyUrl, s.comfyCheckpoint),
    'title-card': () => new TitleCardVisuals(ffmpeg)
  };
  return {
    research: s.researchProviders.map(adapterById),
    writer: s.writer === 'openai-compatible' ? llmWriter(s) : new ExtractiveWriter(),
    fallbackWriter: s.writer === 'openai-compatible' && s.writerFallback ? new ExtractiveWriter() : undefined,
    narration: narrator(s, dirs),
    fallbackNarration: s.narration === 'windows-sapi' ? undefined : new SapiNarration(dirs.tmpDir, s.voice, s.speechRate),
    visuals: s.visuals.map((id) => visualById[id]?.()).filter((v): v is VisualProvider => !!v)
  };
}

/** Health of every known provider (enabled or not), so the UI can explain what is missing. */
export async function checkProviders(s: ProviderSettings, dirs: ProviderDirs): Promise<ProviderStatus[]> {
  const { tmpDir } = dirs;
  const ffmpeg: ProviderStatus = (() => {
    try {
      return { id: 'ffmpeg', kind: 'render', label: 'FFmpeg', available: true, detail: resolveFfmpeg(s.ffmpegPath), costPerUnitUsd: 0 };
    } catch (e) {
      return { id: 'ffmpeg', kind: 'render', label: 'FFmpeg', available: false, detail: (e as Error).message, costPerUnitUsd: 0 };
    }
  })();
  const research = RESEARCH_PROVIDERS.map((r) => adapterById(r.id));
  const all = [
    new ExtractiveWriter(),
    llmWriter(s),
    new SapiNarration(tmpDir, s.voice, s.speechRate),
    new PiperNarration(piperExePath(s, dirs), s.piperVoice, tmpDir, s.speechRate),
    kokoro(s, dirs),
    new CommonsVisuals({ allowShareAlike: s.allowShareAlike }),
    new OpenverseVisuals({ allowShareAlike: s.allowShareAlike }),
    new GraphicsVisuals(dirs.rasterize),
    new ComfyVisuals(s.comfyUrl, s.comfyCheckpoint),
    new TitleCardVisuals(() => resolveFfmpeg(s.ffmpegPath))
  ];
  const [statuses, researchStatuses] = await Promise.all([
    Promise.all(all.map((p) => p.check(AbortSignal.timeout(15000)))),
    Promise.all(research.map((a) => checkAdapter(a, AbortSignal.timeout(12000))))
  ]);
  return [...researchStatuses, ...statuses, ffmpeg];
}
