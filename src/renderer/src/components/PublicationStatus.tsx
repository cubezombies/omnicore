import { useState } from 'react';
import type { Publication } from '../../../shared/operations';
import { PUBLICATION_STATE_HELP, PUBLICATION_STATE_LABELS, publicationState, visibilityLabel, type DestinationStatus, type PublicationState } from '../../../shared/publicationStatus';
import { errorText } from './ProductionDetail';

const PLATFORM_LABEL: Record<string, string> = { tiktok: 'TikTok', youtube: 'YouTube', instagram: 'Instagram' };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

/** One unmistakable status badge: distinct colour, label text and (for deleted) a struck-through outline style. */
export function PublicationBadge({ state, prefix }: { state: PublicationState; prefix?: string }) {
  return (
    <span className={`badge pub-badge pub-${state}`} title={PUBLICATION_STATE_HELP[state]} aria-label={`${prefix ? `${prefix}: ` : ''}${PUBLICATION_STATE_LABELS[state]}. ${PUBLICATION_STATE_HELP[state]}`}>
      {prefix ? `${prefix} · ` : ''}
      {PUBLICATION_STATE_LABELS[state]}
    </span>
  );
}

/** Badges for each destination that has a status (Content Library rows, Studio list). */
export function DestinationBadges({ statuses }: { statuses: DestinationStatus[] }) {
  const shown = statuses.filter((s) => s.state);
  if (!shown.length) return null;
  return (
    <span className="pub-badges">
      {shown.map((s) => (
        <PublicationBadge key={s.platform} state={s.state!} prefix={PLATFORM_LABEL[s.platform] ?? s.platform} />
      ))}
    </span>
  );
}

/**
 * Every publication attempt for a production, newest first, with upload, publication, failure and deletion details.
 * Records are never overwritten: a corrected render is a new attempt.
 */
export function PublicationHistory({ pubs, onChanged }: { pubs: Publication[]; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  if (!pubs.length) return null;
  async function recordDeletion(x: Publication) {
    const note = window.prompt(`Record that this ${PLATFORM_LABEL[x.platform] ?? x.platform} post (${x.remoteId || 'no post ID'}) was deleted on the platform?\n\nOptional note (for example "removed in the TikTok app"):`, '');
    if (note === null) return;
    setError(null);
    try {
      await window.api.recordPublicationDeletion(x.id, note);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <div className="pub-history">
      <h4>Publication history</h4>
      {error && <p className="field-error small" role="alert">{error}</p>}
      <ul className="pub-attempts">
        {[...pubs].sort((a, b) => b.id - a.id).map((x) => {
          const state = publicationState(x);
          return (
            <li key={x.id} className={`pub-attempt pub-attempt-${state}`}>
              <div className="pub-attempt-head">
                <PublicationBadge state={state} />
                <strong>{PLATFORM_LABEL[x.platform] ?? x.platform}</strong>
                <span className="muted small">{x.accountHandle || 'account not recorded'} · attempt #{x.id}</span>
              </div>
              <dl className="pub-facts small">
                <dt>Visibility</dt>
                <dd>{visibilityLabel(x.privacyApplied)}{x.privacyRequested && x.privacyRequested !== x.privacyApplied ? ` (requested ${visibilityLabel(x.privacyRequested)})` : ''}</dd>
                <dt>Upload started</dt>
                <dd>{when(x.createdAt)}</dd>
                <dt>Uploaded</dt>
                <dd>{when(x.uploadedAt)}</dd>
                <dt>Published</dt>
                <dd>{x.publishedAt ? when(x.publishedAt) : x.status === 'processing' ? 'not confirmed by the platform yet' : '—'}</dd>
                {x.failedAt && (
                  <>
                    <dt>Failed</dt>
                    <dd>{when(x.failedAt)}</dd>
                  </>
                )}
                <dt>Post ID</dt>
                <dd className="mono">{x.remoteId || '—'}</dd>
                <dt>Link</dt>
                <dd>{x.url ? <a href={x.url} target="_blank" rel="noreferrer">{x.url}</a> : x.status === 'published' ? 'no public link (restricted visibility)' : '—'}</dd>
                {x.deletedAt && (
                  <>
                    <dt>Deleted</dt>
                    <dd>
                      {when(x.deletedAt)} · {x.deletionSource === 'platform' ? 'confirmed by the platform' : 'recorded by you'}
                      {x.deletionNote ? ` · “${x.deletionNote}”` : ''}
                      {x.publishedAt ? ` · originally published ${when(x.publishedAt)}` : ''}
                    </dd>
                  </>
                )}
                {x.renderSha256 && (
                  <>
                    <dt>Video file</dt>
                    <dd className="mono" title={x.renderSha256}>{x.renderSha256.slice(0, 12)}…</dd>
                  </>
                )}
                {x.restoredFrom && (
                  <>
                    <dt>Record</dt>
                    <dd>restored from the audit log ({x.restoredFrom})</dd>
                  </>
                )}
              </dl>
              {x.detail && <p className="muted small">{x.detail}</p>}
              {!x.deletedAt && (x.status === 'published' || x.status === 'processing') && (
                <button className="ghost small-btn" onClick={() => void recordDeletion(x)}>
                  Record deletion…
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
