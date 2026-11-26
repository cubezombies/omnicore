import type { Platform, PlatformMetadata, ProductionDestination } from '../../shared/operations';
import type { Production } from '../../shared/production';
import { keywords } from '../providers/text';

/** Official per-platform limits used for metadata generation and QA. */
export const PLATFORM_LIMITS: Record<Platform, { title: number; caption: number; hashtags: number; maxDurationSec: number }> = {
  tiktok: { title: 2200, caption: 2200, hashtags: 10, maxDurationSec: 600 },
  youtube: { title: 100, caption: 5000, hashtags: 15, maxDurationSec: 180 },
  instagram: { title: 2200, caption: 2200, hashtags: 30, maxDurationSec: 900 }
};

export const AI_DISCLOSURE_TEXT = 'Narration and some visuals are AI-generated. Every claim is sourced; sources are listed below.';

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const tag = (w: string) => `#${w.replace(/[^\p{L}\p{N}]/gu, '')}`;

/**
 * Platform metadata from the production's own data only (title, sourced hook, credits).
 * Nothing here adds claims the script does not contain.
 */
export function buildMetadata(p: Production, dest: ProductionDestination, credits: string, brandName: string): PlatformMetadata {
  const limits = PLATFORM_LIMITS[dest.platform];
  const title = clip(p.storyboard?.title ?? p.topic, dest.platform === 'youtube' ? limits.title : 150);
  const hook = p.storyboard?.scenes[0]?.narration ?? '';
  const publishers = [...new Set(p.sources.map((s) => s.publisher))].slice(0, 4);
  const base = [...keywords(p.topic, 3).map(tag), '#AI', `#${brandName.replace(/[^\p{L}\p{N}]/gu, '')}`, '#TechNews'];
  const hashtags = [...new Set(base.map((h) => h.toLowerCase()))].map((h) => base.find((b) => b.toLowerCase() === h)!).filter((h) => h.length > 2).slice(0, Math.min(5, limits.hashtags));
  const sourcesLine = publishers.length ? `Sources: ${publishers.join(', ')} (full list in credits).` : '';
  const caption = clip([hook, sourcesLine, AI_DISCLOSURE_TEXT, hashtags.join(' ')].filter(Boolean).join('\n\n'), limits.caption);
  const manualSteps: string[] = [];
  if (p.assets.some((a) => a.kind === 'music')) manualSteps.push('Music is embedded in the video under its recorded licence; no platform-native sound is attached (not supported by the official publishing APIs).');
  if (dest.platform === 'tiktok') manualSteps.push('TikTok Direct Post from an unaudited app can only post SELF_ONLY (private) to a private account until TikTok audits the app.');
  if (dest.platform === 'instagram') manualSteps.push('Instagram publishing requires the video at a publicly reachable URL when publishing; no free hosting is configured yet.');
  return {
    platform: dest.platform,
    title,
    caption,
    hashtags,
    aiDisclosure: true,
    credits: dest.platform === 'youtube' ? clip(credits, limits.caption - caption.length - 2) : credits,
    manualSteps
  };
}
