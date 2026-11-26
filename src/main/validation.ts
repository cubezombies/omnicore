import path from 'node:path';
import { LIMITS, isStage, type ContentDraft, type ContentPatch, type Stage } from '../shared/domain';
import {
  MUSIC_MODES,
  NARRATORS,
  PIPER_VOICES,
  SOUND_GENERATORS,
  VISUAL_PROVIDERS,
  WRITERS,
  type AudioKind,
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
  return { topic, contentId: o.contentId === undefined || o.contentId === null ? undefined : id(o.contentId, 'contentId') };
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
  if (typeof o.wikipediaResearch !== 'boolean') throw new ValidationError('wikipediaResearch must be true or false');
  return {
    wikipediaResearch: o.wikipediaResearch,
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
    visuals: [...new Set(o.visuals as ProviderSettings['visuals'])],
    comfyUrl: httpUrl(o.comfyUrl, 'ComfyUI URL'),
    comfyCheckpoint: str(o.comfyCheckpoint, 'ComfyUI checkpoint', 300),
    musicMode: o.musicMode as ProviderSettings['musicMode'],
    musicTrackId:
      o.musicMode === 'track' ? id(o.musicTrackId, 'Music track') : typeof o.musicTrackId === 'number' && o.musicTrackId >= 0 ? Math.floor(o.musicTrackId) : 0,
    musicVolume: num(o.musicVolume, 'Music volume', 0, 1),
    sfxTransitions: o.sfxTransitions,
    sfxVolume: num(o.sfxVolume, 'Effect volume', 0, 1),
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
  if (o.tags !== undefined) {
    if (!Array.isArray(o.tags) || o.tags.length > 20) throw new ValidationError('Tags must be a list');
    p.tags = o.tags.map((t) => str(t, 'Tag', 40).toLowerCase()).filter(Boolean);
  }
  return p;
}
