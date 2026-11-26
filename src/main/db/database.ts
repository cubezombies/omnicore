import { DatabaseSync } from 'node:sqlite';

/**
 * Ordered schema migrations. Append only: never edit a shipped migration.
 * The number applied is stored in PRAGMA user_version.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE channels (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL UNIQUE,
    niche       TEXT NOT NULL DEFAULT '',
    platforms   TEXT NOT NULL DEFAULT '[]',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE content_items (
    id              INTEGER PRIMARY KEY,
    channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    summary         TEXT NOT NULL DEFAULT '',
    research_notes  TEXT NOT NULL DEFAULT '',
    script          TEXT NOT NULL DEFAULT '',
    stage           TEXT NOT NULL DEFAULT 'idea'
                    CHECK (stage IN ('idea','research','script','production','review','published')),
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_content_channel_stage ON content_items(channel_id, stage);
  CREATE TABLE stage_history (
    id          INTEGER PRIMARY KEY,
    content_id  INTEGER NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
    from_stage  TEXT,
    to_stage    TEXT NOT NULL,
    changed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_history_content ON stage_history(content_id);
  INSERT INTO channels (name, slug, niche, platforms)
    VALUES ('AI, Actually', 'ai-actually', 'AI and technology',
            '["tiktok","youtube-shorts","instagram-reels"]');
  `
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  try {
    if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
    migrate(db);
  } catch (err) {
    db.close(); // never leave a locked file behind on failure
    throw err;
  }
  return db;
}

export function schemaVersion(db: DatabaseSync): number {
  return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
}

export function migrate(db: DatabaseSync): void {
  const current = schemaVersion(db);
  if (current > MIGRATIONS.length) {
    throw new Error(`Database schema v${current} is newer than this app supports (v${MIGRATIONS.length}).`);
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
