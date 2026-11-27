import { useEffect, useState } from 'react';
import { BUSINESS_TYPES, MODULES, type Business, type BusinessType, type ModuleId } from '../../../shared/business';
import { KOKORO_VOICES } from '../../../shared/production';
import { VoiceList } from '../components/VoiceList';

const clean = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Identity, objectives, agent instructions, type and modules of the active business. */
export function BusinessSettings(props: { business: Business; onSaved: () => void }) {
  const b = props.business;
  const [name, setName] = useState(b.name);
  const [description, setDescription] = useState(b.description);
  const [niche, setNiche] = useState(b.niche);
  const [objectives, setObjectives] = useState(b.objectives);
  const [instructions, setInstructions] = useState(b.instructions);
  const [type, setType] = useState<BusinessType>(b.businessType);
  const [modules, setModules] = useState<ModuleId[]>(b.modules);
  const [accent, setAccent] = useState(b.accent);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [presenter, setPresenter] = useState<{ engine: string; voice: string } | null>(null);

  useEffect(() => {
    if (b.modules.includes('media')) window.api.getBrandPresenter().then(setPresenter, () => setPresenter(null));
  }, [b.id, b.modules]);

  const save = async () => {
    setMsg(null);
    setError(null);
    try {
      await window.api.updateBusiness(b.id, { name, description, niche, objectives, instructions, businessType: type, modules, accent });
      setMsg('Saved.');
      props.onSaved();
    } catch (e) {
      setError(clean(e));
    }
  };

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Business Settings</h1>
          <p className="muted">Settings for {b.name} only.</p>
        </div>
      </header>

      <div className="settings-grid">
        <fieldset className="card">
          <legend>Identity</legend>
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </label>
          <label className="field">
            <span>Description</span>
            <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
          </label>
          <label className="field">
            <span>Focus</span>
            <input value={niche} onChange={(e) => setNiche(e.target.value)} maxLength={200} />
            <span className="muted small">A few words research and discovery use to stay on subject.</span>
          </label>
          <label className="field">
            <span>Colour</span>
            <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} />
          </label>
        </fieldset>

        <fieldset className="card">
          <legend>Objectives and AI instructions</legend>
          <label className="field">
            <span>Objectives</span>
            <textarea rows={4} value={objectives} onChange={(e) => setObjectives(e.target.value)} maxLength={2000} />
          </label>
          <label className="field">
            <span>Standing instructions for this business's AI agents</span>
            <textarea rows={5} value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={2000} placeholder="Tone, audience, things to always or never do…" />
            <span className="muted small">Used only for {b.name}. They guide style and focus; they can't override editorial, rights or approval rules.</span>
          </label>
        </fieldset>

        <fieldset className="card">
          <legend>Type and modules</legend>
          <label className="field">
            <span>Business type</span>
            <select value={type} onChange={(e) => setType(e.target.value as BusinessType)}>
              {(Object.keys(BUSINESS_TYPES) as BusinessType[]).map((t) => (
                <option key={t} value={t}>
                  {BUSINESS_TYPES[t].label}
                </option>
              ))}
            </select>
          </label>
          {(Object.keys(MODULES) as ModuleId[]).map((m) => (
            <label key={m} className={`check${MODULES[m].available ? '' : ' tt-off'}`}>
              <input type="checkbox" checked={modules.includes(m)} disabled={!MODULES[m].available && !modules.includes(m)} onChange={(e) => setModules((cur) => (e.target.checked ? [...cur, m] : cur.filter((x) => x !== m)))} />
              {MODULES[m].label} <span className="muted small">{MODULES[m].available ? MODULES[m].description : 'coming later'}</span>
            </label>
          ))}
          <span className="muted small">Turning a module off hides its pages; its data is kept.</span>
        </fieldset>

        {b.modules.includes('media') && presenter && (
          <fieldset className="card">
            <legend>Presenter voice</legend>
            <VoiceList
              label={`${b.name} presenter (used for this business regardless of the global narration settings)`}
              name="presenterVoice"
              engine="sherpa"
              voices={[...KOKORO_VOICES.map((k) => ({ id: k.id as string, label: k.label })), { id: 'global', label: 'Use global narration settings', previewable: false }]}
              value={presenter.engine === 'sherpa' ? presenter.voice : presenter.engine}
              onSelect={(id) => {
                void (id === 'global' ? window.api.setBrandPresenter('global', '') : window.api.setBrandPresenter('sherpa', id)).then(() => window.api.getBrandPresenter().then(setPresenter), (e) => setError(clean(e)));
              }}
            />
          </fieldset>
        )}
      </div>

      <div className="prod-actions">
        <button className="primary" onClick={() => void save()} disabled={!name.trim()}>
          Save settings
        </button>
        {msg && (
          <span className="small" role="status">
            {msg}
          </span>
        )}
        {error && (
          <span className="field-error small" role="alert">
            {error}
          </span>
        )}
      </div>
    </section>
  );
}
