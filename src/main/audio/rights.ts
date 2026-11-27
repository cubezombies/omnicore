import crypto from 'node:crypto';
import fs from 'node:fs';
import type { DiscoveredAudio } from './discovery';
import { clearedLicence } from './sound';

/**
 * Rights gate for third-party audio. Fail closed: a track is approved only when the provider's own source of record
 * confirms the exact asset, its licence and its commercial-use permission. Aggregator metadata (Openverse), domains,
 * search results and provider labels are never enough on their own.
 *
 * Incident 2026-11-27: tracks listed on Openverse as CC BY were Jamendo Licensing (paid) catalogue tracks
 * ("Ambient Dance" by Zeropage, "Meio Ambiente" by NeLaS). Jamendo runs a paid licensing catalogue alongside its
 * free Creative Commons one, so a Jamendo track is approved only when Jamendo's API (with a client id) confirms a
 * free CC licence, that the track is not in its commercial programmes and that download is allowed.
 */

export type RightsDecision = 'approved' | 'rejected' | 'unverifiable';

export interface RightsVerdict {
  decision: RightsDecision;
  verifier: string;
  reasons: string[];
  /** What the source of record said (kept as immutable evidence). */
  evidence: Record<string, unknown>;
}

export type JsonFetch = (url: string) => Promise<unknown>;

/** Known paid Jamendo Licensing catalogue tracks (Openverse ids), rejected outright. */
export const KNOWN_PAID_TRACKS: Record<string, string> = {
  '7d573956-f2f0-457a-9ed6-3b2de0280c4e': 'Ambient Dance by Zeropage (Jamendo Licensing catalogue)',
  '45bc4dac-af0d-4895-9d8a-f8a5bedb2b6a': 'Meio Ambiente by NeLaS (Jamendo Licensing catalogue)'
};

/** Signs of a paid or subscription catalogue in URLs or text. */
const PAID = /licensing\.jamendo|jamendo\s*(pro|licensing)|prolicensing|probackground|subscription|royalty[- ]free licen|buy (a )?licen|purchase/i;

const sha1 = (file: string) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');

/** Wikimedia Commons: the file page's own licence metadata and SHA-1 must match the downloaded file. */
async function verifyWikimedia(a: DiscoveredAudio, file: string, get: JsonFetch): Promise<RightsVerdict> {
  const v = 'wikimedia-commons-api';
  const name = decodeURIComponent((a.fileUrl.split('/').pop() ?? '').replace(/^\d+px-/, ''));
  if (!name) return { decision: 'unverifiable', verifier: v, reasons: ['cannot tell which Commons file this is'], evidence: {} };
  const url = `https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|sha1|extmetadata&titles=${encodeURIComponent(`File:${name}`)}`;
  const res = (await get(url)) as { query?: { pages?: Record<string, { imageinfo?: { url: string; sha1: string; extmetadata?: Record<string, { value?: string }> }[] }> } };
  const info = Object.values(res.query?.pages ?? {})[0]?.imageinfo?.[0];
  if (!info) return { decision: 'unverifiable', verifier: v, reasons: ['Commons has no record of this file'], evidence: { url } };
  const m = info.extmetadata ?? {};
  const short = (m.LicenseShortName?.value ?? '').trim();
  const lic = (m.License?.value ?? '').toLowerCase();
  const evidence = { url, fileUrl: info.url, sha1: info.sha1, license: lic, licenseShortName: short, licenseUrl: m.LicenseUrl?.value ?? '', usageTerms: m.UsageTerms?.value ?? '', attributionRequired: m.AttributionRequired?.value ?? '' };
  const reasons: string[] = [];
  if (info.url !== a.fileUrl) reasons.push(`download endpoint ${a.fileUrl} is not the file Commons describes (${info.url})`);
  if (info.sha1 !== sha1(file)) reasons.push('the downloaded file is not byte-identical to the Commons file');
  const norm = lic === 'cc0' || lic === 'pd' || /^public domain/i.test(short) ? 'cc0' : /^cc-by-\d/.test(lic) ? 'by' : /^cc-by-sa/.test(lic) ? 'by-sa' : lic;
  const ok = clearedLicence(norm);
  if (!ok.ok) reasons.push(`Commons licence "${short || lic}": ${ok.reason}`);
  if (a.license !== norm && !(a.license === 'pdm' && norm === 'cc0')) reasons.push(`contradiction: the index says ${a.license}, Commons says ${short || lic}`);
  return { decision: reasons.length ? 'rejected' : 'approved', verifier: v, reasons: reasons.length ? reasons : [`Commons confirms ${short} for this exact file (SHA-1 match)`], evidence };
}

/** Jamendo: only its API (client id required) can confirm a free CC licence outside its paid programmes. */
async function verifyJamendo(a: DiscoveredAudio, _file: string, get: JsonFetch, clientId?: string): Promise<RightsVerdict> {
  const v = 'jamendo-api';
  const trackId = /trackid=(\d+)/.exec(a.fileUrl)?.[1] ?? /\/track\/(\d+)/.exec(a.landingUrl)?.[1];
  if (!clientId) return { decision: 'unverifiable', verifier: v, reasons: ['Jamendo runs a paid licensing catalogue beside its free one; only its API can tell them apart, and no Jamendo API client id is configured'], evidence: { trackId } };
  if (!trackId) return { decision: 'unverifiable', verifier: v, reasons: ['no Jamendo track id'], evidence: {} };
  const base = `https://api.jamendo.com/v3.0/tracks/?client_id=${encodeURIComponent(clientId)}&format=json&id=${trackId}&include=licenses`;
  const all = (await get(base)) as { results?: Record<string, unknown>[] };
  const t = all.results?.[0];
  if (!t) return { decision: 'unverifiable', verifier: v, reasons: ['Jamendo has no record of this track'], evidence: { trackId } };
  const pro = (await get(`${base}&prolicensing=true`)) as { results?: unknown[] };
  const bg = (await get(`${base}&probackground=true`)) as { results?: unknown[] };
  const ccurl = String(t.license_ccurl ?? '');
  const reasons: string[] = [];
  if ((pro.results ?? []).length || (bg.results ?? []).length) reasons.push('the track is in a Jamendo commercial licensing programme (paid catalogue)');
  if (t.audiodownload_allowed !== true) reasons.push('Jamendo does not allow download of this track');
  if (PAID.test(JSON.stringify(t.licenses ?? {}))) reasons.push('Jamendo lists paid licensing terms for this track');
  const m = /creativecommons\.org\/(licenses\/([a-z-]+)|publicdomain\/zero)/.exec(ccurl);
  const lic = m ? (m[1].startsWith('publicdomain') ? 'cc0' : m[2]) : '';
  const ok = clearedLicence(lic);
  if (!ok.ok) reasons.push(`Jamendo licence ${ccurl || 'missing'}: ${ok.reason}`);
  if (lic && a.license !== lic) reasons.push(`contradiction: the index says ${a.license}, Jamendo says ${lic}`);
  return { decision: reasons.length ? 'rejected' : 'approved', verifier: v, reasons: reasons.length ? reasons : [`Jamendo confirms ${ccurl}, not in any commercial programme, download allowed`], evidence: { trackId, license_ccurl: ccurl, audiodownload_allowed: t.audiodownload_allowed, licenses: t.licenses, inProLicensing: (pro.results ?? []).length > 0, inProBackground: (bg.results ?? []).length > 0 } };
}

/**
 * Decide whether a discovered track may enter the approved library. Anything not positively confirmed by the
 * provider's own source of record is rejected; verification errors count as unverifiable (fail closed).
 */
export async function verifyAudioRights(a: DiscoveredAudio, file: string, get: JsonFetch, opts: { jamendoClientId?: string } = {}): Promise<RightsVerdict> {
  if (KNOWN_PAID_TRACKS[a.providerId]) return { decision: 'rejected', verifier: 'known-paid-list', reasons: [`known paid track: ${KNOWN_PAID_TRACKS[a.providerId]}`], evidence: { providerId: a.providerId } };
  if (PAID.test(`${a.fileUrl} ${a.landingUrl} ${a.licenseUrl}`)) return { decision: 'rejected', verifier: 'paid-catalogue-check', reasons: ['the asset links to a paid or subscription catalogue'], evidence: { fileUrl: a.fileUrl, landingUrl: a.landingUrl } };
  const lic = clearedLicence(a.license);
  if (!lic.ok) return { decision: 'rejected', verifier: 'licence-check', reasons: [lic.reason], evidence: { license: a.license } };
  try {
    if (a.source === 'wikimedia_audio') return await verifyWikimedia(a, file, get);
    if (a.source === 'jamendo') return await verifyJamendo(a, file, get, opts.jamendoClientId);
  } catch (e) {
    return { decision: 'unverifiable', verifier: a.source, reasons: [`verification unavailable: ${(e as Error).message}`], evidence: {} };
  }
  return { decision: 'unverifiable', verifier: 'none', reasons: [`no source-of-record verifier for ${a.source}; index metadata alone is never accepted`], evidence: {} };
}
