import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ComfyDetection, ComfyState, ComfyStatus } from '../../shared/comfy';

export type { ComfyDetection, ComfyStatus };

/**
 * ComfyUI as a managed Omnicore service. Omnicore starts an existing ComfyUI installation (for example Stability
 * Matrix's package) as its own child process, on its own port, with Omnicore-owned input/output/user/temp folders and
 * its own model-paths file, custom nodes disabled and no browser. Nothing in the installation is modified and nothing
 * is downloaded: missing pieces are reported with guided setup steps.
 */
export interface ComfyConfig {
  /** ComfyUI installation folder (contains main.py). Empty = detect. */
  installDir: string;
  port: number;
  /** Omnicore-owned working folder (input, output, temp, user, logs, model-paths file). */
  dataDir: string;
}




const CANDIDATES = [
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Stability Matrix', 'Packages', 'ComfyUI') : '',
  'F:/Stability Matrix/Packages/ComfyUI',
  'D:/Stability Matrix/Packages/ComfyUI',
  'C:/Stability Matrix/Packages/ComfyUI'
].filter(Boolean);

const pythonOf = (dir: string): string | null => {
  for (const p of ['venv/Scripts/python.exe', 'python_embeded/python.exe', '../python_embeded/python.exe', 'venv/bin/python']) {
    const f = path.resolve(dir, p);
    if (fs.existsSync(f)) return f;
  }
  return null;
};

/** Stability Matrix keeps shared models two levels up (…/Stability Matrix/Models). */
const modelsRootOf = (dir: string): string | null => {
  const sm = path.resolve(dir, '..', '..', 'Models');
  if (fs.existsSync(path.join(sm, 'StableDiffusion'))) return sm;
  const own = path.join(dir, 'models');
  return fs.existsSync(own) ? own : null;
};

export class ComfyRuntime {
  private child: ChildProcess | null = null;
  private st: { state: ComfyState; lastError: string; startedAt: string | null } = { state: 'stopped', lastError: '', startedAt: null };
  private detection: ComfyDetection | null = null;

  constructor(private readonly cfg: () => ComfyConfig, private readonly onEvent?: (type: string, data: Record<string, unknown>) => void) {}

  get url(): string {
    return `http://127.0.0.1:${this.cfg().port}`;
  }

  /** Find the installation, its Python, models and CUDA support (runs Python once; cached until the next call). */
  async detect(): Promise<ComfyDetection> {
    const c = this.cfg();
    const problems: string[] = [];
    const setup: string[] = [];
    const dirs = [c.installDir, ...CANDIDATES].filter(Boolean);
    const installDir = dirs.find((d) => fs.existsSync(path.join(d, 'main.py'))) ?? null;
    let python: string | null = null;
    let version: string | null = null;
    let torch: string | null = null;
    let cuda: boolean | null = null;
    let gpu: string | null = null;
    if (!installDir) {
      problems.push('No ComfyUI installation found.');
      setup.push('Install the ComfyUI package in Stability Matrix (it includes Python and PyTorch), or set the ComfyUI folder in Studio → Providers. Omnicore never downloads it for you.');
    } else {
      python = pythonOf(installDir);
      const vf = path.join(installDir, 'comfyui_version.py');
      version = fs.existsSync(vf) ? (/__version__\s*=\s*"([^"]+)"/.exec(fs.readFileSync(vf, 'utf8'))?.[1] ?? null) : null;
      if (!python) {
        problems.push(`No Python environment in ${installDir}.`);
        setup.push('Open Stability Matrix once and let it finish installing the ComfyUI package (it creates the venv).');
      } else {
        const out = await new Promise<string>((resolve) =>
          execFile(python!, ['-c', "import torch;print(torch.__version__);print(torch.cuda.is_available());print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else '')"], { windowsHide: true, timeout: 120_000 }, (e, so) => resolve(e ? `ERR ${e.message}` : String(so)))
        );
        if (out.startsWith('ERR')) {
          problems.push(`PyTorch could not be loaded: ${out.slice(4, 300)}`);
          setup.push('Repair the ComfyUI package in Stability Matrix (Update/Repair), then detect again.');
        } else {
          const [tv, ca, g] = out.trim().split(/\r?\n/);
          torch = tv ?? null;
          cuda = ca === 'True';
          gpu = g || null;
          if (!cuda) {
            problems.push('PyTorch cannot use the NVIDIA GPU (CUDA unavailable).');
            setup.push('Update the NVIDIA driver, then reinstall the ComfyUI package in Stability Matrix with the CUDA build of PyTorch.');
          }
        }
      }
    }
    const modelsRoot = installDir ? modelsRootOf(installDir) : null;
    if (installDir && !modelsRoot) {
      problems.push('No models folder found.');
      setup.push('Download an SDXL checkpoint in Stability Matrix (Model Browser). Omnicore does not download models automatically.');
    }
    this.detection = { ok: problems.length === 0, installDir, python, modelsRoot, version, torch, cuda, gpu, problems, setup };
    return this.detection;
  }

  /** Omnicore's own model-paths file, pointing ComfyUI at the shared models without touching the installation's config. */
  private writeModelPaths(modelsRoot: string): string {
    const c = this.cfg();
    fs.mkdirSync(c.dataDir, { recursive: true });
    const f = path.join(c.dataDir, 'extra_model_paths.yaml');
    const sm = fs.existsSync(path.join(modelsRoot, 'StableDiffusion'));
    const map: [string, string][] = sm
      ? [['checkpoints', 'StableDiffusion'], ['vae', 'VAE'], ['loras', 'Lora'], ['text_encoders', 'TextEncoders'], ['clip', 'TextEncoders'], ['diffusion_models', 'DiffusionModels'], ['unet', 'DiffusionModels'], ['upscale_models', 'ESRGAN']]
      : [['checkpoints', 'checkpoints'], ['vae', 'vae'], ['loras', 'loras'], ['text_encoders', 'text_encoders'], ['diffusion_models', 'diffusion_models']];
    const yaml = `omnicore:\n  base_path: ${JSON.stringify(modelsRoot.replace(/\\/g, '/'))}\n${map.map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n`;
    fs.writeFileSync(f, yaml, 'utf8');
    return f;
  }

  private async ping(timeoutMs = 3000): Promise<Record<string, unknown> | null> {
    try {
      const r = await fetch(`${this.url}/system_stats`, { signal: AbortSignal.timeout(timeoutMs) });
      return r.ok ? ((await r.json()) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  async start(): Promise<ComfyStatus> {
    if (this.st.state === 'running' || this.st.state === 'starting') return this.status();
    const c = this.cfg();
    if (await this.ping()) {
      this.st = { ...this.st, state: 'error', lastError: `Port ${c.port} is already used by another ComfyUI that Omnicore did not start. Stop it or change the port.` };
      throw new Error(this.st.lastError);
    }
    const d = await this.detect();
    if (!d.installDir || !d.python || d.cuda === false) {
      this.st = { ...this.st, state: 'error', lastError: d.problems.join(' ') };
      throw new Error(`ComfyUI cannot start: ${d.problems.join(' ')} ${d.setup.join(' ')}`);
    }
    const dirs = Object.fromEntries(['input', 'output', 'temp', 'user'].map((k) => [k, path.join(c.dataDir, k)]));
    for (const p of Object.values(dirs)) fs.mkdirSync(p, { recursive: true });
    const args = [
      'main.py',
      '--listen', '127.0.0.1',
      '--port', String(c.port),
      '--disable-auto-launch',
      '--disable-all-custom-nodes',
      '--input-directory', dirs.input,
      '--output-directory', dirs.output,
      '--temp-directory', dirs.temp,
      '--user-directory', dirs.user,
      ...(d.modelsRoot ? ['--extra-model-paths-config', this.writeModelPaths(d.modelsRoot)] : [])
    ];
    const log = fs.openSync(path.join(c.dataDir, 'comfyui.log'), 'w');
    this.st = { state: 'starting', lastError: '', startedAt: new Date().toISOString() };
    const child = spawn(d.python, args, { cwd: d.installDir, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    this.child = child;
    this.onEvent?.('comfy.started', { pid: child.pid, port: c.port, installDir: d.installDir, version: d.version });
    child.on('exit', (code) => {
      fs.closeSync(log);
      if (this.child === child) {
        this.child = null;
        const expected = this.st.state === 'stopping';
        this.st = { ...this.st, state: expected ? 'stopped' : 'error', lastError: expected ? '' : `ComfyUI exited unexpectedly (code ${code}). See ${path.join(c.dataDir, 'comfyui.log')}.` };
        this.onEvent?.(expected ? 'comfy.stopped' : 'comfy.crashed', { code });
      }
    });
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (!this.child) throw new Error(this.st.lastError || 'ComfyUI exited while starting.');
      if (await this.ping(2000)) {
        this.st.state = 'running';
        return this.status();
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    await this.stop();
    this.st = { ...this.st, state: 'error', lastError: 'ComfyUI did not answer within 3 minutes.' };
    throw new Error(this.st.lastError);
  }

  async stop(): Promise<ComfyStatus> {
    const child = this.child;
    if (!child) {
      this.st.state = 'stopped';
      return this.status();
    }
    this.st.state = 'stopping';
    try {
      await fetch(`${this.url}/interrupt`, { method: 'POST', signal: AbortSignal.timeout(2000) });
    } catch {
      // not answering: the process is ended below
    }
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once('exit', done);
      if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
      else child.kill('SIGTERM');
      setTimeout(done, 15_000);
    });
    this.child = null;
    this.st = { ...this.st, state: 'stopped' };
    return this.status();
  }

  async restart(): Promise<ComfyStatus> {
    await this.stop();
    return this.start();
  }

  running(): boolean {
    return this.st.state === 'running' && this.child !== null;
  }

  async status(): Promise<ComfyStatus> {
    let system: ComfyStatus['system'] = null;
    let queue: ComfyStatus['queue'] = null;
    if (this.st.state === 'running') {
      const s = (await this.ping()) as { system?: { comfyui_version?: string }; devices?: { name?: string; vram_total?: number; vram_free?: number }[] } | null;
      if (s) {
        const dev = s.devices?.[0];
        system = { version: s.system?.comfyui_version ?? '', vramTotalMb: Math.round((dev?.vram_total ?? 0) / 1048576), vramFreeMb: Math.round((dev?.vram_free ?? 0) / 1048576), device: dev?.name ?? '' };
        try {
          const q = (await (await fetch(`${this.url}/queue`, { signal: AbortSignal.timeout(2000) })).json()) as { queue_running?: unknown[]; queue_pending?: unknown[] };
          queue = { running: q.queue_running?.length ?? 0, pending: q.queue_pending?.length ?? 0 };
        } catch {
          queue = null;
        }
      } else if (this.child) {
        this.st.lastError = 'ComfyUI is not answering.';
      }
    }
    return { state: this.st.state, pid: this.child?.pid ?? null, port: this.cfg().port, url: this.url, installDir: this.detection?.installDir ?? null, lastError: this.st.lastError, startedAt: this.st.startedAt, system, queue };
  }

  /** Ask ComfyUI to unload models and free GPU memory (so the LLM and voice can use it again). */
  async free(): Promise<void> {
    if (!this.running()) return;
    try {
      await fetch(`${this.url}/free`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }), signal: AbortSignal.timeout(10_000) });
    } catch {
      // best effort
    }
  }

  /** The models folder in use (for listing checkpoints). */
  modelsRoot(): string | null {
    return this.detection?.modelsRoot ?? null;
  }

  outputDir(): string {
    return path.join(this.cfg().dataDir, 'output');
  }
}
