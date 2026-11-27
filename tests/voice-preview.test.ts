import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/main/db/database';
import { ProductionRepository } from '../src/main/db/productions';
import { VoicePreviews, previewNarrator, previewStyle } from '../src/main/providers/voicePreview';
import { PreviewPlayer, type AudioLike } from '../src/renderer/src/previewPlayer';
import { DEFAULT_SETTINGS, VOICE_PREVIEW_TEXT, type PreviewEngine, type ProviderSettings, type VoicePreview } from '../src/shared/production';
import type { NarrationProvider } from '../src/main/providers/types';

const tmp = () => fs.mkdtempSync(path.join(process.env.AIMO_TEST_TMP ?? os.tmpdir(), 'vprev-'));

function fakeNarrator(voiceUsed: string, opts: { available?: boolean; fail?: boolean } = {}) {
  const texts: string[] = [];
  const n: NarrationProvider = {
    id: 'fake',
    kind: 'narration',
    label: 'Fake',
    costPerUnitUsd: 0,
    check: async () => ({ id: 'fake', kind: 'narration', label: 'Fake', available: opts.available !== false, detail: opts.available === false ? 'Voice "X" is not installed.' : 'ok', costPerUnitUsd: 0 }),
    synthesize: async (text, out) => {
      texts.push(text);
      if (opts.fail) throw new Error('engine crashed');
      fs.writeFileSync(out, 'RIFFfake');
      return { durationSec: 6.2, words: [], voice: voiceUsed };
    }
  } as NarrationProvider;
  return { n, texts };
}

describe('voice previews (main)', () => {
  it('generates a preview with exactly the requested engine and voice, using the fixed sample text', async () => {
    const dir = tmp();
    const made: [PreviewEngine, string][] = [];
    const { n, texts } = fakeNarrator('kokoro:am_michael');
    const p = new VoicePreviews(dir, (e, v) => (made.push([e, v]), n), () => previewStyle(DEFAULT_SETTINGS));
    const r = await p.preview('sherpa', 'am_michael');
    expect(made).toEqual([['sherpa', 'am_michael']]);
    expect(texts).toEqual([VOICE_PREVIEW_TEXT]);
    expect(r).toMatchObject({ engine: 'sherpa', voice: 'kokoro:am_michael', cached: false, durationSec: 6.2 });
    expect(r.url).toMatch(/^omnicore-media:\/\/sample\/preview-[0-9a-f]+\.wav$/);
    expect(fs.existsSync(path.join(dir, decodeURIComponent(r.url.split('/').pop()!)))).toBe(true);
  });

  it('caches previews per voice and style, and shares one synthesis between concurrent requests', async () => {
    const dir = tmp();
    const { n, texts } = fakeNarrator('kokoro:af_heart');
    let style = previewStyle(DEFAULT_SETTINGS);
    const p = new VoicePreviews(dir, () => n, () => style);
    const [a, b] = await Promise.all([p.preview('sherpa', 'af_heart'), p.preview('sherpa', 'af_heart')]);
    expect(texts.length).toBe(1);
    expect(a.url).toBe(b.url);
    const c = await p.preview('sherpa', 'af_heart');
    expect(c.cached).toBe(true);
    expect(texts.length).toBe(1);
    style = { ...style, speechRate: style.speechRate + 1 }; // a different rate sounds different: regenerate
    expect((await p.preview('sherpa', 'af_heart')).cached).toBe(false);
    expect(texts.length).toBe(2);
  });

  it('refuses unavailable voices and synthesis failures without substituting or caching', async () => {
    const dir = tmp();
    const missing = fakeNarrator('X', { available: false });
    await expect(new VoicePreviews(dir, () => missing.n, () => previewStyle(DEFAULT_SETTINGS)).preview('windows-sapi', 'X')).rejects.toThrow(/Voice unavailable: Voice "X" is not installed/);
    expect(missing.texts).toEqual([]);
    const broken = fakeNarrator('kokoro:af_bella', { fail: true });
    await expect(new VoicePreviews(dir, () => broken.n, () => previewStyle(DEFAULT_SETTINGS)).preview('sherpa', 'af_bella')).rejects.toThrow(/Couldn't synthesise the preview: engine crashed/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('rejects and discards audio when the engine used a different voice than requested', async () => {
    const dir = tmp();
    const sub = fakeNarrator('Microsoft David Desktop');
    const p = new VoicePreviews(dir, () => sub.n, () => previewStyle(DEFAULT_SETTINGS));
    await expect(p.preview('windows-sapi', 'Microsoft Zira Desktop')).rejects.toThrow(/used "Microsoft David Desktop" instead of "Microsoft Zira Desktop"/);
    expect(fs.readdirSync(dir)).toEqual([]);
    await expect(p.preview('windows-sapi', '')).rejects.toThrow(/specific voice/);
  });

  it('never alters saved voice settings; the preview narrator gets a copy with only the voice swapped', async () => {
    const dir = tmp();
    const db = openDatabase(path.join(dir, 'x.db'));
    const productions = new ProductionRepository(db);
    const before = productions.getSettings();
    expect(before.sherpaVoice).toBe('af_heart'); // Kokoro Heart stays the default presenter voice
    const seen: ProviderSettings[] = [];
    const make = vi.fn((s: ProviderSettings) => (seen.push(s), fakeNarrator(s.narration === 'sherpa' ? `kokoro:${s.sherpaVoice}` : s.voice).n));
    const p = new VoicePreviews(path.join(dir, 'samples'), previewNarrator(() => productions.getSettings(), { tmpDir: dir, toolsDir: dir }, make), () => previewStyle(productions.getSettings()));
    await p.preview('sherpa', 'bm_george');
    await p.preview('windows-sapi', 'Microsoft Zira Desktop');
    expect(seen[0]).toMatchObject({ narration: 'sherpa', sherpaVoice: 'bm_george' });
    expect(seen[1]).toMatchObject({ narration: 'windows-sapi', voice: 'Microsoft Zira Desktop' });
    expect(productions.getSettings()).toEqual(before);
    db.close();
  });
});

class FakeAudio implements AudioLike {
  static all: FakeAudio[] = [];
  paused = true;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string, private failPlay = false) {
    FakeAudio.all.push(this);
  }
  async play() {
    if (this.failPlay) throw new Error('NotAllowedError');
    this.paused = false;
  }
  pause() {
    this.paused = true;
  }
}

const vp = (voice: string): VoicePreview => ({ url: `omnicore-media://sample/${voice}.wav`, engine: 'sherpa', voice: `kokoro:${voice}`, durationSec: 5, cached: false });

describe('voice preview playback (renderer)', () => {
  it('shows loading then playing, returns to idle when playback ends, and stops on a second click', async () => {
    FakeAudio.all = [];
    let resolve!: (v: VoicePreview) => void;
    let first = true;
    const player = new PreviewPlayer((_e, v) => (first ? ((first = false), new Promise((r) => (resolve = r))) : Promise.resolve(vp(v))), (u) => new FakeAudio(u));
    const t = player.toggle('sherpa', 'af_heart');
    expect(player.state('sherpa', 'af_heart').status).toBe('loading');
    resolve(vp('af_heart'));
    await t;
    expect(player.state('sherpa', 'af_heart').status).toBe('playing');
    expect(FakeAudio.all[0].url).toBe('omnicore-media://sample/af_heart.wav');
    FakeAudio.all[0].onended!();
    expect(player.state('sherpa', 'af_heart').status).toBe('idle');
    await player.toggle('sherpa', 'af_heart');
    await player.toggle('sherpa', 'af_heart');
    expect(FakeAudio.all[1].paused).toBe(true);
    expect(player.state('sherpa', 'af_heart').status).toBe('idle');
  });

  it('plays one voice at a time', async () => {
    FakeAudio.all = [];
    const player = new PreviewPlayer(async (_e, v) => vp(v), (u) => new FakeAudio(u));
    await player.toggle('sherpa', 'af_heart');
    await player.toggle('sherpa', 'am_michael');
    expect(FakeAudio.all[0].paused).toBe(true);
    expect(player.state('sherpa', 'af_heart').status).toBe('idle');
    expect(player.state('sherpa', 'am_michael').status).toBe('playing');
  });

  it('shows synthesis and playback failures on that voice instead of playing anything else', async () => {
    FakeAudio.all = [];
    const player = new PreviewPlayer(async () => {
      throw new Error("Error invoking remote method 'providers:voicePreview': Error: Voice unavailable: Kokoro is not installed.");
    }, (u) => new FakeAudio(u));
    await player.toggle('sherpa', 'af_sky');
    expect(player.state('sherpa', 'af_sky')).toEqual({ status: 'error', message: 'Voice unavailable: Kokoro is not installed.' });
    expect(FakeAudio.all).toEqual([]);
    const blocked = new PreviewPlayer(async (_e, v) => vp(v), (u) => new FakeAudio(u, true));
    await blocked.toggle('sherpa', 'af_sky');
    expect(blocked.state('sherpa', 'af_sky').status).toBe('error');
  });
});
