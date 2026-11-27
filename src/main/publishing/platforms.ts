import fs from 'node:fs';
import type { Platform, PlatformMetadata, Privacy } from '../../shared/operations';
import { inSeconds, loopbackAuthorize, OAuthError, pkce, type TokenSet } from './oauth';

/** Developer-app credentials the user registers with each platform (never bundled with Omnicore). */
export interface PlatformApp {
  clientId: string;
  clientSecret: string;
  /** Loopback redirect port registered with the platform (TikTok requires an exact match). */
  redirectPort: number;
  /** Instagram only: long-lived access token issued in Meta's App Dashboard (official; no loopback OAuth for Instagram). */
  accessToken?: string;
  /** Instagram only: public HTTPS base URL where Omnicore's exported videos are reachable (`<base>/<production id>.mp4`). */
  publicVideoBaseUrl?: string;
}

export interface Profile {
  externalId: string;
  handle: string;
  displayName: string;
  avatarUrl: string;
  /** Whether the platform currently lets this app post publicly for this account. */
  canPublishPublic: boolean;
  restrictions: string[];
}

export interface PublishRequest {
  tokens: TokenSet;
  file: string;
  productionId: number;
  metadata: PlatformMetadata;
  privacy: Privacy;
  app: PlatformApp;
  signal?: AbortSignal;
}
export interface PublishResult {
  remoteId: string;
  /** Platform privacy actually applied (e.g. TikTok SELF_ONLY when the app is unaudited). */
  appliedPrivacy: string;
  notes: string[];
}
export interface VerifyResult {
  state: 'processing' | 'published' | 'failed';
  url: string | null;
  detail: string;
}

export interface PlatformClient {
  platform: Platform;
  authorize(app: PlatformApp, open: (url: string) => Promise<void> | void, signal?: AbortSignal): Promise<{ tokens: TokenSet; profile: Profile }>;
  refresh(app: PlatformApp, t: TokenSet): Promise<TokenSet>;
  publish(r: PublishRequest): Promise<PublishResult>;
  verify(tokens: TokenSet, remoteId: string, app: PlatformApp): Promise<VerifyResult>;
}

export type FetchFn = typeof fetch;

async function json(res: Response, what: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* non-JSON error page */
  }
  const err = body.error as Record<string, unknown> | string | undefined;
  const tiktokOk = typeof err === 'object' && err && err.code === 'ok';
  if (!res.ok || (err && !tiktokOk)) {
    const msg = typeof err === 'string' ? `${err} ${body.error_description ?? ''}` : err ? `${err.code ?? ''} ${err.message ?? ''}` : text.slice(0, 300);
    throw new OAuthError(`${what} failed (HTTP ${res.status}): ${String(msg).trim()}`);
  }
  return body;
}
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

// ---- TikTok: Login Kit for Desktop + Content Posting API (Direct Post) ------------------------------

const TT = 'https://open.tiktokapis.com/v2';
export const TIKTOK_PRIVACY: Record<Privacy, string> = { private: 'SELF_ONLY', unlisted: 'MUTUAL_FOLLOW_FRIENDS', public: 'PUBLIC_TO_EVERYONE' };

export function tiktokClient(f: FetchFn = fetch): PlatformClient {
  const tokens = (b: Record<string, unknown>, prev?: TokenSet): TokenSet => ({
    accessToken: String(b.access_token),
    refreshToken: b.refresh_token ? String(b.refresh_token) : (prev?.refreshToken ?? null),
    expiresAt: inSeconds(Number(b.expires_in)),
    refreshExpiresAt: b.refresh_expires_in ? inSeconds(Number(b.refresh_expires_in)) : (prev?.refreshExpiresAt ?? null),
    scopes: String(b.scope ?? '').split(/[ ,]+/).filter(Boolean),
    userId: b.open_id ? String(b.open_id) : prev?.userId
  });
  const auth = (t: TokenSet) => ({ Authorization: `Bearer ${t.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' });
  return {
    platform: 'tiktok',
    async authorize(app, open, signal) {
      const p = pkce('hex');
      const { code, redirectUri } = await loopbackAuthorize({
        port: app.redirectPort,
        open,
        signal,
        buildAuthUrl: (redirect, state) =>
          `https://www.tiktok.com/v2/auth/authorize/?${form({ client_key: app.clientId, scope: 'user.info.basic,video.publish', response_type: 'code', redirect_uri: redirect, state, code_challenge: p.challenge, code_challenge_method: 'S256' })}`
      });
      const t = tokens(
        await json(
          await f(`${TT}/oauth/token/`, { method: 'POST', headers: FORM, body: form({ client_key: app.clientId, client_secret: app.clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri, code_verifier: p.verifier }) }),
          'TikTok token exchange'
        )
      );
      const u = ((await json(await f(`${TT}/user/info/?fields=open_id,avatar_url,display_name`, { headers: auth(t) }), 'TikTok profile')).data as Record<string, Record<string, string>>).user;
      const creator = ((await json(await f(`${TT}/post/publish/creator_info/query/`, { method: 'POST', headers: auth(t), body: '{}' }), 'TikTok creator info')).data ?? {}) as Record<string, unknown>;
      const options = (creator.privacy_level_options as string[] | undefined) ?? [];
      const canPublishPublic = options.includes('PUBLIC_TO_EVERYONE');
      return {
        tokens: t,
        profile: {
          externalId: u.open_id ?? t.userId ?? '',
          handle: `@${String(creator.creator_username ?? u.display_name ?? '')}`,
          displayName: u.display_name ?? '',
          avatarUrl: u.avatar_url ?? '',
          canPublishPublic,
          restrictions: canPublishPublic ? [] : [`TikTok allows only ${options.join(', ') || 'no'} visibility for this app (unaudited apps post SELF_ONLY).`]
        }
      };
    },
    async refresh(app, prev) {
      if (!prev.refreshToken) throw new OAuthError('TikTok session expired; reconnect the account.');
      const b = await json(await f(`${TT}/oauth/token/`, { method: 'POST', headers: FORM, body: form({ client_key: app.clientId, client_secret: app.clientSecret, grant_type: 'refresh_token', refresh_token: prev.refreshToken }) }), 'TikTok token refresh');
      return tokens(b, prev);
    },
    async publish(r) {
      const creator = (await json(await f(`${TT}/post/publish/creator_info/query/`, { method: 'POST', headers: auth(r.tokens), body: '{}' }), 'TikTok creator info')).data as Record<string, unknown>;
      const options = (creator.privacy_level_options as string[]) ?? [];
      const wanted = TIKTOK_PRIVACY[r.privacy];
      const notes: string[] = [];
      let privacy = wanted;
      if (!options.includes(wanted)) {
        // Never escalate visibility: fall back only to private, and say so.
        if (!options.includes('SELF_ONLY')) throw new OAuthError(`TikTok offers no usable privacy level for this account (${options.join(', ') || 'none'}).`);
        privacy = 'SELF_ONLY';
        notes.push(`TikTok only allowed ${options.join(', ')} for this app/account; posted as SELF_ONLY (private). Make it public in the TikTok app, or get the app audited.`);
      }
      const size = fs.statSync(r.file).size;
      const init = (
        await json(
          await f(`${TT}/post/publish/video/init/`, {
            method: 'POST',
            headers: auth(r.tokens),
            body: JSON.stringify({
              post_info: {
                title: r.metadata.caption.slice(0, 2200),
                privacy_level: privacy,
                disable_comment: Boolean(creator.comment_disabled),
                disable_duet: Boolean(creator.duet_disabled),
                disable_stitch: Boolean(creator.stitch_disabled),
                video_cover_timestamp_ms: 1000,
                is_aigc: r.metadata.aiDisclosure,
                brand_content_toggle: false,
                brand_organic_toggle: false
              },
              source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: size, total_chunk_count: 1 }
            })
          }),
          'TikTok post init'
        )
      ).data as { publish_id: string; upload_url: string };
      const up = await f(init.upload_url, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size), 'Content-Range': `bytes 0-${size - 1}/${size}` }, body: fs.readFileSync(r.file), signal: r.signal });
      if (!up.ok) throw new OAuthError(`TikTok video upload failed (HTTP ${up.status}): ${(await up.text()).slice(0, 300)}`);
      return { remoteId: init.publish_id, appliedPrivacy: privacy, notes };
    },
    async verify(t, publishId) {
      const d = (await json(await f(`${TT}/post/publish/status/fetch/`, { method: 'POST', headers: auth(t), body: JSON.stringify({ publish_id: publishId }) }), 'TikTok publish status')).data as Record<string, unknown>;
      const status = String(d.status);
      const ids = (d.publicaly_available_post_id as (string | number)[] | undefined) ?? [];
      if (status === 'PUBLISH_COMPLETE') return { state: 'published', url: ids.length ? `https://www.tiktok.com/video/${ids[0]}` : null, detail: ids.length ? 'Published' : 'Published (private: no public link; visible in the TikTok app)' };
      if (status === 'FAILED') return { state: 'failed', url: null, detail: `TikTok rejected the post: ${d.fail_reason ?? 'unknown reason'}` };
      return { state: 'processing', url: null, detail: status };
    }
  };
}

// ---- YouTube: OAuth for installed apps + Data API v3 resumable upload ------------------------------

export function youtubeClient(f: FetchFn = fetch): PlatformClient {
  const tokens = (b: Record<string, unknown>, prev?: TokenSet): TokenSet => ({
    accessToken: String(b.access_token),
    refreshToken: b.refresh_token ? String(b.refresh_token) : (prev?.refreshToken ?? null),
    expiresAt: inSeconds(Number(b.expires_in)),
    refreshExpiresAt: null,
    scopes: String(b.scope ?? prev?.scopes.join(' ') ?? '').split(/\s+/).filter(Boolean)
  });
  const bearer = (t: TokenSet) => ({ Authorization: `Bearer ${t.accessToken}` });
  return {
    platform: 'youtube',
    async authorize(app, open, signal) {
      const p = pkce('base64url');
      const { code, redirectUri } = await loopbackAuthorize({
        port: app.redirectPort,
        open,
        signal,
        buildAuthUrl: (redirect, state) =>
          `https://accounts.google.com/o/oauth2/v2/auth?${form({ client_id: app.clientId, redirect_uri: redirect, response_type: 'code', scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly', access_type: 'offline', prompt: 'consent', state, code_challenge: p.challenge, code_challenge_method: 'S256' })}`
      });
      const t = tokens(await json(await f('https://oauth2.googleapis.com/token', { method: 'POST', headers: FORM, body: form({ client_id: app.clientId, client_secret: app.clientSecret, code, code_verifier: p.verifier, grant_type: 'authorization_code', redirect_uri: redirectUri }) }), 'Google token exchange'));
      const ch = ((await json(await f('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: bearer(t) }), 'YouTube channel')).items as Record<string, any>[] | undefined)?.[0];
      if (!ch) throw new OAuthError('This Google account has no YouTube channel. Create the channel first, then connect.');
      return { tokens: t, profile: { externalId: ch.id, handle: ch.snippet.customUrl ?? ch.snippet.title, displayName: ch.snippet.title, avatarUrl: ch.snippet.thumbnails?.default?.url ?? '', canPublishPublic: true, restrictions: ['Unverified Google API projects may have uploads locked to private.'] } };
    },
    async refresh(app, prev) {
      if (!prev.refreshToken) throw new OAuthError('YouTube session expired; reconnect the account.');
      return tokens(await json(await f('https://oauth2.googleapis.com/token', { method: 'POST', headers: FORM, body: form({ client_id: app.clientId, client_secret: app.clientSecret, grant_type: 'refresh_token', refresh_token: prev.refreshToken }) }), 'Google token refresh'), prev);
    },
    async publish(r) {
      const size = fs.statSync(r.file).size;
      const meta = {
        snippet: { title: r.metadata.title.slice(0, 100), description: r.metadata.caption.slice(0, 5000), tags: r.metadata.hashtags.map((h) => h.replace(/^#/, '')), categoryId: '28' },
        status: { privacyStatus: r.privacy, selfDeclaredMadeForKids: false, containsSyntheticMedia: r.metadata.aiDisclosure }
      };
      const start = await f('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
        method: 'POST',
        headers: { ...bearer(r.tokens), 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(size) },
        body: JSON.stringify(meta)
      });
      if (!start.ok) await json(start, 'YouTube upload start');
      const location = start.headers.get('location');
      if (!location) throw new OAuthError('YouTube did not return an upload location.');
      const video = await json(await f(location, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size) }, body: fs.readFileSync(r.file), signal: r.signal }), 'YouTube upload');
      const applied = String((video.status as Record<string, unknown> | undefined)?.privacyStatus ?? r.privacy);
      return { remoteId: String(video.id), appliedPrivacy: applied, notes: applied !== r.privacy ? [`YouTube set the video to ${applied} (requested ${r.privacy}); unverified API projects may be locked to private.`] : [] };
    },
    async verify(t, id) {
      const v = ((await json(await f(`https://www.googleapis.com/youtube/v3/videos?part=status&id=${encodeURIComponent(id)}`, { headers: bearer(t) }), 'YouTube status')).items as Record<string, any>[] | undefined)?.[0];
      if (!v) return { state: 'processing', url: null, detail: 'not visible yet' };
      const s = v.status.uploadStatus as string;
      if (s === 'failed' || s === 'rejected') return { state: 'failed', url: null, detail: `${s}: ${v.status.failureReason ?? v.status.rejectionReason ?? ''}` };
      return { state: s === 'processed' ? 'published' : 'processing', url: `https://youtube.com/shorts/${id}`, detail: `${s} · ${v.status.privacyStatus}` };
    }
  };
}

// ---- Instagram: Instagram API with Instagram Login (token from Meta App Dashboard) ------------------

const IG = 'https://graph.instagram.com/v23.0';

export function instagramClient(f: FetchFn = fetch): PlatformClient {
  return {
    platform: 'instagram',
    async authorize(app) {
      // Meta requires an HTTPS redirect for Instagram Login, which a desktop app cannot host; use the
      // official App Dashboard token generator for the professional account instead.
      if (!app.accessToken) throw new OAuthError('Paste the Instagram access token generated for this professional account in Meta App Dashboard → Instagram → API setup.');
      const me = await json(await f(`${IG}/me?fields=user_id,username,profile_picture_url&access_token=${encodeURIComponent(app.accessToken)}`), 'Instagram profile');
      const tokens: TokenSet = { accessToken: app.accessToken, refreshToken: null, expiresAt: inSeconds(60 * 86400), refreshExpiresAt: null, scopes: ['instagram_business_basic', 'instagram_business_content_publish'], userId: String(me.user_id ?? me.id) };
      return { tokens, profile: { externalId: tokens.userId!, handle: `@${String(me.username)}`, displayName: String(me.username), avatarUrl: String(me.profile_picture_url ?? ''), canPublishPublic: true, restrictions: ['Instagram API posts are always public.', 'Needs the video at a public HTTPS URL.'] } };
    },
    async refresh(_app, prev) {
      const b = await json(await f(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(prev.accessToken)}`), 'Instagram token refresh');
      return { ...prev, accessToken: String(b.access_token), expiresAt: inSeconds(Number(b.expires_in)) };
    },
    async publish(r) {
      if (!r.app.publicVideoBaseUrl) throw new OAuthError('Instagram fetches the video from a public HTTPS URL. Set a public video location for Instagram first.');
      const videoUrl = `${r.app.publicVideoBaseUrl.replace(/\/$/, '')}/${r.productionId}.mp4`;
      const q = (o: Record<string, string>) => form({ ...o, access_token: r.tokens.accessToken });
      const c = await json(await f(`${IG}/${r.tokens.userId}/media`, { method: 'POST', headers: FORM, body: q({ media_type: 'REELS', video_url: videoUrl, caption: r.metadata.caption.slice(0, 2200), share_to_feed: 'true' }) }), 'Instagram container');
      const id = String(c.id);
      for (let i = 0; i < 60; i++) {
        const s = await json(await f(`${IG}/${id}?fields=status_code,status&access_token=${encodeURIComponent(r.tokens.accessToken)}`), 'Instagram container status');
        if (s.status_code === 'FINISHED') break;
        if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new OAuthError(`Instagram could not process the video: ${s.status ?? s.status_code}`);
        await new Promise((res) => setTimeout(res, 5000));
      }
      const m = await json(await f(`${IG}/${r.tokens.userId}/media_publish`, { method: 'POST', headers: FORM, body: q({ creation_id: id }) }), 'Instagram publish');
      return { remoteId: String(m.id), appliedPrivacy: 'public', notes: ['Instagram API posts are public; there is no private option.'] };
    },
    async verify(t, id) {
      const m = await json(await f(`${IG}/${id}?fields=permalink,media_type&access_token=${encodeURIComponent(t.accessToken)}`), 'Instagram media');
      return { state: m.permalink ? 'published' : 'processing', url: m.permalink ? String(m.permalink) : null, detail: String(m.media_type ?? '') };
    }
  };
}

export const defaultClients = (): Record<Platform, PlatformClient> => ({ tiktok: tiktokClient(), youtube: youtubeClient(), instagram: instagramClient() });
