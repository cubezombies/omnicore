import { DatabaseSync } from 'node:sqlite';

/**
 * Ordered schema migrations. Append only: never edit a shipped migration.
 * The number applied is stored in PRAGMA user_version.
 */
export const MIGRATIONS: string[] = [
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
  `,
  // v5: autonomous operations — brands/accounts/destinations, idea pipeline, audit ledger,
  // rights evidence, QA history, incidents, engine runs, music restrictions.
  `
  ALTER TABLE channels ADD COLUMN presenter_engine TEXT NOT NULL DEFAULT 'sherpa';
  ALTER TABLE channels ADD COLUMN presenter_voice TEXT NOT NULL DEFAULT 'af_heart';
  ALTER TABLE channels ADD COLUMN editorial TEXT NOT NULL DEFAULT '{}';

  CREATE TABLE platform_accounts (
    id               INTEGER PRIMARY KEY,
    platform         TEXT NOT NULL CHECK (platform IN ('tiktok','youtube','instagram')),
    handle           TEXT NOT NULL,
    display_name     TEXT NOT NULL DEFAULT '',
    external_id      TEXT NOT NULL DEFAULT '',
    avatar_url       TEXT NOT NULL DEFAULT '',
    status           TEXT NOT NULL DEFAULT 'not_connected'
                     CHECK (status IN ('not_connected','connected','expired','revoked','error')),
    scopes           TEXT NOT NULL DEFAULT '[]',
    capabilities     TEXT NOT NULL DEFAULT '{}',
    token_expires_at TEXT,
    last_auth_at     TEXT,
    last_error       TEXT,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (platform, handle)
  );
  -- Tokens are encrypted with the OS key store (Electron safeStorage / Windows DPAPI) before they reach the DB.
  CREATE TABLE secure_tokens (
    account_id  INTEGER PRIMARY KEY REFERENCES platform_accounts(id) ON DELETE CASCADE,
    ciphertext  BLOB NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE brand_destinations (
    id          INTEGER PRIMARY KEY,
    brand_id    INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    platform    TEXT NOT NULL CHECK (platform IN ('tiktok','youtube','instagram')),
    account_id  INTEGER REFERENCES platform_accounts(id) ON DELETE SET NULL,
    is_default  INTEGER NOT NULL DEFAULT 1,
    enabled     INTEGER NOT NULL DEFAULT 1,
    privacy     TEXT NOT NULL DEFAULT 'private' CHECK (privacy IN ('private','public','unlisted')),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_dest_brand ON brand_destinations(brand_id, platform);

  CREATE TABLE ideas (
    id             INTEGER PRIMARY KEY,
    brand_id       INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    topic          TEXT NOT NULL,
    headline       TEXT NOT NULL DEFAULT '',
    mode           TEXT NOT NULL DEFAULT 'news' CHECK (mode IN ('explainer','news')),
    signals        TEXT NOT NULL DEFAULT '[]',
    score          REAL NOT NULL DEFAULT 0,
    score_detail   TEXT NOT NULL DEFAULT '{}',
    status         TEXT NOT NULL DEFAULT 'new'
                   CHECK (status IN ('new','selected','rejected','produced','failed','expired')),
    decision       TEXT NOT NULL DEFAULT '',
    production_id  INTEGER REFERENCES productions(id) ON DELETE SET NULL,
    fingerprint    TEXT NOT NULL,
    discovered_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    decided_at     TEXT,
    UNIQUE (brand_id, fingerprint)
  );
  CREATE INDEX idx_ideas_status ON ideas(brand_id, status, score);

  CREATE TABLE engine_runs (
    id           INTEGER PRIMARY KEY,
    kind         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed','interrupted')),
    detail       TEXT NOT NULL DEFAULT '',
    started_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    finished_at  TEXT
  );

  -- Append-only, hash-chained audit ledger. Updates and deletes are refused by triggers.
  CREATE TABLE audit_events (
    id             INTEGER PRIMARY KEY,
    ts             TEXT NOT NULL,
    actor          TEXT NOT NULL,
    type           TEXT NOT NULL,
    subject_type   TEXT NOT NULL DEFAULT '',
    subject_id     TEXT NOT NULL DEFAULT '',
    production_id  INTEGER,
    data           TEXT NOT NULL DEFAULT '{}',
    prev_hash      TEXT NOT NULL,
    hash           TEXT NOT NULL UNIQUE
  );
  CREATE INDEX idx_audit_prod ON audit_events(production_id, id);
  CREATE INDEX idx_audit_subject ON audit_events(subject_type, subject_id);
  CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;

  -- Retained evidence (licence metadata snapshots, source excerpts, script versions), content-addressed.
  CREATE TABLE evidence (
    sha256      TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    source_url  TEXT NOT NULL DEFAULT '',
    media_type  TEXT NOT NULL DEFAULT 'application/json',
    path        TEXT NOT NULL,
    bytes       INTEGER NOT NULL,
    retrieved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE qa_runs (
    id             INTEGER PRIMARY KEY,
    production_id  INTEGER NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
    round          INTEGER NOT NULL,
    status         TEXT NOT NULL CHECK (status IN ('passed','failed','blocked')),
    summary        TEXT NOT NULL DEFAULT '{}',
    started_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    finished_at    TEXT
  );
  CREATE TABLE qa_findings (
    id         INTEGER PRIMARY KEY,
    qa_run_id  INTEGER NOT NULL REFERENCES qa_runs(id) ON DELETE CASCADE,
    check_id   TEXT NOT NULL,
    category   TEXT NOT NULL,
    severity   TEXT NOT NULL CHECK (severity IN ('critical','major','minor','info')),
    passed     INTEGER NOT NULL,
    message    TEXT NOT NULL,
    evidence   TEXT NOT NULL DEFAULT '{}',
    repair     TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_qa_findings_run ON qa_findings(qa_run_id);

  CREATE TABLE incidents (
    id             INTEGER PRIMARY KEY,
    kind           TEXT NOT NULL CHECK (kind IN ('rights_complaint','incident')),
    production_id  INTEGER REFERENCES productions(id) ON DELETE SET NULL,
    asset_key      TEXT NOT NULL DEFAULT '',
    description    TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    resolved_at    TEXT
  );

  ALTER TABLE productions ADD COLUMN idea_id INTEGER REFERENCES ideas(id) ON DELETE SET NULL;
  ALTER TABLE productions ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','autonomous'));
  ALTER TABLE productions ADD COLUMN destinations TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE productions ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE productions ADD COLUMN approval TEXT NOT NULL DEFAULT 'none'
    CHECK (approval IN ('none','awaiting_review','approved','rejected','blocked'));
  ALTER TABLE productions ADD COLUMN publish_status TEXT NOT NULL DEFAULT 'not_published';

  -- Embedded (licensed into the file) vs platform-native (attached on the platform) audio, with restrictions.
  ALTER TABLE audio_library ADD COLUMN usage TEXT NOT NULL DEFAULT 'embedded' CHECK (usage IN ('embedded','platform_native'));
  ALTER TABLE audio_library ADD COLUMN commercial_use TEXT NOT NULL DEFAULT 'unknown' CHECK (commercial_use IN ('yes','no','unknown'));
  ALTER TABLE audio_library ADD COLUMN restrictions TEXT NOT NULL DEFAULT '{}';
  UPDATE audio_library SET commercial_use = 'yes' WHERE origin = 'generated';

  -- QA becomes a pipeline step for existing productions too.
  INSERT INTO production_steps (production_id, step) SELECT id, 'qa' FROM productions;
  -- AI, Actually: the approved presenter (Kokoro Heart) and editorial focus; default destinations (not yet connected).
  UPDATE channels SET presenter_engine = 'sherpa', presenter_voice = 'af_heart',
    editorial = '{"keywords":["AI","artificial intelligence","LLM","language model","OpenAI","Anthropic","Google","DeepMind","NVIDIA","GPU","chip","model","agent","robot","machine learning","Meta","Microsoft","Apple","regulation","AI Act"]}'
    WHERE slug = 'ai-actually';
  INSERT INTO brand_destinations (brand_id, platform, is_default, enabled, privacy)
    SELECT id, p.platform, 1, CASE p.platform WHEN 'tiktok' THEN 1 ELSE 0 END, 'private'
    FROM channels, (SELECT 'tiktok' AS platform UNION ALL SELECT 'youtube' UNION ALL SELECT 'instagram') p
    WHERE slug = 'ai-actually';
  `,
  // v6: publishing records (one per production × platform), verified against the platform.
  `
  CREATE TABLE publications (
    id                 INTEGER PRIMARY KEY,
    production_id      INTEGER NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
    platform           TEXT NOT NULL CHECK (platform IN ('tiktok','youtube','instagram')),
    account_id         INTEGER REFERENCES platform_accounts(id) ON DELETE SET NULL,
    privacy_requested  TEXT NOT NULL,
    privacy_applied    TEXT NOT NULL DEFAULT '',
    status             TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','processing','published','failed')),
    remote_id          TEXT NOT NULL DEFAULT '',
    url                TEXT NOT NULL DEFAULT '',
    detail             TEXT NOT NULL DEFAULT '',
    approved_by        TEXT NOT NULL DEFAULT '',
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_publications_prod ON publications(production_id, platform);
  `,
  // v7: length format (short < 60 s, standard 65–120 s). Existing productions are shorts.
  `
  ALTER TABLE productions ADD COLUMN format TEXT NOT NULL DEFAULT 'short' CHECK (format IN ('short','standard'));
  `,
  // v8: audience snapshots (one row per account or publication per refresh), for trends over time.
  `
  CREATE TABLE metric_snapshots (
    id              INTEGER PRIMARY KEY,
    captured_at     TEXT NOT NULL,
    platform        TEXT NOT NULL CHECK (platform IN ('tiktok','youtube','instagram')),
    account_id      INTEGER REFERENCES platform_accounts(id) ON DELETE SET NULL,
    publication_id  INTEGER REFERENCES publications(id) ON DELETE CASCADE,
    followers       INTEGER,
    views           INTEGER,
    likes           INTEGER,
    comments        INTEGER,
    extra           TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX idx_metric_snapshots ON metric_snapshots(platform, captured_at);
  `,
  // v9: multi-business. The channels table is the business table; every business-owned record gets an explicit
  // owner, and everything that existed before belongs to AI, Actually (the only business so far).
  `
  ALTER TABLE channels ADD COLUMN business_type TEXT NOT NULL DEFAULT 'media';
  ALTER TABLE channels ADD COLUMN modules TEXT NOT NULL DEFAULT '["media"]';
  ALTER TABLE channels ADD COLUMN description TEXT NOT NULL DEFAULT '';
  ALTER TABLE channels ADD COLUMN objectives TEXT NOT NULL DEFAULT '';
  ALTER TABLE channels ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
  ALTER TABLE channels ADD COLUMN accent TEXT NOT NULL DEFAULT '#5eead4';
  ALTER TABLE channels ADD COLUMN archived_at TEXT;
  UPDATE channels SET description = 'Short videos explaining AI and technology news, sourced and fact-checked.' WHERE slug = 'ai-actually' AND description = '';
  UPDATE channels SET objectives = 'Reach $1,000,000 cumulative collected revenue. Replace $150,000 of employment income. Build toward $200,000 annual profit.' WHERE slug = 'ai-actually' AND objectives = '';

  ALTER TABLE platform_accounts ADD COLUMN business_id INTEGER REFERENCES channels(id);
  UPDATE platform_accounts SET business_id = (SELECT id FROM channels WHERE slug = 'ai-actually') WHERE business_id IS NULL;
  ALTER TABLE metric_snapshots ADD COLUMN business_id INTEGER REFERENCES channels(id);
  UPDATE metric_snapshots SET business_id = (SELECT business_id FROM platform_accounts WHERE id = metric_snapshots.account_id);
  ALTER TABLE engine_runs ADD COLUMN business_id INTEGER REFERENCES channels(id);
  UPDATE engine_runs SET business_id = CAST(substr(kind, instr(kind, ':') + 1) AS INTEGER) WHERE kind LIKE 'discovery:%';
  ALTER TABLE incidents ADD COLUMN business_id INTEGER REFERENCES channels(id);
  UPDATE incidents SET business_id = COALESCE((SELECT channel_id FROM productions WHERE id = incidents.production_id), (SELECT id FROM channels WHERE slug = 'ai-actually'));
  -- Audit: new events carry their business inside the hash; earlier events stay byte-identical (their chain still
  -- verifies) and are attributed to the business that owned everything at the time (recorded in settings).
  ALTER TABLE audit_events ADD COLUMN business_id INTEGER;
  INSERT INTO settings (key, value) SELECT 'legacyAuditBusiness', CAST(id AS TEXT) FROM channels WHERE slug = 'ai-actually';
  INSERT INTO settings (key, value) SELECT 'legacyAuditMaxId', CAST(COALESCE(MAX(id), 0) AS TEXT) FROM audit_events;

  -- Per-business settings: automation and developer-app credentials belong to the business.
  INSERT INTO settings (key, value) SELECT 'business:' || (SELECT id FROM channels WHERE slug = 'ai-actually') || ':' || key, value FROM settings WHERE key = 'autonomy' OR key LIKE 'platformApp:%';
  DELETE FROM settings WHERE key = 'autonomy' OR key LIKE 'platformApp:%';
  INSERT INTO settings (key, value) SELECT 'activeBusiness', CAST(id AS TEXT) FROM channels WHERE slug = 'ai-actually';

  CREATE TABLE topics (
    id                  INTEGER PRIMARY KEY,
    business_id         INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    parent_id           INTEGER REFERENCES topics(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    description         TEXT NOT NULL DEFAULT '',
    keywords            TEXT NOT NULL DEFAULT '[]',
    exclusions          TEXT NOT NULL DEFAULT '[]',
    priority            INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
    position            INTEGER NOT NULL DEFAULT 0,
    enabled             INTEGER NOT NULL DEFAULT 1,
    status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','proposed')),
    origin              TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user','agent','seed')),
    research_priority   TEXT NOT NULL DEFAULT 'normal' CHECK (research_priority IN ('low','normal','high')),
    discovery           TEXT NOT NULL DEFAULT '',
    objectives          TEXT NOT NULL DEFAULT '',
    autonomous_ok       INTEGER NOT NULL DEFAULT 1,
    approval_required   INTEGER NOT NULL DEFAULT 0,
    archived_at         TEXT,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_topics_business ON topics(business_id, parent_id, position);
  INSERT INTO topics (business_id, name, description, keywords, position, origin)
  SELECT c.id, t.name, t.description, t.keywords, t.position, 'seed' FROM channels c,
    (SELECT 'AI models and releases' AS name, 'New and updated models, benchmarks and capabilities.' AS description, '["model","LLM","language model","OpenAI","Anthropic","Google","DeepMind","Meta","release"]' AS keywords, 0 AS position
     UNION ALL SELECT 'AI hardware', 'Chips, accelerators and data centers that run AI.', '["GPU","chip","NVIDIA","accelerator","data center"]', 1
     UNION ALL SELECT 'AI research', 'Papers and results from labs and universities.', '["research","paper","arXiv","machine learning"]', 2
     UNION ALL SELECT 'AI industry news', 'Companies, deals, funding and the business of AI.', '["Microsoft","Apple","funding","acquisition","startup"]', 3
     UNION ALL SELECT 'AI tools and applications', 'What people can actually do with AI.', '["agent","assistant","app","tool"]', 4
     UNION ALL SELECT 'Robotics', 'Robots and embodied AI.', '["robot","robotics","humanoid"]', 5
     UNION ALL SELECT 'Cybersecurity', 'AI in attacks, defence and security research.', '["cybersecurity","security","attack","vulnerability"]', 6
     UNION ALL SELECT 'AI regulation and policy', 'Laws, regulators and policy debates.', '["regulation","AI Act","policy","law"]', 7) t
  WHERE c.slug = 'ai-actually';
  `,
  // v10: central pronunciation dictionary. business_id NULL = shared by every business; a business entry overrides it.
  // The old global list in the provider settings moves here unchanged.
  `
  CREATE TABLE pronunciations (
    id              INTEGER PRIMARY KEY,
    business_id     INTEGER REFERENCES channels(id) ON DELETE CASCADE,
    term            TEXT NOT NULL,
    say             TEXT NOT NULL,
    engine_say      TEXT NOT NULL DEFAULT '{}',
    ipa             TEXT NOT NULL DEFAULT '',
    context         TEXT NOT NULL DEFAULT '',
    case_sensitive  INTEGER NOT NULL DEFAULT 0,
    verified        INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE UNIQUE INDEX idx_pron_term ON pronunciations(COALESCE(business_id, 0), lower(term));
  INSERT OR IGNORE INTO pronunciations (term, say)
    SELECT trim(json_extract(j.value, '$.term')), trim(json_extract(j.value, '$.say'))
    FROM settings s, json_each(json_extract(s.value, '$.pronunciations')) j
    WHERE s.key = 'providers' AND json_valid(s.value) AND trim(COALESCE(json_extract(j.value, '$.term'), '')) <> '' AND trim(COALESCE(json_extract(j.value, '$.say'), '')) <> '';
  `,
  // v11: production numbers are never reused. SQLite hands a deleted top id to the next insert (production 11 was
  // three different videos), so a high-water mark is kept, seeded from every production id ever recorded (including
  // the audit log), and a trigger refuses any insert at or below it.
  `
  CREATE TABLE id_high_water (name TEXT PRIMARY KEY, max_id INTEGER NOT NULL);
  INSERT INTO id_high_water (name, max_id) VALUES ('productions', MAX(
    COALESCE((SELECT MAX(id) FROM productions), 0),
    COALESCE((SELECT MAX(production_id) FROM audit_events), 0),
    COALESCE((SELECT MAX(production_id) FROM ideas), 0)));
  CREATE TRIGGER productions_ids_never_reused AFTER INSERT ON productions BEGIN
    SELECT RAISE(ABORT, 'Production numbers are never reused.') WHERE NEW.id <= (SELECT max_id FROM id_high_water WHERE name = 'productions');
    UPDATE id_high_water SET max_id = NEW.id WHERE name = 'productions';
  END;
  `,
  // v12: rights ledger for library sounds (provider, track id, licence URL, source page, evidence hash).
  `
  ALTER TABLE audio_library ADD COLUMN rights TEXT NOT NULL DEFAULT '{}';
  `,
  // v13: rights gate (incident 2026-11-27: paid Jamendo Licensing tracks were imported as CC BY from Openverse metadata).
  // Every library sound has a rights status; only 'approved' sounds can be selected, rendered or published. Decisions
  // are append-only evidence. Every non-generated sound is quarantined and each production that used one gets an open
  // rights incident. Nothing is deleted.
  `
  ALTER TABLE audio_library ADD COLUMN rights_status TEXT NOT NULL DEFAULT 'unverified' CHECK (rights_status IN ('approved','unverified','quarantined','rejected'));
  ALTER TABLE audio_library ADD COLUMN quarantine_reason TEXT NOT NULL DEFAULT '';
  CREATE TABLE audio_rights_decisions (
    id                INTEGER PRIMARY KEY,
    track_id          INTEGER,
    provider          TEXT NOT NULL DEFAULT '',
    provider_track_id TEXT NOT NULL DEFAULT '',
    title             TEXT NOT NULL DEFAULT '',
    decision          TEXT NOT NULL,
    verifier          TEXT NOT NULL,
    reasons           TEXT NOT NULL DEFAULT '[]',
    evidence          TEXT NOT NULL DEFAULT '{}',
    evidence_sha256   TEXT NOT NULL DEFAULT '',
    decided_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TRIGGER audio_rights_no_update BEFORE UPDATE ON audio_rights_decisions BEGIN SELECT RAISE(ABORT, 'audio rights decisions are append-only'); END;
  CREATE TRIGGER audio_rights_no_delete BEFORE DELETE ON audio_rights_decisions BEGIN SELECT RAISE(ABORT, 'audio rights decisions are append-only'); END;
  UPDATE audio_library SET rights_status = 'approved' WHERE origin = 'generated';
  UPDATE audio_library SET rights_status = 'quarantined', quarantine_reason = 'Rights incident 2026-11-27: imported from index metadata (Openverse) without verification at the source of record; paid Jamendo Licensing catalogue tracks were listed as CC BY.' WHERE origin <> 'generated';
  INSERT INTO audio_rights_decisions (track_id, provider, provider_track_id, title, decision, verifier, reasons)
    SELECT id, COALESCE(json_extract(rights, '$.provider'), origin), COALESCE(json_extract(rights, '$.providerTrackId'), ''), title,
      CASE WHEN origin = 'generated' THEN 'approved' ELSE 'quarantined' END,
      CASE WHEN origin = 'generated' THEN 'omnicore-generated' ELSE 'incident-2026-11-27' END,
      CASE WHEN origin = 'generated' THEN '["synthesised by Omnicore; no third-party material"]' ELSE json_array(quarantine_reason) END
    FROM audio_library;
  INSERT INTO incidents (kind, production_id, asset_key, description, business_id)
    SELECT DISTINCT 'rights_complaint', a.production_id, a.path,
      'Music "' || l.title || '" is quarantined (rights incident 2026-11-27): it was imported as CC BY from index metadata and may be a paid Jamendo Licensing track. Do not publish this video; remove any post that uses it.',
      p.channel_id
    FROM production_assets a JOIN audio_library l ON a.path = 'library:' || l.file JOIN productions p ON p.id = a.production_id
    WHERE l.rights_status = 'quarantined';
  `,
  // v14: publication history is permanent. Deleting a production used to cascade-delete its publications (the record
  // of production 19's TikTok post was lost that way). The table is rebuilt without the cascade, with separate upload,
  // publish, failure and deletion times, the production number/topic and account handle at the time, and the uploaded
  // file's hash. Timestamps are backfilled from the audit log, and publications that the audit log proves happened
  // but whose rows were lost are restored from it (marked as restored).
  `
  CREATE TABLE publications_v14 (
    id                 INTEGER PRIMARY KEY,
    production_id      INTEGER REFERENCES productions(id) ON DELETE SET NULL,
    production_number  INTEGER NOT NULL DEFAULT 0,
    production_topic   TEXT NOT NULL DEFAULT '',
    platform           TEXT NOT NULL CHECK (platform IN ('tiktok','youtube','instagram')),
    account_id         INTEGER REFERENCES platform_accounts(id) ON DELETE SET NULL,
    account_handle     TEXT NOT NULL DEFAULT '',
    privacy_requested  TEXT NOT NULL,
    privacy_applied    TEXT NOT NULL DEFAULT '',
    status             TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','processing','published','failed')),
    remote_id          TEXT NOT NULL DEFAULT '',
    url                TEXT NOT NULL DEFAULT '',
    detail             TEXT NOT NULL DEFAULT '',
    approved_by        TEXT NOT NULL DEFAULT '',
    render_sha256      TEXT NOT NULL DEFAULT '',
    uploaded_at        TEXT,
    published_at       TEXT,
    failed_at          TEXT,
    deleted_at         TEXT,
    deletion_source    TEXT NOT NULL DEFAULT '' CHECK (deletion_source IN ('','user','platform')),
    deletion_note      TEXT NOT NULL DEFAULT '',
    restored_from      TEXT NOT NULL DEFAULT '',
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  INSERT INTO publications_v14 (id, production_id, production_number, production_topic, platform, account_id, account_handle, privacy_requested, privacy_applied, status, remote_id, url, detail, approved_by, uploaded_at, published_at, failed_at, created_at, updated_at)
    SELECT x.id, x.production_id, x.production_id, COALESCE(p.topic, ''), x.platform, x.account_id, COALESCE(a.handle, ''), x.privacy_requested, x.privacy_applied, x.status, x.remote_id, x.url, x.detail, x.approved_by,
      CASE WHEN x.remote_id <> '' THEN COALESCE((SELECT e.ts FROM audit_events e WHERE e.type = 'publish.submitted' AND e.production_id = x.production_id AND json_extract(e.data, '$.remoteId') = x.remote_id ORDER BY e.id LIMIT 1), x.created_at) END,
      CASE WHEN x.status = 'published' THEN COALESCE((SELECT e.ts FROM audit_events e WHERE e.type = 'publish.verified' AND e.production_id = x.production_id AND json_extract(e.data, '$.remoteId') = x.remote_id ORDER BY e.id LIMIT 1), x.updated_at) END,
      CASE WHEN x.status = 'failed' THEN x.updated_at END,
      x.created_at, x.updated_at
    FROM publications x LEFT JOIN productions p ON p.id = x.production_id LEFT JOIN platform_accounts a ON a.id = x.account_id;
  DROP TABLE publications;
  ALTER TABLE publications_v14 RENAME TO publications;
  CREATE INDEX idx_publications_production ON publications(production_id);
  INSERT INTO publications (production_id, production_number, production_topic, platform, account_id, account_handle, privacy_requested, privacy_applied, status, remote_id, url, detail, approved_by, uploaded_at, published_at, restored_from, created_at, updated_at)
    SELECT
      (SELECT id FROM productions WHERE id = v.production_id),
      v.production_id,
      COALESCE((SELECT topic FROM productions WHERE id = v.production_id), (SELECT json_extract(d.data, '$.topic') FROM audit_events d WHERE d.type = 'production.deleted' AND d.production_id = v.production_id ORDER BY d.id DESC LIMIT 1), ''),
      json_extract(v.data, '$.platform'),
      (SELECT id FROM platform_accounts WHERE id = json_extract(st.data, '$.accountId')),
      COALESCE(json_extract(st.data, '$.handle'), ''),
      COALESCE(json_extract(st.data, '$.privacy'), ''),
      COALESCE(json_extract(sb.data, '$.appliedPrivacy'), ''),
      'published',
      json_extract(v.data, '$.remoteId'),
      COALESCE(json_extract(v.data, '$.url'), ''),
      COALESCE(json_extract(v.data, '$.detail'), ''),
      COALESCE(json_extract(st.data, '$.approvedBy'), st.actor),
      sb.ts, v.ts, 'audit:' || v.id, COALESCE(st.ts, v.ts), v.ts
    FROM audit_events v
    LEFT JOIN audit_events sb ON sb.id = (SELECT id FROM audit_events WHERE type = 'publish.submitted' AND production_id = v.production_id AND json_extract(data, '$.remoteId') = json_extract(v.data, '$.remoteId') ORDER BY id LIMIT 1)
    LEFT JOIN audit_events st ON st.id = (SELECT id FROM audit_events WHERE type = 'publish.started' AND production_id = v.production_id AND id < COALESCE(sb.id, v.id) ORDER BY id DESC LIMIT 1)
    WHERE v.type = 'publish.verified' AND json_extract(v.data, '$.remoteId') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM publications x WHERE x.remote_id = json_extract(v.data, '$.remoteId'));
  `,
  // v15: QA history is permanent, and failures carry a typed classification.
  // Deleting a production used to cascade-delete its QA runs and findings (production 19's three passed runs were lost),
  // and because qa_runs had no AUTOINCREMENT the next runs reused their ids (production 21's runs became 37 and 38).
  // qa_runs is rebuilt with production_id ON DELETE SET NULL, AUTOINCREMENT, and a snapshot of what was checked:
  // business, production number and topic, the render's SHA-256 and the qa.run audit event. A trigger stamps
  // production_deleted_at before a production row goes. The id sequence is seeded from the number of qa.run audit
  // events (every run ever saved wrote one), so no id that was ever used is handed out again.
  // Rebuild order avoids SQLite's implicit DELETE on DROP TABLE (which fires ON DELETE CASCADE into child tables):
  // the child table is copied and its original dropped before the parent is dropped.
  `
  ALTER TABLE productions ADD COLUMN failure TEXT;
  CREATE TABLE qa_runs_v15 (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    production_id          INTEGER REFERENCES productions(id) ON DELETE SET NULL,
    business_id            INTEGER REFERENCES channels(id) ON DELETE SET NULL,
    production_number      INTEGER NOT NULL DEFAULT 0,
    production_topic       TEXT NOT NULL DEFAULT '',
    render_sha256          TEXT NOT NULL DEFAULT '',
    audit_event_id         INTEGER,
    production_deleted_at  TEXT,
    round                  INTEGER NOT NULL,
    status                 TEXT NOT NULL CHECK (status IN ('passed','failed','blocked')),
    summary                TEXT NOT NULL DEFAULT '{}',
    started_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    finished_at            TEXT
  );
  INSERT INTO qa_runs_v15 (id, production_id, business_id, production_number, production_topic, render_sha256, audit_event_id, round, status, summary, started_at, finished_at)
    SELECT r.id, r.production_id, p.channel_id, r.production_id, COALESCE(p.topic, ''),
      COALESCE((SELECT json_extract(e.data, '$.sha256') FROM audit_events e WHERE e.type = 'render.output' AND e.production_id = r.production_id AND e.ts <= r.started_at ORDER BY e.id DESC LIMIT 1), ''),
      (SELECT e.id FROM audit_events e WHERE e.type = 'qa.run' AND e.production_id = r.production_id AND e.ts >= r.started_at AND json_extract(e.data, '$.round') = r.round ORDER BY e.id LIMIT 1),
      r.round, r.status, r.summary, r.started_at, r.finished_at
    FROM qa_runs r LEFT JOIN productions p ON p.id = r.production_id;
  CREATE TABLE qa_findings_v15 (
    id         INTEGER PRIMARY KEY,
    qa_run_id  INTEGER NOT NULL REFERENCES qa_runs_v15(id) ON DELETE CASCADE,
    check_id   TEXT NOT NULL,
    category   TEXT NOT NULL,
    severity   TEXT NOT NULL CHECK (severity IN ('critical','major','minor','info')),
    passed     INTEGER NOT NULL,
    message    TEXT NOT NULL,
    evidence   TEXT NOT NULL DEFAULT '{}',
    repair     TEXT NOT NULL DEFAULT ''
  );
  INSERT INTO qa_findings_v15 SELECT id, qa_run_id, check_id, category, severity, passed, message, evidence, repair FROM qa_findings;
  DROP TABLE qa_findings;
  DROP TABLE qa_runs;
  ALTER TABLE qa_runs_v15 RENAME TO qa_runs;
  ALTER TABLE qa_findings_v15 RENAME TO qa_findings;
  CREATE INDEX idx_qa_findings_run ON qa_findings(qa_run_id);
  CREATE INDEX idx_qa_runs_production ON qa_runs(production_id);
  INSERT INTO sqlite_sequence (name, seq)
    SELECT 'qa_runs', MAX(COALESCE((SELECT MAX(id) FROM qa_runs), 0), (SELECT COUNT(*) FROM audit_events WHERE type = 'qa.run'))
    WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'qa_runs');
  UPDATE sqlite_sequence SET seq = MAX(seq, (SELECT COUNT(*) FROM audit_events WHERE type = 'qa.run')) WHERE name = 'qa_runs';
  CREATE TRIGGER qa_runs_keep_on_production_delete BEFORE DELETE ON productions
  BEGIN
    UPDATE qa_runs SET production_deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE production_id = OLD.id;
  END;
  `,
  // v16: production jobs and managed ComfyUI. Every run of a production is a job with an initiator, a lifecycle
  // (queued → running → succeeded/failed/cancelled/interrupted/stalled/expired) and a heartbeat; a unique index
  // allows one active job per production. ComfyUI generations are recorded with their business, production, workflow,
  // model and seed (provenance); models are only used for productions after an explicit, recorded licence approval.
  // New tables only: no existing record is changed.
  `
  CREATE TABLE production_jobs (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    production_id      INTEGER REFERENCES productions(id) ON DELETE SET NULL,
    production_number  INTEGER NOT NULL,
    business_id        INTEGER REFERENCES channels(id) ON DELETE SET NULL,
    kind               TEXT NOT NULL CHECK (kind IN ('produce','retry','rerun','revoice')),
    from_step          TEXT,
    initiator          TEXT NOT NULL CHECK (initiator IN ('user','scheduler','automation','agent','recovery','system')),
    status             TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled','interrupted','stalled','expired')),
    reason             TEXT NOT NULL DEFAULT '',
    error              TEXT NOT NULL DEFAULT '',
    failure_kind       TEXT NOT NULL DEFAULT '',
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    started_at         TEXT,
    heartbeat_at       TEXT,
    finished_at        TEXT
  );
  CREATE UNIQUE INDEX production_jobs_one_active ON production_jobs(production_id) WHERE status IN ('queued','running');
  CREATE INDEX production_jobs_business ON production_jobs(business_id, id);
  CREATE TABLE comfy_models (
    file         TEXT PRIMARY KEY,
    status       TEXT NOT NULL CHECK (status IN ('approved','revoked')),
    license      TEXT NOT NULL,
    license_url  TEXT NOT NULL DEFAULT '',
    note         TEXT NOT NULL DEFAULT '',
    sha256       TEXT NOT NULL DEFAULT '',
    decided_by   TEXT NOT NULL,
    decided_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE comfy_generations (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id        INTEGER REFERENCES channels(id) ON DELETE SET NULL,
    production_id      INTEGER REFERENCES productions(id) ON DELETE SET NULL,
    production_number  INTEGER,
    job_id             INTEGER,
    scene_index        INTEGER,
    prompt_id          TEXT NOT NULL DEFAULT '',
    workflow_id        TEXT NOT NULL,
    workflow_sha256    TEXT NOT NULL,
    model              TEXT NOT NULL,
    seed               INTEGER NOT NULL,
    steps              INTEGER NOT NULL,
    width              INTEGER NOT NULL,
    height             INTEGER NOT NULL,
    prompt             TEXT NOT NULL,
    negative           TEXT NOT NULL DEFAULT '',
    status             TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
    error              TEXT NOT NULL DEFAULT '',
    output_path        TEXT NOT NULL DEFAULT '',
    output_sha256      TEXT NOT NULL DEFAULT '',
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    finished_at        TEXT
  );
  CREATE INDEX comfy_generations_business ON comfy_generations(business_id, id);
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
