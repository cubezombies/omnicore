import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowedFor, clearedLicence, storyMood } from '../src/main/audio/sound';
import { refuseAudio } from '../src/main/audio/discovery';
import { musicCredit } from '../src/main/publishing/metadata';
import { openDatabase } from '../src/main/db/database';
import { ProductionRepository } from '../src/main/db/productions';
import { runQaChecks } from '../src/main/qa/engine';
import { SoundLibrary } from '../src/main/library';
import { resolveFfmpeg } from '../src/main/media/ffmpeg';
import { DEFAULT_SETTINGS, DEFAULT_SOUND_PROFILE } from '../src/shared/production';

const sb = (narration: string[]) => ({ scenes: narration.map((n, i) => ({ index: i, narration: n })) }) as never;

describe('story-aware mood', () => {
  it('follows the subject first, then the pace, inside the business preferences', () => {
    expect(storyMood(sb(['Hackers breach a model host.', 'The attack exposed keys and the risk is growing.']), 'news', 2.4)).toBe('tense');
    expect(storyMood(sb(['A breakthrough: the first-ever model to beat the record.']), 'explainer', 2.2)).toBe('inspiring');
    expect(storyMood(sb(['Here is how attention works in transformers.']), 'explainer', 2.2)).toBe('calm');
    expect(storyMood(sb(['Here is how attention works.']), 'news', 2.2)).toBe('upbeat');
    expect(storyMood(sb(['Hackers breach a host.', 'The attack is a risk.']), 'news', 2.4, ['calm', 'upbeat'])).toBe('upbeat');
  });
});

describe('licences', () => {
  it('accepts only licences that allow commercial use and syncing to video', () => {
    expect(clearedLicence('cc0').ok).toBe(true);
    expect(clearedLicence('by')).toMatchObject({ ok: true, attribution: true });
    expect(clearedLicence('by-sa').ok).toBe(false);
    expect(clearedLicence('by-sa', true).ok).toBe(true);
    expect(clearedLicence('by-nc').reason).toMatch(/non-commercial/);
    expect(clearedLicence('by-nd').reason).toMatch(/no adaptations/);
    expect(clearedLicence('mystery').ok).toBe(false);
  });

  it('refuses discovered tracks with vocals, the wrong length, no source page or an unusable licence', () => {
    const base = { id: 'x', title: 'Calm bed', license: 'by', url: 'https://cdn.example/a.mp3', foreign_landing_url: 'https://jamendo.com/track/1', duration: 120_000, source: 'jamendo' };
    expect(refuseAudio(base, 'music')).toBeNull();
    expect(refuseAudio({ ...base, title: 'Night drive (feat. Mia) vocal mix' }, 'music')).toMatch(/vocals/);
    expect(refuseAudio({ ...base, duration: 20_000 }, 'music')).toMatch(/length/);
    expect(refuseAudio({ ...base, foreign_landing_url: undefined }, 'music')).toMatch(/source page/);
    expect(refuseAudio({ ...base, license: 'by-nc' }, 'music')).toMatch(/non-commercial/);
    expect(refuseAudio({ ...base, source: 'freesound', duration: 1500 }, 'sfx')).toBeNull();
  });
});

describe('placement and platforms', () => {


  it('never lets a platform-only or platform-limited track go elsewhere', () => {
    expect(allowedFor({ usage: 'embedded', restrictions: {} }, ['tiktok', 'youtube']).ok).toBe(true);
    expect(allowedFor({ usage: 'embedded', restrictions: { platforms: ['tiktok'] } }, ['tiktok', 'youtube'])).toEqual({ ok: false, blocked: ['youtube'] });
    expect(allowedFor({ usage: 'platform_native', restrictions: { platforms: ['tiktok'] } }, ['tiktok']).ok).toBe(false);
  });

  it('credits attribution-required music in descriptions', () => {
    expect(musicCredit({ assets: [{ kind: 'music', attribution: 'Ambient India by Zeropage, CC BY 3.0', sourceUrl: 'https://www.jamendo.com/track/20232', meta: { rights: { attributionRequired: true } } }] } as never)).toBe(
      'Music: Ambient India by Zeropage, CC BY 3.0 https://www.jamendo.com/track/20232'
    );
    expect(musicCredit({ assets: [{ kind: 'music', attribution: 'Pad', sourceUrl: '', meta: {} }] } as never)).toBe('');
  });
});

describe('selection and QA', () => {
  it('selects only tracks cleared for every destination, honours overrides and falls back to verified generated beds', async () => {
    const db = openDatabase(':memory:');
    const lib = new SoundLibrary(db, fs.mkdtempSync(path.join(os.tmpdir(), 'lib-')), () => resolveFfmpeg(''));
    const profile = { ...DEFAULT_SOUND_PROFILE, autoDiscover: false };
    const a = await lib.select(DEFAULT_SETTINGS, 1, { mood: 'tense', platforms: ['tiktok', 'youtube'], profile });
    expect(a.music?.origin).toBe('generated');
    expect(a.music?.title).toBe('Bright pulse 120 BPM (generated)'); // the phone-audible bed, never the legacy pulse bed
    expect(Object.keys(a).sort()).toEqual(['discovered', 'music', 'refused']); // no automatic effects of any kind
    expect(lib.list('sfx')).toEqual([]); // and none generated
    const none = await lib.select(DEFAULT_SETTINGS, 1, { mood: 'calm', platforms: ['tiktok'], profile, override: { mode: 'none', trackId: null } });
    expect(none.music).toBeNull();
    db.prepare('UPDATE audio_library SET restrictions = ? WHERE id = ?').run(JSON.stringify({ platforms: ['tiktok'] }), a.music!.id);
    await expect(lib.select(DEFAULT_SETTINGS, 1, { mood: 'calm', platforms: ['youtube'], profile, override: { mode: 'track', trackId: a.music!.id } })).rejects.toThrow(/not licensed for youtube/);
  }, 180_000);

  it('fails QA when required music is missing or a track is not licensed for a destination', async () => {
    const db = openDatabase(':memory:');
    const repo = new ProductionRepository(db);
    const p = repo.create(1, 'test', null, '', 'news', { destinations: [{ platform: 'youtube', accountId: null, handle: '', privacy: 'private', blockers: [] }] });
    const ffmpeg = resolveFfmpeg('');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-'));
    let checks = await runQaChecks({ production: repo.get(p.id), dir, ffmpeg, allowShareAlike: false });
    expect(checks.find((c) => c.checkId === 'audio.music-present')).toMatchObject({ passed: false, severity: 'major' });
    checks = await runQaChecks({ production: repo.get(p.id), dir, ffmpeg, allowShareAlike: false, musicRequired: false });
    expect(checks.find((c) => c.checkId === 'audio.music-present')).toMatchObject({ passed: true, severity: 'minor' });
    repo.addAsset(p.id, {
      kind: 'music',
      sceneIndex: null,
      path: 'library:t.mp3',
      provider: 'sound-library',
      sourceUrl: 'https://x',
      license: 'CC BY 4.0',
      attribution: 'T by C, CC BY 4.0',
      meta: { usage: 'embedded', commercialUse: 'yes', restrictions: { platforms: ['tiktok'] }, rights: { attributionRequired: true } }
    });
    checks = await runQaChecks({ production: repo.get(p.id), dir, ffmpeg, allowShareAlike: false });
    expect(checks.find((c) => c.checkId === 'rights.audio-platforms')).toMatchObject({ passed: false, severity: 'critical' });
    expect(checks.find((c) => c.checkId === 'rights.audio-evidence')).toMatchObject({ passed: false });
    expect(checks.find((c) => c.checkId === 'rights.audio-attribution')).toMatchObject({ passed: false, repairAction: 'metadata' });
  }, 60_000);
});

describe('vocal check', () => {
  it('ignores music tags and reports the words a recogniser hears', async () => {
    const db = openDatabase(':memory:');
    const replies = ['[Music]', 'and I will always love you'];
    const lib = new SoundLibrary(db, fs.mkdtempSync(path.join(os.tmpdir(), 'lib-')), () => resolveFfmpeg(''), async () => replies.shift() ?? '');
    const bed = await lib.generate('ambient-pad');
    expect(await lib.heardWords(lib.pathOf(bed), bed.durationSec)).toBe('and I will always love you');
    const quiet = new SoundLibrary(db, lib.dir, () => resolveFfmpeg(''), async () => '(upbeat music) ♪');
    expect(await quiet.heardWords(lib.pathOf(bed), bed.durationSec)).toBe('');
  }, 60_000);
});
