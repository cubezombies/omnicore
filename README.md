# Omnicore

Windows desktop app for running an AI-produced media business. First channel: **AI, Actually** (AI and technology; TikTok → YouTube Shorts → Instagram Reels).

Stack: Electron 45 · React 19 · TypeScript · Vite (electron-vite) · SQLite via Node's built-in `node:sqlite` (no native modules) · electron-builder (NSIS).

## Run

```bat
scripts\dev.cmd            :: hot-reload dev (installs deps on first run)
scripts\dev.cmd preview    :: run the production build
```

`dev.cmd` keeps temp files, npm/Electron caches and app data on `F:`. The dev data directory is `F:\Claude\AI Media Operations\data-dev` (override with `AIMO_DEV_DATA_DIR`); it never uses the installed app's `AIMO_DATA_DIR`.

| Command | What it does |
|---|---|
| `npm test` | Unit tests: schema/migrations, repository, workflow, IPC validation, data-dir rules |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run smoke` | Builds, launches the real Electron app headless against a throwaway data dir, checks sandboxing + IPC + DB |
| `npm run pack` | Unpacked app in `release\win-unpacked` |
| `npm run dist` | NSIS installer `release\Omnicore-Setup-<version>.exe` (unsigned) |

Set `TMP`/`TEMP` to an `F:` folder before running `npm run dist` by hand (`dev.cmd` does this).

## Video Factory (Studio)

Studio turns a topic (or a content item via **Produce video**) into a finished 1080×1920 H.264/AAC MP4 with narration, visuals and word-synchronised burned-in captions. Pipeline steps, each persisted, resumable and individually re-runnable:

| Step | Default provider (free) | Alternatives |
|---|---|---|
| Research | 11 free providers (see below) + a linked item's research notes | SEC EDGAR (opt-in) |
| Brief | Deterministic fact selection: verbatim sentences from cited sources | — |
| Script & storyboard | Strata at `http://127.0.0.1:8080/v1` (model discovered via `/models`); grounding-validated with one repair round; falls back to the deterministic writer | Deterministic writer (no AI); any OpenAI-compatible server |
| Narration | Kokoro v1.0 via sherpa-onnx (one-click install) | Windows speech (fallback), Piper |
| Visuals | Freely licensed images from the cited Wikipedia articles, then Commons search (licence- and relevance-filtered), then local title cards | ComfyUI (local generation) |
| Captions | ASS from narration word timings | — |
| Render | Bundled FFmpeg: Ken Burns stills, loudness-normalised narration, ducked music bed and transition SFX from the Sound Library | Custom FFmpeg path |

**Research engine (0.4):** a production is an *Explainer* (background + research) or *News* (last N days). Free, key-less providers run in parallel and are individually toggled and health-checked in Providers: Wikipedia, arXiv, OpenAlex, Crossref, GitHub (README + latest release), Hugging Face (model cards), company newsroom RSS (OpenAI, NVIDIA, Google, DeepMind, Hugging Face, AMD, Microsoft, NIST), technology-press RSS (The Verge, Ars Technica, TechCrunch, MIT Technology Review, Tom's Hardware), GDELT news search (rate-limited), Hacker News (discovery only), US Federal Register, and SEC EDGAR full-text (off by default). Summary-only hits are fetched and read; every source keeps URL, publisher, authors, date, kind (research / official / company / reporting / background) and content level. Duplicates (same URL, DOI, arXiv id, title) are merged; text that repeats a press release is grouped with it so reprints never count as independent corroboration. Off-topic, non-English, unreadable, community and (news) stale items are dropped with reasons. News mode refuses to run on papers alone.

**Evidence claims:** the brief is a list of verbatim claims, each classified as confirmed / company claim / independently reported / estimate / speculation / opinion, with supporting sources and an independent-source count. Preprints are attributed ("a preprint on arXiv") unless corroborated. Scripts must cite claim ids; anything not confirmed must be attributed or hedged in the narration, or the script is rejected.

**Narration (0.4):** default narrator is Kokoro v1.0 (Apache-2.0) via the sherpa-onnx 1.13.8 runtime with the voice **Heart** (AI, Actually's presenter; Bella, Emma and other Kokoro voices are selectable). The default applies to fresh installs only; a saved voice choice is never overwritten on upgrade. It is installed from Providers into `<data>\tools\sherpa`; Windows speech is the automatic fallback when Kokoro is not installed (never mid-video). Pronunciation handling (acronyms, units, versions, model names, user overrides) feeds the engine while captions keep the original words; sentence boundaries are found from the audio's own pauses and re-spaced to the configured pause. Scripts are sized to the voice's measured speed instead of speeding the voice up. "Generate voice sample" in Providers plays the current voice and measures its words/second. Voice comparison: `tests/voice-eval.test.ts` (gated by `AIMO_VOICE_EVAL=1`).

**Visual licence policy:** external images are used only with a verified licence that allows commercial use and modification (CC0 / public domain / CC BY; CC BY-SA only if enabled). Non-commercial, no-derivatives, unclear, watermarked, logo/trademark and software-UI images are rejected. Each image keeps source URL, creator, licence and licence URL, attribution, commercial/modification flags and retrieval date; a render-time check blocks any unverified image. AI illustrations are labelled on screen. Title cards are the fallback.

**Script grounding:** every fact scene must cite sources, and numbers, names and acronyms must appear in the cited source; most of a fact scene's key words must come from it; hook/outro may not introduce facts; scripts over 140 words are sent back. Failures get one repair round with the exact problems, then the deterministic fallback (if enabled) with the reason recorded.

**Sound Library** (sidebar): import your own music/SFX with licence and credit line, or generate rights-free sounds locally (ambient pad, pulse bed, whoosh, riser, pop). Productions use none / auto / a chosen track, plus optional transition effects; all credited in `credits.txt`.

Output per production: `<data dir>\productions\<id>inal.mp4` plus `credits.txt` (sources + image licences/attribution for the post description). Every step records attempts, errors, progress and cost (all built-in providers cost $0). Failed or cancelled productions resume from the failed step; productions interrupted by an app exit are marked failed and retryable.

Live research reports: `AIMO_RESEARCH_LIVE=1 AIMO_RESEARCH_OUT=<dir> npx vitest run tests/research-live.test.ts`.

Live end-to-end check (needs internet + Windows; Strata for the LLM writer; `AIMO_E2E_MODE=news` for news): `set AIMO_E2E=1 && npx vitest run tests/e2e.test.ts` (output kept in `.tmp\e2e`). Options: `AIMO_E2E_REQUIRE_LLM=1`, `AIMO_E2E_NARRATION=piper` (installs Piper into `AIMO_TOOLS_DIR`), `AIMO_E2E_MUSIC=auto`, `AIMO_E2E_SFX=1`, `AIMO_E2E_TOPIC=...`. Through the real app: `AIMO_SMOKE_PRODUCE="<topic>" node scripts/smoke.mjs`.

## Autonomous operations (0.5)

**Operations** (sidebar) runs an operating engine in the main process, independent of the window:

- **Discovery** every N hours: official AI-lab newsrooms and press feeds, Hacker News (high-signal only) and Hugging Face trending. Stories covered by several outlets are clustered and scored on freshness, coverage, primary sources, niche fit and novelty. Deal and shopping posts are dropped.
- **Idea pipeline**: scored ideas persist in SQLite. The engine starts the best one above the minimum score, within active hours and the daily limit, one production at a time. Transient failures are retried up to 3 times, 10 minutes apart.
- **Independent QA** after rendering, covering:
  - facts and grounding, source independence and title honesty;
  - visual and audio rights evidence and the AI label;
  - narration pacing and **speech-to-text intelligibility** (Whisper base.en);
  - caption coverage and sync;
  - video spec, duration, integrity and fast-start;
  - loudness and true peak;
  - per-platform metadata.

  Failures trigger the most upstream automatic repair (rescript, shorten, revisuals, recaptions, rerender, metadata), then QA runs again, for up to the configured number of rounds. Passed content waits at **awaiting review**; a critical failure **blocks** it.
- **Audit ledger**: every decision, asset, licence, script version, render and QA run is an append-only, hash-chained event. Database triggers refuse edits, and **Verify** detects tampering. Source text and licence pages are retained as content-addressed evidence in `<data dir>\evidence`. **Export audit report** writes `audit-report.md` and `.json` next to the video.
- **Background running**: closing the window keeps the engine in the tray (when enabled). **Start with Windows** registers `Omnicore.exe --background` (installed app only). On restart, interrupted work is recorded and resumed; quitting stops the engine gracefully.

Limits: it runs only while the PC is on, awake, signed in and online, with Strata and the voice tools available. This is **not** 24/7 operation.

**Accounts** (sidebar) holds platform accounts, the AI, Actually destinations (each production gets explicit destinations and blockers; there's no fallback to "whichever account is connected"), the brand presenter voice (**Kokoro Heart**, which overrides the global narration setting for this brand), audit verification and rights-complaint records. **Connect** signs in through each platform's official OAuth (TikTok Login Kit for Desktop and Google installed-app OAuth, both PKCE over a loopback redirect; Instagram uses an App Dashboard token). Tokens and developer-app secrets are encrypted with Windows DPAPI. **Publish** (on an approved production) uploads through the official APIs: TikTok Direct Post, YouTube resumable upload, and Instagram Reels from a public URL. A post counts as published only when the platform confirms it. Publishing requires QA passed + your approval + a connected, explicitly assigned account. **Auto-publish** unlocks only after a public post you approved has been confirmed. Nothing ever spends money (`requireFinancialAuthorization` always refuses). Setup: [docs/launch-setup.md](docs/launch-setup.md). See [docs/platform-feasibility.md](docs/platform-feasibility.md) for each platform's official capabilities and blockers.

Real autonomous end-to-end check (internet, Strata, Kokoro + Whisper installed): `AIMO_E2E_AUTONOMY=1 AIMO_TOOLS_DIR=<tools> npx vitest run tests/autonomy-e2e.test.ts` (output in `.tmp\autonomy-e2e`).

## Data location

All user data (SQLite database plus the Chromium profile) goes in one folder:

1. `AIMO_DATA_DIR`, if set
2. otherwise Electron's per-user default (`%APPDATA%\Omnicore`)

The app will not start with a data dir inside the installation directory, and uninstalling never deletes data. To keep an installed copy's data off `C:`, set a user environment variable once, for example `setx AIMO_DATA_DIR "F:\Projects\AIMediaOperations\data"` (this machine's setting).

## Layout

```
src/shared/domain.ts      types, workflow stages + rules, typed API contract, IPC channel names
src/main/index.ts         window, security hardening, data dir, smoke mode
src/main/ipc.ts           IPC handlers (sender check + validation on every call)
src/main/validation.ts    input validation for everything coming from the renderer
src/main/paths.ts         data-directory resolution
src/main/db/              migrations (PRAGMA user_version) + repository
src/preload/index.ts      contextBridge → window.api
src/renderer/             React UI: Dashboard, Research, Studio, Content Library, Business
tests/                    vitest
```

## Security model

- `contextIsolation`, `sandbox`, no `nodeIntegration`; the renderer only sees `window.api`.
- Main process validates every IPC argument and accepts calls only from the app's own top frame.
- Strict CSP in production builds (no inline scripts or styles, no remote origins). Dev relaxes it only for Vite HMR.
- Navigation, popups and `<webview>` are blocked; http(s) links open in the default browser; all permission requests are denied.

## Workflow

Idea → Research → Script → Production → Review → Published. Items move forward one stage at a time and can be sent back to any earlier stage. Every move is recorded in `stage_history`.

## Multi-channel

Every content row belongs to a channel (`channel_id`). The UI shows a channel picker once more than one channel exists. Adding channels through the UI is not built yet.
