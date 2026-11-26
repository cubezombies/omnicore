import type { Brief, Claim, ClaimKind, ProductionMode, Source } from '../../shared/production';
import { InsufficientResearchError, significantTokens, splitSentences, titleCase, wordCount } from '../providers/text';

/** A claim must read as an ordinary English sentence: not a heading, title, badge line or code fragment. */
export function isProseSentence(s: string): boolean {
  if (/\p{Extended_Pictographic}|[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(s)) return false; // emoji / CJK in English narration
  if (/---|\||`|\[\s*!|https?:\/\/|\{|\}|<|>|\$ |\bpip install\b|\bnpm\b/.test(s)) return false;
  const words = s.replace(/[.!?]+$/, '').split(/\s+/).filter(Boolean);
  if (words.length < 8) return false;
  const caps = words.filter((w) => /^[A-Z]/.test(w)).length;
  if (caps / words.length > 0.55) return false; // Title Case Heading
  const lowerFunction = words.filter((w) => /^(the|a|an|of|to|in|for|on|with|at|by|from|its|their|that|which|and|is|are|was|were|as|into|than)$/.test(w)).length;
  if (lowerFunction < 1) return false; // headings and badge lines lack ordinary function words
  return true;
}

const PRONOUN_START = /^(It|Its|This|That|These|Those|They|Their|He|She|His|Her|Such|Here|There|We|Our|I)\b/;
const OPINION = /\b(I|we) (think|believe|feel)\b|\bin (my|our) (view|opinion)\b|\bshould\b|\bmust\b/i;
const SPECULATION = /\b(may|might|could|reportedly|allegedly|alleged|purportedly|purported|rumou?red|possibly|likely|is expected to|are expected to|plans? to|aims? to|intends? to|is set to|would)\b/i;
const ESTIMATE = /\b(estimated?|estimates|approximately|roughly|about \d|around \d|projected|forecasts?|up to \d|nearly \d)\b/i;
const SUPERLATIVE = /\b(fastest|best|state[- ]of[- ]the[- ]art|leading|most (powerful|advanced|capable|efficient)|breakthrough|revolutionary|unprecedented|world'?s first|\d+(\.\d+)?x (faster|better|more)|outperforms?)\b/i;

/** Words that, when present in narration, show a claim is being attributed or qualified. */
export const QUALIFIERS: Record<Exclude<ClaimKind, 'confirmed'>, RegExp> = {
  'company-claim': /\b(says?|said|claims?|claimed|according to|announced|states?|describes?|calls?|reports?|promises?)\b/i,
  reported: /\b(reports?|reported|reportedly|according to|says?|said|writes?|wrote)\b/i,
  estimate: /\b(estimates?|estimated|about|roughly|approximately|around|nearly|projected|expected|forecasts?|up to)\b/i,
  speculation: /\b(may|might|could|reportedly|allegedly|alleged|purportedly|expected|possibly|likely|plans?|aims?|would|if)\b/i,
  opinion: /\b(argues?|argued|believes?|says?|said|thinks?|according to|in (their|his|her) view|writes?)\b/i
};

const PREPRINT_DOI = /^10\.(5281|48550|21203|36227|20944|31219|2139|22541|31234|66977)\//;
/** Preprints and self-archived uploads are not peer reviewed: their claims are reported, not confirmed, unless corroborated. */
export function isPreprint(s: Source): boolean {
  if (/arxiv\.org|zenodo\.org|ssrn\.com|researchsquare|techrxiv|preprints\.org|osf\.io|biorxiv|medrxiv/i.test(s.url)) return true;
  if (s.doi && PREPRINT_DOI.test(s.doi)) return true;
  return /\b(arxiv|zenodo|research square|techrxiv|ssrn|preprints?)\b/i.test(s.publisher);
}

/** Classify one sentence from one source. Company/self-published claims are never "confirmed" on their own. */
export function classifyClaim(sentence: string, src: Source): ClaimKind {
  if (OPINION.test(sentence) && (src.kind === 'reporting' || src.kind === 'other' || src.kind === 'company')) return 'opinion';
  if (SPECULATION.test(sentence)) return 'speculation';
  if (ESTIMATE.test(sentence)) return 'estimate';
  if (src.kind === 'company') return 'company-claim';
  if (src.kind === 'official' && (src.provider === 'github' || src.provider === 'huggingface') && SUPERLATIVE.test(sentence)) return 'company-claim';
  if (src.kind === 'reporting' || src.kind === 'other') return 'reported';
  if (src.kind === 'research' && isPreprint(src)) return 'reported';
  return 'confirmed';
}

const jaccard = (a: Set<string>, b: Set<string>) => {
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i || 1);
};

const KIND_PREF: Record<ClaimKind, number> = { confirmed: 3, reported: 2.2, 'company-claim': 1.8, estimate: 1.5, speculation: 0.6, opinion: 0.3 };

interface Candidate {
  text: string;
  src: Source;
  pos: number;
  tok: Set<string>;
  kind: ClaimKind;
  score: number;
}

/**
 * Build claim-level evidence: verbatim sentences from sources, each classified
 * (confirmed / company claim / reported / estimate / speculation / opinion), with
 * the sources that support it and how many independent groups that is.
 */
export function buildClaims(topic: string, sources: Source[], mode: ProductionMode, maxClaims = 6, maxWords = 130): Claim[] {
  const topicTok = significantTokens(topic);
  const cands: Candidate[] = [];
  sources.forEach((src, rank) => {
    if (src.kind === 'community') return;
    splitSentences(src.excerpt).slice(0, 60).forEach((text, pos) => {
      const wc = wordCount(text);
      if (wc < 7 || wc > 34 || !/[.!?]$/.test(text)) return;
      if (PRONOUN_START.test(text) && !(pos === 0 && src.kind === 'background')) return; // needs context we would have to invent
      if (/may refer to|disambiguation|click here|subscribe|newsletter|cookie|all rights reserved|^(image|photo|credit):|must-read|star (this|us)|^(note|tip|warning):/i.test(text)) return;
      if (!isProseSentence(text)) return;
      if (/^(to (run|use|install|get started|try)|set |run |install |click |see |download |clone |open |you('ll| will| can| need| should))/i.test(text)) return; // instructions, not claims
      if (/^[A-Z][a-z]+ing (how|the|a|an|new|our|why|what)\b/.test(text)) return; // subject-less fragments ("Exploring how…")
      const tok = significantTokens(text);
      let overlap = 0;
      for (const t of topicTok) if (tok.has(t) || [...tok].some((x) => x.length >= 5 && x.startsWith(t))) overlap++;
      if (overlap === 0 && !(src.kind === 'background' && pos <= 1)) return; // every claim must be about the topic
      const kind = classifyClaim(text, src);
      const fresh = mode === 'news' && src.publishedAt && Date.now() - Date.parse(src.publishedAt) < 14 * 86400_000 ? 1 : 0;
      const score = overlap * 2 + (3 - Math.min(pos, 3)) * 0.6 + (2 - Math.min(rank, 2)) * 0.5 + KIND_PREF[kind] + fresh;
      cands.push({ text, src, pos, tok, kind, score });
    });
  });

  // Supporting sources: near-duplicate statements in other sources.
  const supportFor = (c: Candidate) => {
    const support = cands.filter((o) => o.src.id !== c.src.id && jaccard(o.tok, c.tok) >= 0.5).map((o) => o.src);
    return [c.src, ...support.filter((s, i, a) => a.findIndex((x) => x.id === s.id) === i)];
  };

  const chosen: Claim[] = [];
  const picked: Candidate[] = [];
  let words = 0;
  for (const c of [...cands].sort((a, b) => b.score - a.score)) {
    if (chosen.length >= maxClaims) break;
    if (picked.some((p) => jaccard(p.tok, c.tok) > 0.45)) continue;
    if (picked.filter((p) => p.src.id === c.src.id).length >= 3) continue;
    const wc = wordCount(c.text);
    if (words + wc > maxWords && chosen.length >= 2) continue;
    const supporting = supportFor(c);
    const groups = new Set(supporting.map((s) => s.group ?? s.id));
    let kind = c.kind;
    // Independent corroboration by a research/official source upgrades reports and company claims.
    if ((kind === 'reported' || kind === 'company-claim') && supporting.some((s) => s.id !== c.src.id && (s.kind === 'research' || (s.kind === 'official' && s.provider !== 'github' && s.provider !== 'huggingface')) && s.group !== c.src.group)) kind = 'confirmed';
    else if (kind === 'reported' && groups.size >= 2) kind = 'confirmed';
    // A company announcement that independent outlets (not reprints of it) also report is an independently reported development.
    else if (kind === 'company-claim' && supporting.some((s) => s.id !== c.src.id && (s.kind === 'reporting' || s.kind === 'other') && s.group !== c.src.group && s.derivedFrom !== c.src.id)) kind = 'reported';
    picked.push(c);
    words += wc;
    if (kind === 'reported' && c.src.kind === 'research' && isPreprint(c.src) && supporting.some((s) => s.id !== c.src.id && s.group !== c.src.group && (s.kind === 'background' || (s.kind === 'research' && !isPreprint(s)) || s.kind === 'official'))) kind = 'confirmed';
    const attribution = c.src.kind === 'research' && isPreprint(c.src) ? `a preprint on ${c.src.publisher.replace(/\s*\(.*\)$/, '')}` : c.src.publisher;
    chosen.push({ id: '', text: c.text, sourceIds: supporting.map((s) => s.id), kind, attribution, independentSources: groups.size });
  }
  if (chosen.length < 2) {
    throw new InsufficientResearchError(
      `The research sources did not contain enough usable, on-topic statements about "${topic}" to support a script. Try a more specific topic, switch mode, or add research notes.`
    );
  }
  // Present in source order (rank) then position, for a natural narrative.
  const order = (cl: Claim) => {
    const p = picked[chosen.indexOf(cl)];
    return sources.indexOf(p.src) * 1000 + p.pos;
  };
  return [...chosen].sort((a, b) => order(a) - order(b)).map((c, i) => ({ ...c, id: `C${i + 1}` }));
}

export function buildEvidenceBrief(topic: string, sources: Source[], channelNiche: string, mode: ProductionMode): Brief {
  const claims = buildClaims(topic, sources, mode);
  const words = claims.reduce((s, c) => s + wordCount(c.text), 0) + 20;
  return {
    topic,
    title: mode === 'news' ? `${titleCase(topic)}: what happened` : `${titleCase(topic)}, explained`,
    angle: mode === 'news' ? `What is new about ${topic}, who says so, and what is confirmed.` : `A fast, sourced explainer on ${topic}: only what the cited sources say.`,
    audience: `Short-form viewers interested in ${channelNiche || 'the topic'}`,
    keyFacts: claims.map((c) => ({ text: c.text, sourceId: c.sourceIds[0] })),
    claims,
    mode,
    targetSeconds: Math.round(words / 2.5)
  };
}

/** Deterministic narration for a claim: verbatim text, attributed when it is not confirmed. */
export function narrateClaim(c: Claim): string {
  if (c.kind === 'confirmed' || QUALIFIERS[c.kind].test(c.text)) return c.text;
  const [first, ...rest] = c.text.split(' ');
  const common = /^(The|A|An|This|That|In|On|For|With|By|At|Its|Their|Our|New|Each|Every|Some|Most|Many)$/.test(first);
  return `According to ${c.attribution}, ${common ? first.toLowerCase() : first} ${rest.join(' ')}`;
}
