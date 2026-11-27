import { useCallback, useEffect, useState } from 'react';
import type { Business } from '../../../shared/business';
import type { Production, PronunciationFinding } from '../../../shared/production';
import { PronunciationForm } from '../pages/Pronunciation';
import { useAudition } from './pronunciationAudio';

const clean = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const STATUS: Record<PronunciationFinding['status'], string> = { uncertain: 'Check', rule: 'Rule', builtin: 'Built-in', dictionary: 'Dictionary' };

/** The sentence in a scene that contains a term, for hearing it in context. */
function sentenceWith(p: Production, f: PronunciationFinding): string {
  const text = p.storyboard?.scenes.find((s) => s.index === f.scenes[0])?.narration ?? f.term;
  return (text.match(/[^.!?]+[.!?]?/g) ?? [text]).find((s) => s.includes(f.term))?.trim() ?? text;
}

/** Pronunciation check for one production: hear each term in context, correct it, re-voice only affected scenes. */
export function PronunciationPanel(props: { production: Production; business: Business }) {
  const p = props.production;
  const [findings, setFindings] = useState<PronunciationFinding[]>([]);
  const [fixing, setFixing] = useState<PronunciationFinding | null>(null);
  const [changed, setChanged] = useState<number[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const a = useAudition();

  const load = useCallback(() => {
    window.api.pronunciationReport(p.id).then(setFindings, (e) => setError(clean(e)));
  }, [p.id]);
  useEffect(load, [load, p.storyboard]);

  const unsure = findings.filter((f) => f.status === 'uncertain');
  const shown = showAll ? findings : unsure;
  const busy = p.status === 'running' || p.status === 'queued';
  return (
    <section className="card">
      <h3>Pronunciation check</h3>
      <p className="muted small">
        {findings.length} names and technical terms · {unsure.length ? `${unsure.length} not in the dictionary yet` : 'all known'}. Captions always show the written spelling.
      </p>
      {error && (
        <p className="field-error small" role="alert">
          {error}
        </p>
      )}
      {a.error && (
        <p className="field-error small" role="alert">
          {a.error}
        </p>
      )}
      {changed.length > 0 && (
        <div className="banner">
          Corrections saved. Re-voice scene{changed.length > 1 ? 's' : ''} {changed.map((s) => s + 1).join(', ')} to apply them (visuals and the other scenes are kept).{' '}
          <button
            className="secondary small-btn"
            disabled={busy}
            onClick={() =>
              void window.api.revoiceScenes(p.id, changed).then(
                () => setChanged([]),
                (e) => setError(clean(e))
              )
            }
          >
            Re-voice now
          </button>
        </div>
      )}
      {fixing && (
        <PronunciationForm
          business={props.business}
          initial={{ term: fixing.term, say: fixing.status === 'uncertain' ? '' : fixing.spoken, ...(fixing.entryId ? { id: fixing.entryId } : {}) }}
          example={sentenceWith(p, fixing)}
          onSaved={() => {
            setChanged((cur) => [...new Set([...cur, ...fixing.scenes])].sort((x, y) => x - y));
            setFixing(null);
            load();
          }}
          onCancel={() => setFixing(null)}
        />
      )}
      {shown.length > 0 && (
        <table className="analytics-table pron-table">
          <tbody>
            {shown.map((f) => (
              <tr key={f.term}>
                <td>
                  <strong>{f.term}</strong> <span className={`pill${f.status === 'uncertain' ? ' warn' : ''}`}>{STATUS[f.status]}</span>
                  <div className="muted small">
                    said “{f.spoken}” · scene {f.scenes.map((s) => s + 1).join(', ')}
                  </div>
                </td>
                <td className="pron-actions">
                  <button className="ghost small-btn" disabled={!!a.busy} onClick={() => void a.listen(f.term, { text: sentenceWith(p, f) })}>
                    {a.busy === f.term ? '…' : 'Listen in context'}
                  </button>
                  <button className="ghost small-btn" onClick={() => setFixing(f)}>
                    {f.status === 'uncertain' ? 'Set pronunciation' : 'Correct'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {findings.length > unsure.length && (
        <button className="ghost small-btn" onClick={() => setShowAll((s) => !s)}>
          {showAll ? 'Show only terms to check' : `Show all ${findings.length} terms`}
        </button>
      )}
    </section>
  );
}
