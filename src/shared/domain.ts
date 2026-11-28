// Shared domain model: used by main (authoritative) and renderer (display).
import type { Business, BusinessDraft, BusinessPatch, Topic, TopicDraft } from './business';
import type { AnalyticsReport, AuditEvent, AuditVerification, AutonomySettings, BrandDestination, EngineStatus, Idea, Incident, Platform, PlatformAccount, PlatformAppSummary, Privacy, Publication, QaRun, TikTokCreatorInfo, TikTokPostOptions } from './operations';
import type { DestinationStatus } from './publicationStatus';
import type {
  AudioKind,
  AudioTrack,
  AudioTrackPatch,
  PiperVoiceId,
  VoiceSample,
  PreviewEngine,
  VoicePreview,
  PronunciationDraft,
  PronunciationEntry,
  PronunciationFinding,
  SoundGeneratorId,
  NewProduction,
  Production,
  ProductionSummary,
  ProviderSettings,
  ProviderStatus,
  StepName,
  SoundProfile,
  MusicOverride
} from './production';
import type { ProductionFreeze } from './operations';
import type { HistoryEntry, TrackRightsDetails } from './rights';
import type { ContextualEffect, ProductionEffects } from './audioMix';
import type { AutomationHalt, BreakerStatus, ProductionJob, ReliabilitySettings } from './automation';
import type { ComfyDetection, ComfyGeneration, ComfyModel, ComfyStatus, GpuInfo } from './comfy';

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
  /** Shared dictionary entries plus the active business's own. */
  listPronunciations(): Promise<PronunciationEntry[]>;
  savePronunciation(draft: PronunciationDraft): Promise<PronunciationEntry>;
  deletePronunciation(id: number): Promise<void>;
  /** Names and technical terms in a production's script and how each will be said. */
  pronunciationReport(productionId: number): Promise<PronunciationFinding[]>;
  /** Speak a word or sentence with the business's presenter, optionally with a draft correction applied. */
  auditionPronunciation(req: { text: string; term?: string; say?: string }): Promise<VoicePreview>;
  /** Re-voice only these scenes, then rebuild captions, render and QA. */
  revoiceScenes(productionId: number, scenes: number[]): Promise<void>;
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
  /** Audition a voice: 'short' (one sentence, default) or 'passage' (a longer paragraph). Never saves anything. */
  previewVoice(engine: PreviewEngine, voice: string, length?: 'short' | 'passage', kokoroBackend?: 'sherpa' | 'gpu'): Promise<VoicePreview>;
  /** Install Kokoro's reference pipeline (local PyTorch, GPU when available). Does not switch engines. */
  installKokoroGpu(): Promise<ProviderSettings>;
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
  /** Managed ComfyUI: runtime state, GPU, the generation in progress for this business and the selected model. */
  comfyStatus(): Promise<{ runtime: ComfyStatus; gpu: GpuInfo | null; progress: { generationId: number; fraction: number; detail: string } | null; model: string }>;
  /** Find the installation, Python/CUDA and models, with guided setup for anything missing (nothing is downloaded). */
  comfyDetect(): Promise<ComfyDetection>;
  comfyStart(): Promise<ComfyStatus>;
  comfyStop(): Promise<ComfyStatus>;
  comfyRestart(): Promise<ComfyStatus>;
  comfyModels(): Promise<ComfyModel[]>;
  /** Approve a model for production visuals with its licence (recorded and audited). */
  comfyApproveModel(file: string, license: string, licenseUrl?: string, note?: string): Promise<ComfyModel>;
  comfyRevokeModel(file: string, note?: string): Promise<void>;
  /** Generation history of the active business only. */
  comfyHistory(): Promise<ComfyGeneration[]>;
  /** Recent production actions of the active business (newest first): who did what, with state before and after. */
  productionActivity(limit?: number): Promise<AuditEvent[]>;
  /** Automation halt, circuit breakers, recent jobs and reliability limits of the active business. */
  automationStatus(): Promise<{ halt: AutomationHalt | null; breakers: BreakerStatus[]; jobs: ProductionJob[]; reliability: ReliabilitySettings }>;
  /** Resume automation after a gate halted it (you have reviewed the failure). */
  clearAutomationHalt(note?: string): Promise<void>;
  saveReliability(r: ReliabilitySettings): Promise<ReliabilitySettings>;
  runDiscoveryNow(): Promise<{ created: number; candidates: number }>;
  listIdeas(): Promise<Idea[]>;
  /** Start a production from an idea. Off-topic ideas are refused ("OFF_TOPIC: ...") unless confirmOffTopic is true. */
  produceIdea(ideaId: number, confirmOffTopic?: boolean): Promise<number>;
  ideaRelevance(ideaId: number): Promise<{ onTopic: boolean; keywordHits: string[]; anchorHits: string[]; reason: string }>;
  /** The active business's sound profile (music required, moods, accents, discovery, volume). */
  getSoundProfile(): Promise<SoundProfile>;
  /** Contextual effects approved for one production (none by default). */
  getProductionEffects(productionId: number): Promise<ProductionEffects | null>;
  /** Approve (or clear, with an empty list) contextual effects for one production; each must pass the rights check. */
  setProductionEffects(productionId: number, effects: ContextualEffect[]): Promise<ProductionEffects | null>;
  /** Production freeze (audio pipeline restoration): state, the latest verification render and the release. */
  productionFreeze(): Promise<ProductionFreeze>;
  /** Render the audio verification video and record the result (creates no production). */
  verifyAudioPipeline(): Promise<ProductionFreeze>;
  /** Resume production. Refused unless the verification render passed on the current audio pipeline. */
  releaseProduction(note: string): Promise<ProductionFreeze>;
  saveSoundProfile(s: SoundProfile): Promise<SoundProfile>;
  /** A manual music choice for one production (audited). Re-render to apply. */
  getMusicOverride(productionId: number): Promise<MusicOverride | null>;
  setMusicOverride(productionId: number, o: MusicOverride): Promise<MusicOverride | null>;
  /** Find and import openly licensed instrumental music for a mood (licence-checked; unclear rights are refused). */
  discoverMusic(mood: 'calm' | 'upbeat' | 'tense' | 'inspiring'): Promise<{ imported: AudioTrack[]; refused: string[] }>;
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
  /** Full rights and licensing evidence for one sound (read-only). */
  soundRightsDetails(trackId: number): Promise<TrackRightsDetails>;
  /** Rights & Compliance history of the active business (read-only). */
  rightsHistory(): Promise<HistoryEntry[]>;
  addIncident(kind: Incident['kind'], description: string, productionId: number | null, assetKey: string): Promise<Incident>;
  resolveIncident(id: number): Promise<void>;
  platformApps(): Promise<PlatformAppSummary[]>;
  savePlatformApp(platform: Platform, app: { clientId?: string; clientSecret?: string; redirectPort?: number; accessToken?: string; publicVideoBaseUrl?: string }): Promise<PlatformAppSummary>;
  connectAccount(accountId: number): Promise<PlatformAccount>;
  publications(productionId: number): Promise<Publication[]>;
  /** Every publication of the active business, including those whose production was deleted (newest first). */
  publicationHistory(): Promise<Publication[]>;
  /** Publication status per destination for every production of the active business. */
  publicationOverview(): Promise<{ productionId: number; contentId: number | null; topic: string; statuses: DestinationStatus[] }[]>;
  /** Record that a post was deleted on the platform (by you). The record and its history are kept. */
  recordPublicationDeletion(publicationId: number, note?: string): Promise<Publication>;
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
  listPronunciations: 'pron:list',
  savePronunciation: 'pron:save',
  deletePronunciation: 'pron:delete',
  pronunciationReport: 'pron:report',
  auditionPronunciation: 'pron:audition',
  revoiceScenes: 'productions:revoice',
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
  installKokoroGpu: 'providers:installKokoroGpu',
  getAnalytics: 'analytics:get',
  listSounds: 'sounds:list',
  generateSound: 'sounds:generate',
  importSound: 'sounds:import',
  updateSound: 'sounds:update',
  deleteSound: 'sounds:delete',
  getAutonomy: 'ops:autonomy:get',
  saveAutonomy: 'ops:autonomy:save',
  engineStatus: 'ops:engine:status',
  comfyStatus: 'comfy:status',
  comfyDetect: 'comfy:detect',
  comfyStart: 'comfy:start',
  comfyStop: 'comfy:stop',
  comfyRestart: 'comfy:restart',
  comfyModels: 'comfy:models',
  comfyApproveModel: 'comfy:models:approve',
  comfyRevokeModel: 'comfy:models:revoke',
  comfyHistory: 'comfy:history',
  productionActivity: 'ops:activity',
  automationStatus: 'ops:automation:status',
  clearAutomationHalt: 'ops:automation:clearHalt',
  saveReliability: 'ops:reliability:save',
  runDiscoveryNow: 'ops:discovery:run',
  listIdeas: 'ops:ideas:list',
  produceIdea: 'ops:ideas:produce',
  ideaRelevance: 'ops:ideas:relevance',
  getSoundProfile: 'sound:profile:get',
  getProductionEffects: 'sound:effects:get',
  setProductionEffects: 'sound:effects:set',
  productionFreeze: 'ops:freeze:get',
  verifyAudioPipeline: 'ops:freeze:verify',
  releaseProduction: 'ops:freeze:release',
  saveSoundProfile: 'sound:profile:save',
  getMusicOverride: 'sound:override:get',
  setMusicOverride: 'sound:override:set',
  discoverMusic: 'sound:discover',
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
  soundRightsDetails: 'sound:rights:details',
  rightsHistory: 'rights:history',
  addIncident: 'incidents:add',
  resolveIncident: 'incidents:resolve',
  platformApps: 'publishing:apps',
  savePlatformApp: 'publishing:saveApp',
  connectAccount: 'accounts:connect',
  publications: 'publishing:list',
  publicationHistory: 'publishing:history',
  publicationOverview: 'publishing:overview',
  recordPublicationDeletion: 'publishing:recordDeletion',
  publishBlockers: 'publishing:blockers',
  publishProduction: 'publishing:publish',
  tiktokCreatorInfo: 'publishing:tiktok-creator',
  onProductionChanged: 'productions:changed',
  onBusinessChanged: 'business:changed'
} as const satisfies Record<keyof AppApi, string>;
