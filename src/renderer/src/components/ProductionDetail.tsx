import { useEffect, useState } from 'react';
import type { Platform, Publication, QaRun, TikTokPostOptions } from '../../../shared/operations';
import { TikTokPostDialog } from './TikTokPostDialog';
import { PronunciationPanel } from './PronunciationPanel';
import type { Business } from '../../../shared/business';
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

export function ProductionDetail({ production: p, onDeleted, business }: { production: Production; onDeleted: () => void; business?: Business }) {
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

      {p.storyboard && business && <PronunciationPanel production={p} business={business} />}

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

      <ReadinessPanel production={p} />

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

const APPROVAL_LABEL: Record<string, string> = {
  none: 'Not checked yet',
  awaiting_review: 'Ready for your review',
  approved: 'Approved by you',
  rejected: 'Rejected by you',
  blocked: 'Blocked by QA (critical failure)'
};

/** Destinations, QA history, platform metadata and the approval gate for one production. */
function ReadinessPanel({ production: p }: { production: Production }) {
  const [runs, setRuns] = useState<QaRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [exported, setExported] = useState<string | null>(null);
  const [pubs, setPubs] = useState<Publication[]>([]);
  const [blockers, setBlockers] = useState<Record<string, string[]>>({});
  const [publishing, setPublishing] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [ttOpen, setTtOpen] = useState(false);
  const video = p.assets.find((a) => a.kind === 'video');
  useEffect(() => {
    void window.api.qaRuns(p.id).then(setRuns);
    void window.api.publications(p.id).then(setPubs);
    void window.api.publishBlockers(p.id).then(setBlockers);
  }, [p.id, p.updatedAt, tick]);
  const last = runs.at(-1);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const meta = Object.values(p.metadata ?? {});
  const postTikTok = async (o: TikTokPostOptions) => {
    setPublishing('tiktok');
    setError(null);
    try {
      await window.api.publishProduction(p.id, 'tiktok', o);
      setTtOpen(false);
    } catch (e) {
      setError(errorText(e));
      setTtOpen(false);
    } finally {
      setPublishing(null);
      setTick((x) => x + 1);
    }
  };
  const publish = async (platform: Platform) => {
    if (platform === 'tiktok') return setTtOpen(true);
    const d = p.destinations.find((x) => x.platform === platform);
    if (d?.privacy === 'public' && !window.confirm(`Publish this video PUBLICLY to ${d.handle} on ${platform}? Anyone will be able to see it.`)) return;
    setPublishing(platform);
    await act(() => window.api.publishProduction(p.id, platform));
    setPublishing(null);
    setTick((x) => x + 1);
  };
  return (
    <section className="readiness">
      <h3>Publication readiness</h3>
      <p className="small">
        <span className={`badge ${p.approval === 'blocked' ? 'prod-failed' : p.approval === 'approved' ? 'prod-completed' : 'prod-queued'}`}>{APPROVAL_LABEL[p.approval] ?? p.approval}</span>{' '}
        <span className="muted">{p.origin === 'autonomous' ? 'Created autonomously' : 'Created manually'} · publishing: {p.publishStatus.replace('_', ' ')}</span>
      </p>
      {error && <p className="field-error small" role="alert">{error}</p>}
      <ul className="sources">
        {p.destinations.map((d) => (
          <li key={d.platform}>
            <strong>{d.platform}</strong> → {d.handle ?? 'no account assigned'} ({d.privacy}){d.blockers.length ? <span className="field-error small"> · cannot publish yet: {d.blockers.join(' ')}</span> : <span className="muted small"> · ready</span>}
          </li>
        ))}
        {!p.destinations.length && <li className="muted small">No destination assigned.</li>}
      </ul>
      {last && (
        <details open={last.status !== 'passed'}>
          <summary>
            QA round {last.round}: <strong>{last.status}</strong> · {last.summary.checks} checks · {last.summary.critical} critical, {last.summary.major} major, {last.summary.minor} minor
            {runs.length > 1 ? ` · ${runs.length} rounds (repairs: ${runs.flatMap((r) => r.summary.repairs).join(', ') || 'none'})` : ''}
          </summary>
          <ul className="qa-list">
            {last.findings.map((f) => (
              <li key={f.checkId} className={f.passed ? 'qa-pass' : `qa-fail qa-${f.severity}`}>
                <span className="qa-mark">{f.passed ? '✓' : '✕'}</span> <span className="muted small">{f.category} · {f.severity}</span> {f.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      {pubs.length > 0 && (
        <ul className="sources">
          {pubs.map((x) => (
            <li key={x.id}>
              <strong>{x.platform}</strong>: {x.status}{x.privacyApplied ? ` (${x.privacyApplied})` : ''} {x.url && <a href={x.url} target="_blank" rel="noreferrer">{x.url}</a>} <span className="muted small">{x.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {p.approval === 'approved' && Object.entries(blockers).some(([, b]) => b.length) && (
        <ul className="muted small">
          {Object.entries(blockers).filter(([, b]) => b.length).map(([pl, b]) => <li key={pl}>{pl}: {b.join(' ')}</li>)}
        </ul>
      )}
      {ttOpen && (
        <TikTokPostDialog
          productionId={p.id}
          videoUrl={video ? mediaUrl(p.id, video.path, p.updatedAt) : null}
          durationSec={p.durationSec}
          caption={p.metadata?.tiktok?.caption ?? ''}
          onPost={postTikTok}
          onClose={() => setTtOpen(false)}
        />
      )}
      {publishing && (
        <p className="small" role="status">
          <span className="spinner" aria-hidden="true" /> Uploading to {publishing} and waiting for {publishing} to confirm the post. This usually takes under two minutes; keep Omnicore open.
        </p>
      )}
      {p.approval === 'approved' && !publishing && p.publishStatus === 'not_published' && Object.values(blockers).some((b) => b.length === 0) && (
        <p className="small">Approved. Click <strong>Publish</strong> below to post it; approving alone never publishes.</p>
      )}
      {meta.map((m) => (
        <details key={m.platform}>
          <summary>{m.platform} metadata</summary>
          <p className="small"><strong>{m.title}</strong></p>
          <pre className="meta-caption">{m.caption}</pre>
          {m.manualSteps.length > 0 && <ul className="muted small">{m.manualSteps.map((s) => <li key={s}>{s}</li>)}</ul>}
        </details>
      ))}
      <div className="prod-actions">
        {p.approval === 'awaiting_review' && (
          <>
            <input aria-label="Approval note" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="primary" onClick={() => act(() => window.api.approveProduction(p.id, note)).then(() => setTick((x) => x + 1))}>Approve for publication</button>
            <button className="danger" onClick={() => act(() => window.api.rejectProduction(p.id, note)).then(() => setTick((x) => x + 1))}>Reject</button>
          </>
        )}
        {p.approval === 'approved' &&
          p.destinations.map((d) => (
            <button key={d.platform} className="primary" disabled={publishing !== null || (blockers[d.platform]?.length ?? 1) > 0} title={(blockers[d.platform] ?? []).join(' ')} onClick={() => void publish(d.platform)}>
              {publishing === d.platform ? `Publishing to ${d.platform}…` : d.platform === 'tiktok' ? 'Post to TikTok…' : `Publish to ${d.platform} (${d.privacy})`}
            </button>
          ))}
        <button className="secondary" onClick={() => act(() => window.api.runQa(p.id))}>Re-run QA</button>
        <button className="secondary" onClick={() => act(async () => setExported(await window.api.exportAudit(p.id)))}>Export audit report</button>
        {exported && <span className="muted small">Saved {exported}</span>}
      </div>
    </section>
  );
}
