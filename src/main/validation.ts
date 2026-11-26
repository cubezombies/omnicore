import { LIMITS, isStage, type ContentDraft, type ContentPatch, type Stage } from '../shared/domain';

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
