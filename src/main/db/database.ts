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
  `,
  // v2: Video Factory — settings, productions, per-step progress/cost, assets.
  `
  CREATE TABLE settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );
  CREATE TABLE productions (
    id            INTEGER PRIMARY KEY,
    channel_id    INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    content_id    INTEGER REFERENCES content_items(id) ON DELETE SET NULL,
    topic         TEXT NOT NULL,
    user_notes    TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','failed','completed','cancelled')),
    current_step  TEXT,
    error         TEXT,
    sources       TEXT NOT NULL DEFAULT '[]',
    brief         TEXT,
    storyboard    TEXT,
    output_path   TEXT,
    duration_sec  REAL,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_productions_channel ON productions(channel_id, created_at);
  CREATE TABLE production_steps (
    production_id  INTEGER NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
    step           TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
    attempts       INTEGER NOT NULL DEFAULT 0,
    progress       REAL NOT NULL DEFAULT 0,
    detail         TEXT NOT NULL DEFAULT '',
    error          TEXT,
    cost_usd       REAL NOT NULL DEFAULT 0,
    started_at     TEXT,
    finished_at    TEXT,
    PRIMARY KEY (production_id, step)
  );
  CREATE TABLE production_assets (
    id             INTEGER PRIMARY KEY,
    production_id  INTEGER NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
    kind           TEXT NOT NULL,
    scene_index    INTEGER,
    path           TEXT NOT NULL,
    provider       TEXT NOT NULL,
    source_url     TEXT NOT NULL DEFAULT '',
    license        TEXT NOT NULL DEFAULT '',
    attribution    TEXT NOT NULL DEFAULT '',
    meta           TEXT NOT NULL DEFAULT '{}',
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_assets_production ON production_assets(production_id, kind);
  `,
  // v3: Music & Sound Library.
  `
  CREATE TABLE audio_library (
    id            INTEGER PRIMARY KEY,
    kind          TEXT NOT NULL CHECK (kind IN ('music','sfx')),
    title         TEXT NOT NULL,
    file          TEXT NOT NULL,
    duration_sec  REAL NOT NULL,
    license       TEXT NOT NULL DEFAULT '',
    attribution   TEXT NOT NULL DEFAULT '',
    source_url    TEXT NOT NULL DEFAULT '',
    tags          TEXT NOT NULL DEFAULT '[]',
    origin        TEXT NOT NULL CHECK (origin IN ('generated','imported')),
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  `,
  // v4: production mode (explainer / news).
  `
  ALTER TABLE productions ADD COLUMN mode TEXT NOT NULL DEFAULT 'explainer' CHECK (mode IN ('explainer','news'));
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
