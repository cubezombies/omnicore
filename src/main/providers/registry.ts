import type { ProviderSettings, ProviderStatus } from '../../shared/production';
import { resolveFfmpeg } from '../media/ffmpeg';
import { SapiNarration } from './narration';
import { WikipediaResearch } from './research';
import type { Providers, VisualProvider } from './types';
import { CommonsVisuals, ComfyVisuals, TitleCardVisuals } from './visuals';
import { ExtractiveWriter, OpenAICompatibleWriter } from './writers';

/** Build the provider set from the user's settings. */
export function buildProviders(s: ProviderSettings, tmpDir: string): Providers {
  const ffmpeg = () => resolveFfmpeg(s.ffmpegPath);
  const visualById: Record<string, () => VisualProvider> = {
    'wikimedia-commons': () => new CommonsVisuals(),
    comfyui: () => new ComfyVisuals(s.comfyUrl, s.comfyCheckpoint),
    'title-card': () => new TitleCardVisuals(ffmpeg)
  };
  return {
    research: s.wikipediaResearch ? [new WikipediaResearch()] : [],
    writer: s.writer === 'openai-compatible' ? new OpenAICompatibleWriter(s.llmBaseUrl, s.llmModel) : new ExtractiveWriter(),
    narration: new SapiNarration(tmpDir, s.voice, s.speechRate),
    visuals: s.visuals.map((id) => visualById[id]?.()).filter((v): v is VisualProvider => !!v)
  };
}

/** Health of every known provider (enabled or not), so the UI can explain what is missing. */
export async function checkProviders(s: ProviderSettings, tmpDir: string): Promise<ProviderStatus[]> {
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
    new OpenAICompatibleWriter(s.llmBaseUrl, s.llmModel),
    new SapiNarration(tmpDir, s.voice, s.speechRate),
    new CommonsVisuals(),
    new ComfyVisuals(s.comfyUrl, s.comfyCheckpoint),
    new TitleCardVisuals(() => resolveFfmpeg(s.ffmpegPath))
  ];
  const statuses = await Promise.all(all.map((p) => p.check(AbortSignal.timeout(15000))));
  return [...statuses, ffmpeg];
}
