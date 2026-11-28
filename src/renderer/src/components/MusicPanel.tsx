import { useEffect, useState } from 'react';
import { libraryUrl, type AudioTrack, type MusicOverride, type Production } from '../../../shared/production';
import { errorText } from './ProductionDetail';
import { RightsBadge } from './RightsDetails';
import type { ContextualEffect } from '../../../shared/audioMix';

/**
 * Music for one production: what was chosen (with its licence and role), and a manual override. Changing the choice
 * is recorded in the audit log; it applies when the video is re-rendered.
 */
export function MusicPanel({ production: p }: { production: Production }) {
  const [tracks, setTracks] = useState<AudioTrack[]>([]);
  const [all, setAll] = useState<AudioTrack[]>([]);
  const [choice, setChoice] = useState<MusicOverride | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void Promise.all([window.api.listSounds(), window.api.getMusicOverride(p.id)])
      .then(([t, o]) => {
        setTracks(t.filter((x) => x.kind === 'music' && x.rightsStatus === 'approved' && x.usage === 'embedded' && x.commercialUse === 'yes'));
        setAll(t);
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
              {(() => {
                const now = all.find((x) => x.id === Number(a.meta.trackId));
                return now && now.rightsStatus !== 'approved' ? (
                  <>
                    {' '}
                    <RightsBadge status={now.rightsStatus} /> <span className="field-error">this render cannot be published</span>
                  </>
                ) : null;
              })()}
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
          {tracks.map((t) => (
            <option key={t.id} value={String(t.id)}>
              {t.title} · Approved · {t.attribution || (t.origin === 'generated' ? 'Omnicore (generated)' : 'unknown creator')}
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
      <ContextualEffects production={p} effects={all.filter((t) => t.kind === 'sfx' && t.rightsStatus === 'approved')} />
      {msg && <p className="muted small" role="status">{msg}</p>}
      {error && <div className="banner error" role="alert">{error}</div>}
    </div>
  );
}

/**
 * Contextual effects for this production only. Off by default: nothing is added automatically. You choose an approved
 * sound effect, where it plays and why; saving approves them (each is rights-checked now and again at render time).
 */
function ContextualEffects({ production: p, effects }: { production: Production; effects: AudioTrack[] }) {
  const [rows, setRows] = useState<ContextualEffect[]>([]);
  const [approvedAt, setApprovedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    void window.api.getProductionEffects(p.id).then((e) => {
      setRows(e?.effects ?? []);
      setApprovedAt(e?.approvedAt ?? null);
      setOpen(!!e?.effects.length);
    });
  }, [p.id]);
  const update = (i: number, patch: Partial<ContextualEffect>) => setRows(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  async function save(list: ContextualEffect[]) {
    setError(null);
    try {
      const saved = await window.api.setProductionEffects(p.id, list);
      setRows(saved?.effects ?? []);
      setApprovedAt(saved?.approvedAt ?? null);
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <details className="contextual-effects" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>Contextual sound effects ({approvedAt && rows.length ? `${rows.length} approved` : 'none'})</summary>
      <p className="muted small">Off by default. Add an effect only when it genuinely supports a scene. Saving approves it for this production; it applies on the next render.</p>
      {effects.length === 0 && <p className="muted small">No approved sound effects are in the library.</p>}
      {rows.map((r, i) => (
        <div key={i} className="prod-actions">
          <select aria-label="Sound effect" value={String(r.trackId)} onChange={(e) => update(i, { trackId: Number(e.target.value) })}>
            {effects.map((t) => (
              <option key={t.id} value={String(t.id)}>
                {t.title}
              </option>
            ))}
          </select>
          <input aria-label="Start time in seconds" type="number" min={0} step={0.1} value={r.atSec} onChange={(e) => update(i, { atSec: Number(e.target.value) })} style={{ width: 90 }} />
          <input aria-label="Why it belongs in this scene" placeholder="Why it belongs here" value={r.note} onChange={(e) => update(i, { note: e.target.value })} />
          <button className="ghost" onClick={() => setRows(rows.filter((_, k) => k !== i))}>
            Remove
          </button>
        </div>
      ))}
      <div className="prod-actions">
        {effects.length > 0 && (
          <button className="secondary" onClick={() => setRows([...rows, { trackId: effects[0].id, atSec: 0, note: '' }])}>
            Add effect
          </button>
        )}
        <button className="primary" disabled={rows.some((r) => !r.note.trim())} title={rows.some((r) => !r.note.trim()) ? 'Say why each effect belongs in its scene' : undefined} onClick={() => void save(rows)}>
          {rows.length ? 'Approve effects for this production' : 'Save (no effects)'}
        </button>
      </div>
      {error && <p className="field-error small" role="alert">{error}</p>}
    </details>
  );
}
