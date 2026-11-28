import type { FailureInfo, FailureKind } from '../../shared/failures';
import { InvalidStoryboardError } from '../providers/text';
import { NoRecentNewsError } from '../research/engine';

/** An error that carries its own failure classification. Throw this wherever a failure's nature is known. */
export class ProductionFailure extends Error implements FailureInfo {
  constructor(
    readonly kind: FailureKind,
    readonly code: string,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'ProductionFailure';
  }
}

/**
 * Classify a thrown error by its type. Untyped errors are 'transient' (retried with back-off and bounded by the
 * attempt limit), so an unknown failure is never silently made permanent.
 */
export function classifyFailure(e: unknown, cancelled = false): FailureInfo {
  if (cancelled) return { kind: 'cancelled', code: 'cancelled' };
  if (e instanceof ProductionFailure) return { kind: e.kind, code: e.code };
  if (e instanceof InvalidStoryboardError) return { kind: 'writer', code: 'invalid-script' };
  if (e instanceof NoRecentNewsError) return { kind: 'content', code: 'no-news-coverage' };
  return { kind: 'transient', code: 'error' };
}
