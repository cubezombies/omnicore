import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AudioTrack } from '../../shared/production';
import { classifyVerification, trackSummary, type HistoryEntry, type RightsDecisionRecord, type TrackRightsDetails } from '../../shared/rights';
import type { SoundLibrary } from '../library';
import { KNOWN_PAID_TRACKS } from './rights';

/**
 * Read-only views of the rights record: the full evidence for one sound, and the incident history of a business.
 * Nothing here changes a decision, a status or a record; enforcement stays in library.revalidate/embeddable.
 */

type Row = Record<string, unknown>;
const sha256 = (file: string): string | null => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null);




const decisionsOf = (db: DatabaseSync, trackId: number): RightsDecisionRecord[] =>
  (db.prepare('SELECT id, decision, verifier, reasons, evidence_sha256, decided_at FROM audio_rights_decisions WHERE track_id = ? ORDER BY id').all(trackId) as Row[]).map((r) => ({
    id: Number(r.id),
    decision: String(r.decision),
    verifier: String(r.verifier),
    reasons: JSON.parse(String(r.reasons)) as string[],
    evidenceSha256: String(r.evidence_sha256 ?? ''),
    decidedAt: String(r.decided_at)
  }));

/** History key of a decision: one entry per incident (verifier "incident-YYYY-MM-DD"). */
const historyKeyOf = (verifier: string): string | null => (verifier.startsWith('incident-') ? verifier : null);

export function trackRightsDetails(db: DatabaseSync, library: SoundLibrary, trackId: number, businessId: number): TrackRightsDetails {
  const t: AudioTrack = library.get(trackId);
  const decisions = decisionsOf(db, trackId);
  const verification = classifyVerification(t, decisions);
  const r = t.rights ?? {};
  const evidenceFile = path.join(library.dir, 'evidence', `${t.file}.json`);
  const evidenceSha = sha256(evidenceFile);
  let evidenceJson: Record<string, unknown> | null = null;
  try {
    evidenceJson = evidenceSha ? (JSON.parse(fs.readFileSync(evidenceFile, 'utf8')) as Record<string, unknown>) : null;
  } catch {
    evidenceJson = null;
  }
  // Download/modification permission only from source-of-record evidence (an approving verifier's record).
  const sorEvidence = verification.kind === 'source-of-record' ? evidenceJson : null;
  const perm = (k: string): string | null => {
    const v = (sorEvidence?.[k] ?? null) as string | boolean | null;
    return v === null ? null : String(v);
  };
  const recordedFileSha = typeof (r as Record<string, unknown>).fileSha256 === 'string' ? String((r as Record<string, unknown>).fileSha256) : null;
  const fileSha = sha256(library.pathOf(t));
  const incidentHistory = decisions.map((d) => historyKeyOf(d.verifier)).find(Boolean) ?? null;
  const incidents = (db.prepare("SELECT id, status, created_at, resolved_at FROM incidents WHERE business_id = ? AND asset_key = ? ORDER BY id").all(businessId, `library:${t.file}`) as Row[]).map((i) => ({
    id: Number(i.id),
    status: i.status as 'open' | 'resolved',
    createdAt: String(i.created_at),
    resolvedAt: (i.resolved_at as string) ?? null,
    historyKey: incidentHistory ?? `incident-${String(i.created_at).slice(0, 10)}`
  }));
  const last = decisions.at(-1);
  const knownPaid = r.providerTrackId ? (KNOWN_PAID_TRACKS[r.providerTrackId] ?? null) : null;
  const missing: string[] = [];
  if (t.origin !== 'generated') {
    if (verification.kind !== 'source-of-record') missing.push('source-of-record verification of the licence');
    if (!recordedFileSha) missing.push('file hash recorded at import (the file cannot be matched to the source)');
    if (!perm('download')) missing.push('download permission from the source of record');
    if (!perm('modification')) missing.push('modification (sync/edit) permission from the source of record');
    if (!r.landingUrl && !t.sourceUrl) missing.push('source page');
    if (!evidenceSha) missing.push('evidence record file');
  }
  return {
    trackId: t.id,
    title: t.title,
    summary: trackSummary(t),
    verification,
    knownPaid,
    source: { origin: t.origin, provider: r.provider ?? null, sourceName: r.source ?? null, sourceOfRecordUrl: r.landingUrl || t.sourceUrl || null, assetId: r.providerTrackId ?? null, licenceUrl: r.licenseUrl ?? null },
    recordedLicence: { value: t.license || null, historical: t.rightsStatus !== 'approved', recordedAt: r.verifiedAt ?? null },
    commercialUse: t.rightsStatus === 'approved' ? t.commercialUse : `${t.commercialUse} (not usable while ${t.rightsStatus})`,
    attributionRequired: typeof r.attributionRequired === 'boolean' ? r.attributionRequired : null,
    attributionText: t.attribution || null,
    permissions: { download: perm('download'), modification: perm('modification') },
    file: { name: t.file, present: fileSha !== null, sha256: fileSha, recordedSha256: recordedFileSha, identityVerified: !!recordedFileSha && recordedFileSha === fileSha },
    evidence: { file: `evidence/${t.file}.json`, present: evidenceSha !== null, sha256: evidenceSha, recordedSha256: r.evidenceSha256 ?? null, matchesRecord: evidenceSha && r.evidenceSha256 ? evidenceSha === r.evidenceSha256 : null },
    decisions,
    incidents,
    reason: t.rightsStatus === 'quarantined' || t.rightsStatus === 'rejected' ? (last?.reasons.join(' ') || t.quarantineReason || null) : null,
    missing
  };
}


/** Narratives for known incidents (kept here once, instead of on every track). */
const NARRATIVE: Record<string, { title: string; text: string }> = {
  'incident-2026-11-27': {
    title: 'Jamendo/Openverse licensing incident',
    text:
      'Music was imported from Openverse search results, which listed these Jamendo tracks as CC BY 3.0. Openverse is an index, not the source of record, and Jamendo also sells tracks through its paid Jamendo Licensing catalogue. Two of the tracks were identified as paid Jamendo Licensing tracks; the licensing of the other two could not be verified at Jamendo. All four were quarantined.'
  }
};

/** The rights incident history of a business: what happened, which assets and productions, and what was done. */
export function rightsHistory(db: DatabaseSync, library: SoundLibrary, businessId: number): HistoryEntry[] {
  const incidents = db.prepare("SELECT * FROM incidents WHERE business_id = ? AND kind = 'rights_complaint' ORDER BY id").all(businessId) as Row[];
  const decisions = db.prepare("SELECT * FROM audio_rights_decisions WHERE verifier LIKE 'incident-%' ORDER BY id").all() as Row[];
  const keys = [...new Set(decisions.map((d) => String(d.verifier)))];
  const ownerOf = (pid: number): number | null => {
    const live = db.prepare('SELECT channel_id FROM productions WHERE id = ?').get(pid) as Row | undefined;
    if (live) return Number(live.channel_id);
    const del = db.prepare("SELECT business_id FROM audit_events WHERE type = 'production.deleted' AND production_id = ? AND business_id IS NOT NULL ORDER BY id DESC LIMIT 1").get(pid) as Row | undefined;
    return del ? Number(del.business_id) : null;
  };
  const used = new Set<number>();
  const entries: HistoryEntry[] = keys.map((key) => {
    const ds = decisions.filter((d) => d.verifier === key);
    const trackIds = [...new Set(ds.map((d) => Number(d.track_id)).filter((x) => Number.isFinite(x)))];
    const assets = trackIds.map((id) => {
      const t = library.get(id);
      const paid = t.rights?.providerTrackId ? KNOWN_PAID_TRACKS[t.rights.providerTrackId] : undefined;
      const ids = incidents.filter((i) => i.asset_key === `library:${t.file}`).map((i) => Number(i.id));
      ids.forEach((x) => used.add(x));
      return { trackId: id, title: t.title, creator: t.attribution || '—', status: t.rightsStatus, category: (paid ? 'known paid track' : t.rightsStatus === 'quarantined' ? 'licensing unverified' : 'other') as HistoryEntry['assets'][number]['category'], reason: (JSON.parse(String(ds.find((d) => Number(d.track_id) === id)?.reasons ?? '[]')) as string[]).join(' '), incidentIds: ids };
    });
    // Productions that rendered one of these tracks (audit log), limited to this business.
    const sel = db.prepare("SELECT production_id, data, ts FROM audit_events WHERE type = 'audio.selected' AND production_id IS NOT NULL ORDER BY id").all() as Row[];
    const pids = [...new Set(sel.filter((e) => trackIds.includes(Number((JSON.parse(String(e.data)) as { music?: { id?: number } }).music?.id))).map((e) => Number(e.production_id)))].filter((pid) => ownerOf(pid) === businessId);
    const musicId = (e: Row) => Number((JSON.parse(String(e.data)) as { music?: { id?: number } }).music?.id);
    const productions = pids.map((pid) => {
      // Renders made while one of these tracks was selected: from its selection until another track was selected.
      const mine = sel.filter((e) => Number(e.production_id) === pid);
      const windows: [string, string][] = [];
      mine.forEach((e, k) => {
        if (!trackIds.includes(musicId(e))) return;
        const next = mine.slice(k + 1).find((x) => !trackIds.includes(musicId(x)));
        windows.push([String(e.ts), next ? String(next.ts) : '9999']);
      });
      const inWindow = (ts: string) => windows.some(([a, b]) => ts >= a && ts < b);
      const renders = (db.prepare("SELECT ts, data FROM audit_events WHERE type = 'render.output' AND production_id = ? ORDER BY id").all(pid) as Row[])
        .filter((e) => inWindow(String(e.ts)))
        .map((e) => ({ at: String(e.ts), sha256: String((JSON.parse(String(e.data)) as { sha256?: string }).sha256 ?? '') }));
      const shas = new Set(renders.map((x) => x.sha256));
      const pubs = (db.prepare('SELECT id, platform, status, privacy_applied, deleted_at, render_sha256, created_at FROM publications WHERE production_number = ? ORDER BY id').all(pid) as Row[])
        .filter((x) => (x.render_sha256 ? shas.has(String(x.render_sha256)) : inWindow(String(x.created_at))))
        .map((x) => ({ id: Number(x.id), platform: String(x.platform), status: String(x.status), privacy: String(x.privacy_applied), deletedAt: (x.deleted_at as string) ?? null }));
      // Production numbers were reused before v11, so the deletion that matters is the first one after this use.
      const del = db.prepare("SELECT data FROM audit_events WHERE type = 'production.deleted' AND production_id = ? AND ts >= ? ORDER BY id LIMIT 1").get(pid, windows[0]?.[0] ?? '') as Row | undefined;
      const live = del ? undefined : (db.prepare('SELECT topic FROM productions WHERE id = ?').get(pid) as Row | undefined);
      return { productionNumber: pid, topic: del ? String((JSON.parse(String(del.data)) as { topic?: string }).topic ?? '') : String(live?.topic ?? ''), renders, publications: pubs, deleted: !!del };
    });
    const ownIncidents = incidents.filter((i) => assets.some((a) => a.incidentIds.includes(Number(i.id))));
    const narrative = NARRATIVE[key];
    const actions = [
      `${assets.length} track(s) quarantined by an append-only rights decision (${key}); they cannot be selected, rendered or published.`,
      'Automatic music discovery switched off; only source-of-record verification (Jamendo API, Wikimedia Commons API) can approve a track.',
      'Rendering and publishing re-check every sound against the rights ledger and fail closed.'
    ];
    for (const p of productions) {
      for (const pub of p.publications) if (pub.deletedAt) actions.push(`Publication attempt #${pub.id} (${pub.platform}, production ${p.productionNumber}) recorded as deleted on ${pub.deletedAt.slice(0, 10)}.`);
      if (p.deleted) actions.push(`Production ${p.productionNumber} deleted.`);
    }
    return {
      key,
      title: narrative?.title ?? `Rights incident ${key.replace('incident-', '')}`,
      date: String(ds[0]?.decided_at ?? ''),
      status: ownIncidents.some((i) => i.status === 'open') ? 'open' : ownIncidents.length ? 'resolved' : 'open',
      whatHappened: narrative?.text ?? (assets[0]?.reason || 'Rights incident.'),
      assets,
      verification: [
        'At import: Openverse index metadata only (licence fields copied from the index). This is insufficient to establish licensing at the source of record.',
        'No source-of-record verification (Jamendo API) was performed: no Jamendo API client is configured.',
        `Known paid list: ${assets.filter((a) => a.category === 'known paid track').map((a) => a.title).join(', ') || 'none'}.`
      ],
      productions,
      correctiveActions: actions,
      incidents: ownIncidents.map((i) => ({ id: Number(i.id), status: String(i.status), createdAt: String(i.created_at), resolvedAt: (i.resolved_at as string) ?? null, description: String(i.description) }))
    };
  });
  // Rights complaints that are not part of a grouped incident are listed on their own.
  for (const i of incidents.filter((x) => !used.has(Number(x.id)))) {
    entries.push({ key: `incident-row-${i.id}`, title: `Rights complaint #${i.id}`, date: String(i.created_at), status: i.status as 'open' | 'resolved', whatHappened: String(i.description), assets: [], verification: [], productions: [], correctiveActions: [], incidents: [{ id: Number(i.id), status: String(i.status), createdAt: String(i.created_at), resolvedAt: (i.resolved_at as string) ?? null, description: String(i.description) }] });
  }
  return entries;
}
