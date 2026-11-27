import { useEffect, useSyncExternalStore } from 'react';
import type { PreviewEngine } from '../../../shared/production';
import { PreviewPlayer } from '../previewPlayer';

// One player for the whole app, so only one preview plays at a time.
// The longer passage uses the same player (key suffix), so a sentence and a passage never play at once.
// The Kokoro engine being considered is part of the key too, so both engines can be auditioned before saving.
const PASSAGE = '\u0001passage';
const GPU = '\u0002gpu';
const player = new PreviewPlayer(
  (engine, key) => {
    const gpu = key.endsWith(GPU);
    const k = gpu ? key.slice(0, -GPU.length) : key;
    const passage = k.endsWith(PASSAGE);
    return window.api.previewVoice(engine, passage ? k.slice(0, -PASSAGE.length) : k, passage ? 'passage' : 'short', engine === 'sherpa' ? (gpu ? 'gpu' : 'sherpa') : undefined);
  },
  (url) => new Audio(url)
);

export interface VoiceOption {
  id: string;
  label: string;
  /** False for choices that aren't a specific voice (e.g. "System default"). */
  previewable?: boolean;
}

/**
 * Voice chooser with a Listen button beside each voice. Listening never selects the voice or saves anything;
 * only the radio button selects.
 */
export function VoiceList(props: { label: string; name: string; engine: PreviewEngine; voices: VoiceOption[]; value: string; onSelect: (id: string) => void; /** Kokoro only: audition on this engine, saved or not. */ kokoroBackend?: 'sherpa' | 'gpu' }) {
  const sfx = props.kokoroBackend === 'gpu' ? GPU : '';
  useSyncExternalStore(player.subscribe, player.snapshot);
  useEffect(() => () => player.stop(), []);

  return (
    <div className="field">
      <span id={`${props.name}-label`}>{props.label}</span>
      <div className="voice-list" role="radiogroup" aria-labelledby={`${props.name}-label`}>
        {props.voices.map((v) => {
          const st = player.state(props.engine, v.id + sfx);
          const canPreview = v.previewable !== false && v.id !== '';
          return (
            <div className="voice-row" key={v.id || '_default'}>
              <label className="check">
                <input type="radio" name={props.name} checked={props.value === v.id} onChange={() => props.onSelect(v.id)} />
                {v.label}
              </label>
              {canPreview && (
                <button
                  type="button"
                  className="secondary voice-listen"
                  aria-label={`${st.status === 'playing' ? 'Stop' : 'Listen to'} ${v.label}`}
                  onClick={() => void player.toggle(props.engine, v.id + sfx)}
                >
                  {st.status === 'loading' ? (
                    <>
                      <span className="spinner" aria-hidden="true" /> Loading…
                    </>
                  ) : st.status === 'playing' ? (
                    <>
                      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3" y="3" width="10" height="10" fill="currentColor" /></svg> Stop
                    </>
                  ) : (
                    <>
                      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor" /></svg> Listen
                    </>
                  )}
                </button>
              )}
              {canPreview && (
                <button
                  type="button"
                  className="secondary voice-listen"
                  aria-label={`${player.state(props.engine, v.id + PASSAGE + sfx).status === 'playing' ? 'Stop' : 'Listen to a longer passage with'} ${v.label}`}
                  onClick={() => void player.toggle(props.engine, v.id + PASSAGE + sfx)}
                >
                  {player.state(props.engine, v.id + PASSAGE + sfx).status === 'loading' ? (
                    <>
                      <span className="spinner" aria-hidden="true" /> Loading…
                    </>
                  ) : player.state(props.engine, v.id + PASSAGE + sfx).status === 'playing' ? (
                    'Stop'
                  ) : (
                    'Passage'
                  )}
                </button>
              )}
              {player.state(props.engine, v.id + PASSAGE + sfx).status === 'error' && (
                <span className="field-error small voice-error" role="alert">
                  {(player.state(props.engine, v.id + PASSAGE + sfx) as { message: string }).message}
                </span>
              )}
              {st.status === 'error' && (
                <span className="field-error small voice-error" role="alert">
                  {st.message}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
