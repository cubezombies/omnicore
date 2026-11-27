import type { TopicRepository } from '../business/topics';
import type { AuditLedger } from '../audit/ledger';
import type { Publisher } from '../publishing/publisher';
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
  /** Publishing (optional so tests can run the loop without it). */
  publisher?: Pick<Publisher, 'verifyPending' | 'hasUserApprovedPublicPost' | 'blockers' | 'publish'>;
  /** Business topics steer discovery (optional so older tests can omit it). */
  topics?: Pick<TopicRepository, 'discoveryProfile'>;
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
const mentionsAny = (text: string, terms: string[]): boolean => {
  const t = text.toLowerCase();
  return terms.some((x) => x.trim() && new RegExp(`\\b${x.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t));
};

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
    this.d.audit.record({ actor: 'engine', type: 'engine.started', data: { businesses: this.d.ops.brandIds().map((b) => ({ businessId: b, autonomy: this.d.ops.getAutonomy(b) })) } });
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
      // Each business runs with its own automation settings; archived businesses are skipped entirely.
      for (const brandId of this.d.ops.brandIds()) {
        const s = this.d.ops.getAutonomy(brandId);
        if (!s.enabled && !force) continue;
        const last = this.d.ops.lastRun(`discovery:${brandId}`);
        const due = !last || this.now().getTime() - Date.parse(`${last.startedAt}Z`.replace('ZZ', 'Z')) >= s.discoveryEveryHours * 3600_000;
        if (due) await this.runDiscovery(brandId);
        this.retryFailed(brandId);
        this.maybeStartProduction(brandId);
        await this.autoPublish(brandId);
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
    const s = this.d.ops.getAutonomy(brandId);
    const runId = this.d.ops.startRun(`discovery:${brandId}`, brandId);
    this.discovering = new AbortController();
    try {
      // The business's own enabled topics steer discovery; exclusions drop stories outright.
      const profile = this.d.topics?.discoveryProfile(brandId);
      const keywords = profile?.keywords.length ? profile.keywords : this.d.ops.brandKeywords(brandId);
      const recent = this.d.ops.recentTopics(brandId, 21);
      const res = await this.d.discover(brandId, keywords, recent, this.discovering.signal);
      let created = 0;
      for (const c of res.candidates) {
        if (profile && mentionsAny(`${c.topic} ${c.headline}`, profile.exclusions)) continue;
        const { idea, created: isNew } = this.d.ops.upsertIdea({ brandId, topic: c.topic, headline: c.headline, mode: c.mode, signals: c.signals, score: c.score, scoreDetail: c.scoreDetail, fingerprint: c.fingerprint });
        if (isNew) {
          created++;
          this.d.audit.record({ actor: 'engine', businessId: brandId, type: 'idea.discovered', subjectType: 'idea', subjectId: idea.id, data: { topic: idea.topic, score: idea.score, detail: idea.scoreDetail, signals: idea.signals.map((x) => ({ url: x.url, publisher: x.publisher, kind: x.kind })) } });
        }
      }
      const pruned = this.d.ops.pruneIdeas(brandId, s.maxIdeasKept, 7);
      const detail = `${res.items} items · ${res.candidates.length} stories · ${created} new ideas · ${pruned} expired · sources: ${res.sourceReports.map((r) => `${r.id} ${r.ok ? r.items : `failed (${r.error})`}`).join(', ')}`;
      this.d.ops.finishRun(runId, 'done', detail);
      this.d.audit.record({ actor: 'engine', businessId: brandId, type: 'discovery.run', data: { brandId, items: res.items, stories: res.candidates.length, created, pruned, sources: res.sourceReports } });
      return { created, candidates: res.candidates.length };
    } catch (e) {
      this.d.ops.finishRun(runId, this.discovering.signal.aborted ? 'interrupted' : 'failed', e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      this.discovering = null;
    }
  }

  private withinHours(brandId: number): boolean {
    const s = this.d.ops.getAutonomy(brandId);
    const h = this.now().getHours();
    return s.activeFromHour <= s.activeToHour ? h >= s.activeFromHour && h < s.activeToHour : h >= s.activeFromHour || h < s.activeToHour;
  }

  productionsToday(brandId: number): number {
    const d = this.now();
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
    return this.d.ops.autonomousProductionsSince(start, brandId);
  }

  /** Editorial selection: start the best-scoring new idea if limits, hours and the queue allow. */
  maybeStartProduction(brandId: number): number | null {
    const s = this.d.ops.getAutonomy(brandId);
    if (!this.withinHours(brandId) || this.d.runner.busy() || this.productionsToday(brandId) >= s.maxProductionsPerDay) return null;
    // Ideas under topics that require approval are left for the user ("Produce now"); the engine never starts them.
    const needsApproval = this.d.topics?.discoveryProfile(brandId).approvalKeywords ?? [];
    const best = this.d.ops.listIdeas(brandId, 'new').find((i) => !mentionsAny(`${i.topic} ${i.headline}`, needsApproval));
    if (!best || best.score < s.minIdeaScore) return null;
    return this.produceIdea(best.id, 'engine', `highest-scoring idea (${best.score} ≥ ${s.minIdeaScore})`);
  }

  /** Turn an idea into a production with its brand's explicit destinations. Used by the engine and by "Produce now". */
  produceIdea(ideaId: number, actor: string, reason: string): number {
    const idea = this.d.ops.getIdea(ideaId);
    const destinations = this.d.ops.resolveDestinations(idea.brandId);
    const p = this.d.productions.create(idea.brandId, idea.topic, null, '', idea.mode, { origin: 'autonomous', ideaId: idea.id, destinations });
    this.d.ops.decideIdea(idea.id, 'selected', reason, p.id);
    this.d.audit.record({ actor, businessId: idea.brandId, type: 'idea.selected', subjectType: 'idea', subjectId: idea.id, productionId: p.id, data: { topic: idea.topic, score: idea.score, reason } });
    this.d.audit.record({ actor, businessId: idea.brandId, type: 'production.destination', productionId: p.id, data: { destinations } });
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

  /**
   * Check on submitted posts, and — only when you enabled auto-publish AND have already approved a public post
   * that the platform confirmed — approve and publish QA-passed autonomous videos to their unblocked destinations.
   */
  async autoPublish(brandId: number): Promise<void> {
    const pub = this.d.publisher;
    if (!pub) return;
    await pub.verifyPending();
    if (!this.d.ops.getAutonomy(brandId).autoPublish || !pub.hasUserApprovedPublicPost(brandId)) return;
    for (const p of this.d.productions.list(brandId).filter((x) => x.origin === 'autonomous' && x.status === 'completed' && x.approval === 'awaiting_review')) {
      if (this.d.ops.qaRuns(p.id).at(-1)?.status !== 'passed') continue;
      // Approval is the only blocker auto-publish may lift; skip if anything else (e.g. a disconnected account) blocks every destination.
      const ready = p.destinations.filter((d) => pub.blockers(p.id, d.platform).every((b) => b === 'Not approved for publication.'));
      if (!ready.length) continue;
      this.d.productions.update(p.id, { approval: 'approved' });
      this.d.audit.record({ actor: 'engine', businessId: brandId, type: 'approval.granted', productionId: p.id, data: { reason: 'auto-publish: QA passed and a user-approved public post exists', publishes: true } });
      for (const d of this.d.productions.get(p.id).destinations) {
        if (pub.blockers(p.id, d.platform).length) continue;
        try {
          await pub.publish(p.id, d.platform, 'engine');
        } catch (e) {
          this.lastError = `Publishing #${p.id} to ${d.platform}: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
    }
  }

  /** Status of one business's automation (never mixes businesses). */
  status(brandId: number): EngineStatus {
    const s = this.d.ops.getAutonomy(brandId);
    const last = this.d.ops.lastRun(`discovery:${brandId}`);
    const lastAt = last ? new Date(Date.parse(`${last.startedAt}Z`.replace('ZZ', 'Z'))).toISOString() : null;
    const active = this.d.productions.list(brandId).find((p) => p.status === 'running' || p.status === 'queued');
    return {
      enabled: s.enabled,
      running: this.isRunning(),
      lastDiscoveryAt: lastAt,
      nextDiscoveryAt: lastAt ? new Date(Date.parse(lastAt) + s.discoveryEveryHours * 3600_000).toISOString() : null,
      productionsToday: this.productionsToday(brandId),
      activeProductionId: active?.id ?? null,
      lastError: this.lastError,
      limitations: ENGINE_LIMITATIONS
    };
  }
}
