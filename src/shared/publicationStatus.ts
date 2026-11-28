import type { Platform, Publication } from './operations';

/**
 * Publication status, derived only from what the destination reported and what the user recorded.
 * An upload response alone never counts as published; only the platform's confirmation does.
 */
export type PublicationState = 'needs_fixes' | 'ready_for_review' | 'approved' | 'uploading' | 'uploaded' | 'published' | 'private' | 'failed' | 'deleted';

export const PUBLICATION_STATE_LABELS: Record<PublicationState, string> = {
  needs_fixes: 'Needs fixes before approval',
  ready_for_review: 'Ready for review',
  approved: 'Approved',
  uploading: 'Uploading',
  uploaded: 'Uploaded',
  published: 'Published',
  private: 'Private',
  failed: 'Failed',
  deleted: 'Deleted'
};

/** What each state means, for tooltips and screen readers. */
export const PUBLICATION_STATE_HELP: Record<PublicationState, string> = {
  needs_fixes: 'The latest QA run failed; it cannot be approved until the issues are fixed and QA passes.',
  ready_for_review: 'QA passed; awaiting your approval.',
  approved: 'You approved it; it has not been uploaded.',
  uploading: 'The upload is in progress.',
  uploaded: 'The platform accepted the upload but has not confirmed publication.',
  published: 'The platform confirmed it is published and publicly visible.',
  private: 'The platform confirmed it is published with restricted visibility (for example TikTok "Only me").',
  failed: 'The upload or publication failed.',
  deleted: 'It was published and later deleted (recorded by you or confirmed by the platform).'
};

/** Visibility values that mean anyone can see the post. Everything else that is published is "private". */
const PUBLIC = new Set(['PUBLIC_TO_EVERYONE', 'public']);

/** Human visibility for a platform privacy value. */
export function visibilityLabel(v: string): string {
  const map: Record<string, string> = {
    PUBLIC_TO_EVERYONE: 'Public',
    public: 'Public',
    SELF_ONLY: 'Only me (private)',
    private: 'Private',
    MUTUAL_FOLLOW_FRIENDS: 'Friends only',
    FOLLOWER_OF_CREATOR: 'Followers only',
    unlisted: 'Unlisted'
  };
  return v ? (map[v] ?? v) : 'Not reported';
}

/** The state of one publication attempt. */
export function publicationState(p: Pick<Publication, 'status' | 'privacyApplied' | 'deletedAt'>): PublicationState {
  if (p.deletedAt) return 'deleted';
  if (p.status === 'uploading') return 'uploading';
  if (p.status === 'processing') return 'uploaded';
  if (p.status === 'failed') return 'failed';
  return PUBLIC.has(p.privacyApplied) ? 'published' : 'private';
}

export interface DestinationStatus {
  platform: Platform;
  handle: string | null;
  state: PublicationState | null;
  /** The attempt the state comes from (the latest one for this destination), if any. */
  publication: Publication | null;
  attempts: number;
}

/**
 * Status per destination: the latest attempt decides; before any attempt, the approval does
 * (awaiting review with passed QA → "Ready for review", awaiting review with failed or missing QA → "Needs fixes",
 * approved → "Approved"). Null = still in production.
 */
export function destinationStatuses(
  p: { status: string; approval: string; destinations: { platform: Platform; handle?: string | null }[] },
  pubs: Publication[],
  /** Status of the latest QA run; anything but 'passed' turns "Ready for review" into "Needs fixes". */
  lastQaStatus?: string | null
): DestinationStatus[] {
  return p.destinations.map((d) => {
    const mine = pubs.filter((x) => x.platform === d.platform).sort((a, b) => a.id - b.id);
    const latest = mine.at(-1) ?? null;
    let state: PublicationState | null = latest ? publicationState(latest) : null;
    const byApproval = p.status === 'completed' ? (p.approval === 'approved' ? 'approved' : p.approval === 'awaiting_review' ? (lastQaStatus === 'passed' ? 'ready_for_review' : 'needs_fixes') : null) : null;
    // Before any attempt the approval decides; after a deleted post, a corrected render shows its own approval state
    // (the deleted attempt stays in the history).
    if (!latest || (state === 'deleted' && byApproval)) state = byApproval ?? state;
    return { platform: d.platform, handle: d.handle ?? null, state, publication: latest, attempts: mine.length };
  });
}
