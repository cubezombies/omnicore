import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, openDatabase } from '../src/main/db/database';
import { OperationsRepository } from '../src/main/db/operations';
import { ProductionRepository } from '../src/main/db/productions';
import { AuditLedger } from '../src/main/audit/ledger';
import { Publisher } from '../src/main/publishing/publisher';
import { instagramClient, tiktokClient, youtubeClient, type FetchFn } from '../src/main/publishing/platforms';
import type { SecretBox } from '../src/main/publishing/oauth';
import { destinationStatuses, publicationState } from '../src/shared/publicationStatus';
import type { Publication } from '../src/shared/operations';

const box: SecretBox = {
  available: () => true,
  encrypt: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from(Buffer.from(b).map((x) => x ^ 0x5a)).toString('utf8')
};
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** A fake TikTok: `mode` decides what happens after the upload. */
function fakeTikTok(mode: 'complete' | 'processing' | 'init-fails' = 'complete') {
  let n = 0;
  const f: FetchFn = async (input) => {
    const url = String(input);
    if (url.includes('/oauth/token/')) return ok({ access_token: 'AT', refresh_token: 'RT', expires_in: 86400, refresh_expires_in: 31536000, open_id: 'open-1', scope: 'user.info.basic,video.publish' });
    if (url.includes('/user/info/')) return ok({ data: { user: { open_id: 'open-1', display_name: 'AI, Actually', avatar_url: '' } }, error: { code: 'ok' } });
    if (url.includes('/creator_info/')) return ok({ data: { creator_username: 'aiactually', privacy_level_options: ['SELF_ONLY'], comment_disabled: false, duet_disabled: false, stitch_disabled: false }, error: { code: 'ok' } });
    if (url.includes('/video/init/')) return mode === 'init-fails' ? new Response(JSON.stringify({ error: { code: 'unaudited_client_can_only_post_to_private_accounts', message: 'x' } }), { status: 403 }) : ok({ data: { publish_id: `pub-${++n}`, upload_url: 'https://upload.example/u1' }, error: { code: 'ok' } });
    if (url.startsWith('https://upload.example/')) return new Response('', { status: 201 });
    if (url.includes('/status/fetch/')) return ok({ data: { status: mode === 'processing' ? 'PROCESSING_UPLOAD' : 'PUBLISH_COMPLETE', publicaly_available_post_id: [] }, error: { code: 'ok' } });
    return new Response('not found', { status: 404 });
  };
  return f;
}
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubstat-'));
  audit = new AuditLedger(db, path.join(dir, 'evidence'));
});

async function setup(mode: 'complete' | 'processing' | 'init-fails' = 'complete') {
  const f = fakeTikTok(mode);
  const publisher = new Publisher({ db, ops, productions, audit, box, clients: { tiktok: tiktokClient(f), youtube: youtubeClient(f), instagram: instagramClient(f) }, open: browser, verifyWaitMs: 50, pollMs: 10 });
  publisher.saveApp(1, 'tiktok', { clientId: 'ck', clientSecret: 'cs', redirectPort: 0 });
  const acct = ops.addAccount(1, 'tiktok', '@aiactually');
  ops.setDestination(1, 'tiktok', { accountId: acct.id, enabled: true, privacy: 'private' });
  await publisher.connect(acct.id);
  return publisher;
}
function ready(bytes = 1) {
  const p = productions.create(1, 'GPT-6 launches', null, '', 'news', { destinations: ops.resolveDestinations(1) });
  const out = path.join(dir, `${p.id}-${bytes}.mp4`);
  fs.writeFileSync(out, Buffer.alloc(2048, bytes));
  db.prepare(`UPDATE productions SET status = 'completed', output_path = ?, approval = 'approved', metadata = ? WHERE id = ?`).run(out, JSON.stringify({ tiktok: { platform: 'tiktok', title: 't', caption: 'c #AI', hashtags: ['#AI'], aiDisclosure: true, credits: '', manualSteps: [] } }), p.id);
  ops.saveQaRun(p.id, 1, 'passed', { critical: 0, major: 0, minor: 0, checks: 26, repairs: [] }, [{ checkId: 'audio.gate', category: 'audio', severity: 'critical', passed: true, message: 'Audio gate passed', evidence: {}, repair: '' }]);
  return p.id;
}
const pub = (over: Partial<Publication>): Publication => ({ id: 1, productionId: 1, platform: 'tiktok', accountId: 1, privacyRequested: 'SELF_ONLY', privacyApplied: '', status: 'uploading', remoteId: '', url: '', detail: '', approvedBy: 'user', createdAt: '', updatedAt: '', productionNumber: 1, productionTopic: '', accountHandle: '', renderSha256: '', uploadedAt: null, publishedAt: null, failedAt: null, deletedAt: null, deletionSource: '', deletionNote: '', restoredFrom: '', ...over });

describe('publication states (pure)', () => {
  it('maps every state without conflating them', () => {
    expect(publicationState(pub({ status: 'uploading' }))).toBe('uploading');
    expect(publicationState(pub({ status: 'processing', remoteId: 'r' }))).toBe('uploaded');
    expect(publicationState(pub({ status: 'published', privacyApplied: 'SELF_ONLY' }))).toBe('private');
    expect(publicationState(pub({ status: 'published', privacyApplied: 'PUBLIC_TO_EVERYONE' }))).toBe('published');
    expect(publicationState(pub({ status: 'published', privacyApplied: 'FOLLOWER_OF_CREATOR' }))).toBe('private');
    expect(publicationState(pub({ status: 'failed' }))).toBe('failed');
    expect(publicationState(pub({ status: 'published', privacyApplied: 'PUBLIC_TO_EVERYONE', deletedAt: '2026-11-27T00:00:00Z' }))).toBe('deleted');
  });

  it('walks review → approved → attempts → deleted → corrected render approved', () => {
    const dest = [{ platform: 'tiktok' as const, handle: '@a' }];
    expect(destinationStatuses({ status: 'running', approval: 'none', destinations: dest }, [])[0].state).toBeNull();
    expect(destinationStatuses({ status: 'completed', approval: 'awaiting_review', destinations: dest }, [], 'passed')[0].state).toBe('ready_for_review');
    // Production 21: QA failed (60.5 s < 61 s) yet the badge read "Ready for review".
    expect(destinationStatuses({ status: 'completed', approval: 'awaiting_review', destinations: dest }, [], 'failed')[0].state).toBe('needs_fixes');
    expect(destinationStatuses({ status: 'completed', approval: 'awaiting_review', destinations: dest }, [])[0].state).toBe('needs_fixes');
    expect(destinationStatuses({ status: 'completed', approval: 'approved', destinations: dest }, [])[0].state).toBe('approved');
    const failed = pub({ id: 1, status: 'failed' });
    const priv = pub({ id: 2, status: 'published', privacyApplied: 'SELF_ONLY' });
    const s = destinationStatuses({ status: 'completed', approval: 'approved', destinations: dest }, [failed, priv])[0];
    expect(s).toMatchObject({ state: 'private', attempts: 2 });
    expect(s.publication?.id).toBe(2);
    const deleted = { ...priv, deletedAt: '2026-11-27T01:00:00Z' };
    expect(destinationStatuses({ status: 'completed', approval: 'none', destinations: dest }, [failed, deleted])[0].state).toBe('deleted');
    expect(destinationStatuses({ status: 'completed', approval: 'awaiting_review', destinations: dest }, [failed, deleted], 'passed')[0].state).toBe('ready_for_review');
    expect(destinationStatuses({ status: 'completed', approval: 'awaiting_review', destinations: dest }, [failed, deleted], 'failed')[0].state).toBe('needs_fixes');
  });
});

describe('publication lifecycle against the destination', () => {
  it('private TikTok post: upload and publication times recorded separately, state Private', async () => {
    const publisher = await setup('complete');
    const id = ready();
    const p = await publisher.publish(id, 'tiktok', 'user');
    expect(p).toMatchObject({ status: 'published', privacyApplied: 'SELF_ONLY', accountHandle: '@aiactually', productionNumber: id, productionTopic: 'GPT-6 launches' });
    expect(p.uploadedAt).toBeTruthy();
    expect(p.publishedAt).toBeTruthy();
    expect(p.renderSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(publicationState(p)).toBe('private');
  });

  it('upload accepted but not confirmed: Uploaded, never Published', async () => {
    const publisher = await setup('processing');
    const id = ready();
    const p = await publisher.publish(id, 'tiktok', 'user');
    expect(p.status).toBe('processing');
    expect(p.uploadedAt).toBeTruthy();
    expect(p.publishedAt).toBeNull();
    expect(publicationState(p)).toBe('uploaded');
    expect(productions.get(id).publishStatus).toBe('publishing');
  });

  it('failed upload: Failed with its time, and a retry is a new record', async () => {
    const publisher = await setup('init-fails');
    const id = ready();
    await expect(publisher.publish(id, 'tiktok', 'user')).rejects.toThrow();
    const [p] = publisher.publications(id);
    expect(publicationState(p)).toBe('failed');
    expect(p.failedAt).toBeTruthy();
    expect(p.uploadedAt).toBeNull();
  });

  it('deleted post: only recorded by the user, history kept, a corrected render becomes a new attempt', async () => {
    const publisher = await setup('complete');
    const id = ready(1);
    const first = await publisher.publish(id, 'tiktok', 'user');
    expect(publisher.blockers(id, 'tiktok').join(' ')).toMatch(/Already published/);
    const del = publisher.recordDeletion(first.id, 1, 'user', 'removed in the TikTok app');
    expect(publicationState(del)).toBe('deleted');
    expect(del).toMatchObject({ deletionSource: 'user', deletionNote: 'removed in the TikTok app' });
    expect(del.publishedAt).toBe(first.publishedAt); // original publication time kept
    expect(() => publisher.recordDeletion(first.id, 1, 'user', '')).toThrow(/already recorded/);
    expect(audit.events({ productionId: id }).map((e) => e.type)).toContain('publish.deleted');
    expect(productions.get(id).publishStatus).toBe('not_published');
    // Corrected render: a different file, a new attempt; the deleted one is untouched.
    const out = path.join(dir, 'corrected.mp4');
    fs.writeFileSync(out, Buffer.alloc(4096, 7));
    db.prepare('UPDATE productions SET output_path = ? WHERE id = ?').run(out, id);
    expect(publisher.blockers(id, 'tiktok').join(' ')).not.toMatch(/Already/);
    const second = await publisher.publish(id, 'tiktok', 'user');
    const all = publisher.publications(id);
    expect(all.map((x) => [x.id, publicationState(x)])).toEqual([
      [first.id, 'deleted'],
      [second.id, 'private']
    ]);
    expect(second.renderSha256).not.toBe(first.renderSha256);
  });

  it('refuses to record a deletion for a post that never reached the platform, or for another business', async () => {
    const publisher = await setup('init-fails');
    const id = ready();
    await expect(publisher.publish(id, 'tiktok', 'user')).rejects.toThrow();
    const [p] = publisher.publications(id);
    expect(() => publisher.recordDeletion(p.id, 1, 'user', '')).toThrow(/never reached|reached the platform/);
    expect(() => publisher.recordDeletion(p.id, 999, 'user', '')).toThrow(/not found/);
  });

  it('keeps publication history when the production is deleted', async () => {
    const publisher = await setup('complete');
    const id = ready();
    const p = await publisher.publish(id, 'tiktok', 'user');
    productions.delete(id);
    const kept = publisher.publicationHistory(1).find((x) => x.id === p.id)!;
    expect(kept).toMatchObject({ productionId: null, productionNumber: id, productionTopic: 'GPT-6 launches', status: 'published', remoteId: p.remoteId });
  });
});

describe('persistence and migration', () => {
  it('statuses survive closing and reopening the database', async () => {
    const file = path.join(dir, 'persist.db');
    db = openDatabase(file);
    ops = new OperationsRepository(db);
    productions = new ProductionRepository(db);
    audit = new AuditLedger(db, path.join(dir, 'ev2'));
    const publisher = await setup('complete');
    const id = ready();
    const p = await publisher.publish(id, 'tiktok', 'user');
    publisher.recordDeletion(p.id, 1, 'user', 'gone');
    db.close();
    const again = openDatabase(file);
    const row = again.prepare('SELECT status, privacy_applied, uploaded_at, published_at, deleted_at, deletion_note FROM publications WHERE id = ?').get(p.id) as Record<string, string>;
    expect(row).toMatchObject({ status: 'published', privacy_applied: 'SELF_ONLY', deletion_note: 'gone' });
    expect(row.uploaded_at && row.published_at && row.deleted_at).toBeTruthy();
    again.close();
  });

  it('v14 backfills times from the audit log, removes the cascade and restores a publication lost to it', () => {
    const file = path.join(dir, 'v13.db');
    const old = new DatabaseSync(file);
    old.exec('PRAGMA foreign_keys = ON;');
    for (let v = 0; v < 13; v++) old.exec(MIGRATIONS[v]);
    old.exec('PRAGMA user_version = 13');
    const ch = Number((old.prepare('SELECT id FROM channels LIMIT 1').get() as { id: number }).id);
    const acct = Number(old.prepare("INSERT INTO platform_accounts (platform, handle, business_id) VALUES ('tiktok', '@aiactuallyofficial', ?)").run(ch).lastInsertRowid);
    const kept = Number(old.prepare("INSERT INTO productions (channel_id, topic) VALUES (?, 'kept')").run(ch).lastInsertRowid);
    old.prepare("INSERT INTO publications (production_id, platform, account_id, privacy_requested, privacy_applied, status, remote_id, created_at, updated_at) VALUES (?, 'tiktok', ?, 'SELF_ONLY', 'SELF_ONLY', 'published', 'v_kept', '2026-11-27T01:00:00Z', '2026-11-27T01:00:12Z')").run(kept, acct);
    const ev = (ts: string, actor: string, type: string, pid: number, data: unknown) => old.prepare("INSERT INTO audit_events (ts, actor, type, production_id, data, prev_hash, hash) VALUES (?,?,?,?,?,'x',?)").run(ts, actor, type, pid, JSON.stringify(data), `${type}-${pid}-${ts}`);
    ev('2026-11-27T01:00:05Z', 'user', 'publish.submitted', kept, { platform: 'tiktok', remoteId: 'v_kept', appliedPrivacy: 'SELF_ONLY' });
    ev('2026-11-27T01:00:12Z', 'engine', 'publish.verified', kept, { platform: 'tiktok', remoteId: 'v_kept' });
    // Production 19's story: published privately, then the production was deleted and the row cascaded away.
    ev('2026-11-27T22:38:01Z', 'user', 'publish.started', 19, { platform: 'tiktok', accountId: acct, handle: '@aiactuallyofficial', privacy: 'SELF_ONLY', approvedBy: 'user' });
    ev('2026-11-27T22:38:05Z', 'user', 'publish.submitted', 19, { platform: 'tiktok', remoteId: 'v_lost', appliedPrivacy: 'SELF_ONLY' });
    ev('2026-11-27T22:38:14Z', 'engine', 'publish.verified', 19, { platform: 'tiktok', remoteId: 'v_lost', url: null, detail: 'Published (private)' });
    ev('2026-11-27T23:44:22Z', 'user', 'production.deleted', 19, { topic: 'build maintain agentic evaluation' });
    old.close();
    const up = openDatabase(file);
    const rows = up.prepare('SELECT production_id, production_number, production_topic, account_handle, privacy_applied, status, remote_id, uploaded_at, published_at, restored_from FROM publications ORDER BY id').all() as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ production_id: kept, remote_id: 'v_kept', uploaded_at: '2026-11-27T01:00:05Z', published_at: '2026-11-27T01:00:12Z', account_handle: '@aiactuallyofficial', restored_from: '' });
    expect(rows[1]).toMatchObject({ production_id: null, production_number: 19, production_topic: 'build maintain agentic evaluation', account_handle: '@aiactuallyofficial', privacy_applied: 'SELF_ONLY', status: 'published', remote_id: 'v_lost', uploaded_at: '2026-11-27T22:38:05Z', published_at: '2026-11-27T22:38:14Z' });
    expect(String(rows[1].restored_from)).toMatch(/^audit:\d+$/);
    // No cascade any more: deleting a production keeps its publications.
    up.prepare('DELETE FROM productions WHERE id = ?').run(kept);
    expect((up.prepare("SELECT COUNT(*) n FROM publications WHERE remote_id = 'v_kept'").get() as { n: number }).n).toBe(1);
    up.close();
  });
});
