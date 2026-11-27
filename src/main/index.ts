import { stopKokoroGpuWorkers } from './providers/kokoroGpu';
import { app, BrowserWindow, dialog, Menu, nativeImage, net, protocol, safeStorage, session, shell, Tray, type IpcMainInvokeEvent } from 'electron';
import { Publisher } from './publishing/publisher';
import { defaultClients } from './publishing/platforms';
import { AuditLedger } from './audit/ledger';
import { defaultDiscoverySources, discover } from './autonomy/discovery';
import { OperatingEngine } from './autonomy/engine';
import { OperationsRepository } from './db/operations';
import { SherpaWhisper } from './qa/asr';
import type { AutonomySettings } from '../shared/operations';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { IPC } from '../shared/domain';
import { MEDIA_SCHEME } from '../shared/production';
import { openDatabase } from './db/database';
import { ProductionRepository } from './db/productions';
import { Repository } from './db/repository';
import { resolveFfmpeg } from './media/ffmpeg';
import { ProductionRunner } from './pipeline/runner';
import { buildProviders } from './providers/registry';
import { electronRasterize } from './media/rasterize';
import { BusinessRepository } from './business/businesses';
import { TopicRepository } from './business/topics';
import { BusinessContext } from './business/context';
import { PronunciationRepository, checkPronunciations, englishWords } from './pronunciation/dictionary';
import { onAutonomySettingsChanged, registerIpc } from './ipc';
import { SoundLibrary } from './library';
import { DATA_DIR_ENV, resolveDataDir, resolveLibraryPath, resolveMediaPath, resolveSamplePath } from './paths';

// Resolve and apply the data directory before anything else touches userData,
// so the database and the Chromium profile both live outside the install dir.
function prepareDataDir(): string {
  try {
    const dir = resolveDataDir({
      env: process.env,
      defaultUserData: () => app.getPath('userData'),
      installDir: path.dirname(app.getPath('exe')),
      isPackaged: app.isPackaged
    });
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (e) {
    const msg = `${e instanceof Error ? e.message : String(e)}\n\nSet ${DATA_DIR_ENV} to a writable folder outside the installation directory.`;
    console.error(msg);
    dialog.showErrorBox('Omnicore cannot start', msg);
    app.exit(1);
    throw e;
  }
}
const dataDir = prepareDataDir();
app.setPath('userData', dataDir);
app.setPath('sessionData', path.join(dataDir, 'session'));

// Production media (previews) are served from the data dir through a locked-down custom scheme.
protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

const DEV_URL = process.env.ELECTRON_RENDERER_URL; // set by electron-vite in dev only
const RENDERER_FILE = path.join(__dirname, '../renderer/index.html');
const SMOKE = process.env.AIMO_SMOKE === '1';
/** Started by Windows at login (or with --background): run the engine without opening a window. */
const BACKGROUND = process.argv.includes('--background');
let keepInTray = false;
let quitting = false;
let tray: Tray | null = null;

let mainWindow: BrowserWindow | null = null;
/** webContents id of our app page; the only renderer allowed to call IPC. */
let appContentsId: number | null = null;

function isAppUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (DEV_URL && !app.isPackaged) return u.origin === new URL(DEV_URL).origin;
    if (u.protocol !== 'file:') return false;
    const same = (a: string, b: string) =>
      process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    return same(path.resolve(fileURLToPath(u)), path.resolve(RENDERER_FILE));
  } catch {
    return false;
  }
}

/** Only our own window's top frame, showing our own page, may call IPC. */
function isTrustedSender(e: IpcMainInvokeEvent): boolean {
  const frame = e.senderFrame;
  return (
    appContentsId !== null &&
    e.sender.id === appContentsId &&
    !!frame &&
    frame === e.sender.mainFrame &&
    isAppUrl(frame.url)
  );
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b1120',
    title: 'Omnicore',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true
    }
  });

  const wc = mainWindow.webContents;
  appContentsId = wc.id;
  wc.once('destroyed', () => {
    if (appContentsId === wc.id) appContentsId = null;
  });
  // No popups; external http(s) links open in the default browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault();
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());

  mainWindow.once('ready-to-show', () => {
    if (!SMOKE) mainWindow?.show();
  });
  mainWindow.on('close', (e) => {
    if (keepInTray && !quitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (DEV_URL && !app.isPackaged) void mainWindow.loadURL(DEV_URL);
  else void mainWindow.loadFile(RENDERER_FILE);

  if (SMOKE) runSmoke(mainWindow);
}

/** Headless self-check used by `npm run smoke`: renderer loads and reaches the DB via IPC. */
function runSmoke(win: BrowserWindow): void {
  const fail = (msg: string): void => {
    console.error(`SMOKE FAIL: ${msg}`);
    app.exit(1);
  };
  const timer = setTimeout(() => fail('timeout'), 20000);
  win.webContents.once('did-finish-load', async () => {
    try {
      const result = await win.webContents.executeJavaScript(`
        new Promise((resolve) => {
          const started = Date.now();
          const poll = () => {
            const nav = [...document.querySelectorAll('nav [data-nav]')].map((n) => n.textContent.trim());
            const channel = document.querySelector('[data-channel-name]')?.textContent ?? '';
            if ((nav.length && channel && channel !== '…') || Date.now() - started > 10000) {
              const hasApi = typeof window.api === 'object';
              const done = (probe) => resolve({ nav, channel, hasNode: typeof require !== 'undefined', hasApi, probe, err: document.querySelector('.banner.error')?.textContent ?? null });
              hasApi ? window.api.listChannels().then((c) => done(c.map((x) => x.name)), (e) => done('ERR ' + e)) : done(null);
            } else setTimeout(poll, 100);
          };
          poll();
        })`);
      clearTimeout(timer);
      console.log(`SMOKE RESULT ${JSON.stringify(result)}`);
      const ok =
        result.nav.length === 8 && result.channel.includes("AI, Actually") && !result.hasNode && result.hasApi && !result.err;
      if (!ok) return fail('unexpected renderer state');
      const shotDir = process.env.AIMO_SMOKE_SHOT; // optional: capture UI screenshots for review
      if (shotDir) {
        const shot = async (name: string, js: string) => {
          await win.webContents.executeJavaScript(js);
          await new Promise((r) => setTimeout(r, 400));
          fs.writeFileSync(path.join(shotDir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
        };
        await shot('dashboard', `window.api.createContent(1, { title: 'Why AI agents keep failing at simple tasks', summary: 'Hook: the demo vs reality gap' })
          .then((i) => window.api.moveContent(i.id, 'research')).then(() => document.querySelectorAll('[data-nav]')[1].click()).then(() => document.querySelectorAll('[data-nav]')[0].click())`);
      }
      const produceTopic = process.env.AIMO_SMOKE_PRODUCE; // optional: full topic → MP4 run through the real UI bridge
      if (produceTopic) {
        const r = await win.webContents.executeJavaScript(`
          (async () => {
            const p = await window.api.createProduction(1, { topic: ${JSON.stringify(produceTopic)} });
            const t0 = Date.now();
            for (;;) {
              await new Promise((r) => setTimeout(r, 1000));
              const x = await window.api.getProduction(p.id);
              if (['completed', 'failed', 'cancelled'].includes(x.status) || Date.now() - t0 > 900000) {
                return { id: x.id, status: x.status, error: x.error, outputPath: x.outputPath, durationSec: x.durationSec, steps: x.steps.map((s) => s.step + ': ' + s.detail) };
              }
            }
          })()`);
        console.log(`SMOKE PRODUCTION ${JSON.stringify(r)}`);
        if (r.status !== 'completed') return fail(`production ${r.status}: ${r.error}`);
        if (shotDir) {
          await win.webContents.executeJavaScript(`document.querySelectorAll('[data-nav]')[2].click()`);
          await new Promise((res) => setTimeout(res, 1500));
          fs.writeFileSync(path.join(shotDir, 'studio.png'), (await win.webContents.capturePage()).toPNG());
        }
      }
      if (process.env.AIMO_SMOKE_MEDIA) {
        // Verify production media is reachable through the custom scheme and playable in <video>.
        const m = await win.webContents.executeJavaScript(`
          (async () => {
            document.querySelectorAll('[data-nav]')[2].click();
            for (let i = 0; i < 100 && !document.querySelector('.preview video'); i++) await new Promise((r) => setTimeout(r, 100));
            const v = document.querySelector('.preview video');
            if (!v) return { video: 'missing' };
            for (let i = 0; i < 100 && v.readyState < 1 && !v.error; i++) await new Promise((r) => setTimeout(r, 100));
            const credits = await fetch(v.src.replace(/final\.mp4.*$/, 'credits.txt')).then((r) => r.status + ':' + r.headers.get('content-type'), (e) => 'ERR ' + e);
            const outside = await fetch(v.src.replace(/final\.mp4.*$/, '..%2F..%2Fai-media-operations.db')).then((r) => r.status, (e) => 'ERR');
            return { readyState: v.readyState, error: v.error && v.error.code, duration: v.duration, w: v.videoWidth, h: v.videoHeight, credits, outside };
          })()`);
        console.log(`SMOKE MEDIA ${JSON.stringify(m)}`);
        if (!(m.readyState >= 1 && m.w === 1080 && m.h === 1920)) return fail('preview video not playable');
      }
      console.log('SMOKE OK');
      app.exit(0);
    } catch (e) {
      fail(String(e));
    }
  });
}

/** omnicore-media://p/<productionId>/<relative path> → file inside that production's folder only. */
function registerMediaProtocol(productionsDir: string, libraryDir: string, samplesDir: string): void {
  const root = path.resolve(productionsDir);
  protocol.handle(MEDIA_SCHEME, (req) => {
    const host = new URL(req.url).hostname;
    const file = host === 'lib' ? resolveLibraryPath(libraryDir, req.url) : host === 'sample' ? resolveSamplePath(samplesDir, req.url) : resolveMediaPath(root, req.url);
    if (!file || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString(), { headers: req.headers });
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else createWindow();
  });

  void app.whenReady().then(() => {
    // Deny every permission request (camera, mic, notifications, ...) until a feature needs one.
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    session.defaultSession.setPermissionCheckHandler(() => false);

    const db = openDatabase(path.join(dataDir, 'ai-media-operations.db'));
    const repo = new Repository(db);
    const productions = new ProductionRepository(db);
    const productionsDir = path.join(dataDir, 'productions');
    const tmpDir = path.join(dataDir, 'tmp');
    const dirs = { tmpDir, toolsDir: path.join(dataDir, 'tools'), rasterize: electronRasterize };
    const library = new SoundLibrary(db, path.join(dataDir, 'library'), () => resolveFfmpeg(productions.getSettings().ffmpegPath));
    fs.mkdirSync(productionsDir, { recursive: true });
    productions.markInterrupted();
    productions.restoreOutputs(productionsDir);
    const ops = new OperationsRepository(db);
    const pronunciations = new PronunciationRepository(db);
    const businesses = new BusinessRepository(db);
    const topics = new TopicRepository(db);
    const business = new BusinessContext(db, businesses);
    const audit = new AuditLedger(db, path.join(dataDir, 'evidence'));
    const runner = new ProductionRunner({
      ops,
      audit,
      asr: new SherpaWhisper(dirs.toolsDir),
      repo: productions,
      productionsDir,
      settings: () => productions.getSettings(),
      providers: (s) => buildProviders(s, dirs),
      library,
      ffmpeg: (s) => resolveFfmpeg(s.ffmpegPath),
      pronunciations: (bid, engine) => pronunciations.resolved(bid, engine),
      pronunciationCheck: (p) => (p.storyboard ? checkPronunciations(p.storyboard, pronunciations.list(p.channelId), englishWords(dirs.toolsDir)) : []),
      channel: (id) => {
        // Each production is written with its own business's identity and agent instructions, never another's.
        const c = businesses.get(id);
        return { name: c.name, niche: c.niche, instructions: c.instructions, keywords: topics.discoveryProfile(id).keywords };
      },
      emit: (id) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.onProductionChanged, id);
        else if (appContentsId !== null) BrowserWindow.getAllWindows()[0]?.webContents.send(IPC.onProductionChanged, id);
      },
      onScript: (id, sb) => {
        // Copy the generated script into the linked content item if it has none yet.
        const p = productions.get(id);
        const item = p.contentId ? repo.getContent(p.contentId) : null;
        if (item && !item.script.trim()) {
          repo.updateContent(item.id, { script: sb.scenes.map((s) => s.narration).join('\n\n') });
        }
      }
    });
    const samplesDir = path.join(dataDir, 'samples');
    // Tokens and developer-app secrets are encrypted with Windows DPAPI via safeStorage; never stored in plain text.
    const publisher = new Publisher({
      db,
      ops,
      productions,
      audit,
      clients: defaultClients(),
      open: (url) => shell.openExternal(url),
      box: {
        available: () => safeStorage.isEncryptionAvailable(),
        encrypt: (s) => safeStorage.encryptString(s),
        decrypt: (b) => safeStorage.decryptString(Buffer.from(b))
      }
    });
    const engine = new OperatingEngine({
      publisher,
      ops,
      productions,
      runner,
      audit,
      topics,
      discover: (_brandId, keywords, recent, signal, anchors) => discover(defaultDiscoverySources(), keywords, recent, signal, anchors),
      onChange: () => BrowserWindow.getAllWindows()[0]?.webContents.send(IPC.onProductionChanged, 0)
    });
    registerIpc({ repo, productions, runner, info: { version: app.getVersion(), dataDir }, dirs, library, samplesDir, ops, audit, engine, publisher, isTrustedSender, businesses, topics, business, pronunciations });
    registerMediaProtocol(productionsDir, library.dir, samplesDir);
    // Keep every window on the real active business, whoever switched it.
    business.onChange((b) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(IPC.onBusinessChanged, b.id)));

    // Automation is configured per business; the engine runs while any active business has it enabled.
    const applyAutonomy = () => {
      const all = ops.brandIds().map((b) => ops.getAutonomy(b));
      const a: AutonomySettings = { ...(all[0] ?? ops.getAutonomy(0)), enabled: all.some((x) => x.enabled), keepRunningInTray: all.some((x) => x.keepRunningInTray), runAtStartup: all.some((x) => x.runAtStartup) };
      keepInTray = a.keepRunningInTray && (a.enabled || BACKGROUND);
      if (a.enabled) engine.start();
      else void engine.stop('disabled by user');
      // Registering a login item only makes sense for the installed app (dev would register electron.exe).
      if (app.isPackaged && !SMOKE) app.setLoginItemSettings({ openAtLogin: a.runAtStartup, args: ['--background'] });
      if (keepInTray && !tray) {
        tray = new Tray(nativeImage.createFromPath(process.execPath).resize({ width: 16, height: 16 }));
        tray.setToolTip('Omnicore');
        tray.on('click', () => (mainWindow ? (mainWindow.show(), mainWindow.focus()) : createWindow()));
      }
      if (tray) {
        tray.setContextMenu(
          Menu.buildFromTemplate([
            { label: 'Open Omnicore', click: () => (mainWindow ? (mainWindow.show(), mainWindow.focus()) : createWindow()) },
            { label: engine.isRunning() ? 'Autonomy: running' : 'Autonomy: paused', enabled: false },
            { label: 'Run discovery now', click: () => void engine.tick(true) },
            { type: 'separator' },
            { label: 'Quit Omnicore', click: () => ((quitting = true), app.quit()) }
          ])
        );
        if (!keepInTray) (tray.destroy(), (tray = null));
      }
    };
    onAutonomySettingsChanged(applyAutonomy);
    applyAutonomy();

    // Graceful shutdown: stop the engine, let an autonomous production record its interruption, then close the DB.
    let closing = false;
    app.on('before-quit', (e) => {
      quitting = true;
      if (closing) return;
      closing = true;
      e.preventDefault();
      void engine.stop('application quit').finally(() => setTimeout(() => app.quit(), 300));
    });
    app.on('will-quit', () => {
      stopKokoroGpuWorkers();
      db.close();
    });

    if (!BACKGROUND) createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // With autonomy running in the tray, closing the window does not quit.
  app.on('window-all-closed', () => {
    if (!keepInTray) app.quit();
  });
}
