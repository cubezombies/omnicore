import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/main/db/database';
import { OperationsRepository } from '../src/main/db/operations';
import { ProductionRepository } from '../src/main/db/productions';
import { AuditLedger } from '../src/main/audit/ledger';
import { Publisher, PublishBlockedError } from '../src/main/publishing/publisher';
import { instagramClient, tiktokClient, youtubeClient, type FetchFn } from '../src/main/publishing/platforms';
import { pkce, type SecretBox } from '../src/main/publishing/oauth';
import { OperatingEngine } from '../src/main/autonomy/engine';

/** Fake DPAPI: reversible but never plain text. */
const box: SecretBox = {
  available: () => true,
  encrypt: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from(Buffer.from(b).map((x) => x ^ 0x5a)).toString('utf8')
};

const ok = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

/** A fake TikTok API that records calls; privacy options mimic an unaudited app. */
function fakeTikTok(opts: { username?: string; privacy?: string[] } = {}) {
  const calls: { url: string; body: string }[] = [];
  let polls = 0;
  const f: FetchFn = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
    if (url.includes('/oauth/token/')) return ok({ access_token: 'AT-secret', refresh_token: 'RT-secret', expires_in: 86400, refresh_expires_in: 31536000, open_id: 'open-1', scope: 'user.info.basic,video.publish' });
    if (url.includes('/user/info/')) return ok({ data: { user: { open_id: 'open-1', display_name: 'AI, Actually', avatar_url: '' } }, error: { code: 'ok' } });
    if (url.includes('/creator_info/')) return ok({ data: { creator_username: opts.username ?? 'aiactually', privacy_level_options: opts.privacy ?? ['SELF_ONLY'], comment_disabled: false, duet_disabled: false, stitch_disabled: false }, error: { code: 'ok' } });
    if (url.includes('/video/init/')) return ok({ data: { publish_id: 'pub-123', upload_url: 'https://upload.example/u1' }, error: { code: 'ok' } });
    if (url.startsWith('https://upload.example/')) return new Response('', { status: 201 });
    if (url.includes('/status/fetch/')) return ok({ data: { status: ++polls < 2 ? 'PROCESSING_UPLOAD' : 'PUBLISH_COMPLETE', publicaly_available_post_id: [] }, error: { code: 'ok' } });
    return new Response('not found', { status: 404 });
  };
  return { f, calls };
}

/** Plays the user's browser: follows the auth URL straight to the loopback redirect with a code. */
const browser = async (authUrl: string) => {
  const u = new URL(authUrl);
  const back = new URL(u.searchParams.get('redirect_uri')!);
  back.searchParams.set('code', 'CODE');
  back.searchParams.set('state', u.searchParams.get('state')!);
  await fetch(back);
};

let db: DatabaseSync;
let ops: OperationsRepository;
let productions: ProductionRepository;
let audit: AuditLedger;
let dir: string;

beforeEach(() => {
  db = openDatabase(':memory:');
  ops = new OperationsRepository(db);
  productions = new ProductionRepository(db);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-pub-'));
  audit = new AuditLedger(db, path.join(dir, 'evidence'));
});

function setup(tt = fakeTikTok()) {
  const publisher = new Publisher({ db, ops, productions, audit, box, clients: { tiktok: tiktokClient(tt.f), youtube: youtubeClient(tt.f), instagram: instagramClient(tt.f) }, open: browser, verifyWaitMs: 2000, pollMs: 10 });
  publisher.saveApp('tiktok', { clientId: 'ck', clientSecret: 'cs-secret', redirectPort: 0 });
  const acct = ops.addAccount('tiktok', '@aiactually');
  ops.setDestination(1, 'tiktok', { accountId: acct.id, enabled: true, privacy: 'private' });
  return { publisher, acct, tt };
}

function readyProduction(qa: 'passed' | 'failed' = 'passed', approval = 'approved') {
  const p = productions.create(1, 'GPT-6 launches', null, '', 'news', { destinations: ops.resolveDestinations(1) });
  const out = path.join(dir, `${p.id}.mp4`);
  fs.writeFileSync(out, Buffer.alloc(2048, 1));
  db.prepare(`UPDATE productions SET status = 'completed', output_path = ?, approval = ?, metadata = ? WHERE id = ?`).run(
    out,
    approval,
    JSON.stringify({ tiktok: { platform: 'tiktok', title: 'GPT-6, actually', caption: 'GPT-6 launched. #AI', hashtags: ['#AI'], aiDisclosure: true, credits: '', manualSteps: [] } }),
    p.id
  );
  ops.saveQaRun(p.id, 1, qa, { critical: 0, major: qa === 'passed' ? 0 : 1, minor: 0, checks: 26, repairs: [] }, []);
  return p.id;
}

describe('accounts: official OAuth and encrypted tokens', () => {
  it('uses PKCE (hex for TikTok desktop, base64url for Google)', () => {
    expect(pkce('hex').challenge).toMatch(/^[0-9a-f]{64}$/);
    expect(pkce('base64url').challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('connects through the loopback redirect, stores tokens encrypted and records capabilities', async () => {
    const { publisher, acct, tt } = setup();
    const a = await publisher.connect(acct.id);
    expect(a.status).toBe('connected');
    expect(a.capabilities).toMatchObject({ canPublishPrivate: true, canPublishPublic: false, financial: false });
    expect(tt.calls.find((c) => c.url.includes('/oauth/token/'))?.body).toMatch(/code_verifier=/);
    const raw = Buffer.from(ops.readToken(acct.id)!).toString('utf8');
    expect(raw).not.toContain('AT-secret');
    const settingsDump = JSON.stringify(db.prepare('SELECT * FROM settings').all());
    expect(settingsDump).not.toContain('cs-secret');
    expect(publisher.appSummary('tiktok')).toMatchObject({ configured: true, hasSecret: true, clientId: 'ck' });
  });

  it('refuses to attach a different account than the one registered', async () => {
    const { publisher, acct } = setup(fakeTikTok({ username: 'someoneelse' }));
    await expect(publisher.connect(acct.id)).rejects.toThrow(/signed in as @someoneelse/);
    expect(ops.getAccount(acct.id).status).toBe('not_connected');
    expect(ops.readToken(acct.id)).toBeNull();
  });
});

describe('publishing gates and verification', () => {
  it('a production made before the account was assigned follows the later explicit assignment', async () => {
    const { publisher, acct } = setup();
    ops.setDestination(1, 'tiktok', { accountId: null, enabled: true, privacy: 'private' });
    const id = readyProduction();
    expect(publisher.blockers(id, 'tiktok').join(' ')).toMatch(/No tiktok account is assigned/);
    await publisher.connect(acct.id);
    ops.setDestination(1, 'tiktok', { accountId: acct.id, enabled: true, privacy: 'private' });
    publisher.refreshDestinations(1);
    expect(productions.get(id).destinations[0]).toMatchObject({ accountId: acct.id, handle: '@aiactually', privacy: 'private', blockers: [] });
    expect(publisher.blockers(id, 'tiktok')).toEqual([]);
  });

  it('re-links a finished video whose output path was lost by a QA re-run', () => {
    const { publisher } = setup();
    const id = readyProduction();
    fs.mkdirSync(path.join(dir, String(id)), { recursive: true });
    fs.writeFileSync(path.join(dir, String(id), 'final.mp4'), Buffer.alloc(2048, 1));
    productions.addAsset(id, { kind: 'video', sceneIndex: null, path: 'final.mp4', provider: 'ffmpeg', meta: { durationSec: 36.4 } });
    productions.update(id, { outputPath: null, durationSec: null });
    expect(publisher.blockers(id, 'tiktok')).toContain('The video is not finished.');
    expect(productions.restoreOutputs(dir)).toEqual([id]);
    expect(productions.get(id)).toMatchObject({ outputPath: path.join(dir, String(id), 'final.mp4'), durationSec: 36.4 });
    expect(publisher.blockers(id, 'tiktok')).not.toContain('The video is not finished.');
  });

  it('blocks unapproved, QA-failed or unconnected content', async () => {
    const { publisher, acct } = setup();
    const unconnected = readyProduction();
    expect(publisher.blockers(unconnected, 'tiktok').join(' ')).toMatch(/not connected/);
    await publisher.connect(acct.id);
    expect(publisher.blockers(readyProduction('failed'), 'tiktok').join(' ')).toMatch(/Quality check has not passed/);
    expect(publisher.blockers(readyProduction('passed', 'awaiting_review'), 'tiktok')).toContain('Not approved for publication.');
    await expect(publisher.publish(readyProduction('failed'), 'tiktok', 'user')).rejects.toThrow(PublishBlockedError);
  });

  it('publishes to TikTok with the AI label, never escalates privacy, and records only a platform-verified post', async () => {
    const { publisher, acct, tt } = setup(fakeTikTok({ privacy: ['SELF_ONLY'] }));
    await publisher.connect(acct.id);
    const id = readyProduction();
    const pub = await publisher.publish(id, 'tiktok', 'user');
    const init = JSON.parse(tt.calls.find((c) => c.url.includes('/video/init/'))!.body);
    expect(init.post_info).toMatchObject({ privacy_level: 'SELF_ONLY', is_aigc: true, brand_content_toggle: false });
    expect(init.source_info).toMatchObject({ source: 'FILE_UPLOAD', video_size: 2048, total_chunk_count: 1 });
    expect(pub).toMatchObject({ status: 'published', remoteId: 'pub-123', privacyApplied: 'SELF_ONLY' });
    expect(productions.get(id).publishStatus).toBe('published');
    expect(audit.events({ productionId: id }).map((e) => e.type)).toEqual(expect.arrayContaining(['publish.started', 'publish.submitted', 'publish.verified']));
    expect(publisher.blockers(id, 'tiktok').join(' ')).toMatch(/Already published/);
    // A private post never unlocks auto-publish.
    expect(publisher.hasUserApprovedPublicPost()).toBe(false);
  });

  it('posts exactly what the user chose on the TikTok posting screen', async () => {
    const { publisher, acct, tt } = setup(fakeTikTok({ privacy: ['FOLLOWER_OF_CREATOR', 'SELF_ONLY'] }));
    await publisher.connect(acct.id);
    const info = await publisher.tiktokCreatorInfo(readyProduction());
    expect(info).toMatchObject({ username: 'aiactually', privacyLevelOptions: ['FOLLOWER_OF_CREATOR', 'SELF_ONLY'], commentDisabled: false });
    const choice = { privacyLevel: 'FOLLOWER_OF_CREATOR', caption: 'Edited caption #AI', allowComment: true, allowDuet: false, allowStitch: false, brandOrganic: true, brandContent: false };
    const id = readyProduction();
    const pub = await publisher.publish(id, 'tiktok', 'user', undefined, choice);
    const init = JSON.parse(tt.calls.filter((c) => c.url.includes('/video/init/')).at(-1)!.body);
    expect(init.post_info).toMatchObject({ title: 'Edited caption #AI', privacy_level: 'FOLLOWER_OF_CREATOR', disable_comment: false, disable_duet: true, disable_stitch: true, brand_organic_toggle: true, brand_content_toggle: false, is_aigc: true });
    expect(pub).toMatchObject({ privacyRequested: 'FOLLOWER_OF_CREATOR', privacyApplied: 'FOLLOWER_OF_CREATOR' });
    // A level TikTok doesn't offer is refused, never swapped for another one.
    await expect(publisher.publish(readyProduction(), 'tiktok', 'user', undefined, { ...choice, privacyLevel: 'PUBLIC_TO_EVERYONE' })).rejects.toThrow(/no longer offers/);
  });

  it('auto-publishes only after a user-approved public post exists', async () => {
    const { publisher, acct } = setup(fakeTikTok({ privacy: ['SELF_ONLY', 'PUBLIC_TO_EVERYONE'] }));
    await publisher.connect(acct.id);
    ops.saveAutonomy({ ...ops.getAutonomy(), autoPublish: true });
    const runner = { busy: () => true, enqueue: () => {}, retry: () => {} };
    const engine = new OperatingEngine({ ops, productions, audit, runner: runner as never, publisher, discover: async () => ({ items: 0, candidates: [], sourceReports: [] }) });
    const auto = readyProduction('passed', 'awaiting_review');
    db.prepare(`UPDATE productions SET origin = 'autonomous' WHERE id = ?`).run(auto);
    await engine.autoPublish(1);
    expect(productions.get(auto).approval).toBe('awaiting_review'); // no user-approved public post yet

    ops.setDestination(1, 'tiktok', { accountId: acct.id, enabled: true, privacy: 'public' });
    const first = readyProduction();
    await publisher.publish(first, 'tiktok', 'user');
    expect(publisher.hasUserApprovedPublicPost()).toBe(true);

    await engine.autoPublish(1);
    expect(productions.get(auto).approval).toBe('approved');
    expect(publisher.publications(auto)[0]?.status).toBe('published');
  });
});
