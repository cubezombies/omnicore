import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/main/db/database';
import { BusinessRepository } from '../src/main/business/businesses';
import { PronunciationRepository, checkPronunciations } from '../src/main/pronunciation/dictionary';
import { timingsForTokens } from '../src/main/providers/narration';
import { speechTokens, spokenText } from '../src/main/providers/pronunciation';
import { pronunciationDraft } from '../src/main/validation';

function setup() {
  const db = openDatabase(':memory:');
  const biz = new BusinessRepository(db);
  const A = biz.list()[0].id;
  const B = biz.create({ name: 'Other Co', businessType: 'media' }).id;
  return { db, dict: new PronunciationRepository(db), A, B };
}

describe('pronunciation dictionary', () => {
  it('lets a business entry override a shared one, and engine overrides override both', () => {
    const { dict, A, B } = setup();
    dict.save(A, { term: 'Qwen', say: 'chwen', scope: 'global' });
    dict.save(A, { term: 'qwen', say: 'kwen', scope: 'business', engineSay: { piper: 'k wen' } });
    expect(dict.resolved(A, 'sherpa')).toContainEqual({ term: 'qwen', say: 'kwen' });
    expect(dict.resolved(A, 'piper')).toContainEqual({ term: 'qwen', say: 'k wen' });
    expect(dict.resolved(B, 'sherpa')).toEqual([{ term: 'Qwen', say: 'chwen' }]); // B sees only the shared entry
  });

  it('keeps business entries private and replaces an entry for the same term instead of duplicating it', () => {
    const { dict, A, B } = setup();
    const e = dict.save(A, { term: 'Omnicore', say: 'omni core', scope: 'business' });
    expect(dict.list(B)).toEqual([]);
    expect(() => dict.get(B, e.id)).toThrow(/not found/);
    expect(() => dict.delete(B, e.id)).toThrow(/not found/);
    dict.save(A, { term: 'OMNICORE', say: 'om ni core', scope: 'business' });
    expect(dict.list(A)).toHaveLength(1);
    expect(dict.list(A)[0].say).toBe('om ni core');
  });

  it('validates entries: one written word, a respelling, a known engine and a scope', () => {
    expect(() => pronunciationDraft({ term: 'two words', say: 'x', scope: 'business' })).toThrow(/one word/);
    expect(() => pronunciationDraft({ term: 'CUDA', say: '', scope: 'business' })).toThrow(/how the term should be said/);
    expect(() => pronunciationDraft({ term: 'CUDA', say: 'cooda', scope: 'business', engineSay: { espeak: 'x' } })).toThrow(/Unknown engine/);
    expect(() => pronunciationDraft({ term: 'CUDA', say: 'cooda' })).toThrow(/every business/);
    expect(pronunciationDraft({ term: 'CUDA', say: 'cooda', scope: 'global', engineSay: { sherpa: ' koo da ', piper: '' } })).toMatchObject({ engineSay: { sherpa: 'koo da' } });
  });
});

describe('pronunciation detection', () => {
  const english = new Set(['the', 'model', 'runs', 'on', 'today', 'we', 'look', 'at', 'says', 'new', 'and', 'cluster', 'a', 'it']);
  const sb = { scenes: [{ index: 0, narration: 'Today we look at Zenodo and the H100.' }, { index: 1, narration: 'Qwen runs on a Kubernetes cluster. NVIDIA says it is new.' }] } as never;

  it('flags names nobody has confirmed, and explains how known terms will be said', () => {
    const { dict, A } = setup();
    dict.save(A, { term: 'Kubernetes', say: 'koo ber net eez', scope: 'business' });
    const f = checkPronunciations(sb, dict.list(A), english);
    const by = Object.fromEntries(f.map((x) => [x.term, x]));
    expect(by.Zenodo).toMatchObject({ status: 'uncertain', scenes: [0] });
    expect(by.Kubernetes).toMatchObject({ status: 'dictionary', spoken: 'koo ber net eez', scenes: [1] });
    expect(by.NVIDIA).toMatchObject({ status: 'builtin', spoken: 'Envidia' });
    expect(by.Qwen).toMatchObject({ status: 'builtin' });
    expect(by.H100).toMatchObject({ status: 'rule', spoken: 'H 100' });
    expect(by.Today).toBeUndefined(); // ordinary English at the start of a sentence
    expect(f[0].status).toBe('uncertain'); // terms to check come first
  });
});

describe('captions keep the written spelling', () => {
  it('maps Windows voice timings on respelled text back to the original words', () => {
    const tokens = speechTokens('NVIDIA ships CUDA 13.', [{ term: 'ships', say: 'shipps' }]);
    expect(spokenText(tokens)).toBe('Envidia shipps cooda 13.');
    // SAPI reports character offsets in the text it actually spoke.
    const raw = [
      { t: 'Envidia', ms: 0, c: 0 },
      { t: 'shipps', ms: 600, c: 8 },
      { t: 'cooda', ms: 1100, c: 15 },
      { t: '13', ms: 1600, c: 21 }
    ];
    const w = timingsForTokens(tokens, raw, 2.2);
    expect(w.map((x) => x.text)).toEqual(['NVIDIA', 'ships', 'CUDA', '13.']);
    expect(w.map((x) => x.start)).toEqual([0, 0.6, 1.1, 1.6]);
  });

  it('interpolates words the engine reported no event for', () => {
    const tokens = speechTokens('one two three', []);
    const w = timingsForTokens(tokens, [{ t: 'one', ms: 0, c: 0 }, { t: 'three', ms: 1000, c: 8 }], 1.5);
    expect(w.map((x) => x.text)).toEqual(['one', 'two', 'three']);
    expect(w[1].start).toBeCloseTo(0.5, 5);
  });
});

describe('pronunciation detection regressions', () => {
  it('does not flag inflected or hyphenated forms of ordinary words', () => {
    const english = new Set(['accelerate', 'general', 'purpose', 'compute', 'they', 'calculations', 'used', 'to', 'were']);
    const f = checkPronunciations({ scenes: [{ index: 0, narration: 'they were used to accelerated calculations, computing general-purpose work' }] } as never, [], english);
    expect(f.map((x) => x.term)).not.toEqual(expect.arrayContaining(['accelerated', 'computing', 'general-purpose']));
  });
});

describe('engine-specific spoken forms (each verified with Whisper on the real engine)', () => {
  const say = (t: string, o: Parameters<typeof speechTokens>[2] = {}) => spokenText(speechTokens(t, [], o));

  it('keeps acronym plurals audible on every engine', () => {
    expect(say('GPUs and CPUs, an API and AMD.', { acronyms: 'dotted' })).toBe('G.P.yooz and C.P.yooz, an A.P.I and A.M.D.');
    expect(say('GPUs and CPUs, an API and AMD.')).toBe("G P U's and C P U's, an A-P-I and A-M-D.");
    expect(say('GPUs and CPUs, an RTX 5070 and AMD.', { acronyms: 'native' })).toBe('GPUs and CPUs, an RTX 5070 and AMD.');
  });

  it('says product model numbers in pairs, dates as ordinals, titles in full', () => {
    expect(say('An RTX 5070 beats a GTX 1080.')).toBe('An R T X 50 70 beats a G T X 10 80.');
    expect(say('On March 3, 2026, Dr. Chen spoke.')).toBe('On March 3rd, 2026, Doctor Chen spoke.');
    expect(say('Since 2026 and 2005, not 1999.', { years: true })).toBe('Since twenty twenty-six and two thousand five, not nineteen ninety-nine.');
  });

  it('uses respellings for the benchmark terms the engines got wrong', () => {
    expect(say('Omnicore needs VRAM and CUDA.', { acronyms: 'dotted' })).toBe('omni core needs vee-ram and cooda.');
    expect(say('ChatGPT', { acronyms: 'dotted' })).toBe('Chat G.P.T');
  });
});

describe('sentence splitting', () => {
  it('does not break sentences after titles, abbreviations or initials', async () => {
    const { splitForSpeech } = await import('../src/main/providers/piper');
    expect(splitForSpeech('Dr. Chen met J. Smith, e.g. at lunch. Then AMD. Then more!')).toEqual(['Dr. Chen met J. Smith, e.g. at lunch.', 'Then AMD.', 'Then more!']);
  });
});

describe('Kokoro (GPU) helpers', () => {
  it('maps model word timings back onto the script words and converts IPA', async () => {
    const { alignWords, ipaToKokoro } = await import('../src/main/providers/kokoroGpu');
    const toks = speechTokens('NVIDIA ships general-purpose GPUs.', [], { acronyms: 'native' });
    const model = [
      { text: 'NVIDIA', start: 0.1, end: 0.6 },
      { text: 'ships', start: 0.6, end: 0.9 },
      { text: 'general', start: 0.9, end: 1.3 },
      { text: '-', start: 1.3, end: 1.3 },
      { text: 'purpose', start: 1.3, end: 1.7 },
      { text: 'GPUs', start: 1.7, end: 2.3 },
      { text: '.', start: 2.3, end: 2.4 }
    ];
    const w = alignWords(toks, model, 2.5);
    expect(w.map((x) => [x.text, x.start, x.end])).toEqual([['NVIDIA', 0.1, 0.6], ['ships', 0.6, 0.9], ['general-purpose', 0.9, 1.7], ['GPUs.', 1.7, 2.3]]);
    expect(ipaToKokoro('/ˈɑːmnikɔːr/')).toBe('ˈɑmnikɔɹ');
    expect(ipaToKokoro('dʒiːpiːˈjuː')).toBe('ʤipiˈju');
    expect(ipaToKokoro('ˈoʊmni')).toBe('ˈOmni');
  });
});

describe('pause shaping and Kokoro settings', () => {
  it('shortens only over-long silences, by punctuation, and shifts word timings', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { writeWav, readWavPcm } = await import('../src/main/media/wav');
    const { shapePauses } = await import('../src/main/providers/speechTiming');
    const sr = 24000;
    const tone = (sec: number) => Array.from({ length: Math.round(sec * sr) }, (_, i) => 0.4 * Math.sin((2 * Math.PI * 180 * i) / sr));
    const gap = (sec: number) => new Array(Math.round(sec * sr)).fill(0);
    // word | 0.8 s after a comma | word | 0.5 s with no punctuation | word | 0.3 s after a full stop | word
    const samples = Float32Array.from([...tone(0.5), ...gap(0.8), ...tone(0.5), ...gap(0.5), ...tone(0.5), ...gap(0.3), ...tone(0.5)]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shape-'));
    const f = path.join(dir, 'in.wav');
    writeWav(f, samples, sr);
    const words = [
      { text: 'one,', start: 0, end: 0.5 },
      { text: 'two', start: 1.3, end: 1.8 },
      { text: 'three.', start: 2.3, end: 2.8 },
      { text: 'four', start: 3.1, end: 3.6 }
    ];
    const r = shapePauses(readWavPcm(f), words, { sentence: 0.4, clause: 0.22, word: 0.09 }, path.join(dir, 'out.wav'));
    expect(r.removedSec).toBeCloseTo(0.58 + 0.41, 1); // comma pause → 0.22 s, word gap → 0.09 s, sentence pause kept
    expect(r.words[1].start).toBeCloseTo(0.72, 1);
    expect(r.words[3].start - r.words[2].end).toBeCloseTo(0.3, 1);
    expect(r.durationSec).toBeCloseTo(3.6 - r.removedSec, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses American English for US Kokoro voices and the model pause scale for the pause setting', async () => {
    const { kokoroLang, kokoroSilenceScale } = await import('../src/main/providers/sherpa');
    expect(kokoroLang('af_heart')).toBe('en-us');
    expect(kokoroLang('am_michael')).toBe('en-us');
    expect(kokoroLang('bf_lily')).toBe('en-gb');
    expect(kokoroSilenceScale(0.32)).toBeCloseTo(0.4, 5);
  });
});

describe('re-voice validation', () => {
  it('accepts the first scene (index 0) and rejects bad indexes', async () => {
    const { sceneList } = await import('../src/main/validation');
    expect(sceneList([0, 3])).toEqual([0, 3]);
    expect(() => sceneList([-1])).toThrow(/non-negative/);
    expect(() => sceneList(['1'])).toThrow(/non-negative/);
  });
});
