import type { ProductionMode, ProviderStatus, ResearchCategory, ResearchProviderId } from '../../shared/production';
import { CancelledError } from '../media/ffmpeg';
import { fetchJson, fetchRetry } from '../providers/http';
import { searchTerms } from '../providers/text';
import { classifyUrl } from './classify';
import type { RawSource } from './dedupe';
import { attr, decodeEntities, markdownToText, parseFeed, stripTags, tag, tags, text, toIso } from './text';

export interface ResearchQuery {
  topic: string;
  mode: ProductionMode;
  /** News mode: only items published within this many days. */
  windowDays: number;
}

export interface ResearchAdapter {
  id: ResearchProviderId;
  label: string;
  category: ResearchCategory;
  /** Probe URL for health checks. */
  healthUrl: string;
  search(q: ResearchQuery, signal: AbortSignal): Promise<RawSource[]>;
}

const now = () => new Date().toISOString();
const terms = (q: ResearchQuery) => searchTerms(q.topic) || q.topic;
const sinceDate = (q: ResearchQuery) => new Date(Date.now() - q.windowDays * 86400_000).toISOString().slice(0, 10);

export async function checkAdapter(a: ResearchAdapter, signal?: AbortSignal): Promise<ProviderStatus> {
  const base = { id: `research:${a.id}`, kind: 'research' as const, label: a.label, costPerUnitUsd: 0 };
  try {
    await fetchRetry(a.healthUrl, { signal, timeoutMs: 8000, retries: 0 });
    return { ...base, available: true, detail: 'Reachable' };
  } catch (e) {
    return { ...base, available: false, detail: `Unreachable: ${(e as Error).message}` };
  }
}

// ---------------------------------------------------------------------------

export const wikipedia = (api = 'https://en.wikipedia.org/w/api.php'): ResearchAdapter => ({
  id: 'wikipedia',
  label: 'Wikipedia',
  category: 'background',
  healthUrl: `${api}?action=query&meta=siteinfo&format=json`,
  async search(q, signal) {
    const s = await fetchJson<{ query?: { search?: { title: string }[] } }>(
      `${api}?${new URLSearchParams({ action: 'query', list: 'search', srsearch: terms(q), srlimit: '4', format: 'json', formatversion: '2' })}`,
      { signal }
    );
    const titles = (s.query?.search ?? []).map((r) => r.title);
    if (!titles.length) return [];
    const x = await fetchJson<{ query?: { pages?: { title: string; extract?: string; fullurl?: string; missing?: boolean; touched?: string }[] } }>(
      `${api}?${new URLSearchParams({ action: 'query', prop: 'extracts|info', exintro: '1', explaintext: '1', inprop: 'url', redirects: '1', titles: titles.join('|'), format: 'json', formatversion: '2' })}`,
      { signal }
    );
    return (x.query?.pages ?? [])
      .filter((p) => !p.missing && (p.extract ?? '').length > 200 && !/may refer to:?/i.test((p.extract ?? '').slice(0, 300)))
      .map((p) => ({
        title: p.title,
        url: p.fullurl ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`,
        publisher: 'Wikipedia',
        excerpt: p.extract!.slice(0, 5000),
        retrievedAt: now(),
        kind: 'background' as const,
        provider: 'wikipedia',
        category: 'background' as const,
        contentLevel: 'full' as const
      }));
  }
});

export function parseArxiv(xml: string): RawSource[] {
  return tags(xml, 'entry').map((e) => {
    const absUrl = text(e, 'id').replace(/^http:/, 'https:');
    return {
      title: text(e, 'title'),
      url: absUrl,
      publisher: 'arXiv',
      excerpt: text(e, 'summary'),
      retrievedAt: now(),
      publishedAt: toIso(text(e, 'published')),
      authors: tags(e, 'author').map((a) => text(a, 'name')).filter(Boolean).slice(0, 8),
      doi: text(e, 'arxiv:doi') || undefined,
      kind: 'research' as const,
      provider: 'arxiv',
      category: 'research' as const,
      contentLevel: 'abstract' as const
    };
  });
}

export const arxiv = (api = 'https://export.arxiv.org/api/query'): ResearchAdapter => ({
  id: 'arxiv',
  label: 'arXiv',
  category: 'research',
  healthUrl: `${api}?search_query=all:test&max_results=1`,
  async search(q, signal) {
    const words = terms(q).split(' ').filter(Boolean).slice(0, 6);
    const query = words.map((w) => `all:${w}`).join(' AND ');
    const params = new URLSearchParams({ search_query: query, max_results: '5', sortBy: q.mode === 'news' ? 'submittedDate' : 'relevance', sortOrder: 'descending' });
    const res = await fetchRetry(`${api}?${params}`, { signal });
    return parseArxiv(await res.text());
  }
});

interface OpenAlexWork {
  id: string;
  doi?: string | null;
  display_name?: string;
  title?: string;
  publication_date?: string;
  authorships?: { author?: { display_name?: string } }[];
  abstract_inverted_index?: Record<string, number[]> | null;
  primary_location?: { landing_page_url?: string | null; source?: { display_name?: string } | null } | null;
}

export function invertedToText(idx: Record<string, number[]> | null | undefined): string {
  if (!idx) return '';
  const words: string[] = [];
  for (const [w, positions] of Object.entries(idx)) for (const p of positions) words[p] = w;
  return words.filter((w) => w !== undefined).join(' ');
}

export function parseOpenAlex(body: { results?: OpenAlexWork[] }): RawSource[] {
  return (body.results ?? [])
    .map((w) => {
      const doi = w.doi ? w.doi.replace(/^https?:\/\/doi\.org\//i, '') : undefined;
      const url = w.primary_location?.landing_page_url || (doi ? `https://doi.org/${doi}` : w.id);
      return {
        title: w.display_name ?? w.title ?? '',
        url,
        publisher: w.primary_location?.source?.display_name || 'OpenAlex',
        excerpt: invertedToText(w.abstract_inverted_index),
        retrievedAt: now(),
        publishedAt: toIso(w.publication_date),
        authors: (w.authorships ?? []).map((a) => a.author?.display_name ?? '').filter(Boolean).slice(0, 8),
        doi,
        kind: 'research' as const,
        provider: 'openalex',
        category: 'research' as const,
        contentLevel: 'abstract' as const
      };
    })
    .filter((s) => s.title && s.excerpt.length > 100);
}

export const openalex = (api = 'https://api.openalex.org'): ResearchAdapter => ({
  id: 'openalex',
  label: 'OpenAlex',
  category: 'research',
  healthUrl: `${api}/works?per-page=1`,
  async search(q, signal) {
    const filter = ['has_abstract:true', ...(q.mode === 'news' ? [`from_publication_date:${sinceDate(q)}`] : [])].join(',');
    return parseOpenAlex(await fetchJson(`${api}/works?${new URLSearchParams({ search: terms(q), 'per-page': '5', filter })}`, { signal }));
  }
});

interface CrossrefItem {
  DOI: string;
  title?: string[];
  author?: { given?: string; family?: string; name?: string }[];
  issued?: { 'date-parts'?: number[][] };
  'container-title'?: string[];
  abstract?: string;
  URL?: string;
  publisher?: string;
}

export function parseCrossref(body: { message?: { items?: CrossrefItem[] } }): RawSource[] {
  return (body.message?.items ?? [])
    .map((i) => {
      const dp = i.issued?.['date-parts']?.[0];
      return {
        title: stripTags(i.title?.[0] ?? ''),
        url: `https://doi.org/${i.DOI}`,
        publisher: i['container-title']?.[0] || i.publisher || 'Crossref',
        excerpt: stripTags((i.abstract ?? '').replace(/<jats:title>[\s\S]*?<\/jats:title>/gi, ' ')),
        retrievedAt: now(),
        publishedAt: dp?.length ? toIso(`${dp[0]}-${String(dp[1] ?? 1).padStart(2, '0')}-${String(dp[2] ?? 1).padStart(2, '0')}`) : undefined,
        authors: (i.author ?? []).map((a) => a.name ?? [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean).slice(0, 8),
        doi: i.DOI,
        kind: 'research' as const,
        provider: 'crossref',
        category: 'research' as const,
        contentLevel: 'abstract' as const
      };
    })
    .filter((s) => s.title && s.excerpt.length > 100);
}

export const crossref = (api = 'https://api.crossref.org'): ResearchAdapter => ({
  id: 'crossref',
  label: 'Crossref',
  category: 'research',
  healthUrl: `${api}/works?rows=0`,
  async search(q, signal) {
    const filter = ['has-abstract:true', ...(q.mode === 'news' ? [`from-pub-date:${sinceDate(q)}`] : [])].join(',');
    return parseCrossref(await fetchJson(`${api}/works?${new URLSearchParams({ query: terms(q), rows: '5', filter })}`, { signal }));
  }
});

interface GhRepo {
  full_name: string;
  html_url: string;
  description?: string | null;
  pushed_at?: string;
  owner: { login: string };
  default_branch?: string;
  license?: { spdx_id?: string } | null;
}

export const github = (api = 'https://api.github.com', raw = 'https://raw.githubusercontent.com'): ResearchAdapter => ({
  id: 'github',
  label: 'GitHub',
  category: 'tools',
  healthUrl: `${api}/rate_limit`,
  async search(q, signal) {
    const res = await fetchJson<{ items?: GhRepo[] }>(`${api}/search/repositories?${new URLSearchParams({ q: terms(q), per_page: '3' })}`, {
      signal,
      init: { headers: { Accept: 'application/vnd.github+json' } }
    });
    const out: RawSource[] = [];
    for (const r of res.items ?? []) {
      let readme = '';
      try {
        readme = markdownToText(await (await fetchRetry(`${raw}/${r.full_name}/${r.default_branch ?? 'main'}/README.md`, { signal, retries: 0, timeoutMs: 10000 })).text());
      } catch (e) {
        if (e instanceof CancelledError) throw e;
      }
      let release = '';
      let releasedAt: string | undefined;
      try {
        const rel = await fetchJson<{ name?: string; tag_name?: string; published_at?: string; body?: string }>(`${api}/repos/${r.full_name}/releases/latest`, { signal, retries: 0, timeoutMs: 10000 });
        release = `Latest release ${rel.name || rel.tag_name}: ${markdownToText(rel.body ?? '').slice(0, 1500)}`;
        releasedAt = toIso(rel.published_at);
      } catch (e) {
        if (e instanceof CancelledError) throw e; // no releases is normal (404)
      }
      out.push({
        title: `${r.full_name}${r.description ? `: ${r.description}` : ''}`,
        url: r.html_url,
        publisher: r.owner.login,
        excerpt: [r.description ? `${r.description}.` : '', readme.slice(0, 5000), release].filter(Boolean).join(' '),
        retrievedAt: now(),
        publishedAt: releasedAt ?? toIso(r.pushed_at),
        authors: [r.owner.login],
        kind: 'official',
        provider: 'github',
        category: 'tools',
        contentLevel: readme ? 'full' : 'summary'
      });
    }
    return out;
  }
});

interface HfModel {
  id: string;
  author?: string;
  lastModified?: string;
  createdAt?: string;
  pipeline_tag?: string;
  cardData?: { license?: string };
}

export const huggingface = (base = 'https://huggingface.co'): ResearchAdapter => ({
  id: 'huggingface',
  label: 'Hugging Face',
  category: 'tools',
  healthUrl: `${base}/api/models?limit=1`,
  async search(q, signal) {
    const models = await fetchJson<HfModel[]>(`${base}/api/models?${new URLSearchParams({ search: terms(q).split(' ').slice(0, 3).join(' '), sort: 'downloads', limit: '3', full: 'true' })}`, { signal });
    const out: RawSource[] = [];
    for (const m of models) {
      let card = '';
      try {
        card = markdownToText(await (await fetchRetry(`${base}/${m.id}/raw/main/README.md`, { signal, retries: 0, timeoutMs: 10000 })).text());
      } catch (e) {
        if (e instanceof CancelledError) throw e;
      }
      if (card.length < 200) continue; // no model card: nothing citable
      out.push({
        title: `${m.id} model card`,
        url: `${base}/${m.id}`,
        publisher: m.author ?? m.id.split('/')[0],
        excerpt: card.slice(0, 6000),
        retrievedAt: now(),
        publishedAt: toIso(m.lastModified ?? m.createdAt),
        authors: [m.author ?? m.id.split('/')[0]],
        kind: 'official',
        provider: 'huggingface',
        category: 'tools',
        contentLevel: 'full'
      });
    }
    return out;
  }
});

// ---------------------------------------------------------------------------
// RSS/Atom feeds. Items are filtered by relevance here; full text is fetched later by the engine.

export interface FeedDef {
  url: string;
  category: ResearchCategory;
}

export const NEWSROOM_FEEDS: FeedDef[] = [
  { url: 'https://openai.com/news/rss.xml', category: 'news' },
  { url: 'https://nvidianews.nvidia.com/releases.xml', category: 'hardware' },
  { url: 'https://blog.google/technology/ai/rss/', category: 'news' },
  { url: 'https://deepmind.google/blog/rss.xml', category: 'research' },
  { url: 'https://huggingface.co/blog/feed.xml', category: 'tools' },
  { url: 'https://ir.amd.com/news-events/press-releases/rss', category: 'hardware' },
  { url: 'https://news.microsoft.com/source/feed/', category: 'news' },
  { url: 'https://www.nist.gov/news-events/news/rss.xml', category: 'policy' }
];

export const PRESS_FEEDS: FeedDef[] = [
  { url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', category: 'news' },
  { url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', category: 'news' },
  { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', category: 'news' },
  { url: 'https://www.technologyreview.com/feed/', category: 'news' },
  { url: 'https://www.tomshardware.com/feeds/all', category: 'hardware' }
];

/** Relevance gate used before fetching: the item's title+summary must mention the topic. */
export function mentionsTopic(topic: string, title: string, summary: string): boolean {
  const want = searchTerms(topic).toLowerCase().split(' ').filter(Boolean);
  if (!want.length) return false;
  const hay = `${title} ${summary}`.toLowerCase();
  const hits = want.filter((w) => hay.includes(w.replace(/s$/, ''))).length;
  return hits >= Math.min(2, want.length);
}

export function feedItemsToSources(xml: string, feed: FeedDef, q: ResearchQuery, provider: ResearchProviderId): RawSource[] {
  const cutoff = Date.now() - q.windowDays * 86400_000;
  return parseFeed(xml)
    .filter((i) => i.link && i.title && mentionsTopic(q.topic, i.title, i.summary))
    .filter((i) => q.mode !== 'news' || !i.publishedAt || Date.parse(i.publishedAt) >= cutoff)
    .slice(0, 4)
    .map((i) => {
      const c = classifyUrl(i.link);
      return {
        title: i.title,
        url: i.link,
        publisher: c.publisher,
        excerpt: i.summary,
        retrievedAt: now(),
        publishedAt: i.publishedAt,
        authors: i.authors,
        kind: c.kind,
        provider,
        category: feed.category,
        contentLevel: 'summary' as const
      };
    });
}

const feedAdapter = (id: ResearchProviderId, label: string, feeds: FeedDef[]): ResearchAdapter => ({
  id,
  label,
  category: 'news',
  healthUrl: feeds[0].url,
  async search(q, signal) {
    const results = await Promise.allSettled(
      feeds.map(async (f) => feedItemsToSources(await (await fetchRetry(f.url, { signal, retries: 1, timeoutMs: 20000 })).text(), f, q, id))
    );
    if (signal.aborted) throw new CancelledError();
    const ok = results.filter((r): r is PromiseFulfilledResult<RawSource[]> => r.status === 'fulfilled');
    if (!ok.length) throw new Error(`none of the ${feeds.length} feeds could be read`);
    return ok.flatMap((r) => r.value);
  }
});

export const newsrooms = (feeds = NEWSROOM_FEEDS) => feedAdapter('newsrooms', 'Company newsrooms', feeds);
export const techPress = (feeds = PRESS_FEEDS) => feedAdapter('tech-press', 'Technology press', feeds);

// ---------------------------------------------------------------------------

let lastGdelt = 0;
/** GDELT asks for at most one request every 5 seconds. */
async function gdeltSlot(signal: AbortSignal, spacingMs: number) {
  const wait = lastGdelt + spacingMs - Date.now();
  lastGdelt = Math.max(Date.now(), lastGdelt + spacingMs);
  if (wait > 0) {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, wait);
      signal.addEventListener('abort', () => (clearTimeout(t), reject(new CancelledError())), { once: true });
    });
  }
}

export const gdelt = (api = 'https://api.gdeltproject.org/api/v2/doc/doc', spacingMs = 5500): ResearchAdapter => ({
  id: 'gdelt',
  label: 'GDELT news search',
  category: 'news',
  healthUrl: 'https://api.gdeltproject.org/',
  async search(q, signal) {
    await gdeltSlot(signal, spacingMs);
    const t = terms(q);
    const query = `${t.includes(' ') ? `"${t}"` : t} sourcelang:english`;
    const res = await fetchRetry(`${api}?${new URLSearchParams({ query, mode: 'ArtList', format: 'json', maxrecords: '8', sort: 'HybridRel', timespan: q.mode === 'news' ? `${q.windowDays}d` : '1y' })}`, { signal, retries: 0, timeoutMs: 30000 });
    const body = await res.text();
    if (!body.trim().startsWith('{')) throw new Error(body.slice(0, 120));
    const data = JSON.parse(body) as { articles?: { url: string; title: string; seendate?: string; domain?: string }[] };
    return (data.articles ?? []).slice(0, 6).map((a) => {
      const c = classifyUrl(a.url);
      const sd = a.seendate?.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z');
      return { title: a.title, url: a.url, publisher: c.publisher, excerpt: '', retrievedAt: now(), publishedAt: toIso(sd), authors: [], kind: c.kind, provider: 'gdelt', category: 'news' as const, contentLevel: 'summary' as const };
    });
  }
});

export const hackernews = (api = 'https://hn.algolia.com/api/v1'): ResearchAdapter => ({
  id: 'hackernews',
  label: 'Hacker News (discovery)',
  category: 'news',
  healthUrl: `${api}/search?query=test&hitsPerPage=1`,
  async search(q, signal) {
    const params = new URLSearchParams({ query: terms(q), tags: 'story', hitsPerPage: '8' });
    if (q.mode === 'news') params.set('numericFilters', `created_at_i>${Math.floor(Date.now() / 1000) - q.windowDays * 86400}`);
    const data = await fetchJson<{ hits?: { title: string; url?: string | null; points?: number; created_at?: string }[] }>(`${api}/search?${params}`, { signal });
    // HN is only a discovery channel: we keep the linked page, classified by its own domain.
    return (data.hits ?? [])
      .filter((h) => h.url && (h.points ?? 0) >= 5)
      .slice(0, 4)
      .map((h) => {
        const c = classifyUrl(h.url!);
        return { title: h.title, url: h.url!, publisher: c.publisher, excerpt: '', retrievedAt: now(), publishedAt: toIso(h.created_at), authors: [], kind: c.kind, provider: 'hackernews', category: 'news' as const, contentLevel: 'summary' as const };
      });
  }
});

export const federalRegister = (api = 'https://www.federalregister.gov/api/v1'): ResearchAdapter => ({
  id: 'federal-register',
  label: 'US Federal Register',
  category: 'policy',
  healthUrl: `${api}/documents.json?per_page=1`,
  async search(q, signal) {
    const params = new URLSearchParams({ 'conditions[term]': terms(q), per_page: '4', order: q.mode === 'news' ? 'newest' : 'relevance' });
    if (q.mode === 'news') params.set('conditions[publication_date][gte]', sinceDate(q));
    const data = await fetchJson<{ results?: { title: string; abstract?: string | null; html_url: string; publication_date?: string; type?: string; agencies?: { name?: string }[] }[] }>(`${api}/documents.json?${params}`, { signal });
    return (data.results ?? [])
      .filter((r) => (r.abstract ?? '').length > 80)
      .map((r) => {
        const agency = r.agencies?.map((a) => a.name).filter(Boolean).join(', ') || 'US Federal Register';
        return { title: r.title, url: r.html_url, publisher: agency, excerpt: `${r.type ? `${r.type}. ` : ''}${r.abstract}`, retrievedAt: now(), publishedAt: toIso(r.publication_date), authors: [agency], kind: 'official' as const, provider: 'federal-register', category: 'policy' as const, contentLevel: 'abstract' as const };
      });
  }
});

export const secEdgar = (api = 'https://efts.sec.gov/LATEST/search-index'): ResearchAdapter => ({
  id: 'sec-edgar',
  label: 'SEC EDGAR full-text',
  category: 'policy',
  healthUrl: `${api}?q=test`,
  async search(q, signal) {
    const data = await fetchJson<{ hits?: { hits?: { _id: string; _source: { display_names?: string[]; file_date?: string; form?: string; adsh?: string; ciks?: string[] } }[] } }>(
      `${api}?${new URLSearchParams({ q: `"${terms(q)}"`, forms: '10-K,10-Q,8-K' })}`,
      { signal }
    );
    return (data.hits?.hits ?? []).slice(0, 3).map((h) => {
      const s = h._source;
      const cik = (s.ciks?.[0] ?? '').replace(/^0+/, '');
      const file = h._id.split(':')[1] ?? '';
      const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${(s.adsh ?? '').replace(/-/g, '')}/${file}`;
      const company = (s.display_names?.[0] ?? 'SEC filing').replace(/\s*\(CIK.*$/, '');
      return { title: `${company} ${s.form ?? 'filing'} (${s.file_date ?? 'date unknown'})`, url, publisher: company, excerpt: '', retrievedAt: now(), publishedAt: toIso(s.file_date), authors: [company], kind: 'company' as const, provider: 'sec-edgar', category: 'policy' as const, contentLevel: 'summary' as const };
    });
  }
});

export function adapterById(id: ResearchProviderId): ResearchAdapter {
  switch (id) {
    case 'wikipedia': return wikipedia();
    case 'arxiv': return arxiv();
    case 'openalex': return openalex();
    case 'crossref': return crossref();
    case 'github': return github();
    case 'huggingface': return huggingface();
    case 'newsrooms': return newsrooms();
    case 'tech-press': return techPress();
    case 'gdelt': return gdelt();
    case 'hackernews': return hackernews();
    case 'federal-register': return federalRegister();
    case 'sec-edgar': return secEdgar();
  }
}

// Exported for tests.
export const _internals = { decodeEntities, attr, tag };
