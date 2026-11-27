import { useCallback, useEffect, useState } from 'react';
import { SOUND_GENERATORS, libraryUrl, type AudioKind, type AudioTrack, type SoundGeneratorId, type SoundProfile } from '../../../shared/production';
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
          {t.rights.provider && (
            <div className="small muted">
              Verified {t.rights.verifiedAt?.slice(0, 10)} via {t.rights.provider} ({t.rights.source}, track {t.rights.providerTrackId}){t.rights.attributionRequired ? ' · credit required in descriptions' : ''} ·{' '}
              <a href={t.rights.landingUrl} target="_blank" rel="noreferrer">source</a>
              {t.rights.licenseUrl ? (
                <>
                  {' '}
                  · <a href={t.rights.licenseUrl} target="_blank" rel="noreferrer">licence</a>
                </>
              ) : null}
            </div>
          )}
          {(t.restrictions.platforms?.length || t.usage === 'platform_native') && <div className="small field-error">{t.usage === 'platform_native' ? 'Platform-only sound: never mixed into exported videos.' : `Only for: ${t.restrictions.platforms!.join(', ')}`}</div>}
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

const MOOD_LABELS = { calm: 'Calm', upbeat: 'Upbeat', tense: 'Tense', inspiring: 'Inspiring' } as const;
type MoodId = keyof typeof MOOD_LABELS;

/** The active business's sound: music required, preferred moods, accents, discovery and level. */
function SoundProfileCard() {
  const [p, setP] = useState<SoundProfile | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void window.api.getSoundProfile().then(setP).catch((e: unknown) => setError(errorText(e)));
  }, []);
  if (!p) return error ? <div className="banner error" role="alert">{error}</div> : null;
  const set = <K extends keyof SoundProfile>(k: K, v: SoundProfile[K]) => setP({ ...p, [k]: v });
  async function save() {
    setError(null);
    try {
      setP(await window.api.saveSoundProfile(p!));
      setMsg('Sound profile saved. It applies to the next render.');
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <section className="card">
      <h2>Sound profile for this business</h2>
      <label className="check">
        <input type="checkbox" checked={p.music === 'required'} onChange={(e) => set('music', e.target.checked ? 'required' : 'off')} />
        Background music in every video (QA fails a video without it)
      </label>
      <fieldset className="field">
        <legend>Preferred moods (the story picks among these; none = any)</legend>
        {(Object.keys(MOOD_LABELS) as MoodId[]).map((m) => (
          <label key={m} className="check">
            <input type="checkbox" checked={p.preferredMoods.includes(m)} onChange={(e) => set('preferredMoods', e.target.checked ? [...p.preferredMoods, m] : p.preferredMoods.filter((x) => x !== m))} />
            {MOOD_LABELS[m]}
          </label>
        ))}
      </fieldset>
      <label className="check">
        <input type="checkbox" checked={p.introAccent} onChange={(e) => set('introAccent', e.target.checked)} /> Intro accent (a short riser into the first line)
      </label>
      <label className="check">
        <input type="checkbox" checked={p.transitions} onChange={(e) => set('transitions', e.target.checked)} /> Transition effects at scene cuts
      </label>
      <label className="check">
        <input type="checkbox" checked={p.outroAccent} onChange={(e) => set('outroAccent', e.target.checked)} /> Outro accent
      </label>
      <label className="check">
        <input type="checkbox" checked={p.autoDiscover} onChange={(e) => set('autoDiscover', e.target.checked)} /> Find licensed music automatically when the library has nothing for a story's mood
      </label>
      <label className="field">
        <span>Music level under the voice ({Math.round(p.musicVolume * 100)}%)</span>
        <input type="range" min={0.04} max={0.3} step={0.01} value={p.musicVolume} onChange={(e) => set('musicVolume', Number(e.target.value))} />
      </label>
      <div className="prod-actions">
        <button onClick={save}>Save sound profile</button>
      </div>
      {msg && <p className="muted small" role="status">{msg}</p>}
      {error && <div className="banner error" role="alert">{error}</div>}
    </section>
  );
}

export function SoundLibraryPage() {
  const [mood, setMood] = useState<MoodId>('calm');
  const [found, setFound] = useState<string | null>(null);
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
      <SoundProfileCard />
      <section className="card">
        <h2>Find licensed music</h2>
        <p className="muted small">
          Searches Openverse for instrumental tracks whose licence allows commercial use and syncing to video (CC0, public domain, CC BY). Non-commercial, no-derivatives, share-alike and unclear licences are refused. Each track's licence record is kept as evidence; CC BY tracks are credited in every description. TikTok's Commercial Music Library is not used here: its sounds can't be added to exported videos.
        </p>
        <div className="prod-actions">
          <select aria-label="Mood" value={mood} onChange={(e) => setMood(e.target.value as MoodId)}>
            {(Object.keys(MOOD_LABELS) as MoodId[]).map((m) => (
              <option key={m} value={m}>
                {MOOD_LABELS[m]}
              </option>
            ))}
          </select>
          <button
            className="secondary"
            disabled={!!busy}
            onClick={() =>
              run('discover', async () => {
                const r = await window.api.discoverMusic(mood);
                setFound(`${r.imported.length} track(s) added.${r.refused.length ? ` Refused: ${r.refused.slice(0, 4).join('; ')}${r.refused.length > 4 ? '…' : ''}` : ''}`);
              })
            }
          >
            {busy === 'discover' ? 'Searching…' : 'Find music'}
          </button>
        </div>
        {found && <p className="small muted" role="status">{found}</p>}
      </section>
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
