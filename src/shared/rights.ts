import type { AudioRights, AudioTrack } from './production';

/**
 * How a sound's rights are presented. Pure and shared by every screen, so the wording and the rules are the same in
 * every business workspace. Presentation only: what may be used is decided server-side (library.revalidate/embeddable).
 */
export type RightsStatus = AudioTrack['rightsStatus'];

export const RIGHTS_STATUS: Record<RightsStatus, { label: string; meaning: string; usable: boolean }> = {
  approved: { label: 'Approved', meaning: 'Eligible for use, subject to its recorded conditions.', usable: true },
  quarantined: { label: 'Quarantined', meaning: 'Unavailable pending rights resolution.', usable: false },
  unverified: { label: 'Unverified', meaning: 'Rights have not been established.', usable: false },
  rejected: { label: 'Rejected', meaning: 'Rights verification failed or the asset is prohibited.', usable: false }
};

/** The one short line shown for a quarantined track (the full story lives in Rights & Compliance history). */
export const QUARANTINE_SUMMARY = 'Unavailable: licensing could not be verified with the original source.';

/** Verifiers that check the source of record itself (the exact file and licence at the owner), as opposed to an index. */
const SOURCE_OF_RECORD_VERIFIERS = new Set(['jamendo-api', 'wikimedia-commons-api']);
/** Search indexes and aggregators: their metadata is a lead, never proof of a licence. */
const INDEX_PROVIDERS = new Set(['openverse']);

export interface TrackSummary {
  status: RightsStatus;
  statusLabel: string;
  /** One line under the status: the quarantine summary, or what the status means. */
  statusLine: string;
  creator: string;
  /** "Eligible for commercial use" only for an approved, embeddable track with confirmed commercial rights. */
  commercial: { eligible: boolean; label: string };
  /** Shown only when the track is approved and its licence requires a credit. */
  attribution: string | null;
  /** The licence as a current fact: only for approved tracks. Anything else is a claim, kept in the details. */
  licence: string | null;
}

export function trackSummary(t: Pick<AudioTrack, 'rightsStatus' | 'attribution' | 'origin' | 'license' | 'commercialUse' | 'usage' | 'rights' | 'restrictions'>): TrackSummary {
  const status = t.rightsStatus;
  const approved = status === 'approved';
  const eligible = approved && t.usage === 'embedded' && t.commercialUse === 'yes';
  const creator = t.origin === 'generated' ? 'Omnicore (generated)' : t.attribution || 'Unknown creator';
  const needsCredit = !!t.rights?.attributionRequired;
  return {
    status,
    statusLabel: RIGHTS_STATUS[status].label,
    statusLine: status === 'quarantined' ? QUARANTINE_SUMMARY : RIGHTS_STATUS[status].meaning,
    creator,
    commercial: {
      eligible,
      label: eligible ? 'Eligible for commercial use' : approved ? (t.usage !== 'embedded' ? 'Platform-only: not mixed into exported videos' : 'Commercial use not confirmed: not eligible') : 'Not eligible for any use'
    },
    attribution: approved && needsCredit ? `Credit required: ${t.attribution || creator}${t.license ? `, ${t.license}` : ''}` : null,
    licence: approved ? t.license || null : null
  };
}

export interface VerificationClaim {
  /** What kind of evidence this is. */
  kind: 'source-of-record' | 'index-metadata' | 'generated' | 'none';
  /** Plain description, safe to show next to the historical record. */
  label: string;
  /** True only when the evidence verified the licence at the source of record. */
  establishesLicence: boolean;
}

/**
 * Classify the verification recorded on a track. Index metadata (Openverse) is labelled as exactly that, never as a
 * verification, even when the old record carries a "verifiedAt" time.
 */
export function classifyVerification(t: { origin: string; rights: AudioRights }, decisions: { decision: string; verifier: string }[] = []): VerificationClaim {
  if (t.origin === 'generated') return { kind: 'generated', label: 'Synthesised by Omnicore: no third-party material.', establishesLicence: true };
  const provider = t.rights?.provider ?? '';
  // Only an approval by a source-of-record verifier counts; a later quarantine or rejection always wins.
  const latest = decisions.at(-1);
  const sor = decisions.filter((d) => d.decision === 'approved' && SOURCE_OF_RECORD_VERIFIERS.has(d.verifier));
  if (sor.length && latest?.decision === 'approved')
    return { kind: 'source-of-record', label: `Verified at the source of record (${[...new Set(sor.map((d) => d.verifier))].join(', ')}).`, establishesLicence: true };
  if (INDEX_PROVIDERS.has(provider))
    return { kind: 'index-metadata', label: `Historical claim: ${provider === 'openverse' ? 'Openverse' : provider}/index metadata only, insufficient to establish licensing at the source of record.`, establishesLicence: false };
  return { kind: 'none', label: 'No verification evidence is recorded.', establishesLicence: false };
}

/** A value from the evidence, or an explicit statement that it is missing (never inferred). */
export const orMissing = (v: string | number | boolean | null | undefined, what: string): string => (v === undefined || v === null || v === '' ? `Missing: no ${what} recorded` : String(v));

// ---- full evidence and incident history (built in the main process, shown in Rights & Licensing details) ----

export interface RightsDecisionRecord {
  id: number;
  decision: string;
  verifier: string;
  reasons: string[];
  evidenceSha256: string;
  decidedAt: string;
}

export interface IncidentRef {
  id: number;
  status: 'open' | 'resolved';
  createdAt: string;
  resolvedAt: string | null;
  /** The incident history entry this belongs to (see rightsHistory). */
  historyKey: string;
}

export interface TrackRightsDetails {
  trackId: number;
  title: string;
  summary: TrackSummary;
  verification: VerificationClaim;
  /** Set when the track is on the known paid list (as opposed to merely unverified). */
  knownPaid: string | null;
  source: { origin: string; provider: string | null; sourceName: string | null; sourceOfRecordUrl: string | null; assetId: string | null; licenceUrl: string | null };
  /** The licence as recorded at import. For anything not approved this is a historical claim, not a fact. */
  recordedLicence: { value: string | null; historical: boolean; recordedAt: string | null };
  commercialUse: string;
  attributionRequired: boolean | null;
  attributionText: string | null;
  permissions: { download: string | null; modification: string | null };
  file: { name: string; present: boolean; sha256: string | null; recordedSha256: string | null; identityVerified: boolean };
  evidence: { file: string; present: boolean; sha256: string | null; recordedSha256: string | null; matchesRecord: boolean | null };
  decisions: RightsDecisionRecord[];
  incidents: IncidentRef[];
  /** Why it is quarantined or rejected (from the decision log). */
  reason: string | null;
  missing: string[];
}

export interface HistoryEntry {
  key: string;
  title: string;
  date: string;
  status: 'open' | 'resolved';
  whatHappened: string;
  assets: { trackId: number; title: string; creator: string; status: string; category: 'known paid track' | 'licensing unverified' | 'other'; reason: string; incidentIds: number[] }[];
  verification: string[];
  productions: { productionNumber: number; topic: string; renders: { at: string; sha256: string }[]; publications: { id: number; platform: string; status: string; privacy: string; deletedAt: string | null }[]; deleted: boolean }[];
  correctiveActions: string[];
  incidents: { id: number; status: string; createdAt: string; resolvedAt: string | null; description: string }[];
}
