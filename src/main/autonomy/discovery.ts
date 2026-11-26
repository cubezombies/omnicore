import { createHash } from 'node:crypto';
import type { IdeaSignal, ScoreDetail } from '../../shared/operations';
import { fetchJson, fetchRetry, readText } from '../providers/http';
import { significantTokens } from '../providers/text';
import { NEWSROOM_FEEDS, PRESS_FEEDS, type FeedDef } from '../research/adapters';
import { classifyUrl } from '../research/classify';
import { parseFeed, toIso } from '../research/text';

export interface DiscoveredItem extends IdeaSignal {
  summary: string;
}

export interface CandidateIdea {
  topic: string;
  headline: string;
  mode: 'news' | 'explainer';
  signals: IdeaSignal[];
  score: number;
  scoreDetail: ScoreDetail;
  fingerprint: string;
}

export interface DiscoverySource {
  id: string;
  fetch(signal: AbortSignal): Promise<DiscoveredItem[]>;
}

const DAY = 86400_000;

/** Recent items from RSS/Atom feeds (company newsrooms + technology press). */
export const feedSource = (id: string, feeds: FeedDef[], maxAgeDays = 7): DiscoverySource => ({
  id,
  async fetch(signal) {
    const cutoff = Date.now() - maxAgeDays * DAY;
    const res = await Promise.allSettled(feeds.map(async (f) => parseFeed(await readText(await fetchRetry(f.url, { signal, retries: 1, timeoutMs: 20000 })))));
    return res
      .filter((r): r is PromiseFulfilledResult<ReturnType<typeof parseFeed>> => r.status === 'fulfilled')
      .flatMap((r) => r.value)
      .filter((i) => i.link && i.title && (!i.publishedAt || Date.parse(i.publishedAt) >= cutoff))
      .map((i) => {
        const c = classifyUrl(i.link);
        return { title: i.title, url: i.link, publisher: c.publisher, kind: c.kind, publishedAt: i.publishedAt, provider: id, summary: i.summary.slice(0, 600) };
      });
  }
});

/** Hacker News stories with real traction; the linked page is the signal, not HN itself. */
export const hackerNewsSource = (api = 'https://hn.algolia.com/api/v1', days = 3, minPoints = 60): DiscoverySource => ({
  id: 'hackernews',
  async fetch(signal) {
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    const q = new URLSearchParams({ tags: 'story', query: 'AI', numericFilters: `points>${minPoints},created_at_i>${since}`, hitsPerPage: '40' });
    const data = await fetchJson<{ hits?: { title: string; url?: string | null; created_at?: string }[] }>(`${api}/search_by_date?${q}`, { signal });
    return (data.hits ?? [])
      .filter((h) => h.url)
      .map((h) => {
        const c = classifyUrl(h.url!);
        return { title: h.title, url: h.url!, publisher: c.publisher, kind: c.kind, publishedAt: toIso(h.created_at), provider: 'hackernews', summary: '' };
      });
  }
});

/** Trending models on Hugging Face (tools/models explainers). */
export const huggingFaceTrendingSource = (base = 'https://huggingface.co'): DiscoverySource => ({
  id: 'huggingface-trending',
  async fetch(signal) {
    const models = await fetchJson<{ id: string; lastModified?: string; pipeline_tag?: string }[]>(`${base}/api/models?sort=trendingScore&limit=8`, { signal });
    return models.map((m) => ({ title: `${m.id}${m.pipeline_tag ? ` (${m.pipeline_tag})` : ''}`, url: `${base}/${m.id}`, publisher: m.id.split('/')[0], kind: 'official', publishedAt: toIso(m.lastModified), provider: 'huggingface-trending', summary: '' }));
  }
});

export const defaultDiscoverySources = (): DiscoverySource[] => [feedSource('newsrooms', NEWSROOM_FEEDS), feedSource('tech-press', PRESS_FEEDS), hackerNewsSource(), huggingFaceTrendingSource()];

const GENERIC = new Set(['new', 'says', 'said', 'ai', 'model', 'models', 'tech', 'company', 'update', 'launch', 'launches', 'introduces', 'introducing', 'announces', 'report', 'week', 'today', 'how', 'why', 'what', 'year', 'first', 'just', 'not', 'now', 'will', 'can', 'get', 'gets', 'its', 'their', 'more', 'over', 'into', 'after', 'about', 'really', 'reportedly']);
const OPENER = /^(the|a|an|how|why|what|when|this|that|these|here|new|meet|introducing|inside|exclusive|report|watch|one|two|three|four|five|six|seven|eight|nine|ten|get|save|why|is|are|can|will)$/i;
/** Shopping/deal posts are not stories. */
/** Newsletter digests bundle unrelated stories; each story is covered on its own elsewhere. */
const DIGEST = /^(the download|this week in|weekly roundup|week in review|daily digest|newsletter)\b|\b(roundup|recap|digest)\b/i;
const COMMERCE = /\b(deals?|save \$|\$\d[\d,]*(\.\d+)? off|% off|discount|coupon|sale\b|lowest price|price drop|cheapest|just \$|best buy|black friday|cyber monday|gift guide)\b/i;

/** Capitalised names in a headline (NVIDIA, Blackwell, OpenAI), excluding sentence openers. */
export function headlineNames(title: string): string[] {
  const words = title.split(/[^\p{L}\p{N}-]+/u).filter(Boolean);
  return words.filter((w, i) => /^[A-Z0-9]/.test(w) && w.length > 1 && !(i === 0 && OPENER.test(w)) && !OPENER.test(w) && !GENERIC.has(w.toLowerCase()));
}

export function nicheHits(text: string, keywords: string[]): string[] {
  const t = ` ${text.toLowerCase()} `;
  return keywords.filter((k) => new RegExp(`[^a-z0-9]${k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^a-z0-9]`).test(t));
}

const tok = (s: string) => new Set([...significantTokens(s)].filter((w) => !GENERIC.has(w)));
const jaccard = (a: Set<string>, b: Set<string>) => {
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i || 1);
};

/** Group items that are about the same story (shared names or overlapping headline words). */
export function clusterItems(items: DiscoveredItem[]): DiscoveredItem[][] {
  const clusters: { items: DiscoveredItem[]; tok: Set<string>; names: Set<string> }[] = [];
  for (const it of items) {
    const t = tok(it.title);
    const names = new Set(headlineNames(it.title).map((n) => n.toLowerCase()));
    const c = clusters.find((cl) => jaccard(cl.tok, t) >= 0.35 || [...names].filter((n) => cl.names.has(n)).length >= 2);
    if (c) {
      c.items.push(it);
      for (const x of t) c.tok.add(x);
      for (const n of names) c.names.add(n);
    } else clusters.push({ items: [it], tok: t, names });
  }
  return clusters.map((c) => c.items);
}

/** Concise research topic for a story: its most frequent names, then its most frequent words (max 4 terms). */
export function deriveTopic(cluster: DiscoveredItem[]): { topic: string; headline: string } {
  const lead = [...cluster].sort((a, b) => rankKind(b.kind) - rankKind(a.kind) || Date.parse(b.publishedAt ?? '0') - Date.parse(a.publishedAt ?? '0'))[0];
  const freq = new Map<string, { n: number; form: string; name: boolean }>();
  for (const it of cluster) {
    const names = new Set(headlineNames(it.title));
    for (const w of it.title.split(/[^\p{L}\p{N}-]+/u).filter(Boolean)) {
      const k = w.toLowerCase();
      if (GENERIC.has(k) || (k.length < 4 && !names.has(w))) continue;
      if (!names.has(w) && !significantTokens(w).size) continue;
      const e = freq.get(k) ?? { n: 0, form: w, name: names.has(w) };
      e.n += 1;
      e.name ||= names.has(w);
      freq.set(k, e);
    }
  }
  const leadWords = new Set(lead.title.split(/[^\p{L}\p{N}-]+/u).map((w) => w.toLowerCase()));
  // Topic terms come from the lead headline (names shared across the story rank first).
  const ranked = [...freq.values()].filter((r) => leadWords.has(r.form.toLowerCase())).sort((a, b) => Number(b.name) - Number(a.name) || b.n - a.n);
  const names = ranked.filter((r) => r.name).slice(0, 3);
  const words = ranked.filter((r) => !r.name).slice(0, Math.max(1, 4 - names.length));
  const chosen = new Set([...names, ...words].map((r) => r.form.toLowerCase()));
  // Keep the lead headline's word order so the topic reads naturally.
  const ordered = lead.title.split(/[^\p{L}\p{N}-]+/u).filter((w) => chosen.delete(w.toLowerCase()));
  return { topic: [...ordered, ...[...chosen]].slice(0, 4).join(' '), headline: lead.title };
}

const rankKind = (k: string) => ({ company: 4, official: 4, research: 3, reporting: 3, other: 1, community: 0 })[k as 'company'] ?? 1;

/** Transparent opportunity score (0–100) with its parts. */
export function scoreCluster(cluster: DiscoveredItem[], keywords: string[], recentTopics: string[], now = Date.now()): ScoreDetail {
  const notes: string[] = [];
  const newest = Math.max(...cluster.map((i) => (i.publishedAt ? Date.parse(i.publishedAt) : now - 5 * DAY)));
  const ageH = (now - newest) / 3600_000;
  const freshness = ageH <= 24 ? 1 : ageH <= 72 ? 0.7 : ageH <= 168 ? 0.4 : 0.1;
  const outlets = new Set(cluster.filter((i) => i.kind !== 'community').map((i) => i.publisher.toLowerCase())).size;
  const coverage = outlets >= 3 ? 1 : outlets === 2 ? 0.7 : 0.35;
  const hasPrimary = cluster.some((i) => ['company', 'official', 'research'].includes(i.kind));
  const primarySource = hasPrimary ? 1 : 0.4;
  const hits = new Set(cluster.flatMap((i) => nicheHits(`${i.title} ${i.summary}`, keywords)));
  const nicheFit = Math.min(1, hits.size / 3);
  const t = tok(cluster.map((i) => i.title).join(' '));
  const similar = recentTopics.reduce((m, r) => Math.max(m, jaccard(t, tok(r))), 0);
  const novelty = 1 - similar;
  notes.push(`${outlets} outlet(s)`, `newest ${Math.round(ageH)} h ago`, hasPrimary ? 'has primary source' : 'no primary source', `brand keywords: ${[...hits].join(', ') || 'none'}`);
  if (similar > 0.5) notes.push('similar to a recent topic');
  const total = Math.round(freshness * 25 + coverage * 25 + primarySource * 20 + nicheFit * 20 + novelty * 10);
  return { freshness, coverage, primarySource, nicheFit, novelty, total, notes };
}

export interface DiscoveryResult {
  candidates: CandidateIdea[];
  items: number;
  sourceReports: { id: string; ok: boolean; items: number; error?: string }[];
}

/** Discover opportunities: fetch signals, keep on-niche items, cluster stories, derive topics and score them. */
export async function discover(sources: DiscoverySource[], keywords: string[], recentTopics: string[], signal: AbortSignal): Promise<DiscoveryResult> {
  const sourceReports: DiscoveryResult['sourceReports'] = [];
  const all: DiscoveredItem[] = [];
  await Promise.all(
    sources.map(async (s) => {
      try {
        const items = await s.fetch(signal);
        sourceReports.push({ id: s.id, ok: true, items: items.length });
        all.push(...items);
      } catch (e) {
        sourceReports.push({ id: s.id, ok: false, items: 0, error: e instanceof Error ? e.message : String(e) });
      }
    })
  );
  const onNiche = all.filter((i) => i.kind !== 'community' && !COMMERCE.test(i.title) && !DIGEST.test(i.title) && nicheHits(`${i.title} ${i.summary}`, keywords).length > 0);
  const seen = new Set<string>();
  const unique = onNiche.filter((i) => (seen.has(i.url) ? false : (seen.add(i.url), true)));
  const candidates = clusterItems(unique)
    .map((cluster): CandidateIdea => {
      const { topic, headline } = deriveTopic(cluster);
      const scoreDetail = scoreCluster(cluster, keywords, recentTopics);
      const mode = cluster.every((i) => i.provider === 'huggingface-trending') ? 'explainer' : 'news';
      const fingerprint = createHash('sha1').update([...tok(topic)].sort().join(' ')).digest('hex').slice(0, 16);
      return { topic, headline, mode, signals: cluster.map(({ summary: _s, ...sig }) => sig), score: scoreDetail.total, scoreDetail, fingerprint };
    })
    .filter((c) => c.topic.split(' ').length >= 2)
    .sort((a, b) => b.score - a.score);
  return { candidates, items: all.length, sourceReports };
}
