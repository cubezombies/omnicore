import type { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_AUTONOMY,
  type AccountCapabilities,
  type AutonomySettings,
  type BrandDestination,
  type Idea,
  type IdeaSignal,
  type IdeaStatus,
  type Incident,
  type Platform,
  type PlatformAccount,
  type ProductionDestination,
  type QaFinding,
  type QaRun,
  type ScoreDetail
} from '../../shared/operations';
import { NotFoundError } from './repository';
import { DEFAULT_SOUND_PROFILE, type MusicOverride, type SoundProfile } from '../../shared/production';
import { AUDIO_PIPELINE_VERSION, type ContextualEffect, type ProductionEffects } from '../../shared/audioMix';
import type { AudioVerification, ProductionFreeze } from '../../shared/operations';
import { DEFAULT_RELIABILITY, type AutomationHalt, type ReliabilitySettings } from '../../shared/automation';

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
type Row = Record<string, unknown>;
const j = <T>(v: unknown, d: T): T => (typeof v === 'string' && v ? (JSON.parse(v) as T) : d);

const NO_CAPS: AccountCapabilities = { canPublishPrivate: false, canPublishPublic: false, financial: false, restrictions: [] };

const toAccount = (r: Row): PlatformAccount => ({
  id: Number(r.id),
  platform: r.platform as Platform,
  handle: String(r.handle),
  displayName: String(r.display_name),
  externalId: String(r.external_id),
  avatarUrl: String(r.avatar_url),
  status: r.status as PlatformAccount['status'],
  scopes: j(r.scopes, [] as string[]),
  capabilities: { ...NO_CAPS, ...j(r.capabilities, {}), financial: false },
  tokenExpiresAt: (r.token_expires_at as string) ?? null,
  lastAuthAt: (r.last_auth_at as string) ?? null,
  lastError: (r.last_error as string) ?? null,
  createdAt: String(r.created_at),
  businessId: r.business_id === null || r.business_id === undefined ? null : Number(r.business_id)
});

const toDest = (r: Row): BrandDestination => ({
  id: Number(r.id),
  brandId: Number(r.brand_id),
  platform: r.platform as Platform,
  accountId: r.account_id === null ? null : Number(r.account_id),
  isDefault: Number(r.is_default) === 1,
  enabled: Number(r.enabled) === 1,
  privacy: r.privacy as BrandDestination['privacy']
});

const toIdea = (r: Row): Idea => ({
  id: Number(r.id),
  brandId: Number(r.brand_id),
  topic: String(r.topic),
  headline: String(r.headline),
  mode: r.mode as Idea['mode'],
  signals: j(r.signals, [] as IdeaSignal[]),
  score: Number(r.score),
  scoreDetail: j(r.score_detail, {} as ScoreDetail),
  status: r.status as IdeaStatus,
  decision: String(r.decision),
  productionId: r.production_id === null ? null : Number(r.production_id),
  discoveredAt: String(r.discovered_at),
  decidedAt: (r.decided_at as string) ?? null
});

/** Brands, accounts, destinations, ideas, QA history, incidents, engine runs and autonomy settings. */
export class OperationsRepository {
  constructor(private readonly db: DatabaseSync) {}

  // ---- autonomy settings ----------------------------------------------------
  private autonomyKey = (businessId: number) => `business:${businessId}:autonomy`;
  getAutonomy(businessId: number): AutonomySettings {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(this.autonomyKey(businessId)) as Row | undefined;
    return { ...DEFAULT_AUTONOMY, ...(r ? (JSON.parse(String(r.value)) as Partial<AutonomySettings>) : {}) };
  }
  saveAutonomy(businessId: number, s: AutonomySettings): AutonomySettings {
    this.db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(this.autonomyKey(businessId), JSON.stringify(s));
    return this.getAutonomy(businessId);
  }

  // ---- sound ------------------------------------------------------------------
  private soundKey = (businessId: number) => `business:${businessId}:sound`;
  getSoundProfile(businessId: number): SoundProfile {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(this.soundKey(businessId)) as Row | undefined;
    // Automatic effects (intro riser, transitions, outro pop) are retired: a stored "on" is never honoured or shown.
    return { ...DEFAULT_SOUND_PROFILE, ...(r ? (JSON.parse(String(r.value)) as Partial<SoundProfile>) : {}), introAccent: false, transitions: false, outroAccent: false };
  }
  saveSoundProfile(businessId: number, s: SoundProfile): SoundProfile {
    this.db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(this.soundKey(businessId), JSON.stringify(s));
    return this.getSoundProfile(businessId);
  }
  private effectsKey = (productionId: number) => `production:${productionId}:effects`;
  /** Contextual effects you approved for one production (none unless you chose some). */
  getProductionEffects(productionId: number): ProductionEffects | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(this.effectsKey(productionId)) as Row | undefined;
    return r ? (JSON.parse(String(r.value)) as ProductionEffects) : null;
  }
  setProductionEffects(productionId: number, effects: ContextualEffect[]): ProductionEffects | null {
    if (!effects.length) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(this.effectsKey(productionId));
      return null;
    }
    const v: ProductionEffects = { effects, approvedAt: new Date().toISOString() };
    this.db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(this.effectsKey(productionId), JSON.stringify(v));
    return v;
  }
  private overrideKey = (productionId: number) => `production:${productionId}:music`;
  getMusicOverride(productionId: number): MusicOverride | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(this.overrideKey(productionId)) as Row | undefined;
    return r ? (JSON.parse(String(r.value)) as MusicOverride) : null;
  }
  setMusicOverride(productionId: number, o: MusicOverride): void {
    if (o.mode === 'auto') this.db.prepare('DELETE FROM settings WHERE key = ?').run(this.overrideKey(productionId));
    else this.db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(this.overrideKey(productionId), JSON.stringify(o));
  }
  /** Music tracks this business used in its most recent productions (newest first), for variety. */
  recentMusic(businessId: number, beforeProductionId: number, limit = 3): number[] {
    const rows = this.db
      .prepare(`SELECT a.meta FROM production_assets a JOIN productions p ON p.id = a.production_id WHERE p.channel_id = ? AND a.kind = 'music' AND p.id < ? ORDER BY p.id DESC LIMIT ?`)
      .all(businessId, beforeProductionId, limit) as Row[];
    return rows.map((r) => Number(j(r.meta, {} as { trackId?: number }).trackId)).filter((x) => Number.isFinite(x) && x > 0);
  }

  // ---- brands -----------------------------------------------------------------
  brandPresenter(brandId: number): { engine: string; voice: string } {
    const r = this.db.prepare('SELECT presenter_engine, presenter_voice FROM channels WHERE id = ?').get(brandId) as Row | undefined;
    if (!r) throw new NotFoundError(`Brand ${brandId} not found`);
    return { engine: String(r.presenter_engine), voice: String(r.presenter_voice) };
  }
  setBrandPresenter(brandId: number, engine: string, voice: string): void {
    this.db.prepare('UPDATE channels SET presenter_engine = ?, presenter_voice = ? WHERE id = ?').run(engine, voice, brandId);
  }
  brandKeywords(brandId: number): string[] {
    const r = this.db.prepare('SELECT editorial FROM channels WHERE id = ?').get(brandId) as Row | undefined;
    return j(r?.editorial, {} as { keywords?: string[] }).keywords ?? [];
  }
  /** Businesses whose automation may run (archived businesses are skipped). */
  brandIds(): number[] {
    return (this.db.prepare('SELECT id FROM channels WHERE archived_at IS NULL ORDER BY id').all() as Row[]).map((r) => Number(r.id));
  }

  // ---- accounts ---------------------------------------------------------------
  listAccounts(businessId: number): PlatformAccount[] {
    return (this.db.prepare('SELECT * FROM platform_accounts WHERE business_id = ? ORDER BY platform, handle').all(businessId) as Row[]).map(toAccount);
  }
  getAccount(id: number): PlatformAccount {
    const r = this.db.prepare('SELECT * FROM platform_accounts WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new NotFoundError(`Account ${id} not found`);
    return toAccount(r);
  }
  /** Register an account the user intends to use. It stays "not_connected" until an official OAuth flow succeeds. */
  addAccount(businessId: number, platform: Platform, handle: string, displayName = ''): PlatformAccount {
    const h = handle.trim().startsWith('@') ? handle.trim() : `@${handle.trim()}`;
    const res = this.db.prepare('INSERT INTO platform_accounts (business_id, platform, handle, display_name) VALUES (?,?,?,?)').run(businessId, platform, h, displayName);
    return this.getAccount(Number(res.lastInsertRowid));
  }
  updateAccountAuth(id: number, p: Partial<Pick<PlatformAccount, 'status' | 'scopes' | 'capabilities' | 'tokenExpiresAt' | 'externalId' | 'displayName' | 'avatarUrl' | 'lastError'>> & { authenticated?: boolean }): PlatformAccount {
    const a = this.getAccount(id);
    this.db
      .prepare('UPDATE platform_accounts SET status=?, scopes=?, capabilities=?, token_expires_at=?, external_id=?, display_name=?, avatar_url=?, last_error=?, last_auth_at=COALESCE(?, last_auth_at) WHERE id=?')
      .run(
        p.status ?? a.status,
        JSON.stringify(p.scopes ?? a.scopes),
        JSON.stringify({ ...(p.capabilities ?? a.capabilities), financial: false }),
        p.tokenExpiresAt === undefined ? a.tokenExpiresAt : p.tokenExpiresAt,
        p.externalId ?? a.externalId,
        p.displayName ?? a.displayName,
        p.avatarUrl ?? a.avatarUrl,
        p.lastError === undefined ? a.lastError : p.lastError,
        p.authenticated ? new Date().toISOString() : null,
        id
      );
    return this.getAccount(id);
  }
  /** Disconnect: forget tokens and permissions, keep the account record and brand assignments. */
  disconnectAccount(id: number): PlatformAccount {
    this.db.prepare('DELETE FROM secure_tokens WHERE account_id = ?').run(id);
    return this.updateAccountAuth(id, { status: 'not_connected', scopes: [], capabilities: NO_CAPS, tokenExpiresAt: null });
  }
  storeToken(accountId: number, ciphertext: Uint8Array): void {
    this.db.prepare(`INSERT INTO secure_tokens (account_id, ciphertext) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = ${NOW}`).run(accountId, ciphertext);
  }
  readToken(accountId: number): Uint8Array | null {
    const r = this.db.prepare('SELECT ciphertext FROM secure_tokens WHERE account_id = ?').get(accountId) as { ciphertext: Uint8Array } | undefined;
    return r?.ciphertext ?? null;
  }

  // ---- destinations -------------------------------------------------------------
  listDestinations(brandId: number): BrandDestination[] {
    return (this.db.prepare('SELECT * FROM brand_destinations WHERE brand_id = ? ORDER BY platform, id').all(brandId) as Row[]).map(toDest);
  }
  setDestination(brandId: number, platform: Platform, p: { accountId: number | null; enabled: boolean; privacy: BrandDestination['privacy'] }): BrandDestination {
    if (p.accountId !== null) {
      const a = this.getAccount(p.accountId);
      if (a.businessId !== brandId) throw new Error('That account belongs to a different business.');
      if (a.platform !== platform) throw new Error('That account belongs to a different platform.');
    }
    const existing = this.db.prepare('SELECT id FROM brand_destinations WHERE brand_id = ? AND platform = ? AND is_default = 1').get(brandId, platform) as Row | undefined;
    if (existing) {
      this.db.prepare('UPDATE brand_destinations SET account_id = ?, enabled = ?, privacy = ? WHERE id = ?').run(p.accountId, p.enabled ? 1 : 0, p.privacy, Number(existing.id));
      return toDest(this.db.prepare('SELECT * FROM brand_destinations WHERE id = ?').get(Number(existing.id)) as Row);
    }
    const res = this.db.prepare('INSERT INTO brand_destinations (brand_id, platform, account_id, is_default, enabled, privacy) VALUES (?,?,?,1,?,?)').run(brandId, platform, p.accountId, p.enabled ? 1 : 0, p.privacy);
    return toDest(this.db.prepare('SELECT * FROM brand_destinations WHERE id = ?').get(Number(res.lastInsertRowid)) as Row);
  }
  /**
   * Resolve a brand's enabled default destinations into explicit, frozen production destinations,
   * listing every reason one cannot publish. Never picks "whatever account is connected".
   */
  resolveDestinations(brandId: number, overrides?: { platform: Platform; accountId: number | null }[]): ProductionDestination[] {
    const defaults = this.listDestinations(brandId).filter((d) => d.enabled && d.isDefault);
    const chosen = overrides?.length
      ? // A frozen destination with no account follows the brand's current explicit assignment (set later by the user).
        overrides.map((o) => ({ platform: o.platform, accountId: o.accountId ?? defaults.find((d) => d.platform === o.platform)?.accountId ?? null, privacy: defaults.find((d) => d.platform === o.platform)?.privacy ?? ('private' as const) }))
      : defaults.map((d) => ({ platform: d.platform, accountId: d.accountId, privacy: d.privacy }));
    return chosen.map((d) => {
      const blockers: string[] = [];
      let handle: string | null = null;
      if (d.accountId === null) blockers.push(`No ${d.platform} account is assigned to this brand.`);
      else {
        const a = this.getAccount(d.accountId);
        handle = a.handle;
        if (a.businessId !== brandId) blockers.push(`${a.handle} belongs to a different business.`);
        if (a.platform !== d.platform) blockers.push(`${a.handle} is a ${a.platform} account, not ${d.platform}.`);
        if (a.status !== 'connected') blockers.push(`${a.handle} is ${a.status.replace('_', ' ')}.`);
        else if (a.tokenExpiresAt && Date.parse(a.tokenExpiresAt) < Date.now()) blockers.push(`${a.handle}'s authorization expired.`);
        const allowed = d.privacy === 'private' ? a.capabilities.canPublishPrivate : a.capabilities.canPublishPublic;
        if (a.status === 'connected' && !allowed) blockers.push(`${a.handle} does not have permission to publish ${d.privacy} posts.`);
      }
      return { platform: d.platform, accountId: d.accountId, handle, privacy: d.privacy, blockers };
    });
  }

  // ---- ideas ------------------------------------------------------------------
  upsertIdea(i: Omit<Idea, 'id' | 'status' | 'decision' | 'productionId' | 'discoveredAt' | 'decidedAt'> & { fingerprint: string }): { idea: Idea; created: boolean } {
    const existing = this.db.prepare('SELECT * FROM ideas WHERE brand_id = ? AND fingerprint = ?').get(i.brandId, i.fingerprint) as Row | undefined;
    if (existing) return { idea: toIdea(existing), created: false };
    const res = this.db
      .prepare('INSERT INTO ideas (brand_id, topic, headline, mode, signals, score, score_detail, fingerprint) VALUES (?,?,?,?,?,?,?,?)')
      .run(i.brandId, i.topic, i.headline, i.mode, JSON.stringify(i.signals), i.score, JSON.stringify(i.scoreDetail), i.fingerprint);
    return { idea: this.getIdea(Number(res.lastInsertRowid)), created: true };
  }
  getIdea(id: number): Idea {
    const r = this.db.prepare('SELECT * FROM ideas WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new NotFoundError(`Idea ${id} not found`);
    return toIdea(r);
  }
  listIdeas(brandId: number, status?: IdeaStatus): Idea[] {
    const rows = (status
      ? this.db.prepare('SELECT * FROM ideas WHERE brand_id = ? AND status = ? ORDER BY score DESC, id DESC').all(brandId, status)
      : this.db.prepare('SELECT * FROM ideas WHERE brand_id = ? ORDER BY discovered_at DESC, score DESC LIMIT 200').all(brandId)) as Row[];
    return rows.map(toIdea);
  }
  recentTopics(brandId: number, days: number): string[] {
    return (this.db.prepare(`SELECT topic FROM ideas WHERE brand_id = ? AND status IN ('selected','produced') AND discovered_at >= datetime('now', ?)`).all(brandId, `-${days} days`) as Row[]).map((r) => String(r.topic));
  }
  decideIdea(id: number, status: IdeaStatus, decision: string, productionId?: number): Idea {
    this.db.prepare(`UPDATE ideas SET status = ?, decision = ?, production_id = COALESCE(?, production_id), decided_at = ${NOW} WHERE id = ?`).run(status, decision, productionId ?? null, id);
    return this.getIdea(id);
  }
  /** Keep the pipeline bounded: expire stale or low-ranked "new" ideas beyond the cap. */
  pruneIdeas(brandId: number, keep: number, maxAgeDays: number): number {
    const stale = this.db.prepare(`UPDATE ideas SET status = 'expired', decision = 'expired: older than ' || ? || ' days', decided_at = ${NOW} WHERE brand_id = ? AND status = 'new' AND discovered_at < datetime('now', ?)`).run(maxAgeDays, brandId, `-${maxAgeDays} days`);
    const extra = this.db
      .prepare(`UPDATE ideas SET status = 'expired', decision = 'expired: pipeline full', decided_at = ${NOW} WHERE id IN (SELECT id FROM ideas WHERE brand_id = ? AND status = 'new' ORDER BY score DESC, id DESC LIMIT -1 OFFSET ?)`)
      .run(brandId, keep);
    return Number(stale.changes) + Number(extra.changes);
  }

  // ---- automation reliability -----------------------------------------------------------------------------------
  getReliability(): ReliabilitySettings {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = 'reliability'").get() as Row | undefined;
    return { ...DEFAULT_RELIABILITY, ...(r ? (JSON.parse(String(r.value)) as Partial<ReliabilitySettings>) : {}) };
  }
  saveReliability(s: ReliabilitySettings): ReliabilitySettings {
    this.db.prepare(`INSERT INTO settings (key, value) VALUES ('reliability', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(s));
    return this.getReliability();
  }
  private haltKey = (businessId: number) => `business:${businessId}:automation-halt`;
  /** A hard stop: automation for this business does nothing until you clear it (set on a failed gate). */
  getAutomationHalt(businessId: number): AutomationHalt | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(this.haltKey(businessId)) as Row | undefined;
    return r ? (JSON.parse(String(r.value)) as AutomationHalt) : null;
  }
  setAutomationHalt(businessId: number, h: AutomationHalt): void {
    this.db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(this.haltKey(businessId), JSON.stringify(h));
  }
  clearAutomationHalt(businessId: number): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(this.haltKey(businessId));
  }

  // ---- production freeze (audio pipeline restoration) ---------------------------------------------------------
  /**
   * Production is frozen until the current audio pipeline version has passed a real verification render AND you
   * released it. Missing state means frozen, so a fresh install or an upgrade starts frozen.
   */
  productionFreeze(): ProductionFreeze {
    const get = <T>(k: string): T | null => {
      const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as Row | undefined;
      return r ? (JSON.parse(String(r.value)) as T) : null;
    };
    const verification = get<AudioVerification>('audio.pipeline.verification');
    const release = get<{ version: number; at: string; note: string; verifiedAt: string }>('audio.pipeline.release');
    const released = release?.version === AUDIO_PIPELINE_VERSION;
    const verified = verification?.passed === true && verification.version === AUDIO_PIPELINE_VERSION;
    return {
      frozen: !released,
      version: AUDIO_PIPELINE_VERSION,
      reason: released
        ? ''
        : verified
          ? 'the audio pipeline passed its verification render; release production in Operations to resume.'
          : `audio pipeline v${AUDIO_PIPELINE_VERSION} has not passed its verification render yet (music, narration, ducking, effects and levels must pass on a real render).`,
      verification,
      release
    };
  }
  recordAudioVerification(v: AudioVerification): void {
    this.db.prepare(`INSERT INTO settings (key, value) VALUES ('audio.pipeline.verification', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(v));
  }
  /** Release production. Refused unless a verification render passed on the current audio pipeline version. */
  releaseProduction(note: string): ProductionFreeze {
    const f = this.productionFreeze();
    if (!f.verification?.passed || f.verification.version !== AUDIO_PIPELINE_VERSION) throw new Error(`Production stays frozen: ${f.reason}`);
    this.db
      .prepare(`INSERT INTO settings (key, value) VALUES ('audio.pipeline.release', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify({ version: AUDIO_PIPELINE_VERSION, at: new Date().toISOString(), note, verifiedAt: f.verification.at }));
    return this.productionFreeze();
  }

  // ---- QA history -----------------------------------------------------------
  /**
   * Save a QA run with a snapshot of what was checked (business, production number and topic, render hash), so the
   * record still identifies its video after the production is deleted.
   */
  saveQaRun(productionId: number, round: number, status: QaRun['status'], summary: QaRun['summary'], findings: QaFinding[], renderSha256 = ''): QaRun {
    const res = this.db
      .prepare(
        `INSERT INTO qa_runs (production_id, business_id, production_number, production_topic, render_sha256, round, status, summary, finished_at)
         SELECT p.id, p.channel_id, p.id, p.topic,
           COALESCE(NULLIF(?, ''), (SELECT json_extract(e.data, '$.sha256') FROM audit_events e WHERE e.type = 'render.output' AND e.production_id = p.id ORDER BY e.id DESC LIMIT 1), ''),
           ?, ?, ?, ${NOW}
         FROM productions p WHERE p.id = ?`
      )
      .run(renderSha256, round, status, JSON.stringify(summary), productionId);
    if (!Number(res.changes)) throw new Error(`Production #${productionId} not found.`);
    const runId = Number(res.lastInsertRowid);
    const ins = this.db.prepare('INSERT INTO qa_findings (qa_run_id, check_id, category, severity, passed, message, evidence, repair) VALUES (?,?,?,?,?,?,?,?)');
    for (const f of findings) ins.run(runId, f.checkId, f.category, f.severity, f.passed ? 1 : 0, f.message, JSON.stringify(f.evidence), f.repair);
    return this.qaRuns(productionId).find((r) => r.id === runId)!;
  }
  /** Link a QA run to the audit event that records it. */
  linkQaAudit(runId: number, auditEventId: number): void {
    this.db.prepare('UPDATE qa_runs SET audit_event_id = ? WHERE id = ? AND audit_event_id IS NULL').run(auditEventId, runId);
  }
  qaRuns(productionId: number): QaRun[] {
    return this.mapQaRuns(this.db.prepare('SELECT * FROM qa_runs WHERE production_id = ? ORDER BY id').all(productionId) as Row[]);
  }
  /** Every QA run of a business, including runs of deleted productions (newest first). */
  qaHistory(businessId: number): QaRun[] {
    return this.mapQaRuns(this.db.prepare('SELECT * FROM qa_runs WHERE business_id = ? ORDER BY id DESC').all(businessId) as Row[]);
  }
  private mapQaRuns(runs: Row[]): QaRun[] {
    return runs.map((r) => ({
      id: Number(r.id),
      productionId: r.production_id === null ? null : Number(r.production_id),
      productionNumber: Number(r.production_number),
      productionTopic: String(r.production_topic ?? ''),
      renderSha256: String(r.render_sha256 ?? ''),
      auditEventId: r.audit_event_id === null || r.audit_event_id === undefined ? null : Number(r.audit_event_id),
      productionDeletedAt: (r.production_deleted_at as string) ?? null,
      round: Number(r.round),
      status: r.status as QaRun['status'],
      summary: j(r.summary, { critical: 0, major: 0, minor: 0, checks: 0, repairs: [] }),
      startedAt: String(r.started_at),
      finishedAt: (r.finished_at as string) ?? null,
      findings: (this.db.prepare('SELECT * FROM qa_findings WHERE qa_run_id = ? ORDER BY id').all(Number(r.id)) as Row[]).map((f) => ({
        checkId: String(f.check_id),
        category: f.category as QaFinding['category'],
        severity: f.severity as QaFinding['severity'],
        passed: Number(f.passed) === 1,
        message: String(f.message),
        evidence: j(f.evidence, {}),
        repair: String(f.repair)
      }))
    }));
  }

  // ---- incidents ------------------------------------------------------------
  addIncident(businessId: number, kind: Incident['kind'], description: string, productionId: number | null, assetKey = ''): Incident {
    const res = this.db.prepare('INSERT INTO incidents (business_id, kind, production_id, asset_key, description) VALUES (?,?,?,?,?)').run(businessId, kind, productionId, assetKey, description);
    return this.listIncidents(businessId).find((i) => i.id === Number(res.lastInsertRowid))!;
  }
  listIncidents(businessId: number): Incident[] {
    return (this.db.prepare('SELECT * FROM incidents WHERE business_id = ? ORDER BY id DESC').all(businessId) as Row[]).map((r) => ({
      id: Number(r.id),
      kind: r.kind as Incident['kind'],
      productionId: r.production_id === null ? null : Number(r.production_id),
      assetKey: String(r.asset_key),
      description: String(r.description),
      status: r.status as Incident['status'],
      createdAt: String(r.created_at),
      resolvedAt: (r.resolved_at as string) ?? null
    }));
  }
  resolveIncident(id: number): void {
    this.db.prepare(`UPDATE incidents SET status = 'resolved', resolved_at = ${NOW} WHERE id = ?`).run(id);
  }

  // ---- engine runs -------------------------------------------------------------
  startRun(kind: string, businessId: number | null = null): number {
    return Number(this.db.prepare('INSERT INTO engine_runs (kind, business_id) VALUES (?, ?)').run(kind, businessId).lastInsertRowid);
  }
  finishRun(id: number, status: 'done' | 'failed' | 'interrupted', detail: string): void {
    this.db.prepare(`UPDATE engine_runs SET status = ?, detail = ?, finished_at = ${NOW} WHERE id = ?`).run(status, detail.slice(0, 4000), id);
  }
  lastRun(kind: string): { status: string; startedAt: string; finishedAt: string | null; detail: string } | null {
    const r = this.db.prepare('SELECT * FROM engine_runs WHERE kind = ? ORDER BY id DESC LIMIT 1').get(kind) as Row | undefined;
    return r ? { status: String(r.status), startedAt: String(r.started_at), finishedAt: (r.finished_at as string) ?? null, detail: String(r.detail) } : null;
  }
  markRunsInterrupted(): number {
    return Number(this.db.prepare(`UPDATE engine_runs SET status = 'interrupted', detail = 'Interrupted by app exit', finished_at = ${NOW} WHERE status = 'running'`).run().changes);
  }
  autonomousProductionsSince(isoStart: string, businessId: number): number {
    return Number((this.db.prepare(`SELECT COUNT(*) n FROM productions WHERE origin = 'autonomous' AND channel_id = ? AND created_at >= ?`).get(businessId, isoStart) as Row).n);
  }
}
