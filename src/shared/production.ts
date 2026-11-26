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
  /** Why a fallback writer was used, if one was. */
  fallbackReason?: string;
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

export type AssetKind = 'narration' | 'image' | 'captions' | 'video' | 'credits' | 'music' | 'sfx';

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
export const NARRATORS = ['windows-sapi', 'piper'] as const;
export type NarratorId = (typeof NARRATORS)[number];

/**
 * Piper voices whose training data allows commercial use (checked against each voice's MODEL_CARD)
 * and that the standalone piper.exe can load (single-codepoint phoneme maps; e.g. en_US-joe needs newer Piper).
 */
export const PIPER_VOICES = [
  { id: 'en_US-john-medium', label: 'John (US male)', license: 'Public domain (LibriVox)', path: 'en/en_US/john/medium' },
  { id: 'en_US-norman-medium', label: 'Norman (US male)', license: 'Public domain (LibriVox)', path: 'en/en_US/norman/medium' },
  { id: 'en_US-libritts_r-medium', label: 'LibriTTS-R (US, multi-speaker)', license: 'CC BY 4.0', path: 'en/en_US/libritts_r/medium' }
] as const;
export type PiperVoiceId = (typeof PIPER_VOICES)[number]['id'];

export const MUSIC_MODES = ['none', 'auto', 'track'] as const;
export type MusicMode = (typeof MUSIC_MODES)[number];
export type WriterId = (typeof WRITERS)[number];

/** User-configurable provider choices. Nothing here is hardcoded to a vendor. */
export interface ProviderSettings {
  wikipediaResearch: boolean;
  writer: WriterId;
  llmBaseUrl: string;
  /** Blank = discover the loaded model from the server's /models endpoint. */
  llmModel: string;
  llmTimeoutSec: number;
  /** Use the deterministic writer if the LLM is unreachable or its script fails validation. */
  writerFallback: boolean;
  narration: NarratorId;
  voice: string;
  /** -10..10; also drives Piper's speaking speed. */
  speechRate: number;
  /** Blank = <data dir>/tools/piper/piper.exe (installed from Providers). */
  piperPath: string;
  /** Absolute path to a Piper .onnx voice; blank = first installed voice. */
  piperVoice: string;
  visuals: VisualProviderId[];
  comfyUrl: string;
  comfyCheckpoint: string;
  /** Background music from the Sound Library: none, a random music track, or a chosen one. */
  musicMode: MusicMode;
  musicTrackId: number;
  musicVolume: number;
  /** Transition sound effect at each scene cut (an SFX tagged "transition"). */
  sfxTransitions: boolean;
  sfxVolume: number;
  ffmpegPath: string;
}

export const DEFAULT_SETTINGS: ProviderSettings = {
  wikipediaResearch: true,
  writer: 'openai-compatible',
  llmBaseUrl: 'http://127.0.0.1:8080/v1',
  llmModel: '',
  llmTimeoutSec: 300,
  writerFallback: true,
  narration: 'windows-sapi',
  voice: '',
  speechRate: 0,
  piperPath: '',
  piperVoice: '',
  visuals: ['wikimedia-commons', 'title-card'],
  comfyUrl: 'http://127.0.0.1:8188',
  comfyCheckpoint: '',
  musicMode: 'none',
  musicTrackId: 0,
  musicVolume: 0.12,
  sfxTransitions: false,
  sfxVolume: 0.35,
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

export type AudioKind = 'music' | 'sfx';

export interface AudioTrack {
  id: number;
  kind: AudioKind;
  title: string;
  /** Path relative to the library folder. */
  file: string;
  durationSec: number;
  license: string;
  attribution: string;
  sourceUrl: string;
  tags: string[];
  origin: 'generated' | 'imported';
  createdAt: string;
}

export type AudioTrackPatch = Partial<Pick<AudioTrack, 'title' | 'license' | 'attribution' | 'sourceUrl' | 'tags'>>;

/** Built-in generators: sounds synthesised locally by FFmpeg, free of third-party rights. */
export const SOUND_GENERATORS = [
  { id: 'ambient-pad', kind: 'music', title: 'Ambient pad (generated)', tags: ['calm', 'ambient'] },
  { id: 'pulse-bed', kind: 'music', title: 'Pulse bed 100 BPM (generated)', tags: ['upbeat', 'tech'] },
  { id: 'whoosh', kind: 'sfx', title: 'Whoosh (generated)', tags: ['transition'] },
  { id: 'riser', kind: 'sfx', title: 'Riser (generated)', tags: ['transition', 'build'] },
  { id: 'pop', kind: 'sfx', title: 'Pop (generated)', tags: ['accent'] }
] as const;
export type SoundGeneratorId = (typeof SOUND_GENERATORS)[number]['id'];

export const libraryUrl = (file: string): string => `${MEDIA_SCHEME}://lib/${file.split('/').map(encodeURIComponent).join('/')}`;
