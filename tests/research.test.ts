// Research adapters, parsed against REAL responses captured from each API (tests/fixtures/research).
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  arxiv,
  crossref,
  federalRegister,
  feedItemsToSources,
  github,
  hackernews,
  huggingface,
  invertedToText,
  mentionsTopic,
  newsrooms,
  openalex,
  type ResearchAdapter,
  type ResearchQuery
} from '../src/main/research/adapters';
import { classifyUrl } from '../src/main/research/classify';
import { dedupeSources, groupIndependence, normalizeUrl, type RawSource } from '../src/main/research/dedupe';
import { rankScore, relevance, runResearch } from '../src/main/research/engine';
import { extractArticle, parseFeed } from '../src/main/research/text';
import type { Source } from '../src/shared/production';

const FX = path.resolve(__dirname, 'fixtures/research');
const fx = (f: string) => fs.readFileSync(path.join(FX, f), 'utf8');
const q = (topic: string, mode: ResearchQuery['mode'] = 'explainer', windowDays = 30): ResearchQuery => ({ topic, mode, windowDays });
const signal = () => new AbortController().signal;

/** Route fetch() to fixture files by URL; unknown URLs fail like a network error would. */
function stubFetch(routes: [RegExp, string | (() => Response)][]) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    const hit = routes.find(([re]) => re.test(u));
    if (!hit) throw new TypeError(`fetch failed (no route for ${u})`);
    if (typeof hit[1] === 'function') return hit[1]();
    const body = fx(hit[1]);
    const type = hit[1].endsWith('.json') ? 'application/json' : hit[1].endsWith('.md') ? 'text/plain' : 'application/xml';
    return new Response(body, { status: 200, headers: { 'content-type': type } });
  });
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe('research adapters (real captured responses)', () => {
  it('arXiv: parses Atom entries with abstract, authors, date and canonical abs URL', async () => {
    const calls = stubFetch([[/export\.arxiv\.org/, 'arxiv.xml']]);
    const r = await arxiv().search(q('speculative decoding'), signal());
    expect(calls[0]).toContain('search_query=all%3Aspeculative+AND+all%3Adecoding');
    expect(r[0]).toMatchObject({ title: 'Hybrid Spark: Adaptive Speculative Decoding That Lets the Content Choose the Drafter', publisher: 'arXiv', kind: 'research', contentLevel: 'abstract', provider: 'arxiv' });
    expect(r[0].url).toMatch(/^https:\/\/arxiv\.org\/abs\//);
    expect(r[0].publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r[0].authors!.length).toBeGreaterThan(0);
    expect(r[0].excerpt.length).toBeGreaterThan(200);
  });

  it('OpenAlex: rebuilds abstracts from the inverted index and keeps venue, DOI, authors', async () => {
    stubFetch([[/api\.openalex\.org/, 'openalex.json']]);
    const r = await openalex().search(q('speculative decoding'), signal());
    expect(r.map((s) => s.title)).toEqual(['Online Speculative Decoding', 'Decoding Speculative Decoding']);
    expect(r[0]).toMatchObject({ url: 'https://proceedings.mlr.press/v235/liu24y.html', publishedAt: '2024-07-08T00:00:00.000Z', kind: 'research' });
    expect(r[1].doi).toBe('10.18653/v1/2025.naacl-long.328');
    expect(invertedToText({ world: [1], hello: [0] })).toBe('hello world');
  });

  it('Crossref: strips JATS markup and maps DOIs to doi.org URLs', async () => {
    stubFetch([[/api\.crossref\.org/, 'crossref.json']]);
    const r = await crossref().search(q('speculative decoding'), signal());
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].url).toBe('https://doi.org/10.66977/xsci.2611.003h');
    for (const s of r) expect(s.excerpt).not.toMatch(/<jats:|<\/?p>/);
  });

  it('GitHub: repo + README + latest release, classified as the owner’s official source', async () => {
    stubFetch([
      [/api\.github\.com\/search/, 'github-search.json'],
      [/raw\.githubusercontent\.com\/deepseek-ai\/DeepSpec/, 'github-readme.md'],
      [/api\.github\.com\/repos\/.*\/releases\/latest/, () => new Response('{"message":"Not Found"}', { status: 404 })]
    ]);
    const r = await github().search(q('speculative decoding'), signal());
    expect(r[0]).toMatchObject({ url: 'https://github.com/deepseek-ai/DeepSpec', publisher: 'deepseek-ai', kind: 'official', provider: 'github', contentLevel: 'full' });
    expect(r[0].excerpt.length).toBeGreaterThan(500);
    // Second repo's README was unreachable: kept, but marked summary-level.
    expect(r[1].contentLevel).toBe('summary');
  });

  it('Hugging Face: uses model cards; models without a card are skipped', async () => {
    stubFetch([
      [/huggingface\.co\/api\/models/, 'huggingface-models.json'],
      [/huggingface\.co\/hexgrad\/Kokoro-82M\/raw/, 'huggingface-card.md'],
      [/huggingface\.co\/.*\/raw/, () => new Response('', { status: 404 })]
    ]);
    const r = await huggingface().search(q('kokoro'), signal());
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ title: 'hexgrad/Kokoro-82M model card', publisher: 'hexgrad', kind: 'official' });
    expect(r[0].excerpt).not.toMatch(/^---/); // YAML front matter removed
  });

  it('Federal Register: agency, type, date and abstract preserved as official policy sources', async () => {
    stubFetch([[/federalregister\.gov/, 'federalregister.json']]);
    const r = await federalRegister().search(q('artificial intelligence'), signal());
    expect(r[0]).toMatchObject({ kind: 'official', category: 'policy', publishedAt: '2026-11-27T00:00:00.000Z' });
    expect(r[0].publisher.length).toBeGreaterThan(2);
  });

  it('Hacker News is discovery only: items become their linked pages, classified by domain', async () => {
    stubFetch([[/hn\.algolia\.com/, 'hn.json']]);
    const r = await hackernews().search(q('speculative decoding'), signal());
    expect(r.map((s) => s.url)).toContain('https://arxiv.org/abs/2603.03251');
    expect(r.find((s) => s.url.includes('arxiv'))!.kind).toBe('research');
    expect(r.every((s) => !s.url.includes('ycombinator'))).toBe(true);
  });

  it('feeds: RSS items are filtered by topic and classified (NVIDIA newsroom = company announcement)', () => {
    const items = parseFeed(fx('nvidia-newsroom.rss'));
    expect(items.length).toBe(3);
    expect(items[0].publishedAt).toMatch(/^\d{4}-/);
    const src = feedItemsToSources(fx('nvidia-newsroom.rss'), { url: 'x', category: 'hardware' }, q('Jensen Huang NVIDIA board'), 'newsrooms');
    expect(src).toHaveLength(1);
    expect(src[0]).toMatchObject({ title: 'NVIDIA Board Reinstates Jensen Huang as President, CEO and Board Director', kind: 'company', publisher: 'NVIDIA', contentLevel: 'summary' });
    expect(feedItemsToSources(fx('verge-ai.atom'), { url: 'x', category: 'news' }, q('quantum gravity'), 'tech-press')).toEqual([]);
    expect(parseFeed(fx('verge-ai.atom'))[0].link).toMatch(/^https:\/\/www\.theverge\.com\//);
  });

  it('a feed adapter fails only when every feed fails', async () => {
    stubFetch([[/good\.example/, 'nvidia-newsroom.rss']]);
    const ok = await newsrooms([{ url: 'https://good.example/rss', category: 'news' }, { url: 'https://down.example/rss', category: 'news' }]).search(q('Jensen Huang NVIDIA'), signal());
    expect(ok.length).toBe(1);
    await expect(newsrooms([{ url: 'https://down.example/rss', category: 'news' }]).search(q('x'), signal())).rejects.toThrow(/none of the 1 feeds/);
  });
});

describe('classification, dedupe and syndication', () => {
  it('classifies primary, company, reporting, background, community and unknown sites', () => {
    expect(classifyUrl('https://nvidianews.nvidia.com/news/x')).toEqual({ kind: 'company', publisher: 'NVIDIA' });
    expect(classifyUrl('https://www.theverge.com/ai/1')).toEqual({ kind: 'reporting', publisher: 'The Verge' });
    expect(classifyUrl('https://arxiv.org/abs/2401.1').kind).toBe('research');
    expect(classifyUrl('https://www.ftc.gov/news').kind).toBe('official');
    expect(classifyUrl('https://digital-strategy.ec.europa.eu/en/policies').kind).toBe('official');
    expect(classifyUrl('https://github.com/vllm-project/vllm')).toEqual({ kind: 'official', publisher: 'vllm-project' });
    expect(classifyUrl('https://en.wikipedia.org/wiki/X').kind).toBe('background');
    expect(classifyUrl('https://news.ycombinator.com/item?id=1').kind).toBe('community');
    expect(classifyUrl('https://random-ai-blog.biz/post').kind).toBe('other');
  });

  it('normalises URLs (tracking params, www, arXiv versions/PDF)', () => {
    expect(normalizeUrl('https://www.theverge.com/a/b/?utm_source=x&id=2#top')).toBe('theverge.com/a/b?id=2');
    expect(normalizeUrl('https://arxiv.org/pdf/2401.12345v3.pdf')).toBe(normalizeUrl('https://arxiv.org/abs/2401.12345'));
  });

  it('merges the same paper found via arXiv and OpenAlex, keeping metadata from both', () => {
    const a: RawSource = { title: 'Online Speculative Decoding', url: 'https://arxiv.org/abs/2310.07177v4', publisher: 'arXiv', excerpt: 'short', retrievedAt: '', kind: 'research', contentLevel: 'abstract', provider: 'arxiv', authors: ['X Liu'] };
    const b: RawSource = { title: 'Online speculative decoding', url: 'https://proceedings.mlr.press/v235/liu24y.html', publisher: 'ICML', excerpt: 'a much longer abstract text '.repeat(10), retrievedAt: '', kind: 'research', contentLevel: 'abstract', provider: 'openalex', doi: '10.1/x', publishedAt: '2024-07-08T00:00:00.000Z' };
    const out = dedupeSources([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].excerpt.length).toBeGreaterThan(100);
    expect(out[0].doi).toBe('10.1/x');
    expect(out[0].authors).toEqual(['X Liu']);
  });

  it('does not treat articles repeating a press release as independent', () => {
    const release = 'NVIDIA today announced the Rubin platform, a new generation of accelerated computing for AI factories that delivers record performance and efficiency for training and inference across every major cloud provider and enterprise data center worldwide starting next year.';
    const mk = (id: string, publisher: string, kind: Source['kind'], excerpt: string): Source => ({ id, title: id, url: `https://${id}.example/x`, publisher, excerpt, retrievedAt: '', kind });
    const out = groupIndependence([
      mk('S1', 'NVIDIA', 'company', release),
      mk('S2', 'Outlet A', 'reporting', `In a statement, ${release} Analysts were not immediately available.`),
      mk('S3', 'Outlet B', 'reporting', 'Our own testing of the previous generation found mixed results in several independent benchmark runs across different workloads and settings, which we describe below in detail with charts and methodology notes for readers.')
    ]);
    expect(out[1].derivedFrom).toBe('S1');
    expect(out[1].group).toBe(out[0].group);
    expect(out[2].derivedFrom).toBeUndefined();
    expect(new Set(out.map((s) => s.group)).size).toBe(2);
  });
});

describe('research engine', () => {
  const adapter = (id: ResearchAdapter['id'], items: RawSource[] | Error, delayMs = 0): ResearchAdapter => ({
    id,
    label: id,
    category: 'news',
    healthUrl: 'x',
    search: async (_q, sig) => {
      if (delayMs) await new Promise((r, j) => { const t = setTimeout(r, delayMs); sig.addEventListener('abort', () => (clearTimeout(t), j(new Error('aborted')))); });
      if (items instanceof Error) throw items;
      return items;
    }
  });
  const item = (o: Partial<RawSource>): RawSource => ({ title: 'Speculative decoding speeds up LLM inference', url: `https://example.org/${Math.random()}`, publisher: 'P', excerpt: 'Speculative decoding uses a draft model to propose tokens that a larger model verifies, speeding up LLM inference without changing outputs. '.repeat(3), retrievedAt: '', kind: 'research', contentLevel: 'abstract', provider: 'arxiv', ...o });

  it('reports failures and timeouts per provider without failing the job', async () => {
    const r = await runResearch(q('speculative decoding'), [adapter('arxiv', [item({})]), adapter('gdelt', new Error('HTTP 429')), adapter('openalex', [], 0), adapter('crossref', [item({})], 500)], [], signal(), { perProviderTimeoutMs: 100 });
    const byId = Object.fromEntries(r.reports.map((x) => [x.id, x]));
    expect(byId.arxiv.status).toBe('ok');
    expect(byId.gdelt).toMatchObject({ status: 'failed', error: 'HTTP 429' });
    expect(byId.openalex.status).toBe('empty');
    expect(byId.crossref).toMatchObject({ status: 'failed', error: 'timed out' });
    expect(r.sources.map((s) => s.id)).toEqual(['S1']);
  });

  it('drops off-topic, unreadable, community and (in news mode) stale items, with reasons', async () => {
    const old = new Date(Date.now() - 90 * 86400_000).toISOString();
    const r = await runResearch(
      q('speculative decoding', 'news', 30),
      [adapter('arxiv', [item({ publishedAt: new Date().toISOString(), kind: 'reporting' }), item({ title: 'Cooking pasta', excerpt: 'Boil water and add salt to taste before the pasta goes in, then stir. '.repeat(4) }), item({ title: 'Speculative decoding benchmark results', publishedAt: old, url: 'https://example.org/old' }), item({ title: 'Speculative decoding discussion thread', kind: 'community', url: 'https://reddit.com/r/x' }), item({ title: 'Speculative decoding paywalled story', excerpt: 'tiny', url: 'https://example.org/tiny', contentLevel: 'summary', kind: 'reporting' })])],
      [],
      signal(),
      { fetchPage: async () => '<html><p>paywall</p></html>' }
    );
    expect(r.sources).toHaveLength(1);
    const reasons = r.dropped.map((d) => d.reason).join(' | ');
    expect(reasons).toMatch(/not about the topic/);
    expect(reasons).toMatch(/older than 30 days/);
    expect(reasons).toMatch(/community site/);
    expect(reasons).toMatch(/no readable text/);
  });

  it('fetches full text for summary-only hits and keeps the article’s own metadata', async () => {
    const html = `<html><head><meta property="og:site_name" content="Example News"><meta property="article:published_time" content="2026-11-20T10:00:00Z"><script type="application/ld+json">{"@type":"NewsArticle","author":{"@type":"Person","name":"Ada Reporter"}}</script></head><body><nav>menu</nav><article>${[1, 2, 3, 4, 5].map((i) => `<p>Paragraph ${i}: speculative decoding lets a small draft model propose several tokens that the large model verifies in one pass, cutting LLM latency.</p>`).join('')}</article></body></html>`;
    const r = await runResearch(q('speculative decoding'), [adapter('gdelt', [item({ excerpt: '', contentLevel: 'summary', kind: 'other', url: 'https://example-news.com/a', publisher: 'example-news.com' })])], [], signal(), { fetchPage: async () => html });
    expect(r.sources[0]).toMatchObject({ contentLevel: 'full', publishedAt: '2026-11-20T10:00:00Z', authors: ['Ada Reporter'], publisher: 'Example News' });
    expect(r.sources[0].excerpt).toMatch(/draft model/);
  });

  it('ranks primary research above background and recent news above old news', () => {
    const t = 'speculative decoding';
    // Explainers favour background + research over repos; news favours reporting/announcements over background.
    expect(rankScore(t, item({ kind: 'research' }), 'explainer')).toBeGreaterThan(rankScore(t, item({ kind: 'official', provider: 'github' }), 'explainer'));
    expect(rankScore(t, item({ kind: 'background' }), 'explainer')).toBeGreaterThan(rankScore(t, item({ kind: 'official', provider: 'huggingface' }), 'explainer'));
    expect(rankScore(t, item({ kind: 'reporting', publishedAt: new Date().toISOString() }), 'news')).toBeGreaterThan(rankScore(t, item({ kind: 'background' }), 'news'));
    const recent = item({ kind: 'reporting', publishedAt: new Date().toISOString() });
    const stale = item({ kind: 'reporting', publishedAt: new Date(Date.now() - 20 * 86400_000).toISOString() });
    expect(rankScore(t, recent, 'news')).toBeGreaterThan(rankScore(t, stale, 'news'));
    expect(relevance('how speech recognition works', { title: 'Speech recognition', excerpt: 'Speech recognition converts spoken words into text.' })).toBeGreaterThan(0.9);
    expect(relevance('how speech recognition works', { title: 'Affective computing', excerpt: 'Systems that recognize emotions.' })).toBeLessThan(0.4);
    // Names in the topic must appear; exact phrases count strongly.
    expect(relevance('NVIDIA Blackwell GPUs', { title: 'Developer builds a gallery of classic GPU demos', excerpt: 'Old NVIDIA and ATI GPU demos run in the browser.' })).toBeLessThanOrEqual(0.3);
    expect(relevance('EU AI Act', { title: 'Regulators publish guidance', excerpt: 'The EU AI Act sets obligations for providers of general-purpose AI models.' })).toBeGreaterThanOrEqual(0.75);
  });

  it('news mode refuses to pass off papers as news, and non-English sources are dropped', async () => {
    const paper = item({ publishedAt: new Date().toISOString() });
    await expect(runResearch(q('speculative decoding', 'news'), [adapter('arxiv', [paper])], [], signal())).rejects.toThrow(/No news coverage of "speculative decoding" from the last 30 days/);
    const pt = item({ title: 'Decodificação especulativa', excerpt: 'A decodificação especulativa é uma técnica que usa um modelo pequeno para propor tokens e um modelo maior para verificar os tokens propostos de forma paralela e eficiente sem perda de qualidade nas respostas geradas pelo sistema de linguagem. '.repeat(2), url: 'https://example.org/pt' });
    const r = await runResearch(q('speculative decoding'), [adapter('arxiv', [item({}), pt])], [], signal());
    expect(r.dropped.find((d) => d.url === 'https://example.org/pt')?.reason).toBe('not in English');
  });

  it('includes the user’s research notes as a source', async () => {
    const notes: RawSource = { title: 'Your research notes', url: '', publisher: 'You', excerpt: 'Speculative decoding drafts tokens with a small model and verifies them with a big one. '.repeat(3), retrievedAt: '', kind: 'user', provider: 'notes', contentLevel: 'notes' };
    const r = await runResearch(q('speculative decoding'), [], [notes], signal());
    expect(r.sources.map((s) => s.id)).toEqual(['N1']);
    expect(r.reports.find((x) => x.id === 'notes')!.found).toBe(1);
  });
});

describe('article extraction', () => {
  it('extracts paragraphs and metadata without inventing missing fields', () => {
    const a = extractArticle('<html><head><title>T | Site</title></head><body><p>' + 'Real paragraph text that is long enough to keep around for evidence. '.repeat(2) + '</p><p>Subscribe to our newsletter</p></body></html>');
    expect(a.text).toMatch(/^Real paragraph/);
    expect(a.text).not.toMatch(/Subscribe/);
    expect(a.publishedAt).toBeUndefined();
    expect(a.authors).toEqual([]);
  });
  it('topic gate needs at least two topic words in title/summary', () => {
    expect(mentionsTopic('NVIDIA Blackwell GPUs', 'NVIDIA ships Blackwell', '')).toBe(true);
    expect(mentionsTopic('NVIDIA Blackwell GPUs', 'NVIDIA earnings', 'quarterly revenue')).toBe(false);
  });
});
