import type { ContextualEffect } from '../../shared/audioMix';
import type { AudioTrack } from '../../shared/production';
import type { SoundLibrary } from '../library';
import { ProductionFailure } from '../pipeline/failures';

/** Upper bound on approved effects per production (they are deliberate, contextual accents, not a pattern). */
export const MAX_EFFECTS = 12;

/**
 * Validate a list of contextual effects for one production. Every effect must be an approved sound effect that passes
 * the live rights check (revalidate). Used when you approve them and again at render time (fail closed).
 */
export function resolveEffects(library: SoundLibrary, effects: ContextualEffect[], totalSec?: number): { track: AudioTrack; path: string; atSec: number; note: string }[] {
  if (effects.length > MAX_EFFECTS) throw new ProductionFailure('audio', 'too-many-effects', `At most ${MAX_EFFECTS} contextual effects can be approved for one production.`);
  return effects.map((e) => {
    let track: AudioTrack;
    try {
      track = library.get(e.trackId);
    } catch {
      throw new ProductionFailure('rights', 'effect-missing', `Sound effect ${e.trackId} is no longer in the library.`);
    }
    if (track.kind !== 'sfx') throw new ProductionFailure('audio', 'effect-not-sfx', `"${track.title}" is music, not a sound effect.`);
    const r = library.revalidate(track.id);
    if (!r.ok) throw new ProductionFailure('rights', 'effect-not-approved', `Contextual effect blocked: ${r.reason}`);
    if (!Number.isFinite(e.atSec) || e.atSec < 0 || (totalSec !== undefined && e.atSec >= totalSec)) throw new ProductionFailure('audio', 'effect-bad-time', `"${track.title}" is placed at ${e.atSec}s, outside the video.`);
    return { track, path: library.pathOf(track), atSec: e.atSec, note: e.note };
  });
}
