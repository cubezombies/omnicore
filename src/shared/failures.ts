/**
 * Why a production failed, decided where the failure happens (never by matching the wording of the message).
 *  - content:   the story itself cannot be made (no sources, not enough evidence, no news coverage). Retrying the
 *               same topic gives the same result, so it is not retried.
 *  - rights:    a sound or asset is not cleared for a destination. Needs a human decision; not retried.
 *  - writer:    the script writer (local LLM) was down, unloaded, errored or returned a script that failed
 *               validation. Retried once the writer answers again.
 *  - transient: anything else (network, disk, a provider error). Retried with back-off, up to the attempt limit.
 *  - audio:     the soundtrack or mix failed the mandatory audio gate (missing, inaudible or unbalanced music, missing
 *               narration). The same inputs give the same result, so it is not retried; fix the soundtrack or mix.
 *  - unsafe:    the production is in an inconsistent or unsafe state (e.g. a job and the production disagree after a
 *               crash, or a stalled job). Needs a person to look at it; not retried automatically.
 *  - cancelled: stopped by you or by closing the app. Resumable.
 */
export type FailureKind = 'content' | 'rights' | 'audio' | 'unsafe' | 'writer' | 'transient' | 'cancelled';

export interface FailureInfo {
  kind: FailureKind;
  /** Stable machine code, e.g. 'insufficient-evidence', 'writer-unavailable', 'invalid-script'. */
  code: string;
}

/** Failures that will happen again on retry: the scheduler never retries these automatically. */
export const PERMANENT_KINDS: ReadonlySet<FailureKind> = new Set(['content', 'rights', 'audio', 'unsafe']);

export const isRetryable = (f: FailureInfo | null | undefined): boolean => !f || !PERMANENT_KINDS.has(f.kind);
