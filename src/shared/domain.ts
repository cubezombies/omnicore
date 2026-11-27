// Shared domain model: used by main (authoritative) and renderer (display).
import type { Business, BusinessDraft, BusinessPatch, Topic, TopicDraft } from './business';
import type { AnalyticsReport, AuditEvent, AuditVerification, AutonomySettings, BrandDestination, EngineStatus, Idea, Incident, Platform, PlatformAccount, PlatformAppSummary, Privacy, Publication, QaRun, TikTokCreatorInfo, TikTokPostOptions } from './operations';
import type {
  AudioKind,
  AudioTrack,
  AudioTrackPatch,
  PiperVoiceId,
  VoiceSample,
  PreviewEngine,
  VoicePreview,
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

/** A business operating on Omnicore (stored in the channels table for compatibility). */
export type Channel = Business;

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

export interface AppInfo {
  version: string;
  dataDir: string;
}

/** The API the preload exposes as window.api. Every call is validated again in main. */
export interface AppApi {
  listChannels(): Promise<Channel[]>;
  /** Businesses (active only unless includeArchived). */
  listBusinesses(includeArchived?: boolean): Promise<Business[]>;
  /** The business the main process is working in, or null when none is valid. */
  activeBusiness(): Promise<Business | null>;
  switchBusiness(id: number): Promise<Business>;
  createBusiness(draft: BusinessDraft): Promise<Business>;
  /** Only the active business can be edited. */
  updateBusiness(id: number, patch: BusinessPatch): Promise<Business>;
  archiveBusiness(id: number): Promise<Business>;
  restoreBusiness(id: number): Promise<Business>;
  listTopics(): Promise<Topic[]>;
  createTopic(draft: TopicDraft): Promise<Topic>;
  updateTopic(id: number, patch: Partial<TopicDraft>): Promise<Topic>;
  reorderTopics(parentId: number | null, orderedIds: number[]): Promise<Topic[]>;
  archiveTopic(id: number): Promise<Topic>;
  restoreTopic(id: number): Promise<Topic>;
  deleteTopic(id: number): Promise<void>;
  decideTopicProposal(id: number, accept: boolean): Promise<Topic | null>;
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
  /** Download sherpa-onnx + Kokoro v1.0 (Apache-2.0) into the data dir and select it; returns updated settings. */
  installKokoro(): Promise<ProviderSettings>;
  /** Synthesise a short technical sample with the current narration settings and measure its speaking speed. */
  generateVoiceSample(): Promise<VoiceSample>;
  /** Synthesise (or reuse) a short preview of one voice. Never changes settings. */
  previewVoice(engine: PreviewEngine, voice: string): Promise<VoicePreview>;
  /** Refresh audience numbers from connected accounts (read-only) and compute monetization progress. */
  getAnalytics(): Promise<AnalyticsReport>;

  // Music & Sound Library
  listSounds(): Promise<AudioTrack[]>;
  generateSound(generator: SoundGeneratorId): Promise<AudioTrack>;
  /** Opens a file picker in the main process; resolves null if the user cancels. */
  importSound(kind: AudioKind): Promise<AudioTrack | null>;
  updateSound(id: number, patch: AudioTrackPatch): Promise<AudioTrack>;
  deleteSound(id: number): Promise<void>;

  // 0.5 autonomous operations
  getAutonomy(): Promise<AutonomySettings>;
  saveAutonomy(s: AutonomySettings): Promise<AutonomySettings>;
  engineStatus(): Promise<EngineStatus>;
  runDiscoveryNow(): Promise<{ created: number; candidates: number }>;
  listIdeas(): Promise<Idea[]>;
  produceIdea(ideaId: number): Promise<number>;
  rejectIdea(ideaId: number, reason: string): Promise<void>;
  listAccounts(): Promise<PlatformAccount[]>;
  addAccount(platform: Platform, handle: string): Promise<PlatformAccount>;
  disconnectAccount(id: number): Promise<PlatformAccount>;
  listDestinations(): Promise<BrandDestination[]>;
  setDestination(platform: Platform, accountId: number | null, enabled: boolean, privacy: Privacy): Promise<BrandDestination>;
  getBrandPresenter(): Promise<{ engine: string; voice: string }>;
  setBrandPresenter(engine: string, voice: string): Promise<void>;
  qaRuns(productionId: number): Promise<QaRun[]>;
  runQa(productionId: number): Promise<void>;
  approveProduction(productionId: number, note: string): Promise<void>;
  rejectProduction(productionId: number, note: string): Promise<void>;
  exportAudit(productionId: number): Promise<string>;
  verifyAudit(): Promise<AuditVerification>;
  auditEvents(productionId: number): Promise<AuditEvent[]>;
  listIncidents(): Promise<Incident[]>;
  addIncident(kind: Incident['kind'], description: string, productionId: number | null, assetKey: string): Promise<Incident>;
  resolveIncident(id: number): Promise<void>;
  platformApps(): Promise<PlatformAppSummary[]>;
  savePlatformApp(platform: Platform, app: { clientId?: string; clientSecret?: string; redirectPort?: number; accessToken?: string; publicVideoBaseUrl?: string }): Promise<PlatformAppSummary>;
  connectAccount(accountId: number): Promise<PlatformAccount>;
  publications(productionId: number): Promise<Publication[]>;
  publishBlockers(productionId: number): Promise<Record<string, string[]>>;
  publishProduction(productionId: number, platform: Platform, tiktok?: TikTokPostOptions): Promise<Publication>;
  tiktokCreatorInfo(productionId: number): Promise<TikTokCreatorInfo>;

  /** Subscribe to production changes; returns an unsubscribe function. */
  onProductionChanged(cb: (productionId: number) => void): () => void;
  /** Fired whenever the main process switches the active business (from any source). */
  onBusinessChanged(cb: (businessId: number) => void): () => void;
}

/** IPC channel names, shared so preload and main cannot drift. */
export const IPC = {
  listChannels: 'channels:list',
  listBusinesses: 'business:list',
  activeBusiness: 'business:active',
  switchBusiness: 'business:switch',
  createBusiness: 'business:create',
  updateBusiness: 'business:update',
  archiveBusiness: 'business:archive',
  restoreBusiness: 'business:restore',
  listTopics: 'topics:list',
  createTopic: 'topics:create',
  updateTopic: 'topics:update',
  reorderTopics: 'topics:reorder',
  archiveTopic: 'topics:archive',
  restoreTopic: 'topics:restore',
  deleteTopic: 'topics:delete',
  decideTopicProposal: 'topics:decide',
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
  installKokoro: 'providers:installKokoro',
  generateVoiceSample: 'providers:voiceSample',
  previewVoice: 'providers:voicePreview',
  getAnalytics: 'analytics:get',
  listSounds: 'sounds:list',
  generateSound: 'sounds:generate',
  importSound: 'sounds:import',
  updateSound: 'sounds:update',
  deleteSound: 'sounds:delete',
  getAutonomy: 'ops:autonomy:get',
  saveAutonomy: 'ops:autonomy:save',
  engineStatus: 'ops:engine:status',
  runDiscoveryNow: 'ops:discovery:run',
  listIdeas: 'ops:ideas:list',
  produceIdea: 'ops:ideas:produce',
  rejectIdea: 'ops:ideas:reject',
  listAccounts: 'accounts:list',
  addAccount: 'accounts:add',
  disconnectAccount: 'accounts:disconnect',
  listDestinations: 'destinations:list',
  setDestination: 'destinations:set',
  getBrandPresenter: 'brand:presenter:get',
  setBrandPresenter: 'brand:presenter:set',
  qaRuns: 'qa:runs',
  runQa: 'qa:run',
  approveProduction: 'approval:approve',
  rejectProduction: 'approval:reject',
  exportAudit: 'audit:export',
  verifyAudit: 'audit:verify',
  auditEvents: 'audit:events',
  listIncidents: 'incidents:list',
  addIncident: 'incidents:add',
  resolveIncident: 'incidents:resolve',
  platformApps: 'publishing:apps',
  savePlatformApp: 'publishing:saveApp',
  connectAccount: 'accounts:connect',
  publications: 'publishing:list',
  publishBlockers: 'publishing:blockers',
  publishProduction: 'publishing:publish',
  tiktokCreatorInfo: 'publishing:tiktok-creator',
  onProductionChanged: 'productions:changed',
  onBusinessChanged: 'business:changed'
} as const satisfies Record<keyof AppApi, string>;
