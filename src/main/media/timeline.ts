import type { SceneTiming, WordTiming } from './captions';
import { frameAlign, SCENE_PAD_SEC } from './render';

/** Music on its own before the first word (the intro accent plays here) and after the last word (the music fades). */
export const MUSIC_INTRO_SEC = 1.2;
export const MUSIC_OUTRO_SEC = 1.8;

export interface TimelineScene extends SceneTiming {
  /** Narration clip (relative path). */
  audio: string;
  /** Length of the narration clip. */
  speechSec: number;
  /** Where the narration starts inside the scene (the music intro on the first scene). */
  leadSec: number;
  /** Word timings relative to the clip (SceneTiming.words are shifted by leadSec, for captions). */
  clipWords: WordTiming[];
}

/**
 * The one video timeline, used by captions, the render, the mix and QA: each scene lasts its narration plus a short
 * pause; the first scene opens with a music-only intro and the last ends with a music-only outro.
 */
export function narrationTimeline(clips: { audio: string; durationSec: number; words: WordTiming[] }[]): TimelineScene[] {
  let offset = 0;
  return clips.map((c, i) => {
    const leadSec = i === 0 ? MUSIC_INTRO_SEC : 0;
    const tail = i === clips.length - 1 ? MUSIC_OUTRO_SEC : 0;
    const duration = frameAlign(leadSec + c.durationSec + SCENE_PAD_SEC + tail);
    const t: TimelineScene = { offset, duration, words: c.words.map((w) => ({ ...w, start: w.start + leadSec, end: w.end + leadSec })), audio: c.audio, speechSec: c.durationSec, leadSec, clipWords: c.words };
    offset += duration;
    return t;
  });
}
