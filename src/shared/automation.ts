/** Who started a production-affecting action. */
export type JobInitiator = 'user' | 'scheduler' | 'automation' | 'agent' | 'recovery' | 'system';
export type JobKind = 'produce' | 'retry' | 'rerun' | 'revoice';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'stalled' | 'expired';

export interface ProductionJob {
  id: number;
  productionId: number | null;
  productionNumber: number;
  businessId: number | null;
  kind: JobKind;
  fromStep: string | null;
  initiator: JobInitiator;
  status: JobStatus;
  reason: string;
  error: string;
  failureKind: string;
  createdAt: string;
  startedAt: string | null;
  heartbeatAt: string | null;
  finishedAt: string | null;
}

/** A snapshot of a production's state, recorded before and after every action. */
export interface ProductionStateSnapshot {
  status: string;
  step: string | null;
  approval: string;
}

/** The data of a `production.action` audit event (one per production-affecting action). */
export interface ProductionActionEvent {
  action: 'queue' | 'retry' | 'rerun' | 'revoice' | 'start' | 'complete' | 'fail' | 'cancel' | 'interrupt' | 'stall' | 'expire' | 'approve' | 'reject' | 'delete' | 'refuse';
  initiator: JobInitiator;
  outcome: 'requested' | 'started' | 'succeeded' | 'failed' | 'cancelled' | 'refused';
  stage: string | null;
  jobId: number | null;
  previous: ProductionStateSnapshot | null;
  resulting: ProductionStateSnapshot | null;
  error?: string;
  failureKind?: string;
  reason?: string;
}

/** Retry, stall and expiry limits for automated work (Operations settings). */
export interface ReliabilitySettings {
  maxAutomaticRetries: number;
  retryBackoffMinutes: number;
  stallMinutes: number;
  queuedExpiryHours: number;
  circuitFailureThreshold: number;
  circuitCooldownMinutes: number;
}

export const DEFAULT_RELIABILITY: ReliabilitySettings = {
  maxAutomaticRetries: 3,
  retryBackoffMinutes: 10,
  stallMinutes: 20,
  queuedExpiryHours: 24,
  circuitFailureThreshold: 3,
  circuitCooldownMinutes: 15
};

/** Failure kinds that stop automation for the business until you review them (gates, never retried). */
export const HALTING_FAILURES = ['content', 'rights', 'audio', 'unsafe'] as const;

export interface AutomationHalt {
  reason: string;
  productionId: number | null;
  failureKind: string;
  at: string;
}

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerStatus {
  service: string;
  state: BreakerState;
  failures: number;
  lastError: string;
  openedAt: string | null;
}

