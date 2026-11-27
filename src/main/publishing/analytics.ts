import type { MonetizationProgram, MonetizationRequirement } from '../../shared/operations';

/** Account-level numbers a platform reported (null = not available with the current permissions). */
export interface PlatformStats {
  followers: number | null;
  totalViews: number | null;
  /** remoteId → per-video counts. */
  videos: Record<string, { views: number | null; likes: number | null; comments: number | null }>;
  /** YouTube Analytics: watch hours on long-form videos over the last 365 days (all visibility; YouTube counts public only). */
  longformWatchHours12m?: number | null;
  /** YouTube Analytics: Shorts views over the last 90 days. */
  shortsViews90d?: number | null;
  /** Account views over the last 30 days. */
  views30d?: number | null;
  detail?: string;
}

const eligible = (reqs: MonetizationRequirement[]): boolean => {
  const met = (r: MonetizationRequirement) => r.current !== null && r.current >= r.target;
  const solo = reqs.filter((r) => !r.either);
  const groups = new Map<string, MonetizationRequirement[]>();
  for (const r of reqs) if (r.either) groups.set(r.either, [...(groups.get(r.either) ?? []), r]);
  return solo.every(met) && [...groups.values()].every((g) => g.some(met));
};

/** YouTube raises the full-monetization thresholds on 2027-02-01 (announced by YouTube). */
export const YPP_CHANGE_DATE = '2027-02-01';

/**
 * Progress toward each monetization programme from real platform numbers. Thresholds are the programmes'
 * published criteria; the platform has the final say (and checks policy compliance), so this is guidance.
 */
export function monetizationPrograms(input: { youtube?: PlatformStats | null; tiktok?: PlatformStats | null; youtubePublicUploads90d: number }, now = new Date()): MonetizationProgram[] {
  const yt = input.youtube ?? null;
  const tt = input.tiktok ?? null;
  const after = now.toISOString().slice(0, 10) >= YPP_CHANGE_DATE;
  const fan: MonetizationRequirement[] = [
    { label: 'Subscribers', current: yt?.followers ?? null, target: 500 },
    { label: 'Public uploads in the last 90 days', current: yt ? input.youtubePublicUploads90d : null, target: 3 },
    { label: 'Long-form watch hours (12 months)', current: yt?.longformWatchHours12m ?? null, target: 3000, either: 'watch' },
    { label: 'Shorts views (90 days)', current: yt?.shortsViews90d ?? null, target: 3_000_000, either: 'watch' }
  ];
  const full: MonetizationRequirement[] = [
    { label: 'Subscribers', current: yt?.followers ?? null, target: 1000 },
    { label: 'Long-form watch hours (12 months)', current: yt?.longformWatchHours12m ?? null, target: after ? 8000 : 4000, either: 'watch' },
    { label: 'Shorts views (90 days)', current: yt?.shortsViews90d ?? null, target: after ? 20_000_000 : 10_000_000, either: 'watch' }
  ];
  const rewards: MonetizationRequirement[] = [
    { label: 'Followers', current: tt?.followers ?? null, target: 10_000 },
    { label: 'Video views (30 days)', current: tt?.views30d ?? null, target: 100_000 }
  ];
  const ytNote = yt ? 'YouTube counts only public watch hours and views; the figures here include all of the channel\'s videos.' : 'Connect YouTube to track this.';
  return [
    { id: 'ypp-fan', platform: 'youtube', name: 'YouTube Partner Program: fan funding', requirements: fan, eligible: eligible(fan), note: ytNote, source: 'https://support.google.com/youtube/answer/72851' },
    {
      id: 'ypp-full',
      platform: 'youtube',
      name: 'YouTube Partner Program: ad revenue',
      requirements: full,
      eligible: eligible(full),
      note: `${ytNote}${after ? '' : ` Thresholds double on ${YPP_CHANGE_DATE} (8,000 watch hours or 20M Shorts views).`}`,
      source: 'https://support.google.com/youtube/answer/72851'
    },
    {
      id: 'tiktok-rewards',
      platform: 'tiktok',
      name: 'TikTok Creator Rewards',
      requirements: rewards,
      eligible: eligible(rewards),
      note: `Also requires being 18+ and videos over 1 minute (the default about-a-minute format). ${tt?.followers == null ? 'TikTok follower and view counts need the user.info.stats and video.list permissions, which can be added after the current app review.' : ''}`.trim(),
      source: 'https://www.tiktok.com/creator-academy/en/article/creator-rewards-program'
    }
  ];
}
