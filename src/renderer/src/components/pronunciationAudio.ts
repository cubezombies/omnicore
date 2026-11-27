import { useState } from 'react';

const clean = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
let current: HTMLAudioElement | null = null;

/** Speak text with the business's presenter (optionally with a draft correction) and play it; one sound at a time. */
export function useAudition() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listen = async (key: string, req: { text: string; term?: string; say?: string }) => {
    setError(null);
    setBusy(key);
    try {
      const p = await window.api.auditionPronunciation(req);
      current?.pause();
      current = new Audio(p.url);
      await current.play();
    } catch (e) {
      setError(clean(e));
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, listen };
}
