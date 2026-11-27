import type { PreviewEngine, VoicePreview } from '../../shared/production';

export type PreviewState = { status: 'idle' } | { status: 'loading' } | { status: 'playing' } | { status: 'error'; message: string };

/** The subset of HTMLAudioElement the player needs (lets tests run without a DOM). */
export interface AudioLike {
  play(): Promise<void>;
  pause(): void;
  onended: ((...args: never[]) => unknown) | null;
  onerror: ((...args: never[]) => unknown) | null;
}

const IDLE: PreviewState = { status: 'idle' };
export const previewKey = (engine: PreviewEngine, voice: string): string => `${engine}|${voice}`;
const cleanError = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/**
 * Plays one voice preview at a time. Toggling a playing voice stops it; starting another stops the first.
 * It only fetches and plays audio; it never selects a voice or saves settings.
 */
export class PreviewPlayer {
  private states = new Map<string, PreviewState>();
  private current: { key: string; audio: AudioLike } | null = null;
  private pending: string | null = null;
  private listeners = new Set<() => void>();
  private version = 0;

  constructor(
    private readonly fetchPreview: (engine: PreviewEngine, voice: string) => Promise<VoicePreview>,
    private readonly makeAudio: (url: string) => AudioLike
  ) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  /** Changes whenever any state changes (for useSyncExternalStore). */
  snapshot = (): number => this.version;
  state(engine: PreviewEngine, voice: string): PreviewState {
    return this.states.get(previewKey(engine, voice)) ?? IDLE;
  }

  private set(key: string, s: PreviewState): void {
    this.states.set(key, s);
    this.version++;
    for (const l of this.listeners) l();
  }

  stop(): void {
    if (this.current) {
      const { key, audio } = this.current;
      this.current = null;
      audio.onended = audio.onerror = null;
      audio.pause();
      this.set(key, IDLE);
    }
    if (this.pending) {
      const key = this.pending;
      this.pending = null;
      this.set(key, IDLE);
    }
  }

  async toggle(engine: PreviewEngine, voice: string): Promise<void> {
    const key = previewKey(engine, voice);
    const s = this.state(engine, voice).status;
    if (s === 'playing' || s === 'loading') return this.stop();
    this.stop();
    this.pending = key;
    this.set(key, { status: 'loading' });
    let preview: VoicePreview;
    try {
      preview = await this.fetchPreview(engine, voice);
    } catch (e) {
      if (this.pending === key) {
        this.pending = null;
        this.set(key, { status: 'error', message: cleanError(e) });
      }
      return;
    }
    if (this.pending !== key) return; // cancelled or superseded while generating
    this.pending = null;
    const audio = this.makeAudio(preview.url);
    this.current = { key, audio };
    const finish = (err?: string) => {
      if (this.current?.audio !== audio) return;
      this.current = null;
      this.set(key, err ? { status: 'error', message: err } : IDLE);
    };
    audio.onended = () => finish();
    audio.onerror = () => finish("The preview couldn't be played.");
    this.set(key, { status: 'playing' });
    try {
      await audio.play();
    } catch (e) {
      finish(`The preview couldn't be played: ${cleanError(e)}`);
    }
  }
}
