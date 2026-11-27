import path from 'node:path';
import { PLATFORMS, type AutonomySettings, type Platform, type Privacy } from '../shared/operations';
import { LIMITS, isStage, type ContentDraft, type ContentPatch, type Stage } from '../shared/domain';
import {
  KOKORO_VOICES,
  RESEARCH_PROVIDERS,
  MUSIC_MODES,
  NARRATORS,
  PIPER_VOICES,
  SOUND_GENERATORS,
  VISUAL_PROVIDERS,
  WRITERS,
  type AudioKind,
  type ProductionMode,
  type Pronunciation,
  type AudioTrackPatch,
  type PiperVoiceId,
  type SoundGeneratorId,
  isStepName,
  type NewProduction,
  type ProviderSettings,
  type StepName
} from '../shared/production';

/** Thrown for malformed input from the renderer. The renderer is treated as untrusted. */
export class ValidationError extends Error {}

export function id(v: unknown, name = 'id'): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
    throw new ValidationError(`${name} must be a positive integer`);
  }
  return v;
}

export function stage(v: unknown): Stage {
  if (!isStage(v)) throw new ValidationError('Unknown stage');
  return v;
}

export function stages(v: unknown): Stage[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new ValidationError('stages must be an array');
  return v.map(stage);
}

function text(v: unknown, field: keyof typeof LIMITS, required: boolean): string | undefined {
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string') throw new ValidationError(`${field} must be text`);
  const s = field === 'title' ? v.trim() : v;
  if (required && s.length === 0) throw new ValidationError(`${field} is required`);
  if (s.length > LIMITS[field]) throw new ValidationError(`${field} exceeds ${LIMITS[field]} characters`);
  return s;
}

function object(v: unknown, name: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ValidationError(`${name} must be an object`);
  return v as Record<string, unknown>;
}

export function draft(v: unknown): ContentDraft {
  const o = object(v, 'draft');
  return {
    title: text(o.title, 'title', true)!,
    summary: text(o.summary, 'summary', false),
    researchNotes: text(o.researchNotes, 'researchNotes', false),
    script: text(o.script, 'script', false)
  };
}

export function patch(v: unknown): ContentPatch {
  const o = object(v, 'patch');
  const p: ContentPatch = {};
  if (o.title !== undefined) p.title = text(o.title, 'title', true);
  if (o.summary !== undefined) p.summary = text(o.summary, 'summary', false);
  if (o.researchNotes !== undefined) p.researchNotes = text(o.researchNotes, 'researchNotes', false);
  if (o.script !== undefined) p.script = text(o.script, 'script', false);
  return p;
}

// ---- Video Factory -------------------------------------------------------

export function newProduction(v: unknown): NewProduction {
  const o = object(v, 'production');
  const topic = text(o.topic, 'title', true)!;
  const mode: ProductionMode | undefined = o.mode === undefined ? undefined : o.mode === 'news' || o.mode === 'explainer' ? o.mode : (() => {
    throw new ValidationError('Mode must be explainer or news');
  })();
  return { topic, contentId: o.contentId === undefined || o.contentId === null ? undefined : id(o.contentId, 'contentId'), ...(mode ? { mode } : {}) };
}

export function stepName(v: unknown): StepName {
  if (!isStepName(v)) throw new ValidationError('Unknown production step');
  return v;
}

const str = (v: unknown, name: string, max: number): string => {
  if (typeof v !== 'string') throw new ValidationError(`${name} must be text`);
  if (v.length > max) throw new ValidationError(`${name} is too long`);
  return v.trim();
};
const httpUrl = (v: unknown, name: string): string => {
  const s = str(v, name, 500);
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
  } catch {
    throw new ValidationError(`${name} must be an http(s) URL`);
  }
  return s;
};
const num = (v: unknown, name: string, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new ValidationError(`${name} must be between ${min} and ${max}`);
  return v;
};
const filePath = (v: unknown, name: string, exts: RegExp): string => {
  const s = str(v, name, 1000);
  if (s && (!path.isAbsolute(s) || !exts.test(s))) throw new ValidationError(`${name} must be an absolute path to a ${exts.source} file`);
  return s;
};

export function settings(v: unknown): ProviderSettings {
  const o = object(v, 'settings');
  if (!(WRITERS as readonly unknown[]).includes(o.writer)) throw new ValidationError('Unknown writer');
  if (!(NARRATORS as readonly unknown[]).includes(o.narration)) throw new ValidationError('Unknown narration provider');
  if (!(MUSIC_MODES as readonly unknown[]).includes(o.musicMode)) throw new ValidationError('Unknown music mode');
  if (typeof o.sfxTransitions !== 'boolean') throw new ValidationError('sfxTransitions must be true or false');
  if (!Array.isArray(o.visuals) || o.visuals.some((x) => !(VISUAL_PROVIDERS as readonly unknown[]).includes(x))) {
    throw new ValidationError('Unknown visual provider');
  }
  if (!Array.isArray(o.researchProviders) || o.researchProviders.some((x) => !RESEARCH_PROVIDERS.some((r) => r.id === x))) {
    throw new ValidationError('Unknown research provider');
  }
  if (!KOKORO_VOICES.some((k) => k.id === o.sherpaVoice)) throw new ValidationError('Unknown Kokoro voice');
  if (typeof o.allowShareAlike !== 'boolean') throw new ValidationError('allowShareAlike must be true or false');
  const researchProviders = [...new Set(o.researchProviders as ProviderSettings['researchProviders'])];
  return {
    wikipediaResearch: researchProviders.includes('wikipedia'),
    researchProviders,
    newsWindowDays: Math.round(num(o.newsWindowDays, 'News window', 1, 365)),
    writer: o.writer as ProviderSettings['writer'],
    llmBaseUrl: httpUrl(o.llmBaseUrl, 'LLM base URL'),
    llmModel: str(o.llmModel, 'LLM model', 200),
    llmTimeoutSec: Math.round(num(o.llmTimeoutSec, 'LLM timeout', 10, 1800)),
    writerFallback: (() => {
      if (typeof o.writerFallback !== 'boolean') throw new ValidationError('writerFallback must be true or false');
      return o.writerFallback;
    })(),
    narration: o.narration as ProviderSettings['narration'],
    voice: str(o.voice, 'Voice', 200),
    speechRate: Math.round(num(o.speechRate, 'Speech rate', -10, 10)),
    piperPath: filePath(o.piperPath, 'Piper path', /\.exe$/i),
    piperVoice: filePath(o.piperVoice, 'Piper voice', /\.onnx$/i),
    sherpaVoice: o.sherpaVoice as ProviderSettings['sherpaVoice'],
    sentencePauseSec: num(o.sentencePauseSec, 'Sentence pause', 0.15, 0.8),
    pronunciations: pronunciations(o.pronunciations),
    voiceWordsPerSec: num(o.voiceWordsPerSec, 'Voice speed', 0, 5),
    visuals: [...new Set(o.visuals as ProviderSettings['visuals'])],
    comfyUrl: httpUrl(o.comfyUrl, 'ComfyUI URL'),
    comfyCheckpoint: str(o.comfyCheckpoint, 'ComfyUI checkpoint', 300),
    musicMode: o.musicMode as ProviderSettings['musicMode'],
    musicTrackId:
      o.musicMode === 'track' ? id(o.musicTrackId, 'Music track') : typeof o.musicTrackId === 'number' && o.musicTrackId >= 0 ? Math.floor(o.musicTrackId) : 0,
    musicVolume: num(o.musicVolume, 'Music volume', 0, 1),
    sfxTransitions: o.sfxTransitions,
    sfxVolume: num(o.sfxVolume, 'Effect volume', 0, 1),
    allowShareAlike: o.allowShareAlike,
    ffmpegPath: filePath(o.ffmpegPath, 'FFmpeg path', /\.exe$/i)
  };
}

export function audioKind(v: unknown): AudioKind {
  if (v !== 'music' && v !== 'sfx') throw new ValidationError('Sound kind must be music or sfx');
  return v;
}

export function generatorId(v: unknown): SoundGeneratorId {
  if (!SOUND_GENERATORS.some((g) => g.id === v)) throw new ValidationError('Unknown sound generator');
  return v as SoundGeneratorId;
}

export function piperVoiceId(v: unknown): PiperVoiceId {
  if (!PIPER_VOICES.some((x) => x.id === v)) throw new ValidationError('Unknown Piper voice');
  return v as PiperVoiceId;
}

export function trackPatch(v: unknown): AudioTrackPatch {
  const o = object(v, 'sound');
  const p: AudioTrackPatch = {};
  if (o.title !== undefined) {
    p.title = str(o.title, 'Title', 200);
    if (!p.title) throw new ValidationError('Title is required');
  }
  if (o.license !== undefined) p.license = str(o.license, 'Licence', 300);
  if (o.attribution !== undefined) p.attribution = str(o.attribution, 'Attribution', 500);
  if (o.sourceUrl !== undefined) p.sourceUrl = o.sourceUrl === '' ? '' : httpUrl(o.sourceUrl, 'Source URL');
  if (o.commercialUse !== undefined) {
    if (!['yes', 'no', 'unknown'].includes(o.commercialUse as string)) throw new ValidationError('Commercial use must be yes, no or unknown');
    p.commercialUse = o.commercialUse as AudioTrackPatch['commercialUse'];
  }
  if (o.tags !== undefined) {
    if (!Array.isArray(o.tags) || o.tags.length > 20) throw new ValidationError('Tags must be a list');
    p.tags = o.tags.map((t) => str(t, 'Tag', 40).toLowerCase()).filter(Boolean);
  }
  return p;
}

export function pronunciations(v: unknown): Pronunciation[] {
  if (!Array.isArray(v) || v.length > 300) throw new ValidationError('Pronunciations must be a list (max 300)');
  return v.map((x) => {
    const o = object(x, 'pronunciation');
    const term = str(o.term, 'Term', 60);
    const say = str(o.say, 'Pronunciation', 120);
    if (!term || !say) throw new ValidationError('Each pronunciation needs a term and how to say it');
    return { term, say };
  });
}

// ---- 0.5 operations ---------------------------------------------------------

export function platform(v: unknown): Platform {
  if (!(PLATFORMS as readonly unknown[]).includes(v)) throw new ValidationError('Unknown platform');
  return v as Platform;
}
export function privacy(v: unknown): Privacy {
  if (v !== 'private' && v !== 'public' && v !== 'unlisted') throw new ValidationError('Privacy must be private, public or unlisted');
  return v;
}
export function bool(v: unknown): boolean {
  if (typeof v !== 'boolean') throw new ValidationError('Expected true or false');
  return v;
}
export function handle(v: unknown): string {
  const h = str(v, 'Handle', 80).replace(/^@/, '');
  if (!/^[A-Za-z0-9._-]{2,60}$/.test(h)) throw new ValidationError('Handle may contain letters, numbers, dots, underscores and dashes');
  return h;
}
export function shortText(v: unknown, name: string, max: number): string {
  return str(v ?? '', name, max);
}
export function incidentKind(v: unknown): 'rights_complaint' | 'incident' {
  if (v !== 'rights_complaint' && v !== 'incident') throw new ValidationError('Unknown incident kind');
  return v;
}
export function presenter(engine: unknown, voice: unknown): { engine: string; voice: string } {
  if (engine === 'sherpa') {
    if (!KOKORO_VOICES.some((k) => k.id === voice)) throw new ValidationError('Unknown Kokoro voice');
    return { engine, voice: voice as string };
  }
  if (engine === 'windows-sapi') return { engine, voice: str(voice, 'Voice', 200) };
  if (engine === 'global') return { engine, voice: '' };
  throw new ValidationError('Unknown presenter engine');
}
export function autonomy(v: unknown): AutonomySettings {
  const o = object(v, 'autonomy');
  const b = (k: string) => {
    if (typeof o[k] !== 'boolean') throw new ValidationError(`${k} must be true or false`);
    return o[k] as boolean;
  };
  return {
    enabled: b('enabled'),
    runAtStartup: b('runAtStartup'),
    keepRunningInTray: b('keepRunningInTray'),
    discoveryEveryHours: num(o.discoveryEveryHours, 'Discovery interval', 1, 168),
    maxProductionsPerDay: Math.round(num(o.maxProductionsPerDay, 'Productions per day', 0, 24)),
    activeFromHour: Math.round(num(o.activeFromHour, 'Start hour', 0, 23)),
    activeToHour: Math.round(num(o.activeToHour, 'End hour', 0, 24)),
    minIdeaScore: Math.round(num(o.minIdeaScore, 'Minimum score', 0, 100)),
    maxIdeasKept: Math.round(num(o.maxIdeasKept, 'Ideas kept', 5, 500)),
    maxRepairRounds: Math.round(num(o.maxRepairRounds, 'Repair rounds', 0, 5)),
    autoPublish: o.autoPublish === undefined ? false : b('autoPublish')
  };
}

export function platformApp(v: unknown): { clientId?: string; clientSecret?: string; redirectPort?: number; accessToken?: string; publicVideoBaseUrl?: string } {
  const o = object(v, 'app');
  const opt = (k: string, max: number) => (o[k] === undefined ? undefined : str(o[k], k, max));
  const base = opt('publicVideoBaseUrl', 500);
  if (base && !/^https:\/\/[^\s]+$/.test(base)) throw new ValidationError('The public video location must be an https:// URL');
  return {
    clientId: opt('clientId', 300),
    clientSecret: opt('clientSecret', 500),
    accessToken: opt('accessToken', 1000),
    redirectPort: o.redirectPort === undefined ? undefined : Math.round(num(o.redirectPort, 'Redirect port', 0, 65535)),
    publicVideoBaseUrl: base
  };
}
