import { execFile } from 'node:child_process';
import type { GpuInfo, GpuProcess } from '../../shared/comfy';

export type { GpuInfo, GpuProcess };



const run = (args: string[]): Promise<string> =>
  new Promise((resolve, reject) => execFile('nvidia-smi', args, { windowsHide: true, timeout: 15_000 }, (e, out) => (e ? reject(e) : resolve(String(out)))));

/** First NVIDIA GPU (nvidia-smi), with the processes holding its memory. Null when no NVIDIA GPU or driver tool exists. */
export async function gpuInfo(): Promise<GpuInfo | null> {
  try {
    const line = (await run(['--query-gpu=name,memory.total,memory.used,memory.free', '--format=csv,noheader,nounits'])).trim().split(/\r?\n/)[0];
    const [name, total, used, free] = line.split(',').map((x) => x.trim());
    let processes: GpuProcess[] = [];
    try {
      processes = (await run(['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits']))
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => {
          const [pid, pname, mb] = l.split(',').map((x) => x.trim());
          return { pid: Number(pid), name: pname.split(/[\\/]/).pop() ?? pname, usedMb: Number(mb) || 0 };
        });
    } catch {
      processes = [];
    }
    return { name, totalMb: Number(total), usedMb: Number(used), freeMb: Number(free), processes };
  } catch {
    return null;
  }
}

/** Plain explanation of who holds the GPU (for "not enough free VRAM" errors). */
export const describeGpu = (g: GpuInfo): string =>
  `${g.name}: ${g.freeMb} MB free of ${g.totalMb} MB${g.processes.length ? ` (held by ${g.processes.map((p) => `${p.name}${p.usedMb ? ` ${p.usedMb} MB` : ''}`).join(', ')})` : ''}`;
