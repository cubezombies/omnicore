import type { Brief, ProviderStatus, Scene, Source, Storyboard } from '../../shared/production';
import type { WordTiming } from '../media/captions';
import type { ResearchAdapter } from '../research/adapters';

/**
 * Provider contracts. Every external capability (research, writing, voice,
 * visuals) sits behind one of these so implementations can be swapped
 * without touching the pipeline.
 */
interface ProviderBase {
  id: string;
  label: string;
  /** Cost per unit (per request/character/image). All built-ins are free: 0. */
  costPerUnitUsd: number;
  check(signal?: AbortSignal): Promise<ProviderStatus>;
}

/** Thrown when a provider is not set up or reachable; message tells the user how to fix it. */
export class ProviderUnavailableError extends Error {}

export interface ResearchProvider extends ProviderBase {
  research(topic: string, signal: AbortSignal): Promise<Source[]>;
}

export interface WriterResult {
  storyboard: Storyboard;
  /** Billable units (e.g. tokens) for cost tracking. */
  units: number;
}

export interface Writer extends ProviderBase {
  write(input: { brief: Brief; sources: Source[]; channelName: string; instructions?: string }, signal: AbortSignal): Promise<WriterResult>;
}

export interface NarrationResult {
  durationSec: number;
  words: WordTiming[];
  voice: string;
}

export interface NarrationProvider extends ProviderBase {
  synthesize(text: string, outWav: string, signal: AbortSignal): Promise<NarrationResult>;
}

export interface VisualRequest {
  scene: Scene;
  brief: Brief;
  /** Research sources (lets providers use images from the cited articles). */
  sources: Source[];
  sceneCount: number;
  /** Output path without extension; the provider appends .png/.jpg. */
  outBase: string;
  /** Keys of assets already used in this production (avoid repeats). */
  usedKeys: Set<string>;
  /** Titles of images already used (to avoid near-duplicates from one photo series). */
  usedTitles?: Set<string>;
  /** The business's own topic keywords, used to disambiguate image matches (never sent anywhere). */
  contextTerms?: string[];
  /** Scene visual plan (0.6.1+): what this scene should show and why. */
  plan?: import('../media/visualPlan').VisualPlan;
  /** The production, business and job this visual is for (generated assets are tied to them). */
  productionId?: number;
  businessId?: number;
  jobId?: number | null;
}

export interface VisualResult {
  file: string;
  key: string;
  sourceUrl: string;
  license: string;
  attribution: string;
  meta?: Record<string, unknown>;
}

export interface VisualProvider extends ProviderBase {
  /** Returns null when nothing suitable was found (the pipeline tries the next provider). */
  fetch(req: VisualRequest, signal: AbortSignal): Promise<VisualResult | null>;
}

export interface Providers {
  research: ResearchAdapter[];
  writer: Writer;
  /** Used when the primary writer is unreachable or its output fails validation. */
  fallbackWriter?: Writer;
  narration: NarrationProvider;
  /** Used for the whole narration step when the chosen narrator is not installed/available. */
  fallbackNarration?: NarrationProvider;
  visuals: VisualProvider[];
}
