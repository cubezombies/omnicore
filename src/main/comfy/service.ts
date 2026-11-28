import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ComfyGeneration, ComfyModel } from '../../shared/comfy';
import { ProductionFailure } from '../pipeline/failures';
import { ProviderUnavailableError } from '../providers/types';
import type { CircuitBreakers } from '../automation/circuit';
import { describeGpu, gpuInfo, type GpuInfo } from './gpu';
import type { ComfyRuntime } from './runtime';
import { buildWorkflow, cleanModelName, WORKFLOWS, workflowSha256 } from './workflows';

type Row = Record<string, unknown>;
const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

export interface GenerateRequest {
  businessId: number;
  /** Null only for an isolated verification generation (never part of a production). */
  productionId: number | null;
  sceneIndex: number;
  jobId?: number | null;
  prompt: string;
  /** Where the image is written (must be inside allowedDir). */
  outFile: string;
  allowedDir: string;
  workflowId?: string;
  model?: string;
  seed?: number;
  steps?: number;
  /** Verification only: allows a model that is not approved for productions. */
  verification?: boolean;
  signal?: AbortSignal;
  onProgress?: (fraction: number, detail: string) => void;
}

export interface GenerateResult {
  file: string;
  sha256: string;
  generationId: number;
  meta: Record<string, unknown>;
}

const OOM = /out of memory|CUDA error: out of memory|OutOfMemoryError|allocat/i;

/**
 * Generation through the managed runtime: approved workflows and approved models only, one job at a time (configurable),
 * free GPU memory checked first, outputs fetched over ComfyUI's API into the production's own folder (path validated)
 * and every generation recorded with its business, production, workflow, model, seed and hashes.
 */
export class ComfyService {
  private running = 0;
  private waiting: (() => void)[] = [];
  private current: { generationId: number; promptId: string; businessId: number; fraction: number; detail: string } | null = null;

  constructor(
    private readonly d: {
      db: DatabaseSync;
      runtime: ComfyRuntime;
      settings: () => { model: string; maxConcurrent: number; minFreeVramMb: number; unloadAfterJob: boolean; autoStart: boolean };
      breakers?: CircuitBreakers;
      audit?: (type: string, businessId: number | null, productionId: number | null, data: Record<string, unknown>) => void;
      gpu?: () => Promise<GpuInfo | null>;
    }
  ) {}

  // ---- models -----------------------------------------------------------------------------------------------
  /** Checkpoints in the models folder with their approval for production use (licence recorded by you). */
  models(): ComfyModel[] {
    const root = this.d.runtime.modelsRoot();
    const dir = root ? [path.join(root, 'StableDiffusion'), path.join(root, 'checkpoints')].find((p) => fs.existsSync(p)) : null;
    const decisions = new Map((this.d.db.prepare('SELECT * FROM comfy_models').all() as Row[]).map((r) => [String(r.file), r]));
    const files = dir ? fs.readdirSync(dir).filter((f) => /\.(safetensors|ckpt)$/i.test(f)) : [];
    return files.map((file) => {
      const r = decisions.get(file);
      let base = '';
      try {
        const info = JSON.parse(fs.readFileSync(path.join(dir!, file.replace(/\.(safetensors|ckpt)$/i, '.cm-info.json')), 'utf8')) as { BaseModel?: string; Nsfw?: boolean };
        base = `${info.BaseModel ?? ''}${info.Nsfw ? ' · NSFW' : ''}`;
      } catch {
        base = '';
      }
      return { file, sizeMb: Math.round(fs.statSync(path.join(dir!, file)).size / 1048576), base, approved: r?.status === 'approved', license: r ? String(r.license) : '', licenseUrl: r ? String(r.license_url) : '', decidedAt: r ? String(r.decided_at) : null };
    });
  }

  /** Record that a model may be used for production visuals, with its licence. Only you can do this. */
  approveModel(file: string, license: string, licenseUrl: string, note: string): ComfyModel {
    cleanModelName(file);
    if (!this.models().some((m) => m.file === file)) throw new Error(`"${file}" is not in the models folder.`);
    if (license.trim().length < 3) throw new Error('Record the model licence (for example "CreativeML Open RAIL++-M").');
    this.d.db
      .prepare(`INSERT INTO comfy_models (file, status, license, license_url, note, decided_by) VALUES (?, 'approved', ?, ?, ?, 'user') ON CONFLICT(file) DO UPDATE SET status = 'approved', license = excluded.license, license_url = excluded.license_url, note = excluded.note, decided_by = 'user', decided_at = ${NOW}`)
      .run(file, license.trim(), licenseUrl.trim(), note.trim());
    this.d.audit?.('comfy.model.approved', null, null, { file, license, licenseUrl, note });
    return this.models().find((m) => m.file === file)!;
  }

  revokeModel(file: string, note: string): void {
    this.d.db.prepare(`UPDATE comfy_models SET status = 'revoked', note = ?, decided_by = 'user', decided_at = ${NOW} WHERE file = ?`).run(note, file);
    this.d.audit?.('comfy.model.revoked', null, null, { file, note });
  }

  private approved(file: string): boolean {
    return (this.d.db.prepare("SELECT status FROM comfy_models WHERE file = ?").get(file) as Row | undefined)?.status === 'approved';
  }

  // ---- generation -------------------------------------------------------------------------------------------
  private async slot(signal?: AbortSignal): Promise<() => void> {
    const max = Math.max(1, Math.min(2, this.d.settings().maxConcurrent));
    while (this.running >= max) {
      if (signal?.aborted) throw new ProviderUnavailableError('Cancelled while waiting for the GPU.');
      await new Promise<void>((r) => this.waiting.push(r));
    }
    this.running++;
    return () => {
      this.running--;
      this.waiting.shift()?.();
    };
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const s = this.d.settings();
    const workflowId = req.workflowId ?? 'sdxl-illustration';
    const model = req.model ?? s.model;
    if (!model) throw new ProviderUnavailableError('No ComfyUI model is selected. Approve and choose one in Studio → ComfyUI.');
    if (!req.verification && !this.approved(model)) throw new ProductionFailure('rights', 'comfy-model-not-approved', `The model "${model}" is not approved for production visuals. Record its licence and approve it in Studio → ComfyUI.`);
    if (this.d.breakers && !this.d.breakers.allows('comfyui')) throw new ProviderUnavailableError('ComfyUI is paused after repeated failures (circuit open). It is tried again after the cooldown.');
    const out = path.resolve(req.outFile);
    if (!out.startsWith(path.resolve(req.allowedDir) + path.sep) || !/\.png$/i.test(out)) throw new Error('Invalid output path for a generated image.');
    const release = await this.slot(req.signal);
    let generationId = 0;
    try {
      if (!this.d.runtime.running()) {
        if (!s.autoStart) throw new ProviderUnavailableError('ComfyUI is not running. Start it in Studio → ComfyUI.');
        req.onProgress?.(0.02, 'Starting ComfyUI…');
        await this.d.runtime.start();
      }
      const workflow = WORKFLOWS[workflowId];
      const need = Math.max(s.minFreeVramMb, workflow?.minFreeVramMb ?? 0);
      const g = await (this.d.gpu ?? gpuInfo)();
      if (g && g.freeMb < need) throw new ProviderUnavailableError(`Not enough free GPU memory for image generation: ${need} MB needed, ${describeGpu(g)}. Free the GPU (for example stop the local LLM) and try again.`);
      const seed = req.seed ?? crypto.randomInt(0, 2 ** 31 - 1);
      const prefix = req.productionId === null ? `omnicore/test/t${Date.now() % 1e9}` : `omnicore/b${req.businessId}/p${req.productionId}/s${req.sceneIndex}`;
      const built = buildWorkflow(workflowId, { prompt: req.prompt, model, seed, steps: req.steps, prefix });
      const promptText = (built.graph['6'] as { inputs: { text: string } }).inputs.text;
      generationId = Number(
        this.d.db
          .prepare('INSERT INTO comfy_generations (business_id, production_id, production_number, job_id, scene_index, workflow_id, workflow_sha256, model, seed, steps, width, height, prompt, negative, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(req.businessId, req.productionId, req.productionId, req.jobId ?? null, req.sceneIndex, workflowId, workflowSha256(workflowId), model, seed, built.steps, built.workflow.width, built.workflow.height, promptText, built.workflow.negative, 'queued').lastInsertRowid
      );
      const res = await fetch(`${this.d.runtime.url}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: built.graph, client_id: `omnicore-${generationId}` }), signal: AbortSignal.timeout(30_000) });
      const body = (await res.json()) as { prompt_id?: string; error?: { message?: string }; node_errors?: unknown };
      if (!res.ok || !body.prompt_id) throw new Error(`ComfyUI refused the workflow: ${body.error?.message ?? res.status} ${JSON.stringify(body.node_errors ?? '').slice(0, 300)}`);
      const promptId = body.prompt_id;
      this.d.db.prepare("UPDATE comfy_generations SET prompt_id = ?, status = 'running' WHERE id = ?").run(promptId, generationId);
      this.current = { generationId, promptId, businessId: req.businessId, fraction: 0, detail: 'queued in ComfyUI' };
      const started = Date.now();
      let image: { filename: string; subfolder: string; type: string } | null = null;
      while (Date.now() - started < 15 * 60_000) {
        // Checked after each wait, so a cancellation during the wait is never missed.
        await new Promise((r) => setTimeout(r, 1000));
        if (req.signal?.aborted) {
          await fetch(`${this.d.runtime.url}/interrupt`, { method: 'POST' }).catch(() => undefined);
          await fetch(`${this.d.runtime.url}/queue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: [promptId] }) }).catch(() => undefined);
          this.finish(generationId, 'cancelled', 'Cancelled.');
          throw new ProviderUnavailableError('Image generation cancelled.');
        }
        const hist = (await (await fetch(`${this.d.runtime.url}/history/${promptId}`, { signal: AbortSignal.timeout(10_000) })).json()) as Record<string, { status?: { status_str?: string; completed?: boolean; messages?: [string, Record<string, unknown>][] }; outputs?: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }> }>;
        const h = hist[promptId];
        const elapsed = (Date.now() - started) / 1000;
        this.current.fraction = Math.min(0.95, elapsed / 60);
        this.current.detail = `generating (${Math.round(elapsed)} s)`;
        req.onProgress?.(this.current.fraction, `Generating with ComfyUI (${Math.round(elapsed)} s)`);
        if (!h) continue;
        if (h.status?.status_str === 'error') {
          const msg = h.status.messages?.find((m) => m[0] === 'execution_error')?.[1] as { exception_message?: string } | undefined;
          const text = msg?.exception_message ?? 'ComfyUI reported an error.';
          if (OOM.test(text)) {
            await this.d.runtime.free();
            throw new ProviderUnavailableError(`ComfyUI ran out of GPU memory (${text.slice(0, 160)}). Models were unloaded; free more GPU memory and retry.`);
          }
          throw new Error(`ComfyUI failed: ${text.slice(0, 300)}`);
        }
        image = Object.values(h.outputs ?? {}).flatMap((o) => o.images ?? [])[0] ?? null;
        if (image) break;
      }
      if (!image) throw new Error('ComfyUI did not finish the image within 15 minutes.');
      // Only an image from this job's own output folder is accepted.
      if (image.type !== 'output' || image.subfolder.replace(/\\/g, '/') !== path.posix.dirname(prefix) || !/^[\w.-]+\.png$/.test(image.filename) || !image.filename.startsWith(path.posix.basename(prefix))) {
        throw new Error(`ComfyUI returned an unexpected output (${image.subfolder}/${image.filename}).`);
      }
      const q = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: 'output' });
      const bytes = Buffer.from(await (await fetch(`${this.d.runtime.url}/view?${q}`, { signal: AbortSignal.timeout(60_000) })).arrayBuffer());
      if (bytes.length < 1000 || bytes.readUInt32BE(0) !== 0x89504e47) throw new Error('ComfyUI returned something that is not a PNG image.');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, bytes);
      const sha = crypto.createHash('sha256').update(bytes).digest('hex');
      // ComfyUI's copy is removed so the shared output folder keeps no business's images.
      const copy = path.resolve(this.d.runtime.outputDir(), image.subfolder, image.filename);
      if (copy.startsWith(path.resolve(this.d.runtime.outputDir()) + path.sep)) fs.rmSync(copy, { force: true });
      this.d.db.prepare(`UPDATE comfy_generations SET status = 'succeeded', output_path = ?, output_sha256 = ?, finished_at = ${NOW} WHERE id = ?`).run(out, sha, generationId);
      this.d.breakers?.success('comfyui');
      const meta = { generator: 'comfyui', aiGenerated: true, generationId, promptId, workflow: workflowId, workflowSha256: workflowSha256(workflowId), model, seed, steps: built.steps, width: built.workflow.width, height: built.workflow.height, prompt: promptText, negative: built.workflow.negative, sha256: sha, comfyuiVersion: (await this.d.runtime.status()).system?.version ?? '' };
      this.d.audit?.('comfy.generation', req.businessId, req.productionId, { ...meta, sceneIndex: req.sceneIndex, verification: !!req.verification });
      req.onProgress?.(1, 'Image generated');
      return { file: out, sha256: sha, generationId, meta };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (generationId) this.finish(generationId, 'failed', msg);
      if (!(e instanceof ProductionFailure) && !/cancelled/i.test(msg) && !/Not enough free GPU memory/.test(msg)) this.d.breakers?.failure('comfyui', msg);
      throw e;
    } finally {
      this.current = null;
      if (s.unloadAfterJob) await this.d.runtime.free();
      release();
    }
  }

  private finish(id: number, status: 'failed' | 'cancelled', error: string): void {
    this.d.db.prepare(`UPDATE comfy_generations SET status = ?, error = ?, finished_at = ${NOW} WHERE id = ? AND status IN ('queued','running')`).run(status, error.slice(0, 1000), id);
  }

  /** The generation in progress, if it belongs to this business. */
  progress(businessId: number): { generationId: number; fraction: number; detail: string } | null {
    return this.current && this.current.businessId === businessId ? { generationId: this.current.generationId, fraction: this.current.fraction, detail: this.current.detail } : null;
  }

  /** Generation history of one business only. */
  history(businessId: number, limit = 30): ComfyGeneration[] {
    return (this.d.db.prepare('SELECT * FROM comfy_generations WHERE business_id = ? ORDER BY id DESC LIMIT ?').all(businessId, limit) as Row[]).map((r) => ({
      id: Number(r.id),
      productionId: r.production_id === null ? null : Number(r.production_id),
      sceneIndex: r.scene_index === null ? null : Number(r.scene_index),
      workflowId: String(r.workflow_id),
      model: String(r.model),
      seed: Number(r.seed),
      prompt: String(r.prompt),
      status: r.status as ComfyGeneration['status'],
      error: String(r.error),
      outputFile: r.output_path ? path.basename(String(r.output_path)) : '',
      sha256: String(r.output_sha256),
      createdAt: String(r.created_at),
      finishedAt: (r.finished_at as string) ?? null
    }));
  }
}
