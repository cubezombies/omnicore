import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { BUSINESS_TYPES, MODULES, type Business, type BusinessType } from '../../../shared/business';

const clean = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const ACCENTS = ['#5eead4', '#93c5fd', '#fbbf24', '#f9a8d4', '#86efac', '#fca5a5', '#c4b5fd'];

/** Create, view, switch, archive and restore businesses. */
export function Businesses(props: { active: Business | null; onSwitch: (id: number) => void; onChanged: () => void }) {
  const [list, setList] = useState<Business[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<BusinessType>('media');
  const [description, setDescription] = useState('');
  const [niche, setNiche] = useState('');
  const [accent, setAccent] = useState(ACCENTS[1]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    window.api.listBusinesses(true).then(setList, (e) => setError(clean(e)));
  }, []);
  useEffect(load, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      load();
      props.onChanged();
    } catch (e) {
      setError(clean(e));
    }
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const b = await window.api.createBusiness({ name, businessType: type, description, niche, accent });
      setCreating(false);
      setName('');
      setDescription('');
      setNiche('');
      load();
      props.onSwitch(b.id);
    } catch (err) {
      setError(clean(err));
    } finally {
      setBusy(false);
    }
  };

  const shown = list.filter((b) => showArchived || !b.archivedAt);
  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Businesses</h1>
          <p className="muted">Each business has its own topics, accounts, automation, content and records. Nothing is shared between them.</p>
        </div>
        <button className="primary" onClick={() => setCreating((c) => !c)} aria-expanded={creating}>
          {creating ? 'Cancel' : 'New business'}
        </button>
      </header>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      {creating && (
        <form className="card biz-form" onSubmit={(e) => void create(e)}>
          <h2>New business</h2>
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required autoFocus />
          </label>
          <label className="field">
            <span>What kind of business is it?</span>
            <select value={type} onChange={(e) => setType(e.target.value as BusinessType)}>
              {(Object.keys(BUSINESS_TYPES) as BusinessType[]).map((t) => (
                <option key={t} value={t}>
                  {BUSINESS_TYPES[t].label}
                </option>
              ))}
            </select>
            <span className="muted small">
              {BUSINESS_TYPES[type].modules.length
                ? `Starts with: ${BUSINESS_TYPES[type].modules.map((m) => `${MODULES[m].label}${MODULES[m].available ? '' : ' (coming later)'}`).join(', ')}. You can change modules afterwards in Business Settings.`
                : 'Starts with the core tools only (topics, analytics, settings).'}
            </span>
          </label>
          <label className="field">
            <span>Short description</span>
            <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
          </label>
          <label className="field">
            <span>Focus (optional)</span>
            <input value={niche} onChange={(e) => setNiche(e.target.value)} maxLength={200} placeholder="e.g. small-business bookkeeping" />
          </label>
          <fieldset className="field">
            <legend>Colour</legend>
            <div className="swatches">
              {ACCENTS.map((c) => (
                <label key={c} className="swatch" style={{ background: c }}>
                  <input type="radio" name="accent" checked={accent === c} onChange={() => setAccent(c)} aria-label={`Colour ${c}`} />
                </label>
              ))}
            </div>
          </fieldset>
          <div className="prod-actions">
            <button className="primary" type="submit" disabled={busy || !name.trim()}>
              {busy ? 'Creating…' : 'Create and switch to it'}
            </button>
          </div>
        </form>
      )}

      <label className="check small">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived businesses
      </label>
      <ul className="biz-list">
        {shown.map((b) => {
          const isActive = props.active?.id === b.id;
          return (
            <li key={b.id} className={`card biz-card${isActive ? ' active' : ''}${b.archivedAt ? ' archived' : ''}`}>
              <span className="biz-dot" style={{ background: b.accent }} aria-hidden="true">
                {b.name.charAt(0).toUpperCase()}
              </span>
              <div className="biz-card-body">
                <strong>{b.name}</strong> {isActive && <span className="pill">Current</span>} {b.archivedAt && <span className="pill muted">Archived</span>}
                <div className="muted small">
                  {BUSINESS_TYPES[b.businessType].label}
                  {b.modules.length ? ` · ${b.modules.map((m) => MODULES[m].label).join(', ')}` : ''}
                </div>
                {b.description && <p className="small">{b.description}</p>}
              </div>
              <div className="prod-actions">
                {!b.archivedAt && !isActive && (
                  <button className="secondary" onClick={() => props.onSwitch(b.id)}>
                    Switch to
                  </button>
                )}
                {!b.archivedAt && !isActive && (
                  <button className="ghost" onClick={() => void act(() => window.api.archiveBusiness(b.id))}>
                    Archive
                  </button>
                )}
                {b.archivedAt && (
                  <button className="secondary" onClick={() => void act(() => window.api.restoreBusiness(b.id))}>
                    Restore
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="muted small">Archiving hides a business and pauses its automation. Its data is kept and comes back when you restore it.</p>
    </section>
  );
}
