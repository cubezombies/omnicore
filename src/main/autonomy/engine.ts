import type { AuditLedger } from '../audit/ledger';
import type { OperationsRepository } from '../db/operations';
import type { ProductionRepository } from '../db/productions';
import type { ProductionRunner } from '../pipeline/runner';
import type { EngineStatus } from '../../shared/operations';
import type { DiscoveryResult } from './discovery';

export interface EngineDeps {
  ops: OperationsRepository;
  productions: ProductionRepository;
  runner: ProductionRunner;
  audit: AuditLedger;
  discover: (brandId: number, keywords: string[], recentTopics: string[], signal: AbortSignal) => Promise<DiscoveryResult>;
  now?: () => Date;
  tickMs?: number;
  onChange?: () => void;
}

/** What the operating engine cannot do on its own — shown in the UI so nobody assumes 24/7 operation. */
export const ENGINE_LIMITATIONS = [
  'Runs only while this computer is on, awake and online; sleep, shutdown or a lost connection pauses it.',
  'Keeps working with the window closed (system tray) — choosing Quit stops it.',
  'Local services it relies on (Strata, internet research sources) must be available; it retries later when they are not.',
  'It never spends money and never publishes publicly without your approval.'
];

const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 10 * 60_000;

/**
 * The autonomous operating engine. Lives in the main process (independent of any window):
 * discovers opportunities on a schedule, selects the best idea within limits and operating
 * hours, produces it with its brand destinations, retries failures and recovers after restarts.
 */
export class OperatingEngine {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private discovering: AbortController | null = null;
  private lastError: string | null = null;
  private stopped = true;

  constructor(private readonly d: EngineDeps) {}

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const interrupted = this.d.ops.markRunsInterrupted();
    if (interrupted) this.d.audit.record({ actor: 'engine', type: 'engine.recovered', data: { interruptedRuns: interrupted } });
    this.d.audit.record({ actor: 'engine', type: 'engine.started', data: { autonomy: this.d.ops.getAutonomy() } });
    this.timer = setInterval(() => void this.tick(), this.d.tickMs ?? 60_000);
    setTimeout(() => void this.tick(), 2_000);
  }

  /** Graceful shutdown: stop scheduling, abort discovery, and interrupt an autonomous production so it resumes next start. */
  async stop(reason = 'shutdown'): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.discovering?.abort();
    const active = this.d.ops.brandIds().flatMap((b) => this.d.productions.list(b)).find((p) => p.status === 'running' && p.origin === 'autonomous');
    if (active) this.d.runner.cancel(active.id);
    this.d.audit.record({ actor: 'engine', type: 'engine.stopped', data: { reason, interruptedProduction: active?.id ?? null } });
  }

  isRunning(): boolean {
    return !this.stopped;
  }

  /** One scheduling pass. Safe to call any time; re-entrant calls are ignored. */
  async tick(force = false): Promise<void> {
    if (this.ticking || (this.stopped && !force)) return;
    this.ticking = true;
    try {
      const s = this.d.ops.getAutonomy();
      if (!s.enabled && !force) return;
      for (const brandId of this.d.ops.brandIds()) {
        const last = this.d.ops.lastRun(`discovery:${brandId}`);
        const due = !last || this.now().getTime() - Date.parse(`${last.startedAt}Z`.replace('ZZ', 'Z')) >= s.discoveryEveryHours * 3600_000;
        if (due) await this.runDiscovery(brandId);
        this.retryFailed(brandId);
        this.maybeStartProduction(brandId);
      }
      this.lastError = null;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.d.audit.record({ actor: 'engine', type: 'engine.error', data: { error: this.lastError } });
    } finally {
      this.ticking = false;
      this.d.onChange?.();
    }
  }

  async runDiscovery(brandId: number): Promise<{ created: number; candidates: number }> {
    const s = this.d.ops.getAutonomy();
    const runId = this.d.ops.startRun(`discovery:${brandId}`);
    this.discovering = new AbortController();
    try {
      const keywords = this.d.ops.brandKeywords(brandId);
      const recent = this.d.ops.recentTopics(brandId, 21);
      const res = await this.d.discover(brandId, keywords, recent, this.discovering.signal);
      let created = 0;
      for (const c of res.candidates) {
        const { idea, created: isNew } = this.d.ops.upsertIdea({ brandId, topic: c.topic, headline: c.headline, mode: c.mode, signals: c.signals, score: c.score, scoreDetail: c.scoreDetail, fingerprint: c.fingerprint });
        if (isNew) {
          created++;
          this.d.audit.record({ actor: 'engine', type: 'idea.discovered', subjectType: 'idea', subjectId: idea.id, data: { topic: idea.topic, score: idea.score, detail: idea.scoreDetail, signals: idea.signals.map((x) => ({ url: x.url, publisher: x.publisher, kind: x.kind })) } });
        }
      }
      const pruned = this.d.ops.pruneIdeas(brandId, s.maxIdeasKept, 7);
      const detail = `${res.items} items · ${res.candidates.length} stories · ${created} new ideas · ${pruned} expired · sources: ${res.sourceReports.map((r) => `${r.id} ${r.ok ? r.items : `failed (${r.error})`}`).join(', ')}`;
      this.d.ops.finishRun(runId, 'done', detail);
      this.d.audit.record({ actor: 'engine', type: 'discovery.run', data: { brandId, items: res.items, stories: res.candidates.length, created, pruned, sources: res.sourceReports } });
      return { created, candidates: res.candidates.length };
    } catch (e) {
      this.d.ops.finishRun(runId, this.discovering.signal.aborted ? 'interrupted' : 'failed', e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      this.discovering = null;
    }
  }

  private withinHours(): boolean {
    const s = this.d.ops.getAutonomy();
    const h = this.now().getHours();
    return s.activeFromHour <= s.activeToHour ? h >= s.activeFromHour && h < s.activeToHour : h >= s.activeFromHour || h < s.activeToHour;
  }

  productionsToday(): number {
    const d = this.now();
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
    return this.d.ops.autonomousProductionsSince(start);
  }

  /** Editorial selection: start the best-scoring new idea if limits, hours and the queue allow. */
  maybeStartProduction(brandId: number): number | null {
    const s = this.d.ops.getAutonomy();
    if (!this.withinHours() || this.d.runner.busy() || this.productionsToday() >= s.maxProductionsPerDay) return null;
    const best = this.d.ops.listIdeas(brandId, 'new')[0];
    if (!best || best.score < s.minIdeaScore) return null;
    return this.produceIdea(best.id, 'engine', `highest-scoring idea (${best.score} ≥ ${s.minIdeaScore})`);
  }

  /** Turn an idea into a production with its brand's explicit destinations. Used by the engine and by "Produce now". */
  produceIdea(ideaId: number, actor: string, reason: string): number {
    const idea = this.d.ops.getIdea(ideaId);
    const destinations = this.d.ops.resolveDestinations(idea.brandId);
    const p = this.d.productions.create(idea.brandId, idea.topic, null, '', idea.mode, { origin: 'autonomous', ideaId: idea.id, destinations });
    this.d.ops.decideIdea(idea.id, 'selected', reason, p.id);
    this.d.audit.record({ actor, type: 'idea.selected', subjectType: 'idea', subjectId: idea.id, productionId: p.id, data: { topic: idea.topic, score: idea.score, reason } });
    this.d.audit.record({ actor, type: 'production.destination', productionId: p.id, data: { destinations } });
    this.d.runner.enqueue(p.id);
    return p.id;
  }

  /** Keep idea status in step with its production; retry transient failures a limited number of times. */
  retryFailed(brandId: number): void {
    for (const p of this.d.productions.list(brandId).filter((x) => x.origin === 'autonomous' && x.ideaId)) {
      const idea = this.d.ops.getIdea(p.ideaId!);
      if (p.status === 'completed' && idea.status === 'selected') {
        this.d.ops.decideIdea(idea.id, 'produced', `production ${p.id} completed (${p.approval})`);
        continue;
      }
      if ((p.status === 'failed' || p.status === 'cancelled') && idea.status === 'selected') {
        const failedStep = p.steps.find((st) => st.status === 'failed' || st.status === 'pending');
        const attempts = failedStep?.attempts ?? 0;
        const waited = this.now().getTime() - Date.parse(p.updatedAt) >= RETRY_AFTER_MS;
        if (attempts < MAX_ATTEMPTS && waited && !this.d.runner.busy()) {
          this.d.audit.record({ actor: 'engine', type: 'production.retry', productionId: p.id, data: { step: failedStep?.step, attempts, error: p.error } });
          this.d.runner.retry(p.id);
        } else if (attempts >= MAX_ATTEMPTS) {
          this.d.ops.decideIdea(idea.id, 'failed', `gave up after ${attempts} attempts: ${p.error}`);
          this.d.audit.record({ actor: 'engine', type: 'idea.failed', subjectType: 'idea', subjectId: idea.id, productionId: p.id, data: { error: p.error } });
        }
      }
    }
  }

  status(): EngineStatus {
    const s = this.d.ops.getAutonomy();
    const last = this.d.ops.brandIds().map((b) => this.d.ops.lastRun(`discovery:${b}`)).find(Boolean) ?? null;
    const lastAt = last ? new Date(Date.parse(`${last.startedAt}Z`.replace('ZZ', 'Z'))).toISOString() : null;
    const active = this.d.ops.brandIds().flatMap((b) => this.d.productions.list(b)).find((p) => p.status === 'running' || p.status === 'queued');
    return {
      enabled: s.enabled,
      running: this.isRunning(),
      lastDiscoveryAt: lastAt,
      nextDiscoveryAt: lastAt ? new Date(Date.parse(lastAt) + s.discoveryEveryHours * 3600_000).toISOString() : null,
      productionsToday: this.productionsToday(),
      activeProductionId: active?.id ?? null,
      lastError: this.lastError,
      limitations: ENGINE_LIMITATIONS
    };
  }
}
