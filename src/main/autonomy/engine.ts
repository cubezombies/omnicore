import type { TopicRepository } from '../business/topics';
import type { AuditLedger } from '../audit/ledger';
import type { Publisher } from '../publishing/publisher';
import type { OperationsRepository } from '../db/operations';
import type { ProductionRepository } from '../db/productions';
import type { ProductionRunner } from '../pipeline/runner';
import type { EngineStatus, Idea } from '../../shared/operations';
import type { DiscoveryResult } from './discovery';
import { topicRelevance, type Relevance } from './relevance';
import { isRetryable } from '../../shared/failures';
import { HALTING_FAILURES } from '../../shared/automation';
import type { JobRepository } from '../automation/jobs';
import type { CircuitBreakers } from '../automation/circuit';

export interface EngineDeps {
  ops: OperationsRepository;
  productions: ProductionRepository;
  runner: ProductionRunner;
  audit: AuditLedger;
  discover: (brandId: number, keywords: string[], recentTopics: string[], signal: AbortSignal, anchors?: string[]) => Promise<DiscoveryResult>;
  now?: () => Date;
  tickMs?: number;
  onChange?: () => void;
  /** Publishing (optional so tests can run the loop without it). */
  publisher?: Pick<Publisher, 'verifyPending' | 'hasUserApprovedPublicPost' | 'blockers' | 'publish'>;
  /** Business topics steer discovery (optional so older tests can omit it). */
  topics?: Pick<TopicRepository, 'discoveryProfile'>;
  /**
   * Before a production is created: does independent evidence for this idea exist (the same research and evidence
   * gate the production would run)? Ideas that fail are set aside instead of becoming failed productions.
   */
  precheck?: (brandId: number, idea: Idea, signal: AbortSignal) => Promise<{ ok: boolean; reason: string }>;
  /** Is the script writer (the local LLM) loaded and answering? Nothing starts while it is down. */
  writerReady?: () => Promise<{ ok: boolean; reason: string }>;
  /** Job history (bounded retries survive restarts). */
  jobs?: Pick<JobRepository, 'automaticRetries'>;
  /** Circuit breakers: automation does not start work for an open service. */
  breakers?: Pick<CircuitBreakers, 'allows'>;
}

/** What the operating engine cannot do on its own — shown in the UI so nobody assumes 24/7 operation. */
export const ENGINE_LIMITATIONS = [
  'Runs only while this computer is on, awake and online; sleep, shutdown or a lost connection pauses it.',
  'Keeps working with the window closed (system tray) — choosing Quit stops it.',
  'Local services it relies on (Strata, internet research sources) must be available; it retries later when they are not.',
  'It never spends money and never publishes publicly without your approval.'
];

/** Ideas checked for independent evidence per scheduling pass (each check runs the research providers). */
const PRECHECKS_PER_TICK = 3;


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
        // Hard stop: a failed gate halted automation for this business until you review it.
        if (this.d.ops.getAutomationHalt(brandId)) continue;
        const last = this.d.ops.lastRun(`discovery:${brandId}`);
        const due = !last || this.now().getTime() - Date.parse(`${last.startedAt}Z`.replace('ZZ', 'Z')) >= s.discoveryEveryHours * 3600_000;
        if (due) await this.runDiscovery(brandId);
        const writer = await this.checkWriter();
        this.retryFailed(brandId, writer);
        if (writer && (this.d.breakers?.allows('writer') ?? true)) await this.maybeStartProduction(brandId);
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
      const res = await this.d.discover(brandId, keywords, recent, this.discovering.signal, profile?.anchors ?? []);
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

  /**
   * Editorial selection: the best-scoring new idea that is on topic, needs no approval, has no production yet and has
   * independent evidence (checked before any production exists), if limits, hours and the queue allow.
   */
  async maybeStartProduction(brandId: number): Promise<number | null> {
    const s = this.d.ops.getAutonomy(brandId);
    if (!this.withinHours(brandId) || this.d.runner.busy() || this.productionsToday(brandId) >= s.maxProductionsPerDay) return null;
    // Ideas under topics that require approval are left for the user ("Produce now"); the engine never starts them.
    const needsApproval = this.d.topics?.discoveryProfile(brandId).approvalKeywords ?? [];
    // Off-topic ideas (e.g. discovered before the relevance rule) are never started automatically.
    const candidates = this.d.ops
      .listIdeas(brandId, 'new')
      .filter((i) => i.score >= s.minIdeaScore && !i.productionId && !mentionsAny(`${i.topic} ${i.headline}`, needsApproval) && this.ideaRelevance(i.id).onTopic);
    let checked = 0;
    for (const idea of candidates) {
      if (this.d.precheck) {
        if (checked++ >= PRECHECKS_PER_TICK) break;
        const pre = await this.d.precheck(brandId, idea, AbortSignal.timeout(180_000)).catch((e: unknown) => ({ ok: false, reason: `check failed: ${e instanceof Error ? e.message : String(e)}` }));
        if (!pre.ok) {
          // A missing-evidence verdict is final for this idea; a failed check (network) leaves it for the next pass.
          if (!pre.reason.startsWith('check failed')) this.d.ops.decideIdea(idea.id, 'rejected', `set aside before production: ${pre.reason}`);
          this.d.audit.record({ actor: 'engine', businessId: brandId, type: 'idea.precheck', subjectType: 'idea', subjectId: idea.id, data: { topic: idea.topic, ok: false, reason: pre.reason } });
          continue;
        }
        this.d.audit.record({ actor: 'engine', businessId: brandId, type: 'idea.precheck', subjectType: 'idea', subjectId: idea.id, data: { topic: idea.topic, ok: true, reason: pre.reason } });
      }
      return this.produceIdea(idea.id, 'engine', `highest-scoring idea with independent evidence (${idea.score} ≥ ${s.minIdeaScore})`);
    }
    return null;
  }

  /** Whether an idea is on topic for its business (topic, headline and every signal title). */
  ideaRelevance(ideaId: number): Relevance {
    const idea = this.d.ops.getIdea(ideaId);
    const profile = this.d.topics?.discoveryProfile(idea.brandId);
    const keywords = profile?.keywords.length ? profile.keywords : this.d.ops.brandKeywords(idea.brandId);
    const r = topicRelevance([idea.topic, idea.headline, ...idea.signals.map((s) => s.title)].join(' \n '), keywords, profile?.anchors ?? []);
    // Discovery also read the articles' summaries; AI terms it found there (recorded in the score notes) count too.
    const found = (idea.scoreDetail.notes ?? []).find((n) => n.startsWith('AI terms: '));
    if (!r.onTopic && found && profile?.anchors.length) return { ...r, onTopic: true, anchorHits: found.slice(10).split(', '), reason: `${found} (in the article summaries)` };
    return r;
  }

  /** Turn an idea into a production with its brand's explicit destinations. Used by the engine and by "Produce now". */
  produceIdea(ideaId: number, actor: string, reason: string): number {
    const idea = this.d.ops.getIdea(ideaId);
    // Duplicate prevention: one live production per idea.
    if (idea.productionId) {
      const existing = this.d.productions.list(idea.brandId).find((x) => x.id === idea.productionId);
      if (existing && (existing.status === 'queued' || existing.status === 'running' || existing.status === 'completed')) throw new Error(`This idea already has production #${existing.id} (${existing.status}).`);
    }
    this.d.runner.assertNotFrozen?.(); // nothing is created while production is frozen
    const destinations = this.d.ops.resolveDestinations(idea.brandId);
    const p = this.d.productions.create(idea.brandId, idea.topic, null, '', idea.mode, { origin: 'autonomous', ideaId: idea.id, destinations, format: 'standard' });
    this.d.ops.decideIdea(idea.id, 'selected', reason, p.id);
    this.d.audit.record({ actor, businessId: idea.brandId, type: 'idea.selected', subjectType: 'idea', subjectId: idea.id, productionId: p.id, data: { topic: idea.topic, score: idea.score, reason } });
    this.d.audit.record({ actor, businessId: idea.brandId, type: 'production.destination', productionId: p.id, data: { destinations } });
    this.d.runner.enqueue(p.id, actor === 'engine' ? 'automation' : 'user', reason);
    return p.id;
  }

  private writerDown: string | null = null;
  /** Local LLM health, recorded once per outage (and once on recovery) instead of failing productions. */
  async checkWriter(): Promise<boolean> {
    if (!this.d.writerReady) return true;
    const r = await this.d.writerReady().catch((e: unknown) => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }));
    if (!r.ok && this.writerDown === null) this.d.audit.record({ actor: 'engine', type: 'writer.down', data: { reason: r.reason, action: 'productions paused until the writer answers again' } });
    if (r.ok && this.writerDown !== null) this.d.audit.record({ actor: 'engine', type: 'writer.recovered', data: { downReason: this.writerDown } });
    this.writerDown = r.ok ? null : r.reason;
    return r.ok;
  }

  /**
   * Bring an idea's status in line with its production. A production that completes after a manual retry recovers an
   * idea the scheduler had marked failed; the change is audited. Safe to call any time (no-op when already in step).
   */
  reconcileIdea(productionId: number): void {
    const p = this.d.productions.get(productionId);
    if (!p.ideaId || p.status !== 'completed') return;
    const idea = this.d.ops.getIdea(p.ideaId);
    if (idea.productionId !== null && idea.productionId !== p.id) return; // the idea belongs to another production
    if (idea.status !== 'selected' && idea.status !== 'failed') return;
    const recovered = idea.status === 'failed';
    this.d.ops.decideIdea(idea.id, 'produced', `production ${p.id} completed (${p.approval})${recovered ? ' after manual recovery' : ''}`, p.id);
    if (recovered) this.d.audit.record({ actor: 'engine', businessId: p.channelId, type: 'idea.reconciled', subjectType: 'idea', subjectId: idea.id, productionId: p.id, data: { from: 'failed', to: 'produced', previousDecision: idea.decision } });
  }

  /**
   * Keep idea status in step with its production and retry failures by their classification (set where the failure
   * was thrown, see shared/failures.ts): content and rights failures are not retried; writer failures wait until the
   * writer answers again; transient and cancelled ones back off 10, 20, 40 minutes; 3 attempts.
   */
  retryFailed(brandId: number, writerOk = true): void {
    let retried = false;
    for (const p of this.d.productions.list(brandId).filter((x) => x.ideaId)) {
      if (p.status === 'completed') {
        this.reconcileIdea(p.id);
        continue;
      }
      if (p.origin !== 'autonomous') continue;
      const idea = this.d.ops.getIdea(p.ideaId!);
      if ((p.status === 'failed' || p.status === 'cancelled') && idea.status === 'selected') {
        const failedStep = p.steps.find((st) => st.status === 'failed' || st.status === 'pending');
        const attempts = failedStep?.attempts ?? 0;
        const error = p.error ?? '';
        const failure = p.status === 'cancelled' ? { kind: 'cancelled' as const, code: 'cancelled' } : (p.failure ?? { kind: 'transient' as const, code: 'unclassified' });
        if (!isRetryable(failure)) {
          this.d.ops.decideIdea(idea.id, 'failed', `not retried (${failure.kind}: ${failure.code}): ${error}`);
          this.d.audit.record({ actor: 'engine', type: 'idea.failed', subjectType: 'idea', subjectId: idea.id, productionId: p.id, data: { error, permanent: true, failureKind: failure.kind, failureCode: failure.code } });
          // A failed gate (rights, evidence, audio, unsafe state) stops automation for the business: never retried around.
          if ((HALTING_FAILURES as readonly string[]).includes(failure.kind) && !this.d.ops.getAutomationHalt(brandId)) {
            this.d.ops.setAutomationHalt(brandId, { reason: `Production #${p.id} failed a ${failure.kind} gate (${failure.code}): ${error}`.slice(0, 600), productionId: p.id, failureKind: failure.kind, at: this.now().toISOString() });
            this.d.audit.record({ actor: 'engine', businessId: brandId, type: 'automation.halted', productionId: p.id, data: { failureKind: failure.kind, failureCode: failure.code, error } });
            return;
          }
          continue;
        }
        if (failure.kind === 'writer' && !writerOk) continue; // wait for the LLM; does not use up attempts
        // Bounded, configurable retries with exponential back-off, counted from the job history (scheduler retries since
        // the last run you started), so they survive restarts.
        const rel = this.d.ops.getReliability();
        const done = this.d.jobs ? this.d.jobs.automaticRetries(p.id) : Math.max(0, attempts - 1);
        const waited = this.now().getTime() - Date.parse(p.updatedAt) >= rel.retryBackoffMinutes * 60_000 * 2 ** done;
        // One retry per pass, so a failing job never crowds out new work.
        if (done < rel.maxAutomaticRetries && waited && !retried && !this.d.runner.busy()) {
          retried = true;
          this.d.audit.record({ actor: 'engine', type: 'production.retry', productionId: p.id, data: { step: failedStep?.step, attempts, automaticRetries: done, error: p.error, failureKind: failure.kind, failureCode: failure.code } });
          try {
            this.d.runner.retry(p.id, 'scheduler', `automatic retry ${done + 1} of ${rel.maxAutomaticRetries} (${failure.kind}: ${failure.code})`);
          } catch (e) {
            this.lastError = `Retry of #${p.id} refused: ${e instanceof Error ? e.message : String(e)}`;
          }
        } else if (done >= rel.maxAutomaticRetries) {
          this.d.ops.decideIdea(idea.id, 'failed', `gave up after ${done} automatic retries (${failure.kind}: ${failure.code}): ${p.error}`);
          this.d.audit.record({ actor: 'engine', type: 'idea.failed', subjectType: 'idea', subjectId: idea.id, productionId: p.id, data: { error: p.error, failureKind: failure.kind, failureCode: failure.code } });
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
