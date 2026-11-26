// Shared domain model: used by main (authoritative) and renderer (display).
import type {
  AudioKind,
  AudioTrack,
  AudioTrackPatch,
  PiperVoiceId,
  SoundGeneratorId,
  NewProduction,
  Production,
  ProductionSummary,
  ProviderSettings,
  ProviderStatus,
  StepName
} from './production';

export const STAGES = ['idea', 'research', 'script', 'production', 'review', 'published'] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  idea: 'Idea',
  research: 'Research',
  script: 'Script',
  production: 'Production',
  review: 'Review',
  published: 'Published'
};

export interface Channel {
  id: number;
  name: string;
  slug: string;
  niche: string;
  platforms: string[];
  createdAt: string;
}

export interface ContentItem {
  id: number;
  channelId: number;
  title: string;
  summary: string;
  researchNotes: string;
  script: string;
  stage: Stage;
  createdAt: string;
  updatedAt: string;
}

export interface ContentDraft {
  title: string;
  summary?: string;
  researchNotes?: string;
  script?: string;
}

export type ContentPatch = Partial<ContentDraft>;

export interface StageCounts {
  channelId: number;
  counts: Record<Stage, number>;
  total: number;
}

export const isStage = (v: unknown): v is Stage =>
  typeof v === 'string' && (STAGES as readonly string[]).includes(v);

export const stageIndex = (s: Stage): number => STAGES.indexOf(s);

export const nextStage = (s: Stage): Stage | null => STAGES[stageIndex(s) + 1] ?? null;

export const previousStage = (s: Stage): Stage | null =>
  stageIndex(s) > 0 ? STAGES[stageIndex(s) - 1] : null;

/**
 * Workflow rule: work moves forward one stage at a time (no skipping review),
 * and can be sent back to any earlier stage for rework.
 */
export function canTransition(from: Stage, to: Stage): boolean {
  const f = stageIndex(from);
  const t = stageIndex(to);
  return t === f + 1 || t < f;
}

export const LIMITS = { title: 200, summary: 2000, researchNotes: 50000, script: 50000 } as const;

/** Business goals (static targets for now; revenue tracking comes later). */
export const BUSINESS_GOALS = {
  cumulativeRevenueTarget: 1_000_000,
  incomeToReplace: 150_000,
  annualProfitTarget: 200_000
} as const;

export interface AppInfo {
  version: string;
  dataDir: string;
}

/** The API the preload exposes as window.api. Every call is validated again in main. */
export interface AppApi {
  listChannels(): Promise<Channel[]>;
  listContent(channelId: number, stages?: Stage[]): Promise<ContentItem[]>;
  getContent(id: number): Promise<ContentItem | null>;
  createContent(channelId: number, draft: ContentDraft): Promise<ContentItem>;
  updateContent(id: number, patch: ContentPatch): Promise<ContentItem>;
  moveContent(id: number, to: Stage): Promise<ContentItem>;
  deleteContent(id: number): Promise<void>;
  stageCounts(channelId: number): Promise<StageCounts>;
  appInfo(): Promise<AppInfo>;

  // Video Factory
  listProductions(channelId: number): Promise<ProductionSummary[]>;
  getProduction(id: number): Promise<Production>;
  createProduction(channelId: number, input: NewProduction): Promise<Production>;
  retryProduction(id: number): Promise<void>;
  rerunProduction(id: number, from: StepName): Promise<void>;
  cancelProduction(id: number): Promise<void>;
  deleteProduction(id: number): Promise<void>;
  showProductionFile(id: number): Promise<void>;
  getSettings(): Promise<ProviderSettings>;
  saveSettings(settings: ProviderSettings): Promise<ProviderSettings>;
  checkProviders(): Promise<ProviderStatus[]>;
  /** Download Piper and a commercially usable voice into the data dir; returns updated settings. */
  installPiper(voice: PiperVoiceId): Promise<ProviderSettings>;

  // Music & Sound Library
  listSounds(): Promise<AudioTrack[]>;
  generateSound(generator: SoundGeneratorId): Promise<AudioTrack>;
  /** Opens a file picker in the main process; resolves null if the user cancels. */
  importSound(kind: AudioKind): Promise<AudioTrack | null>;
  updateSound(id: number, patch: AudioTrackPatch): Promise<AudioTrack>;
  deleteSound(id: number): Promise<void>;

  /** Subscribe to production changes; returns an unsubscribe function. */
  onProductionChanged(cb: (productionId: number) => void): () => void;
}

/** IPC channel names, shared so preload and main cannot drift. */
export const IPC = {
  listChannels: 'channels:list',
  listContent: 'content:list',
  getContent: 'content:get',
  createContent: 'content:create',
  updateContent: 'content:update',
  moveContent: 'content:move',
  deleteContent: 'content:delete',
  stageCounts: 'content:stageCounts',
  appInfo: 'app:info',
  listProductions: 'productions:list',
  getProduction: 'productions:get',
  createProduction: 'productions:create',
  retryProduction: 'productions:retry',
  rerunProduction: 'productions:rerun',
  cancelProduction: 'productions:cancel',
  deleteProduction: 'productions:delete',
  showProductionFile: 'productions:show',
  getSettings: 'settings:get',
  saveSettings: 'settings:save',
  checkProviders: 'providers:check',
  installPiper: 'providers:installPiper',
  listSounds: 'sounds:list',
  generateSound: 'sounds:generate',
  importSound: 'sounds:import',
  updateSound: 'sounds:update',
  deleteSound: 'sounds:delete',
  onProductionChanged: 'productions:changed'
} as const satisfies Record<keyof AppApi, string>;
