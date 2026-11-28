import crypto from 'node:crypto';
import fs from 'node:fs';
import { monetizationPrograms, type PlatformStats } from './analytics';
import type { AnalyticsReport, PlatformAnalytics, VideoStats } from '../../shared/operations';
import type { DatabaseSync } from 'node:sqlite';
import type { AuditLedger } from '../audit/ledger';
import type { OperationsRepository } from '../db/operations';
import type { ProductionRepository } from '../db/productions';
import type { Platform, PlatformAppSummary, Privacy, Publication, TikTokCreatorInfo, TikTokPostOptions } from '../../shared/operations';
import { OAuthError, type SecretBox, type TokenSet } from './oauth';
import type { PlatformApp, PlatformClient } from './platforms';
import { allowedFor } from '../audio/sound';
import { AUDIO_GATE_ID } from '../../shared/audioMix';

export class PublishBlockedError extends Error {}

const DEFAULT_PORT: Record<Platform, number> = { tiktok: 53682, youtube: 0, instagram: 0 };
const toPub = (r: Record<string, unknown>): Publication => ({
  id: Number(r.id),
  productionId: r.production_id === null || r.production_id === undefined ? null : Number(r.production_id),
  platform: r.platform as Platform,
  accountId: r.account_id === null ? null : Number(r.account_id),
  privacyRequested: r.privacy_requested as Privacy,
  privacyApplied: String(r.privacy_applied),
  status: r.status as Publication['status'],
  remoteId: String(r.remote_id),
  url: String(r.url),
  detail: String(r.detail),
  approvedBy: String(r.approved_by),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
  productionNumber: Number(r.production_number ?? r.production_id ?? 0),
  productionTopic: String(r.production_topic ?? ''),
  accountHandle: String(r.account_handle ?? ''),
  renderSha256: String(r.render_sha256 ?? ''),
  uploadedAt: (r.uploaded_at as string | null) ?? null,
  publishedAt: (r.published_at as string | null) ?? null,
  failedAt: (r.failed_at as string | null) ?? null,
  deletedAt: (r.deleted_at as string | null) ?? null,
  deletionSource: (String(r.deletion_source ?? '') as Publication['deletionSource']),
  deletionNote: String(r.deletion_note ?? ''),
  restoredFrom: String(r.restored_from ?? '')
});
const NOW_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
const norm = (h: string) => h.trim().replace(/^@/, '').toLowerCase();

export interface PublisherDeps {
  db: DatabaseSync;
  ops: OperationsRepository;
  productions: ProductionRepository;
  audit: AuditLedger;
  box: SecretBox;
  clients: Record<Platform, PlatformClient>;
  open: (url: string) => Promise<void> | void;
  /** How long publish() waits for the platform to confirm before leaving it to the engine (ms). */
  verifyWaitMs?: number;
  pollMs?: number;
  /** Live rights check of a library sound. Without it, any non-generated sound blocks publishing (fail closed). */
  soundRights?: (trackId: number) => { ok: boolean; reason: string };
}

/**
 * Publishing through official APIs only. Gates: completed + QA passed + approved (by the user, or by the
 * engine under auto-publish after a user-approved public post exists) + connected destination account.
 * A post is reported published only after the platform itself confirms it.
 */
export class Publisher {
  constructor(private readonly d: PublisherDeps) {}

  // ---- developer apps (encrypted) -------------------------------------------------------
  // Developer-app credentials belong to one business; no business can read or use another's.
  private appKey = (p: Platform, businessId: number) => `business:${businessId}:platformApp:${p}`;
  getApp(p: Platform, businessId: number): PlatformApp | null {
    const r = this.d.db.prepare('SELECT value FROM settings WHERE key = ?').get(this.appKey(p, businessId)) as { value: string } | undefined;
    if (!r) return null;
    return JSON.parse(this.d.box.decrypt(Buffer.from(r.value, 'base64'))) as PlatformApp;
  }
  saveApp(businessId: number, p: Platform, patch: Partial<PlatformApp>): PlatformAppSummary {
    if (!this.d.box.available()) throw new OAuthError('Windows secure storage is unavailable, so credentials cannot be stored safely.');
    const cur = this.getApp(p, businessId) ?? { clientId: '', clientSecret: '', redirectPort: DEFAULT_PORT[p] };
    // Empty strings in the patch mean "keep the stored secret" so the UI never needs to read secrets back.
    const next: PlatformApp = {
      clientId: patch.clientId?.trim() || cur.clientId,
      clientSecret: patch.clientSecret?.trim() || cur.clientSecret,
      redirectPort: patch.redirectPort ?? cur.redirectPort,
      accessToken: patch.accessToken?.trim() || cur.accessToken,
      publicVideoBaseUrl: patch.publicVideoBaseUrl !== undefined ? patch.publicVideoBaseUrl.trim() : cur.publicVideoBaseUrl
    };
    const value = this.d.box.encrypt(JSON.stringify(next)).toString('base64');
    this.d.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(this.appKey(p, businessId), value);
    this.d.audit.record({ actor: 'user', businessId, type: 'platform.app', data: { platform: p, clientId: next.clientId, redirectPort: next.redirectPort, publicVideoBaseUrl: next.publicVideoBaseUrl ?? '' } });
    return this.appSummary(p, businessId);
  }
  appSummary(p: Platform, businessId: number): PlatformAppSummary {
    const a = this.getApp(p, businessId);
    return {
      platform: p,
      configured: p === 'instagram' ? !!a?.accessToken : !!(a?.clientId && a.clientSecret),
      clientId: a?.clientId ?? '',
      hasSecret: !!a?.clientSecret,
      hasAccessToken: !!a?.accessToken,
      redirectPort: a?.redirectPort ?? DEFAULT_PORT[p],
      publicVideoBaseUrl: a?.publicVideoBaseUrl ?? ''
    };
  }

  // ---- accounts ----------------------------------------------------------------------------
  /** Official sign-in; refuses to attach a different account than the one registered. */
  async connect(accountId: number, signal?: AbortSignal) {
    const acct = this.d.ops.getAccount(accountId);
    if (acct.businessId === null) throw new OAuthError(`${acct.handle} is not assigned to a business.`);
    const app = this.getApp(acct.platform, acct.businessId);
    if (!app || !this.appSummary(acct.platform, acct.businessId).configured) throw new OAuthError(`Set up the ${acct.platform} developer app credentials first.`);
    try {
      const { tokens, profile } = await this.d.clients[acct.platform].authorize(app, this.d.open, signal);
      if (norm(acct.handle) && norm(profile.handle) && norm(acct.handle) !== norm(profile.handle) && norm(acct.handle) !== norm(profile.displayName)) {
        throw new OAuthError(`You signed in as ${profile.handle}, but this entry is ${acct.handle}. Nothing was connected; sign in with ${acct.handle} or register ${profile.handle} as its own account.`);
      }
      this.saveTokens(accountId, tokens);
      const a = this.d.ops.updateAccountAuth(accountId, {
        status: 'connected',
        authenticated: true,
        scopes: tokens.scopes,
        tokenExpiresAt: tokens.expiresAt,
        externalId: profile.externalId,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        lastError: null,
        capabilities: { canPublishPrivate: acct.platform !== 'instagram', canPublishPublic: profile.canPublishPublic, financial: false, restrictions: profile.restrictions }
      });
      this.d.audit.record({ actor: 'user', businessId: acct.businessId, type: 'account.connected', subjectType: 'account', subjectId: accountId, data: { platform: a.platform, handle: a.handle, externalId: a.externalId, scopes: a.scopes, capabilities: a.capabilities } });
      return a;
    } catch (e) {
      this.d.ops.updateAccountAuth(accountId, { lastError: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }
  private saveTokens(accountId: number, t: TokenSet) {
    if (!this.d.box.available()) throw new OAuthError('Windows secure storage is unavailable, so the sign-in cannot be stored safely.');
    this.d.ops.storeToken(accountId, this.d.box.encrypt(JSON.stringify(t)));
  }
  /**
   * Pull audience numbers from every connected account (read-only), store a snapshot, and work out
   * monetization progress. Platforms that can't report stats say why instead of showing zeros.
   */
  async analytics(businessId: number): Promise<AnalyticsReport> {
    const capturedAt = new Date().toISOString();
    const accounts = this.d.ops.listAccounts(businessId).filter((a) => a.status === 'connected');
    // Only this business's publications, through this business's accounts: numbers never combine businesses.
    const pubs = (
      this.d.db.prepare(`SELECT x.* FROM publications x JOIN productions p ON p.id = x.production_id WHERE p.channel_id = ? AND x.status = 'published' AND x.deleted_at IS NULL AND x.remote_id != '' ORDER BY x.id`).all(businessId) as Record<string, unknown>[]
    ).map(toPub);
    const platforms: PlatformAnalytics[] = [];
    const raw: Partial<Record<Platform, PlatformStats>> = {};
    const ins = this.d.db.prepare('INSERT INTO metric_snapshots (captured_at, platform, account_id, publication_id, followers, views, likes, comments, extra, business_id) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const a of accounts) {
      const mine = pubs.filter((p) => p.accountId === a.id);
      const videos = (s?: PlatformStats): VideoStats[] =>
        mine.map((p) => {
          const pr = this.d.productions.get(p.productionId!);
          const v = s?.videos[p.remoteId];
          return { publicationId: p.id, productionId: p.productionId!, title: pr.storyboard?.title ?? pr.topic, url: p.url, privacy: p.privacyApplied, views: v?.views ?? null, likes: v?.likes ?? null, comments: v?.comments ?? null };
        });
      const client = this.d.clients[a.platform];
      if (!client.stats) {
        const why = a.platform === 'tiktok' ? 'TikTok view and follower counts need the video.list and user.info.stats permissions. Add them after the current app review finishes.' : 'Stats for this platform are not available yet.';
        platforms.push({ platform: a.platform, handle: a.handle, available: false, detail: why, followers: null, totalViews: null, videos: videos() });
        continue;
      }
      try {
        const s = await client.stats(await this.tokensFor(a.id, businessId), [...new Set(mine.map((p) => p.remoteId))]);
        raw[a.platform] = s;
        ins.run(capturedAt, a.platform, a.id, null, s.followers, s.totalViews, null, null, JSON.stringify({ longformWatchHours12m: s.longformWatchHours12m ?? null, shortsViews90d: s.shortsViews90d ?? null, views30d: s.views30d ?? null }), businessId);
        const vs = videos(s);
        for (const v of vs) if (v.views !== null) ins.run(capturedAt, a.platform, a.id, v.publicationId, null, v.views, v.likes, v.comments, '{}', businessId);
        platforms.push({ platform: a.platform, handle: a.handle, available: true, detail: s.detail ?? '', followers: s.followers, totalViews: s.totalViews, videos: vs });
      } catch (e) {
        platforms.push({ platform: a.platform, handle: a.handle, available: false, detail: e instanceof Error ? e.message : String(e), followers: null, totalViews: null, videos: videos() });
      }
    }
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const ytPublic90 = pubs.filter((p) => p.platform === 'youtube' && p.privacyApplied === 'public' && p.createdAt >= since).length;
    return { capturedAt, platforms, programs: monetizationPrograms({ youtube: raw.youtube, tiktok: raw.tiktok, youtubePublicUploads90d: ytPublic90 }) };
  }

  /** Decrypt an account's tokens for work done on behalf of `businessId`; another business's account is refused. */
  private async tokensFor(accountId: number, businessId: number): Promise<TokenSet> {
    const acct = this.d.ops.getAccount(accountId);
    if (acct.businessId !== businessId) throw new PublishBlockedError(`${acct.handle} belongs to a different business; its credentials cannot be used here.`);
    const raw = this.d.ops.readToken(accountId);
    if (!raw || acct.status !== 'connected') throw new PublishBlockedError(`${acct.handle} is not connected.`);
    let t = JSON.parse(this.d.box.decrypt(raw)) as TokenSet;
    if (Date.parse(t.expiresAt) - Date.now() < 5 * 60_000) {
      try {
        t = await this.d.clients[acct.platform].refresh(this.getApp(acct.platform, businessId)!, t);
        this.saveTokens(accountId, t);
        this.d.ops.updateAccountAuth(accountId, { tokenExpiresAt: t.expiresAt, lastError: null });
      } catch (e) {
        this.d.ops.updateAccountAuth(accountId, { status: 'expired', lastError: e instanceof Error ? e.message : String(e) });
        this.d.audit.record({ actor: 'engine', businessId, type: 'account.expired', subjectType: 'account', subjectId: accountId, data: { error: String(e) } });
        throw new PublishBlockedError(`${acct.handle}: sign-in expired and could not be renewed. Reconnect the account.`);
      }
    }
    return t;
  }

  // ---- publishing -------------------------------------------------------------------------
  publications(productionId: number): Publication[] {
    return (this.d.db.prepare('SELECT * FROM publications WHERE production_id = ? ORDER BY id').all(productionId) as Record<string, unknown>[]).map(toPub);
  }
  /** True once the user has approved a post that the platform confirmed publicly visible: the gate for auto-publish. */
  hasUserApprovedPublicPost(businessId: number): boolean {
    return !!this.d.db
      .prepare(`SELECT 1 FROM publications x JOIN productions p ON p.id = x.production_id WHERE p.channel_id = ? AND x.status = 'published' AND x.approved_by = 'user' AND x.privacy_applied IN ('PUBLIC_TO_EVERYONE','public') LIMIT 1`)
      .get(businessId);
  }

  /** Everything that stops this production from going to this platform right now (empty = ready). */
  /**
   * Re-resolve an unpublished production's destinations against the brand's current settings (account,
   * privacy, connection state) and persist them, so the UI's confirmation and the actual post always agree.
   */
  private refreshProduction(productionId: number) {
    const p = this.d.productions.get(productionId);
    if (p.publishStatus === 'published' || !p.destinations.length) return p;
    const destinations = this.d.ops.resolveDestinations(p.channelId, p.destinations.map((d) => ({ platform: d.platform, accountId: d.accountId })));
    if (JSON.stringify(destinations) !== JSON.stringify(p.destinations)) this.d.productions.update(productionId, { destinations });
    return this.d.productions.get(productionId);
  }
  /** Called after the user changes a brand destination. */
  refreshDestinations(brandId: number) {
    for (const s of this.d.productions.list(brandId)) this.refreshProduction(s.id);
  }

  blockers(productionId: number, platform: Platform): string[] {
    const p = this.refreshProduction(productionId);
    const out: string[] = [];
    if (p.status !== 'completed' || !p.outputPath || !fs.existsSync(p.outputPath)) out.push('The video is not finished.');
    const qa = this.d.ops.qaRuns(productionId).at(-1);
    if (!qa || qa.status !== 'passed') out.push(`Quality check has not passed${qa ? ` (last result: ${qa.status})` : ''}.`);
    // The mandatory audio gate is checked again here, independently of the approval.
    const audioGate = qa?.findings.find((f) => f.checkId === AUDIO_GATE_ID);
    if (!audioGate?.passed) out.push(audioGate ? `Audio gate failed: ${audioGate.message}` : 'The audio gate has not passed on this render (QA predates the mandatory audio checks). Re-render and run QA.');
    if (p.approval !== 'approved') out.push('Not approved for publication.');
    // Rights are re-verified right before publishing; an open rights incident blocks the video outright.
    const incident = this.d.db.prepare("SELECT description FROM incidents WHERE production_id = ? AND status = 'open' AND kind = 'rights_complaint' LIMIT 1").get(productionId) as { description: string } | undefined;
    if (incident) out.push(`Open rights incident: ${incident.description}`);
    for (const a of p.assets.filter((x) => x.kind === 'music' || x.kind === 'sfx')) {
      const id = Number(a.meta.trackId);
      if (!(String(a.license).startsWith('Generated by Omnicore') && !this.d.soundRights)) {
        const r = this.d.soundRights && Number.isFinite(id) ? this.d.soundRights(id) : { ok: false, reason: `${a.attribution}: rights cannot be verified` };
        if (!r.ok) out.push(`Sound rights not verified: ${r.reason}.`);
      }
    }
    // Music or effects limited to other platforms (or attached only on a platform) never go out in this video.
    for (const a of p.assets.filter((x) => x.kind === 'music' || x.kind === 'sfx')) {
      const r = allowedFor({ usage: (a.meta.usage as 'embedded' | 'platform_native') ?? 'embedded', restrictions: (a.meta.restrictions as { platforms?: string[] }) ?? {} }, [platform]);
      if (!r.ok) out.push(`"${a.attribution}" is not licensed for ${platform}. Re-render with music cleared for ${platform}.`);
    }
    const dest = p.destinations.find((d) => d.platform === platform);
    if (!dest) out.push(`No ${platform} destination is assigned to this production.`);
    else {
      const live = this.d.ops.resolveDestinations(p.channelId, [{ platform, accountId: dest.accountId }]).find((d) => d.platform === platform);
      out.push(...(live?.blockers ?? []));
      if (platform === 'instagram' && dest.privacy !== 'public') out.push('Instagram API posts are always public; set the Instagram destination to Public to use it.');
      if (platform === 'instagram' && !this.getApp('instagram', p.channelId)?.publicVideoBaseUrl) out.push('Instagram needs the video at a public HTTPS URL (not configured).');
    }
    // Failed attempts and posts recorded as deleted don't block a new attempt (a corrected render is a new record).
    const prior = this.publications(productionId).find((x) => x.platform === platform && x.status !== 'failed' && !x.deletedAt);
    if (prior) out.push(`Already ${prior.status} on ${platform}.`);
    return out;
  }

  /** TikTok posting screen data for this production's assigned account (live from TikTok). */
  async tiktokCreatorInfo(productionId: number): Promise<TikTokCreatorInfo> {
    const p = this.refreshProduction(productionId);
    const dest = p.destinations.find((d) => d.platform === 'tiktok');
    if (!dest?.accountId) throw new PublishBlockedError('No TikTok account is assigned to this production.');
    const client = this.d.clients.tiktok;
    if (!client.creatorInfo) throw new PublishBlockedError('TikTok creator info is unavailable.');
    const info = await client.creatorInfo(await this.tokensFor(dest.accountId, this.d.productions.get(productionId).channelId));
    // The renderer's CSP allows no remote images, so inline the avatar as a data URL.
    if (/^https:\/\//.test(info.avatarUrl)) {
      try {
        const res = await fetch(info.avatarUrl, { signal: AbortSignal.timeout(8000) });
        const type = res.headers.get('content-type') ?? '';
        const buf = Buffer.from(await res.arrayBuffer());
        info.avatarUrl = res.ok && /^image\/(jpeg|png|webp|gif)/.test(type) && buf.length < 2_000_000 ? `data:${type.split(';')[0]};base64,${buf.toString('base64')}` : '';
      } catch {
        info.avatarUrl = '';
      }
    } else info.avatarUrl = '';
    return info;
  }

  async publish(productionId: number, platform: Platform, actor: 'user' | 'engine', signal?: AbortSignal, tiktok?: TikTokPostOptions): Promise<Publication> {
    const blockers = this.blockers(productionId, platform);
    if (blockers.length) throw new PublishBlockedError(blockers.join(' '));
    const p = this.d.productions.get(productionId);
    const dest = p.destinations.find((d) => d.platform === platform)!;
    const approvedBy = this.d.audit.events({ productionId }).filter((e) => e.type === 'approval.granted').at(-1)?.actor ?? actor;
    // Every attempt is its own record: what was uploaded (file hash), by whom, to which account, and when.
    const renderSha = p.outputPath && fs.existsSync(p.outputPath) ? crypto.createHash('sha256').update(fs.readFileSync(p.outputPath)).digest('hex') : '';
    const ins = this.d.db
      .prepare('INSERT INTO publications (production_id, production_number, production_topic, platform, account_id, account_handle, privacy_requested, approved_by, render_sha256) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(productionId, productionId, p.topic, platform, dest.accountId, dest.handle ?? '', tiktok?.privacyLevel ?? dest.privacy, approvedBy, renderSha);
    const id = Number(ins.lastInsertRowid);
    const set = (f: Partial<Record<'status' | 'remote_id' | 'url' | 'detail' | 'privacy_applied', string>>, stamp?: 'uploaded_at' | 'failed_at') => {
      const keys = Object.keys(f);
      this.d.db.prepare(`UPDATE publications SET ${keys.map((k) => `${k} = ?`).join(', ')}${stamp ? `, ${stamp} = ${NOW_SQL}` : ''}, updated_at = ${NOW_SQL} WHERE id = ?`).run(...keys.map((k) => f[k as keyof typeof f]!), id);
    };
    this.d.audit.record({ actor, type: 'publish.started', productionId, data: { platform, accountId: dest.accountId, handle: dest.handle, privacy: tiktok?.privacyLevel ?? dest.privacy, approvedBy, ...(tiktok ? { tiktok: { ...tiktok, caption: undefined } } : {}) } });
    this.syncStatus(productionId);
    try {
      const tokens = await this.tokensFor(dest.accountId!, p.channelId);
      const r = await this.d.clients[platform].publish({ tokens, file: p.outputPath!, productionId, metadata: p.metadata[platform], privacy: dest.privacy, app: this.getApp(platform, p.channelId)!, tiktok, signal });
      set({ status: 'processing', remote_id: r.remoteId, privacy_applied: r.appliedPrivacy, detail: r.notes.join(' ') }, 'uploaded_at');
      this.d.audit.record({ actor, type: 'publish.submitted', productionId, data: { platform, remoteId: r.remoteId, appliedPrivacy: r.appliedPrivacy, notes: r.notes } });
      const deadline = Date.now() + (this.d.verifyWaitMs ?? 120_000);
      while (Date.now() < deadline) {
        const v = await this.verifyOne(id);
        if (v.status !== 'processing') break;
        await new Promise((res) => setTimeout(res, this.d.pollMs ?? 8000));
      }
    } catch (e) {
      set({ status: 'failed', detail: e instanceof Error ? e.message : String(e) }, 'failed_at');
      this.d.audit.record({ actor, type: 'publish.failed', productionId, data: { platform, error: String(e) } });
      this.syncStatus(productionId);
      throw e;
    }
    this.syncStatus(productionId);
    return this.publications(productionId).find((x) => x.id === id)!;
  }

  /** Ask the platform whether a submitted post is live; records the verified URL. */
  async verifyOne(publicationId: number): Promise<Publication> {
    const pub = toPub(this.d.db.prepare('SELECT * FROM publications WHERE id = ?').get(publicationId) as Record<string, unknown>);
    if (pub.status !== 'processing' || !pub.accountId || pub.productionId === null) return pub;
    const owner = this.d.productions.get(pub.productionId).channelId;
    const tokens = await this.tokensFor(pub.accountId, owner);
    const v = await this.d.clients[pub.platform].verify(tokens, pub.remoteId, this.getApp(pub.platform, owner)!);
    if (v.state !== 'processing') {
      this.d.db
        .prepare(`UPDATE publications SET status = ?, url = ?, detail = TRIM(detail || ' ' || ?), ${v.state === 'published' ? 'published_at' : 'failed_at'} = ${NOW_SQL}, updated_at = ${NOW_SQL} WHERE id = ?`)
        .run(v.state, v.url ?? '', v.detail, publicationId);
      this.d.audit.record({ actor: 'engine', type: v.state === 'published' ? 'publish.verified' : 'publish.failed', productionId: pub.productionId, data: { platform: pub.platform, remoteId: pub.remoteId, url: v.url, detail: v.detail } });
      this.syncStatus(pub.productionId);
    }
    return toPub(this.d.db.prepare('SELECT * FROM publications WHERE id = ?').get(publicationId) as Record<string, unknown>);
  }

  async verifyPending(): Promise<void> {
    for (const r of this.d.db.prepare(`SELECT id FROM publications WHERE status = 'processing'`).all() as { id: number }[]) {
      try {
        await this.verifyOne(r.id);
      } catch {
        /* retried next tick */
      }
    }
  }

  /**
   * Record that a published post was deleted on the platform. Only the user (or a platform confirmation) can say so;
   * Omnicore never infers it. The record and its earlier history are kept; a new attempt becomes possible.
   */
  recordDeletion(publicationId: number, businessId: number, source: 'user' | 'platform', note: string): Publication {
    const row = this.d.db.prepare('SELECT x.*, p.channel_id FROM publications x LEFT JOIN productions p ON p.id = x.production_id WHERE x.id = ?').get(publicationId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Publication ${publicationId} not found`);
    if (row.channel_id !== null && row.channel_id !== undefined && Number(row.channel_id) !== businessId) throw new Error(`Publication ${publicationId} not found`);
    const pub = toPub(row);
    if (pub.deletedAt) throw new Error('This post is already recorded as deleted.');
    if (pub.status !== 'published' && pub.status !== 'processing') throw new Error('Only a post that reached the platform can be recorded as deleted.');
    this.d.db.prepare(`UPDATE publications SET deleted_at = ${NOW_SQL}, deletion_source = ?, deletion_note = ?, updated_at = ${NOW_SQL} WHERE id = ?`).run(source, note, publicationId);
    this.d.audit.record({ actor: source === 'user' ? 'user' : 'engine', businessId, type: 'publish.deleted', productionId: pub.productionId ?? undefined, data: { publicationId, platform: pub.platform, remoteId: pub.remoteId, productionNumber: pub.productionNumber, source, note } });
    if (pub.productionId !== null) this.syncStatus(pub.productionId);
    return toPub(this.d.db.prepare('SELECT * FROM publications WHERE id = ?').get(publicationId) as Record<string, unknown>);
  }

  /** Every publication for a business, including those whose production was deleted (newest first). */
  publicationHistory(businessId: number): Publication[] {
    return (
      this.d.db
        .prepare(
          `SELECT x.* FROM publications x LEFT JOIN productions p ON p.id = x.production_id LEFT JOIN platform_accounts a ON a.id = x.account_id
           WHERE p.channel_id = ? OR (x.production_id IS NULL AND (a.business_id = ? OR a.id IS NULL)) ORDER BY x.id DESC`
        )
        .all(businessId, businessId) as Record<string, unknown>[]
    ).map(toPub);
  }

  private syncStatus(productionId: number) {
    const p = this.d.productions.get(productionId);
    const pubs = this.publications(productionId);
    const wanted = p.destinations.map((d) => d.platform);
    const latest = (pl: Platform) => pubs.filter((x) => x.platform === pl && !x.deletedAt).at(-1);
    const states = wanted.map((pl) => latest(pl)?.status ?? 'none');
    const status = states.every((s) => s === 'published')
      ? 'published'
      : states.some((s) => s === 'uploading' || s === 'processing')
        ? 'publishing'
        : states.some((s) => s === 'published')
          ? 'partially_published'
          : states.some((s) => s === 'failed')
            ? 'failed'
            : 'not_published';
    this.d.productions.update(productionId, { publishStatus: status });
  }
}
