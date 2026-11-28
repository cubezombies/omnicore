import type { ApprovalState, QaFinding, QaRun } from './operations';
import { AUDIO_GATE_ID } from './audioMix';

/**
 * Where a production stands at the approval gate. Derived from the stored approval AND the latest QA run, so a
 * production whose last QA failed can never read "Ready for your review": it reads "Needs fixes before approval",
 * names the failing checks, and cannot be approved (the main process enforces the same rule).
 */
export type ReviewState = 'not_checked' | 'needs_fixes' | 'ready' | 'approved' | 'rejected' | 'blocked';

export interface ReviewGate {
  state: ReviewState;
  label: string;
  canApprove: boolean;
  /** Why approval is or is not possible, in plain words. */
  reason: string;
  /** The critical and major checks that failed in the latest QA run (the ones that stop approval). */
  failing: QaFinding[];
}

export const REVIEW_LABELS: Record<ReviewState, string> = {
  not_checked: 'Not checked yet',
  needs_fixes: 'Needs fixes before approval',
  ready: 'Ready for your review',
  approved: 'Approved by you',
  rejected: 'Rejected by you',
  blocked: 'Blocked by QA (critical failure)'
};

const blocking = (run: QaRun | undefined): QaFinding[] => (run?.findings ?? []).filter((f) => !f.passed && (f.severity === 'critical' || f.severity === 'major'));

export function reviewGate(approval: ApprovalState, lastQa: Pick<QaRun, 'status' | 'findings'> | undefined | null): ReviewGate {
  const run = lastQa ?? undefined;
  const failing = blocking(run as QaRun | undefined);
  const checks = failing.map((f) => f.message || f.checkId).join('; ');
  const make = (state: ReviewState, canApprove: boolean, reason: string): ReviewGate => ({ state, label: REVIEW_LABELS[state], canApprove, reason, failing });
  if (approval === 'approved') return make('approved', false, 'Approved. Approving never publishes; publishing is a separate step.');
  if (approval === 'rejected') return make('rejected', false, 'You rejected this video.');
  if (approval === 'blocked' || run?.status === 'blocked') return make('blocked', false, `Critical QA failure${checks ? `: ${checks}` : ''}. It cannot be approved; fix it and re-run QA.`);
  if (!run) return make(approval === 'awaiting_review' ? 'needs_fixes' : 'not_checked', false, 'QA has not run on this version. Run QA before approving.');
  if (run.status !== 'passed') return make('needs_fixes', false, `The latest QA run failed${checks ? `: ${checks}` : ''}. Fix ${failing.length === 1 ? 'it' : 'them'} and re-run QA; only a passed QA can be approved.`);
  // The mandatory audio gate: a QA run without a passed audio gate (including runs from before the gate) never approves.
  const audio = run.findings.find((f) => f.checkId === AUDIO_GATE_ID);
  if (!audio?.passed) return make('needs_fixes', false, audio ? `The audio gate failed: ${audio.message}` : 'This QA run predates the mandatory audio gate. Re-render the video and run QA again.');
  if (approval === 'awaiting_review') return make('ready', true, 'QA passed. Review the video, then approve or reject it.');
  return make('not_checked', false, 'Not checked yet.');
}

/** QA status for badges: 'passed' only when the run passed AND its mandatory audio gate passed. */
export const effectiveQaStatus = (run: Pick<QaRun, 'status' | 'findings'> | undefined | null): string | null =>
  !run ? null : run.status === 'passed' && !run.findings.some((f) => f.checkId === AUDIO_GATE_ID && f.passed) ? 'failed' : run.status;
