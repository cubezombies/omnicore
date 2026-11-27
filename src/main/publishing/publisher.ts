import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { AuditLedger } from '../audit/ledger';
import type { OperationsRepository } from '../db/operations';
import type { ProductionRepository } from '../db/productions';
import type { Platform, PlatformAppSummary, Privacy, Publication, TikTokCreatorInfo, TikTokPostOptions } from '../../shared/operations';
import { OAuthError, type SecretBox, type TokenSet } from './oauth';
import type { PlatformApp, PlatformClient } from './platforms';

export class PublishBlockedError extends Error {}

const DEFAULT_PORT: Record<Platform, number> = { tiktok: 53682, youtube: 0, instagram: 0 };
const toPub = (r: Record<string, unknown>): Publication => ({
  id: Number(r.id),
  productionId: Number(r.production_id),
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
  updatedAt: String(r.updated_at)
});
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
}

/**
 * Publishing through official APIs only. Gates: completed + QA passed + approved (by the user, or by the
 * engine under auto-publish after a user-approved public post exists) + connected destination account.
 * A post is reported published only after the platform itself confirms it.
 */
export class Publisher {
  constructor(private readonly d: PublisherDeps) {}

  // ---- developer apps (encrypted) -------------------------------------------------------
  private appKey = (p: Platform) => `platformApp:${p}`;
  getApp(p: Platform): PlatformApp | null {
    const r = this.d.db.prepare('SELECT value FROM settings WHERE key = ?').get(this.appKey(p)) as { value: string } | undefined;
    if (!r) return null;
    return JSON.parse(this.d.box.decrypt(Buffer.from(r.value, 'base64'))) as PlatformApp;
  }
  saveApp(p: Platform, patch: Partial<PlatformApp>): PlatformAppSummary {
    if (!this.d.box.available()) throw new OAuthError('Windows secure storage is unavailable, so credentials cannot be stored safely.');
    const cur = this.getApp(p) ?? { clientId: '', clientSecret: '', redirectPort: DEFAULT_PORT[p] };
    // Empty strings in the patch mean "keep the stored secret" so the UI never needs to read secrets back.
    const next: PlatformApp = {
      clientId: patch.clientId?.trim() || cur.clientId,
      clientSecret: patch.clientSecret?.trim() || cur.clientSecret,
      redirectPort: patch.redirectPort ?? cur.redirectPort,
      accessToken: patch.accessToken?.trim() || cur.accessToken,
      publicVideoBaseUrl: patch.publicVideoBaseUrl !== undefined ? patch.publicVideoBaseUrl.trim() : cur.publicVideoBaseUrl
    };
    const value = this.d.box.encrypt(JSON.stringify(next)).toString('base64');
    this.d.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(this.appKey(p), value);
    this.d.audit.record({ actor: 'user', type: 'platform.app', data: { platform: p, clientId: next.clientId, redirectPort: next.redirectPort, publicVideoBaseUrl: next.publicVideoBaseUrl ?? '' } });
    return this.appSummary(p);
  }
  appSummary(p: Platform): PlatformAppSummary {
    const a = this.getApp(p);
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
    const app = this.getApp(acct.platform);
    if (!app || !this.appSummary(acct.platform).configured) throw new OAuthError(`Set up the ${acct.platform} developer app credentials first.`);
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
      this.d.audit.record({ actor: 'user', type: 'account.connected', subjectType: 'account', subjectId: accountId, data: { platform: a.platform, handle: a.handle, externalId: a.externalId, scopes: a.scopes, capabilities: a.capabilities } });
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
  private async tokensFor(accountId: number): Promise<TokenSet> {
    const acct = this.d.ops.getAccount(accountId);
    const raw = this.d.ops.readToken(accountId);
    if (!raw || acct.status !== 'connected') throw new PublishBlockedError(`${acct.handle} is not connected.`);
    let t = JSON.parse(this.d.box.decrypt(raw)) as TokenSet;
    if (Date.parse(t.expiresAt) - Date.now() < 5 * 60_000) {
      try {
        t = await this.d.clients[acct.platform].refresh(this.getApp(acct.platform)!, t);
        this.saveTokens(accountId, t);
        this.d.ops.updateAccountAuth(accountId, { tokenExpiresAt: t.expiresAt, lastError: null });
      } catch (e) {
        this.d.ops.updateAccountAuth(accountId, { status: 'expired', lastError: e instanceof Error ? e.message : String(e) });
        this.d.audit.record({ actor: 'engine', type: 'account.expired', subjectType: 'account', subjectId: accountId, data: { error: String(e) } });
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
  hasUserApprovedPublicPost(): boolean {
    return !!this.d.db.prepare(`SELECT 1 FROM publications WHERE status = 'published' AND approved_by = 'user' AND privacy_applied IN ('PUBLIC_TO_EVERYONE','public') LIMIT 1`).get();
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
    if (p.approval !== 'approved') out.push('Not approved for publication.');
    const dest = p.destinations.find((d) => d.platform === platform);
    if (!dest) out.push(`No ${platform} destination is assigned to this production.`);
    else {
      const live = this.d.ops.resolveDestinations(p.channelId, [{ platform, accountId: dest.accountId }]).find((d) => d.platform === platform);
      out.push(...(live?.blockers ?? []));
      if (platform === 'instagram' && dest.privacy !== 'public') out.push('Instagram API posts are always public; set the Instagram destination to Public to use it.');
      if (platform === 'instagram' && !this.getApp('instagram')?.publicVideoBaseUrl) out.push('Instagram needs the video at a public HTTPS URL (not configured).');
    }
    const prior = this.publications(productionId).find((x) => x.platform === platform && x.status !== 'failed');
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
    const info = await client.creatorInfo(await this.tokensFor(dest.accountId));
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
    const ins = this.d.db
      .prepare('INSERT INTO publications (production_id, platform, account_id, privacy_requested, approved_by) VALUES (?,?,?,?,?)')
      .run(productionId, platform, dest.accountId, tiktok?.privacyLevel ?? dest.privacy, approvedBy);
    const id = Number(ins.lastInsertRowid);
    const set = (f: Partial<Record<'status' | 'remote_id' | 'url' | 'detail' | 'privacy_applied', string>>) => {
      const keys = Object.keys(f);
      this.d.db.prepare(`UPDATE publications SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(...keys.map((k) => f[k as keyof typeof f]!), id);
    };
    this.d.audit.record({ actor, type: 'publish.started', productionId, data: { platform, accountId: dest.accountId, handle: dest.handle, privacy: tiktok?.privacyLevel ?? dest.privacy, approvedBy, ...(tiktok ? { tiktok: { ...tiktok, caption: undefined } } : {}) } });
    this.syncStatus(productionId);
    try {
      const tokens = await this.tokensFor(dest.accountId!);
      const r = await this.d.clients[platform].publish({ tokens, file: p.outputPath!, productionId, metadata: p.metadata[platform], privacy: dest.privacy, app: this.getApp(platform)!, tiktok, signal });
      set({ status: 'processing', remote_id: r.remoteId, privacy_applied: r.appliedPrivacy, detail: r.notes.join(' ') });
      this.d.audit.record({ actor, type: 'publish.submitted', productionId, data: { platform, remoteId: r.remoteId, appliedPrivacy: r.appliedPrivacy, notes: r.notes } });
      const deadline = Date.now() + (this.d.verifyWaitMs ?? 120_000);
      while (Date.now() < deadline) {
        const v = await this.verifyOne(id);
        if (v.status !== 'processing') break;
        await new Promise((res) => setTimeout(res, this.d.pollMs ?? 8000));
      }
    } catch (e) {
      set({ status: 'failed', detail: e instanceof Error ? e.message : String(e) });
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
    if (pub.status !== 'processing' || !pub.accountId) return pub;
    const tokens = await this.tokensFor(pub.accountId);
    const v = await this.d.clients[pub.platform].verify(tokens, pub.remoteId, this.getApp(pub.platform)!);
    if (v.state !== 'processing') {
      this.d.db
        .prepare(`UPDATE publications SET status = ?, url = ?, detail = TRIM(detail || ' ' || ?), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
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

  private syncStatus(productionId: number) {
    const p = this.d.productions.get(productionId);
    const pubs = this.publications(productionId);
    const wanted = p.destinations.map((d) => d.platform);
    const latest = (pl: Platform) => pubs.filter((x) => x.platform === pl).at(-1);
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
