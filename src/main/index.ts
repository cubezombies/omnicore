import { app, BrowserWindow, dialog, session, shell, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db/database';
import { Repository } from './db/repository';
import { registerIpc } from './ipc';
import { DATA_DIR_ENV, resolveDataDir } from './paths';

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
    dialog.showErrorBox('AI Media Operations cannot start', msg);
    app.exit(1);
    throw e;
  }
}
const dataDir = prepareDataDir();
app.setPath('userData', dataDir);
app.setPath('sessionData', path.join(dataDir, 'session'));

const DEV_URL = process.env.ELECTRON_RENDERER_URL; // set by electron-vite in dev only
const RENDERER_FILE = path.join(__dirname, '../renderer/index.html');
const SMOKE = process.env.AIMO_SMOKE === '1';

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
    title: 'AI Media Operations',
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
        result.nav.length === 5 && result.channel.includes("AI, Actually") && !result.hasNode && result.hasApi && !result.err;
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
      console.log('SMOKE OK');
      app.exit(0);
    } catch (e) {
      fail(String(e));
    }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    // Deny every permission request (camera, mic, notifications, ...) until a feature needs one.
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    session.defaultSession.setPermissionCheckHandler(() => false);

    const db = openDatabase(path.join(dataDir, 'ai-media-operations.db'));
    registerIpc(new Repository(db), { version: app.getVersion(), dataDir }, isTrustedSender);
    app.on('will-quit', () => db.close());

    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}
