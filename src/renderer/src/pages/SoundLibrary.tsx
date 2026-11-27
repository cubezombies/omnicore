import { useCallback, useEffect, useState } from 'react';
import { SOUND_GENERATORS, libraryUrl, type AudioKind, type AudioTrack, type SoundGeneratorId } from '../../../shared/production';
import { errorText } from '../components/ProductionDetail';

function TrackRow({ t, onChanged }: { t: AudioTrack; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(t.title);
  const [license, setLicense] = useState(t.license);
  const [attribution, setAttribution] = useState(t.attribution);
  const [sourceUrl, setSourceUrl] = useState(t.sourceUrl);
  const [tags, setTags] = useState(t.tags.join(', '));
  const [commercialUse, setCommercialUse] = useState(t.commercialUse);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    try {
      await window.api.updateSound(t.id, { title, license, attribution, sourceUrl, commercialUse, tags: tags.split(',').map((x) => x.trim()).filter(Boolean) });
      setEditing(false);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function remove() {
    if (!window.confirm(`Delete "${t.title}" from the library?`)) return;
    try {
      await window.api.deleteSound(t.id);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <li className="track">
      <div className="track-main">
        <div>
          <strong>{t.title}</strong>
          <span className="muted small">
            {' '}
            · {t.durationSec.toFixed(1)}s · {t.origin}
            {t.tags.length ? ` · ${t.tags.join(', ')}` : ''}
          </span>
          <div className={t.license ? 'small muted' : 'small field-error'}>{t.license || 'No licence recorded: add one before publishing videos that use this sound.'}</div>
          {t.attribution && <div className="small muted">Attribution: {t.attribution}</div>}
          <div className={t.commercialUse === 'yes' ? 'small muted' : 'small field-error'}>{t.commercialUse === 'yes' ? 'Cleared for commercial videos (used automatically)' : t.commercialUse === 'no' ? 'Not for commercial use: never used automatically' : 'Commercial use not confirmed: never used automatically'}</div>
        </div>
        <audio controls preload="none" src={libraryUrl(t.file)} aria-label={`Preview ${t.title}`} />
        <span className="track-actions">
          <button className="ghost" onClick={() => setEditing((x) => !x)} aria-expanded={editing}>
            Edit
          </button>
          <button className="danger" onClick={remove}>
            Delete
          </button>
        </span>
      </div>
      {editing && (
        <div className="track-edit">
          <label className="field">
            <span>Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field">
            <span>Licence</span>
            <input value={license} placeholder="e.g. CC BY 4.0, CC0, Pixabay Content License" onChange={(e) => setLicense(e.target.value)} />
          </label>
          <label className="field">
            <span>Attribution (credit line)</span>
            <input value={attribution} onChange={(e) => setAttribution(e.target.value)} />
          </label>
          <label className="field">
            <span>Source URL</span>
            <input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} />
          </label>
          <label className="field">
            <span>Commercial use (does the licence allow use in monetised/brand videos?)</span>
            <select value={commercialUse} onChange={(e) => setCommercialUse(e.target.value as AudioTrack['commercialUse'])}>
              <option value="unknown">Not confirmed</option>
              <option value="yes">Yes: the licence allows commercial use</option>
              <option value="no">No</option>
            </select>
          </label>
          <label className="field">
            <span>Tags (comma separated; SFX tagged "transition" are used at scene cuts)</span>
            <input value={tags} onChange={(e) => setTags(e.target.value)} />
          </label>
          <div className="prod-actions">
            <button className="primary" onClick={save}>
              Save
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="field-error small" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

export function SoundLibraryPage() {
  const [tracks, setTracks] = useState<AudioTrack[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void window.api
      .listSounds()
      .then(setTracks)
      .catch((e: unknown) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const section = (kind: AudioKind, heading: string) => {
    const list = (tracks ?? []).filter((t) => t.kind === kind);
    return (
      <section>
        <h2>{heading}</h2>
        {list.length === 0 ? (
          <p className="empty">None yet. Generate one below or import your own file.</p>
        ) : (
          <ul className="tracks">
            {list.map((t) => (
              <TrackRow key={t.id} t={t} onChanged={load} />
            ))}
          </ul>
        )}
      </section>
    );
  };

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Sound Library</h1>
          <p className="muted">Music beds and sound effects for productions. Choose how they are used in Studio → Providers.</p>
        </div>
        <span className="prod-actions">
          <button className="secondary" disabled={!!busy} onClick={() => run('import-music', () => window.api.importSound('music'))}>
            Import music
          </button>
          <button className="secondary" disabled={!!busy} onClick={() => run('import-sfx', () => window.api.importSound('sfx'))}>
            Import effect
          </button>
        </span>
      </header>
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      {tracks === null ? <p className="muted">Loading…</p> : (
        <>
          {section('music', 'Music')}
          {section('sfx', 'Sound effects')}
        </>
      )}
      <h2>Generate (free, synthesised locally)</h2>
      <p className="muted small">These are created from scratch by FFmpeg on this computer, so they carry no third-party rights.</p>
      <div className="prod-actions">
        {SOUND_GENERATORS.map((g) => (
          <button key={g.id} className="secondary" disabled={!!busy} onClick={() => run(g.id, () => window.api.generateSound(g.id as SoundGeneratorId))}>
            {busy === g.id ? 'Generating…' : g.title.replace(' (generated)', '')}
          </button>
        ))}
      </div>
      <p className="muted small">
        Importing your own files: you are responsible for their licence. Record the licence and credit line so they appear in each video's credits.
      </p>
    </section>
  );
}
