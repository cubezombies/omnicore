import type { Brief, ProviderStatus, Scene, Source, Storyboard } from '../../shared/production';
import { CancelledError } from '../media/ffmpeg';
import { USER_AGENT } from './http';
import { extractiveStoryboard, InvalidStoryboardError, validateGrounding, validateStoryboard } from './text';
import { ProviderUnavailableError, type Writer, type WriterResult } from './types';

/** No-AI writer: narrates the brief's sourced facts verbatim. Always available; the offline fallback. */
export class ExtractiveWriter implements Writer {
  id = 'extractive';
  label = 'Deterministic (no AI, verbatim sourced facts)';
  costPerUnitUsd = 0;
  async check(): Promise<ProviderStatus> {
    return { id: this.id, kind: 'writer', label: this.label, available: true, detail: 'Built in', costPerUnitUsd: 0 };
  }
  async write(input: { brief: Brief; sources: Source[]; channelName: string }): Promise<WriterResult> {
    return { storyboard: validateStoryboard(extractiveStoryboard(input.brief, input.channelName), input.sources), units: 0 };
  }
}

export class LlmTimeoutError extends Error {}

interface ModelEntry {
  id: string;
  status?: { value?: string };
  meta?: { n_ctx?: number };
}
interface ChatResp {
  choices?: { message?: { content?: string | null; reasoning_content?: string }; finish_reason?: string }[];
  usage?: { total_tokens?: number };
  error?: { message?: string } | string;
}

export interface LlmWriterOptions {
  baseUrl: string;
  /** Blank = discover from /models (prefers a model reporting status "loaded"). */
  model: string;
  timeoutMs: number;
  maxTokens?: number;
}

/** Pick the model to use from a /models listing without assuming an id. */
export function chooseModel(models: ModelEntry[], configured: string): string | null {
  if (configured) return models.some((m) => m.id === configured) ? configured : null;
  return (models.find((m) => m.status?.value === 'loaded') ?? models[0])?.id ?? null;
}

const SOURCE_CHARS = 2200;
/** Hard ceiling so a script fits a sub-60s short at typical TTS speeds (~2.2-2.6 words/s). */
export const MAX_SCRIPT_WORDS = 140;

export function lengthProblem(sb: Storyboard): string | null {
  const words = sb.scenes.reduce((n, s) => n + s.narration.split(/\s+/).filter(Boolean).length, 0);
  return words > MAX_SCRIPT_WORDS ? `The script is ${words} words; it must be at most ${MAX_SCRIPT_WORDS} so the video stays under 60 seconds. Shorten it.` : null;
}

export function buildMessages(input: { brief: Brief; sources: Source[]; channelName: string }): { role: string; content: string }[] {
  const sources = input.sources
    .map((s) => `[${s.id}] ${s.title} (${s.publisher})\n${s.excerpt.slice(0, SOURCE_CHARS)}`)
    .join('\n\n');
  const facts = input.brief.keyFacts.map((f) => `- [${f.sourceId}] ${f.text}`).join('\n');
  const system = [
    `You are the head writer of "${input.channelName}", a faceless short-form video channel about ${input.brief.audience.replace(/^Short-form viewers interested in /, '') || 'technology'}.`,
    'You write tight, original, high-retention scripts for 45-60 second vertical videos (TikTok, YouTube Shorts, Reels).',
    'Hard rules, never broken:',
    '1. Every factual statement must come from the SOURCES you are given. Do not use outside knowledge.',
    '2. Never introduce a number, date, name, product, company or acronym that is not written in the cited source.',
    '3. Each fact scene cites the ids of the sources it restates in "sourceIds".',
    '4. Write in your own words: conversational, concrete, second person is fine. No hype words, no clickbait lies.',
    'Respond with one JSON object only. No markdown.'
  ].join('\n');
  const user = `TOPIC: ${input.brief.topic}

SOURCES:
${sources}

STRONGEST FACTS (suggested, from the sources):
${facts}

Write the script as JSON:
{"title": string (max 60 chars, curiosity-driven, no claims beyond the sources),
 "scenes": [
  {"role": "hook", "narration": string, "onScreenText": string, "visualQuery": string, "sourceIds": []},
  {"role": "fact", "narration": string, "onScreenText": string, "visualQuery": string, "sourceIds": ["S1"]},
  ...
  {"role": "outro", "narration": string, "onScreenText": string, "visualQuery": string, "sourceIds": []}
 ]}

Structure:
- hook: 1 sentence, max 18 words. A question, contrast or surprising angle that makes people stay. It must not state facts that are not in the sources.
- 3 to 5 fact scenes, each 12-28 words, one idea per scene, building on the previous one. Restate the sources plainly; do not add new claims.
- outro: max 25 words. Tell viewers the sources are in the description and to follow ${input.channelName}; you may end with a question for the comments.
- Total narration 95-130 words (the video must stay under 60 seconds). Never exceed 140 words.
- onScreenText: max 5 punchy words. visualQuery: 2-4 concrete words describing a real image to search for.`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

/**
 * Writer backed by a local OpenAI-compatible server. Defaults target Strata
 * (http://127.0.0.1:8080/v1); LM Studio, Ollama or llama.cpp work the same way.
 */
export class OpenAICompatibleWriter implements Writer {
  id = 'openai-compatible';
  label = 'Strata / local LLM (OpenAI-compatible)';
  costPerUnitUsd = 0;
  private readonly o: Required<LlmWriterOptions>;

  constructor(o: LlmWriterOptions) {
    this.o = { maxTokens: 8000, ...o, baseUrl: o.baseUrl.replace(/\/+$/, '') };
  }

  /** fetch with a hard timeout that is distinguishable from user cancellation. */
  private async request(path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    if (signal?.aborted) throw new CancelledError();
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => ((timedOut = true), ctrl.abort()), timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await fetch(`${this.o.baseUrl}${path}`, { ...init, headers: { 'User-Agent': USER_AGENT, ...(init.headers ?? {}) }, signal: ctrl.signal });
    } catch (e) {
      if (signal?.aborted) throw new CancelledError();
      if (timedOut) throw new LlmTimeoutError(`The LLM at ${this.o.baseUrl} did not answer within ${Math.round(timeoutMs / 1000)}s.`);
      throw new ProviderUnavailableError(
        `No LLM server is answering at ${this.o.baseUrl} (${e instanceof Error ? e.message : String(e)}). Start Strata (or another OpenAI-compatible server), or switch the writer in Studio → Providers.`
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelEntry[]> {
    const res = await this.request('/models', {}, Math.min(this.o.timeoutMs, 8000), signal);
    if (!res.ok) throw new ProviderUnavailableError(`${this.o.baseUrl}/models answered HTTP ${res.status}.`);
    const body = (await res.json()) as { data?: ModelEntry[] };
    return Array.isArray(body.data) ? body.data : [];
  }

  async check(signal?: AbortSignal): Promise<ProviderStatus> {
    const base = { id: this.id, kind: 'writer' as const, label: this.label, costPerUnitUsd: 0 };
    try {
      const models = await this.listModels(signal);
      const ids = models.map((m) => m.id);
      const chosen = chooseModel(models, this.o.model);
      if (!models.length) return { ...base, available: false, detail: `The server at ${this.o.baseUrl} has no model loaded.`, options: [] };
      if (!chosen) return { ...base, available: false, detail: `Model "${this.o.model}" is not on the server (available: ${ids.join(', ')}).`, options: ids };
      const ctx = models.find((m) => m.id === chosen)?.meta?.n_ctx;
      return { ...base, available: true, detail: `${chosen}${ctx ? ` · ${ctx.toLocaleString()} ctx` : ''} at ${this.o.baseUrl}`, options: ids };
    } catch (e) {
      return { ...base, available: false, detail: e instanceof Error ? e.message : String(e), options: [] };
    }
  }

  private async chat(model: string, messages: { role: string; content: string }[], signal: AbortSignal): Promise<{ content: string; tokens: number }> {
    const send = (jsonMode: boolean) =>
      this.request(
        '/chat/completions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            temperature: 0.6,
            max_tokens: this.o.maxTokens,
            messages,
            ...(jsonMode ? { response_format: { type: 'json_object' } } : {})
          })
        },
        this.o.timeoutMs,
        signal
      );
    let res = await send(true);
    // Some servers reject response_format; retry once as plain chat.
    if (res.status === 400 || res.status === 422) res = await send(false);
    const body = (await res.json().catch(() => ({}))) as ChatResp;
    if (!res.ok) {
      const msg = typeof body.error === 'string' ? body.error : body.error?.message;
      throw new ProviderUnavailableError(`The LLM server answered HTTP ${res.status}${msg ? `: ${msg}` : ''}.`);
    }
    const choice = body.choices?.[0];
    const content = choice?.message?.content ?? '';
    if (!content.trim()) {
      const why = choice?.finish_reason === 'length' ? ' It ran out of tokens while reasoning.' : '';
      throw new InvalidStoryboardError(`The LLM returned an empty answer.${why}`);
    }
    return { content, tokens: body.usage?.total_tokens ?? 0 };
  }

  async write(input: { brief: Brief; sources: Source[]; channelName: string }, signal: AbortSignal): Promise<WriterResult> {
    const models = await this.listModels(signal);
    const model = chooseModel(models, this.o.model);
    if (!model) {
      throw new ProviderUnavailableError(
        models.length
          ? `Model "${this.o.model}" is not loaded at ${this.o.baseUrl} (available: ${models.map((m) => m.id).join(', ')}).`
          : `The LLM server at ${this.o.baseUrl} has no model loaded.`
      );
    }
    const messages = buildMessages(input);
    const grounding = { allowed: `${input.brief.topic} ${input.channelName}` };
    let tokens = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.chat(model, messages, signal);
      tokens += r.tokens;
      try {
        const sb = validateGrounding(parseLlmStoryboard(r.content, input.sources, `${this.id}:${model}`), input.sources, grounding);
        const tooLong = lengthProblem(sb);
        if (tooLong) throw new InvalidStoryboardError(tooLong);
        return { storyboard: sb, units: tokens };
      } catch (e) {
        if (!(e instanceof InvalidStoryboardError)) throw e;
        if (attempt === 1) throw new InvalidStoryboardError(`The script from ${model} failed validation after one repair attempt: ${e.message}`);
        // One repair round: tell the model exactly what was rejected.
        messages.push({ role: 'assistant', content: r.content });
        messages.push({
          role: 'user',
          content: `Your script was rejected:\n${e.message}\nRewrite the whole JSON so every statement is supported by the cited sources. Remove anything you cannot support. Same JSON format.`
        });
      }
    }
    throw new InvalidStoryboardError('unreachable');
  }
}

export function parseLlmStoryboard(content: string, sources: Source[], writer: string): Storyboard {
  const text = content.replace(/<think>[\s\S]*?<\/think>/g, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new InvalidStoryboardError('The LLM did not return JSON.');
  let raw: { title?: unknown; scenes?: unknown };
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new InvalidStoryboardError('The LLM returned malformed JSON.');
  }
  if (!Array.isArray(raw.scenes)) throw new InvalidStoryboardError('The LLM JSON has no "scenes" array.');
  const sb: Storyboard = {
    title: String(raw.title ?? '').trim().slice(0, 200),
    writer,
    scenes: raw.scenes.map((s: Record<string, unknown>, i): Scene => ({
      index: i,
      role: String(s?.role ?? '') as Scene['role'],
      narration: String(s?.narration ?? '').replace(/\s+/g, ' ').trim(),
      onScreenText: String(s?.onScreenText ?? '').slice(0, 60),
      visualQuery: String(s?.visualQuery ?? '').slice(0, 120),
      sourceIds: Array.isArray(s?.sourceIds) ? s.sourceIds.map(String) : []
    }))
  };
  return validateStoryboard(sb, sources);
}
