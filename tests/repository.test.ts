import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, schemaVersion, SCHEMA_VERSION } from '../src/main/db/database';
import { NotFoundError, Repository, WorkflowError } from '../src/main/db/repository';

let db: DatabaseSync;
let repo: Repository;
let channelId: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = new Repository(db);
  channelId = repo.listChannels()[0].id;
});

describe('schema', () => {
  it('seeds AI, Actually as the initial channel', () => {
    const channels = repo.listChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({
      name: 'AI, Actually',
      slug: 'ai-actually',
      niche: 'AI and technology',
      platforms: ['tiktok', 'youtube-shorts', 'instagram-reels']
    });
  });

  it('is idempotent on reopen and persists to disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimo-'));
    const file = path.join(dir, 'test.db');
    const a = openDatabase(file);
    new Repository(a).createContent(1, { title: 'Persisted' });
    a.close();
    const b = openDatabase(file);
    expect(schemaVersion(b)).toBe(SCHEMA_VERSION);
    const r = new Repository(b);
    expect(r.listChannels()).toHaveLength(1);
    expect(r.listContent(1).map((i) => i.title)).toEqual(['Persisted']);
    b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a database from a newer app version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimo-'));
    const file = path.join(dir, 'future.db');
    const f = openDatabase(file);
    f.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    f.close();
    expect(() => openDatabase(file)).toThrow(/newer/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects an invalid stage at the database level', () => {
    expect(() => db.prepare(`INSERT INTO content_items (channel_id, title, stage) VALUES (1, 'x', 'bogus')`).run()).toThrow();
  });
});

describe('content', () => {
  it('creates ideas in the Idea stage and records history', () => {
    const item = repo.createContent(channelId, { title: 'Why AI agents fail', summary: 'Hook angle' });
    expect(item).toMatchObject({ title: 'Why AI agents fail', summary: 'Hook angle', stage: 'idea', channelId });
    expect(repo.stageHistory(item.id)).toEqual([expect.objectContaining({ from: null, to: 'idea' })]);
  });

  it('edits only the provided fields', () => {
    const item = repo.createContent(channelId, { title: 'A', summary: 'keep me' });
    const updated = repo.updateContent(item.id, { title: 'B', script: 'Line one' });
    expect(updated).toMatchObject({ title: 'B', summary: 'keep me', script: 'Line one' });
  });

  it('rejects unknown channel and content ids', () => {
    expect(() => repo.createContent(999, { title: 'x' })).toThrow(NotFoundError);
    expect(() => repo.updateContent(999, { title: 'x' })).toThrow(NotFoundError);
    expect(repo.getContent(999)).toBeNull();
  });

  it('filters by stage and counts per stage', () => {
    const a = repo.createContent(channelId, { title: 'A' });
    repo.createContent(channelId, { title: 'B' });
    repo.moveContent(a.id, 'research');
    expect(repo.listContent(channelId, ['research']).map((i) => i.title)).toEqual(['A']);
    expect(repo.listContent(channelId, ['idea', 'research'])).toHaveLength(2);
    const counts = repo.stageCounts(channelId);
    expect(counts.total).toBe(2);
    expect(counts.counts).toMatchObject({ idea: 1, research: 1, script: 0, published: 0 });
  });

  it('deletes content and its history', () => {
    const a = repo.createContent(channelId, { title: 'A' });
    repo.deleteContent(a.id);
    expect(repo.getContent(a.id)).toBeNull();
    expect(repo.stageHistory(a.id)).toEqual([]);
  });

  it('keeps channels independent', () => {
    db.prepare(`INSERT INTO channels (name, slug) VALUES ('Second', 'second')`).run();
    const second = repo.listChannels()[1].id;
    repo.createContent(channelId, { title: 'Mine' });
    repo.createContent(second, { title: 'Theirs' });
    expect(repo.listContent(channelId).map((i) => i.title)).toEqual(['Mine']);
    expect(repo.listContent(second).map((i) => i.title)).toEqual(['Theirs']);
    expect(repo.stageCounts(second).total).toBe(1);
  });
});

describe('workflow', () => {
  it('walks Idea → Research → Script → Production → Review → Published', () => {
    const item = repo.createContent(channelId, { title: 'Pipeline' });
    for (const s of ['research', 'script', 'production', 'review', 'published'] as const) {
      expect(repo.moveContent(item.id, s).stage).toBe(s);
    }
    expect(repo.stageHistory(item.id).map((h) => h.to)).toEqual([
      'idea', 'research', 'script', 'production', 'review', 'published'
    ]);
  });

  it('blocks skipping stages and allows sending work back', () => {
    const item = repo.createContent(channelId, { title: 'Skip' });
    expect(() => repo.moveContent(item.id, 'script')).toThrow(WorkflowError);
    expect(() => repo.moveContent(item.id, 'idea')).toThrow(WorkflowError); // no-op move
    repo.moveContent(item.id, 'research');
    repo.moveContent(item.id, 'script');
    expect(repo.moveContent(item.id, 'idea').stage).toBe('idea');
  });
});
