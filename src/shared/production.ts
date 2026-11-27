import type { ApprovalState, PlatformMetadata, ProductionDestination } from './operations';
// Video Factory: shared types for productions (topic → finished 9:16 MP4).

export const PRODUCTION_STEPS = ['research', 'brief', 'script', 'narration', 'visuals', 'captions', 'render', 'qa'] as const;
export type StepName = (typeof PRODUCTION_STEPS)[number];

export const STEP_LABELS: Record<StepName, string> = {
  research: 'Research',
  brief: 'Brief',
  script: 'Script & storyboard',
  narration: 'Narration',
  visuals: 'Visuals',
  captions: 'Captions',
  render: 'Render',
  qa: 'Quality check'
};

export type StepStatus = 'pending' | 'running' | 'done' | 'failed';
export type ProductionStatus = 'queued' | 'running' | 'failed' | 'completed' | 'cancelled';

export const isStepName = (v: unknown): v is StepName =>
  typeof v === 'string' && (PRODUCTION_STEPS as readonly string[]).includes(v);

/** What kind of evidence a source is. Drives ranking, claim classification and attribution. */
export type SourceKind = 'research' | 'official' | 'company' | 'reporting' | 'background' | 'community' | 'user' | 'other';

export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  research: 'Research',
  official: 'Official / primary',
  company: 'Company announcement',
  reporting: 'Independent reporting',
  background: 'Background',
  community: 'Community',
  user: 'Your notes',
  other: 'Unclassified site'
};

export type ResearchCategory = 'news' | 'research' | 'tools' | 'hardware' | 'policy' | 'background';

export interface Source {
  id: string;
  title: string;
  url: string;
  publisher: string;
  excerpt: string;
  retrievedAt: string;
  /** Fields below were added in 0.4; older productions may not have them. */
  kind?: SourceKind;
  provider?: string;
  category?: ResearchCategory;
  publishedAt?: string;
  authors?: string[];
  /** How much of the source we actually have: full text, an abstract, or only a feed summary. */
  contentLevel?: 'full' | 'abstract' | 'summary' | 'notes';
  doi?: string;
  /** Sources in the same group are NOT independent of each other (same publisher, wire copy, syndicated release). */
  group?: string;
  /** Id of the source this one appears to repeat (e.g. reporting that re-publishes a press release). */
  derivedFrom?: string;
}

/** How strongly a claim is established, which decides how the script must phrase it. */
export type ClaimKind = 'confirmed' | 'company-claim' | 'reported' | 'estimate' | 'speculation' | 'opinion';

export const CLAIM_KIND_LABELS: Record<ClaimKind, string> = {
  confirmed: 'Confirmed',
  'company-claim': 'Company claim',
  reported: 'Independently reported',
  estimate: 'Estimate',
  speculation: 'Speculation',
  opinion: 'Opinion'
};

export interface Claim {
  id: string;
  /** Verbatim (cleaned) sentence from the first supporting source. */
  text: string;
  sourceIds: string[];
  kind: ClaimKind;
  /** Who the claim must be attributed to when it is not confirmed (publisher/company name). */
  attribution: string;
  /** Number of independent source groups that support it (syndicated copies count once). */
  independentSources: number;
}

export type ProductionMode = 'explainer' | 'news';

/** Length formats. Standard (about a minute: 61–90 s, the default) qualifies for programmes that require videos over one minute (e.g. TikTok Creator Rewards). */
export type ProductionFormat = 'short' | 'standard';
export const PRODUCTION_FORMATS: Record<ProductionFormat, { label: string; minSec: number; maxSec: number; minClaims: number; maxClaims: number; minSources: number; factScenes: [number, number]; maxScenes: number }> = {
  short: { label: 'Short (under 60 s)', minSec: 10, maxSec: 60, minClaims: 1, maxClaims: 6, minSources: 1, factScenes: [3, 5], maxScenes: 10 },
  standard: { label: 'About a minute (61–90 s, default)', minSec: 61, maxSec: 90, minClaims: 5, maxClaims: 10, minSources: 3, factScenes: [5, 8], maxScenes: 12 }
};
export const isProductionFormat = (v: unknown): v is ProductionFormat => v === 'short' || v === 'standard';

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
  /** Claim-level evidence (0.4+). */
  claims?: Claim[];
  mode?: ProductionMode;
  format?: ProductionFormat;
  /** Narration word budget for the format at the voice's measured speed. */
  minWords?: number;
  maxWords?: number;
}

export type SceneRole = 'hook' | 'fact' | 'outro';

export interface Scene {
  index: number;
  role: SceneRole;
  narration: string;
  onScreenText: string;
  visualQuery: string;
  sourceIds: string[];
  /** Evidence claims this scene states (0.4+). */
  claimIds?: string[];
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
  mode: ProductionMode;
  format: ProductionFormat;
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
  /** 0.5: autonomy, destinations, publication readiness. */
  origin: 'manual' | 'autonomous';
  ideaId: number | null;
  destinations: ProductionDestination[];
  metadata: Record<string, PlatformMetadata>;
  approval: ApprovalState;
  publishStatus: string;
}

export type ProductionSummary = Omit<Production, 'sources' | 'brief' | 'storyboard' | 'assets' | 'metadata'>;

export const VISUAL_PROVIDERS = ['wikimedia-commons', 'openverse', 'graphics', 'comfyui', 'title-card'] as const;
export type VisualProviderId = (typeof VISUAL_PROVIDERS)[number];
export const WRITERS = ['extractive', 'openai-compatible'] as const;
export const NARRATORS = ['windows-sapi', 'piper', 'sherpa'] as const;
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

/** Kokoro v1.0 English voices (Apache-2.0 model and voices), run through sherpa-onnx. Speaker ids from the model metadata. */
export const KOKORO_VOICES = [
  { id: 'af_heart', sid: 3, label: 'Heart (US female) · AI, Actually presenter (default)' },
  { id: 'af_bella', sid: 2, label: 'Bella (US female)' },
  { id: 'af_nicole', sid: 6, label: 'Nicole (US female, soft)' },
  { id: 'af_sarah', sid: 9, label: 'Sarah (US female)' },
  { id: 'af_nova', sid: 7, label: 'Nova (US female)' },
  { id: 'af_sky', sid: 10, label: 'Sky (US female)' },
  { id: 'am_michael', sid: 16, label: 'Michael (US male)' },
  { id: 'am_fenrir', sid: 14, label: 'Fenrir (US male)' },
  { id: 'am_puck', sid: 18, label: 'Puck (US male)' },
  { id: 'am_adam', sid: 11, label: 'Adam (US male)' },
  { id: 'am_echo', sid: 12, label: 'Echo (US male)' },
  { id: 'am_eric', sid: 13, label: 'Eric (US male)' },
  { id: 'am_liam', sid: 15, label: 'Liam (US male)' },
  { id: 'am_onyx', sid: 17, label: 'Onyx (US male, deep)' },
  { id: 'bf_emma', sid: 21, label: 'Emma (UK female)' },
  { id: 'bf_isabella', sid: 22, label: 'Isabella (UK female)' },
  { id: 'bf_alice', sid: 20, label: 'Alice (UK female)' },
  { id: 'bf_lily', sid: 23, label: 'Lily (UK female)' },
  { id: 'bm_george', sid: 26, label: 'George (UK male)' },
  { id: 'bm_fable', sid: 25, label: 'Fable (UK male)' },
  { id: 'bm_lewis', sid: 27, label: 'Lewis (UK male)' },
  { id: 'bm_daniel', sid: 24, label: 'Daniel (UK male)' }
] as const;
export type KokoroVoiceId = (typeof KOKORO_VOICES)[number]['id'];

export interface Pronunciation {
  term: string;
  say: string;
}

/** A dictionary entry. `say` is a respelling every engine reads; `engineSay` overrides it for one engine. */
export interface PronunciationEntry {
  id: number;
  /** null = shared by every business; otherwise this business only (and it wins over a shared entry). */
  businessId: number | null;
  term: string;
  say: string;
  engineSay: Partial<Record<PreviewEngine, string>>;
  /** Reference phonetics for people; no installed engine accepts phoneme input (verified), so it is never sent to one. */
  ipa: string;
  context: string;
  caseSensitive: boolean;
  /** False for entries nobody has auditioned yet. */
  verified: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PronunciationDraft {
  term: string;
  say: string;
  engineSay?: Partial<Record<PreviewEngine, string>>;
  ipa?: string;
  context?: string;
  caseSensitive?: boolean;
  verified?: boolean;
  /** Save for this business only, or for every business. */
  scope: 'business' | 'global';
}

/** One term found in a script: how it will be said and whether that is known to be right. */
export interface PronunciationFinding {
  term: string;
  /** dictionary = an entry you saved; builtin = Omnicore's list; rule = spelled-out acronym etc.; uncertain = needs your check. */
  status: 'dictionary' | 'builtin' | 'rule' | 'uncertain';
  spoken: string;
  count: number;
  scenes: number[];
  entryId?: number;
}

/** Research sources Omnicore can query. All are free; none needs an API key. */
export const RESEARCH_PROVIDERS = [
  { id: 'wikipedia', label: 'Wikipedia', category: 'background', description: 'Encyclopedic background (optional).', defaultOn: true },
  { id: 'arxiv', label: 'arXiv', category: 'research', description: 'Preprints: abstracts, authors, dates.', defaultOn: true },
  { id: 'openalex', label: 'OpenAlex', category: 'research', description: 'Scholarly index: abstracts, venues, citations.', defaultOn: true },
  { id: 'crossref', label: 'Crossref', category: 'research', description: 'DOI metadata and abstracts where publishers provide them.', defaultOn: true },
  { id: 'github', label: 'GitHub', category: 'tools', description: 'Repositories, READMEs and latest releases.', defaultOn: true },
  { id: 'huggingface', label: 'Hugging Face', category: 'tools', description: 'Models and model cards.', defaultOn: true },
  { id: 'newsrooms', label: 'Company newsrooms', category: 'news', description: 'Official RSS: OpenAI, NVIDIA, Google, DeepMind, Hugging Face, AMD.', defaultOn: true },
  { id: 'tech-press', label: 'Technology press', category: 'news', description: 'RSS: The Verge, Ars Technica, TechCrunch, MIT Technology Review, Tom’s Hardware.', defaultOn: true },
  { id: 'gdelt', label: 'GDELT news search', category: 'news', description: 'Searches worldwide news coverage (rate-limited: 1 request / 5 s).', defaultOn: true },
  { id: 'hackernews', label: 'Hacker News (discovery)', category: 'news', description: 'Finds links; the linked pages are fetched and classified, HN itself is never evidence.', defaultOn: true },
  { id: 'federal-register', label: 'US Federal Register', category: 'policy', description: 'US federal rules, notices and executive documents.', defaultOn: true },
  { id: 'sec-edgar', label: 'SEC EDGAR full-text', category: 'policy', description: 'Company filings. SEC asks automated clients to identify themselves; off by default.', defaultOn: false }
] as const;
export type ResearchProviderId = (typeof RESEARCH_PROVIDERS)[number]['id'];

export const MUSIC_MODES = ['none', 'auto', 'track'] as const;
export type MusicMode = (typeof MUSIC_MODES)[number];
export type WriterId = (typeof WRITERS)[number];

/** User-configurable provider choices. Nothing here is hardcoded to a vendor. */
export interface ProviderSettings {
  /** Kept for 0.3 compatibility; mirrors whether 'wikipedia' is in researchProviders. */
  wikipediaResearch: boolean;
  researchProviders: ResearchProviderId[];
  /** News mode only uses items published within this many days. */
  newsWindowDays: number;
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
  /** Kokoro voice (sherpa-onnx engine). */
  sherpaVoice: KokoroVoiceId;
  /** Target pause between sentences, in seconds (0.15–0.8). */
  sentencePauseSec: number;
  /**
   * How Kokoro voices are run: 'sherpa' (sherpa-onnx on the CPU, built in) or 'gpu' (Kokoro's reference pipeline,
   * an optional local install). Same model and voices; only switched by the user.
   */
  kokoroBackend: 'sherpa' | 'gpu';
  /** Extra pronunciations (term → how to say it), applied before the built-in ones. */
  pronunciations: Pronunciation[];
  /** Measured speaking speed of the selected voice (words/s), from the last voice sample; 0 = unknown. */
  voiceWordsPerSec: number;
  visuals: VisualProviderId[];
  /** 2 = settings already offered Openverse and graphics (0.6.1). */
  visualsRev?: number;
  comfyUrl: string;
  comfyCheckpoint: string;
  /** Background music from the Sound Library: none, a random music track, or a chosen one. */
  musicMode: MusicMode;
  musicTrackId: number;
  musicVolume: number;
  /** Transition sound effect at each scene cut (an SFX tagged "transition"). */
  sfxTransitions: boolean;
  sfxVolume: number;
  /** CC BY-SA images: commercial use and edits are allowed, but the adapted work must be shared alike. Off = only CC0/PD/CC BY. */
  allowShareAlike: boolean;
  ffmpegPath: string;
}

export const DEFAULT_SETTINGS: ProviderSettings = {
  wikipediaResearch: true,
  researchProviders: ['wikipedia', 'arxiv', 'openalex', 'crossref', 'github', 'huggingface', 'newsrooms', 'tech-press', 'gdelt', 'hackernews', 'federal-register'],
  newsWindowDays: 30,
  writer: 'openai-compatible',
  llmBaseUrl: 'http://127.0.0.1:8080/v1',
  llmModel: '',
  llmTimeoutSec: 300,
  writerFallback: true,
  narration: 'sherpa',
  voice: '',
  speechRate: 0,
  piperPath: '',
  piperVoice: '',
  /** AI, Actually's presenter voice. Applies to fresh installs only: a saved choice is never overwritten. */
  sherpaVoice: 'af_heart',
  sentencePauseSec: 0.32,
  kokoroBackend: 'sherpa',
  pronunciations: [],
  voiceWordsPerSec: 0,
  visuals: ['wikimedia-commons', 'openverse', 'graphics', 'title-card'],
  visualsRev: 2,
  comfyUrl: 'http://127.0.0.1:8188',
  comfyCheckpoint: '',
  musicMode: 'none',
  musicTrackId: 0,
  musicVolume: 0.12,
  sfxTransitions: false,
  sfxVolume: 0.35,
  allowShareAlike: false,
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
  mode?: ProductionMode;
  format?: ProductionFormat;
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
  /** embedded = mixed into the video file under its own licence; platform_native = attached on the platform (not exportable). */
  usage: 'embedded' | 'platform_native';
  commercialUse: 'yes' | 'no' | 'unknown';
  restrictions: { platforms?: string[]; territories?: string[]; accountTypes?: string[]; notes?: string };
}

export type AudioTrackPatch = Partial<Pick<AudioTrack, 'title' | 'license' | 'attribution' | 'sourceUrl' | 'tags' | 'commercialUse'>>;

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

export const VOICE_SAMPLE_TEXT =
  'NVIDIA says its new GPU delivers up to 30x faster inference for LLMs. Researchers on arXiv describe speculative decoding, where a small draft model proposes tokens and a larger model verifies them.';

export interface VoiceSample {
  url: string;
  durationSec: number;
  wordsPerSec: number;
  voice: string;
  engine: string;
}

export const sampleUrl = (file: string): string => `${MEDIA_SCHEME}://sample/${encodeURIComponent(file)}`;

/** Short neutral line for auditioning voices: a brand name, a number, an acronym and plain speech. */
export const VOICE_PREVIEW_TEXT = "Hello, and welcome to AI, Actually. Today we look at how one open model handles 30 languages, and why clear, careful reporting still matters.";

/** A longer audition: questions, a list, numbers, acronyms and a change of tone, to judge flow rather than one sentence. */
export const VOICE_PASSAGE_TEXT =
  "So why does the chip matter? Because NVIDIA's GPUs, not CPUs, now train almost every large model. A single RTX 5070 has 12 gigabytes of VRAM, and developers program it with CUDA. On March 3, 2026, one company reported $4.5B in revenue, up 38%. Here's the part nobody tells you: the models didn't get smarter. They got bigger. And honestly? That's both exciting and a little worrying.";

export type PreviewEngine = 'sherpa' | 'piper' | 'windows-sapi';

export interface VoicePreview {
  url: string;
  engine: PreviewEngine;
  /** The voice the engine actually used (always the one requested; anything else is an error). */
  voice: string;
  durationSec: number;
  /** True when served from the preview cache without re-synthesising. */
  cached: boolean;
}
