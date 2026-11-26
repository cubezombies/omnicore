import type { ProviderSettings, ProviderStatus } from '../../shared/production';
import { resolveFfmpeg } from '../media/ffmpeg';
import path from 'node:path';
import { SapiNarration } from './narration';
import { PiperNarration } from './piper';
import { WikipediaResearch } from './research';
import type { NarrationProvider, Providers, VisualProvider } from './types';
import { CommonsVisuals, ComfyVisuals, TitleCardVisuals } from './visuals';
import { ExtractiveWriter, OpenAICompatibleWriter } from './writers';

const llmWriter = (s: ProviderSettings) =>
  new OpenAICompatibleWriter({ baseUrl: s.llmBaseUrl, model: s.llmModel, timeoutMs: s.llmTimeoutSec * 1000 });

export interface ProviderDirs {
  tmpDir: string;
  /** Where in-app installed tools (Piper) live: <data dir>/tools. */
  toolsDir: string;
}

export const piperExePath = (s: ProviderSettings, dirs: ProviderDirs): string => s.piperPath || path.join(dirs.toolsDir, 'piper', 'piper.exe');

const narrator = (s: ProviderSettings, dirs: ProviderDirs): NarrationProvider =>
  s.narration === 'piper' ? new PiperNarration(piperExePath(s, dirs), s.piperVoice, dirs.tmpDir, s.speechRate) : new SapiNarration(dirs.tmpDir, s.voice, s.speechRate);

/** Build the provider set from the user's settings. */
export function buildProviders(s: ProviderSettings, dirs: ProviderDirs): Providers {
  const ffmpeg = () => resolveFfmpeg(s.ffmpegPath);
  const visualById: Record<string, () => VisualProvider> = {
    'wikimedia-commons': () => new CommonsVisuals(),
    comfyui: () => new ComfyVisuals(s.comfyUrl, s.comfyCheckpoint),
    'title-card': () => new TitleCardVisuals(ffmpeg)
  };
  return {
    research: s.wikipediaResearch ? [new WikipediaResearch()] : [],
    writer: s.writer === 'openai-compatible' ? llmWriter(s) : new ExtractiveWriter(),
    fallbackWriter: s.writer === 'openai-compatible' && s.writerFallback ? new ExtractiveWriter() : undefined,
    narration: narrator(s, dirs),
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
  const all = [
    new WikipediaResearch(),
    new ExtractiveWriter(),
    llmWriter(s),
    new SapiNarration(tmpDir, s.voice, s.speechRate),
    new PiperNarration(piperExePath(s, dirs), s.piperVoice, tmpDir, s.speechRate),
    new CommonsVisuals(),
    new ComfyVisuals(s.comfyUrl, s.comfyCheckpoint),
    new TitleCardVisuals(() => resolveFfmpeg(s.ffmpegPath))
  ];
  const statuses = await Promise.all(all.map((p) => p.check(AbortSignal.timeout(15000))));
  return [...statuses, ffmpeg];
}
