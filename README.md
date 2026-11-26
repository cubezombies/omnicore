# AI Media Operations

Windows desktop app for running an AI-produced media business. First channel: **AI, Actually** (AI and technology; TikTok → YouTube Shorts → Instagram Reels).

Stack: Electron 45 · React 19 · TypeScript · Vite (electron-vite) · SQLite via Node's built-in `node:sqlite` (no native modules) · electron-builder (NSIS).

## Run

```bat
scripts\dev.cmd            :: hot-reload dev (installs deps on first run)
scripts\dev.cmd preview    :: run the production build
```

`dev.cmd` keeps temp files, npm/Electron caches and app data on `F:`. The dev data directory is `F:\Claude\AI Media Operations\data-dev` unless `AIMO_DATA_DIR` is already set.

| Command | What it does |
|---|---|
| `npm test` | Unit tests: schema/migrations, repository, workflow, IPC validation, data-dir rules |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run smoke` | Builds, launches the real Electron app headless against a throwaway data dir, checks sandboxing + IPC + DB |
| `npm run pack` | Unpacked app in `release\win-unpacked` |
| `npm run dist` | NSIS installer in `release\` (unsigned) |

Set `TMP`/`TEMP` to an `F:` folder before running `npm run dist` by hand (`dev.cmd` does this).

## Video Factory (Studio)

Studio turns a topic (or a content item via **Produce video**) into a finished 1080×1920 H.264/AAC MP4 with narration, visuals and word-synchronised burned-in captions. Pipeline steps, each persisted, resumable and individually re-runnable:

| Step | Default provider (free) | Alternatives |
|---|---|---|
| Research | Wikipedia API (article intros + URLs); a linked item's research notes | — |
| Brief | Deterministic fact selection: verbatim sentences from cited sources | — |
| Script & storyboard | Extractive writer (no AI) | Local OpenAI-compatible LLM (LM Studio, Ollama, …) |
| Narration | Windows speech (SAPI) with per-word timings | — (adapter interface in `src/main/providers/types.ts`) |
| Visuals | Freely licensed images from the cited Wikipedia articles, then Commons search (licence- and relevance-filtered), then local title cards | ComfyUI (local generation) |
| Captions | ASS from narration word timings | — |
| Render | Bundled FFmpeg: Ken Burns stills, loudness-normalised narration, optional ducked music bed | Custom FFmpeg path |

Output per production: `<data dir>\productions\<id>inal.mp4` plus `credits.txt` (sources + image licences/attribution for the post description). Every step records attempts, errors, progress and cost (all built-in providers cost $0). Failed or cancelled productions resume from the failed step; productions interrupted by an app exit are marked failed and retryable.

Live end-to-end check (needs internet + Windows): `set AIMO_E2E=1 && npx vitest run tests/e2e.test.ts` (output kept in `.tmp\e2e`). Through the real app: `AIMO_SMOKE_PRODUCE="<topic>" node scripts/smoke.mjs`.

## Data location

All user data (SQLite database plus the Chromium profile) goes in one folder:

1. `AIMO_DATA_DIR`, if set
2. otherwise Electron's per-user default (`%APPDATA%\AI Media Operations`)

The app will not start with a data dir inside the installation directory, and uninstalling never deletes data. To keep an installed copy's data off `C:`, set a user environment variable once, for example `setx AIMO_DATA_DIR "F:\Claude\AI Media Operations\data"`.

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
