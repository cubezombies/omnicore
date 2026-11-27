import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { PreviewEngine, Pronunciation, PronunciationDraft, PronunciationEntry, PronunciationFinding, Storyboard } from '../../shared/production';
import { NotFoundError } from '../db/repository';
import { BUILTIN_LEXICON, speechTokens } from '../providers/pronunciation';

type Row = Record<string, unknown>;
const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

const toEntry = (r: Row): PronunciationEntry => ({
  id: Number(r.id),
  businessId: r.business_id === null ? null : Number(r.business_id),
  term: String(r.term),
  say: String(r.say),
  engineSay: (() => {
    try {
      return JSON.parse(String(r.engine_say)) as PronunciationEntry['engineSay'];
    } catch {
      return {};
    }
  })(),
  ipa: String(r.ipa),
  context: String(r.context),
  caseSensitive: Number(r.case_sensitive) === 1,
  verified: Number(r.verified) === 1,
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at)
});

export class PronunciationError extends Error {}

/**
 * Central pronunciation dictionary: shared entries (business_id NULL) plus each business's own, which win.
 * A business only ever sees shared entries and its own; it can never read or change another business's entries.
 */
export class PronunciationRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Shared entries and this business's entries (business entries listed first). */
  list(businessId: number): PronunciationEntry[] {
    return (this.db.prepare('SELECT * FROM pronunciations WHERE business_id IS NULL OR business_id = ? ORDER BY business_id IS NULL, lower(term)').all(businessId) as Row[]).map(toEntry);
  }

  get(businessId: number, id: number): PronunciationEntry {
    const r = this.db.prepare('SELECT * FROM pronunciations WHERE id = ? AND (business_id IS NULL OR business_id = ?)').get(id, businessId) as Row | undefined;
    if (!r) throw new NotFoundError(`Pronunciation ${id} not found`);
    return toEntry(r);
  }

  /** Create or replace the entry for this term at the chosen scope. */
  save(businessId: number, d: PronunciationDraft): PronunciationEntry {
    const owner = d.scope === 'global' ? null : businessId;
    const existing = this.db.prepare('SELECT id FROM pronunciations WHERE COALESCE(business_id, 0) = ? AND lower(term) = lower(?)').get(owner ?? 0, d.term) as Row | undefined;
    const args = [d.say, JSON.stringify(d.engineSay ?? {}), d.ipa ?? '', d.context ?? '', d.caseSensitive ? 1 : 0, d.verified === false ? 0 : 1];
    if (existing) {
      this.db.prepare(`UPDATE pronunciations SET term = ?, say = ?, engine_say = ?, ipa = ?, context = ?, case_sensitive = ?, verified = ?, updated_at = ${NOW} WHERE id = ?`).run(d.term, ...args, Number(existing.id));
      return this.get(businessId, Number(existing.id));
    }
    const res = this.db.prepare('INSERT INTO pronunciations (business_id, term, say, engine_say, ipa, context, case_sensitive, verified) VALUES (?,?,?,?,?,?,?,?)').run(owner, d.term, ...args);
    return this.get(businessId, Number(res.lastInsertRowid));
  }

  delete(businessId: number, id: number): PronunciationEntry {
    const e = this.get(businessId, id);
    this.db.prepare('DELETE FROM pronunciations WHERE id = ?').run(e.id);
    return e;
  }

  /** What one engine should say for this business: business entries beat shared ones; engine overrides beat `say`. */
  resolved(businessId: number, engine: PreviewEngine): Pronunciation[] {
    const byTerm = new Map<string, PronunciationEntry>();
    for (const e of this.list(businessId).reverse()) byTerm.set(e.term.toLowerCase(), e); // shared first, business overwrites
    return [...byTerm.values()].map((e) => ({ term: e.term, say: e.engineSay[engine]?.trim() || e.say }));
  }
}

// ---- detection ---------------------------------------------------------------------------

let englishCache: { file: string; words: Set<string> } | null = null;
/**
 * Common English words, taken from Kokoro's lexicon file. Used only to decide which words need a human check;
 * the synthesis itself never reads this list.
 */
export function englishWords(toolsDir: string): Set<string> | null {
  const file = path.join(toolsDir, 'sherpa', 'models', 'kokoro-multi-lang-v1_0', 'lexicon-us-en.txt');
  if (englishCache?.file === file) return englishCache.words;
  if (!fs.existsSync(file)) return null;
  const words = new Set<string>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const sp = line.indexOf(' ');
    if (sp > 0) words.add(line.slice(0, sp));
  }
  englishCache = { file, words };
  return words;
}

const CORE = /^[("'“‘[]*(.*?)[)"'”’\].,;:!?]*$/;
const strip = (w: string) => (CORE.exec(w)?.[1] ?? w).replace(/[’‘ʼ]s$|'s$/, '');

/**
 * Find the terms in a script whose pronunciation matters: names, acronyms, mixed-case and alphanumeric terms,
 * and words that aren't common English. Says how each will be spoken and flags the ones nobody has confirmed.
 * Never invents a pronunciation: an uncertain term is reported, not guessed.
 */
export function checkPronunciations(sb: Pick<Storyboard, 'scenes'>, entries: PronunciationEntry[], english: Set<string> | null): PronunciationFinding[] {
  const dict = new Map<string, PronunciationEntry>();
  for (const e of [...entries].reverse()) dict.set(e.term.toLowerCase(), e);
  const found = new Map<string, PronunciationFinding>();
  for (const sc of sb.scenes) {
    const words = sc.narration.split(/\s+/).filter(Boolean);
    words.forEach((raw, i) => {
      const term = strip(raw);
      if (!term || !/\p{L}/u.test(term)) return;
      const sentenceStart = i === 0 || /[.!?]["”’)]*$/.test(words[i - 1]);
      const lower = term.toLowerCase();
      const entry = dict.get(lower);
      const builtin = BUILTIN_LEXICON[term] !== undefined;
      const acronym = /^[A-Z]{2,6}s?$/.test(term);
      const mixed = /[a-z][A-Z]|[A-Z]{2,}[a-z]/.test(term);
      const alnum = /\d/.test(term) && /\p{L}/u.test(term);
      const capitalised = /^\p{Lu}/u.test(term) && !sentenceStart;
      const known = (w: string) => !!english && (english.has(w) || [/s$/, /es$/, /ed$/, /d$/, /ing$/, /ly$/, /er$/].some((re) => re.test(w) && (english.has(w.replace(re, '')) || english.has(w.replace(re, 'e')))));
      const unknownWord = english ? !known(lower) && !lower.split('-').every((part) => part && known(part)) : capitalised;
      if (!entry && !builtin && !acronym && !mixed && !alnum && !(capitalised && unknownWord) && !(unknownWord && term.length > 3 && english)) return;
      const spoken = speechTokens(term, entries.map((e) => ({ term: e.term, say: e.say })))[0]?.spoken ?? term;
      const status: PronunciationFinding['status'] = entry ? 'dictionary' : builtin ? 'builtin' : acronym || (alnum && spoken !== term) ? 'rule' : 'uncertain';
      const key = entry ? entry.term.toLowerCase() : term;
      const f = found.get(key) ?? { term: entry?.term ?? term, status, spoken, count: 0, scenes: [], ...(entry ? { entryId: entry.id } : {}) };
      f.count++;
      if (!f.scenes.includes(sc.index)) f.scenes.push(sc.index);
      found.set(key, f);
    });
  }
  const order = { uncertain: 0, rule: 1, builtin: 2, dictionary: 3 };
  return [...found.values()].sort((a, b) => order[a.status] - order[b.status] || a.term.localeCompare(b.term));
}
