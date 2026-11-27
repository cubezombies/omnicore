import { fetchJson } from '../providers/http';
import { MOOD_QUERIES, VOCAL, clearedLicence, type Mood } from './sound';

/**
 * Automatic music and sound-effect discovery through Openverse's official API (openverse.org), which indexes openly
 * licensed audio from Jamendo, Freesound, ccMixter and Wikimedia with machine-readable licences.
 * Only licences that allow commercial use and syncing to video are accepted; anything unclear is refused.
 * Platform music libraries (TikTok's Commercial Music Library etc.) are never searched or downloaded here.
 */

export interface DiscoveredAudio {
  provider: 'openverse';
  providerId: string;
  source: string;
  kind: 'music' | 'sfx';
  title: string;
  creator: string;
  license: string;
  licenseVersion: string;
  licenseUrl: string;
  landingUrl: string;
  fileUrl: string;
  durationSec: number;
  tags: string[];
  attributionRequired: boolean;
  /** The provider's own record, kept as licence evidence. */
  record: unknown;
}

interface OvAudio {
  id: string;
  title: string;
  creator?: string;
  license: string;
  license_version?: string;
  license_url?: string;
  foreign_landing_url?: string;
  url?: string;
  duration?: number;
  source: string;
  tags?: { name: string }[];
  genres?: string[];
  mature?: boolean;
  filetype?: string;
}

const API = 'https://api.openverse.org/v1/audio/';
const MUSIC_SOURCES = new Set(['jamendo', 'ccmixter', 'wikimedia_audio']);

/** Why a result is refused, or null when it is usable. */
export function refuseAudio(r: OvAudio, kind: 'music' | 'sfx', allowShareAlike = false): string | null {
  const lic = clearedLicence(r.license, allowShareAlike);
  if (!lic.ok) return `licence: ${lic.reason}`;
  if (!r.url || !/^https:\/\//.test(r.url)) return 'no direct HTTPS file';
  if (!r.foreign_landing_url) return 'no source page to verify the licence';
  if (r.mature) return 'marked mature';
  const sec = (r.duration ?? 0) / 1000;
  const words = `${r.title} ${(r.tags ?? []).map((t) => t.name).join(' ')}`;
  if (kind === 'music') {
    if (!MUSIC_SOURCES.has(r.source)) return `source ${r.source} is not a music library`;
    if (sec < 45 || sec > 600) return `length ${Math.round(sec)} s (music beds need 45–600 s)`;
    if (VOCAL.test(words)) return 'has vocals, which would compete with the narration';
  } else {
    if (sec <= 0 || sec > 4) return `length ${sec.toFixed(1)} s (effects need up to 4 s)`;
  }
  return null;
}

export async function discoverAudio(kind: 'music' | 'sfx', query: string, opts: { signal?: AbortSignal; allowShareAlike?: boolean; limit?: number } = {}): Promise<{ found: DiscoveredAudio[]; refused: { title: string; reason: string }[] }> {
  const params = new URLSearchParams({ q: query, license: opts.allowShareAlike ? 'cc0,pdm,by,by-sa' : 'cc0,pdm,by', page_size: '20', mature: 'false' });
  if (kind === 'music') params.set('category', 'music');
  else params.set('category', 'sound_effect');
  const res = await fetchJson<{ results: OvAudio[] }>(`${API}?${params}`, { signal: opts.signal, timeoutMs: 30_000 });
  const found: DiscoveredAudio[] = [];
  const refused: { title: string; reason: string }[] = [];
  for (const r of res.results ?? []) {
    const why = refuseAudio(r, kind, opts.allowShareAlike);
    if (why) {
      refused.push({ title: r.title, reason: why });
      continue;
    }
    const lic = clearedLicence(r.license, opts.allowShareAlike);
    found.push({
      provider: 'openverse',
      providerId: r.id,
      source: r.source,
      kind,
      title: r.title.trim(),
      creator: (r.creator ?? '').trim(),
      license: r.license,
      licenseVersion: r.license_version ?? '',
      licenseUrl: r.license_url ?? '',
      landingUrl: r.foreign_landing_url!,
      fileUrl: r.url!,
      durationSec: (r.duration ?? 0) / 1000,
      tags: [...new Set([...(r.genres ?? []), ...(r.tags ?? []).map((t) => t.name)].map((t) => t.toLowerCase()))].slice(0, 12),
      attributionRequired: lic.attribution,
      record: r
    });
    if (found.length >= (opts.limit ?? 5)) break;
  }
  return { found, refused };
}

export const discoverMusicFor = (mood: Mood, o: { signal?: AbortSignal; allowShareAlike?: boolean; limit?: number } = {}) => discoverAudio('music', MOOD_QUERIES[mood], o);

/** Human licence name ("CC BY 4.0", "CC0 1.0"). */
export const licenceName = (a: Pick<DiscoveredAudio, 'license' | 'licenseVersion'>): string =>
  a.license === 'pdm' ? 'Public Domain Mark' : `CC ${a.license.toUpperCase()}${a.licenseVersion ? ` ${a.licenseVersion}` : ''}`;
