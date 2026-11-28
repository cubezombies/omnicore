import fs from 'node:fs';
import path from 'node:path';
import type { ProviderStatus } from '../../shared/production';
import { assEscape, assHeader } from '../media/captions';
import { evaluateLicense, restrictionProblem, type LicenseRecord } from '../media/assetPolicy';
import { searchTerms, significantTokens } from './text';
import { runFfmpeg } from '../media/ffmpeg';
import { downloadTo, fetchJson } from './http';
import { ProviderUnavailableError, type VisualProvider, type VisualRequest, type VisualResult } from './types';
import { assetRelevance, seriesKey } from '../media/relevance';
import { graphicHtml, revealSteps } from '../media/graphics';

/** Renders self-contained HTML to a 1080×1920 PNG (Electron offscreen in the app; injected in tests). */
export type Rasterizer = (html: string, outPng: string, signal: AbortSignal) => Promise<void>;

/** Series of the images already used in this production (keys are file titles, or openverse:id with the title in usedTitles). */
const usedSeries = (req: Pick<VisualRequest, 'usedKeys' | 'usedTitles'>): Set<string> => new Set([...req.usedKeys, ...(req.usedTitles ?? [])].filter((k) => !k.startsWith('openverse:') && !k.startsWith('graphic:') && !k.startsWith('card:')).map(seriesKey));

const GENERIC = /^(ai|how|why|what|use|uses|used|work|works|explained|training|model|models|new|large|data|system|systems|history|histories|rise|future|role|impact|story|evolution|guide|introduction|basics|today|latest|artificial|intelligence|world|age|era)$/i;

/**
 * Search phrases for a scene, most specific first: the planned query, the topic, named things in the
 * narration (e.g. "NVIDIA H100"), then the topic's main subject word. Image search engines match every
 * word, so shorter fallbacks are needed; the relevance check still has to pass for whatever comes back.
 */
export function photoQueries(req: Pick<VisualRequest, 'scene' | 'brief' | 'plan'>): string[] {
  const named = [...req.scene.narration.matchAll(/\b([A-Z][A-Za-z0-9]*[A-Z0-9][A-Za-z0-9]*|[A-Z][a-z]+)(\s+[A-Z0-9][A-Za-z0-9-]*)+/g)].map((m) => m[0]).filter((n) => !/^(A|An|The|This|That|Another|Sources|Follow)\b/.test(n));
  const subject = searchTerms(req.brief.topic).split(' ').filter((w) => w && !GENERIC.test(w));
  const list = [req.plan?.query ?? req.scene.visualQuery, req.brief.topic, ...named.slice(0, 2), subject.slice(0, 2).join(' '), subject[0] ?? ''];
  return [...new Set(list.map((q) => searchTerms(q)).filter(Boolean))].slice(0, 5);
}

// ---------------------------------------------------------------------------
// Wikimedia Commons: real, freely licensed photos/illustrations with attribution.

/** Kept for compatibility: true when the licence passes the asset policy (share-alike allowed). */
export const isFreeLicense = (l: string): boolean => evaluateLicense(l, { allowShareAlike: true }).ok;
const stripHtml = (s: string) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

interface CommonsPage {
  title: string;
  index?: number;
  imageinfo?: {
    thumburl?: string;
    url: string;
    width: number;
    height: number;
    mime: string;
    descriptionurl: string;
    extmetadata?: Record<string, { value: string } | undefined>;
  }[];
}

export interface CommonsCandidate {
  key: string;
  url: string;
  ext: string;
  sourceUrl: string;
  license: string;
  attribution: string;
  width: number;
  height: number;
  licenseRecord: LicenseRecord;
  /** Image description from the file page, for relevance checks. */
  description?: string;
}

/**
 * Commons full-text search matches loosely (descriptions, categories), so a
 * file is only accepted when its own name mentions the topic, and its name plus
 * description mention at least two topic words (or the one word of a one-word topic).
 */
export function isRelevantFile(title: string, topic: string, description = ''): boolean {
  const want = significantTokens(topic);
  if (!want.size) return true;
  const hitsIn = (text: string) => {
    const have = [...significantTokens(text)];
    return new Set([...want].filter((w) => have.some((h) => h === w || (w.length >= 4 && h.startsWith(w)))));
  };
  const inTitle = hitsIn(title.replace(/^File:/, '').replace(/\.\w+$/, ''));
  if (inTitle.size === 0) return false;
  const all = new Set([...inTitle, ...hitsIn(description)]);
  return all.size >= Math.min(2, want.size);
}

/** Filter Commons search results to relevant, usable, freely licensed raster images. */
export function pickCommonsCandidates(pages: CommonsPage[], used: Set<string>, topic = '', policy: { allowShareAlike: boolean } = { allowShareAlike: false }): CommonsCandidate[] {
  return [...pages]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .flatMap((p): CommonsCandidate[] => {
      const ii = p.imageinfo?.[0];
      if (!ii || used.has(p.title)) return [];
      if (!/^image\/(jpeg|png)$/.test(ii.mime) || ii.width < 400 || ii.height < 400) return [];
      const meta = ii.extmetadata ?? {};
      const license = stripHtml(meta.LicenseShortName?.value ?? '');
      const verdict = evaluateLicense(license, policy);
      if (!verdict.ok) return [];
      if (restrictionProblem(stripHtml(meta.Restrictions?.value ?? ''), stripHtml(meta.Categories?.value ?? ''), p.title)) return [];
      if (topic && !isRelevantFile(p.title, topic, stripHtml(meta.ImageDescription?.value ?? '').slice(0, 2000))) return [];
      const creator = stripHtml(meta.Artist?.value ?? '');
      if (verdict.attributionRequired && !creator) return []; // cannot attribute → cannot use
      const artistRaw = creator || 'Unknown author';
      const artist = artistRaw.length > 120 ? `${artistRaw.slice(0, 117)}…` : artistRaw;
      const name = p.title.replace(/^File:/, '');
      return [
        {
          key: p.title,
          url: ii.thumburl ?? ii.url,
          ext: ii.mime === 'image/png' ? '.png' : '.jpg',
          sourceUrl: ii.descriptionurl,
          license,
          attribution: `"${name}" by ${artist}, ${license}, via ${/commons\.wikimedia\.org/.test(ii.descriptionurl) ? 'Wikimedia Commons' : 'Wikipedia'}`,
          width: ii.width,
          height: ii.height,
          description: stripHtml(meta.ImageDescription?.value ?? '').slice(0, 2000),
          licenseRecord: {
            origin: /commons\.wikimedia\.org/.test(ii.descriptionurl) ? 'commons' : 'wikipedia',
            sourceUrl: ii.descriptionurl,
            creator: artist,
            license,
            licenseUrl: stripHtml(meta.LicenseUrl?.value ?? ''),
            attributionRequired: verdict.attributionRequired || /true/i.test(meta.AttributionRequired?.value ?? ''),
            commercialUse: verdict.commercialUse,
            modification: verdict.modification,
            shareAlike: verdict.shareAlike,
            retrievedAt: new Date().toISOString(),
            verified: true,
            notes: verdict.reason
          }
        }
      ];
    });
}

const IMAGE_PROPS = {
  prop: 'imageinfo',
  iiprop: 'url|size|mime|extmetadata',
  iiurlwidth: '1440',
  iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|ImageDescription|AttributionRequired|Restrictions|Categories'
};

export class CommonsVisuals implements VisualProvider {
  id = 'wikimedia-commons';
  label = 'Wikimedia Commons (free licensed images)';
  costPerUnitUsd = 0;
  private articleCache = new Map<string, CommonsCandidate[]>();
  constructor(
    private readonly policy: { allowShareAlike: boolean } = { allowShareAlike: false },
    private readonly api = 'https://commons.wikimedia.org/w/api.php',
    private readonly wikiApi = 'https://en.wikipedia.org/w/api.php'
  ) {}

  /** Freely licensed images used in the cited Wikipedia articles: relevant by construction. */
  private async articleImages(titles: string[], signal: AbortSignal): Promise<CommonsCandidate[]> {
    const key = titles.join('|');
    const hit = this.articleCache.get(key);
    if (hit) return hit;
    const q = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', generator: 'images', gimlimit: '50', titles: key, ...IMAGE_PROPS });
    const r = await fetchJson<{ query?: { pages?: CommonsPage[] } }>(`${this.wikiApi}?${q}`, { signal });
    const out = pickCommonsCandidates(r.query?.pages ?? [], new Set(), '', this.policy);
    this.articleCache.set(key, out);
    return out;
  }

  async check(signal?: AbortSignal): Promise<ProviderStatus> {
    const base = { id: this.id, kind: 'visuals' as const, label: this.label, costPerUnitUsd: 0 };
    try {
      await fetchJson(`${this.api}?action=query&meta=siteinfo&format=json`, { signal, timeoutMs: 6000, retries: 0 });
      return { ...base, available: true, detail: 'Reachable' };
    } catch (e) {
      return { ...base, available: false, detail: `Unreachable (needs internet): ${(e as Error).message}` };
    }
  }

  private async search(query: string, topic: string, used: Set<string>, signal: AbortSignal): Promise<CommonsCandidate[]> {
    const q = new URLSearchParams({
      action: 'query',
      format: 'json',
      formatversion: '2',
      generator: 'search',
      gsrnamespace: '6',
      gsrsearch: `${query} filetype:bitmap`,
      gsrlimit: '15',
      ...IMAGE_PROPS
    });
    const r = await fetchJson<{ query?: { pages?: CommonsPage[] } }>(`${this.api}?${q}`, { signal });
    return pickCommonsCandidates(r.query?.pages ?? [], used, topic, this.policy);
  }

  async fetch(req: VisualRequest, signal: AbortSignal): Promise<VisualResult | null> {
    const wiki = req.sources.filter((s) => s.publisher === 'Wikipedia');
    const cited = wiki.filter((s) => req.scene.sourceIds.includes(s.id));
    for (const group of [cited, wiki]) {
      if (!group.length) continue;
      for (const c of (await this.articleImages(group.map((s) => s.title), signal)).filter((x) => !req.usedKeys.has(x.key) && !usedSeries(req).has(seriesKey(x.key)))) {
        const rel = assetRelevance({ title: c.key, description: c.description }, req.scene, req.brief.topic, { fromCitedArticle: true, context: req.contextTerms });
        if (rel.ok) return this.save(c, req, signal, `article:${group.map((s) => s.id).join(',')}`, rel.reason);
      }
    }
    const queries = photoQueries(req);
    for (const q of queries) {
      for (const c of await this.search(q, req.brief.topic, req.usedKeys, signal)) {
        if (usedSeries(req).has(seriesKey(c.key))) continue; // one shot per photo series
        const rel = assetRelevance({ title: c.key, description: c.description }, req.scene, req.brief.topic, { context: req.contextTerms });
        if (rel.ok) return this.save(c, req, signal, `search:${q}`, rel.reason);
      }
    }
    return null;
  }

  private async save(c: CommonsCandidate, req: VisualRequest, signal: AbortSignal, via: string, relevance: string): Promise<VisualResult> {
    const file = req.outBase + c.ext;
    await downloadTo(c.url, file, { signal });
    return { file, key: c.key, sourceUrl: c.sourceUrl, license: c.license, attribution: c.attribution, meta: { via, width: c.width, height: c.height, licenseRecord: c.licenseRecord, relevance, relevant: true } };
  }
}

// ---------------------------------------------------------------------------
// ComfyUI: local image generation on your own GPU (e.g. via Stability Matrix).

/** What the visuals step needs from the managed ComfyUI service (see main/comfy/service.ts). */
export interface ComfyGenerator {
  status(): Promise<{ available: boolean; detail: string; options: string[] }>;
  generate(r: { businessId: number; productionId: number; sceneIndex: number; jobId?: number | null; prompt: string; outFile: string; allowedDir: string; signal: AbortSignal }): Promise<{ file: string; sha256: string; generationId: number; meta: Record<string, unknown> }>;
}

/**
 * ComfyUI illustrations through Omnicore's managed service: approved model and workflow only, GPU checked first,
 * recorded with full provenance, and always labelled as AI-generated (never presented as a photo or evidence).
 */
export class ComfyVisuals implements VisualProvider {
  id = 'comfyui';
  label = 'ComfyUI (local AI illustration)';
  costPerUnitUsd = 0;
  constructor(private readonly gen: ComfyGenerator | undefined) {}

  async check(): Promise<ProviderStatus> {
    const base = { id: this.id, kind: 'visuals' as const, label: this.label, costPerUnitUsd: 0 };
    if (!this.gen) return { ...base, available: false, detail: 'ComfyUI is managed by the Omnicore app (not available here).', options: [] };
    const s = await this.gen.status();
    return { ...base, ...s };
  }

  async fetch(req: VisualRequest, signal: AbortSignal): Promise<VisualResult | null> {
    if (!this.gen || req.productionId === undefined || req.businessId === undefined) throw new ProviderUnavailableError('ComfyUI is not available for this production.');
    const r = await this.gen.generate({ businessId: req.businessId, productionId: req.productionId, sceneIndex: req.scene.index, jobId: req.jobId ?? null, prompt: req.scene.visualQuery, outFile: `${req.outBase}.png`, allowedDir: path.dirname(req.outBase), signal });
    return {
      file: r.file,
      key: `comfy:${r.generationId}`,
      sourceUrl: '',
      license: 'AI-generated illustration (Omnicore, local ComfyUI)',
      attribution: `AI-generated illustration (ComfyUI, ${String(r.meta.model)})`,
      meta: { ...r.meta, aiGenerated: true }
    };
  }
}

// ---------------------------------------------------------------------------
// Title cards: typographic graphics rendered locally by FFmpeg. Always available.

const PALETTES = [
  ['0x0f766e', '0x0b1120'],
  ['0x1e3a8a', '0x0b1120'],
  ['0x7c2d12', '0x0b1120'],
  ['0x581c87', '0x0b1120'],
  ['0x134e4a', '0x020617']
];

export class TitleCardVisuals implements VisualProvider {
  id = 'title-card';
  label = 'Title cards (generated locally)';
  costPerUnitUsd = 0;
  constructor(private readonly ffmpeg: () => string) {}

  async check(): Promise<ProviderStatus> {
    const base = { id: this.id, kind: 'visuals' as const, label: this.label, costPerUnitUsd: 0 };
    try {
      this.ffmpeg();
      return { ...base, available: true, detail: 'Built in (FFmpeg)' };
    } catch (e) {
      return { ...base, available: false, detail: (e as Error).message };
    }
  }

  async fetch(req: VisualRequest, signal: AbortSignal): Promise<VisualResult> {
    const dir = path.dirname(req.outBase);
    const base = path.basename(req.outBase);
    const [c0, c1] = PALETTES[req.scene.index % PALETTES.length];
    const text = (req.scene.onScreenText || req.brief.topic).slice(0, 80);
    const ass = `${assHeader([
      'Style: T,Segoe UI,110,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,6,5,110,110,0,1',
      'Style: K,Segoe UI,44,&H00D4EA5E,&H00D4EA5E,&H00000000,&H00000000,-1,0,0,0,100,100,6,0,1,0,0,8,110,110,260,1'
    ])}
Dialogue: 0,0:00:00.00,0:00:05.00,K,,0,0,0,,${assEscape(req.brief.topic.toUpperCase())}
Dialogue: 0,0:00:00.00,0:00:05.00,T,,0,0,0,,${assEscape(text)}
`;
    const assFile = `${base}.card.ass`;
    fs.writeFileSync(path.join(dir, assFile), ass, 'utf8');
    try {
      await runFfmpeg(
        this.ffmpeg(),
        [
          '-f', 'lavfi',
          '-i', `gradients=s=1080x1920:c0=${c0}:c1=${c1}:x0=0:y0=0:x1=1080:y1=1920:d=1`,
          '-vf', `ass=${assFile}`,
          '-frames:v', '1', '-update', '1',
          `${base}.png`
        ],
        { cwd: dir, signal }
      );
    } finally {
      fs.rmSync(path.join(dir, assFile), { force: true });
    }
    return { file: `${req.outBase}.png`, key: `card:${req.scene.index}`, sourceUrl: '', license: 'Generated graphic', attribution: 'Title card generated by Omnicore' };
  }
}

// ---------------------------------------------------------------------------
// Openverse: openly licensed images (Flickr, museums, etc.) with licence metadata, via the official API.

interface OpenverseImage {
  id: string;
  title?: string;
  foreign_landing_url: string;
  url: string;
  creator?: string;
  license: string;
  license_version?: string;
  license_url?: string;
  provider?: string;
  source?: string;
  tags?: { name: string }[];
  width?: number;
  height?: number;
  filetype?: string;
  mature?: boolean;
}

/** Openverse licence code → licence name the asset policy understands (NC/ND/sampling stay unrecognised and are rejected). */
export function openverseLicense(code: string, version = ''): string {
  const v = version ? ` ${version}` : '';
  switch (code.toLowerCase()) {
    case 'cc0':
      return 'CC0';
    case 'pdm':
      return 'Public domain mark';
    case 'by':
      return `CC BY${v}`;
    case 'by-sa':
      return `CC BY-SA${v}`;
    default:
      return `CC ${code.toUpperCase()}${v}`;
  }
}

export class OpenverseVisuals implements VisualProvider {
  id = 'openverse';
  label = 'Openverse (openly licensed images)';
  costPerUnitUsd = 0;
  constructor(
    private readonly policy: { allowShareAlike: boolean } = { allowShareAlike: false },
    private readonly api = 'https://api.openverse.org/v1/images/'
  ) {}

  async check(signal?: AbortSignal): Promise<ProviderStatus> {
    const base = { id: this.id, kind: 'visuals' as const, label: this.label, costPerUnitUsd: 0 };
    try {
      await fetchJson(`${this.api}?q=computer&page_size=1`, { signal, timeoutMs: 8000, retries: 0 });
      return { ...base, available: true, detail: 'Reachable' };
    } catch (e) {
      return { ...base, available: false, detail: `Unreachable (needs internet): ${(e as Error).message}` };
    }
  }

  async fetch(req: VisualRequest, signal: AbortSignal): Promise<VisualResult | null> {
    const licenses = this.policy.allowShareAlike ? 'by,by-sa,cc0,pdm' : 'by,cc0,pdm';
    const queries = photoQueries(req);
    for (const q of queries) {
      const params = new URLSearchParams({ q, license: licenses, page_size: '20', mature: 'false', extension: 'jpg,png' });
      const r = await fetchJson<{ results?: OpenverseImage[] }>(`${this.api}?${params}`, { signal });
      for (const img of r.results ?? []) {
        const key = `openverse:${img.id}`;
        if (req.usedKeys.has(key) || img.mature || usedSeries(req).has(seriesKey(img.title ?? ''))) continue;
        if ((img.width ?? 0) < 800 || (img.height ?? 0) < 600) continue;
        const license = openverseLicense(img.license, img.license_version);
        const verdict = evaluateLicense(license, this.policy);
        if (!verdict.ok) continue;
        const creator = (img.creator ?? '').trim();
        if (verdict.attributionRequired && !creator) continue;
        const title = (img.title ?? '').trim() || 'Untitled';
        const rel = assetRelevance({ title, tags: (img.tags ?? []).map((t) => t.name) }, req.scene, req.brief.topic, { context: req.contextTerms });
        if (!rel.ok) continue;
        const ext = img.filetype === 'png' || /\.png($|\?)/i.test(img.url) ? '.png' : '.jpg';
        const file = req.outBase + ext;
        try {
          await downloadTo(img.url, file, { signal });
        } catch {
          continue; // dead upstream link: try the next result
        }
        const licenseRecord: LicenseRecord = {
          origin: 'openverse',
          sourceUrl: img.foreign_landing_url,
          creator: creator || 'Unknown author',
          license,
          licenseUrl: img.license_url ?? '',
          attributionRequired: verdict.attributionRequired,
          commercialUse: verdict.commercialUse,
          modification: verdict.modification,
          shareAlike: verdict.shareAlike,
          retrievedAt: new Date().toISOString(),
          verified: true,
          notes: `${verdict.reason}; licence as published by ${img.source ?? img.provider ?? 'the source'} via Openverse`
        };
        return {
          file,
          key,
          sourceUrl: img.foreign_landing_url,
          license,
          attribution: `"${title}" by ${licenseRecord.creator}, ${license}, via ${img.source ?? img.provider ?? 'Openverse'}`,
          meta: { via: `openverse:${q}`, width: img.width, height: img.height, licenseRecord, relevance: rel.reason, relevant: true }
        };
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Original explanatory graphics, planned per scene (stat, comparison, steps, quote, source, title, sources).

export class GraphicsVisuals implements VisualProvider {
  id = 'graphics';
  label = 'Explanatory graphics (generated locally)';
  costPerUnitUsd = 0;
  constructor(private readonly rasterize?: Rasterizer) {}

  async check(): Promise<ProviderStatus> {
    const base = { id: this.id, kind: 'visuals' as const, label: this.label, costPerUnitUsd: 0 };
    return this.rasterize ? { ...base, available: true, detail: 'Built in' } : { ...base, available: false, detail: 'Needs the desktop app (graphics are drawn by its built-in renderer).' };
  }

  async fetch(req: VisualRequest, signal: AbortSignal): Promise<VisualResult | null> {
    if (!this.rasterize || !req.plan) return null;
    const spec = req.plan.graphic;
    const file = `${req.outBase}.png`;
    await this.rasterize(graphicHtml(spec, req.scene.index), file, signal);
    // Lists, comparisons and timelines build up one item at a time across the scene.
    const k = revealSteps(spec);
    const frames: string[] = [];
    if (k > 1) {
      for (let j = 1; j <= k; j++) {
        const fr = `${req.outBase}-f${j}.png`;
        if (j === k) fs.copyFileSync(file, fr);
        else await this.rasterize(graphicHtml(spec, req.scene.index, j), fr, signal);
        frames.push(fr);
      }
    }
    const creditedTo = 'attribution' in spec ? spec.attribution : spec.kind === 'source' ? spec.publisher : undefined;
    return {
      file,
      key: `graphic:${spec.kind}:${req.scene.index}`,
      sourceUrl: '',
      license: 'Original graphic (Omnicore)',
      attribution: 'Graphic by AI, Actually',
      meta: { generated: true, graphicKind: spec.kind, planReason: req.plan.reason, labelled: true, ...(frames.length ? { frames } : {}), ...(creditedTo ? { creditedTo } : {}) }
    };
  }
}
