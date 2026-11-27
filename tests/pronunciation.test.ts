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
