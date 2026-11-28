import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../src/main/db/database';
import { ProductionRepository } from '../src/main/db/productions';
import { ComfyService } from '../src/main/comfy/service';
import { ComfyRuntime } from '../src/main/comfy/runtime';
import { buildWorkflow, cleanPrompt, WORKFLOWS, workflowSha256 } from '../src/main/comfy/workflows';
import { CircuitBreakers } from '../src/main/automation/circuit';
import { ProductionFailure } from '../src/main/pipeline/failures';
import { wordBudget } from '../src/main/providers/writers';

// A tiny PNG (8-byte signature + IHDR) is enough for the service's checks.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000, 7)]);

/** A fake ComfyUI: records what it was sent and answers like the real API (or with an error when told to). */
function fakeComfy(opts: { fail?: string; delayMs?: number } = {}) {
  const posted: Record<string, unknown>[] = [];
  const calls: string[] = [];
  let active = 0;
  let maxActive = 0;
  const jobs = new Map<string, { prefix: string; done: number }>();
  let n = 0;
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (o: unknown, code = 200) => (res.writeHead(code, { 'Content-Type': 'application/json' }), res.end(JSON.stringify(o)));
      if (req.url === '/prompt') {
        const b = JSON.parse(body) as { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> };
        posted.push(b.prompt);
        const id = `p${++n}`;
        active++;
        maxActive = Math.max(maxActive, active);
        jobs.set(id, { prefix: String(b.prompt['9'].inputs.filename_prefix), done: Date.now() + (opts.delayMs ?? 300) });
        return json({ prompt_id: id });
      }
      const h = /^\/history\/(\w+)/.exec(req.url ?? '');
      if (h) {
        const j = jobs.get(h[1]);
        if (!j || Date.now() < j.done) return json({});
        active = Math.max(0, active - 1);
        if (opts.fail) return json({ [h[1]]: { status: { status_str: 'error', messages: [['execution_error', { exception_message: opts.fail }]] } } });
        return json({ [h[1]]: { status: { status_str: 'success' }, outputs: { '9': { images: [{ filename: `${path.posix.basename(j.prefix)}_00001_.png`, subfolder: path.posix.dirname(j.prefix), type: 'output' }] } } } });
      }
      if (req.url?.startsWith('/view')) return (res.writeHead(200, { 'Content-Type': 'image/png' }), res.end(PNG));
      if (req.url === '/system_stats') return json({ system: { comfyui_version: '0.41.0' }, devices: [{ name: 'fake', vram_total: 12e9, vram_free: 11e9 }] });
      return json({});
    });
  });
  return { server, posted, calls, maxActive: () => maxActive };
}

let srv: ReturnType<typeof fakeComfy>;
let url: string;
let dir: string;
let db: ReturnType<typeof openDatabase>;
let audits: { type: string; businessId: number | null; productionId: number | null; data: Record<string, unknown> }[];
let freed: number;
let pid: number;

async function start(o: Parameters<typeof fakeComfy>[0] = {}) {
  srv = fakeComfy(o);
  await new Promise<void>((r) => srv.server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(srv.server.address() as AddressInfo).port}`;
}

const runtime = () =>
  ({
    url,
    running: () => true,
    start: async () => undefined,
    free: async () => void freed++,
    status: async () => ({ system: { version: '0.41.0' } }),
    outputDir: () => path.join(dir, 'comfy-output'),
    modelsRoot: () => path.join(dir, 'Models')
  }) as unknown as ComfyRuntime;

const service = (gpuFree = 11000, extra: Partial<{ maxConcurrent: number }> = {}) =>
  new ComfyService({
    db,
    runtime: runtime(),
    breakers: new CircuitBreakers(() => ({ threshold: 3, cooldownMs: 60_000 })),
    settings: () => ({ model: 'sdxl_test.safetensors', maxConcurrent: extra.maxConcurrent ?? 1, minFreeVramMb: 7000, unloadAfterJob: true, autoStart: true }),
    audit: (type, businessId, productionId, data) => audits.push({ type, businessId, productionId, data }),
    gpu: async () => ({ name: 'RTX 5070', totalMb: 12227, usedMb: 12227 - gpuFree, freeMb: gpuFree, processes: [{ pid: 1, name: 'llama-server.exe', usedMb: 10400 }] })
  });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-'));
  fs.mkdirSync(path.join(dir, 'Models', 'StableDiffusion'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Models', 'StableDiffusion', 'sdxl_test.safetensors'), 'x');
  db = openDatabase(':memory:');
  pid = new ProductionRepository(db).create(1, 'comfy test', null, '').id;
  audits = [];
  freed = 0;
});
afterEach(() => srv?.server.close());

describe('approved workflows (validated inputs, no arbitrary graphs)', () => {
  it('builds only the approved graph and refuses bad models, prefixes, seeds and steps', () => {
    const ok = buildWorkflow('sdxl-illustration', { prompt: 'a server rack', model: 'sdxl_test.safetensors', seed: 5, prefix: 'omnicore/b1/p2/s0' });
    expect(Object.values(ok.graph).map((n) => (n as { class_type: string }).class_type).sort()).toEqual(['CLIPTextEncode', 'CLIPTextEncode', 'CheckpointLoaderSimple', 'EmptyLatentImage', 'KSampler', 'SaveImage', 'VAEDecode']);
    expect(() => buildWorkflow('custom', { prompt: 'x y z', model: 'a.safetensors', seed: 1, prefix: 'omnicore/b1/p2/s0' })).toThrow(/Only approved workflows/);
    expect(() => buildWorkflow('sdxl-illustration', { prompt: 'x y z', model: '../secret.safetensors', seed: 1, prefix: 'omnicore/b1/p2/s0' })).toThrow(/not a valid model/);
    expect(() => buildWorkflow('sdxl-illustration', { prompt: 'x y z', model: 'a.safetensors', seed: 1, prefix: '../../etc' })).toThrow(/Invalid output prefix/);
    expect(() => buildWorkflow('sdxl-illustration', { prompt: 'x y z', model: 'a.safetensors', seed: -1, prefix: 'omnicore/b1/p2/s0' })).toThrow(/Invalid seed/);
    expect(() => buildWorkflow('sdxl-illustration', { prompt: 'x y z', model: 'a.safetensors', seed: 1, steps: 200, prefix: 'omnicore/b1/p2/s0' })).toThrow(/Steps/);
    expect(cleanPrompt('rack {"class_type":"Exec"} <script>\u0000 [x]')).not.toMatch(/[{}<>[\]\u0000]/);
    expect(workflowSha256('sdxl-illustration')).toBe(workflowSha256('sdxl-illustration'));
    // Illustrations are never styled as photos or evidence.
    expect(WORKFLOWS['sdxl-illustration'].negative).toMatch(/photograph/);
  });
});

describe('managed generation', () => {
  it('refuses a model that is not approved for production, then generates with full provenance into the production', async () => {
    await start();
    const svc = service();
    const prodDir = path.join(dir, 'productions', String(pid), 'images');
    const req = { businessId: 1, productionId: pid, sceneIndex: 2, prompt: 'GPU cluster', outFile: path.join(prodDir, 'scene-03.png'), allowedDir: path.join(dir, 'productions', String(pid)) };
    await expect(svc.generate(req)).rejects.toBeInstanceOf(ProductionFailure);
    expect(srv.posted).toHaveLength(0);
    svc.approveModel('sdxl_test.safetensors', 'CreativeML Open RAIL++-M', 'https://example.org/license', 'test');
    fs.mkdirSync(path.join(dir, 'comfy-output', 'omnicore', 'b1', `p${pid}`), { recursive: true });
    fs.writeFileSync(path.join(dir, 'comfy-output', 'omnicore', 'b1', `p${pid}`, 's2_00001_.png'), PNG);
    const r = await svc.generate(req);
    expect(fs.readFileSync(r.file).equals(PNG)).toBe(true);
    expect(r.meta).toMatchObject({ generator: 'comfyui', aiGenerated: true, model: 'sdxl_test.safetensors', workflow: 'sdxl-illustration', workflowSha256: workflowSha256('sdxl-illustration') });
    expect(fs.existsSync(path.join(dir, 'comfy-output', 'omnicore', 'b1', `p${pid}`, 's2_00001_.png'))).toBe(false); // ComfyUI's copy removed
    expect(svc.history(1)).toMatchObject([{ productionId: pid, sceneIndex: 2, status: 'succeeded', outputFile: 'scene-03.png' }]);
    expect(svc.history(2)).toEqual([]); // another business sees nothing
    expect(audits.find((a) => a.type === 'comfy.generation')).toMatchObject({ businessId: 1, productionId: pid });
    expect(freed).toBe(1); // models unloaded after the job (GPU back for the LLM and voice)
  });

  it('refuses an output path outside the production folder', async () => {
    await start();
    const svc = service();
    svc.approveModel('sdxl_test.safetensors', 'CreativeML Open RAIL++-M', '', '');
    await expect(svc.generate({ businessId: 1, productionId: pid, sceneIndex: 0, prompt: 'x y z', outFile: path.join(dir, 'elsewhere.png'), allowedDir: path.join(dir, 'productions', String(pid)) })).rejects.toThrow(/Invalid output path/);
  });

  it('does not send a job when the GPU lacks free memory, and says who holds it', async () => {
    await start();
    const svc = service(1400);
    svc.approveModel('sdxl_test.safetensors', 'CreativeML Open RAIL++-M', '', '');
    await expect(svc.generate({ businessId: 1, productionId: pid, sceneIndex: 0, prompt: 'x y z', outFile: path.join(dir, 'p', 'a.png'), allowedDir: path.join(dir, 'p') })).rejects.toThrow(/Not enough free GPU memory.*1400 MB free.*llama-server\.exe/);
    expect(srv.posted).toHaveLength(0);
  });

  it('handles an out-of-memory error gracefully: models unloaded, failure recorded', async () => {
    await start({ fail: 'CUDA error: out of memory' });
    const svc = service();
    svc.approveModel('sdxl_test.safetensors', 'CreativeML Open RAIL++-M', '', '');
    await expect(svc.generate({ businessId: 1, productionId: pid, sceneIndex: 0, prompt: 'x y z', outFile: path.join(dir, 'p', 'a.png'), allowedDir: path.join(dir, 'p') })).rejects.toThrow(/ran out of GPU memory/);
    expect(freed).toBeGreaterThanOrEqual(1);
    expect(svc.history(1)[0]).toMatchObject({ status: 'failed' });
  });

  it('runs one generation at a time and cancels cleanly', async () => {
    await start({ delayMs: 400 });
    const svc = service();
    svc.approveModel('sdxl_test.safetensors', 'CreativeML Open RAIL++-M', '', '');
    const go = (s: number) => svc.generate({ businessId: 1, productionId: pid, sceneIndex: s, prompt: 'x y z', outFile: path.join(dir, 'p', `s${s}.png`), allowedDir: path.join(dir, 'p') });
    await Promise.all([go(0), go(1)]);
    expect(srv.maxActive()).toBe(1);
    const ctrl = new AbortController();
    const p = svc.generate({ businessId: 1, productionId: pid, sceneIndex: 3, prompt: 'x y z', outFile: path.join(dir, 'p', 's3.png'), allowedDir: path.join(dir, 'p'), signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 150);
    await expect(p).rejects.toThrow(/cancelled/);
    expect(srv.calls).toContain('POST /interrupt');
    expect(svc.history(1)[0]).toMatchObject({ status: 'cancelled' });
  });
});

describe('runtime detection (real installation, if present)', () => {
  it('finds the ComfyUI install, its Python and models without modifying it', async () => {
    const rt = new ComfyRuntime(() => ({ installDir: '', port: 8199, dataDir: path.join(dir, 'managed') }));
    const d = await rt.detect();
    if (!d.installDir) return; // no ComfyUI on this machine: guided setup is reported instead
    expect(d.python).toBeTruthy();
    expect(d.problems.filter((p) => !/models/.test(p))).toEqual([]);
  }, 180_000);
});

describe('script length calibration', () => {
  it('a faster voice gets a larger word budget (Production 23: 2.84 words/s)', () => {
    expect(wordBudget('standard', 2.15).minWords).toBe(131);
    expect(wordBudget('standard', 2.84).minWords).toBe(173);
  });
});

/** Real runtime + real generation. Needs ~7 GB of free GPU memory. Run with AIMO_E2E_COMFY=1. */
const real = process.env.AIMO_E2E_COMFY === '1' ? describe : describe.skip;
real('real ComfyUI end to end', () => {
  it('starts the managed runtime, generates one image into a test production, and stops', async () => {
    const out = process.env.AIMO_E2E_COMFY_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-real-'));
    const rt = new ComfyRuntime(() => ({ installDir: '', port: 8199, dataDir: path.join(out, 'comfyui') }));
    const repo = new ProductionRepository(db);
    const p = repo.create(1, 'ComfyUI verification', null, '');
    const svc = new ComfyService({ db, runtime: rt, settings: () => ({ model: process.env.AIMO_E2E_COMFY_MODEL ?? 'epicrealismXL_pureFix.safetensors', maxConcurrent: 1, minFreeVramMb: 7000, unloadAfterJob: true, autoStart: true }), audit: (type, b, pr, data) => audits.push({ type, businessId: b, productionId: pr, data }) });
    try {
      const st = await rt.start();
      expect(st.state).toBe('running');
      const prodDir = path.join(out, 'productions', String(p.id));
      const r = await svc.generate({ businessId: 1, productionId: p.id, sceneIndex: 0, prompt: 'a data center with glowing GPU racks', outFile: path.join(prodDir, 'images', 'scene-01.png'), allowedDir: prodDir, verification: true, seed: 42, steps: 20 });
      console.log(JSON.stringify({ file: r.file, sha256: r.sha256, meta: r.meta, history: svc.history(1), status: await rt.status() }, null, 1));
      expect(fs.statSync(r.file).size).toBeGreaterThan(100_000);
      expect(svc.history(1)[0]).toMatchObject({ productionId: p.id, status: 'succeeded' });
      expect(svc.history(2)).toEqual([]);
    } finally {
      await rt.stop();
    }
    expect((await rt.status()).state).toBe('stopped');
  }, 900_000);
});
