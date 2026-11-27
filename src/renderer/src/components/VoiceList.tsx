import { useEffect, useSyncExternalStore } from 'react';
import type { PreviewEngine } from '../../../shared/production';
import { PreviewPlayer } from '../previewPlayer';

// One player for the whole app, so only one preview plays at a time.
const player = new PreviewPlayer(
  (engine, voice) => window.api.previewVoice(engine, voice),
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
export function VoiceList(props: { label: string; name: string; engine: PreviewEngine; voices: VoiceOption[]; value: string; onSelect: (id: string) => void }) {
  useSyncExternalStore(player.subscribe, player.snapshot);
  useEffect(() => () => player.stop(), []);

  return (
    <div className="field">
      <span id={`${props.name}-label`}>{props.label}</span>
      <div className="voice-list" role="radiogroup" aria-labelledby={`${props.name}-label`}>
        {props.voices.map((v) => {
          const st = player.state(props.engine, v.id);
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
                  onClick={() => void player.toggle(props.engine, v.id)}
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
