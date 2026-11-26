import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CancelledError } from '../src/main/media/ffmpeg';
import { buildBrief, groundingProblems, namedTermsIn } from '../src/main/providers/text';
import { ProviderUnavailableError } from '../src/main/providers/types';
import { chooseModel, LlmTimeoutError, OpenAICompatibleWriter, parseLlmStoryboard } from '../src/main/providers/writers';
import type { Storyboard } from '../src/shared/production';
import { SOURCES } from './fixtures';

const brief = buildBrief('large language models', SOURCES, 'AI and technology');
const input = { brief, sources: SOURCES, channelName: 'AI, Actually' };

const GOOD = {
  title: 'Why chatbots seem to understand you',
  scenes: [
    { role: 'hook', narration: 'Why does a chatbot seem to understand you?', onScreenText: 'How?', visualQuery: 'chatbot screen', sourceIds: [] },
    { role: 'fact', narration: 'A large language model is trained with self-supervised machine learning on a vast amount of text.', onScreenText: 'Trained on text', visualQuery: 'library books', sourceIds: ['S1'] },
    { role: 'fact', narration: 'Under the hood, most are built on the transformer, an architecture based on multi-head attention.', onScreenText: 'Transformers', visualQuery: 'neural network diagram', sourceIds: ['S2'] },
    { role: 'fact', narration: 'Text is split into tokens, and each token becomes a vector.', onScreenText: 'Tokens → vectors', visualQuery: 'vector diagram', sourceIds: ['S2'] },
    { role: 'outro', narration: 'Sources are in the description. Follow AI, Actually for more.', onScreenText: 'Follow', visualQuery: 'smartphone', sourceIds: [] }
  ]
};
const withScene = (i: number, patch: Record<string, unknown>) => ({ ...GOOD, scenes: GOOD.scenes.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

/** Shape captured from the real Strata server (content + separate reasoning_content + timings). */
const strataResponse = (content: string, finish = 'stop') => ({
  id: 'chatcmpl-test',
  object: 'chat.completion',
  model: 'qwen3.8-flash-next-iq2_xs',
  choices: [{ index: 0, message: { role: 'assistant', content, reasoning_content: 'We need answer user... Ensure valid JSON only.' }, finish_reason: finish }],
  usage: { prompt_tokens: 900, completion_tokens: 700, total_tokens: 1600 },
  timings: { predicted_per_second: 47.1 }
});
const MODELS = { object: 'list', data: [{ id: 'other-model', status: { value: 'unloaded' } }, { id: 'qwen3.8-flash-next-iq2_xs', object: 'model', status: { value: 'loaded' }, meta: { n_ctx: 131072 } }] };

interface Mock {
  url: string;
  requests: { path: string; body: Record<string, unknown> }[];
  close: () => Promise<void>;
}
let mock: Mock | null = null;

/** Minimal OpenAI-compatible server; `chat` returns [status, body] per call or delays forever. */
async function startMock(chat: (n: number, body: Record<string, unknown>) => [number, unknown] | 'hang', models: unknown = MODELS): Promise<Mock> {
  const requests: Mock['requests'] = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ path: req.url ?? '', body });
      const send = (status: number, b: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(b));
      };
      if (req.url === '/v1/models') return send(200, models);
      if (req.url === '/v1/chat/completions') {
        const r = chat(n++, body);
        if (r === 'hang') return;
        return send(r[0], r[1]);
      }
      send(404, { error: 'not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r())))
  };
}
afterEach(async () => {
  await mock?.close();
  mock = null;
});
const writer = (url: string, o: Partial<{ model: string; timeoutMs: number }> = {}) =>
  new OpenAICompatibleWriter({ baseUrl: url, model: o.model ?? '', timeoutMs: o.timeoutMs ?? 10000 });
const signal = () => new AbortController().signal;

describe('grounding validation', () => {
  const sb = (patch: Record<string, unknown>, i = 2): Storyboard => parseLlmStoryboard(JSON.stringify(withScene(i, patch)), SOURCES, 't');
  const ctx = { allowed: 'large language models AI, Actually' };

  it('accepts a paraphrased script that stays within its cited sources', () => {
    expect(groundingProblems(parseLlmStoryboard(JSON.stringify(GOOD), SOURCES, 't'), SOURCES, ctx)).toEqual([]);
  });
  it('rejects numbers that are not in the cited source', () => {
    expect(groundingProblems(sb({ narration: 'In 2017 the transformer, based on multi-head attention, changed everything.' }), SOURCES, ctx).join(' ')).toMatch(
      /states the number "2017", which is not in its cited source S2/
    );
  });
  it('rejects names and acronyms that are not in the cited source', () => {
    const p = groundingProblems(sb({ narration: 'Researchers at Google built the transformer on multi-head attention, says OpenAI.' }), SOURCES, ctx).join(' ');
    expect(p).toContain('"Google"');
    expect(p).toContain('"OpenAI"');
  });
  it('checks a fact against the source it cites, not any source', () => {
    // "self-supervised" is in S1 but the scene cites S2.
    const p = groundingProblems(sb({ narration: 'The transformer learns with self-supervised machine learning on a vast amount of text.' }), SOURCES, ctx);
    expect(p.join(' ')).toMatch(/mostly not supported by its cited source S2/);
  });
  it('rejects facts in the hook that no source contains', () => {
    const p = groundingProblems(sb({ narration: 'Elon Musk says 90% of jobs will vanish. Why?' }, 0), SOURCES, ctx).join(' ');
    expect(p).toMatch(/Scene 1 \(hook\) states the number "90%"/);
    expect(p).toMatch(/"Musk"/);
  });
  it('detects named terms but not sentence-initial capitals', () => {
    expect(namedTermsIn('Under the hood, GPT runs on Nvidia chips. Then it ends.')).toEqual(['GPT', 'Nvidia']);
  });
});

describe('Strata / OpenAI-compatible writer', () => {
  it('discovers the loaded model instead of assuming an id', async () => {
    expect(chooseModel(MODELS.data, '')).toBe('qwen3.8-flash-next-iq2_xs');
    expect(chooseModel(MODELS.data, 'other-model')).toBe('other-model');
    expect(chooseModel(MODELS.data, 'missing')).toBeNull();
    mock = await startMock(() => [200, strataResponse(JSON.stringify(GOOD))]);
    const r = await writer(mock.url).write(input, signal());
    expect(mock.requests.find((q) => q.path.endsWith('/chat/completions'))!.body.model).toBe('qwen3.8-flash-next-iq2_xs');
    expect(r.storyboard.writer).toBe('openai-compatible:qwen3.8-flash-next-iq2_xs');
    expect(r.storyboard.scenes.map((s) => s.role)).toEqual(['hook', 'fact', 'fact', 'fact', 'outro']);
    expect(r.units).toBe(1600);
  });

  it('parses real Strata responses (JSON content, reasoning kept separate, think tags stripped)', async () => {
    mock = await startMock(() => [200, strataResponse(`<think>plan</think>\n\`\`\`json\n${JSON.stringify(GOOD)}\n\`\`\``)]);
    const r = await writer(mock.url).write(input, signal());
    expect(r.storyboard.title).toBe(GOOD.title);
  });

  it('runs one repair round with the exact validation errors, then accepts a fixed script', async () => {
    const bad = withScene(2, { narration: 'Google invented the transformer in 2017, based on multi-head attention.' });
    mock = await startMock((n) => [200, strataResponse(JSON.stringify(n === 0 ? bad : GOOD))]);
    const r = await writer(mock.url).write(input, signal());
    expect(r.storyboard.scenes[2].narration).toBe(GOOD.scenes[2].narration);
    const chats = mock.requests.filter((q) => q.path.endsWith('/chat/completions'));
    expect(chats).toHaveLength(2);
    const repair = (chats[1].body.messages as { content: string }[]).at(-1)!.content;
    expect(repair).toContain('"2017"');
    expect(repair).toContain('"Google"');
    expect(r.units).toBe(3200);
  });

  it('rejects scripts that stay ungrounded after the repair round', async () => {
    const bad = withScene(1, { narration: 'OpenAI trained GPT-4 on 13 trillion tokens.', sourceIds: ['S1'] });
    mock = await startMock(() => [200, strataResponse(JSON.stringify(bad))]);
    await expect(writer(mock.url).write(input, signal())).rejects.toThrow(/failed validation after one repair attempt: .*"13"/);
  });

  it('sends over-long scripts back for shortening', async () => {
    const fact = { ...GOOD.scenes[1], narration: `${GOOD.scenes[1].narration} ${GOOD.scenes[1].narration}` };
    const long = { ...GOOD, scenes: [GOOD.scenes[0], ...Array(8).fill(fact), GOOD.scenes[4]] };
    mock = await startMock((n) => [200, strataResponse(JSON.stringify(n === 0 ? long : GOOD))]);
    await writer(mock.url).write(input, signal());
    const chats = mock.requests.filter((q) => q.path.endsWith('/chat/completions'));
    expect((chats[1].body.messages as { content: string }[]).at(-1)!.content).toMatch(/must be at most 140/);
  });

  it('rejects uncited facts and malformed output', async () => {
    mock = await startMock((n) => [200, strataResponse(n % 2 === 0 ? '{"title": "x", "scenes": [' : JSON.stringify(withScene(1, { sourceIds: [] })))]);
    await expect(writer(mock.url).write(input, signal())).rejects.toThrow(/citing a known source/);
  });

  it('reports empty answers caused by running out of tokens while reasoning', async () => {
    mock = await startMock(() => [200, strataResponse('', 'length')]);
    await expect(writer(mock.url).write(input, signal())).rejects.toThrow(/empty answer\. It ran out of tokens while reasoning/);
  });

  it('retries without response_format when the server rejects it', async () => {
    mock = await startMock((_n, body) => (body.response_format ? [400, { error: { message: 'response_format not supported' } }] : [200, strataResponse(JSON.stringify(GOOD))]));
    await writer(mock.url).write(input, signal());
    const chats = mock.requests.filter((q) => q.path.endsWith('/chat/completions'));
    expect(chats.map((c) => 'response_format' in c.body)).toEqual([true, false]);
  });

  it('times out with a clear error', async () => {
    mock = await startMock(() => 'hang');
    await expect(writer(mock.url, { timeoutMs: 300 }).write(input, signal())).rejects.toThrow(LlmTimeoutError);
    await expect(writer(mock.url, { timeoutMs: 300 }).write(input, signal())).rejects.toThrow(/did not answer within 0s|did not answer within/);
  });

  it('cancels promptly', async () => {
    mock = await startMock(() => 'hang');
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    await expect(writer(mock.url, { timeoutMs: 30000 }).write(input, ctrl.signal)).rejects.toThrow(CancelledError);
  });

  it('explains unavailable servers, missing models and server errors', async () => {
    await expect(writer('http://127.0.0.1:9/v1').write(input, signal())).rejects.toThrow(ProviderUnavailableError);
    await expect(writer('http://127.0.0.1:9/v1').write(input, signal())).rejects.toThrow(/Start Strata/);
    mock = await startMock(() => [500, { error: 'CUDA out of memory' }]);
    await expect(writer(mock.url, { model: 'nope' }).write(input, signal())).rejects.toThrow(/Model "nope" is not loaded.*qwen3\.8-flash-next-iq2_xs/);
    await expect(writer(mock.url).write(input, signal())).rejects.toThrow(/HTTP 500: CUDA out of memory/);
  });

  it('health check reports model, context size and failures', async () => {
    mock = await startMock(() => [200, {}]);
    const ok = await writer(mock.url).check();
    expect(ok).toMatchObject({ available: true, options: ['other-model', 'qwen3.8-flash-next-iq2_xs'] });
    expect(ok.detail).toMatch(/qwen3\.8-flash-next-iq2_xs · 131,072 ctx/);
    expect((await writer(mock.url, { model: 'nope' }).check()).available).toBe(false);
    expect((await writer('http://127.0.0.1:9/v1').check()).detail).toMatch(/No LLM server is answering/);
  });
});
