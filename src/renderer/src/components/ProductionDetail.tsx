import { useState } from 'react';
import {
  CLAIM_KIND_LABELS,
  SOURCE_KIND_LABELS,
  PRODUCTION_STEPS,
  STEP_LABELS,
  mediaUrl,
  type Production,
  type ProductionStep,
  type StepName
} from '../../../shared/production';

export const errorText = (e: unknown) =>
  String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export const usd = (n: number) => `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;

const STATUS_LABEL: Record<Production['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  failed: 'Failed',
  completed: 'Ready',
  cancelled: 'Cancelled'
};

export function StatusBadge({ status }: { status: Production['status'] }) {
  return <span className={`badge prod-${status}`}>{STATUS_LABEL[status]}</span>;
}

function StepRow({ s }: { s: ProductionStep }) {
  return (
    <li className={`step step-${s.status}`}>
      <span className="step-dot" aria-hidden="true" />
      <div className="step-body">
        <div className="step-head">
          <strong>{STEP_LABELS[s.step]}</strong>
          <span className="muted small">
            {s.status}
            {s.attempts > 1 ? ` · attempt ${s.attempts}` : ''}
            {s.costUsd > 0 ? ` · ${usd(s.costUsd)}` : ''}
          </span>
        </div>
        {s.status === 'running' && (
          <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(s.progress * 100)} aria-label={`${STEP_LABELS[s.step]} progress`}>
            <div className="meter-fill" style={{ width: `${Math.round(s.progress * 100)}%` }} />
          </div>
        )}
        {s.detail && <span className="small muted">{s.detail}</span>}
        {s.error && <span className="small field-error">{s.error}</span>}
      </div>
    </li>
  );
}

export function ProductionDetail({ production: p, onDeleted }: { production: Production; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rerunFrom, setRerunFrom] = useState<StepName>('render');
  const active = p.status === 'running' || p.status === 'queued';
  const video = p.assets.find((a) => a.kind === 'video');
  const imageFor = (i: number) => p.assets.find((a) => a.kind === 'image' && a.sceneIndex === i);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="production" aria-labelledby={`prod-${p.id}`}>
      <header className="prod-head">
        <div>
          <h2 id={`prod-${p.id}`}>{p.storyboard?.title ?? p.topic}</h2>
          <p className="muted small">
            #{p.id} · {p.topic} · cost {usd(p.costUsd)}
            {p.durationSec ? ` · ${p.durationSec.toFixed(1)}s` : ''}
          </p>
        </div>
        <StatusBadge status={p.status} />
      </header>

      {p.error && (
        <div className="banner error" role="alert">
          {p.error}
        </div>
      )}
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}

      <div className="prod-actions">
        {active && (
          <button className="secondary" disabled={busy} onClick={() => act(() => window.api.cancelProduction(p.id))}>
            Cancel
          </button>
        )}
        {(p.status === 'failed' || p.status === 'cancelled') && (
          <button className="primary" disabled={busy} onClick={() => act(() => window.api.retryProduction(p.id))}>
            Retry from {p.steps.find((s) => s.status !== 'done') ? STEP_LABELS[p.steps.find((s) => s.status !== 'done')!.step] : 'start'}
          </button>
        )}
        {!active && (
          <span className="rerun">
            <select aria-label="Re-run from step" value={rerunFrom} onChange={(e) => setRerunFrom(e.target.value as StepName)}>
              {PRODUCTION_STEPS.map((s) => (
                <option key={s} value={s}>
                  {STEP_LABELS[s]}
                </option>
              ))}
            </select>
            <button className="secondary" disabled={busy} onClick={() => act(() => window.api.rerunProduction(p.id, rerunFrom))}>
              Re-run from here
            </button>
          </span>
        )}
        <span className="spacer" />
        {p.outputPath && (
          <button className="secondary" onClick={() => act(() => window.api.showProductionFile(p.id))}>
            Show MP4 in folder
          </button>
        )}
        <button
          className="danger"
          disabled={busy}
          onClick={() => window.confirm(`Delete production #${p.id} and its files?`) && act(async () => (await window.api.deleteProduction(p.id), onDeleted()))}
        >
          Delete
        </button>
      </div>

      <div className="prod-grid">
        <section aria-label="Pipeline steps">
          <ol className="steps">
            {p.steps.map((s) => (
              <StepRow key={s.step} s={s} />
            ))}
          </ol>
        </section>
        <section aria-label="Preview" className="preview">
          {video ? (
            <video key={p.updatedAt} controls preload="metadata" src={mediaUrl(p.id, video.path, p.updatedAt)} />
          ) : (
            <div className="preview-empty muted small">{active ? 'The preview appears when rendering finishes.' : 'No video rendered yet.'}</div>
          )}
        </section>
      </div>

      {p.storyboard && (
        <section>
          <h3>Storyboard</h3>
          <ol className="scenes">
            {p.storyboard.scenes.map((s) => {
              const img = imageFor(s.index);
              return (
                <li key={s.index} className="scene">
                  {img ? <img src={mediaUrl(p.id, img.path, String(img.id))} alt={`Scene ${s.index + 1} visual`} /> : <div className="scene-ph" />}
                  <div>
                    <span className="muted small">
                      Scene {s.index + 1} · {s.role}
                      {s.claimIds?.length ? ` · states ${s.claimIds.join(', ')}` : ''}
                      {s.sourceIds.length ? ` · cites ${s.sourceIds.join(', ')}` : ''}
                    </span>
                    <p className="scene-text">{s.narration}</p>
                    {img && <span className="muted small">{img.attribution}</span>}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {p.brief?.claims && p.brief.claims.length > 0 && (
        <section>
          <h3>Evidence claims</h3>
          <ul className="claims">
            {p.brief.claims.map((c) => (
              <li key={c.id}>
                <strong>{c.id}</strong> <span className={`badge claim-${c.kind}`}>{CLAIM_KIND_LABELS[c.kind]}</span>{' '}
                <span className="muted small">
                  {c.kind === 'confirmed' ? '' : `${c.attribution} · `}sources {c.sourceIds.join(', ')} · {c.independentSources} independent
                </span>
                <div className="small">{c.text}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {p.sources.length > 0 && (
        <section>
          <h3>Sources</h3>
          <ul className="sources">
            {p.sources.map((s) => (
              <li key={s.id}>
                <strong>{s.id}</strong>{' '}
                {s.url ? (
                  <a href={s.url} target="_blank" rel="noreferrer">
                    {s.title}
                  </a>
                ) : (
                  s.title
                )}{' '}
                <span className="muted small">
                  ({[s.publisher, s.kind ? SOURCE_KIND_LABELS[s.kind] : '', s.authors?.slice(0, 2).join(', '), s.publishedAt?.slice(0, 10), s.contentLevel === 'abstract' ? 'abstract only' : s.contentLevel === 'summary' ? 'summary only' : '']
                    .filter(Boolean)
                    .join(' · ')}
                  {s.derivedFrom ? ` · repeats ${s.derivedFrom}` : ''})
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
