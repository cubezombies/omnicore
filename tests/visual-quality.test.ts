import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planScene } from '../src/main/media/visualPlan';
import { assetRelevance } from '../src/main/media/relevance';
import { GRAPHIC_MARK, graphicHtml } from '../src/main/media/graphics';
import { buildRenderArgs, XFADE_SEC } from '../src/main/media/render';
import { verifyVisualAssets } from '../src/main/media/assetPolicy';
import { GraphicsVisuals, OpenverseVisuals, openverseLicense, photoQueries } from '../src/main/providers/visuals';
import { visualVarietyFindings } from '../src/main/qa/engine';
import { sceneMotion } from '../src/main/pipeline/runner';
import { openDatabase } from '../src/main/db/database';
import { ProductionRepository } from '../src/main/db/productions';
import type { Brief, ProductionAsset, Scene, Source } from '../src/shared/production';

const tmp = () => fs.mkdtempSync(path.join(process.env.AIMO_TEST_TMP ?? os.tmpdir(), 'vq-'));
const brief: Brief = { topic: 'speculative decoding', title: 't', angle: '', audience: '', keyFacts: [], targetSeconds: 80, claims: [] };
const sources: Source[] = [
  { id: 'S1', title: 'Accelerating LLM decoding with speculative sampling', url: 'https://arxiv.org/abs/1', publisher: 'arXiv', excerpt: '', retrievedAt: '', kind: 'research' },
  { id: 'S2', title: 'Speculative decoding explained', url: 'https://example.org', publisher: 'The Verge', excerpt: '', retrievedAt: '', kind: 'reporting' }
];
const scene = (o: Partial<Scene>): Scene => ({ index: 1, role: 'fact', narration: '', onScreenText: '', visualQuery: 'speculative decoding', sourceIds: ['S1'], ...o });

describe('scene visual planning', () => {
  it('turns stated figures into stat or comparison graphics using only the numbers in the narration', () => {
    const p = planScene(scene({ narration: 'The paper reports up to 2.5x faster generation with no loss in quality.' }), brief, sources, 'AI, Actually', null);
    expect(p.kind).toBe('compare');
    expect(p.graphic).toMatchObject({ kind: 'compare', attribution: 'arXiv', bars: [{ display: '1×' }, { display: '2.5×', value: 2.5 }] });
    const s = planScene(scene({ narration: 'Researchers tested the method on 128 tasks across coding and math.' }), brief, sources, 'AI, Actually', null);
    expect(s).toMatchObject({ kind: 'stat', graphic: { value: '128' } });
    expect(planScene(scene({ narration: 'AI racks draw around 60 kilowatts each.' }), brief, sources, 'AI, Actually', null)).toMatchObject({ kind: 'stat', graphic: { value: '60 kW' } });
  });

  it('plans process diagrams, attributed quotes, a sources roll for the outro, and avoids repeating a kind', () => {
    expect(planScene(scene({ narration: 'A small model drafts several tokens, then a larger model verifies them in one pass.' }), brief, sources, 'AI, Actually', null).kind).toBe('steps');
    const q = planScene(scene({ narration: 'The Verge says the technique is now used in production chatbots.', sourceIds: ['S2'] }), brief, sources, 'AI, Actually', null);
    expect(q).toMatchObject({ kind: 'quote', graphic: { attribution: 'The Verge' } });
    expect(planScene(scene({ narration: 'The Verge says the technique is now used in production chatbots.', sourceIds: ['S2'] }), brief, sources, 'AI, Actually', 'quote').kind).not.toBe('quote');
    expect(planScene(scene({ role: 'outro', narration: 'Sources are below.' }), brief, sources, 'AI, Actually', null)).toMatchObject({ kind: 'sources', graphic: { publishers: ['arXiv', 'The Verge'] } });
    expect(planScene(scene({ role: 'hook', narration: 'Why do chatbots type one word at a time?' }), brief, sources, 'AI, Actually', null)).toMatchObject({ kind: 'photo', graphic: { kind: 'title' } });
  });
});

describe('visual relevance check', () => {
  const sc = { visualQuery: 'GPU data center', narration: 'Inference runs on GPUs in large data centers.' };
  it('accepts images whose own metadata matches the topic and scene', () => {
    expect(assetRelevance({ title: 'NVIDIA GPU server rack in a data center', tags: ['gpu', 'datacenter'] }, sc, 'GPU inference').ok).toBe(true);
  });
  it('rejects unrelated, loosely related, logo and screenshot images', () => {
    expect(assetRelevance({ title: 'Sunset over a lake' }, sc, 'GPU inference').ok).toBe(false);
    expect(assetRelevance({ title: 'Data center building exterior' }, sc, 'GPU inference').ok).toBe(false); // no topic anchor
    expect(assetRelevance({ title: 'NVIDIA GPU logo' }, sc, 'GPU inference')).toMatchObject({ ok: false, reason: expect.stringMatching(/logo/) });
    expect(assetRelevance({ title: 'GPU driver settings screenshot' }, sc, 'GPU inference')).toMatchObject({ ok: false, reason: expect.stringMatching(/screenshot/) });
    expect(assetRelevance({ title: 'No Data Center GPU sign' }, sc, 'GPU inference')).toMatchObject({ ok: false, reason: expect.stringMatching(/advocacy/) });
    expect(assetRelevance({ title: 'Protesters outside a GPU data center' }, sc, 'GPU inference').ok).toBe(false);
    expect(assetRelevance({ title: 'GPU inference energy chart' }, sc, 'GPU inference')).toMatchObject({ ok: false, reason: expect.stringMatching(/chart/) });
    expect(assetRelevance({ title: 'Photograph of a GPU in a data center' }, sc, 'GPU inference').ok).toBe(true); // "graph" inside "photograph" is not a chart
    const gs = { visualQuery: 'GPU execution efficiency', narration: 'Training takes huge GPU resources.' };
    expect(assetRelevance({ title: "Moore's Law over 120 Years", tags: ['gpu', 'nvidia', 'cpu'] }, gs, 'how GPUs accelerate AI training')).toMatchObject({ ok: false, reason: expect.stringMatching(/title names no specific topic word/) });
    expect(assetRelevance({ title: 'Intelligence Inside: the future of AI and computation', tags: ['gpu'] }, gs, 'how GPUs accelerate AI training').ok).toBe(false);
    expect(assetRelevance({ title: 'GPU lab visit', tags: ['people', 'gpu'] }, gs, 'how GPUs accelerate AI training')).toMatchObject({ ok: false, reason: expect.stringMatching(/people/) });
    expect(assetRelevance({ title: 'nvidia-tesla-k20-k20x-gpu-accelerators', tags: ['gpu'] }, gs, 'how GPUs accelerate AI training').ok).toBe(true);
    expect(assetRelevance({ title: 'Broken Nvidia GeForce 4 Ti : Broken GPU Chip 3/4' }, gs, 'how GPUs accelerate AI training')).toMatchObject({ ok: false, reason: expect.stringMatching(/damage/) });
    const h100 = { visualQuery: 'GPU cluster', narration: 'Llama 8B models were tuned on eight NVIDIA H100 GPUs.' };
    expect(assetRelevance({ title: 'nVidia NV35 GPU' }, h100, 'how GPUs accelerate AI training')).toMatchObject({ ok: false, reason: expect.stringMatching(/nv35 but the narration is about h100/) });
    expect(assetRelevance({ title: 'NVIDIA H100 GPU board' }, h100, 'how GPUs accelerate AI training').ok).toBe(true);
    expect(assetRelevance({ title: 'Sapphire Radeon 6950 in Originalverpackung OVP ATI AMD GPU' }, h100, 'how GPUs accelerate AI training')).toMatchObject({ ok: false, reason: expect.stringMatching(/amd product but the narration is about nvidia/) });
  });
});

describe('generated graphics', () => {
  it('are self-contained, escaped and always carry the graphic mark', () => {
    const html = graphicHtml({ kind: 'quote', text: 'Up to <b>3x</b> "faster"', attribution: 'arXiv & co' }, 2);
    expect(html).toContain(GRAPHIC_MARK);
    expect(html).toContain('&lt;b&gt;3x&lt;/b&gt;');
    expect(html).not.toMatch(/<script|https?:\/\//i);
  });

  it('render through the rasteriser and are recorded as original, labelled graphics', async () => {
    const dir = tmp();
    const raster = vi.fn(async (_html: string, out: string) => fs.writeFileSync(out, 'PNG'));
    const g = new GraphicsVisuals(raster);
    const plan = planScene(scene({ narration: 'Researchers tested the method on 128 tasks.' }), brief, sources, 'AI, Actually', null);
    const r = await g.fetch({ scene: scene({}), brief, sources, sceneCount: 8, outBase: path.join(dir, 'scene-01'), usedKeys: new Set(), plan }, AbortSignal.timeout(5000));
    expect(r).toMatchObject({ license: 'Original graphic (Omnicore)', meta: { generated: true, labelled: true, graphicKind: 'stat' } });
    expect(fs.existsSync(r!.file)).toBe(true);
    expect(await new GraphicsVisuals().fetch({ scene: scene({}), brief, sources, sceneCount: 8, outBase: path.join(dir, 'x'), usedKeys: new Set(), plan }, AbortSignal.timeout(5000))).toBeNull();
    const asset = (meta: Record<string, unknown>) => ({ id: 1, productionId: 1, kind: 'image', sceneIndex: 0, path: 'a.png', provider: 'graphics', sourceUrl: '', license: '', attribution: '', meta }) as unknown as ProductionAsset;
    expect(verifyVisualAssets([asset({ generated: true, labelled: true })], { allowShareAlike: false })).toEqual([]);
    expect(verifyVisualAssets([asset({})], { allowShareAlike: false })[0]).toMatch(/not marked/);
  });
});

describe('Openverse images', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('maps licence codes so only commercial, modifiable licences pass', () => {
    expect(openverseLicense('by', '4.0')).toBe('CC BY 4.0');
    expect(openverseLicense('cc0')).toBe('CC0');
    expect(openverseLicense('by-nc', '2.0')).toBe('CC BY-NC 2.0');
  });

  it('picks the first relevant, licence-verified result and records full provenance', async () => {
    const dir = tmp();
    const results = [
      { id: 'a', title: 'Sunset over a lake', foreign_landing_url: 'https://flickr.com/a', url: 'https://img/a.jpg', creator: 'X', license: 'by', license_version: '2.0', width: 2000, height: 1500 },
      { id: 'b', title: 'GPU logo', foreign_landing_url: 'https://flickr.com/b', url: 'https://img/b.jpg', creator: 'X', license: 'by', width: 2000, height: 1500 },
      { id: 'c', title: 'GPU server in a data center', tags: [{ name: 'inference' }], foreign_landing_url: 'https://flickr.com/c', url: 'https://img/c.jpg', creator: 'Jane Doe', license: 'by', license_version: '2.0', license_url: 'https://creativecommons.org/licenses/by/2.0/', source: 'flickr', width: 2000, height: 1500 }
    ];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => (String(u).includes('api.openverse.org') ? new Response(JSON.stringify({ results })) : new Response(Buffer.alloc(4000, 7)))));
    const r = await new OpenverseVisuals().fetch(
      { scene: scene({ visualQuery: 'GPU data center', narration: 'Inference runs on GPUs in data centers.' }), brief: { ...brief, topic: 'GPU inference' }, sources, sceneCount: 8, outBase: path.join(dir, 'scene-02'), usedKeys: new Set() },
      AbortSignal.timeout(5000)
    );
    expect(r).toMatchObject({ key: 'openverse:c', license: 'CC BY 2.0', sourceUrl: 'https://flickr.com/c', meta: { relevant: true, licenseRecord: { origin: 'openverse', creator: 'Jane Doe', verified: true, commercialUse: true, modification: true } } });
    expect(r!.attribution).toBe('"GPU server in a data center" by Jane Doe, CC BY 2.0, via flickr');
    expect(verifyVisualAssets([{ id: 1, productionId: 1, kind: 'image', sceneIndex: 0, path: 'x', provider: 'openverse', sourceUrl: r!.sourceUrl, license: r!.license, attribution: r!.attribution, meta: r!.meta! } as unknown as ProductionAsset], { allowShareAlike: false })).toEqual([]);
  });
});

const img = (i: number, provider: string, visualKind: string, sha = `h${i}`) => ({ id: i, productionId: 1, kind: 'image', sceneIndex: i, path: `s${i}.png`, provider, sourceUrl: '', license: '', attribution: '', meta: { visualKind, sha256: sha } }) as unknown as ProductionAsset;
const result = (fs: ReturnType<typeof visualVarietyFindings>, id: string) => fs.find((f) => f.checkId === id)!;

describe('visual QA', () => {
  it('flags a video that is mostly text cards even when the card types alternate', () => {
    const kinds = ['title', 'quote', 'source', 'quote', 'source', 'quote', 'source', 'sources'];
    const f = visualVarietyFindings(kinds.map((k, i) => img(i, 'graphics', k)), 8);
    expect(f.find((x) => x.checkId === 'visuals.monotony')).toMatchObject({ passed: false, severity: 'major' });
  });

  it('searches photos from specific to broad, including named things in the narration', () => {
    const q = photoQueries({ scene: scene({ visualQuery: 'GPU execution efficiency', narration: 'A study fine-tuned Llama models on eight NVIDIA H100 GPUs.' }), brief: { ...brief, topic: 'how GPUs accelerate AI training' } });
    expect(q[0]).toBe('GPU execution efficiency');
    expect(q).toContain('NVIDIA H100 GPUs');
    expect(q).toContain('GPUs');
    expect(q.length).toBeLessThanOrEqual(5);
  });

  it('passes a varied set of visuals', () => {
    const kinds = ['photo', 'stat', 'photo', 'steps', 'quote', 'photo', 'source', 'sources'];
    const f = visualVarietyFindings(kinds.map((k, i) => img(i, k === 'photo' ? 'openverse' : 'graphics', k)), 8);
    expect(f.every((x) => x.passed)).toBe(true);
  });

  it('fails title-card repetition, monotony, missing scenes and reused images', () => {
    const cards = visualVarietyFindings(Array.from({ length: 8 }, (_, i) => img(i, 'title-card', 'title-card')), 8);
    expect(result(cards, 'visuals.title-cards').passed).toBe(false);
    expect(result(cards, 'visuals.variety').passed).toBe(false);
    const gap = visualVarietyFindings([img(0, 'graphics', 'stat'), img(2, 'graphics', 'quote')], 3);
    expect(result(gap, 'visuals.coverage')).toMatchObject({ passed: false, severity: 'critical' });
    const dup = visualVarietyFindings([img(0, 'openverse', 'photo', 'same'), img(1, 'graphics', 'stat'), img(2, 'openverse', 'photo', 'same')], 3);
    expect(result(dup, 'visuals.duplicates').passed).toBe(false);
  });
});

describe('motion and transitions', () => {
  it('varies camera moves by visual kind and keeps cuts on the narration boundaries', () => {
    const imgs = [img(0, 'openverse', 'photo'), img(1, 'graphics', 'stat'), img(2, 'graphics', 'steps'), img(3, 'graphics', 'sources')];
    expect(imgs.map((_, i) => sceneMotion(imgs, i))).toEqual([{ motion: 'in' }, { motion: 'still', transition: 'fade' }, { motion: 'still', transition: 'slideleft' }, { motion: 'still', transition: 'circleopen' }]);
    const scenes = [2, 3, 4].map((d, i) => ({ image: `i${i}.png`, audio: `a${i}.wav`, durationSec: d, ...sceneMotion(imgs, i) }));
    const fc = buildRenderArgs({ scenes, captions: 'c.ass', output: 'o.mp4' })[buildRenderArgs({ scenes, captions: 'c.ass', output: 'o.mp4' }).indexOf('-filter_complex') + 1];
    expect(fc).toContain(`xfade=transition=fade:duration=${XFADE_SEC}:offset=2.0000`);
    expect(fc).toContain(`xfade=transition=slideleft:duration=${XFADE_SEC}:offset=5.0000[vc]`);
    expect(fc).toContain(`d=${Math.round((2 + XFADE_SEC) * 30)}:`); // first picture overlaps the next
    expect(fc).toContain('[a0][a1][a2]concat=n=3:v=0:a=1[ac]');
  });
});

describe('settings', () => {
  it('adds Openverse and graphics once to existing visual settings', () => {
    const db = openDatabase(path.join(tmp(), 'x.db'));
    const repo = new ProductionRepository(db);
    db.prepare(`INSERT INTO settings (key, value) VALUES ('providers', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify({ visuals: ['wikimedia-commons', 'title-card'] }));
    expect(repo.getSettings().visuals).toEqual(['wikimedia-commons', 'openverse', 'graphics', 'title-card']);
    repo.saveSettings({ ...repo.getSettings(), visuals: ['wikimedia-commons', 'title-card'] });
    expect(repo.getSettings().visuals).toEqual(['wikimedia-commons', 'title-card']); // user removal respected
    db.close();
  });
});
