# Platform publishing feasibility (researched 2026-11-26)

This covers what Omnicore can do through each platform's **official** API, what blocks fully autonomous publishing, and the compliant alternatives. Omnicore will not use browser automation, unofficial endpoints or scraped music libraries to get around any of these limits. Recheck the sources before building each integration, because the policies change often.

## Summary

| | TikTok | YouTube Shorts | Instagram Reels |
|---|---|---|---|
| Official upload API | Content Posting API (Direct Post) | Data API v3 `videos.insert` | Graph API content publishing (Reels) |
| Account type | Any; user OAuth (Login Kit) | Google account + channel; OAuth | **Professional** (Business/Creator) account; Facebook Login or Instagram Login |
| Before app review / audit | Posts forced to **`SELF_ONLY` (private)**; max 5 users/24h | Unverified projects historically locked uploads to private. The Nov 2026 docs revision says this was lifted, but sources conflict (verify on first upload) | Only app roles (admins/testers) can publish; Advanced Access needs Meta App Review |
| Review requirement | Audit for public posting; TikTok states internal-only/personal tools are generally **not** approved | Google OAuth verification for sensitive scope `youtube.upload`; quota extension needs an audit | App Review + Business Verification for `instagram_content_publish` |
| Upload volume | Per-creator caps returned by `creator_info/query` | Default quota 10,000 units/day; the current docs give a default of about 100 uploads/day (older docs priced an upload at 1,600 units) | 100 API-published posts / 24h per account |
| AI-content label | `post_info.is_aigc` | `status.containsSyntheticMedia` | No API field confirmed; disclose in caption |
| Branded-content flags | `brand_content_toggle`, `brand_organic_toggle` | `paidProductPlacement` details (manual) | Branded content tools (not via publishing API) |
| Platform-native music via API | **Not in official docs** (only third-party claims of a `song_clip_id`) | **None**: no Audio Library API | Not officially documented; a reported 2026 "Audio API" is unverified |
| Media hosting | Upload bytes (`FILE_UPLOAD`) or pull from a verified domain | Direct resumable upload | **Video must be at a publicly reachable HTTPS URL** at publish time |
| Desktop OAuth | Desktop Login Kit, redirect `http://127.0.0.1:<port>/…`, PKCE required | Installed-app loopback redirect + PKCE | Web redirect only; a desktop app needs a hosted redirect |

## TikTok

**What works:** Login Kit for Desktop (PKCE, loopback redirect) and the Content Posting API with `video.publish` scope. The flow is to query creator info (privacy options, max duration, interaction toggles), then `post/publish/video/init` with `post_info` (title, `privacy_level`, `disable_comment`/`duet`/`stitch`, `is_aigc: true`), then upload the file and poll `post/publish/status/fetch`.

**Blockers:**
1. **Unaudited apps post only as `SELF_ONLY`.** TikTok's audit is required for public visibility, and its guidelines say apps built only for internal or personal use generally won't pass. Don't assume Omnicore will be approved. A realistic plan treats audit approval as uncertain.
2. TikTok's UX guidelines require the user to see a preview, choose the privacy level themselves (no default), and confirm before each post. That matches Omnicore's per-video approval gate, so autonomous *public* posting without a human confirmation is not compliant.
3. TikTok sounds or commercial music library tracks can't be attached through the documented API.

**Compliant alternatives:**
- Post `SELF_ONLY` through the API, then the user makes the post public in the TikTok app.
- The documented **upload-to-inbox** mode (`video.upload` scope), where the creator finishes the post (privacy, sound, caption edits) in TikTok.
- Apply for the audit with the real, human-reviewed publishing UX.

## YouTube Shorts

**What works:** OAuth 2.0 for installed apps (loopback + PKCE), `videos.insert` with a resumable upload. A vertical video ≤ 3 min is classified as a Short automatically. Set `status.privacyStatus`, `status.selfDeclaredMadeForKids` and `status.containsSyntheticMedia: true`.

**Blockers:**
1. The `youtube.upload` scope is sensitive. Until the OAuth consent screen is verified, the app runs in "testing" mode: only listed test users, and refresh tokens expire after 7 days.
2. Private-lock for unaudited projects: the documentation says API projects created after July 2020 that haven't passed an audit had uploads restricted to private. A November 2026 revision indicates this is no longer forced, but cached copies differ, so confirm with the first real test upload.
3. There is no API for the YouTube Audio Library or for Shorts sounds.

**Compliant alternatives:** upload as private or unlisted and let the user switch to public in YouTube Studio; request verification and a quota audit when needed.

## Instagram Reels

**What works:** For a professional account linked through Facebook Login (or Instagram Login), create a media container with `media_type=REELS` and `video_url`, poll the container status, then call `media_publish`.

**Blockers:**
1. Professional account required; personal accounts can't publish through the API.
2. Meta App Review and Business Verification are needed beyond app-role testers.
3. **The video must be hosted at a public URL.** Omnicore is a local desktop app with no hosting. Options are a user-provided host or a temporary signed URL on storage the user controls. Both are a deployment decision for the user and may cost money; nothing is set up automatically.
4. No documented way to attach Instagram music; reported audio APIs are unverified.

**Compliant alternatives:** the user publishes manually from the exported file; or later, an approved, user-owned hosting target.

## Music policy (all platforms)

- **Embedded music** (mixed into the MP4) is the only kind Omnicore attaches. It is auto-selected only when the track's `usage = embedded` and `commercialUse = yes`. Generated tracks qualify; imported tracks start as `unknown` and are never auto-selected until the user confirms the licence. The licence, restrictions and file hash are recorded in the audit ledger.
- **Platform-native audio** (TikTok sounds, Instagram audio, YouTube Shorts sounds) can't be attached through any verified official API. If wanted, it's a **manual step in the platform app**, and Omnicore lists it in each production's "manual steps". Omnicore never pretends to attach it.
- Commercial accounts should assume the platforms' general music libraries aren't cleared for commercial or branded use; only each platform's commercial libraries are, and only inside their apps.

## What Omnicore implements now (0.5.0 Stage 1)

- A brand → destination → account model. Each production stores its destinations and their blockers at creation and never falls back to "whichever account is connected".
- Accounts can be registered as *not connected*. Token storage exists (encrypted with Windows DPAPI via Electron `safeStorage` when OAuth lands); no passwords are ever stored.
- Per-platform metadata: title and caption within limits, hashtags, an AI-disclosure line plus API flags, credits and manual steps.
- Approval gate: content that passes QA waits at **awaiting review**; content with a critical QA failure is **blocked**. Approval only records your decision; **no publishing code exists yet**, and nothing is reported as published.
- Financial actions (ads, boosts, paid tools) throw `FinancialAuthorizationRequired`. Connecting an account never grants them.

## Next stage (not started)

OAuth connections, a real private test upload per platform (TikTok `SELF_ONLY`, YouTube private), then verification of the resulting post on the platform, all before any publishing is reported as working.

## Sources

- TikTok Content Posting API — Direct Post: https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
- TikTok Content Sharing Guidelines / audit: https://developers.tiktok.com/doc/content-sharing-guidelines
- TikTok Login Kit for Desktop: https://developers.tiktok.com/doc/login-kit-desktop
- YouTube `videos.insert`: https://developers.google.com/youtube/v3/docs/videos/insert
- YouTube API quota and audits: https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits
- Google OAuth for installed apps: https://developers.google.com/identity/protocols/oauth2/native-app
- Instagram content publishing: https://developers.facebook.com/docs/instagram-platform/content-publishing
- Meta App Review: https://developers.facebook.com/docs/app-review
