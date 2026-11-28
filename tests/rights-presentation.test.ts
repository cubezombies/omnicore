import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/main/db/database';
import { SoundLibrary } from '../src/main/library';
import { resolveFfmpeg } from '../src/main/media/ffmpeg';
import { rightsHistory, trackRightsDetails } from '../src/main/audio/compliance';
import { classifyVerification, QUARANTINE_SUMMARY, RIGHTS_STATUS, trackSummary } from '../src/shared/rights';
import { DEFAULT_SETTINGS, DEFAULT_SOUND_PROFILE, type AudioTrack } from '../src/shared/production';

// The 27 Nov 2026 incident as it is recorded in the live database: four Jamendo tracks imported as CC BY 3.0 from
// Openverse index metadata; Ambient Dance and Meio Ambiente are known paid Jamendo Licensing tracks, Ambient India and
// Ambient Voyager are unverified; all four quarantined by decision "incident-2026-11-27"; incidents #1 and #2.
const REASON = 'Rights incident 2026-11-27: imported from index metadata (Openverse) without verification at the source of record; paid Jamendo Licensing catalogue tracks were listed as CC BY.';
const TRACKS = [
  { title: 'Ambient Dance', creator: 'Zeropage', file: 'jamendo-Ambient_Dance.mp3', ov: '7d573956-f2f0-457a-9ed6-3b2de0280c4e', jam: 23557, incident: true },
  { title: 'Ambient India', creator: 'Zeropage', file: 'jamendo-Ambient_India.mp3', ov: '7ddc1cd0-615c-4b1d-997f-74b93335693f', jam: 20232, incident: false },
  { title: 'Ambient Voyager', creator: 'Zeropage', file: 'jamendo-Ambient_Voyager.mp3', ov: '297e676f-18e5-478c-9a39-e707f56eb5be', jam: 20231, incident: false },
  { title: 'Meio Ambiente', creator: 'NeLaS', file: 'jamendo-Meio_Ambiente.mp3', ov: '45bc4dac-af0d-4895-9d8a-f8a5bedb2b6a', jam: 26646, incident: true }
];

let db: DatabaseSync;
let lib: SoundLibrary;
let dir: string;
const ids: Record<string, number> = {};
let otherBusiness: number;

function seed(): void {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rights-ui-'));
  db = openDatabase(':memory:');
  lib = new SoundLibrary(db, dir, () => resolveFfmpeg(''));
  fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  for (const t of TRACKS) {
    fs.writeFileSync(path.join(dir, t.file), `fake mp3 ${t.title}`);
    const evidence = JSON.stringify({ provider: 'openverse', record: { id: t.ov, title: t.title, license: 'by', license_version: '3.0', foreign_landing_url: `https://www.jamendo.com/track/${t.jam}` } });
    fs.writeFileSync(path.join(dir, 'evidence', `${t.file}.json`), evidence);
    const sha = require('node:crypto').createHash('sha256').update(evidence).digest('hex');
    const rights = { provider: 'openverse', providerTrackId: t.ov, source: 'jamendo', licenseUrl: 'https://creativecommons.org/licenses/by/3.0/', landingUrl: `https://www.jamendo.com/track/${t.jam}`, attributionRequired: true, evidenceSha256: sha, verifiedAt: '2026-11-27T22:19:12.172Z' };
    const r = db
      .prepare("INSERT INTO audio_library (kind, title, file, duration_sec, license, attribution, source_url, tags, origin, usage, commercial_use, restrictions, rights, rights_status, quarantine_reason) VALUES ('music',?,?,120,'CC BY 3.0',?,?,'[\"calm\"]','imported','embedded','unknown','{}',?,'quarantined',?)")
      .run(t.title, t.file, t.creator, `https://www.jamendo.com/track/${t.jam}`, JSON.stringify(rights), REASON);
    ids[t.title] = Number(r.lastInsertRowid);
    db.prepare("INSERT INTO audio_rights_decisions (track_id, provider, provider_track_id, title, decision, verifier, reasons, decided_at) VALUES (?, 'openverse', ?, ?, 'quarantined', 'incident-2026-11-27', ?, '2026-11-27T23:25:43.907Z')").run(ids[t.title], t.ov, t.title, JSON.stringify([REASON]));
    if (t.incident) db.prepare("INSERT INTO incidents (business_id, kind, production_id, asset_key, description, created_at) VALUES (1, 'rights_complaint', NULL, ?, ?, '2026-11-27T23:25:43.907Z')").run(`library:${t.file}`, `Music "${t.title}" is quarantined (rights incident 2026-11-27).`);
  }
  const ev = (ts: string, type: string, pid: number | null, data: unknown, business: number | null = null) =>
    db.prepare("INSERT INTO audit_events (ts, actor, type, production_id, business_id, data, prev_hash, hash) VALUES (?, 'pipeline', ?, ?, ?, ?, 'x', ?)").run(ts, type, pid, business, JSON.stringify(data), `${type}-${pid}-${ts}`);
  ev('2026-11-27T22:25:12Z', 'audio.selected', 19, { music: { id: ids['Meio Ambiente'], title: 'Meio Ambiente', license: 'CC BY 3.0' } });
  ev('2026-11-27T22:25:48Z', 'render.output', 19, { sha256: 'be8e08d7' });
  ev('2026-11-27T22:38:21Z', 'audio.selected', 11, { music: { id: ids['Ambient Dance'], title: 'Ambient Dance' } });
  ev('2026-11-27T22:38:47Z', 'render.output', 11, { sha256: 'aaaa1111' });
  ev('2026-11-27T23:38:00Z', 'audio.selected', 19, { music: { id: 999, title: 'Pulse bed' } }); // corrected render: not affected
  ev('2026-11-27T23:40:49Z', 'render.output', 19, { sha256: 'e424bef2' });
  ev('2026-11-27T23:44:22Z', 'production.deleted', 19, { topic: 'build maintain agentic evaluation' }, 1);
  ev('2026-11-27T23:50:00Z', 'production.deleted', 11, { topic: 'an earlier story' }, 1);
  db.prepare("INSERT INTO publications (production_id, production_number, production_topic, platform, privacy_requested, privacy_applied, status, remote_id, render_sha256, deleted_at, deletion_source, created_at) VALUES (NULL, 19, 'build maintain agentic evaluation', 'tiktok', 'SELF_ONLY', 'SELF_ONLY', 'published', 'v_pub_file~v2-1.77', '', '2026-11-28T00:05:58Z', 'user', '2026-11-27T22:38:01Z')").run();
  otherBusiness = Number(db.prepare("INSERT INTO channels (name, slug) VALUES ('Second business', 'second-business')").run().lastInsertRowid);
}

const snapshot = () =>
  JSON.stringify(['audio_library', 'audio_rights_decisions', 'incidents', 'publications', 'audit_events', 'productions'].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));

beforeEach(seed);

describe('concise track summaries', () => {
  it('a quarantined track shows only its status line: no historical CC BY licence, no attribution, not eligible', () => {
    const t = lib.get(ids['Meio Ambiente']);
    const s = trackSummary(t);
    expect(s).toMatchObject({ status: 'quarantined', statusLabel: 'Quarantined', statusLine: QUARANTINE_SUMMARY, licence: null, attribution: null, commercial: { eligible: false } });
    expect(JSON.stringify(s)).not.toMatch(/CC BY/);
    expect(JSON.stringify(s)).not.toMatch(/incident|Openverse/i); // the narrative lives in Rights & Compliance history
  });

  it('uses the four statuses with their meanings, and never shows a licence for anything but Approved', () => {
    expect(Object.fromEntries(Object.entries(RIGHTS_STATUS).map(([k, v]) => [k, v.label]))).toEqual({ approved: 'Approved', quarantined: 'Quarantined', unverified: 'Unverified', rejected: 'Rejected' });
    const base = lib.get(ids['Ambient India']);
    for (const status of ['unverified', 'rejected', 'quarantined'] as const) {
      const s = trackSummary({ ...base, rightsStatus: status, commercialUse: 'yes' });
      expect(s.licence).toBeNull();
      expect(s.commercial.eligible).toBe(false);
    }
  });

  it('an approved track that requires credit still shows its attribution and licence', () => {
    const approved: AudioTrack = { ...lib.get(ids['Ambient India']), rightsStatus: 'approved', commercialUse: 'yes', license: 'CC BY 4.0', attribution: 'Some Artist' };
    expect(trackSummary(approved)).toMatchObject({ statusLabel: 'Approved', licence: 'CC BY 4.0', attribution: 'Credit required: Some Artist, CC BY 4.0', commercial: { eligible: true, label: 'Eligible for commercial use' } });
  });
});

describe('verification is labelled for what it is', () => {
  it('Openverse metadata is a historical index claim and cannot establish a licence on its own', () => {
    const t = lib.get(ids['Meio Ambiente']);
    const v = classifyVerification(t, lib.decisions(t.id).map((d) => ({ decision: d.decision, verifier: d.verifier })));
    expect(v).toMatchObject({ kind: 'index-metadata', establishesLicence: false });
    expect(v.label).toBe('Historical claim: Openverse/index metadata only, insufficient to establish licensing at the source of record.');
    // Even an "approved" decision by a non-source-of-record verifier does not count.
    expect(classifyVerification(t, [{ decision: 'approved', verifier: 'openverse' }]).establishesLicence).toBe(false);
    // A source-of-record approval followed by a quarantine is not a current verification.
    expect(classifyVerification(t, [{ decision: 'approved', verifier: 'jamendo-api' }, { decision: 'quarantined', verifier: 'incident-2026-11-27' }]).establishesLicence).toBe(false);
    expect(classifyVerification(t, [{ decision: 'approved', verifier: 'jamendo-api' }]).kind).toBe('source-of-record');
  });
});

describe('full evidence stays accessible', () => {
  it('shows the source, asset id, historical licence claim, hashes, decisions, incident and what is missing', () => {
    const d = trackRightsDetails(db, lib, ids['Meio Ambiente'], 1);
    expect(d.knownPaid).toBe('Meio Ambiente by NeLaS (Jamendo Licensing catalogue)');
    expect(d.source).toMatchObject({ provider: 'openverse', sourceName: 'jamendo', sourceOfRecordUrl: 'https://www.jamendo.com/track/26646', assetId: '45bc4dac-af0d-4895-9d8a-f8a5bedb2b6a' });
    expect(d.recordedLicence).toMatchObject({ value: 'CC BY 3.0', historical: true });
    expect(d.verification.kind).toBe('index-metadata');
    expect(d.evidence).toMatchObject({ present: true, matchesRecord: true });
    expect(d.file).toMatchObject({ present: true, recordedSha256: null, identityVerified: false });
    expect(d.permissions).toEqual({ download: null, modification: null }); // not inferred from the CC BY claim
    expect(d.missing).toEqual(expect.arrayContaining(['source-of-record verification of the licence', 'file hash recorded at import (the file cannot be matched to the source)', 'download permission from the source of record']));
    expect(d.decisions).toHaveLength(1);
    expect(d.reason).toBe(REASON);
    expect(d.incidents.map((i) => i.historyKey)).toEqual(['incident-2026-11-27']);
    expect(d.commercialUse).toMatch(/not usable while quarantined/);
  });

  it('distinguishes the known paid tracks from the unverified ones', () => {
    expect(trackRightsDetails(db, lib, ids['Ambient Dance'], 1).knownPaid).toMatch(/Jamendo Licensing/);
    expect(trackRightsDetails(db, lib, ids['Ambient India'], 1).knownPaid).toBeNull();
    expect(trackRightsDetails(db, lib, ids['Ambient Voyager'], 1).knownPaid).toBeNull();
  });
});

describe('Rights & Compliance history', () => {
  it('documents the incident once: assets, findings, productions, renders, publications, actions and status', () => {
    const [h, ...rest] = rightsHistory(db, lib, 1);
    expect(rest).toEqual([]);
    expect(h).toMatchObject({ key: 'incident-2026-11-27', title: 'Jamendo/Openverse licensing incident', status: 'open' });
    expect(h.assets.map((a) => [a.title, a.category, a.status])).toEqual([
      ['Ambient Dance', 'known paid track', 'quarantined'],
      ['Ambient India', 'licensing unverified', 'quarantined'],
      ['Ambient Voyager', 'licensing unverified', 'quarantined'],
      ['Meio Ambiente', 'known paid track', 'quarantined']
    ]);
    expect(h.incidents.map((i) => i.id)).toEqual([1, 2]);
    expect(h.verification[0]).toMatch(/Openverse index metadata only/);
    const p19 = h.productions.find((p) => p.productionNumber === 19)!;
    expect(p19).toMatchObject({ topic: 'build maintain agentic evaluation', deleted: true });
    expect(p19.renders.map((r) => r.sha256)).toEqual(['be8e08d7']); // not the corrected Pulse-bed render
    expect(p19.publications).toMatchObject([{ platform: 'tiktok', privacy: 'SELF_ONLY' }]);
    expect(h.productions.find((p) => p.productionNumber === 11)?.renders.map((r) => r.sha256)).toEqual(['aaaa1111']);
    expect(h.correctiveActions.join(' ')).toMatch(/4 track\(s\) quarantined/);
    expect(h.correctiveActions.join(' ')).toMatch(/recorded as deleted/);
  });

  it("another business sees the shared library's quarantine record, but none of this business's productions, publications or incident records", () => {
    const [h, ...rest] = rightsHistory(db, lib, otherBusiness);
    expect(rest).toEqual([]);
    expect(h.assets).toHaveLength(4); // the library is shared: the same tracks are quarantined everywhere
    expect(h.productions).toEqual([]);
    expect(h.incidents).toEqual([]);
    expect(h.correctiveActions.join(' ')).not.toMatch(/Production \d|Publication attempt/);
    expect(trackRightsDetails(db, lib, ids['Meio Ambiente'], otherBusiness).incidents).toEqual([]);
  });

  it('shows the same rights status in every business workspace', () => {
    for (const t of TRACKS) expect(trackRightsDetails(db, lib, ids[t.title], otherBusiness).summary).toEqual(trackRightsDetails(db, lib, ids[t.title], 1).summary);
  });

  it('reading the rights views changes no record', () => {
    const before = snapshot();
    for (const t of TRACKS) trackRightsDetails(db, lib, ids[t.title], 1);
    rightsHistory(db, lib, 1);
    rightsHistory(db, lib, otherBusiness);
    expect(snapshot()).toBe(before);
  });
});

describe('enforcement is unchanged or stricter', () => {
  it('all four quarantined tracks stay unavailable: not selectable, not revalidated, not editable, not deletable', async () => {
    for (const t of TRACKS) {
      const id = ids[t.title];
      expect(lib.revalidate(id).ok).toBe(false);
      await expect(lib.select(DEFAULT_SETTINGS, 1, { mood: 'calm', platforms: ['tiktok'], profile: DEFAULT_SOUND_PROFILE, override: { mode: 'track', trackId: id } })).rejects.toThrow(/not cleared/);
      expect(() => lib.update(id, { license: 'CC0', commercialUse: 'yes' })).toThrow(/kept unchanged as rights evidence/);
      expect(() => lib.delete(id)).toThrow(/kept as rights evidence/);
      expect(lib.get(id)).toMatchObject({ rightsStatus: 'quarantined', license: 'CC BY 3.0', commercialUse: 'unknown' });
    }
  });

  it('an unverified track cannot be selected, and recording a licence on it does not approve it', async () => {
    const id = ids['Ambient India'];
    db.prepare("UPDATE audio_library SET rights_status = 'unverified' WHERE id = ?").run(id);
    lib.update(id, { license: 'CC0', commercialUse: 'yes' });
    expect(lib.get(id).rightsStatus).toBe('unverified');
    expect(lib.revalidate(id).ok).toBe(false);
    await expect(lib.select(DEFAULT_SETTINGS, 1, { mood: 'calm', platforms: ['tiktok'], profile: DEFAULT_SOUND_PROFILE, override: { mode: 'track', trackId: id } })).rejects.toThrow(/not cleared/);
  });

  it("an approved sound's licence details only change through verification; rejected sounds are kept as evidence", () => {
    const id = ids['Ambient Voyager'];
    db.prepare("UPDATE audio_library SET rights_status = 'approved', commercial_use = 'yes' WHERE id = ?").run(id);
    expect(() => lib.update(id, { license: 'CC0' })).toThrow(/only change through rights verification/);
    expect(lib.update(id, { tags: ['calm', 'piano'] }).tags).toEqual(['calm', 'piano']);
    db.prepare("UPDATE audio_library SET rights_status = 'rejected' WHERE id = ?").run(id);
    expect(() => lib.delete(id)).toThrow(/rejected; it is kept as rights evidence/);
  });
});
