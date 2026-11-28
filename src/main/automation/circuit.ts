/**
 * Circuit breakers for services automation depends on (the script writer, ComfyUI, narration). After `threshold`
 * consecutive failures a breaker opens: automation stops sending work to that service until `cooldownMs` has passed,
 * then lets one attempt through (half-open). A success closes it. State changes are reported through onChange.
 */
import type { BreakerState, BreakerStatus } from '../../shared/automation';

export class CircuitBreakers {
  private readonly s = new Map<string, { failures: number; openedAt: number | null; lastError: string }>();
  constructor(
    private readonly opts: () => { threshold: number; cooldownMs: number },
    private readonly onChange?: (service: string, state: BreakerState, detail: string) => void,
    private readonly now: () => number = Date.now
  ) {}

  private entry(service: string) {
    let e = this.s.get(service);
    if (!e) this.s.set(service, (e = { failures: 0, openedAt: null, lastError: '' }));
    return e;
  }

  state(service: string): BreakerState {
    const e = this.entry(service);
    if (e.openedAt === null) return 'closed';
    return this.now() - e.openedAt >= this.opts().cooldownMs ? 'half-open' : 'open';
  }

  /** May automation send work to this service now? (A half-open breaker allows one trial.) */
  allows(service: string): boolean {
    return this.state(service) !== 'open';
  }

  success(service: string): void {
    const e = this.entry(service);
    const was = this.state(service);
    e.failures = 0;
    e.openedAt = null;
    if (was !== 'closed') this.onChange?.(service, 'closed', 'service recovered');
  }

  failure(service: string, error: string): void {
    const e = this.entry(service);
    const was = this.state(service);
    e.failures++;
    e.lastError = error.slice(0, 300);
    if (was === 'half-open' || (was === 'closed' && e.failures >= this.opts().threshold)) {
      e.openedAt = this.now();
      this.onChange?.(service, 'open', `${e.failures} consecutive failures: ${e.lastError}`);
    }
  }

  status(): BreakerStatus[] {
    return [...this.s.entries()].map(([service, e]) => ({ service, state: this.state(service), failures: e.failures, lastError: e.lastError, openedAt: e.openedAt ? new Date(e.openedAt).toISOString() : null }));
  }
}
