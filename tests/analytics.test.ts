import { describe, expect, it } from 'vitest';
import { monetizationPrograms, type PlatformStats } from '../src/main/publishing/analytics';
import { youtubeClient } from '../src/main/publishing/platforms';
import type { TokenSet } from '../src/main/publishing/oauth';

const yt = (o: Partial<PlatformStats>): PlatformStats => ({ followers: 0, totalViews: 0, videos: {}, longformWatchHours12m: 0, shortsViews90d: 0, ...o });
const prog = (ps: ReturnType<typeof monetizationPrograms>, id: string) => ps.find((p) => p.id === id)!;

describe('monetization progress', () => {
  it('needs every requirement plus one of the either/or alternatives', () => {
    const now = new Date('2026-12-01');
    expect(prog(monetizationPrograms({ youtube: yt({ followers: 1200, shortsViews90d: 9_000_000 }), youtubePublicUploads90d: 10 }, now), 'ypp-full').eligible).toBe(false);
    expect(prog(monetizationPrograms({ youtube: yt({ followers: 1200, shortsViews90d: 10_000_000 }), youtubePublicUploads90d: 10 }, now), 'ypp-full').eligible).toBe(true);
    expect(prog(monetizationPrograms({ youtube: yt({ followers: 999, longformWatchHours12m: 5000 }), youtubePublicUploads90d: 10 }, now), 'ypp-full').eligible).toBe(false);
    expect(prog(monetizationPrograms({ youtube: yt({ followers: 600, longformWatchHours12m: 3100 }), youtubePublicUploads90d: 3 }, now), 'ypp-fan').eligible).toBe(true);
  });

  it('applies YouTube’s higher thresholds from 2027-02-01', () => {
    const before = prog(monetizationPrograms({ youtube: yt({}), youtubePublicUploads90d: 0 }, new Date('2027-01-31')), 'ypp-full');
    const after = prog(monetizationPrograms({ youtube: yt({}), youtubePublicUploads90d: 0 }, new Date('2027-02-01')), 'ypp-full');
    expect(before.requirements.map((r) => r.target)).toEqual([1000, 4000, 10_000_000]);
    expect(after.requirements.map((r) => r.target)).toEqual([1000, 8000, 20_000_000]);
  });

  it('never treats unknown numbers as met and explains missing TikTok permissions', () => {
    const ps = monetizationPrograms({ youtube: null, tiktok: null, youtubePublicUploads90d: 0 });
    expect(ps.every((p) => !p.eligible)).toBe(true);
    expect(ps.flatMap((p) => p.requirements).every((r) => r.current === null)).toBe(true);
    expect(prog(ps, 'tiktok-rewards').note).toMatch(/user\.info\.stats and video\.list/);
    expect(prog(ps, 'tiktok-rewards').note).toMatch(/over 1 minute/);
  });
});

describe('YouTube stats client', () => {
  const tokens: TokenSet = { accessToken: 'x', refreshToken: null, expiresAt: '2099-01-01T00:00:00Z', refreshExpiresAt: null, scopes: [] };
  const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });

  it('reads channel, per-video and windowed analytics numbers', async () => {
    const urls: string[] = [];
    const f = (async (u: string) => {
      urls.push(u);
      if (u.includes('/channels?')) return ok({ items: [{ statistics: { subscriberCount: '42', viewCount: '9000' } }] });
      if (u.includes('/videos?')) return ok({ items: [{ id: 'abc', statistics: { viewCount: '120', likeCount: '7', commentCount: '2' } }] });
      if (u.includes('youtubeanalytics')) return ok({ rows: [['SHORTS', 800, 600], ['VIDEO_ON_DEMAND', 50, 1200]] });
      throw new Error(u);
    }) as typeof fetch;
    const s = await youtubeClient(f).stats!(tokens, ['abc']);
    expect(s).toMatchObject({ followers: 42, totalViews: 9000, videos: { abc: { views: 120, likes: 7, comments: 2 } }, longformWatchHours12m: 20, shortsViews90d: 800, views30d: 850 });
    expect(urls.some((u) => u.includes('ids=channel%3D%3DMINE') || u.includes('ids=channel==MINE'))).toBe(true);
  });

  it('reports watch time as unavailable (not zero) when the Analytics API is off', async () => {
    const f = (async (u: string) => {
      if (u.includes('/channels?')) return ok({ items: [{ statistics: { subscriberCount: '5', viewCount: '10' } }] });
      if (u.includes('/videos?')) return ok({ items: [] });
      return new Response(JSON.stringify({ error: { message: 'YouTube Analytics API has not been used in project' } }), { status: 403 });
    }) as typeof fetch;
    const s = await youtubeClient(f).stats!(tokens, ['zzz']);
    expect(s.followers).toBe(5);
    expect(s.longformWatchHours12m).toBeNull();
    expect(s.shortsViews90d).toBeNull();
    expect(s.detail).toMatch(/Watch time unavailable/);
  });
});
