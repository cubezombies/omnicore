// Tiny, dependency-free XML/HTML helpers for feeds, Atom, arXiv and article pages.

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export const stripTags = (s: string): string =>
  decodeEntities(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

/** Inner XML of every <tag>…</tag> (namespace-insensitive when the tag has a prefix). */
export function tags(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
  return [...xml.matchAll(re)].map((m) => m[1]);
}

export function tag(xml: string, tag: string): string {
  return tags(xml, tag)[0] ?? '';
}

/** Text of the first matching tag: CDATA unwrapped, entities decoded, markup stripped. */
export const text = (xml: string, t: string): string => stripTags(tag(xml, t));

export function attr(xml: string, tagName: string, name: string, where?: (el: string) => boolean): string {
  const re = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  for (const m of xml.matchAll(re)) {
    if (where && !where(m[0])) continue;
    const a = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(m[0]);
    if (a) return decodeEntities(a[2] ?? a[3] ?? '');
  }
  return '';
}

/** Light markdown → plain text for READMEs and model cards. */
export function markdownToText(md: string): string {
  return md
    .replace(/^---[\s\S]*?\n---\s*\n/, '') // YAML front matter
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[|].*$/gm, ' ') // tables
    .replace(/^#{1,6}\s*(.*)$/gm, '$1.')
    .replace(/[*_`>~]+/g, '')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\.\.+/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ArticleData {
  title: string;
  text: string;
  publishedAt?: string;
  authors: string[];
  siteName?: string;
  canonicalUrl?: string;
}

const meta = (html: string, key: string): string =>
  attr(html, 'meta', 'content', (el) => new RegExp(`(?:property|name|itemprop)\\s*=\\s*["']${key}["']`, 'i').test(el));

/** Extract readable text and publication metadata from an article page. Never invents fields: missing stays missing. */
export function extractArticle(html: string): ArticleData {
  const head = html.slice(0, 200000);
  const authors = new Set<string>();
  let publishedAt = meta(head, 'article:published_time') || meta(head, 'datePublished') || meta(head, 'pubdate') || '';
  // JSON-LD NewsArticle / Article
  for (const block of tags(head, 'script').filter((b) => /"@type"\s*:\s*"(News)?Article|BlogPosting|ReportageNewsArticle/.test(b))) {
    try {
      const data = JSON.parse(block.trim());
      const items = (Array.isArray(data) ? data : data['@graph'] ?? [data]) as Record<string, unknown>[];
      for (const it of items) {
        if (!publishedAt && typeof it.datePublished === 'string') publishedAt = it.datePublished;
        const a = it.author;
        for (const x of Array.isArray(a) ? a : a ? [a] : []) {
          const n = typeof x === 'string' ? x : (x as { name?: string }).name;
          if (n && n.length < 80) authors.add(n.trim());
        }
      }
    } catch {
      /* malformed JSON-LD is common; ignore */
    }
  }
  const metaAuthor = meta(head, 'author');
  if (metaAuthor && !/^https?:/.test(metaAuthor) && metaAuthor.length < 80) authors.add(metaAuthor);

  const body = html.replace(/<(script|style|nav|header|footer|aside|form|figure|noscript)\b[\s\S]*?<\/\1>/gi, ' ');
  const scope = tag(body, 'article') || body;
  const paras = tags(scope, 'p')
    .map(stripTags)
    .filter((p) => p.length > 60 && !/^(subscribe|sign up|advertisement|read more|related:|copyright|©)/i.test(p) && !/cookie|newsletter/i.test(p.slice(0, 80)));
  const canonical = attr(head, 'link', 'href', (el) => /rel\s*=\s*["']canonical["']/i.test(el));
  return {
    title: meta(head, 'og:title') || stripTags(tag(head, 'title')),
    text: [...new Set(paras)].join(' '),
    publishedAt: publishedAt || undefined,
    authors: [...authors].slice(0, 5),
    siteName: meta(head, 'og:site_name') || undefined,
    canonicalUrl: canonical || meta(head, 'og:url') || undefined
  };
}

export interface FeedItem {
  title: string;
  link: string;
  summary: string;
  publishedAt?: string;
  authors: string[];
}

/** RSS 2.0 and Atom. */
export function parseFeed(xml: string): FeedItem[] {
  const rss = tags(xml, 'item');
  if (rss.length) {
    return rss.map((it) => ({
      title: text(it, 'title'),
      link: text(it, 'link') || attr(it, 'guid', 'x') || stripTags(tag(it, 'guid')),
      summary: stripTags(tag(it, 'content:encoded') || tag(it, 'description')).slice(0, 4000),
      publishedAt: toIso(text(it, 'pubDate') || text(it, 'dc:date')),
      authors: [text(it, 'dc:creator') || text(it, 'author')].filter(Boolean)
    }));
  }
  return tags(xml, 'entry').map((e) => ({
    title: text(e, 'title'),
    link: attr(e, 'link', 'href', (el) => !/rel\s*=\s*["'](?!alternate)/i.test(el)) || attr(e, 'link', 'href'),
    summary: stripTags(tag(e, 'content') || tag(e, 'summary')).slice(0, 4000),
    publishedAt: toIso(text(e, 'published') || text(e, 'updated')),
    authors: tags(e, 'author').map((a) => text(a, 'name')).filter(Boolean)
  }));
}

export function toIso(d: string | undefined): string | undefined {
  if (!d) return undefined;
  const t = Date.parse(d.trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}
