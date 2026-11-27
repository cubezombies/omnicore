import { useEffect, useState } from 'react';
import { libraryUrl, type AudioTrack, type MusicOverride, type Production } from '../../../shared/production';
import { errorText } from './ProductionDetail';

/**
 * Music for one production: what was chosen (with its licence and role), and a manual override. Changing the choice
 * is recorded in the audit log; it applies when the video is re-rendered.
 */
export function MusicPanel({ production: p }: { production: Production }) {
  const [tracks, setTracks] = useState<AudioTrack[]>([]);
  const [choice, setChoice] = useState<MusicOverride | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void Promise.all([window.api.listSounds(), window.api.getMusicOverride(p.id)])
      .then(([t, o]) => {
        setTracks(t.filter((x) => x.kind === 'music' && x.usage === 'embedded' && x.commercialUse === 'yes'));
        setChoice(o);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, [p.id]);
  const sounds = p.assets.filter((a) => a.kind === 'music' || a.kind === 'sfx');
  const value = !choice ? 'auto' : choice.mode === 'none' ? 'none' : String(choice.trackId);
  async function change(v: string) {
    setError(null);
    try {
      const o: MusicOverride = v === 'auto' ? { mode: 'auto', trackId: null } : v === 'none' ? { mode: 'none', trackId: null } : { mode: 'track', trackId: Number(v) };
      setChoice(await window.api.setMusicOverride(p.id, o));
      setMsg('Saved. Re-render to apply it.');
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function rerender() {
    setError(null);
    try {
      await window.api.rerunProduction(p.id, 'render');
      setMsg('Re-rendering with the new music…');
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <div className="card">
      <h3>Music &amp; sound</h3>
      {sounds.length === 0 ? (
        <p className="muted small">No music or effects in the current render.</p>
      ) : (
        <ul className="small">
          {sounds.map((a) => (
            <li key={a.id}>
              {String(a.meta.role ?? a.kind)}: {a.attribution}
              {a.meta.mood ? ` · mood ${String(a.meta.mood)}` : ''}
              {a.sourceUrl ? (
                <>
                  {' '}
                  · <a href={a.sourceUrl} target="_blank" rel="noreferrer">source</a>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <label className="field">
        <span>Music for this video</span>
        <select value={value} onChange={(e) => void change(e.target.value)}>
          <option value="auto">Automatic (story mood, business profile)</option>
          <option value="none">No music</option>
          {tracks.map((t) => (
            <option key={t.id} value={String(t.id)}>
              {t.title} · {t.license}
            </option>
          ))}
        </select>
      </label>
      {choice?.mode === 'track' && tracks.find((t) => t.id === choice.trackId) && <audio controls preload="none" src={libraryUrl(tracks.find((t) => t.id === choice.trackId)!.file)} aria-label="Preview the chosen music" />}
      <div className="prod-actions">
        <button className="secondary" disabled={p.status === 'running' || p.status === 'queued'} onClick={rerender}>
          Re-render with this music
        </button>
      </div>
      {msg && <p className="muted small" role="status">{msg}</p>}
      {error && <div className="banner error" role="alert">{error}</div>}
    </div>
  );
}
