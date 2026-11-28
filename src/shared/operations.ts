// Omnicore 0.5 — autonomous operations: brands, platform accounts, destinations, ideas,
// QA, audit ledger and the operating engine.

export const PLATFORMS = ['tiktok', 'youtube', 'instagram'] as const;
export type Platform = (typeof PLATFORMS)[number];
export const PLATFORM_LABELS: Record<Platform, string> = { tiktok: 'TikTok', youtube: 'YouTube Shorts', instagram: 'Instagram Reels' };

export type AccountStatus = 'not_connected' | 'connected' | 'expired' | 'revoked' | 'error';

/** What a connected account is allowed to do. Publishing and financial permissions are deliberately separate. */
export interface AccountCapabilities {
  canPublishPrivate: boolean;
  canPublishPublic: boolean;
  /** Never granted by connecting an account: ads/promotion require explicit financial authorization. */
  financial: false;
  restrictions: string[];
}

export interface PlatformAccount {
  /** Owning business: credentials and publishing never cross businesses. */
  businessId: number | null;
  id: number;
  platform: Platform;
  handle: string;
  displayName: string;
  externalId: string;
  avatarUrl: string;
  status: AccountStatus;
  scopes: string[];
  capabilities: AccountCapabilities;
  tokenExpiresAt: string | null;
  lastAuthAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export type Privacy = 'private' | 'public' | 'unlisted';

export interface BrandDestination {
  id: number;
  brandId: number;
  platform: Platform;
  accountId: number | null;
  isDefault: boolean;
  enabled: boolean;
  privacy: Privacy;
}

/** A production's resolved destination, frozen when the production is created. */
export interface ProductionDestination {
  platform: Platform;
  accountId: number | null;
  handle: string | null;
  privacy: Privacy;
  /** Why it cannot publish yet (e.g. not connected); empty when publishable. */
  blockers: string[];
}

export interface PlatformMetadata {
  platform: Platform;
  title: string;
  caption: string;
  hashtags: string[];
  /** AI-generated content disclosure (TikTok is_aigc, YouTube containsSyntheticMedia / description label). */
  aiDisclosure: boolean;
  credits: string;
  /** Manual steps that cannot be done through the official API (e.g. attaching platform-native music). */
  manualSteps: string[];
}

export type ApprovalState = 'none' | 'awaiting_review' | 'approved' | 'rejected' | 'blocked';

export type IdeaStatus = 'new' | 'selected' | 'rejected' | 'produced' | 'failed' | 'expired';

export interface IdeaSignal {
  title: string;
  url: string;
  publisher: string;
  kind: string;
  publishedAt?: string;
  provider: string;
}

export interface ScoreDetail {
  freshness: number;
  coverage: number;
  primarySource: number;
  nicheFit: number;
  novelty: number;
  total: number;
  notes: string[];
}

export interface Idea {
  id: number;
  brandId: number;
  topic: string;
  headline: string;
  mode: 'explainer' | 'news';
  signals: IdeaSignal[];
  score: number;
  scoreDetail: ScoreDetail;
  status: IdeaStatus;
  decision: string;
  productionId: number | null;
  discoveredAt: string;
  decidedAt: string | null;
}

export type Severity = 'critical' | 'major' | 'minor' | 'info';
export type QaCategory =
  | 'facts'
  | 'research'
  | 'editorial'
  | 'rights'
  | 'visuals'
  | 'narration'
  | 'audio'
  | 'captions'
  | 'video'
  | 'metadata';

export interface QaFinding {
  checkId: string;
  category: QaCategory;
  severity: Severity;
  passed: boolean;
  message: string;
  evidence: Record<string, unknown>;
  /** Repair applied or proposed for this finding. */
  repair: string;
}

/** A verification render of the audio pipeline (real narration, music, effects, mix and the audio gate). */
export interface AudioVerification {
  version: number;
  at: string;
  passed: boolean;
  profile: string;
  track: string;
  narration: string;
  durationSec: number;
  findings: QaFinding[];
  /** Where the verification video and its stems are kept. */
  dir: string;
  renderSha256: string;
}

export interface ProductionFreeze {
  frozen: boolean;
  version: number;
  reason: string;
  verification: AudioVerification | null;
  release: { version: number; at: string; note: string; verifiedAt: string } | null;
}

export interface QaRun {
  id: number;
  /** Null once the production was deleted; the run and its findings are kept (see productionNumber). */
  productionId: number | null;
  /** The production's number at the time of the run (kept after deletion). */
  productionNumber: number;
  productionTopic: string;
  /** SHA-256 of the video file that was checked ('' for runs before the render was hashed). */
  renderSha256: string;
  /** The qa.run audit event recording this run. */
  auditEventId: number | null;
  /** When the production was deleted, if it was. */
  productionDeletedAt: string | null;
  round: number;
  status: 'passed' | 'failed' | 'blocked';
  summary: { critical: number; major: number; minor: number; checks: number; repairs: string[] };
  findings: QaFinding[];
  startedAt: string;
  finishedAt: string | null;
}

export interface AuditEvent {
  /** Owning business (events since 0.7; older events belong to the original business). */
  businessId?: number;
  id: number;
  ts: string;
  actor: string;
  type: string;
  subjectType: string;
  subjectId: string;
  productionId: number | null;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface AuditVerification {
  ok: boolean;
  events: number;
  firstBadId: number | null;
  reason: string;
}

export interface Incident {
  id: number;
  kind: 'rights_complaint' | 'incident';
  productionId: number | null;
  assetKey: string;
  description: string;
  status: 'open' | 'resolved';
  createdAt: string;
  resolvedAt: string | null;
}

/** Operating-engine configuration. Autonomy never includes spending money or public publishing without approval. */
export interface AutonomySettings {
  enabled: boolean;
  /** Start Omnicore in the background when Windows starts. */
  runAtStartup: boolean;
  /** Keep running in the system tray when the window is closed. */
  keepRunningInTray: boolean;
  discoveryEveryHours: number;
  maxProductionsPerDay: number;
  /** Local hours during which productions may start, e.g. 8..22. */
  activeFromHour: number;
  activeToHour: number;
  minIdeaScore: number;
  maxIdeasKept: number;
  /** Max automatic QA repair rounds before a production is blocked for review. */
  maxRepairRounds: number;
  /** Publish QA-passed autonomous videos without per-video review — only after you have approved one public post. */
  autoPublish: boolean;
}

export const DEFAULT_AUTONOMY: AutonomySettings = {
  enabled: false,
  runAtStartup: false,
  keepRunningInTray: true,
  discoveryEveryHours: 6,
  maxProductionsPerDay: 2,
  activeFromHour: 8,
  activeToHour: 22,
  minIdeaScore: 55,
  maxIdeasKept: 60,
  maxRepairRounds: 2,
  autoPublish: false
};

export interface EngineStatus {
  enabled: boolean;
  running: boolean;
  lastDiscoveryAt: string | null;
  nextDiscoveryAt: string | null;
  productionsToday: number;
  activeProductionId: number | null;
  lastError: string | null;
  limitations: string[];
}

// ---- publishing (0.5 Stage 2) ----
export interface VideoStats {
  publicationId: number;
  productionId: number;
  title: string;
  url: string;
  privacy: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
}

export interface PlatformAnalytics {
  platform: Platform;
  handle: string;
  /** False when the platform can't report stats for this account (with the reason in detail). */
  available: boolean;
  detail: string;
  followers: number | null;
  totalViews: number | null;
  videos: VideoStats[];
}

/** One requirement; requirements sharing an `either` group are alternatives (meet any one). */
export interface MonetizationRequirement {
  label: string;
  current: number | null;
  target: number;
  either?: string;
}

export interface MonetizationProgram {
  id: string;
  platform: Platform;
  name: string;
  requirements: MonetizationRequirement[];
  /** True only when every requirement is known and met. */
  eligible: boolean;
  note: string;
  source: string;
}

export interface AnalyticsReport {
  capturedAt: string;
  platforms: PlatformAnalytics[];
  programs: MonetizationProgram[];
}

export interface Publication {
  id: number;
  /** Null once the production itself has been deleted (the publication record is kept). */
  productionId: number | null;
  platform: Platform;
  accountId: number | null;
  /** Omnicore privacy, or the exact TikTok level the user chose on the posting screen. */
  privacyRequested: string;
  privacyApplied: string;
  status: 'uploading' | 'processing' | 'published' | 'failed';
  remoteId: string;
  url: string;
  detail: string;
  approvedBy: string;
  createdAt: string;
  updatedAt: string;
  /** Production number and topic at the time, kept even if the production is later deleted. */
  productionNumber: number;
  productionTopic: string;
  /** The connected account's handle at the time. */
  accountHandle: string;
  /** SHA-256 of the exact video file uploaded (a corrected render is a new attempt, never an overwrite). */
  renderSha256: string;
  /** The platform accepted the upload. */
  uploadedAt: string | null;
  /** The platform confirmed publication. */
  publishedAt: string | null;
  failedAt: string | null;
  /** Set only when the user records a deletion or the platform confirms one. */
  deletedAt: string | null;
  deletionSource: '' | 'user' | 'platform';
  deletionNote: string;
  /** Non-empty when the record was rebuilt from the audit log (e.g. lost to an older cascade delete). */
  restoredFrom: string;
}

/** What the UI may show about a configured developer app (secrets never leave the main process). */
export interface PlatformAppSummary {
  platform: Platform;
  configured: boolean;
  clientId: string;
  hasSecret: boolean;
  hasAccessToken: boolean;
  redirectPort: number;
  publicVideoBaseUrl: string;
}

/** What TikTok reports about the connected creator, shown on the posting screen (Content Sharing Guidelines). */
export interface TikTokCreatorInfo {
  nickname: string;
  username: string;
  avatarUrl: string;
  /** The only privacy levels the user may pick from; TikTok forbids a preselected default. */
  privacyLevelOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec: number;
}

/** Choices the user made on the TikTok posting screen. */
export interface TikTokPostOptions {
  privacyLevel: string;
  caption: string;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  /** Commercial content disclosure: promoting the creator's own business. */
  brandOrganic: boolean;
  /** Commercial content disclosure: paid partnership / promoting a third party. */
  brandContent: boolean;
}
