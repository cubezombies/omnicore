import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, openDatabase } from '../src/main/db/database';
import { ProductionRepository } from '../src/main/db/productions';
import { SoundLibrary } from '../src/main/library';
import { resolveFfmpeg, runFfmpeg } from '../src/main/media/ffmpeg';
import { verifyAudioRights, KNOWN_PAID_TRACKS } from '../src/main/audio/rights';
import type { DiscoveredAudio } from '../src/main/audio/discovery';
import { runQaChecks } from '../src/main/qa/engine';
import { DEFAULT_SETTINGS, DEFAULT_SOUND_PROFILE } from '../src/shared/production';

// Incident 2026-11-27: paid Jamendo Licensing catalogue tracks entered the library as "CC BY" from Openverse metadata.

const openverse = (over: Partial<DiscoveredAudio>): DiscoveredAudio => ({
  provider: 'openverse',
  providerId: 'x',
  source: 'jamendo',
  kind: 'music',
  title: 't',
  creator: 'c',
  license: 'by',
  licenseVersion: '3.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/3.0/',
  landingUrl: 'https://www.jamendo.com/track/1',
  fileUrl: 'https://prod-1.storage.jamendo.com/?trackid=1&format=mp32',
  durationSec: 0,
  tags: [],
  attributionRequired: true,
  record: {},
  ...over
});

// The two known paid tracks, exactly as Openverse listed them.
const AMBIENT_DANCE = openverse({ providerId: '7d573956-f2f0-457a-9ed6-3b2de0280c4e', title: 'Ambient Dance', creator: 'Zeropage', landingUrl: 'https://www.jamendo.com/track/23557', fileUrl: 'https://prod-1.storage.jamendo.com/?trackid=23557&format=mp32' });
const MEIO_AMBIENTE = openverse({ providerId: '45bc4dac-af0d-4895-9d8a-f8a5bedb2b6a', title: 'Meio Ambiente', creator: 'NeLaS', landingUrl: 'https://www.jamendo.com/track/26646', fileUrl: 'https://prod-1.storage.jamendo.com/?trackid=26646&format=mp32' });

const tmpFile = (bytes = 'audio bytes') => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-')), 'a.mp3');
  fs.writeFileSync(f, bytes);
  return f;
};
const sha1 = (f: string) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const never = async () => {
  throw new Error('no network in tests');
};

describe('rights verification (fail closed)', () => {
  it('rejects both known paid Jamendo Licensing tracks, whatever the index says', async () => {
    for (const a of [AMBIENT_DANCE, MEIO_AMBIENTE]) {
      const v = await verifyAudioRights(a, tmpFile(), never, { jamendoClientId: 'id' });
      expect(v.decision).toBe('rejected');
      expect(v.reasons.join(' ')).toMatch(/known paid track/);
    }
    expect(Object.keys(KNOWN_PAID_TRACKS)).toHaveLength(2);
  });

  it('treats any other Jamendo track as unverifiable without its API, and rejects it when Jamendo says it is in a paid programme', async () => {
    const a = openverse({ providerId: 'other', fileUrl: 'https://prod-1.storage.jamendo.com/?trackid=999&format=mp32' });
    expect((await verifyAudioRights(a, tmpFile(), never)).decision).toBe('unverifiable');
    const api = (inPro: boolean) => async (url: string) => {
      if (url.includes('prolicensing=true')) return { results: inPro ? [{ id: '999' }] : [] };
      if (url.includes('probackground=true')) return { results: [] };
      return { results: [{ id: '999', license_ccurl: 'http://creativecommons.org/licenses/by/3.0/', audiodownload_allowed: true, licenses: {} }] };
    };
    const paid = await verifyAudioRights(a, tmpFile(), api(true), { jamendoClientId: 'id' });
    expect(paid.decision).toBe('rejected');
    expect(paid.reasons.join(' ')).toMatch(/commercial licensing programme/);
    expect((await verifyAudioRights(a, tmpFile(), api(false), { jamendoClientId: 'id' })).decision).toBe('approved');
  });

  it('approves a genuinely free Wikimedia Commons file only when Commons confirms the licence and the exact bytes', async () => {
    const file = tmpFile('free bytes');
    const fileUrl = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Free_bed.ogg';
    const a = openverse({ source: 'wikimedia_audio', license: 'cc0', providerId: 'w1', fileUrl, landingUrl: 'https://commons.wikimedia.org/wiki/File:Free_bed.ogg' });
    const commons = (license: string, hash: string, url = fileUrl) => async () => ({ query: { pages: { '1': { imageinfo: [{ url, sha1: hash, extmetadata: { License: { value: license }, LicenseShortName: { value: license.toUpperCase() } } }] } } } });
    expect((await verifyAudioRights(a, file, commons('cc0', sha1(file)))).decision).toBe('approved');
    expect((await verifyAudioRights(a, file, commons('cc0', 'deadbeef'))).reasons.join(' ')).toMatch(/not byte-identical/);
    expect((await verifyAudioRights(a, file, commons('cc-by-nc-4.0', sha1(file)))).decision).toBe('rejected');
    expect((await verifyAudioRights(a, file, commons('cc-by-4.0', sha1(file)))).reasons.join(' ')).toMatch(/contradiction/);
    expect((await verifyAudioRights(a, file, commons('cc0', sha1(file), 'https://elsewhere/x.ogg'))).reasons.join(' ')).toMatch(/download endpoint/);
  });

  it('never accepts index metadata alone, paid-catalogue links or an unavailable verifier', async () => {
    expect((await verifyAudioRights(openverse({ source: 'freesound', providerId: 'f' }), tmpFile(), never)).decision).toBe('unverifiable');
    expect((await verifyAudioRights(openverse({ providerId: 'p', landingUrl: 'https://licensing.jamendo.com/en/track/5' }), tmpFile(), never)).decision).toBe('rejected');
    const down = await verifyAudioRights(openverse({ source: 'wikimedia_audio', license: 'cc0', providerId: 'w2', fileUrl: 'https://upload.wikimedia.org/x.ogg' }), tmpFile(), never);
    expect(down.decision).toBe('unverifiable');
    expect(down.reasons.join(' ')).toMatch(/verification unavailable/);
  });
});

describe('the approved library', () => {
  const lib = (opts: ConstructorParameters<typeof SoundLibrary>[4]) => {
    const db = openDatabase(':memory:');
    return { db, lib: new SoundLibrary(db, fs.mkdtempSync(path.join(os.tmpdir(), 'lib-')), () => resolveFfmpeg(''), undefined, opts) };
  };
  const realAudio = async (out: string) => {
    await runFfmpeg(resolveFfmpeg(''), ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=50', '-c:a', 'libmp3lame', '-f', 'mp3', out]);
  };

  it('keeps paid tracks out: nothing is added, the refusal is recorded as evidence', async () => {
    const { db, lib: l } = lib({ download: async (_u, f) => realAudio(f), getJson: never, jamendoClientId: 'id' });
    await expect(l.importDiscovered({ ...MEIO_AMBIENTE, durationSec: 50 }, 'calm')).rejects.toThrow(/rights not verified \(rejected\): known paid track/);
    await expect(l.importDiscovered({ ...AMBIENT_DANCE, durationSec: 50 }, 'calm')).rejects.toThrow(/rights not verified/);
    expect(l.list('music').filter((t) => t.origin === 'imported')).toEqual([]);
    const rows = db.prepare('SELECT title, decision FROM audio_rights_decisions WHERE track_id IS NULL ORDER BY id').all() as { title: string; decision: string }[];
    expect(rows.map((r) => [r.title, r.decision])).toEqual([['Meio Ambiente', 'rejected'], ['Ambient Dance', 'rejected']]);
    expect(() => db.prepare("UPDATE audio_rights_decisions SET decision = 'approved'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM audio_rights_decisions').run()).toThrow(/append-only/);
  }, 60_000);

  it('admits a verified free asset as approved, with its decision recorded', async () => {
    let downloaded = '';
    const fileUrl = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Free_bed.ogg';
    const { db, lib: l } = lib({
      download: async (_u, f) => {
        await realAudio(f);
        downloaded = f;
      },
      getJson: async () => ({ query: { pages: { '1': { imageinfo: [{ url: fileUrl, sha1: sha1(downloaded), extmetadata: { License: { value: 'cc0' }, LicenseShortName: { value: 'CC0' } } }] } } } })
    });
    const t = await l.importDiscovered(openverse({ source: 'wikimedia_audio', license: 'cc0', providerId: 'w', fileUrl, durationSec: 50, title: 'Free bed' }), 'calm');
    expect(t.rightsStatus).toBe('approved');
    expect(l.decisions(t.id).map((d) => d.decision)).toEqual(['approved']);
    expect(l.revalidate(t.id).ok).toBe(true);
    void db;
  }, 60_000);
});

describe('quarantine: existing tracks and productions', () => {
  it('quarantines every non-generated sound on upgrade, opens an incident per affected production and keeps everything', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')), 'v12.db');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys = ON;');
    for (let v = 0; v < 12; v++) db.exec(MIGRATIONS[v]);
    db.exec('PRAGMA user_version = 12');
    db.prepare("INSERT INTO audio_library (kind, title, file, duration_sec, license, attribution, source_url, tags, origin, usage, commercial_use, restrictions, rights) VALUES ('music','Meio Ambiente','jamendo-Meio_Ambiente.mp3',140,'CC BY 3.0','NeLaS','https://www.jamendo.com/track/26646','[]','imported','embedded','yes','{}',?)").run(JSON.stringify({ provider: 'openverse', providerTrackId: MEIO_AMBIENTE.providerId }));
    db.prepare("INSERT INTO audio_library (kind, title, file, duration_sec, license, attribution, source_url, tags, origin, usage, commercial_use, restrictions, rights) VALUES ('music','Ambient pad (generated)','ambient-pad.m4a',60,'Generated by Omnicore (no third-party rights)','','','[]','generated','embedded','yes','{}','{}')").run();
    const ch = Number((db.prepare('SELECT id FROM channels LIMIT 1').get() as { id: number }).id);
    const pid = Number(db.prepare("INSERT INTO productions (channel_id, topic) VALUES (?, 'used paid track')").run(ch).lastInsertRowid);
    db.prepare("INSERT INTO production_assets (production_id, kind, path, provider) VALUES (?, 'music', 'library:jamendo-Meio_Ambiente.mp3', 'sound-library')").run(pid);
    db.close();
    const up = openDatabase(file);
    const rows = up.prepare('SELECT title, rights_status FROM audio_library ORDER BY id').all() as { title: string; rights_status: string }[];
    expect(rows.map((r) => [r.title, r.rights_status])).toEqual([['Meio Ambiente', 'quarantined'], ['Ambient pad (generated)', 'approved']]);
    expect((up.prepare('SELECT COUNT(*) n FROM incidents WHERE production_id = ? AND status = ?').get(pid, 'open') as { n: number }).n).toBe(1);
    expect((up.prepare("SELECT COUNT(*) n FROM audio_rights_decisions WHERE decision = 'quarantined'").get() as { n: number }).n).toBe(1);
    up.close();
  });

  it('blocks a quarantined track from selection, overrides, QA and deletion', async () => {
    const db = openDatabase(':memory:');
    const l = new SoundLibrary(db, fs.mkdtempSync(path.join(os.tmpdir(), 'q-')), () => resolveFfmpeg(''));
    const t = await l.generate('ambient-pad');
    db.prepare("UPDATE audio_library SET rights_status = 'quarantined', quarantine_reason = 'incident', tags = '[\"calm\"]', origin = 'imported', license = 'CC BY 3.0' WHERE id = ?").run(t.id);
    const profile = { ...DEFAULT_SOUND_PROFILE, autoDiscover: true };
    const auto = await l.select(DEFAULT_SETTINGS, 1, { mood: 'calm', platforms: ['tiktok'], profile });
    expect(auto.music?.id).not.toBe(t.id); // falls back to a verified generated bed; nothing is downloaded (discovery is off)
    await expect(l.select(DEFAULT_SETTINGS, 1, { mood: 'calm', platforms: ['tiktok'], profile, override: { mode: 'track', trackId: t.id } })).rejects.toThrow(/not cleared/);
    // The quarantined record is evidence: it cannot be edited (editing never approved anyway) or deleted.
    expect(() => l.update(t.id, { commercialUse: 'yes' })).toThrow(/kept unchanged as rights evidence/);
    expect(l.get(t.id)).toMatchObject({ rightsStatus: 'quarantined', license: 'CC BY 3.0' });
    expect(l.revalidate(t.id)).toMatchObject({ ok: false });
    expect(() => l.delete(t.id)).toThrow(/kept as rights evidence/);
    const repo = new ProductionRepository(db);
    const p = repo.create(1, 'x', null, '', 'news', { destinations: [{ platform: 'tiktok', accountId: null, handle: '', privacy: 'private', blockers: [] }] });
    repo.addAsset(p.id, { kind: 'music', sceneIndex: null, path: `library:${t.file}`, provider: 'sound-library', sourceUrl: '', license: 'CC BY 3.0', attribution: 'Meio Ambiente by NeLaS, CC BY 3.0', meta: { trackId: t.id, usage: 'embedded', commercialUse: 'yes', restrictions: {} } });
    const checks = await runQaChecks({ production: repo.get(p.id), dir: os.tmpdir(), ffmpeg: resolveFfmpeg(''), allowShareAlike: false, soundRights: (id) => l.revalidate(id) });
    expect(checks.find((c) => c.checkId === 'rights.audio-revalidated')).toMatchObject({ passed: false, severity: 'critical' });
    const failClosed = await runQaChecks({ production: repo.get(p.id), dir: os.tmpdir(), ffmpeg: resolveFfmpeg(''), allowShareAlike: false });
    expect(failClosed.find((c) => c.checkId === 'rights.audio-revalidated')).toMatchObject({ passed: false });
  }, 180_000);
});
