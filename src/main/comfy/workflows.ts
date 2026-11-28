import crypto from 'node:crypto';

/**
 * Approved ComfyUI workflows. Only these graphs are ever submitted: the renderer can choose a workflow by id and supply
 * a prompt, but it cannot send a graph, a node type, a path or an arbitrary parameter. Every input is validated here.
 */
export interface WorkflowParams {
  prompt: string;
  model: string;
  seed: number;
  steps?: number;
  /** Output prefix inside ComfyUI's output folder (built by the service from numeric ids only). */
  prefix: string;
}

export interface ApprovedWorkflow {
  id: string;
  label: string;
  /** Free GPU memory required before the job is sent (MB). */
  minFreeVramMb: number;
  width: number;
  height: number;
  defaultSteps: number;
  negative: string;
  build(p: Required<Omit<WorkflowParams, 'steps'>> & { steps: number }): Record<string, unknown>;
}

/** Generated visuals are illustrations, never presented as photos or evidence: the style and negatives say so. */
const STYLE = 'stylized digital editorial illustration, conceptual, clean shapes, soft lighting, vertical composition';
const NEGATIVE = 'photograph, photo, photorealistic, real person, celebrity, face close-up, logo, brand, text, letters, watermark, signature, news footage, screenshot, lowres, blurry, deformed';

export const WORKFLOWS: Record<string, ApprovedWorkflow> = {
  'sdxl-illustration': {
    id: 'sdxl-illustration',
    label: 'SDXL illustration (portrait 832×1472)',
    minFreeVramMb: 7000,
    width: 832,
    height: 1472,
    defaultSteps: 24,
    negative: NEGATIVE,
    build: (p) => ({
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: p.model } },
      '5': { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1472, batch_size: 1 } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: `${p.prompt}, ${STYLE}`, clip: ['4', 1] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: NEGATIVE, clip: ['4', 1] } },
      '3': { class_type: 'KSampler', inputs: { seed: p.seed, steps: p.steps, cfg: 6, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
      '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
      '9': { class_type: 'SaveImage', inputs: { filename_prefix: p.prefix, images: ['8', 0] } }
    })
  }
};

/** Identity of a workflow template (independent of the prompt and seed), recorded with every generation. */
export function workflowSha256(id: string): string {
  const w = WORKFLOWS[id];
  const graph = w.build({ prompt: '{prompt}', model: '{model}', seed: 0, steps: w.defaultSteps, prefix: '{prefix}' });
  return crypto.createHash('sha256').update(JSON.stringify({ id, graph })).digest('hex');
}

/** Clean, bounded prompt text (no control characters, no path or graph syntax). */
export function cleanPrompt(text: string): string {
  const t = text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[{}[\]<>\\`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
  if (t.length < 3) throw new Error('The image prompt is empty.');
  return t;
}

/** A model file name as ComfyUI lists it: a plain file name with a model extension, nothing else. */
export function cleanModelName(name: string): string {
  if (!/^[\w.\- ()]+\.(safetensors|ckpt)$/i.test(name) || name.includes('..')) throw new Error(`"${name}" is not a valid model file name.`);
  return name;
}

export function buildWorkflow(id: string, p: WorkflowParams): { graph: Record<string, unknown>; workflow: ApprovedWorkflow; steps: number } {
  const w = WORKFLOWS[id];
  if (!w) throw new Error(`Unknown workflow "${id}". Only approved workflows can be used.`);
  if (!/^omnicore\/b\d+\/p\d+\/s\d+$/.test(p.prefix) && !/^omnicore\/test\/t\d+$/.test(p.prefix)) throw new Error('Invalid output prefix.');
  if (!Number.isInteger(p.seed) || p.seed < 0 || p.seed > 2 ** 31 - 1) throw new Error('Invalid seed.');
  const steps = Math.round(p.steps ?? w.defaultSteps);
  if (steps < 10 || steps > 40) throw new Error('Steps must be between 10 and 40.');
  return { graph: w.build({ prompt: cleanPrompt(p.prompt), model: cleanModelName(p.model), seed: p.seed, steps, prefix: p.prefix }), workflow: w, steps };
}
