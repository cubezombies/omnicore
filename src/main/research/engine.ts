import type { ResearchProviderId, Source, SourceKind } from '../../shared/production';
import { CancelledError } from '../media/ffmpeg';
import { fetchRetry, readText } from '../providers/http';
import { significantTokens } from '../providers/text';
import type { ResearchAdapter, ResearchQuery } from './adapters';
import { classifyUrl } from './classify';
import { dedupeSources, groupIndependence, type RawSource } from './dedupe';
import { extractArticle } from './text';

export interface ProviderReport {
  id: ResearchProviderId | 'notes';
  label: string;
  status: 'ok' | 'empty' | 'failed';
  found: number;
  error?: string;
  ms: number;
}

export interface ResearchResult {
  sources: Source[];
  reports: ProviderReport[];
  /** Candidates dropped and why (for transparency in the UI/logs). */
  dropped: { title: string; url: string; reason: string }[];
}

export interface EngineOptions {
  maxSources?: number;
  perProviderTimeoutMs?: number;
  fetchConcurrency?: number;
  onProgress?: (msg: string) => void;
  /** Test seam for article fetching. */
  fetchPage?: (url: string, signal: AbortSignal) => Promise<string>;
}

/** Explainers need background and research; news needs announcements and reporting. Repos/model cards are niche in both. */
const KIND_WEIGHT: Record<'explainer' | 'news', Record<SourceKind, number>> = {
  explainer: { research: 2.8, official: 2.4, company: 1.8, reporting: 2.2, user: 3, background: 3, other: 0.6, community: 0 },
  news: { research: 1.6, official: 2.6, company: 2.8, reporting: 3, user: 3, background: 0.8, other: 0.8, community: 0 }
};
const TOOL_PENALTY = 1.2; // GitHub repos / model cards: primary for a tool, but rarely the best general source
const LEVEL_WEIGHT = { full: 1, notes: 1, abstract: 0.8, summary: 0.1 } as const;

/** Topic relevance in [0,1]: share of topic words found in the title (double weight) and opening text. */
/** Words too common in AI coverage to identify a topic on their own. */
const GENERIC = new Set(['ai', 'model', 'models', 'data', 'system', 'systems', 'new', 'tech', 'technology', 'company', 'companies', 'tool', 'tools', 'app', 'apps', 'work', 'artificial', 'intelligence', 'machine', 'learning', 'use', 'chip', 'chips']);

export function relevance(topic: string, s: Pick<Source, 'title' | 'excerpt'>): number {
  const want = [...significantTokens(topic)];
  if (!want.length) return 0;
  const title = significantTokens(s.title);
  const body = significantTokens(s.excerpt.slice(0, 3000));
  const has = (set: Set<string>, w: string) => set.has(w) || [...set].some((x) => x.length >= 5 && (x.startsWith(w) || w.startsWith(x)));
  const weight = (w: string) => (GENERIC.has(w) && want.length > 1 ? 0.3 : 1);
  let score = 0;
  let total = 0;
  for (const w of want) {
    total += weight(w);
    score += weight(w) * ((has(title, w) ? 0.6 : 0) + (has(body, w) ? 0.4 : 0));
  }
  let rel = score / total;
  // Names in the topic (NVIDIA, Blackwell, EU, OpenAI) must appear somewhere in the item; otherwise it is about something else.
  // Same stemming as the source tokens ("GPUs" → "gpu"), so names compare like for like.
  const names = [...significantTokens((topic.match(/\b[A-Z][\p{L}\p{N}-]*/gu) ?? []).join(' '))].filter((n) => !GENERIC.has(n) && !/^(how|what|why)$/.test(n));
  if (names.some((n) => !has(title, n) && !has(body, n))) rel = Math.min(rel, 0.3);
  // The exact multi-word phrase (e.g. "EU AI Act") is strong evidence the item is about the topic.
  const phrase = topic.trim().toLowerCase().replace(/\s+/g, ' ');
  if (want.length >= 2 && phrase.split(' ').length >= 2) {
    const inTitle = s.title.toLowerCase().includes(phrase);
    const inBody = s.excerpt.slice(0, 3000).toLowerCase().includes(phrase);
    if (inTitle) rel = Math.max(rel, 1);
    else if (inBody) rel = Math.max(rel, 0.75);
  }
  return rel;
}

export function rankScore(topic: string, s: RawSource, mode: ResearchQuery['mode']): number {
  const rel = relevance(topic, s);
  let recency = 0;
  if (mode === 'news') {
    const age = s.publishedAt ? (Date.now() - Date.parse(s.publishedAt)) / 86400_000 : Infinity;
    recency = age <= 7 ? 1.5 : age <= 30 ? 0.8 : age === Infinity ? -0.5 : 0;
    if (s.kind === 'background') recency -= 1; // encyclopedias are context, not news
  }
  const tool = s.provider === 'github' || s.provider === 'huggingface' ? (mode === 'news' ? 3 : TOOL_PENALTY) : 0;
  return rel * 5 + (KIND_WEIGHT[mode][s.kind ?? 'other'] ?? 0) - tool + (LEVEL_WEIGHT[s.contentLevel ?? 'summary'] ?? 0) + recency;
}

const EN_FUNCTION = new Set('the of and to is that for it with be by are this which from have has not were but its their can been also than will would there what how into using uses they these those was'.split(' '));
/** Rough English check: share of common English function words among the first 150 words. */
export function isEnglish(text: string): boolean {
  const words = text.toLowerCase().match(/\p{L}+/gu)?.slice(0, 150) ?? [];
  if (words.length < 20) return true; // too short to judge
  const hits = words.filter((w) => EN_FUNCTION.has(w)).length;
  return hits / words.length >= 0.08;
}

const NEWS_KINDS = new Set(['reporting', 'company', 'official', 'other']);
export class NoRecentNewsError extends Error {}

async function defaultFetchPage(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetchRetry(url, { signal, retries: 1, timeoutMs: 15000, init: { headers: { Accept: 'text/html,application/xhtml+xml' } } });
  const type = res.headers.get('content-type') ?? '';
  if (!/html|xml/.test(type)) throw new Error(`not an HTML page (${type || 'unknown type'})`);
  return (await readText(res)).slice(0, 3_000_000);
}

/** Fetch the page behind a feed/search hit and replace the summary with the article's own text and metadata. */
async function enrich(s: RawSource, fetchPage: EngineOptions['fetchPage'] & {}, signal: AbortSignal): Promise<RawSource> {
  const html = await fetchPage(s.url, signal);
  const a = extractArticle(html);
  if (a.text.length < 400) return { ...s, title: s.title || a.title }; // paywall / script-rendered page: keep what the feed gave us
  const url = a.canonicalUrl && /^https?:/.test(a.canonicalUrl) ? a.canonicalUrl : s.url;
  const c = classifyUrl(url);
  return {
    ...s,
    url,
    title: s.title || a.title,
    publisher: c.kind === 'other' && a.siteName ? a.siteName : c.publisher,
    kind: s.kind === 'official' || s.kind === 'research' ? s.kind : c.kind,
    excerpt: a.text.slice(0, 8000),
    publishedAt: s.publishedAt ?? a.publishedAt,
    authors: s.authors?.length ? s.authors : a.authors,
    contentLevel: 'full'
  };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        try {
          out[i] = { status: 'fulfilled', value: await fn(items[i]) };
        } catch (reason) {
          out[i] = { status: 'rejected', reason };
        }
      }
    })
  );
  return out;
}

/**
 * Run a research job across providers: query in parallel, keep relevant items,
 * fetch article text where only a summary is known, deduplicate, rank (primary
 * and original sources first), and mark which sources are not independent.
 */
export async function runResearch(q: ResearchQuery, adapters: ResearchAdapter[], extra: RawSource[], signal: AbortSignal, o: EngineOptions = {}): Promise<ResearchResult> {
  const maxSources = o.maxSources ?? 8;
  const reports: ProviderReport[] = [];
  const dropped: ResearchResult['dropped'] = [];
  const fetchPage = o.fetchPage ?? defaultFetchPage;

  const results = await Promise.all(
    adapters.map(async (a) => {
      const t0 = Date.now();
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => ctrl.abort(), o.perProviderTimeoutMs ?? 60000);
      try {
        o.onProgress?.(`Searching ${a.label}…`);
        const found = await a.search(q, ctrl.signal);
        reports.push({ id: a.id, label: a.label, status: found.length ? 'ok' : 'empty', found: found.length, ms: Date.now() - t0 });
        return found;
      } catch (e) {
        if (signal.aborted) throw new CancelledError();
        const msg = ctrl.signal.aborted ? 'timed out' : e instanceof Error ? e.message : String(e);
        reports.push({ id: a.id, label: a.label, status: 'failed', found: 0, error: msg, ms: Date.now() - t0 });
        return [];
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      }
    })
  );
  if (extra.length) reports.push({ id: 'notes', label: 'Your research notes', status: 'ok', found: extra.length, ms: 0 });

  let items = dedupeSources([...extra, ...results.flat()]);
  // Community pages are discovery only; never evidence.
  items = items.filter((s) => (s.kind === 'community' ? (dropped.push({ title: s.title, url: s.url, reason: 'community site (discovery only)' }), false) : true));

  // Fetch full text for the most promising summary-only items.
  const needText = items
    .filter((s) => s.contentLevel === 'summary' && s.kind !== 'user')
    .sort((a, b) => rankScore(q.topic, b, q.mode) - rankScore(q.topic, a, q.mode))
    .slice(0, 10);
  if (needText.length) {
    o.onProgress?.(`Reading ${needText.length} articles…`);
    const fetched = await pool(needText, o.fetchConcurrency ?? 4, (s) => enrich(s, fetchPage, signal));
    if (signal.aborted) throw new CancelledError();
    fetched.forEach((r, i) => {
      const idx = items.indexOf(needText[i]);
      if (r.status === 'fulfilled') items[idx] = r.value;
    });
    items = dedupeSources(items); // canonical URLs may reveal more duplicates
  }

  const kept: RawSource[] = [];
  for (const s of items) {
    if (!s.excerpt || s.excerpt.length < 150) dropped.push({ title: s.title, url: s.url, reason: 'no readable text (paywall or summary only)' });
    else if (s.kind !== 'user' && !isEnglish(`${s.title} ${s.excerpt}`)) dropped.push({ title: s.title, url: s.url, reason: 'not in English' });
    else if (s.kind !== 'user' && relevance(q.topic, s) < 0.4) dropped.push({ title: s.title, url: s.url, reason: 'not about the topic' });
    else if (q.mode === 'news' && s.publishedAt && Date.now() - Date.parse(s.publishedAt) > q.windowDays * 86400_000 && s.kind !== 'background' && s.kind !== 'user') dropped.push({ title: s.title, url: s.url, reason: `older than ${q.windowDays} days` });
    else kept.push(s);
  }

  // Rank, with a per-provider cap for diversity.
  const ranked = kept.sort((a, b) => rankScore(q.topic, b, q.mode) - rankScore(q.topic, a, q.mode));
  const perProvider = new Map<string, number>();
  const chosen: RawSource[] = [];
  for (const s of ranked) {
    const p = s.provider ?? 'other';
    if ((perProvider.get(p) ?? 0) >= 3) continue;
    perProvider.set(p, (perProvider.get(p) ?? 0) + 1);
    chosen.push(s);
    if (chosen.length >= maxSources) break;
  }
  // News mode must rest on actual news: announcements, reporting or official documents (not only papers/encyclopedias).
  if (q.mode === 'news' && !chosen.some((s) => NEWS_KINDS.has(s.kind ?? 'other') && s.provider !== 'github' && s.provider !== 'huggingface' && relevance(q.topic, s) >= 0.5)) {
    const failed = reports.filter((r) => r.status === 'failed').map((r) => r.label);
    throw new NoRecentNewsError(
      `No news coverage of "${q.topic}" from the last ${q.windowDays} days was found${failed.length ? ` (unavailable: ${failed.join(', ')})` : ''}. Use Explainer mode, widen the news window in Providers, or try again later.`
    );
  }
  let n = 0;
  const sources: Source[] = chosen.map((s) => {
    const { tempId: _t, ...rest } = s;
    return { ...rest, id: s.kind === 'user' ? 'N1' : `S${++n}` };
  });
  return { sources: groupIndependence(sources), reports, dropped };
}
