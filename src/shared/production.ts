// Video Factory: shared types for productions (topic → finished 9:16 MP4).

export const PRODUCTION_STEPS = ['research', 'brief', 'script', 'narration', 'visuals', 'captions', 'render'] as const;
export type StepName = (typeof PRODUCTION_STEPS)[number];

export const STEP_LABELS: Record<StepName, string> = {
  research: 'Research',
  brief: 'Brief',
  script: 'Script & storyboard',
  narration: 'Narration',
  visuals: 'Visuals',
  captions: 'Captions',
  render: 'Render'
};

export type StepStatus = 'pending' | 'running' | 'done' | 'failed';
export type ProductionStatus = 'queued' | 'running' | 'failed' | 'completed' | 'cancelled';

export const isStepName = (v: unknown): v is StepName =>
  typeof v === 'string' && (PRODUCTION_STEPS as readonly string[]).includes(v);

export interface Source {
  id: string;
  title: string;
  url: string;
  publisher: string;
  excerpt: string;
  retrievedAt: string;
}

export interface KeyFact {
  text: string;
  sourceId: string;
}

export interface Brief {
  topic: string;
  title: string;
  angle: string;
  audience: string;
  keyFacts: KeyFact[];
  targetSeconds: number;
}

export type SceneRole = 'hook' | 'fact' | 'outro';

export interface Scene {
  index: number;
  role: SceneRole;
  narration: string;
  onScreenText: string;
  visualQuery: string;
  sourceIds: string[];
}

export interface Storyboard {
  title: string;
  writer: string;
  scenes: Scene[];
}

export interface ProductionStep {
  step: StepName;
  status: StepStatus;
  attempts: number;
  progress: number;
  detail: string;
  error: string | null;
  costUsd: number;
  startedAt: string | null;
  finishedAt: string | null;
}

export type AssetKind = 'narration' | 'image' | 'captions' | 'video' | 'credits';

export interface ProductionAsset {
  id: number;
  kind: AssetKind;
  sceneIndex: number | null;
  /** Path relative to the production folder. */
  path: string;
  provider: string;
  sourceUrl: string;
  license: string;
  attribution: string;
  meta: Record<string, unknown>;
}

export interface Production {
  id: number;
  channelId: number;
  contentId: number | null;
  topic: string;
  status: ProductionStatus;
  currentStep: StepName | null;
  error: string | null;
  sources: Source[];
  brief: Brief | null;
  storyboard: Storyboard | null;
  outputPath: string | null;
  durationSec: number | null;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
  steps: ProductionStep[];
  assets: ProductionAsset[];
}

export type ProductionSummary = Omit<Production, 'sources' | 'brief' | 'storyboard' | 'assets'>;

export const VISUAL_PROVIDERS = ['wikimedia-commons', 'comfyui', 'title-card'] as const;
export type VisualProviderId = (typeof VISUAL_PROVIDERS)[number];
export const WRITERS = ['extractive', 'openai-compatible'] as const;
export type WriterId = (typeof WRITERS)[number];

/** User-configurable provider choices. Nothing here is hardcoded to a vendor. */
export interface ProviderSettings {
  wikipediaResearch: boolean;
  writer: WriterId;
  llmBaseUrl: string;
  llmModel: string;
  narration: 'windows-sapi';
  voice: string;
  speechRate: number;
  visuals: VisualProviderId[];
  comfyUrl: string;
  comfyCheckpoint: string;
  musicPath: string;
  musicVolume: number;
  ffmpegPath: string;
}

export const DEFAULT_SETTINGS: ProviderSettings = {
  wikipediaResearch: true,
  writer: 'extractive',
  llmBaseUrl: 'http://127.0.0.1:1234/v1',
  llmModel: '',
  narration: 'windows-sapi',
  voice: '',
  speechRate: 0,
  visuals: ['wikimedia-commons', 'title-card'],
  comfyUrl: 'http://127.0.0.1:8188',
  comfyCheckpoint: '',
  musicPath: '',
  musicVolume: 0.12,
  ffmpegPath: ''
};

export interface ProviderStatus {
  id: string;
  kind: 'research' | 'writer' | 'narration' | 'visuals' | 'render';
  label: string;
  available: boolean;
  detail: string;
  /** Every built-in provider is free/local; kept explicit so paid ones can never sneak in unnoticed. */
  costPerUnitUsd: number;
  options?: string[];
}

export interface NewProduction {
  topic: string;
  contentId?: number;
}

/** URL scheme the renderer uses to preview production media. */
export const MEDIA_SCHEME = 'omnicore-media';
export const mediaUrl = (productionId: number, relPath: string, version?: string): string =>
  `${MEDIA_SCHEME}://p/${productionId}/${relPath.split('/').map(encodeURIComponent).join('/')}${version ? `?v=${encodeURIComponent(version)}` : ''}`;
