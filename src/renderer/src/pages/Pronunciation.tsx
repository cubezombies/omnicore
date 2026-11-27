import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Business } from '../../../shared/business';
import type { PreviewEngine, PronunciationDraft, PronunciationEntry } from '../../../shared/production';
import { useAudition } from '../components/pronunciationAudio';

const clean = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const ENGINE_LABEL: Record<PreviewEngine, string> = { sherpa: 'Kokoro', piper: 'Piper', 'windows-sapi': 'Windows voices' };
const sentenceFor = (term: string, example: string) => example.trim() || `Today we look at ${term}, and why it matters.`;

/** Add or edit an entry, with auditions of the word and a sentence before saving. */
export function PronunciationForm(props: { business: Business; initial?: Partial<PronunciationEntry>; example?: string; onSaved: (e: PronunciationEntry) => void; onCancel: () => void }) {
  const i = props.initial;
  const [term, setTerm] = useState(i?.term ?? '');
  const [say, setSay] = useState(i?.say ?? '');
  const [scope, setScope] = useState<PronunciationDraft['scope']>(i?.businessId === null ? 'global' : 'business');
  const [engineSay, setEngineSay] = useState<Partial<Record<PreviewEngine, string>>>(i?.engineSay ?? {});
  const [context, setContext] = useState(i?.context ?? '');
  const [ipa, setIpa] = useState(i?.ipa ?? '');
  const [example, setExample] = useState(props.example ?? '');
  const [error, setError] = useState<string | null>(null);
  const a = useAudition();

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      props.onSaved(await window.api.savePronunciation({ term, say, scope, engineSay, context, ipa, verified: true }));
    } catch (err) {
      setError(clean(err));
    }
  };

  return (
    <form className="card pron-form" onSubmit={(e) => void save(e)}>
      <h3>{i?.id ? `Edit “${i.term}”` : 'New pronunciation'}</h3>
      <div className="topic-form-grid">
        <label className="field">
          <span>Written as</span>
          <input value={term} onChange={(e) => setTerm(e.target.value)} maxLength={60} required placeholder="Kubernetes" />
        </label>
        <label className="field">
          <span>Said as (respelling)</span>
          <input value={say} onChange={(e) => setSay(e.target.value)} maxLength={120} required placeholder="koo ber net eez" />
        </label>
        <label className="field wide">
          <span>Example sentence for listening (optional)</span>
          <input value={example} onChange={(e) => setExample(e.target.value)} maxLength={300} placeholder={term ? sentenceFor(term, '') : ''} />
        </label>
        <div className="prod-actions wide">
          <button type="button" className="secondary" disabled={!term || !say || !!a.busy} onClick={() => void a.listen('w', { text: term, term, say })}>
            {a.busy === 'w' ? 'Generating…' : 'Listen to word'}
          </button>
          <button type="button" className="secondary" disabled={!term || !say || !!a.busy} onClick={() => void a.listen('s', { text: sentenceFor(term, example), term, say })}>
            {a.busy === 's' ? 'Generating…' : 'Listen in a sentence'}
          </button>
          <span className="muted small">Spoken by {props.business.name}'s presenter. Captions and scripts always keep the written spelling.</span>
        </div>
        {a.error && (
          <p className="field-error small wide" role="alert">
            {a.error}
          </p>
        )}
        <fieldset className="field wide">
          <legend>Different respelling for one engine (optional)</legend>
          <div className="topic-form-grid">
            {(Object.keys(ENGINE_LABEL) as PreviewEngine[]).map((en) => (
              <label key={en} className="field">
                <span>{ENGINE_LABEL[en]}</span>
                <input value={engineSay[en] ?? ''} onChange={(e) => setEngineSay((cur) => ({ ...cur, [en]: e.target.value }))} maxLength={120} placeholder={say} />
              </label>
            ))}
          </div>
        </fieldset>
        <label className="field">
          <span>Applies to</span>
          <select value={scope} onChange={(e) => setScope(e.target.value as PronunciationDraft['scope'])}>
            <option value="business">{props.business.name} only</option>
            <option value="global">Every business</option>
          </select>
        </label>
        <label className="field">
          <span>Context or meaning (optional)</span>
          <input value={context} onChange={(e) => setContext(e.target.value)} maxLength={300} placeholder="e.g. the container platform" />
        </label>
        <label className="field wide">
          <span>Phonetic notes, IPA (optional, reference only)</span>
          <input value={ipa} onChange={(e) => setIpa(e.target.value)} maxLength={120} />
          <span className="muted small">None of the installed engines accept phoneme input (tested), so this is never sent to them. The respelling is what they read.</span>
        </label>
      </div>
      {error && (
        <p className="field-error small" role="alert">
          {error}
        </p>
      )}
      <div className="prod-actions">
        <button className="primary" type="submit" disabled={!term.trim() || !say.trim()}>
          Save
        </button>
        <button className="secondary" type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The pronunciation dictionary for the active business (its own entries plus shared ones). */
export function Pronunciation(props: { business: Business }) {
  const [entries, setEntries] = useState<PronunciationEntry[]>([]);
  const [editing, setEditing] = useState<Partial<PronunciationEntry> | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const a = useAudition();

  const load = useCallback(() => {
    window.api.listPronunciations().then(setEntries, (e) => setError(clean(e)));
  }, []);
  useEffect(load, [load]);

  const shown = entries.filter((e) => !filter || e.term.toLowerCase().includes(filter.toLowerCase()) || e.say.toLowerCase().includes(filter.toLowerCase()));
  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Pronunciation</h1>
          <p className="muted">How names and technical terms are said in narration. {props.business.name}'s entries override shared ones. Captions keep the written spelling.</p>
        </div>
        <button className="primary" onClick={() => setEditing({})}>
          New pronunciation
        </button>
      </header>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {editing && (
        <PronunciationForm
          key={editing.id ?? 'new'}
          business={props.business}
          initial={editing}
          onSaved={() => {
            setEditing(null);
            load();
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      <label className="field pron-filter">
        <span>Find</span>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search terms" />
      </label>
      {a.error && (
        <p className="field-error small" role="alert">
          {a.error}
        </p>
      )}
      {shown.length ? (
        <table className="analytics-table pron-table">
          <thead>
            <tr>
              <th scope="col">Written</th>
              <th scope="col">Said as</th>
              <th scope="col">Applies to</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => (
              <tr key={e.id}>
                <td>
                  <strong>{e.term}</strong>
                  {e.context && <div className="muted small">{e.context}</div>}
                </td>
                <td>
                  {e.say}
                  {Object.entries(e.engineSay).map(([en, s]) => (
                    <div key={en} className="muted small">
                      {ENGINE_LABEL[en as PreviewEngine]}: {s}
                    </div>
                  ))}
                </td>
                <td>{e.businessId === null ? 'Every business' : props.business.name}</td>
                <td className="pron-actions">
                  <button className="ghost small-btn" disabled={!!a.busy} onClick={() => void a.listen(`l${e.id}`, { text: sentenceFor(e.term, '') })}>
                    {a.busy === `l${e.id}` ? '…' : 'Listen'}
                  </button>
                  <button className="ghost small-btn" onClick={() => setEditing(e)}>
                    Edit
                  </button>
                  <button
                    className="ghost small-btn danger"
                    onClick={() => {
                      if (window.confirm(`Delete the pronunciation for “${e.term}”${e.businessId === null ? ' for every business' : ''}?`)) void window.api.deletePronunciation(e.id).then(load, (err) => setError(clean(err)));
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No entries{filter ? ' match' : ' yet'}. Omnicore's built-in list (e.g. NVIDIA, CUDA, GPT) still applies.</p>
      )}
    </section>
  );
}
