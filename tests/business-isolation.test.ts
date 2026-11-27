import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, SCHEMA_VERSION } from '../src/main/db/database';
import { OperationsRepository } from '../src/main/db/operations';
import { ProductionRepository } from '../src/main/db/productions';
import { Repository } from '../src/main/db/repository';
import { AuditLedger } from '../src/main/audit/ledger';
import { BusinessRepository } from '../src/main/business/businesses';
import { TopicRepository } from '../src/main/business/topics';
import { BusinessContext, BusinessContextError } from '../src/main/business/context';
import { Publisher, PublishBlockedError } from '../src/main/publishing/publisher';
import { tiktokClient, youtubeClient, instagramClient } from '../src/main/publishing/platforms';
import type { SecretBox } from '../src/main/publishing/oauth';
import { OperatingEngine } from '../src/main/autonomy/engine';
import { PronunciationRepository } from '../src/main/pronunciation/dictionary';

// Capture the real IPC handlers without Electron.
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(ch, fn) },
  shell: { showItemInFolder: () => {}, openPath: async () => '' },
  dialog: {},
  BrowserWindow: { getAllWindows: () => [] }
}));
const { registerIpc } = await import('../src/main/ipc');
const { IPC } = await import('../src/shared/domain');

const box: SecretBox = { available: () => true, encrypt: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)), decrypt: (b) => Buffer.from(Buffer.from(b).map((x) => x ^ 0x5a)).toString('utf8') };
const noFetch = (async () => new Response('offline', { status: 503 })) as typeof fetch;

let db: DatabaseSync;
let ops: OperationsRepository;
let productions: ProductionRepository;
let businesses: BusinessRepository;
let topics: TopicRepository;
let ctx: BusinessContext;
let audit: AuditLedger;
let publisher: Publisher;
let A: number; // AI, Actually (seeded)
let B: number; // a second, unrelated business

const call = (key: keyof typeof IPC, ...args: unknown[]) => handlers.get(IPC[key])!({}, ...args);

beforeEach(() => {
  handlers.clear();
  db = openDatabase(':memory:');
  ops = new OperationsRepository(db);
  productions = new ProductionRepository(db);
  businesses = new BusinessRepository(db);
  topics = new TopicRepository(db);
  ctx = new BusinessContext(db, businesses);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-iso-'));
  audit = new AuditLedger(db, path.join(dir, 'evidence'));
  publisher = new Publisher({ db, ops, productions, audit, box, clients: { tiktok: tiktokClient(noFetch), youtube: youtubeClient(noFetch), instagram: instagramClient(noFetch) }, open: async () => {} });
  A = businesses.list()[0].id;
  B = businesses.create({ name: 'Ledger Labs', businessType: 'services', description: 'Bookkeeping agency' }).id;
  const runner = { enqueue: () => {}, retry: () => {}, rerun: () => {}, cancel: () => {}, delete: () => {}, busy: () => false, dirFor: (id: number) => path.join(dir, String(id)) };
  const engine = new OperatingEngine({ ops, productions, runner: runner as never, audit, topics, discover: async () => ({ items: 0, candidates: [], sourceReports: [] }) });
  registerIpc({
    repo: new Repository(db),
    productions,
    runner: runner as never,
    info: { version: 'test', dataDir: dir },
    dirs: { tmpDir: dir, toolsDir: dir },
    library: { list: () => [] } as never,
    samplesDir: dir,
    ops,
    audit,
    engine,
    publisher,
    isTrustedSender: () => true,
    businesses,
    topics,
    business: ctx,
    pronunciations: new PronunciationRepository(db)
  });
});

describe('business management', () => {
  it('migrates existing data to AI, Actually and creates new businesses from a type template', () => {
    expect(SCHEMA_VERSION).toBe(13);
    const a = businesses.get(A);
    expect(a).toMatchObject({ name: 'AI, Actually', businessType: 'media', modules: ['media'], archivedAt: null, presenterVoice: 'af_heart' });
    expect(businesses.get(B)).toMatchObject({ name: 'Ledger Labs', slug: 'ledger-labs', businessType: 'services', modules: ['services'] });
    expect(topics.list(A).map((t) => t.name)).toEqual(['AI models and releases', 'AI hardware', 'AI research', 'AI industry news', 'AI tools and applications', 'Robotics', 'Cybersecurity', 'AI regulation and policy']);
    expect(topics.list(B)).toEqual([]);
    expect(businesses.create({ name: 'Ledger Labs', businessType: 'other' }).slug).toBe('ledger-labs-2');
  });

  it('switches, archives and restores without affecting the other business', () => {
    expect(ctx.activeId()).toBe(A);
    expect((call('switchBusiness', B) as { id: number }).id).toBe(B);
    expect(() => call('archiveBusiness', B)).toThrow(/Switch to another business/);
    call('switchBusiness', A);
    call('archiveBusiness', B);
    expect(businesses.list().map((b) => b.id)).toEqual([A]);
    expect(() => call('switchBusiness', B)).toThrow(/archived/);
    expect(ops.brandIds()).toEqual([A]); // archived businesses get no automation
    call('restoreBusiness', B);
    expect(businesses.list().map((b) => b.id)).toEqual([A, B]);
    expect(businesses.get(A).archivedAt).toBeNull();
  });

  it('fails closed with no valid business context', () => {
    db.prepare("DELETE FROM settings WHERE key = 'activeBusiness'").run();
    expect(() => ctx.activeId()).toThrow(BusinessContextError);
    expect(() => call('listTopics')).toThrow(/No business is selected/);
    expect(() => call('listAccounts')).toThrow(/No business is selected/);
    expect(call('activeBusiness')).toBeNull();
    db.prepare("INSERT INTO settings (key, value) VALUES ('activeBusiness', '999')").run();
    expect(() => call('listIdeas')).toThrow(BusinessContextError);
  });

  it('only lets the active business be edited', () => {
    expect(() => call('updateBusiness', B, { name: 'Hijacked' })).toThrow(/different business/);
    expect(businesses.get(B).name).toBe('Ledger Labs');
    expect((call('updateBusiness', A, { objectives: 'Grow to 10k followers' }) as { objectives: string }).objectives).toBe('Grow to 10k followers');
  });
});

describe('topics', () => {
  it('are fully isolated even with identical names', () => {
    const ta = call('createTopic', { name: 'Pricing', keywords: ['subscription'] }) as { id: number };
    call('switchBusiness', B);
    const tb = call('createTopic', { name: 'Pricing', keywords: ['hourly rate'] }) as { id: number };
    expect((call('listTopics') as { name: string }[]).map((t) => t.name)).toEqual(['Pricing']);
    expect(() => call('updateTopic', ta.id, { name: 'stolen' })).toThrow(/not found in this business/);
    expect(() => call('archiveTopic', ta.id)).toThrow(/not found/);
    expect(() => call('createTopic', { name: 'child', parentId: ta.id })).toThrow(/not found/);
    expect(topics.get(A, ta.id).name).toBe('Pricing');
    call('switchBusiness', A);
    expect(() => call('updateTopic', tb.id, { enabled: false })).toThrow(/not found/);
  });

  it('support nesting, editing, reordering, enable/disable, archive, restore and guarded delete', () => {
    const parent = call('createTopic', { name: 'Hardware' }) as { id: number };
    const c1 = call('createTopic', { name: 'GPUs', parentId: parent.id }) as { id: number };
    const c2 = call('createTopic', { name: 'TPUs', parentId: parent.id }) as { id: number };
    call('updateTopic', c1.id, { description: 'Graphics processors', keywords: ['GPU', 'CUDA'], exclusions: ['gaming'], priority: 1, approvalRequired: true });
    call('reorderTopics', parent.id, [c2.id, c1.id]);
    const kids = (call('listTopics') as { id: number; parentId: number | null; position: number }[]).filter((t) => t.parentId === parent.id);
    expect(kids.map((k) => k.id)).toEqual([c2.id, c1.id]);
    expect(() => call('reorderTopics', parent.id, [c1.id])).toThrow(/every topic/);
    expect(() => call('updateTopic', parent.id, { parentId: c1.id })).toThrow(/inside itself/);
    call('updateTopic', c2.id, { enabled: false });
    expect(() => call('deleteTopic', c1.id)).toThrow(/Archive the topic before deleting/);
    call('archiveTopic', parent.id); // archives its subtopics too
    expect(topics.get(A, c1.id).archivedAt).not.toBeNull();
    expect(() => call('restoreTopic', c1.id)).toThrow(/Restore the parent/);
    expect(() => call('deleteTopic', parent.id)).toThrow(/subtopics first/);
    call('restoreTopic', parent.id);
    call('restoreTopic', c1.id);
    const t = topics.get(A, c1.id);
    expect(t).toMatchObject({ description: 'Graphics processors', keywords: ['GPU', 'CUDA'], exclusions: ['gaming'], priority: 1, approvalRequired: true, archivedAt: null });
  });

  it('steer discovery only through enabled, active topics; agent proposals change nothing until accepted', () => {
    const tid = topics.list(A)[1].id; // AI hardware
    topics.update(A, tid, { exclusions: ['crypto mining'], approvalRequired: true });
    topics.update(A, topics.list(A)[5].id, { enabled: false }); // Robotics off
    const prof = topics.discoveryProfile(A);
    expect(prof.keywords).toContain('GPU');
    expect(prof.keywords).not.toContain('humanoid');
    expect(prof.exclusions).toEqual(['crypto mining']);
    expect(prof.approvalKeywords).toContain('NVIDIA');
    const proposal = topics.create(A, { name: 'Edge AI chips', keywords: ['NPU'], parentId: tid }, 'agent');
    expect(proposal.status).toBe('proposed');
    expect(topics.discoveryProfile(A).keywords).not.toContain('NPU');
    call('decideTopicProposal', proposal.id, true);
    expect(topics.discoveryProfile(A).keywords).toContain('NPU');
    expect(topics.discoveryProfile(B).keywords).toEqual([]);
  });
});

describe('records, accounts and credentials', () => {
  it('scope productions, content and ideas to their business, including renderer-supplied ids', () => {
    const pa = productions.create(A, 'Same topic', null, '');
    const pb = productions.create(B, 'Same topic', null, '');
    expect((call('listProductions', A) as { id: number }[]).map((p) => p.id)).toEqual([pa.id]);
    expect(() => call('listProductions', B)).toThrow(/different business/);
    expect(() => call('getProduction', pb.id)).toThrow(/not found in AI, Actually/);
    expect(() => call('deleteProduction', pb.id)).toThrow(BusinessContextError);
    expect(() => call('approveProduction', pb.id, '')).toThrow(BusinessContextError);
    expect(() => call('createProduction', B, { topic: 'x' })).toThrow(/different business/);
    call('switchBusiness', B);
    expect((call('getProduction', pb.id) as { id: number }).id).toBe(pb.id);
    expect(() => call('getProduction', pa.id)).toThrow(/not found in Ledger Labs/);
  });

  it('keep accounts, destinations and developer-app credentials inside their business', async () => {
    const acctA = call('addAccount', 'tiktok', '@aiactually') as { id: number; businessId: number };
    expect(acctA.businessId).toBe(A);
    publisher.saveApp(A, 'tiktok', { clientId: 'ck-A', clientSecret: 'secret-A' });
    call('switchBusiness', B);
    expect(call('listAccounts')).toEqual([]);
    expect((call('platformApps') as { platform: string; configured: boolean }[]).find((x) => x.platform === 'tiktok')!.configured).toBe(false);
    expect(() => call('setDestination', 'tiktok', acctA.id, true, 'private')).toThrow(/not found in Ledger Labs/);
    expect(() => ops.setDestination(B, 'tiktok', { accountId: acctA.id, enabled: true, privacy: 'private' })).toThrow(/different business/);
    await expect(call('connectAccount', acctA.id) as Promise<unknown>).rejects.toThrow(/not found/);
    expect(() => call('disconnectAccount', acctA.id)).toThrow(/not found/);
    // Even a stale frozen destination pointing at another business's account is blocked.
    expect(ops.resolveDestinations(B, [{ platform: 'tiktok', accountId: acctA.id }])[0].blockers.join(' ')).toMatch(/different business/);
  });

  it('refuses to use another business’s tokens when publishing', async () => {
    const acct = ops.addAccount(A, 'tiktok', '@aiactually');
    ops.storeToken(acct.id, box.encrypt(JSON.stringify({ accessToken: 'AT', refreshToken: null, expiresAt: '2099-01-01T00:00:00Z', refreshExpiresAt: null, scopes: [] })));
    ops.updateAccountAuth(acct.id, { status: 'connected', capabilities: { canPublishPrivate: true, canPublishPublic: false, financial: false, restrictions: [] } });
    const pb = productions.create(B, 'B video', null, '', 'news', { destinations: [{ platform: 'tiktok', accountId: acct.id, handle: '@aiactually', privacy: 'private', blockers: [] }] });
    productions.update(pb.id, { approval: 'approved' });
    expect(publisher.blockers(pb.id, 'tiktok').join(' ')).toMatch(/different business/);
    await expect(publisher.publish(pb.id, 'tiktok', 'engine')).rejects.toThrow(PublishBlockedError);
    expect(publisher.publications(pb.id)).toEqual([]);
  });

  it('keep automation settings, ideas and analytics separate', async () => {
    call('saveAutonomy', { ...(call('getAutonomy') as object), enabled: true, maxProductionsPerDay: 7 });
    expect(ops.getAutonomy(A).maxProductionsPerDay).toBe(7);
    expect(ops.getAutonomy(B).enabled).toBe(false);
    ops.upsertIdea({ brandId: B, topic: 'Audit season', headline: 'h', mode: 'news', signals: [], score: 80, scoreDetail: {} as never, fingerprint: 'f1' });
    expect(call('listIdeas')).toEqual([]);
    const idea = ops.listIdeas(B)[0];
    expect(() => call('produceIdea', idea.id)).toThrow(/not found/);
    const report = (await call('getAnalytics')) as { platforms: unknown[] };
    expect(report.platforms).toEqual([]);
  });
});

describe('audit', () => {
  it('records the business inside the hash, keeps the chain verifiable and filters per business', () => {
    db.prepare("UPDATE settings SET value = '0' WHERE key = 'legacyAuditMaxId'").run();
    const legacy = audit.record({ actor: 'user', type: 'legacy.event', data: {} }); // no business, recorded before "migration"
    db.prepare("UPDATE settings SET value = ? WHERE key = 'legacyAuditMaxId'").run(String(legacy.id));
    audit.record({ actor: 'engine', type: 'system.event', data: {} }); // later event with no business: belongs to none
    audit.record({ actor: 'user', businessId: B, type: 'b.event', data: {} });
    const pa = productions.create(A, 't', null, '');
    audit.record({ actor: 'user', type: 'a.production', productionId: pa.id });
    expect(audit.verify().ok).toBe(true);
    const typesB = audit.events({ businessId: B }).map((e) => e.type);
    expect(typesB).toContain('b.event');
    expect(typesB).not.toContain('a.production');
    expect(audit.events({ businessId: A }).map((e) => e.type)).toEqual(expect.arrayContaining(['legacy.event', 'a.production']));
    expect(audit.events({ businessId: A }).map((e) => e.type)).not.toContain('system.event');
    // The ledger is append-only at the database level, so an event's business cannot be rewritten.
    expect(() => db.prepare("UPDATE audit_events SET business_id = ? WHERE type = 'b.event'").run(A)).toThrow(/append-only/);
  });
});

describe('migration of the real AI, Actually database', () => {
  const backup = 'F:/Claude/backups/omnicore-data-0.6.1-pre-multibusiness-20261127/ai-media-operations.db';
  it.skipIf(!fs.existsSync(backup))('assigns every existing record to AI, Actually without losing anything', () => {
    const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-mig-')), 'db.db');
    fs.copyFileSync(backup, copy);
    const count = (d: DatabaseSync, t: string) => Number((d.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n);
    const before = openDatabaseReadOnly(copy);
    const tables = ['productions', 'publications', 'production_assets', 'audit_events', 'evidence', 'ideas', 'platform_accounts', 'secure_tokens', 'qa_runs', 'qa_findings', 'audio_library'];
    const counts = Object.fromEntries(tables.map((t) => [t, count(before, t)]));
    before.close();
    const db2 = openDatabase(copy);
    for (const t of tables) expect(count(db2, t), t).toBe(counts[t]);
    expect(Number((db2.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(13);
    expect((db2.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
    expect(db2.prepare('SELECT COUNT(*) n FROM platform_accounts WHERE business_id IS NULL').get()).toEqual({ n: 0 });
    expect(db2.prepare("SELECT key FROM settings ORDER BY key").all().map((r) => (r as { key: string }).key)).toEqual(['activeBusiness', 'business:1:autonomy', 'business:1:platformApp:tiktok', 'legacyAuditBusiness', 'legacyAuditMaxId', 'providers']);
    const ledger = new AuditLedger(db2, os.tmpdir());
    expect(ledger.verify()).toMatchObject({ ok: true, events: counts.audit_events });
    expect(new TopicRepository(db2).list(1)).toHaveLength(8);
    db2.close();
  });
});

function openDatabaseReadOnly(file: string): DatabaseSync {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync: D } = require('node:sqlite') as typeof import('node:sqlite');
  return new D(file, { readOnly: true });
}
