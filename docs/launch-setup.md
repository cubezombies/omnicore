# Launch setup: connecting AI, Actually's accounts

Omnicore publishes only through each platform's official API, which means each platform needs **your own developer app**. This is a one-time setup. Everything is free, and none of it authorizes spending. Omnicore stores the credentials encrypted (Windows DPAPI) and never asks for your passwords.

## TikTok (first priority)

1. Go to https://developers.tiktok.com, sign in, and choose **Manage apps → Create app** (individual developer is fine).
2. Add the **Login Kit** and **Content Posting API** products. In Content Posting, enable **Direct Post**.
3. Scopes: `user.info.basic` and `video.publish`.
4. Login Kit platform: **Desktop**. Redirect URI: `http://127.0.0.1:53682/callback` (or whatever port you choose in Omnicore).
5. Until TikTok has reviewed and approved the app, its production credentials (client key starting `aw…`) are rejected at sign-in with "We couldn't log in with TikTok … client_key". Switch the portal to **Sandbox**, create a sandbox, add Login Kit (Desktop, same redirect URI) and Content Posting API there too, and add the AI, Actually TikTok account as a **target user**.
6. Copy the **sandbox** Client key (starts `sb…`) and Client secret into Omnicore → Accounts → Developer apps → TikTok. After the app is approved, replace them with the production pair.
7. Accounts → register the handle (e.g. `@aiactually`), then **Connect** and sign in to that account in the browser.
8. Accounts → destinations: assign the account to TikTok.

**Limit until TikTok audits the app:** posts are `SELF_ONLY` (only you can see them), and the account must be private. Omnicore tells you when this applies, and it never reports a private post as public. To go public before the audit is approved, publish privately through Omnicore and then switch the post to public in the TikTok app. Submit the audit from the developer portal (it asks for a demo video of the publishing flow; Omnicore's per-video approval and preview satisfy the UX rules).

## YouTube Shorts

1. Go to https://console.cloud.google.com and create a project (free).
2. **APIs & Services → Library → YouTube Data API v3 → Enable**, then do the same for **YouTube Analytics API** (watch time and Shorts views for the monetization tracker).
3. Set up the **OAuth consent screen**: External, in "Testing", with the AI, Actually Google account added as a test user.
4. **Credentials → Create credentials → OAuth client ID → Desktop app.** Copy the client ID and secret into Omnicore.
5. Register the channel handle in Accounts, then **Connect**, then assign it to the YouTube destination and enable it.

**Limits:**
- While the consent screen is in Testing, sign-ins expire after 7 days. Reconnect weekly, or submit for verification.
- Uploads may be locked to private until the project passes Google's API audit. Omnicore reports the visibility YouTube actually applied.

## Instagram Reels (needs hosting)

1. The Instagram account must be a **Professional** account (Business or Creator).
2. At https://developers.facebook.com, create an app with the **Instagram API with Instagram Login** product, add the account as an Instagram tester, and generate an **access token** under API setup.
3. Paste the token into Omnicore. Instagram downloads the video from a **public HTTPS URL**, so you also need somewhere the exported `final.mp4` files can be placed at `<location>/<production id>.mp4`.

   **This is your decision:** it may cost money depending on the host, so Omnicore doesn't set it up. Until then, publish Reels manually from the exported file and caption.

## Publishing rules Omnicore enforces

- A video can be published only if it is finished, has **passed QA**, and has been **approved** by you. Every destination must be connected and assigned to the brand explicitly, with no fallback account.
- You approve the first public video yourself. **Auto-publish** (Operations) stays inactive until a public post you approved has been confirmed by the platform.
- A post is marked published only after the platform confirms it.
- Platform-native sounds can't be attached through any official API. Videos carry embedded, licensed music instead. If you want a trending sound, add it in the platform app after posting.
