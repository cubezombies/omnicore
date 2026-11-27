import fs from 'node:fs';
import { BrowserWindow, nativeImage } from 'electron';
import { VIDEO_H, VIDEO_W } from './render';

let queue: Promise<unknown> = Promise.resolve();
const HALF = VIDEO_H / 2;

/**
 * Windows clamps even offscreen windows to the screen's work area, so a 1080×1920 page would be laid out at
 * the wrong height and stretched. Instead the page is drawn as two exact 1080×960 halves (the second shifted
 * up by a CSS transform) and the pixel rows are joined, with no resizing.
 */
export function halfPage(html: string, half: 0 | 1): string {
  const css = `html{background:#020617}body{position:relative;${half ? `transform:translateY(-${HALF}px);` : ''}}`;
  return html.replace('</style>', `${css}</style>`);
}

/** Join two BGRA bitmaps of equal width top-to-bottom. */
export function stackBitmaps(top: Buffer, bottom: Buffer): Buffer {
  return Buffer.concat([top, bottom]);
}

/**
 * Draw self-contained HTML to a 1080×1920 PNG with a hidden, sandboxed offscreen window
 * (no scripts, no Node, no navigation). Calls are serialised so only one window exists at a time.
 */
export function electronRasterize(html: string, outPng: string, signal: AbortSignal): Promise<void> {
  const job = queue.then(async () => {
    if (signal.aborted) throw new Error('Cancelled');
    const w = new BrowserWindow({
      width: VIDEO_W,
      height: HALF,
      useContentSize: true,
      show: false,
      frame: false,
      webPreferences: { offscreen: true, javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false }
    });
    try {
      w.webContents.setZoomFactor(1);
      w.webContents.on('will-navigate', (e) => e.preventDefault());
      w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const halves: Buffer[] = [];
      for (const half of [0, 1] as const) {
        await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(halfPage(html, half))}`);
        await new Promise((r) => setTimeout(r, 200)); // let fonts and layout settle
        const [cw, ch] = w.getContentSize();
        const shot = await w.webContents.capturePage({ x: 0, y: 0, width: cw, height: ch });
        const { width, height } = shot.getSize();
        // Display scaling can add a pixel or two; crop to the exact half (never resize, which would distort text).
        if (width < VIDEO_W || height < HALF || width > VIDEO_W + 8 || height > HALF + 8) throw new Error(`The graphic renderer drew ${width}×${height} instead of ${VIDEO_W}×${HALF} (screen too small or scaled).`);
        halves.push(shot.crop({ x: 0, y: 0, width: VIDEO_W, height: HALF }).toBitmap());
      }
      const out = nativeImage.createFromBitmap(stackBitmaps(halves[0], halves[1]), { width: VIDEO_W, height: VIDEO_H });
      if (out.isEmpty()) throw new Error('The graphic renderer produced an empty image.');
      fs.writeFileSync(outPng, out.toPNG());
    } finally {
      w.destroy();
    }
  });
  queue = job.catch(() => undefined);
  return job;
}
