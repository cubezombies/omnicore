import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  LIMITS,
  STAGES,
  STAGE_LABELS,
  canTransition,
  nextStage,
  type ContentItem,
  type Stage
} from '../../../shared/domain';
import { StageBadge } from './ContentList';

interface Props {
  channelId: number;
  initial: ContentItem | null;
  onClose: () => void;
  onChanged: () => void;
}

const message = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function ContentEditor({ channelId, initial, onClose, onChanged }: Props) {
  const [item, setItem] = useState<ContentItem | null>(initial);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [researchNotes, setResearchNotes] = useState(initial?.researchNotes ?? '');
  const [script, setScript] = useState(initial?.script ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [produced, setProduced] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const dirty =
    !item ||
    title !== item.title ||
    summary !== item.summary ||
    researchNotes !== item.researchNotes ||
    script !== item.script;

  async function run(fn: () => Promise<ContentItem | void>) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const out = await fn();
      if (out) setItem(out);
      onChanged();
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (!title.trim()) {
      setError('Title is required.');
      return;
    }
    const fields = { title, summary, researchNotes, script };
    const ok = await run(() =>
      item ? window.api.updateContent(item.id, fields) : window.api.createContent(channelId, fields)
    );
    if (ok) setSaved(true);
  }

  async function move(to: Stage) {
    if (!item) return;
    if (dirty) await save();
    await run(() => window.api.moveContent(item.id, to));
  }

  async function produce() {
    if (!item) return;
    if (dirty) await save();
    try {
      const p = await window.api.createProduction(channelId, { topic: title.trim() || item.title, contentId: item.id });
      setProduced(`Production #${p.id} started. Follow it in Studio.`);
    } catch (e) {
      setError(message(e));
    }
  }

  async function remove() {
    if (!item || !window.confirm(`Delete "${item.title}"? This cannot be undone.`)) return;
    if (await run(() => window.api.deleteContent(item.id))) onClose();
  }

  const next = item ? nextStage(item.stage) : null;
  const backTargets = item ? STAGES.filter((s) => s !== item.stage && canTransition(item.stage, s) && s !== next) : [];

  return (
    <div className="overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="editor" role="dialog" aria-modal="true" aria-labelledby="editor-heading" onSubmit={save}>
        <header className="editor-head">
          <h2 id="editor-heading">{item ? 'Edit content' : 'New idea'}</h2>
          {item && <StageBadge stage={item.stage} />}
          <button type="button" className="ghost" onClick={onClose} aria-label="Close editor">
            Close
          </button>
        </header>

        {item && (
          <ol className="pipeline" aria-label="Workflow">
            {STAGES.map((s) => (
              <li key={s} className={s === item.stage ? 'current' : STAGES.indexOf(s) < STAGES.indexOf(item.stage) ? 'done' : ''}>
                {STAGE_LABELS[s]}
              </li>
            ))}
          </ol>
        )}

        <label className="field">
          <span>Title</span>
          <input ref={titleRef} value={title} maxLength={LIMITS.title} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        <label className="field">
          <span>Angle / summary</span>
          <textarea rows={2} value={summary} maxLength={LIMITS.summary} onChange={(e) => setSummary(e.target.value)} />
        </label>
        <label className="field">
          <span>Research notes</span>
          <textarea rows={5} value={researchNotes} maxLength={LIMITS.researchNotes} onChange={(e) => setResearchNotes(e.target.value)} />
        </label>
        <label className="field">
          <span>Script</span>
          <textarea rows={7} value={script} maxLength={LIMITS.script} onChange={(e) => setScript(e.target.value)} />
        </label>

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}

        <footer className="editor-foot">
          {item && (
            <button type="button" className="danger" onClick={remove} disabled={busy}>
              Delete
            </button>
          )}
          <span className="spacer" />
          {saved && !dirty && !produced && <span className="muted" role="status">Saved</span>}
          {produced && <span className="muted small" role="status">{produced}</span>}
          {item && (
            <button type="button" className="secondary" onClick={() => void produce()} disabled={busy} title="Research, script, voice and render a vertical video from this item">
              Produce video
            </button>
          )}
          {backTargets.length > 0 && (
            <select
              aria-label="Send back to stage"
              value=""
              disabled={busy}
              onChange={(e) => e.target.value && void move(e.target.value as Stage)}
            >
              <option value="">Send back to…</option>
              {backTargets.map((s) => (
                <option key={s} value={s}>
                  {STAGE_LABELS[s]}
                </option>
              ))}
            </select>
          )}
          {next && (
            <button type="button" className="secondary" onClick={() => void move(next)} disabled={busy}>
              Move to {STAGE_LABELS[next]}
            </button>
          )}
          <button type="submit" className="primary" disabled={busy || !dirty}>
            {item ? 'Save' : 'Create idea'}
          </button>
        </footer>
      </form>
    </div>
  );
}
