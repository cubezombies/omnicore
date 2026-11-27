// Copyright-safe visual asset policy. Every externally sourced visual must carry a
// verified licence record that allows commercial use AND modification (videos crop,
// zoom and caption every image). Anything unclear is rejected.

import type { ProductionAsset } from '../../shared/production';

export type AssetOrigin = 'commons' | 'wikipedia' | 'openverse' | 'generated-ai' | 'generated-card' | 'user' | 'stock';

export interface LicenseRecord {
  origin: AssetOrigin;
  sourceUrl: string;
  creator: string;
  license: string;
  licenseUrl: string;
  attributionRequired: boolean;
  commercialUse: boolean;
  modification: boolean;
  shareAlike: boolean;
  retrievedAt: string;
  /** True only when every check above was satisfied from the source's own licence metadata. */
  verified: boolean;
  notes?: string;
}

export interface LicenseVerdict {
  ok: boolean;
  commercialUse: boolean;
  modification: boolean;
  shareAlike: boolean;
  attributionRequired: boolean;
  reason: string;
}

const no = (reason: string): LicenseVerdict => ({ ok: false, commercialUse: false, modification: false, shareAlike: false, attributionRequired: false, reason });

/** Decide whether a licence permits commercial social-video use with modification. */
export function evaluateLicense(license: string, opts: { allowShareAlike: boolean }): LicenseVerdict {
  const l = license.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!l) return no('no licence stated');
  if (/\bnc\b|non-?commercial/.test(l)) return no(`${license} forbids commercial use`);
  if (/\bnd\b|no-?deriv/.test(l)) return no(`${license} forbids modification (videos crop, zoom and caption images)`);
  if (/^(cc0|cc-zero|public domain|pd\b|pd-|no restrictions|public domain mark)/.test(l)) {
    return { ok: true, commercialUse: true, modification: true, shareAlike: false, attributionRequired: false, reason: 'public domain / CC0' };
  }
  if (/^cc[ -]by[ -]sa\b|^cc-by-sa/.test(l)) {
    return opts.allowShareAlike
      ? { ok: true, commercialUse: true, modification: true, shareAlike: true, attributionRequired: true, reason: 'CC BY-SA: commercial use and edits allowed; adapted work must be shared alike' }
      : no(`${license}: share-alike images are disabled in Providers (the adapted video would have to be licensed alike)`);
  }
  if (/^cc[ -]by\b(?![ -]?(sa|nc|nd))|^cc-by(-\d|$)/.test(l)) {
    return { ok: true, commercialUse: true, modification: true, shareAlike: false, attributionRequired: true, reason: 'CC BY: commercial use and edits allowed with attribution' };
  }
  return no(`licence "${license}" could not be verified as allowing commercial use with modification`);
}

/** Commons "Restrictions" metadata and categories that make an otherwise free file unsafe to use. */
export function restrictionProblem(restrictions: string, categories: string, title = ''): string | null {
  const r = restrictions.toLowerCase();
  const c = categories.toLowerCase();
  const t = title.toLowerCase();
  // Branded imagery and software screenshots: an uploader's free licence cannot cover a company's logo or UI.
  if (/\blogos?\b|wordmark|emblem|trademark|\bbrand(ing)?\b|\bicon\b/.test(t)) return 'shows a logo or brand mark';
  // Commons rarely categorises UI captures as screenshots, so product-UI words in the file name are treated the same way.
  if (/screenshot|screen ?shot|screen capture|\bui\b|user interface|extension|extention|plug-?in|add-on|\bapp\b|website|web ?page|homepage|dashboard/.test(t)) {
    return 'software screenshot (the interface belongs to its maker)';
  }
  if (/trademark/.test(r)) return 'shows a trademark (logo/brand)';
  if (/personality/.test(r)) return 'subject to personality rights';
  if (/insignia/.test(r)) return 'shows official insignia';
  if (/watermark/.test(c)) return 'watermarked';
  if (/logos?\b|\bbrand/.test(c)) return 'categorised as a logo/brand image';
  if (/non-free|fair use/.test(c)) return 'non-free / fair use file';
  return null;
}

const AI_LABEL = 'AI-generated illustration';
export const AI_GENERATED_LABEL = AI_LABEL;

/**
 * QA gate: every image used in a production must be licence-verified (external),
 * locally generated (title card), or a labelled AI illustration. Returns problems; empty = OK.
 */
export function verifyVisualAssets(images: ProductionAsset[], opts: { allowShareAlike: boolean }): string[] {
  const problems: string[] = [];
  for (const a of images) {
    const scene = `Scene ${(a.sceneIndex ?? 0) + 1}`;
    const lic = a.meta.licenseRecord as LicenseRecord | undefined;
    if (a.provider === 'title-card') continue;
    if (a.provider === 'graphics') {
      if (!a.meta.generated || !a.meta.labelled) problems.push(`${scene}: generated graphic is not marked as an original, labelled graphic.`);
      continue;
    }
    if (a.provider === 'comfyui') {
      if (!a.meta.aiGenerated) problems.push(`${scene}: AI image is not marked as AI-generated.`);
      continue;
    }
    if (!lic) {
      problems.push(`${scene}: ${a.provider} image has no licence record (sourced before licence verification existed). Re-run Visuals.`);
      continue;
    }
    if (!lic.verified) problems.push(`${scene}: licence not verified (${lic.notes ?? lic.license}).`);
    const v = evaluateLicense(lic.license, opts);
    if (!v.ok) problems.push(`${scene}: ${v.reason}.`);
    if (!lic.sourceUrl) problems.push(`${scene}: no source URL recorded.`);
    if (v.attributionRequired && !lic.creator) problems.push(`${scene}: attribution required but creator unknown.`);
  }
  return problems;
}
