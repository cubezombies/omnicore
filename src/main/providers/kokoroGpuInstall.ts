import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CancelledError } from '../media/ffmpeg';
import { downloadTo } from './http';
import { kokoroGpuPaths } from './kokoroGpu';

/** uv (MIT/Apache-2.0) builds a private Python for Kokoro inside the tools folder; nothing is installed system-wide. */
export const UV_URL = 'https://github.com/astral-sh/uv/releases/download/0.12.23/uv-x86_64-pc-windows-msvc.zip';
export const KOKORO_GPU_PACKAGES = [
  'kokoro==0.9.4',
  'misaki[en]==0.9.4',
  'soundfile==0.14.0',
  'en_core_web_sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl'
];

function run(exe: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new CancelledError());
    const c = spawn(exe, args, { windowsHide: true, env, cwd });
    let err = '';
    c.stdout.resume();
    c.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    const onAbort = () => c.kill();
    signal.addEventListener('abort', onAbort, { once: true });
    c.on('error', (e) => reject(new Error(`Could not run ${path.basename(exe)}: ${e.message}`)));
    c.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) return reject(new CancelledError());
      if (code !== 0) return reject(new Error(`${path.basename(exe)} ${args[0]} failed (exit ${code}): ${err.trim().split(/\r?\n/).slice(-2).join(' ')}`));
      resolve();
    });
  });
}

/** True when an NVIDIA GPU driver is present (then the CUDA build of PyTorch is installed). */
export async function hasNvidiaGpu(signal: AbortSignal): Promise<boolean> {
  try {
    await run('nvidia-smi', ['-L'], process.env, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * One-click local install (free; about 3.5 GB with the CUDA runtime, 1 GB on CPU-only machines):
 * uv → private Python 3.12 → PyTorch + Kokoro + misaki → the Kokoro-82M model (Apache-2.0) from Hugging Face.
 */
export async function installKokoroGpu(toolsDir: string, tmpDir: string, signal: AbortSignal, onStatus: (m: string) => void = () => {}): Promise<{ device: 'cuda' | 'cpu' }> {
  const p = kokoroGpuPaths(toolsDir);
  const uvDir = path.join(p.root, 'uv');
  const uv = path.join(uvDir, 'uv.exe');
  fs.mkdirSync(uvDir, { recursive: true });
  const env = {
    ...process.env,
    UV_CACHE_DIR: path.join(p.root, 'cache'),
    UV_PYTHON_INSTALL_DIR: path.join(p.root, 'python'),
    HF_HOME: p.hf,
    HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
    TEMP: tmpDir,
    TMP: tmpDir
  };
  if (!fs.existsSync(uv)) {
    onStatus('Downloading uv…');
    const zip = path.join(uvDir, 'uv.zip');
    await downloadTo(UV_URL, zip, { signal, timeoutMs: 300_000 });
    const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    await run(fs.existsSync(tar) ? tar : 'tar', ['-xf', zip, '-C', uvDir], env, signal);
    fs.rmSync(zip, { force: true });
    if (!fs.existsSync(uv)) throw new Error('The uv download did not contain uv.exe.');
  }
  const cuda = await hasNvidiaGpu(signal);
  if (!fs.existsSync(p.python)) {
    onStatus('Creating a private Python 3.12…');
    await run(uv, ['venv', '--clear', '--python', '3.12', path.join(p.root, 'venv')], env, signal);
  }
  onStatus(cuda ? 'Installing PyTorch with CUDA (about 3 GB)…' : 'Installing PyTorch for the CPU…');
  await run(uv, ['pip', 'install', '--python', p.python, 'torch==2.11.0', '--index-url', cuda ? 'https://download.pytorch.org/whl/cu128' : 'https://download.pytorch.org/whl/cpu'], env, signal);
  onStatus('Installing Kokoro and the misaki phonemizer…');
  await run(uv, ['pip', 'install', '--python', p.python, ...KOKORO_GPU_PACKAGES], env, signal);
  onStatus('Downloading the Kokoro model…');
  await run(
    p.python,
    ['-c', "from huggingface_hub import snapshot_download; snapshot_download('hexgrad/Kokoro-82M', allow_patterns=['config.json', 'kokoro-v1_0.pth', 'voices/*'])"],
    env,
    signal
  );
  fs.rmSync(path.join(p.root, 'cache'), { recursive: true, force: true });
  onStatus('Kokoro (GPU) is installed.');
  return { device: cuda ? 'cuda' : 'cpu' };
}
