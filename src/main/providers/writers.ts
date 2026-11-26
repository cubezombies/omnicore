import type { Brief, ProviderStatus, Scene, Source, Storyboard } from '../../shared/production';
import { fetchJson, fetchRetry } from './http';
import { extractiveStoryboard, InvalidStoryboardError, validateStoryboard } from './text';
import { ProviderUnavailableError, type Writer, type WriterResult } from './types';

/** No-AI writer: narrates the brief's sourced facts verbatim. Always available. */
export class ExtractiveWriter implements Writer {
  id = 'extractive';
  label = 'Extractive (no AI, verbatim sourced facts)';
  costPerUnitUsd = 0;
  async check(): Promise<ProviderStatus> {
    return { id: this.id, kind: 'writer', label: this.label, available: true, detail: 'Built in', costPerUnitUsd: 0 };
  }
  async write(input: { brief: Brief; sources: Source[]; channelName: string }): Promise<WriterResult> {
    return { storyboard: validateStoryboard(extractiveStoryboard(input.brief, input.channelName), input.sources), units: 0 };
  }
}

interface ChatResp {
  choices?: { message?: { content?: string } }[];
  usage?: { total_tokens?: number };
}

/**
 * Any OpenAI-compatible chat endpoint you run locally (LM Studio, Ollama,
 * llama.cpp server…). Base URL and model come from settings.
 */
export class OpenAICompatibleWriter implements Writer {
  id = 'openai-compatible';
  label = 'Local LLM (OpenAI-compatible)';
  costPerUnitUsd = 0;
  constructor(private readonly baseUrl: string, private readonly model: string) {}

  private url(path: string) {
    return `${this.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  async models(signal?: AbortSignal): Promise<string[]> {
    const r = await fetchJson<{ data?: { id: string }[] }>(this.url('/models'), { signal, timeoutMs: 4000, retries: 0 });
    return (r.data ?? []).map((m) => m.id);
  }

  async check(signal?: AbortSignal): Promise<ProviderStatus> {
    const base = { id: this.id, kind: 'writer' as const, label: this.label, costPerUnitUsd: 0 };
    try {
      const models = await this.models(signal);
      if (!models.length) return { ...base, available: false, detail: `Server at ${this.baseUrl} has no model loaded.`, options: [] };
      const ok = !this.model || models.includes(this.model);
      return {
        ...base,
        available: ok,
        detail: ok ? `Using ${this.model || models[0]}` : `Model "${this.model}" is not loaded on the server.`,
        options: models
      };
    } catch {
      return { ...base, available: false, detail: `No server at ${this.baseUrl}. Start LM Studio's or Ollama's local server.`, options: [] };
    }
  }

  async write(input: { brief: Brief; sources: Source[]; channelName: string }, signal: AbortSignal): Promise<WriterResult> {
    let model = this.model;
    try {
      if (!model) model = (await this.models(signal))[0] ?? '';
    } catch {
      throw new ProviderUnavailableError(`No local LLM server at ${this.baseUrl}. Start it, or switch the writer to "Extractive" in Studio → Providers.`);
    }
    if (!model) throw new ProviderUnavailableError(`The LLM server at ${this.baseUrl} has no model loaded.`);
    const facts = input.brief.keyFacts.map((f) => `[${f.sourceId}] ${f.text}`).join('\n');
    const system =
      'You write scripts for 45-60 second vertical explainer videos. Use ONLY the facts provided; never add numbers, names, dates or claims that are not in them. Respond with JSON only.';
    const user = `Channel: ${input.channelName}
Topic: ${input.brief.topic}
Facts (with source ids):
${facts}

Return JSON: {"title": string, "scenes": [{"role": "hook"|"fact"|"outro", "narration": string, "onScreenText": string (max 5 words), "visualQuery": string (3-6 words describing an image), "sourceIds": string[]}]}
Rules: first scene role "hook" (no factual claims), then 2-6 "fact" scenes each restating one or two provided facts in plain spoken English and citing their source ids, last scene "outro" telling viewers sources are in the description and to follow ${input.channelName}. Each narration under 40 words.`;
    const res = await fetchRetry(this.url('/chat/completions'), {
      signal,
      timeoutMs: 180000,
      retries: 1,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, temperature: 0.3, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
      }
    });
    const body = (await res.json()) as ChatResp;
    const content = body.choices?.[0]?.message?.content ?? '';
    return { storyboard: parseLlmStoryboard(content, input.sources, `openai-compatible:${model}`), units: body.usage?.total_tokens ?? 0 };
  }
}

export function parseLlmStoryboard(content: string, sources: Source[], writer: string): Storyboard {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) throw new InvalidStoryboardError('The LLM did not return JSON. Retry, or use the Extractive writer.');
  let raw: { title?: unknown; scenes?: unknown };
  try {
    raw = JSON.parse(content.slice(start, end + 1));
  } catch {
    throw new InvalidStoryboardError('The LLM returned malformed JSON. Retry, or use the Extractive writer.');
  }
  const scenes = Array.isArray(raw.scenes) ? raw.scenes : [];
  const sb: Storyboard = {
    title: String(raw.title ?? '').slice(0, 200),
    writer,
    scenes: scenes.map((s: Record<string, unknown>, i): Scene => ({
      index: i,
      role: s.role as Scene['role'],
      narration: String(s.narration ?? '').trim(),
      onScreenText: String(s.onScreenText ?? '').slice(0, 60),
      visualQuery: String(s.visualQuery ?? '').slice(0, 120),
      sourceIds: Array.isArray(s.sourceIds) ? s.sourceIds.map(String) : []
    }))
  };
  return validateStoryboard(sb, sources);
}
