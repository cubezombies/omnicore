import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { VOICE_PREVIEW_TEXT, sampleUrl, type KokoroVoiceId, type PreviewEngine, type Pronunciation, type ProviderSettings, type VoicePreview } from '../../shared/production';
import { narrator, type ProviderDirs } from './registry';
import type { NarrationProvider } from './types';

/** Settings that change how a voice sounds, so they are part of the cache key. */
export interface PreviewStyle {
  speechRate: number;
  pauseSec: number;
  pronunciations: unknown;
  kokoroBackend?: string;
}

/** Builds the narrator for a preview from a copy of the settings with only the engine and voice swapped; nothing is saved. */
export const previewNarrator =
  (getSettings: () => ProviderSettings, dirs: ProviderDirs, make: typeof narrator = narrator) =>
  (engine: PreviewEngine, voice: string, pronunciations?: Pronunciation[], kokoroBackend?: ProviderSettings['kokoroBackend']): NarrationProvider => {
    const s = { ...getSettings(), ...(pronunciations ? { pronunciations } : {}), ...(kokoroBackend ? { kokoroBackend } : {}) };
    const copy: ProviderSettings =
      engine === 'sherpa' ? { ...s, narration: 'sherpa', sherpaVoice: voice as KokoroVoiceId } : engine === 'piper' ? { ...s, narration: 'piper', piperVoice: voice } : { ...s, narration: 'windows-sapi', voice };
    return make(copy, dirs);
  };

export const previewStyle = (s: ProviderSettings): PreviewStyle => ({ speechRate: s.speechRate, pauseSec: s.sentencePauseSec, pronunciations: s.pronunciations, kokoroBackend: s.kokoroBackend });

const PREFIX = 'preview-';
/** Keep at most this many cached previews (one per voice/style); older ones are removed. */
export const PREVIEW_CACHE_LIMIT = 48;

/** The voice name each engine reports back for a requested voice; a mismatch means the engine substituted another voice. */
export function expectedVoice(engine: PreviewEngine, voice: string): string {
  if (engine === 'sherpa') return `kokoro:${voice}`;
  if (engine === 'piper') return path.basename(voice, '.onnx');
  return voice;
}

/**
 * Auditions voices: synthesises VOICE_PREVIEW_TEXT with exactly the requested engine and voice, caches the
 * result on disk, and never touches saved settings. Unavailable voices and substitutions are errors.
 */
export class VoicePreviews {
  private readonly inflight = new Map<string, Promise<VoicePreview>>();

  constructor(
    private readonly dir: string,
    private readonly make: (engine: PreviewEngine, voice: string, pronunciations?: Pronunciation[], kokoroBackend?: ProviderSettings['kokoroBackend']) => NarrationProvider,
    private readonly style: () => PreviewStyle
  ) {}

  key(engine: PreviewEngine, voice: string, say?: { text: string; pronunciations: Pronunciation[] }, kokoroBackend?: ProviderSettings['kokoroBackend']): string {
    const st = { ...this.style(), ...(engine === 'sherpa' && kokoroBackend ? { kokoroBackend } : {}) };
    const what = say ? { text: say.text, pron: say.pronunciations } : { text: VOICE_PREVIEW_TEXT };
    return crypto.createHash('sha256').update(JSON.stringify({ v: 1, engine, voice, ...what, st })).digest('hex').slice(0, 24);
  }

  /**
   * Preview a voice. With `say`, speak that text (a word or sentence) using exactly those dictionary entries:
   * this is how pronunciation corrections are auditioned before they are saved.
   */
  preview(
    engine: PreviewEngine,
    voice: string,
    signal: AbortSignal = AbortSignal.timeout(180_000),
    say?: { text: string; pronunciations: Pronunciation[] },
    /** Audition Kokoro on an engine that is not saved yet (nothing is saved). */
    kokoroBackend?: ProviderSettings['kokoroBackend']
  ): Promise<VoicePreview> {
    if (!voice) return Promise.reject(new Error('Choose a specific voice to preview.'));
    if (say && !say.text.trim()) return Promise.reject(new Error('Nothing to say.'));
    const key = this.key(engine, voice, say, kokoroBackend);
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.run(engine, voice, key, signal, say, kokoroBackend).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async run(engine: PreviewEngine, voice: string, key: string, signal: AbortSignal, say?: { text: string; pronunciations: Pronunciation[] }, kokoroBackend?: ProviderSettings['kokoroBackend']): Promise<VoicePreview> {
    const wav = path.join(this.dir, `${PREFIX}${key}.wav`);
    const meta = path.join(this.dir, `${PREFIX}${key}.json`);
    if (fs.existsSync(wav) && fs.existsSync(meta)) {
      try {
        const m = JSON.parse(fs.readFileSync(meta, 'utf8')) as { voice: string; durationSec: number };
        const now = new Date();
        fs.utimesSync(wav, now, now);
        return { url: sampleUrl(path.basename(wav)), engine, voice: m.voice, durationSec: m.durationSec, cached: true };
      } catch {
        /* unreadable metadata: regenerate below */
      }
    }

    const n = this.make(engine, voice, say?.pronunciations, kokoroBackend);
    const status = await n.check(signal);
    if (!status.available) throw new Error(`Voice unavailable: ${status.detail}`);
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = path.join(this.dir, `${PREFIX}${key}.partial.wav`);
    let r;
    try {
      r = await n.synthesize(say?.text ?? VOICE_PREVIEW_TEXT, tmp, signal);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`Couldn't synthesise the preview: ${(e as Error).message}`);
    }
    const want = expectedVoice(engine, voice);
    if (r.voice !== want) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`The engine used "${r.voice}" instead of "${want}". Preview discarded.`);
    }
    fs.renameSync(tmp, wav);
    fs.writeFileSync(meta, JSON.stringify({ voice: r.voice, durationSec: r.durationSec }));
    this.prune();
    return { url: sampleUrl(path.basename(wav)), engine, voice: r.voice, durationSec: r.durationSec, cached: false };
  }

  private prune(): void {
    const wavs = fs
      .readdirSync(this.dir)
      .filter((f) => f.startsWith(PREFIX) && f.endsWith('.wav') && !f.endsWith('.partial.wav'))
      .map((f) => ({ f, t: fs.statSync(path.join(this.dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const o of wavs.slice(PREVIEW_CACHE_LIMIT)) {
      fs.rmSync(path.join(this.dir, o.f), { force: true });
      fs.rmSync(path.join(this.dir, o.f.replace(/\.wav$/, '.json')), { force: true });
    }
  }
}
