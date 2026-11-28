import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assEscape, assTime, buildAss, buildCues } from '../src/main/media/captions';
import { buildRenderArgs, frameAlign } from '../src/main/media/render';
import { wavDurationSec, writeWav } from '../src/main/media/wav';
import { toWordTimings } from '../src/main/providers/narration';
import { buildBrief, searchTerms, cleanText, extractiveStoryboard, InsufficientResearchError, selectFacts, splitSentences, validateStoryboard } from '../src/main/providers/text';
import { isFreeLicense, isRelevantFile, pickCommonsCandidates } from '../src/main/providers/visuals';
import { parseLlmStoryboard } from '../src/main/providers/writers';
import * as v from '../src/main/validation';
import { DEFAULT_SETTINGS, type Source } from '../src/shared/production';
import { SOURCES } from './fixtures';
import { testAudio } from './helpers/audioPlan';



describe('text: research → facts → storyboard', () => {
  it('cleans citations and parentheticals and splits sentences', () => {
    expect(cleanText('A model (LLM) is big.[1] Really [citation needed].')).toBe('A model is big. Really.');
    expect(splitSentences('One fact here. Two facts there! 3 more?')).toEqual(['One fact here.', 'Two facts there!', '3 more?']);
  });

  it('builds search terms without stopwords', () => {
    expect(searchTerms('how transformers work in machine learning')).toBe('transformers machine learning');
  });

  it('only selects facts that appear verbatim in a cited source', () => {
    const facts = selectFacts('large language models', SOURCES);
    expect(facts.length).toBeGreaterThanOrEqual(2);
    for (const f of facts) {
      const src = SOURCES.find((s) => s.id === f.sourceId)!;
      expect(cleanText(src.excerpt)).toContain(f.text);
    }
    // Context-dependent sentences ("They can…", "These models…") are skipped rather than rewritten.
    expect(facts.some((f) => /^(They|These)\b/.test(f.text))).toBe(false);
  });

  it('fails honestly when sources have no usable facts', () => {
    const thin: Source[] = [{ ...SOURCES[0], excerpt: 'Short. Tiny.' }];
    expect(() => selectFacts('x', thin)).toThrow(InsufficientResearchError);
  });

  it('builds a valid hook → facts → outro storyboard citing sources', () => {
    const brief = buildBrief('large language models', SOURCES, 'AI and technology');
    const sb = validateStoryboard(extractiveStoryboard(brief, 'AI, Actually'), SOURCES);
    expect(sb.scenes[0].role).toBe('hook');
    expect(sb.scenes.at(-1)!.role).toBe('outro');
    expect(sb.scenes.at(-1)!.narration).toContain('AI, Actually');
    for (const s of sb.scenes.filter((x) => x.role === 'fact')) expect(s.sourceIds.length).toBe(1);
  });

  it('rejects storyboards with uncited or unknown-source facts', () => {
    const brief = buildBrief('large language models', SOURCES, 'AI');
    const sb = extractiveStoryboard(brief, 'C');
    sb.scenes[1].sourceIds = ['S9'];
    expect(() => validateStoryboard(sb, SOURCES)).toThrow(/citing a known source/);
  });
});

describe('local LLM writer output parsing', () => {
  const good = JSON.stringify({
    title: 'LLMs',
    scenes: [
      { role: 'hook', narration: 'Ever wondered how chatbots talk?', onScreenText: 'LLMs', visualQuery: 'chatbot', sourceIds: [] },
      { role: 'fact', narration: 'They are trained on huge amounts of text.', onScreenText: 'Text', visualQuery: 'books', sourceIds: ['S1'] },
      { role: 'fact', narration: 'Most are built on transformers.', onScreenText: 'Transformers', visualQuery: 'network', sourceIds: ['S2'] },
      { role: 'outro', narration: 'Sources below. Follow for more.', onScreenText: 'Follow', visualQuery: 'logo', sourceIds: [] }
    ]
  });
  it('accepts valid JSON, even wrapped in prose', () => {
    expect(parseLlmStoryboard(`Sure!\n${good}\nDone`, SOURCES, 'llm').scenes).toHaveLength(4);
  });
  it('rejects non-JSON, malformed JSON and invented sources', () => {
    expect(() => parseLlmStoryboard('no json here', SOURCES, 'llm')).toThrow(/did not return JSON/);
    expect(() => parseLlmStoryboard('{"title": ', SOURCES, 'llm')).toThrow(/did not return JSON|malformed/);
    expect(() => parseLlmStoryboard(good.replace('"S2"', '"S7"'), SOURCES, 'llm')).toThrow(/known source/);
  });
});

describe('narration timing + captions', () => {
  it('dedupes repeated SAPI events and derives word end times', () => {
    const w = toWordTimings(
      [
        { t: 'GPT-4', ms: 100, c: 0 },
        { t: 'GPT-4', ms: 900, c: 0 },
        { t: 'works', ms: 1500, c: 6 }
      ],
      2.5
    );
    expect(w.map((x) => x.text)).toEqual(['GPT-4', 'works']);
    expect(w[0]).toMatchObject({ start: 0.1, end: 1.3 });
    expect(w[1].end).toBeLessThanOrEqual(2.5);
  });

  it('groups words into short non-overlapping cues offset by scene', () => {
    const words = 'one two three four five.'.split(' ').map((t, i) => ({ text: t, start: i * 0.4, end: i * 0.4 + 0.35 }));
    const cues = buildCues([
      { offset: 0, duration: 2.5, words },
      { offset: 2.5, duration: 1, words: [{ text: 'six', start: 0.1, end: 0.5 }] }
    ]);
    expect(cues.map((c) => c.text)).toEqual(['one two three', 'four five.', 'six']);
    expect(cues[2].start).toBeCloseTo(2.6);
    for (let i = 1; i < cues.length; i++) expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].end);
  });

  it('formats ASS times and escapes override braces', () => {
    expect(assTime(3725.456)).toBe('1:02:05.46');
    expect(assEscape('a {\\b1} b')).toBe('a (\\\\b1) b');
    expect(buildAss([{ start: 0, end: 1, text: 'hi' }])).toMatch(/PlayResY: 1920[\s\S]*Dialogue: 0,0:00:00.00,0:00:01.00,Cap,.*HI/);
  });
});

describe('render plan', () => {
  it('frame-aligns durations and builds a 1080x1920 h264/aac command', () => {
    expect(frameAlign(1.01)).toBeCloseTo(30 / 30);
    const args = buildRenderArgs({
      scenes: [
        { image: 'images/a.jpg', audio: 'audio/a.wav', durationSec: 2 },
        { image: 'images/b.png', audio: 'audio/b.wav', durationSec: 1.5 }
      ],
      captions: 'captions.ass',
      output: 'out.mp4',
      audio: testAudio(2, { music: 'F:\\m.mp3' })
    });
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toContain('s=1080x1920');
    expect(fc).toContain("concat=n=2:v=1:a=0"); // video only; the soundtrack is assembled separately
    expect(fc).toContain('ass=captions.ass');
    expect(fc).toContain('amultiply'); // music multiplied by the precomputed ducking envelope
    expect(fc).toContain('volume=-4.00dB'); // measured gain, not a volume percentage
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-c:a', 'aac', '-stream_loop', '-1']));
    expect(args[args.indexOf('-t') + 1]).toBe('3.500');
  });
  it('refuses an empty plan', () => {
    expect(() => buildRenderArgs({ scenes: [], captions: 'c.ass', output: 'o.mp4', audio: testAudio(0) })).toThrow(/no scenes/);
  });
});

describe('wav', () => {
  it('reads duration from the RIFF header', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aimo-wav-')), 't.wav');
    writeWav(f, new Float32Array(22050 * 2), 22050);
    expect(wavDurationSec(f)).toBeCloseTo(2);
    fs.writeFileSync(f, 'nope');
    expect(() => wavDurationSec(f)).toThrow(/Not a WAV/);
  });
});

describe('Wikimedia Commons filtering', () => {
  const page = (title: string, license: string, extra: Partial<{ mime: string; width: number }> = {}) => ({
    title,
    index: 1,
    imageinfo: [
      {
        url: `https://upload.wikimedia.org/${title}`,
        thumburl: `https://upload.wikimedia.org/thumb/${title}`,
        width: extra.width ?? 2000,
        height: 1500,
        mime: extra.mime ?? 'image/jpeg',
        descriptionurl: `https://commons.wikimedia.org/wiki/${title}`,
        extmetadata: { LicenseShortName: { value: license }, Artist: { value: '<a href="x">Jane Doe</a>' } }
      }
    ]
  });
  it('only accepts files whose name matches the topic', () => {
    expect(isRelevantFile('File:Pros and cons of Large Language Modells, 2025.png', 'large language models')).toBe(true);
    expect(isRelevantFile('File:Dülmen, Mini Hatch Cooper -- 2018.jpg', 'large language models')).toBe(false);
    expect(isRelevantFile('File:Large Hadron Collider.jpg', 'large language models')).toBe(false);
    expect(isRelevantFile('File:ChatGPT logo.svg.png', 'ChatGPT')).toBe(true);
    // One title hit is enough when the description confirms a second topic word.
    expect(isRelevantFile('File:Transformer, full architecture.png', 'how transformers work in machine learning', 'Diagram of the machine learning model')).toBe(true);
    expect(isRelevantFile('File:Transformer, full architecture.png', 'how transformers work in machine learning', 'A power substation')).toBe(false);
    expect(isRelevantFile('File:Sea turtle.jpg', 'machine learning', 'machine learning dataset sample')).toBe(false);
  });
  it('accepts free licences only', () => {
    for (const l of ['CC BY-SA 4.0', 'CC BY 2.0', 'CC0', 'Public domain', 'PD-USGov']) expect(isFreeLicense(l)).toBe(true);
    for (const l of ['Fair use', 'All rights reserved', '']) expect(isFreeLicense(l)).toBe(false);
  });
  it('drops non-free, tiny, non-raster and already-used images and builds attribution', () => {
    const c = pickCommonsCandidates(
      [page('File:A.jpg', 'Fair use'), page('File:B.svg', 'CC0', { mime: 'image/svg+xml' }), page('File:C.jpg', 'CC0', { width: 100 }), page('File:D.jpg', 'CC0'), page('File:E.jpg', 'CC BY 4.0')],
      new Set(['File:D.jpg'])
    );
    expect(c.map((x) => x.key)).toEqual(['File:E.jpg']);
    expect(c[0].attribution).toBe('"E.jpg" by Jane Doe, CC BY 4.0, via Wikimedia Commons');
  });
});

describe('settings + production validation', () => {
  it('accepts defaults and rejects unknown providers / bad URLs / relative paths', () => {
    expect(v.settings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(() => v.settings({ ...DEFAULT_SETTINGS, writer: 'gpt-paid' })).toThrow(/writer/);
    expect(() => v.settings({ ...DEFAULT_SETTINGS, visuals: ['stock-paid'] })).toThrow(/visual/);
    expect(() => v.settings({ ...DEFAULT_SETTINGS, llmBaseUrl: 'file:///c:/x' })).toThrow(/URL/);
    expect(() => v.settings({ ...DEFAULT_SETTINGS, piperPath: 'piper.exe' })).toThrow(/absolute/);
    expect(() => v.settings({ ...DEFAULT_SETTINGS, speechRate: 50 })).toThrow(/between/);
  });
  it('validates new productions and step names', () => {
    expect(v.newProduction({ topic: '  AI agents ' })).toEqual({ topic: 'AI agents', contentId: undefined });
    expect(() => v.newProduction({ topic: '' })).toThrow(/required/);
    expect(v.stepName('render')).toBe('render');
    expect(() => v.stepName('publish')).toThrow(v.ValidationError);
  });
});
