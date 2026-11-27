// Scene-aware visual planning: decides, from each scene's narration, claims and sources, whether it
// is best shown with a licensed photo or an original explanatory graphic, and builds that graphic's
// content strictly from the scene's own (already source-grounded) narration.

import { SOURCE_KIND_LABELS, type Brief, type Scene, type Source } from '../../shared/production';
import type { GraphicSpec } from './graphics';

export type VisualKind = 'photo' | GraphicSpec['kind'];

export interface VisualPlan {
  kind: VisualKind;
  /** Content for a graphic (always set for graphic kinds; for photos it is the fallback graphic). */
  graphic: GraphicSpec;
  /** Search query for photo providers. */
  query: string;
  reason: string;
}

const NUM = /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(%|percent\b|x\b|×|times\b|million\b|billion\b|thousand\b|trillion\b|kilowatts?\b|megawatts?\b|gigawatts?\b|terawatt[- ]hours?\b|kW\b|MW\b|GW\b|TWh\b|GWh\b|MWh\b|kWh\b)?/gi;

const UNIT: Record<string, string> = { kilowatt: 'kW', kilowatts: 'kW', megawatt: 'MW', megawatts: 'MW', gigawatt: 'GW', gigawatts: 'GW', kw: 'kW', mw: 'MW', gw: 'GW', twh: 'TWh', gwh: 'GWh', mwh: 'MWh', kwh: 'kWh' };

interface Figure {
  raw: string;
  value: number;
  unit: string;
}

function figures(text: string): Figure[] {
  const out: Figure[] = [];
  for (const m of text.matchAll(NUM)) {
    const value = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    const u = (m[2] ?? '').toLowerCase();
    const unit = u === 'percent' ? '%' : u === '×' || u === 'times' ? 'x' : /^terawatt/.test(u) ? 'TWh' : (UNIT[u] ?? u);
    // Bare years and list numbers are not statistics.
    if (!unit && (value >= 1900 && value <= 2100)) continue;
    if (!unit && value < 10) continue;
    out.push({ raw: `${m[1]}${unit === '%' ? '%' : unit === 'x' ? '×' : unit ? ` ${unit}` : ''}`, value, unit });
  }
  return out;
}

const firstSentence = (s: string): string => (s.match(/^[^.!?]+[.!?]?/)?.[0] ?? s).trim();

/** Short process steps from narration like "a small model drafts tokens, then a larger model verifies them". */
function processSteps(text: string): string[] | null {
  if (!/\b(then|next|first|finally|afterwards|step)\b/i.test(text)) return null;
  const parts = text
    .replace(/[.!?]+$/, '')
    .split(/\s*(?:,\s*(?:and\s+)?then\b|;\s*|\.\s+|\bthen\b|\bnext\b|\bfinally\b)\s*/i)
    .map((p) => p.replace(/^(and|first|so)\s+/i, '').trim())
    .filter((p) => p.split(/\s+/).length >= 2);
  if (parts.length < 2 || parts.length > 4) return null;
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1));
}

const ATTRIBUTED = /\b(says?|said|according to|reports?|reported|claims?|argues?|estimates?|suggests?|warns?)\b/i;

/**
 * Plan one scene. `previous` is the kind chosen for the scene before, so the same treatment isn't
 * used twice in a row when a good alternative exists.
 */
export function planScene(scene: Scene, brief: Brief, sources: Source[], channelName: string, previous: VisualKind | null): VisualPlan {
  const cited = sources.filter((s) => scene.sourceIds.includes(s.id));
  const primary = cited[0];
  const publisher = primary?.publisher || (brief.claims ?? []).find((c) => scene.claimIds?.includes(c.id))?.attribution || 'the cited source';
  const query = scene.visualQuery || brief.topic;
  const sourceCard: GraphicSpec | null = primary
    ? { kind: 'source', publisher: primary.publisher, title: primary.title, sourceKind: SOURCE_KIND_LABELS[primary.kind ?? 'other'].toLowerCase(), line: firstSentence(scene.narration) }
    : null;
  const quote: GraphicSpec = { kind: 'quote', text: firstSentence(scene.narration), attribution: publisher };

  if (scene.role === 'hook') {
    return { kind: 'photo', query, graphic: { kind: 'title', kicker: brief.topic, text: scene.onScreenText || firstSentence(scene.narration) }, reason: 'hook: real image if a relevant licensed one exists, else a title graphic' };
  }
  if (scene.role === 'outro') {
    return { kind: 'sources', query, graphic: { kind: 'sources', brand: channelName, publishers: sources.filter((s) => s.kind !== 'community').map((s) => s.publisher) }, reason: 'outro: the sources behind the video' };
  }

  const figs = figures(scene.narration);
  const mult = figs.find((f) => f.unit === 'x');
  const pcts = figs.filter((f) => f.unit === '%');
  const candidates: VisualPlan[] = [];
  if (mult && mult.value > 1 && mult.value <= 1000) {
    candidates.push({
      kind: 'compare',
      query,
      graphic: { kind: 'compare', caption: scene.onScreenText || firstSentence(scene.narration), attribution: publisher, bars: [{ label: 'Before', value: 1, display: '1×' }, { label: 'Stated', value: mult.value, display: mult.raw }] },
      reason: `narration states a ${mult.raw} difference`
    });
  }
  if (pcts.length >= 2) {
    candidates.push({
      kind: 'compare',
      query,
      graphic: { kind: 'compare', caption: scene.onScreenText || firstSentence(scene.narration), attribution: publisher, bars: pcts.slice(0, 4).map((p, i) => ({ label: `Figure ${i + 1}`, value: p.value, display: p.raw })) },
      reason: 'narration states several percentages'
    });
  }
  if (figs.length) {
    candidates.push({ kind: 'stat', query, graphic: { kind: 'stat', value: figs[0].raw, label: scene.onScreenText || firstSentence(scene.narration), attribution: publisher }, reason: `narration states ${figs[0].raw}` });
  }
  const steps = processSteps(scene.narration);
  if (steps) candidates.push({ kind: 'steps', query, graphic: { kind: 'steps', title: scene.onScreenText || brief.topic, steps }, reason: 'narration describes a process' });
  if (ATTRIBUTED.test(scene.narration)) candidates.push({ kind: 'quote', query, graphic: quote, reason: 'attributed claim: shown as what the source says' });
  candidates.push({ kind: 'photo', query, graphic: sourceCard ?? quote, reason: 'concrete subject: licensed photo if a relevant one exists' });
  if (sourceCard) candidates.push({ kind: 'source', query, graphic: sourceCard, reason: 'show where the claim comes from' });
  candidates.push({ kind: 'quote', query, graphic: quote, reason: 'key point, credited to its source' });

  // Avoid repeating what the previous scene showed; a photo plan that fell back counts as its fallback graphic.
  const repeats = (c: VisualPlan) => c.kind === previous || (c.kind === 'photo' && previous !== 'photo' && c.graphic.kind === previous);
  return candidates.find((c) => !repeats(c)) ?? candidates[0];
}

export const isGraphicKind = (k: VisualKind): k is GraphicSpec['kind'] => k !== 'photo';
