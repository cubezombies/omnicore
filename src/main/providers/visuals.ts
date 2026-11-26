import fs from 'node:fs';
import path from 'node:path';
import type { ProviderStatus } from '../../shared/production';
import { assEscape, assHeader } from '../media/captions';
import { searchTerms, significantTokens } from './text';
import { runFfmpeg } from '../media/ffmpeg';
import { downloadTo, fetchJson, fetchRetry } from './http';
import { ProviderUnavailableError, type VisualProvider, type VisualRequest, type VisualResult } from './types';

// ---------------------------------------------------------------------------
// Wikimedia Commons: real, freely licensed photos/illustrations with attribution.

const FREE_LICENSE = /^(cc0|cc[- ]by(-sa)?([- ]\d(\.\d)?)?|public domain|pd\b|pd-|no restrictions)/i;
export const isFreeLicense = (l: string): boolean => FREE_LICENSE.test(l.trim());
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
export function pickCommonsCandidates(pages: CommonsPage[], used: Set<string>, topic = ''): CommonsCandidate[] {
  return [...pages]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .flatMap((p): CommonsCandidate[] => {
      const ii = p.imageinfo?.[0];
      if (!ii || used.has(p.title)) return [];
      if (!/^image\/(jpeg|png)$/.test(ii.mime) || ii.width < 400 || ii.height < 400) return [];
      const meta = ii.extmetadata ?? {};
      const license = stripHtml(meta.LicenseShortName?.value ?? '');
      if (!isFreeLicense(license)) return [];
      if (topic && !isRelevantFile(p.title, topic, stripHtml(meta.ImageDescription?.value ?? '').slice(0, 2000))) return [];
      const artistRaw = stripHtml(meta.Artist?.value ?? '') || 'Unknown author';
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
          height: ii.height
        }
      ];
    });
}

const IMAGE_PROPS = {
  prop: 'imageinfo',
  iiprop: 'url|size|mime|extmetadata',
  iiurlwidth: '1440',
  iiextmetadatafilter: 'LicenseShortName|Artist|ImageDescription'
};

export class CommonsVisuals implements VisualProvider {
  id = 'wikimedia-commons';
  label = 'Wikimedia Commons (free licensed images)';
  costPerUnitUsd = 0;
  private articleCache = new Map<string, CommonsCandidate[]>();
  constructor(
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
    const out = pickCommonsCandidates(r.query?.pages ?? [], new Set());
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
    return pickCommonsCandidates(r.query?.pages ?? [], used, topic);
  }

  async fetch(req: VisualRequest, signal: AbortSignal): Promise<VisualResult | null> {
    const wiki = req.sources.filter((s) => s.publisher === 'Wikipedia');
    const cited = wiki.filter((s) => req.scene.sourceIds.includes(s.id));
    for (const group of [cited, wiki]) {
      if (!group.length) continue;
      const c = (await this.articleImages(group.map((s) => s.title), signal)).find((x) => !req.usedKeys.has(x.key));
      if (c) return this.save(c, req, signal, `article:${group.map((s) => s.id).join(',')}`);
    }
    const queries = [...new Set([req.scene.visualQuery, req.brief.topic].map((q) => searchTerms(q)).filter(Boolean))];
    for (const q of queries) {
      const cands = await this.search(q, req.brief.topic, req.usedKeys, signal);
      const c = cands[0];
      if (c) return this.save(c, req, signal, `search:${q}`);
    }
    return null;
  }

  private async save(c: CommonsCandidate, req: VisualRequest, signal: AbortSignal, via: string): Promise<VisualResult> {
    const file = req.outBase + c.ext;
    await downloadTo(c.url, file, { signal });
    return { file, key: c.key, sourceUrl: c.sourceUrl, license: c.license, attribution: c.attribution, meta: { via, width: c.width, height: c.height } };
  }
}

// ---------------------------------------------------------------------------
// ComfyUI: local image generation on your own GPU (e.g. via Stability Matrix).

export function comfyWorkflow(prompt: string, checkpoint: string, seed: number): Record<string, unknown> {
  return {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 1344, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: 'text, letters, watermark, logo, signature, lowres, blurry, deformed', clip: ['4', 1] } },
    '3': {
      class_type: 'KSampler',
      inputs: { seed, steps: 25, cfg: 6, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] }
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'omnicore', images: ['8', 0] } }
  };
}

export class ComfyVisuals implements VisualProvider {
  id = 'comfyui';
  label = 'ComfyUI (local image generation)';
  costPerUnitUsd = 0;
  constructor(private readonly baseUrl: string, private readonly checkpoint: string, private readonly pollMs = 1500) {}

  private url(p: string) {
    return `${this.baseUrl.replace(/\/+$/, '')}${p}`;
  }

  async check(signal?: AbortSignal): Promise<ProviderStatus> {
    const base = { id: this.id, kind: 'visuals' as const, label: this.label, costPerUnitUsd: 0 };
    try {
      const info = await fetchJson<Record<string, { input?: { required?: { ckpt_name?: [string[]] } } }>>(
        this.url('/object_info/CheckpointLoaderSimple'),
        { signal, timeoutMs: 4000, retries: 0 }
      );
      const ckpts = info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
      if (!this.checkpoint) return { ...base, available: false, detail: 'Choose a checkpoint.', options: ckpts };
      const ok = ckpts.includes(this.checkpoint);
      return { ...base, available: ok, detail: ok ? `Checkpoint: ${this.checkpoint}` : `Checkpoint "${this.checkpoint}" not found.`, options: ckpts };
    } catch {
      return { ...base, available: false, detail: `No ComfyUI server at ${this.baseUrl}. Start ComfyUI to enable local generation.`, options: [] };
    }
  }

  async fetch(req: VisualRequest, signal: AbortSignal): Promise<VisualResult | null> {
    if (!this.checkpoint) throw new ProviderUnavailableError('ComfyUI needs a checkpoint. Choose one in Studio → Providers.');
    const prompt = `${req.scene.visualQuery}, editorial illustration, cinematic lighting, high detail, vertical composition`;
    const seed = Math.floor(Math.random() * 2 ** 31);
    let promptId: string;
    try {
      const res = await fetchRetry(this.url('/prompt'), {
        signal,
        retries: 0,
        init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: comfyWorkflow(prompt, this.checkpoint, seed), client_id: 'omnicore' }) }
      });
      promptId = ((await res.json()) as { prompt_id: string }).prompt_id;
    } catch (e) {
      throw new ProviderUnavailableError(`ComfyUI at ${this.baseUrl} did not accept the job: ${(e as Error).message}`);
    }
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.pollMs));
      if (signal.aborted) return null;
      const hist = await fetchJson<Record<string, { outputs?: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }>; status?: { status_str?: string } }>>(
        this.url(`/history/${promptId}`),
        { signal }
      );
      const entry = hist[promptId];
      if (!entry) continue;
      if (entry.status?.status_str === 'error') throw new Error('ComfyUI reported an error while generating the image.');
      const img = Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? [])[0];
      if (!img) continue;
      const file = `${req.outBase}.png`;
      const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: img.type });
      await downloadTo(this.url(`/view?${q}`), file, { signal });
      return {
        file,
        key: `comfy:${promptId}`,
        sourceUrl: '',
        license: 'AI-generated (local)',
        attribution: `AI-generated with ComfyUI (${this.checkpoint})`,
        meta: { prompt, seed }
      };
    }
    throw new Error('ComfyUI did not finish the image within 10 minutes.');
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
