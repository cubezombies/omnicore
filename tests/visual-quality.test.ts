import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planScene } from '../src/main/media/visualPlan';
import { assetRelevance } from '../src/main/media/relevance';
import { GRAPHIC_MARK, graphicHtml, type GraphicSpec } from '../src/main/media/graphics';
import { buildRenderArgs, XFADE_SEC } from '../src/main/media/render';
import { verifyVisualAssets } from '../src/main/media/assetPolicy';
import { GraphicsVisuals, OpenverseVisuals, openverseLicense, photoQueries } from '../src/main/providers/visuals';
import { graphicFindings, visualVarietyFindings } from '../src/main/qa/engine';
import { sceneMotion } from '../src/main/pipeline/runner';
import { openDatabase } from '../src/main/db/database';
import { ProductionRepository } from '../src/main/db/productions';
import type { Brief, ProductionAsset, Scene, Source } from '../src/shared/production';
import { testAudio } from './helpers/audioPlan';

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
    expect(assetRelevance({ title: 'nvidia-tesla-k20-k20x-gpu-accelerators', tags: ['gpu'] }, gs, 'how GPUs accelerate AI training', { context: ['NVIDIA', 'chip'] }).ok).toBe(true);
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
    const args0 = buildRenderArgs({ scenes, captions: 'c.ass', output: 'o.mp4', audio: testAudio(3) });
    const fc = args0[args0.indexOf('-filter_complex') + 1];
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

describe('timelines, build-up animation and graphic attribution', () => {
  it('turns dated narration into a timeline using only its own dates and words', () => {
    const p = planScene(scene({ narration: 'The project began in 2017, and in 2023 it shipped its first open model.' }), brief, sources, 'AI, Actually', null);
    expect(p.kind).toBe('timeline');
    expect(p.graphic).toMatchObject({ kind: 'timeline', attribution: 'arXiv' });
    const ev = (p.graphic as { events: { when: string; what: string }[] }).events;
    expect(ev.map((e) => e.when)).toEqual(['2017', '2023']);
    expect(ev[1].what).toMatch(/shipped its first open model/);
  });

  it('renders build-up frames that reveal one more item each time', async () => {
    const steps: GraphicSpec = { kind: 'steps', title: 'How it works', steps: ['Draft tokens', 'Verify them', 'Keep the good ones'] };
    expect((graphicHtml(steps, 0, 1).match(/visibility:hidden/g) ?? []).length).toBe(2);
    expect(graphicHtml(steps, 0).includes('visibility:hidden')).toBe(false);
    const dir = tmp();
    const raster = vi.fn(async (_h: string, out: string) => fs.writeFileSync(out, 'PNG'));
    const plan = planScene(scene({ narration: 'A small model drafts several tokens, then a larger model verifies them in one pass.' }), brief, sources, 'AI, Actually', null);
    const r = await new GraphicsVisuals(raster).fetch({ scene: scene({}), brief, sources, sceneCount: 8, outBase: path.join(dir, 's'), usedKeys: new Set(), plan }, AbortSignal.timeout(5000));
    expect((r!.meta!.frames as string[]).length).toBe(2);
    expect(raster).toHaveBeenCalledTimes(2); // full frame + first reveal (the last frame reuses the full one)
  });

  it('builds a multi-frame scene with correct input indexes alongside music and effects', () => {
    const args = buildRenderArgs({
      scenes: [
        { image: 'a.png', audio: 'a.wav', durationSec: 3 },
        { image: 'b3.png', frames: ['b1.png', 'b2.png', 'b3.png'], audio: 'b.wav', durationSec: 6, transition: 'fade' }
      ],
      captions: 'c.ass',
      output: 'o.mp4',
      audio: testAudio(2, { sfx: [{ path: 'w.m4a', atSec: [2.7] }] })
    });
    const inputs = args.filter((_, i) => args[i - 1] === '-i');
    expect(inputs).toEqual(['a.png', 'b1.png', 'b2.png', 'b3.png', 'a.wav', 'b.wav', 'm.m4a', 'stems/duck-envelope.wav', 'w.m4a']);
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toContain('[1:v]scale');
    expect(fc).toContain('[v1f0][v1f1]xfade=transition=fade:duration=0.2');
    expect(fc).toContain('[4:a]aresample'); // first narration
    expect(fc).toContain('[6:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim'); // music
    expect(fc).toContain('[7:a]aresample=48000,pan=stereo|c0=c0|c1=c0'); // ducking envelope, channel copied (no -3 dB upmix)
    expect(fc).toContain('[8:a]aresample'); // effect
    expect(fc).toContain('alimiter=limit=0.841');
  });

  it('flags a graphic that credits a source its scene does not cite', () => {
    const prod = {
      storyboard: { scenes: [scene({ index: 0, sourceIds: ['S1'] })] },
      sources,
      brief: { ...brief, claims: [] },
      assets: [
        { id: 1, productionId: 1, kind: 'image', sceneIndex: 0, path: 'x.png', provider: 'graphics', sourceUrl: '', license: '', attribution: '', meta: { creditedTo: 'The Verge' } },
        { id: 2, productionId: 1, kind: 'narration', sceneIndex: 0, path: 'a.wav', provider: 'x', sourceUrl: '', license: '', attribution: '', meta: { durationSec: 12 } }
      ]
    } as never;
    const f = graphicFindings(prod);
    expect(f.find((x) => x.checkId === 'visuals.attribution')).toMatchObject({ passed: false, severity: 'major' });
    expect(f.find((x) => x.checkId === 'visuals.static')).toMatchObject({ passed: false, severity: 'minor' });
  });
});

describe('real render of a build-up scene', () => {
  it('produces a correctly timed 1080x1920 video through FFmpeg', async () => {
    const { resolveFfmpeg, runFfmpeg, probe } = await import('../src/main/media/ffmpeg');
    const ff = resolveFfmpeg('');
    const dir = tmp();
    const color = ['red', 'green', 'blue', 'white'];
    for (let i = 0; i < 4; i++) await runFfmpeg(ff, ['-f', 'lavfi', '-i', `color=c=${color[i]}:s=1080x1920:d=1`, '-frames:v', '1', '-update', '1', `f${i}.png`], { cwd: dir });
    for (const n of ['a', 'b']) await runFfmpeg(ff, ['-f', 'lavfi', '-i', 'sine=f=220:d=2.5', `${n}.wav`], { cwd: dir });
    await runFfmpeg(ff, ['-f', 'lavfi', '-i', 'sine=f=440:d=4', '-c:a', 'aac', 'm.m4a'], { cwd: dir });
    fs.mkdirSync(path.join(dir, 'stems'), { recursive: true });
    const { writeWav } = await import('../src/main/audio/mix');
    writeWav(path.join(dir, 'stems', 'duck-envelope.wav'), new Float32Array(8000 * 6).fill(0.5), 8000);
    fs.writeFileSync(path.join(dir, 'c.ass'), '[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,40,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n');
    const plan = { scenes: [{ image: 'f0.png', audio: 'a.wav', durationSec: 2.6 }, { image: 'f3.png', frames: ['f1.png', 'f2.png', 'f3.png'], audio: 'b.wav', durationSec: 3.0, transition: 'fade' as const, motion: 'still' as const }], captions: 'c.ass', output: 'out.mp4', audio: testAudio(2) };
    await runFfmpeg(ff, buildRenderArgs(plan), { cwd: dir });
    const info = await probe(ff, path.join(dir, 'out.mp4'));
    expect(info.video).toMatchObject({ width: 1080, height: 1920 });
    expect(Math.abs(info.durationSec - 5.6)).toBeLessThan(0.1);
    for (const stem of ['narration', 'music', 'music-dry', 'sfx']) expect(fs.existsSync(path.join(dir, 'stems', `${stem}.flac`))).toBe(true);
  }, 120_000);
});

describe('acceptance-video regressions', () => {
  it('rejects images that only match a framing word like "history", and treats a photo series as one image', async () => {
    const { seriesKey } = await import('../src/main/media/relevance');
    const sc = { visualQuery: 'GPU history', narration: 'GPUs have become essential for AI.' };
    expect(assetRelevance({ title: 'File:Guns on Deck, History is Made (6372966).jpg' }, sc, 'the history of GPUs in artificial intelligence').ok).toBe(false);
    expect(assetRelevance({ title: 'File:NVIDIA GeForce 256 GPU.jpg' }, sc, 'the history of GPUs in artificial intelligence', { context: ['NVIDIA'] }).ok).toBe(true);
    expect(seriesKey('File:Guns on Deck, History is Made (6372966).jpg')).toBe(seriesKey('File:Guns on Deck, History is Made (6372950).jpg'));
    expect(seriesKey('File:NVIDIA H100.jpg')).not.toBe(seriesKey('File:NVIDIA A100.jpg') + 'x');
  });
});

describe('acronym disambiguation', () => {
  const sc = { visualQuery: 'GPU history', narration: 'GPUs have become essential for AI.' };
  const topic = 'the history of GPUs in artificial intelligence';
  it('rejects an image that only shares an ambiguous acronym', () => {
    expect(assetRelevance({ title: 'File:Red Army GPU Novosibirsk Berlin - History Foundation Photography.jpg' }, sc, topic, { context: ['GPU', 'chip', 'NVIDIA', 'accelerator'] })).toMatchObject({ ok: false, reason: expect.stringMatching(/only the acronym/) });
  });
  it('accepts it when the business context confirms the meaning', () => {
    expect(assetRelevance({ title: 'File:NVIDIA GeForce 256 GPU.jpg' }, sc, topic, { context: ['GPU', 'chip', 'NVIDIA', 'accelerator'] }).ok).toBe(true);
    expect(assetRelevance({ title: 'File:NVIDIA GeForce 256 GPU.jpg' }, sc, topic).ok).toBe(false); // without context it can't be confirmed
  });
});
