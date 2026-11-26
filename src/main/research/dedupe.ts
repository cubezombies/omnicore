import type { Source, SourceKind } from '../../shared/production';
import { significantTokens } from '../providers/text';

export type RawSource = Omit<Source, 'id'> & { tempId?: string };

const TRACKING = /^(utm_|fbclid|gclid|mc_|ref$|ref_src|cmpid|guccounter|smid|ocid)/i;

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    let p = u.pathname.replace(/\/+$/, '');
    if (host === 'arxiv.org') p = p.replace(/^\/(pdf|abs)\/([^/]+?)(v\d+)?(\.pdf)?$/, '/abs/$2');
    return `${host}${p}${u.searchParams.toString() ? `?${u.searchParams}` : ''}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

export function arxivId(url: string): string | null {
  const m = /arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5}|[a-z-]+\/[0-9]{7})/i.exec(url);
  return m ? m[1].toLowerCase() : null;
}

const titleTokens = (t: string) => significantTokens(t.replace(/\s*[|–—-]\s*[^|–—-]{2,40}$/, '')); // drop " | Publisher" suffix
const jaccard = (a: Set<string>, b: Set<string>) => {
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i || 1);
};

const KIND_RANK: Record<SourceKind, number> = { research: 7, official: 7, company: 6, reporting: 5, background: 4, user: 8, other: 2, community: 1 };
const CONTENT_RANK = { full: 3, abstract: 2, notes: 3, summary: 1 } as const;

/** Merge two records for the same item, keeping the richer fields. */
function merge(a: RawSource, b: RawSource): RawSource {
  const better = (KIND_RANK[b.kind ?? 'other'] ?? 0) > (KIND_RANK[a.kind ?? 'other'] ?? 0) ? b : a;
  const other = better === a ? b : a;
  const level = (x: RawSource) => CONTENT_RANK[x.contentLevel ?? 'summary'] ?? 0;
  const richer = level(b) > level(a) || (level(b) === level(a) && b.excerpt.length > a.excerpt.length) ? b : a;
  return {
    ...other,
    ...better,
    excerpt: richer.excerpt,
    contentLevel: richer.contentLevel ?? better.contentLevel,
    publishedAt: better.publishedAt ?? other.publishedAt,
    authors: better.authors?.length ? better.authors : other.authors,
    // Prefer the publisher's DOI over an arXiv DOI (10.48550) so a published paper is not treated as a preprint.
    doi: [better.doi, other.doi].filter(Boolean).sort((x, y) => Number(/^10\.48550\//.test(x!)) - Number(/^10\.48550\//.test(y!)))[0]
  };
}

/** Collapse the same item found via several providers (same URL, DOI, arXiv id, or near-identical title from one publisher). */
export function dedupeSources(items: RawSource[]): RawSource[] {
  const out: RawSource[] = [];
  const keyOf = (s: RawSource) => [normalizeUrl(s.url), s.doi?.toLowerCase(), arxivId(s.url) ?? undefined].filter(Boolean) as string[];
  for (const s of items) {
    const keys = keyOf(s);
    const tt = titleTokens(s.title);
    const idx = out.findIndex((o) => {
      const ok = keyOf(o);
      if (keys.some((k) => ok.includes(k))) return true;
      // Same title and publisher (e.g. arXiv + OpenAlex record of one paper) or same scholarly title.
      const sameish = jaccard(tt, titleTokens(o.title)) >= 0.85 && tt.size >= 3;
      return sameish && (o.publisher === s.publisher || (o.kind === 'research' && s.kind === 'research'));
    });
    if (idx >= 0) out[idx] = merge(out[idx], s);
    else out.push(s);
  }
  return out;
}

const shingles = (text: string, n = 6): Set<string> => {
  const w = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
};
/** Fraction of b's shingles that appear in a (how much of b is copied from a). */
const containment = (a: Set<string>, b: Set<string>) => {
  if (!b.size) return 0;
  let i = 0;
  for (const x of b) if (a.has(x)) i++;
  return i / b.size;
};

/**
 * Assign independence groups. Sources from the same publisher share a group;
 * a source whose text largely repeats another (a press release reprinted by
 * outlets, wire copy) joins that source's group and records derivedFrom.
 * Ids must already be assigned.
 */
export function groupIndependence(sources: Source[]): Source[] {
  const sh = sources.map((s) => shingles(s.excerpt.slice(0, 8000)));
  const out = sources.map((s) => ({ ...s, group: `pub:${s.publisher.toLowerCase()}`, derivedFrom: undefined as string | undefined }));
  const order = [...out.keys()].sort((a, b) => (out[a].kind === 'company' || out[a].kind === 'official' ? -1 : 0) - (out[b].kind === 'company' || out[b].kind === 'official' ? -1 : 0));
  for (const i of order) {
    for (const j of order) {
      if (i === j || out[j].derivedFrom || out[i].derivedFrom === out[j].id) continue;
      if (out[i].group === out[j].group) continue;
      const c = containment(sh[i], sh[j]);
      if (c >= 0.3 && sh[j].size >= 20) {
        out[j].derivedFrom = out[i].id;
        out[j].group = out[i].group;
      }
    }
  }
  return out;
}
