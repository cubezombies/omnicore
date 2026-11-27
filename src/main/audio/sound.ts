import type { AudioTrack, Storyboard } from '../../shared/production';

/**
 * Sound design rules shared by the pipeline, QA and the library: which mood a story calls for, which licences can be
 * mixed into a video, and where accents go. Pure functions, so they are tested without audio.
 */

export const MOODS = ['calm', 'upbeat', 'tense', 'inspiring'] as const;
export type Mood = (typeof MOODS)[number];

/** Library tags that count as each mood. */
export const MOOD_TAGS: Record<Mood, string[]> = {
  calm: ['calm', 'ambient', 'soft', 'chill'],
  upbeat: ['upbeat', 'tech', 'energetic', 'news', 'electronic'],
  tense: ['tense', 'dark', 'suspense', 'cinematic'],
  inspiring: ['inspiring', 'uplifting', 'hopeful', 'corporate']
};

/** What to search for when the library has nothing for a mood (instrumental beds, never songs). */
export const MOOD_QUERIES: Record<Mood, string> = {
  calm: 'ambient instrumental',
  upbeat: 'electronic instrumental',
  tense: 'dark ambient',
  inspiring: 'inspiring instrumental'
};

const TENSE = /\b(attack|breach|hack(ed|ers)?|lawsuit|sued|ban(ned|s)?|warn(s|ing)?|risk|threat|danger|crash|fail(s|ed|ure)?|layoffs?|fraud|exploit|vulnerab\w*|scandal)\b/i;
const INSPIRING = /\b(breakthrough|record|first[- ]ever|launch(es|ed)?|discover(s|ed|y)?|cure|milestone|beats?|surpass\w*|wins?|award)\b/i;

/**
 * The mood a story calls for: its subject first (a breach is tense, a breakthrough inspiring), then its pace
 * (news or brisk narration is upbeat, a slower explainer calm). A business's preferred moods break ties.
 */
export function storyMood(sb: Pick<Storyboard, 'scenes'> & { title?: string }, mode: 'news' | 'explainer', wordsPerSec: number, preferred: Mood[] = []): Mood {
  const text = `${sb.title ?? ''} ${sb.scenes.map((s) => s.narration).join(' ')}`;
  const tense = (text.match(new RegExp(TENSE, 'gi')) ?? []).length;
  const inspiring = (text.match(new RegExp(INSPIRING, 'gi')) ?? []).length;
  let mood: Mood = mode === 'news' || wordsPerSec > 2.6 ? 'upbeat' : 'calm';
  if (tense >= 2 && tense > inspiring) mood = 'tense';
  else if (inspiring >= 2 && inspiring > tense) mood = 'inspiring';
  if (preferred.length && !preferred.includes(mood)) {
    // Keep the story's energy but stay inside the business's sound: calm↔inspiring, upbeat↔tense.
    const near: Record<Mood, Mood[]> = { calm: ['inspiring', 'upbeat'], inspiring: ['calm', 'upbeat'], upbeat: ['inspiring', 'tense'], tense: ['upbeat', 'calm'] };
    mood = near[mood].find((m) => preferred.includes(m)) ?? preferred[0];
  }
  return mood;
}

/** Creative Commons licences that allow commercial use and syncing to video. NC, ND and (by default) SA are refused. */
export function clearedLicence(license: string, allowShareAlike = false): { ok: boolean; attribution: boolean; reason: string } {
  const l = license.toLowerCase().replace(/^cc[- ]?/, '');
  if (l === 'cc0' || l === '0' || l === 'pdm' || l === 'publicdomain') return { ok: true, attribution: false, reason: 'public domain dedication' };
  if (l === 'by') return { ok: true, attribution: true, reason: 'commercial use and adaptation allowed with credit' };
  if (l === 'by-sa') return allowShareAlike ? { ok: true, attribution: true, reason: 'share-alike allowed by settings' } : { ok: false, attribution: true, reason: 'share-alike would bind the whole video to the same licence' };
  if (/nc/.test(l)) return { ok: false, attribution: true, reason: 'non-commercial only' };
  if (/nd/.test(l)) return { ok: false, attribution: true, reason: 'no adaptations: music cannot be synced to video' };
  return { ok: false, attribution: true, reason: `unknown licence "${license}"` };
}

/** Titles and tags that suggest singing, which would compete with the narration. */
export const VOCAL = /\b(vocals?|voice|feat\.?|ft\.|featuring|sings?|singer|song|lyrics?|rap|acapella|a cappella|choir)\b/i;

export interface Cue {
  role: 'intro' | 'transition' | 'outro';
  atSec: number;
}

/**
 * Where accents go: a short riser into the first word, a whoosh slightly before each cut (it peaks on the cut), and a
 * soft accent as the outro begins. Accents never land on top of a word in the first or last half-second.
 */
export function soundCues(sceneDurations: number[], opts: { intro: boolean; transitions: boolean; outro: boolean; transitionLead?: number }): Cue[] {
  const out: Cue[] = [];
  if (opts.intro && sceneDurations.length) out.push({ role: 'intro', atSec: 0 });
  let t = 0;
  sceneDurations.forEach((d, i) => {
    if (i > 0 && opts.transitions && i < sceneDurations.length - 1) out.push({ role: 'transition', atSec: Math.max(0, t - (opts.transitionLead ?? 0.3)) });
    if (i > 0 && i === sceneDurations.length - 1 && opts.outro) out.push({ role: 'outro', atSec: t });
    t += d;
  });
  return out;
}

/** Can this track be used for a production going to these platforms? Platform-only tracks never leave their platform. */
export function allowedFor(t: Pick<AudioTrack, 'usage' | 'restrictions'>, platforms: string[]): { ok: boolean; blocked: string[] } {
  if (t.usage === 'platform_native') return { ok: false, blocked: platforms };
  const only = t.restrictions.platforms ?? [];
  const blocked = only.length ? platforms.filter((p) => !only.includes(p)) : [];
  return { ok: blocked.length === 0, blocked };
}
