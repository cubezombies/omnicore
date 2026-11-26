import type { ProviderStatus, Source } from '../../shared/production';
import { fetchJson } from './http';
import type { ResearchProvider } from './types';

const API = 'https://en.wikipedia.org/w/api.php';

interface SearchResp {
  query?: { search?: { title: string }[] };
}
interface ExtractResp {
  query?: { pages?: { title: string; extract?: string; fullurl?: string; missing?: boolean }[] };
}

/** Wikipedia (free, no key). Returns article intros with their URLs as citable sources. */
export class WikipediaResearch implements ResearchProvider {
  id = 'wikipedia';
  label = 'Wikipedia';
  costPerUnitUsd = 0;
  constructor(private readonly api = API) {}

  async check(signal?: AbortSignal): Promise<ProviderStatus> {
    const base = { id: this.id, kind: 'research' as const, label: this.label, costPerUnitUsd: 0 };
    try {
      await fetchJson(`${this.api}?action=query&meta=siteinfo&format=json`, { signal, timeoutMs: 6000, retries: 0 });
      return { ...base, available: true, detail: 'Reachable' };
    } catch (e) {
      return { ...base, available: false, detail: `Unreachable (needs internet): ${(e as Error).message}` };
    }
  }

  async research(topic: string, signal: AbortSignal): Promise<Source[]> {
    const q = new URLSearchParams({ action: 'query', list: 'search', srsearch: topic, srlimit: '5', format: 'json', formatversion: '2' });
    const search = await fetchJson<SearchResp>(`${this.api}?${q}`, { signal });
    const titles = (search.query?.search ?? []).map((r) => r.title);
    if (!titles.length) return [];
    const x = new URLSearchParams({
      action: 'query',
      prop: 'extracts|info',
      exintro: '1',
      explaintext: '1',
      inprop: 'url',
      redirects: '1',
      titles: titles.join('|'),
      format: 'json',
      formatversion: '2'
    });
    const ex = await fetchJson<ExtractResp>(`${this.api}?${x}`, { signal });
    const byTitle = new Map((ex.query?.pages ?? []).map((p) => [p.title, p]));
    const retrievedAt = new Date().toISOString();
    const out: Source[] = [];
    for (const t of titles) {
      const p = byTitle.get(t) ?? [...byTitle.values()].find((v) => v.title.toLowerCase() === t.toLowerCase());
      const text = p?.extract?.trim() ?? '';
      if (!p || p.missing || text.length < 200 || /may refer to:?/i.test(text.slice(0, 300))) continue;
      out.push({
        id: `S${out.length + 1}`,
        title: p.title,
        url: p.fullurl ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`,
        publisher: 'Wikipedia',
        excerpt: text.slice(0, 5000),
        retrievedAt
      });
      if (out.length >= 3) break;
    }
    return out;
  }
}

/** The user's own research notes from the linked content item, treated as a source. */
export function notesSource(notes: string): Source | null {
  const text = notes.trim();
  if (text.length < 40) return null;
  return { id: 'N1', title: 'Your research notes', url: '', publisher: 'You', excerpt: text.slice(0, 8000), retrievedAt: new Date().toISOString() };
}
