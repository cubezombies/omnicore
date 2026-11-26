// Deterministic text tools: cleaning, sentence splitting, fact selection.
// Facts are always verbatim (cleaned) sentences from a cited source: nothing is invented.

import type { Brief, KeyFact, Scene, Source, Storyboard } from '../../shared/production';

const STOP = new Set(
  'a an and are as at be been but by can could did do does for from had has have how in into is it its of on or that the their them then there these they this to was were what when where which while who why will with would about after also between both during each more most other over such than through under up very you your typically especially usually often generally including known used based called many several various particular however although because since within without among around another using made make makes like just even work works explained explain'.split(
    ' '
  )
);

export function cleanText(t: string): string {
  let s = t.replace(/\[\d+\]|\[citation needed\]/gi, ' ');
  // Drop parentheticals (pronunciations, dates in brackets), innermost first.
  for (let i = 0; i < 3; i++) s = s.replace(/\s*\([^()]*\)/g, '');
  return s.replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
}

export function splitSentences(t: string): string[] {
  return cleanText(t)
    .split(/(?<=[.!?])\s+(?=["“A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;

export function keywords(s: string, max = 3): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of s.split(/[^\p{L}\p{N}-]+/u)) {
    const w = raw.replace(/^-+|-+$/g, '');
    const k = w.toLowerCase();
    if (w.length < 3 || STOP.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  // Prefer capitalised terms and longer words: they tend to be the subject.
  return out
    .map((w, i) => ({ w, score: (/^[A-Z]/.test(w) ? 3 : 0) + Math.min(w.length, 10) / 3 - i * 0.05 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.w);
}

const PRONOUN_START = /^(It|Its|This|That|These|Those|They|Their|He|She|His|Her|Such|Here|There)\b/;

/** Search-engine friendly terms: significant words only, original casing (Commons search ANDs every word). */
export const searchTerms = (s: string): string =>
  [...new Set(s.split(/[^\p{L}\p{N}-]+/u).filter((w) => w.length > 2 && !STOP.has(w.toLowerCase())))].join(' ');

/** Lower-cased significant words with a light plural strip, for overlap checks. */
export const significantTokens = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map((w) => w.replace(/(ies)$/, 'y').replace(/(?<=[a-z]{3})l?s$/, ''))
  );

const tokens = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 2 && !STOP.has(w)));
const jaccard = (a: Set<string>, b: Set<string>) => {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
};

export const titleCase = (s: string): string =>
  s
    .trim()
    .split(/\s+/)
    .map((w, i) => (i > 0 && STOP.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');

export class InsufficientResearchError extends Error {}

/** Pick 2–5 short, self-contained sentences from the sources (≈ 45–60 s of narration). */
export function selectFacts(topic: string, sources: Source[], maxFacts = 5, maxWords = 120): KeyFact[] {
  const topicTokens = tokens(topic);
  const cands: { text: string; sourceId: string; score: number; rank: number; pos: number; tok: Set<string> }[] = [];
  sources.forEach((src, rank) => {
    splitSentences(src.excerpt).forEach((text, pos) => {
      const wc = wordCount(text);
      if (wc < 7 || wc > 32) return;
      if (pos > 0 && PRONOUN_START.test(text)) return; // needs context we would have to invent
      if (/may refer to|disambiguation|^see also/i.test(text)) return;
      if (!/[.!?]$/.test(text)) return;
      const tok = tokens(text);
      let overlap = 0;
      for (const t of topicTokens) if (tok.has(t)) overlap++;
      const score = overlap * 2 + (3 - Math.min(pos, 3)) + (2 - Math.min(rank, 2));
      cands.push({ text, sourceId: src.id, score, rank, pos, tok });
    });
  });
  const chosen: typeof cands = [];
  let words = 0;
  for (const c of [...cands].sort((a, b) => b.score - a.score)) {
    if (chosen.length >= maxFacts) break;
    if (chosen.some((x) => jaccard(x.tok, c.tok) > 0.45)) continue;
    const wc = wordCount(c.text);
    if (words + wc > maxWords && chosen.length >= 2) continue;
    chosen.push(c);
    words += wc;
  }
  if (chosen.length < 2) {
    throw new InsufficientResearchError(
      `The research sources did not contain enough usable facts about "${topic}". Try a more specific topic or add research notes.`
    );
  }
  chosen.sort((a, b) => a.rank - b.rank || a.pos - b.pos);
  return chosen.map((c) => ({ text: c.text, sourceId: c.sourceId }));
}

export function buildBrief(topic: string, sources: Source[], channelNiche: string): Brief {
  const keyFacts = selectFacts(topic, sources);
  const words = keyFacts.reduce((s, f) => s + wordCount(f.text), 0) + 20;
  return {
    topic,
    title: `${titleCase(topic)}, explained`,
    angle: `A fast, sourced explainer on ${topic}: only what the cited sources say.`,
    audience: `Short-form viewers interested in ${channelNiche || 'the topic'}`,
    keyFacts,
    targetSeconds: Math.round(words / 2.5)
  };
}

/** Writer that needs no AI: narration is the selected facts, verbatim, with a neutral hook and outro. */
export function extractiveStoryboard(brief: Brief, channelName: string): Storyboard {
  const display = titleCase(brief.topic);
  const scenes: Scene[] = [
    { index: 0, role: 'hook', narration: `Let's talk about ${brief.topic}, in under a minute.`, onScreenText: display, visualQuery: brief.topic, sourceIds: [] },
    ...brief.keyFacts.map(
      (f, i): Scene => ({
        index: i + 1,
        role: 'fact',
        narration: f.text,
        onScreenText: keywords(f.text, 3).join(' · '),
        visualQuery: [brief.topic, ...keywords(f.text, 2).filter((k) => !brief.topic.toLowerCase().includes(k.toLowerCase()))].join(' '),
        sourceIds: [f.sourceId]
      })
    )
  ];
  scenes.push({
    index: scenes.length,
    role: 'outro',
    narration: `Sources are in the description. Follow ${channelName} for more.`,
    onScreenText: `Follow ${channelName}`,
    visualQuery: brief.topic,
    sourceIds: []
  });
  return { title: brief.title, writer: 'extractive', scenes };
}

export class InvalidStoryboardError extends Error {}

/** Structural and citation checks applied to every writer's output. */
export function validateStoryboard(sb: Storyboard, sources: Source[]): Storyboard {
  const ids = new Set(sources.map((s) => s.id));
  if (!sb.title?.trim()) throw new InvalidStoryboardError('Storyboard has no title.');
  if (!Array.isArray(sb.scenes) || sb.scenes.length < 3 || sb.scenes.length > 10) {
    throw new InvalidStoryboardError(`Storyboard needs 3–10 scenes (got ${sb.scenes?.length ?? 0}).`);
  }
  if (sb.scenes[0].role !== 'hook' || sb.scenes[sb.scenes.length - 1].role !== 'outro') {
    throw new InvalidStoryboardError('Storyboard must start with a hook scene and end with an outro scene.');
  }
  const facts = sb.scenes.filter((s) => s.role === 'fact');
  if (facts.length < 2) throw new InvalidStoryboardError('Storyboard needs at least two fact scenes.');
  sb.scenes.forEach((s, i) => {
    if (s.index !== i) throw new InvalidStoryboardError(`Scene ${i} has index ${s.index}.`);
    if (!['hook', 'fact', 'outro'].includes(s.role)) throw new InvalidStoryboardError(`Scene ${i} has unknown role "${s.role}".`);
    if (typeof s.narration !== 'string' || s.narration.trim().length < 3 || s.narration.length > 400) {
      throw new InvalidStoryboardError(`Scene ${i} narration must be 3–400 characters.`);
    }
    if (s.role === 'fact' && (!s.sourceIds?.length || s.sourceIds.some((id) => !ids.has(id)))) {
      throw new InvalidStoryboardError(`Scene ${i} states a fact without citing a known source.`);
    }
  });
  return sb;
}

// ---- Grounding: reject claims the cited sources do not support ------------

const normNum = (n: string) => n.replace(/[,\s]/g, '').replace(/\.$/, '');
const numbersIn = (s: string) => (s.match(/\d[\d,]*(?:\.\d+)?%?/g) ?? []).map(normNum);

const COMMON_OPENERS = new Set(
  "let imagine picture think here here's now today so but yet still instead meanwhile basically simply essentially ever every most many some all one two three first second next finally then under behind inside without unlike just even turns that's it's you you're your we our let's ready stay follow sources source want need curious ok okay yes no not why what how who when where which whether if once while because though although and or nor for after before during since until unless as at by in on of to with from into over the a an this that these those it its they them their he she his her i me my is are was were be been being do does did have has had can could will would should may might must each other another such more less fewer few both either neither every same different new old big small huge tiny real really actually suddenly instead whatever whoever however wait look listen remember notice consider meet say said".split(
    ' '
  )
);

/**
 * Proper nouns / acronyms: capitalised words not at a sentence start, ALL-CAPS
 * tokens anywhere, and sentence-initial capitalised words that are not common
 * sentence openers (e.g. "Google built…").
 */
export function namedTermsIn(s: string): string[] {
  const out: string[] = [];
  const re = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const w = m[0].replace(/['’]s$/, '');
    const before = s.slice(0, m.index).trimEnd();
    const sentenceStart = before === '' || /[.!?:"“]$/.test(before);
    const acronym = /^[A-Z][A-Z0-9-]+$/.test(w) && w.length >= 2;
    const capital = /^[A-Z]/.test(w) && w.length > 1;
    const opener = sentenceStart && COMMON_OPENERS.has(w.toLowerCase());
    if (acronym || (capital && !opener && (!sentenceStart || /[A-Z0-9]/.test(w.slice(1)) || !STOP.has(w.toLowerCase())))) out.push(w);
  }
  return out;
}

const stem = (w: string) => w.toLowerCase().replace(/['’]s$/, '').replace(/(ies)$/, 'y').replace(/(?<=[a-z]{3})(es|s)$/, '');

export interface GroundingContext {
  /** Text that may always be mentioned (topic, channel name). */
  allowed: string;
}

/**
 * Lexical grounding checks for every scene. Fact scenes are checked against their
 * cited sources only; hook and outro may only use terms that appear somewhere in
 * the sources or the allowed text, and may not introduce numbers.
 */
export function groundingProblems(sb: Storyboard, sources: Source[], ctx: GroundingContext): string[] {
  const problems: string[] = [];
  const allText = `${sources.map((s) => `${s.title} ${s.excerpt}`).join(' ')} ${ctx.allowed}`;
  for (const sc of sb.scenes) {
    const cited = sources.filter((s) => sc.sourceIds.includes(s.id));
    const support = sc.role === 'fact' ? `${cited.map((s) => `${s.title} ${s.excerpt}`).join(' ')} ${ctx.allowed}` : allText;
    const supportLower = support.toLowerCase();
    const supportNums = new Set(numbersIn(support));
    const supportStems = new Set([...supportLower.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)].map((x) => stem(x[0])));
    const where = sc.role === 'fact' ? `its cited source${cited.length > 1 ? 's' : ''} ${sc.sourceIds.join(', ')}` : 'any source';
    const label = `Scene ${sc.index + 1} (${sc.role})`;

    for (const n of numbersIn(sc.narration)) {
      if (!supportNums.has(n)) problems.push(`${label} states the number "${n}", which is not in ${where}.`);
    }
    for (const t of new Set(namedTermsIn(sc.narration))) {
      const st = stem(t);
      const parts = t.split(/[-]/).map(stem);
      if (!supportStems.has(st) && !parts.every((p) => supportStems.has(p)) && !supportLower.includes(t.toLowerCase())) {
        problems.push(`${label} mentions "${t}", which does not appear in ${where}.`);
      }
    }
    if (sc.role === 'fact') {
      const words = [...significantTokens(sc.narration)];
      const supported = words.filter((w) => supportStems.has(stem(w)) || [...supportStems].some((s) => s.length >= 5 && (s.startsWith(w) || w.startsWith(s))));
      if (words.length >= 4 && supported.length / words.length < 0.5) {
        problems.push(
          `${label} is mostly not supported by ${where} (only ${supported.length} of ${words.length} key words appear there). Restate what the source says.`
        );
      }
    }
  }
  return problems;
}

export function validateGrounding(sb: Storyboard, sources: Source[], ctx: GroundingContext): Storyboard {
  const problems = groundingProblems(sb, sources, ctx);
  if (problems.length) throw new InvalidStoryboardError(problems.join(' '));
  return sb;
}
