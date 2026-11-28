/**
 * Voice/music mix profiles. Levels are loudness targets (LUFS), not volume percentages: every narration clip,
 * music track and effect is measured first and brought to its target, so a profile sounds the same with any
 * voice or track. Narration is always -16 LUFS (the platform norm) and always dominant.
 */
export type MixProfileId = 'balanced' | 'voice-forward' | 'music-forward';

export interface MixProfile {
  id: MixProfileId;
  label: string;
  description: string;
  /** Music loudness when nobody is speaking (intro, pauses, outro). */
  musicOpenLufs: number;
  /** How far the music is ducked under speech (dB). */
  duckDb: number;
  /** Ducking attack/release (s): the music starts dipping attackSec before a phrase and recovers over releaseSec. */
  attackSec: number;
  releaseSec: number;
  /** Pauses shorter than this stay ducked, so the music never pumps between words. */
  holdGapSec: number;
  /** Peak level (dBFS) of an approved contextual effect. Narration peaks near -2 dBFS. */
  effectPeakDb: number;
  /** QA: acceptable voice-over-music separation during speech, phone band (dB). */
  separationDb: [number, number];
}

export const NARRATION_LUFS = -16;
export const MUSIC_FADE_IN_SEC = 0.8;
export const MUSIC_FADE_OUT_SEC = 2.0;

export const MIX_PROFILES: Record<MixProfileId, MixProfile> = {
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    description: 'Music clearly present between lines and softly under the voice. Recommended.',
    musicOpenLufs: -24,
    duckDb: 9,
    attackSec: 0.25,
    releaseSec: 0.7,
    holdGapSec: 0.45,
    effectPeakDb: -20,
    separationDb: [11, 23]
  },
  'voice-forward': {
    id: 'voice-forward',
    label: 'Voice-forward',
    description: 'Quieter music and deeper ducking for dense, fact-heavy narration.',
    musicOpenLufs: -26,
    duckDb: 11,
    attackSec: 0.3,
    releaseSec: 0.8,
    holdGapSec: 0.5,
    effectPeakDb: -22,
    separationDb: [14, 26]
  },
  'music-forward': {
    id: 'music-forward',
    label: 'Music-forward',
    description: 'More music energy; the voice still leads. For lighter, upbeat stories.',
    musicOpenLufs: -22,
    duckDb: 7,
    attackSec: 0.25,
    releaseSec: 0.6,
    holdGapSec: 0.4,
    effectPeakDb: -18,
    separationDb: [9, 20]
  }
};

export const DEFAULT_MIX_PROFILE: MixProfileId = 'balanced';

/**
 * A contextual sound effect explicitly chosen and approved for one production (there are no automatic effects:
 * no transitions, risers, pops or stingers). It must be an approved library sound and passes the rights check again
 * at render time.
 */
export interface ContextualEffect {
  trackId: number;
  /** Where it starts on the video timeline (s). */
  atSec: number;
  /** Why it belongs in this scene (shown in the audit log). */
  note: string;
}

export interface ProductionEffects {
  effects: ContextualEffect[];
  approvedAt: string;
}

export const mixProfile = (id: string | undefined | null): MixProfile => MIX_PROFILES[(id as MixProfileId) ?? DEFAULT_MIX_PROFILE] ?? MIX_PROFILES[DEFAULT_MIX_PROFILE];

/** The mandatory audio checks. A production cannot complete, reach review, be approved or be published unless every one passed. */
export const AUDIO_GATE_CHECKS = [
  'audio.analysis',
  'audio.encoding',
  'audio.mix-integrity',
  'audio.narration-present',
  'audio.narration-consistency',
  'audio.music-present',
  'audio.music-under-speech',
  'audio.ducking',
  'audio.smoothness',
  'audio.sfx',
  'audio.peaks',
  'audio.silence'
] as const;

/** Summary finding: passed only when every gate check passed on the decoded final render. */
export const AUDIO_GATE_ID = 'audio.gate';

/** Version of the audio pipeline. Production stays frozen until a verification render passes on this version. */
export const AUDIO_PIPELINE_VERSION = 2;
