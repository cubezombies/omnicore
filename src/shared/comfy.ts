/** A checkpoint in the models folder and whether you approved it (with its licence) for production visuals. */
export interface ComfyModel {
  file: string;
  sizeMb: number;
  base: string;
  approved: boolean;
  license: string;
  licenseUrl: string;
  decidedAt: string | null;
}

export interface ComfyGeneration {
  id: number;
  productionId: number | null;
  sceneIndex: number | null;
  workflowId: string;
  model: string;
  seed: number;
  prompt: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  error: string;
  /** File name inside the production's images folder. */
  outputFile: string;
  sha256: string;
  createdAt: string;
  finishedAt: string | null;
}

export interface ComfyDetection {
  ok: boolean;
  installDir: string | null;
  python: string | null;
  modelsRoot: string | null;
  version: string | null;
  torch: string | null;
  cuda: boolean | null;
  gpu: string | null;
  problems: string[];
  setup: string[];
}

export type ComfyState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface ComfyStatus {
  state: ComfyState;
  pid: number | null;
  port: number;
  url: string;
  installDir: string | null;
  lastError: string;
  startedAt: string | null;
  system: { version: string; vramTotalMb: number; vramFreeMb: number; device: string } | null;
  queue: { running: number; pending: number } | null;
}

export interface GpuProcess {
  pid: number;
  name: string;
  usedMb: number;
}

export interface GpuInfo {
  name: string;
  totalMb: number;
  usedMb: number;
  freeMb: number;
  processes: GpuProcess[];
}
