import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/main/db/database';
import { ProductionRepository } from '../src/main/db/productions';
import { buildAss, buildCues } from '../src/main/media/captions';
import { evaluateLicense, restrictionProblem, verifyVisualAssets } from '../src/main/media/assetPolicy';
import { resolveFfmpeg } from '../src/main/media/ffmpeg';
import { readWavPcm, writeWav } from '../src/main/media/wav';
import { ProductionRunner } from '../src/main/pipeline/runner';
import { speechTokens, spellAcronym, spokenText } from '../src/main/providers/pronunciation';
import { kokoroLengthScale, SherpaKokoroNarration } from '../src/main/providers/sherpa';
import { respace, sentenceSegments, tokenTimings } from '../src/main/providers/speechTiming';
import { groundingProblems } from '../src/main/providers/text';
import { ProviderUnavailableError, type NarrationProvider, type VisualProvider } from '../src/main/providers/types';
import { pickCommonsCandidates, TitleCardVisuals } from '../src/main/providers/visuals';
import { claimProblems, claimStoryboard, ExtractiveWriter, maxWordsForVoice, parseLlmStoryboard } from '../src/main/providers/writers';
import { buildClaims, buildEvidenceBrief, classifyClaim, narrateClaim } from '../src/main/research/evidence';
import * as v from '../src/main/validation';
import { effectiveWordsPerSec } from '../src/main/providers/registry';
import { DEFAULT_SETTINGS, KOKORO_VOICES, type Claim, type ProductionAsset, type Source } from '../src/shared/production';

const src = (id: string, kind: Source['kind'], publisher: string, excerpt: string, extra: Partial<Source> = {}): Source => ({ id, title: `${publisher} on AI chips`, url: `https://${id.toLowerCase()}.example/a`, publisher, excerpt, retrievedAt: '', kind, group: `pub:${publisher.toLowerCase()}`, ...extra });

const COMPANY = src('S1', 'company', 'NVIDIA', 'NVIDIA announced the Rubin GPU platform for AI data centers on Monday. The company says Rubin delivers the fastest AI inference performance ever recorded. Rubin will ship to cloud providers in the second half of next year.');
const PRESS = src('S2', 'reporting', 'The Verge', 'NVIDIA unveiled its Rubin GPU platform for AI data centers this week at its annual conference. Analysts estimated the Rubin GPU platform could cost about $40,000 per chip. Some investors may see the launch as a response to rising competition.');
const PAPER = src('S3', 'research', 'arXiv', 'GPU memory bandwidth limits AI inference throughput for large language models. The authors measured inference throughput on several GPU platforms for AI workloads.');

describe('claim classification and evidence', () => {
  it('classifies company claims, estimates, speculation, reports and confirmed facts', () => {
    expect(classifyClaim('The company says Rubin delivers the fastest AI inference performance ever recorded.', COMPANY)).toBe('company-claim');
    expect(classifyClaim('Analysts estimated the chip could cost about $40,000.', PRESS)).toBe('speculation'); // "could" wins
    expect(classifyClaim('Analysts estimated the chip costs about $40,000 per unit.', PRESS)).toBe('estimate');
    expect(classifyClaim('NVIDIA unveiled its Rubin GPU platform this week.', PRESS)).toBe('reported');
    expect(classifyClaim('GPU memory bandwidth limits AI inference throughput.', src('S5', 'research', 'Nature', 'x', { url: 'https://www.nature.com/articles/x' }))).toBe('confirmed');
    expect(classifyClaim('GPU memory bandwidth limits AI inference throughput.', PAPER)).toBe('reported'); // arXiv preprint: not peer reviewed
    expect(classifyClaim('We believe this changes everything for the industry.', PRESS)).toBe('opinion');
    expect(classifyClaim('The fastest open model ever, outperforms everything.', src('S4', 'official', 'acme', 'x', { provider: 'github' }))).toBe('company-claim');
  });

  it('builds claims with supporting sources, attribution and independence counts', () => {
    const claims = buildClaims('NVIDIA Rubin GPU platform', [COMPANY, PRESS, PAPER], 'news');
    expect(claims.length).toBeGreaterThanOrEqual(3);
    for (const c of claims) {
      expect(c.id).toMatch(/^C\d+$/);
      expect(c.sourceIds.length).toBeGreaterThan(0);
      const first = [COMPANY, PRESS, PAPER].find((s) => s.id === c.sourceIds[0])!;
      expect(first.excerpt).toContain(c.text); // verbatim from its first source
    }
    const launch = claims.find((c) => /Rubin GPU platform for AI data centers/.test(c.text))!;
    expect(launch.sourceIds).toEqual(expect.arrayContaining(['S1', 'S2']));
    expect(launch.independentSources).toBe(2);
    expect(launch.kind).toBe('reported'); // company announcement independently reported by The Verge
    expect(claims.find((c) => /fastest/.test(c.text))?.kind).toBe('company-claim');
  });

  it('counts syndicated copies of a press release as one independent source', () => {
    const copy = { ...PRESS, id: 'S2', excerpt: COMPANY.excerpt, group: COMPANY.group, derivedFrom: 'S1' };
    const claims = buildClaims('NVIDIA Rubin GPU platform', [COMPANY, copy], 'news');
    const launch = claims.find((c) => /announced the Rubin/.test(c.text))!;
    expect(launch.independentSources).toBe(1);
    expect(launch.kind).toBe('company-claim'); // not upgraded by its own reprint
  });

  it('refuses to build a brief from inadequate evidence', () => {
    expect(() => buildEvidenceBrief('quantum gravity', [src('S1', 'reporting', 'X', 'Short. Tiny text.')], 'AI', 'explainer')).toThrow(/did not contain enough usable, on-topic statements/);
  });

  it('deterministic narration attributes anything that is not confirmed', () => {
    const c = (kind: Claim['kind'], text: string): Claim => ({ id: 'C1', text, sourceIds: ['S1'], kind, attribution: 'NVIDIA', independentSources: 1 });
    expect(narrateClaim(c('confirmed', 'GPU memory bandwidth limits throughput.'))).toBe('GPU memory bandwidth limits throughput.');
    expect(narrateClaim(c('company-claim', 'Rubin delivers record performance.'))).toBe('According to NVIDIA, Rubin delivers record performance.');
    expect(narrateClaim(c('company-claim', 'The company says Rubin is fast.'))).toBe('The company says Rubin is fast.');
    expect(narrateClaim(c('reported', 'The chip ships next year.'))).toBe('According to NVIDIA, the chip ships next year.');
  });
});

describe('script claim rules', () => {
  const brief = buildEvidenceBrief('NVIDIA Rubin GPU platform', [COMPANY, PRESS, PAPER], 'AI', 'news');
  const claims = brief.claims!;
  const companyClaim = claims.find((c) => c.kind === 'company-claim')!;

  it('the deterministic writer produces a valid, attributed, claim-cited storyboard', async () => {
    const { storyboard } = await new ExtractiveWriter().write({ brief, sources: [COMPANY, PRESS, PAPER], channelName: 'AI, Actually' });
    expect(claimProblems(storyboard, claims)).toEqual([]);
    expect(storyboard.scenes.filter((s) => s.role === 'fact').every((s) => s.claimIds?.length === 1)).toBe(true);
    expect(groundingProblems(storyboard, [COMPANY, PRESS, PAPER], { allowed: 'NVIDIA Rubin GPU platform AI, Actually' })).toEqual([]);
  });

  it('rejects a company claim stated as fact, and scenes without claim ids', () => {
    const sb = claimStoryboard(brief, 'AI, Actually');
    const scene = sb.scenes.find((s) => s.claimIds?.[0] === companyClaim.id)!;
    scene.narration = companyClaim.text.replace(/^The company says /, '');
    sb.scenes.filter((s) => s.role === 'fact' && s !== scene).at(-1)!.claimIds = [];
    const p = claimProblems(sb, claims).join(' ');
    expect(p).toMatch(new RegExp(`states ${companyClaim.id}, a company claim, as if it were confirmed; attribute it`));
    expect(p).toMatch(/does not say which evidence claim/);
  });

  it('LLM output: claim ids determine the cited sources', () => {
    const json = JSON.stringify({
      title: 'Rubin',
      scenes: [
        { role: 'hook', narration: 'What did NVIDIA just announce?', sourceIds: [] },
        { role: 'fact', narration: 'NVIDIA says it announced Rubin.', claimIds: [claims[0].id], sourceIds: ['S9'] },
        { role: 'fact', narration: 'Something else.', claimIds: [claims[1].id] },
        { role: 'outro', narration: 'Follow for more.', sourceIds: [] }
      ]
    });
    const sb = parseLlmStoryboard(json, [COMPANY, PRESS, PAPER], 'llm', claims);
    expect(sb.scenes[1].sourceIds).toEqual(claims[0].sourceIds);
  });

  it('sizes scripts to the narrator’s measured speed instead of speeding the voice up', () => {
    expect(maxWordsForVoice(0)).toBe(140);
    expect(maxWordsForVoice(2.14)).toBe(107);
    expect(maxWordsForVoice(3.4)).toBe(150);
    expect(maxWordsForVoice(1.5)).toBe(90);
    expect(effectiveWordsPerSec({ ...DEFAULT_SETTINGS, voiceWordsPerSec: 0 })).toBe(2.15); // Kokoro default from the evaluation
    expect(effectiveWordsPerSec({ ...DEFAULT_SETTINGS, voiceWordsPerSec: 2.6 })).toBe(2.6);
  });
});

describe('pronunciation', () => {
  it('spells acronyms, expands units and versions, keeps word-like caps', () => {
    const say = (t: string) => spokenText(speechTokens(t));
    expect(say('The GPU runs LLMs via an API.')).toBe("The G P U runs L L M's via an A-P-I.");
    expect(say('Can AI draft tokens? Jalapeño chips.')).toBe('Can AI draft tokens? Jalapenyo chips.');
    expect(say('NVIDIA H100 is 30x faster, costs $40K, uses 80% less power in v2.')).toBe('Envidia H 100 is 30 times faster, costs 40 thousand dollars, uses 80 percent less power in version 2.');
    expect(say('NASA uses RAM and RAG on arXiv, e.g. GPT-4o.')).toBe('NASA uses RAM and rag on archive, for example G P T four oh.');
    expect(say('Llama 3 has 70B parameters.')).toBe('Llama 3 has 70 billion parameters.');
    expect(spellAcronym('TPUs')).toBe("T P U's");
  });
  it('user overrides win and captions keep the original words', () => {
    const t = speechTokens('Omnicore uses Kokoro.', [{ term: 'Omnicore', say: 'omni core' }, { term: 'kokoro', say: 'koh koh roh' }]);
    expect(t.map((x) => x.orig)).toEqual(['Omnicore', 'uses', 'Kokoro.']);
    expect(spokenText(t)).toBe('omni core uses koh koh roh.');
  });
});

describe('sentence timing and pauses', () => {
  const sr = 24000;
  const tone = (sec: number) => Array.from({ length: Math.round(sec * sr) }, (_, i) => 0.4 * Math.sin(i / 3));
  const silence = (sec: number) => Array(Math.round(sec * sr)).fill(0);
  const mk = (file: string, parts: number[][]) => writeWav(file, Float32Array.from(parts.flat()), sr);
  let tmp: string;
  beforeEach(() => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aimo-tim-'))));
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('finds sentence boundaries from real pauses and re-spaces them exactly', () => {
    const f = path.join(tmp, 'a.wav');
    mk(f, [silence(0.1), tone(1.0), silence(0.15), tone(0.5), silence(0.05), tone(0.4), silence(0.2), tone(0.8), silence(0.1)]);
    const pcm = readWavPcm(f);
    // 3 sentences; the short 50 ms gap inside sentence 2 must not be taken as a boundary.
    const segs = sentenceSegments(pcm, [10, 9, 8]);
    expect(segs).toHaveLength(3);
    expect(segs[0].end).toBeCloseTo(1.1, 1);
    expect(segs[1].start).toBeCloseTo(1.25, 1);
    expect(segs[2].start).toBeCloseTo(2.35, 1);
    const out = path.join(tmp, 'b.wav');
    const r = respace(pcm, segs, 0.4, out);
    expect(r.segments[1].start - r.segments[0].end).toBeCloseTo(0.4, 2);
    expect(r.segments[2].start - r.segments[1].end).toBeCloseTo(0.4, 2);
  });

  it('falls back to text-length proportions when the audio has no usable pauses', () => {
    const f = path.join(tmp, 'c.wav');
    mk(f, [tone(3)]);
    const segs = sentenceSegments(readWavPcm(f), [1, 2]);
    expect(segs[0].end - segs[0].start).toBeCloseTo(1, 1);
    expect(segs[1].end - segs[1].start).toBeCloseTo(2, 1);
  });

  it('word timings use spoken length but caption the original words, without overlaps', () => {
    const sentences = [speechTokens('The GPU is fast.'), speechTokens('Very fast.')];
    const w = tokenTimings(sentences, [{ start: 0.1, end: 1.5 }, { start: 1.9, end: 2.6 }]);
    expect(w.map((x) => x.text)).toEqual(['The', 'GPU', 'is', 'fast.', 'Very', 'fast.']);
    expect(w[1].end - w[1].start).toBeGreaterThan(w[0].end - w[0].start); // "G P U" takes longer than "The"
    for (let i = 1; i < w.length; i++) expect(w[i].start).toBeGreaterThanOrEqual(w[i - 1].end);
    const cues = buildCues([{ offset: 0, duration: 2.8, words: w }]);
    expect(cues.map((c) => c.text)).toEqual(['The GPU is', 'fast.', 'Very fast.']);
  });
});

describe('Kokoro narration provider', () => {
  it('explains a missing install and keeps speed within a natural range', async () => {
    const k = new SherpaKokoroNarration(path.join(os.tmpdir(), 'no-tools-here'), 'am_michael', os.tmpdir());
    expect((await k.check()).detail).toMatch(/Kokoro is not installed.*Install it in Studio/);
    await expect(k.synthesize('Hello.', path.join(os.tmpdir(), 'x.wav'), new AbortController().signal)).rejects.toThrow(ProviderUnavailableError);
    expect(kokoroLengthScale(0)).toBe(1);
    expect(kokoroLengthScale(10)).toBe(0.87); // never faster than ~1.15x
    expect(kokoroLengthScale(-10)).toBe(1.15);
  });
});

describe('visual asset policy', () => {
  it('accepts only licences that allow commercial use and modification', () => {
    expect(evaluateLicense('CC0', { allowShareAlike: false }).ok).toBe(true);
    expect(evaluateLicense('Public domain', { allowShareAlike: false })).toMatchObject({ ok: true, attributionRequired: false });
    expect(evaluateLicense('CC BY 4.0', { allowShareAlike: false })).toMatchObject({ ok: true, attributionRequired: true, shareAlike: false });
    expect(evaluateLicense('CC BY-SA 4.0', { allowShareAlike: false }).ok).toBe(false);
    expect(evaluateLicense('CC BY-SA 4.0', { allowShareAlike: true })).toMatchObject({ ok: true, shareAlike: true });
    expect(evaluateLicense('CC BY-NC 4.0', { allowShareAlike: true }).reason).toMatch(/forbids commercial use/);
    expect(evaluateLicense('CC BY-ND 2.0', { allowShareAlike: true }).reason).toMatch(/forbids modification/);
    expect(evaluateLicense('GFDL', { allowShareAlike: true }).ok).toBe(false);
    expect(evaluateLicense('Fair use', { allowShareAlike: true }).ok).toBe(false);
    expect(evaluateLicense('', { allowShareAlike: true }).ok).toBe(false);
  });

  it('rejects trademarked, personality-rights and watermarked files', () => {
    expect(restrictionProblem('trademarked', '')).toMatch(/trademark/);
    expect(restrictionProblem('personality', '')).toMatch(/personality/);
    expect(restrictionProblem('', 'Images with watermarks')).toMatch(/watermark/);
    expect(restrictionProblem('', 'Diagrams of transformers')).toBeNull();
    // Real files seen in a live run: CC-licensed on Commons, but branded / proprietary UI.
    expect(restrictionProblem('', '', 'File:OpenAI logo with magnifying glass (52916339167).jpg')).toMatch(/logo/);
    expect(restrictionProblem('', '', 'File:Screenshot of OpenAI Codex.png')).toMatch(/screenshot/);
    expect(restrictionProblem('', '', 'File:OpenAI Codex extention for VScode.png')).toMatch(/screenshot/);
    expect(restrictionProblem('', '', 'File:Visit of OpenAI representatives to the European Commission - P061880-380830.jpg')).toBeNull();
  });

  it('Commons candidates carry a full licence record; share-alike excluded by default', () => {
    const page = (title: string, license: string, extra: Record<string, string> = {}) => ({
      title, index: 1,
      imageinfo: [{ url: 'u', thumburl: 't', width: 1200, height: 900, mime: 'image/png', descriptionurl: `https://commons.wikimedia.org/wiki/${title}`, extmetadata: Object.fromEntries(Object.entries({ LicenseShortName: license, Artist: 'Jane Doe', LicenseUrl: 'https://creativecommons.org/licenses/by/4.0', ...extra }).map(([k, val]) => [k, { value: val }])) }]
    });
    const c = pickCommonsCandidates([page('File:A.png', 'CC BY-SA 4.0'), page('File:B.png', 'CC BY 4.0'), page('File:C.png', 'CC0', { Restrictions: 'trademarked' })], new Set());
    expect(c.map((x) => x.key)).toEqual(['File:B.png']);
    expect(c[0].licenseRecord).toMatchObject({ origin: 'commons', creator: 'Jane Doe', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0', commercialUse: true, modification: true, attributionRequired: true, verified: true });
    expect(c[0].licenseRecord.retrievedAt).toMatch(/^\d{4}-/);
  });

  it('QA gate blocks unverified or prohibited images and unlabelled AI images', () => {
    const img = (provider: string, meta: Record<string, unknown>): ProductionAsset => ({ id: 1, kind: 'image', sceneIndex: 0, path: 'x', provider, sourceUrl: '', license: '', attribution: '', meta });
    const good = { licenseRecord: { origin: 'commons', sourceUrl: 'https://c/x', creator: 'J', license: 'CC BY 4.0', licenseUrl: '', attributionRequired: true, commercialUse: true, modification: true, shareAlike: false, retrievedAt: '', verified: true } };
    expect(verifyVisualAssets([img('title-card', {}), img('wikimedia-commons', good), img('comfyui', { aiGenerated: true })], { allowShareAlike: false })).toEqual([]);
    const p = verifyVisualAssets(
      [img('wikimedia-commons', {}), img('wikimedia-commons', { licenseRecord: { ...good.licenseRecord, license: 'CC BY-NC 2.0' } }), img('comfyui', {})],
      { allowShareAlike: false }
    ).join(' ');
    expect(p).toMatch(/no licence record/);
    expect(p).toMatch(/forbids commercial use/);
    expect(p).toMatch(/not marked as AI-generated/);
  });

  it('AI illustrations get an on-screen label in the captions file', () => {
    const ass = buildAss([{ start: 0, end: 1, text: 'hi' }], [{ start: 0, end: 3, text: 'AI-generated illustration' }]);
    expect(ass).toMatch(/Style: Lbl/);
    expect(ass).toMatch(/Dialogue: 1,0:00:00\.00,0:00:03\.00,Lbl,,0,0,0,,AI-generated illustration/);
  });
});

describe('validation of 0.4 settings', () => {
  it('accepts defaults and rejects bad research/voice/pronunciation settings', () => {
    expect(v.settings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(() => v.settings({ ...DEFAULT_SETTINGS, researchProviders: ['google-search-paid'] })).toThrow(/research provider/);
    expect(() => v.settings({ ...DEFAULT_SETTINGS, sherpaVoice: 'af_unknown' })).toThrow(/Kokoro voice/);
    expect(() => v.settings({ ...DEFAULT_SETTINGS, sentencePauseSec: 3 })).toThrow(/Sentence pause/);
    expect(() => v.settings({ ...DEFAULT_SETTINGS, pronunciations: [{ term: '', say: 'x' }] })).toThrow(/term/);
    expect(v.settings({ ...DEFAULT_SETTINGS, researchProviders: ['arxiv'] }).wikipediaResearch).toBe(false);
    expect(v.newProduction({ topic: 'x', mode: 'news' })).toMatchObject({ mode: 'news' });
    expect(() => v.newProduction({ topic: 'x', mode: 'rumours' })).toThrow(/Mode/);
  });
});

describe('production integration', () => {
  const ffmpeg = resolveFfmpeg('');
  let db: DatabaseSync;
  let repo: ProductionRepository;
  let dir: string;
  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new ProductionRepository(db);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimo-int-'));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const voice = (id: string, fail?: Error): NarrationProvider => ({
    id, label: id, costPerUnitUsd: 0,
    check: async () => ({ id, kind: 'narration', label: id, available: !fail, detail: '', costPerUnitUsd: 0 }),
    synthesize: async (text, out) => {
      if (fail) throw fail;
      writeWav(out, new Float32Array(22050).map((_, i) => 0.2 * Math.sin(i / 4)), 22050);
      return { durationSec: 1, voice: id, words: text.split(' ').slice(0, 3).map((t, i) => ({ text: t, start: i * 0.3, end: i * 0.3 + 0.25 })) };
    }
  });
  const runner = (o: { narration: NarrationProvider; fallback?: NarrationProvider; visuals?: VisualProvider[]; render?: boolean }) =>
    new ProductionRunner({
      repo,
      productionsDir: dir,
      settings: () => ({ ...DEFAULT_SETTINGS, writer: 'extractive', visuals: ['title-card'] }),
      providers: () => ({
        research: [{ id: 'newsrooms', label: 'Fake newsroom', category: 'news', healthUrl: 'x', search: async () => [COMPANY, PRESS, PAPER].map(({ id: _id, ...s }) => ({ ...s, contentLevel: 'full' as const, publishedAt: new Date().toISOString() })) }],
        writer: new ExtractiveWriter(),
        narration: o.narration,
        fallbackNarration: o.fallback,
        visuals: o.visuals ?? [new TitleCardVisuals(() => ffmpeg)]
      }),
      ffmpeg: () => ffmpeg,
      channel: () => ({ name: 'AI, Actually', niche: 'AI' }),
      emit: () => {},
      ...(o.render === false ? { render: async () => { throw new Error('render skipped'); } } : {})
    });

  it('news-mode production: claims + attribution flow into the storyboard and credits', async () => {
    const r = runner({ narration: voice('kokoro') });
    const p = repo.create(1, 'NVIDIA Rubin GPU platform', null, '', 'news');
    r.enqueue(p.id);
    await r.idle();
    const done = repo.get(p.id);
    expect(done.error).toBeNull();
    expect(done.mode).toBe('news');
    expect(done.brief!.claims!.length).toBeGreaterThanOrEqual(3);
    expect(done.storyboard!.scenes.some((s) => /^According to NVIDIA,|says/.test(s.narration))).toBe(true);
    const credits = fs.readFileSync(path.join(r.dirFor(p.id), 'credits.txt'), 'utf8');
    expect(credits).toMatch(/Company announcement/);
    expect(credits).toMatch(/Claims used:/);
    expect(credits).toMatch(/\[C1\]/);
  }, 120_000);

  it('falls back to the backup narrator for the whole step when the chosen one is not installed', async () => {
    const r = runner({ narration: voice('kokoro', new ProviderUnavailableError('Kokoro is not installed.')), fallback: voice('sapi'), render: false });
    const p = repo.create(1, 'NVIDIA Rubin GPU platform', null, '', 'news');
    r.enqueue(p.id);
    await r.idle();
    const pr = repo.get(p.id);
    expect(pr.assets.filter((a) => a.kind === 'narration').every((a) => a.meta.voice === 'sapi')).toBe(true);
    expect(pr.steps.find((s) => s.step === 'narration')!.detail).toMatch(/kokoro unavailable \(Kokoro is not installed\.\), used sapi/);
  }, 60_000);

  it('does not fall back on ordinary synthesis errors (no silent voice switching)', async () => {
    const r = runner({ narration: voice('kokoro', new Error('model crashed')), fallback: voice('sapi'), render: false });
    const p = repo.create(1, 'NVIDIA Rubin GPU platform', null, '', 'news');
    r.enqueue(p.id);
    await r.idle();
    expect(repo.get(p.id).error).toBe('Narration: model crashed');
  }, 60_000);

  it('blocks rendering when a visual has no verified licence', async () => {
    const unverified: VisualProvider = {
      id: 'wikimedia-commons', label: 'Commons', costPerUnitUsd: 0,
      check: async () => ({ id: 'x', kind: 'visuals', label: 'x', available: true, detail: '', costPerUnitUsd: 0 }),
      fetch: async (req, s) => ({ ...(await new TitleCardVisuals(() => ffmpeg).fetch(req, s)), key: `k${req.scene.index}`, license: 'CC BY 4.0', meta: {} })
    };
    const r = runner({ narration: voice('kokoro'), visuals: [unverified] });
    const p = repo.create(1, 'NVIDIA Rubin GPU platform', null, '', 'news');
    r.enqueue(p.id);
    await r.idle();
    expect(repo.get(p.id).error).toMatch(/^Render: Visual licence check failed, so this video cannot be rendered: Scene 1: wikimedia-commons image has no licence record/);
  }, 120_000);
});

describe('fresh-install defaults and 0.3 → 0.4 settings migration', () => {
  it('fresh install: Kokoro with the presenter voice Heart, Windows speech as fallback, all free research on', async () => {
    const db = openDatabase(':memory:');
    const s = new ProductionRepository(db).getSettings();
    expect(s).toMatchObject({ narration: 'sherpa', sherpaVoice: 'af_heart', writer: 'openai-compatible', allowShareAlike: false, wikipediaResearch: true });
    expect(s.researchProviders).not.toContain('sec-edgar');
    const { buildProviders } = await import('../src/main/providers/registry');
    const p = buildProviders(s, { tmpDir: os.tmpdir(), toolsDir: path.join(os.tmpdir(), 'no-tools') });
    expect(p.narration.id).toBe('sherpa');
    expect(p.fallbackNarration?.id).toBe('windows-sapi');
    db.close();
  });

  it('saved 0.3 settings keep the user’s choices; new fields get 0.4 defaults', () => {
    const db = openDatabase(':memory:');
    const legacy = { wikipediaResearch: false, writer: 'openai-compatible', narration: 'piper', piperVoice: 'F:\\voices\\en_US-john-medium.onnx', musicMode: 'auto', sfxTransitions: true };
    db.prepare(`INSERT INTO settings (key, value) VALUES ('providers', ?)`).run(JSON.stringify(legacy));
    const s = new ProductionRepository(db).getSettings();
    expect(s.narration).toBe('piper'); // the user's explicit 0.3 choice is not overridden
    expect(s.sherpaVoice).toBe('af_heart'); // used as soon as they pick Kokoro
    expect(s.researchProviders).not.toContain('wikipedia'); // 0.3 "Wikipedia off" carried over
    expect(s.researchProviders.length).toBeGreaterThan(5);
    expect(s).toMatchObject({ musicMode: 'auto', sfxTransitions: true, sentencePauseSec: 0.32, allowShareAlike: false });
    expect(v.settings(s)).toEqual(s); // migrated settings pass validation, so saving them works
    db.close();
  });

  it('a saved Kokoro voice choice (e.g. Bella or Emma) survives upgrades and default changes', () => {
    for (const voice of ['af_bella', 'bf_emma'] as const) {
      const db = openDatabase(':memory:');
      const repo = new ProductionRepository(db);
      repo.saveSettings({ ...repo.getSettings(), narration: 'sherpa', sherpaVoice: voice });
      expect(new ProductionRepository(db).getSettings().sherpaVoice).toBe(voice);
      db.close();
    }
  });

  it('Bella and Emma remain selectable; Heart is labelled as the presenter default', () => {
    const ids = KOKORO_VOICES.map((k) => k.id);
    expect(ids).toEqual(expect.arrayContaining(['af_heart', 'af_bella', 'bf_emma']));
    expect(KOKORO_VOICES.find((k) => k.id === 'af_heart')!.label).toMatch(/default/);
    expect(v.settings({ ...DEFAULT_SETTINGS, sherpaVoice: 'bf_emma' }).sherpaVoice).toBe('bf_emma');
  });
});

describe('typographic punctuation in narration', () => {
  it('sends plain apostrophes to the voice engine', async () => {
    const { speechTokens, spokenText } = await import('../src/main/providers/pronunciation');
    expect(spokenText(speechTokens('Nvidia’s CEO hasn’t said “yes”.'))).not.toMatch(/[’‘“”]/);
  });
});
