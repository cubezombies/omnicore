import fs from 'node:fs';
import { CancelledError } from '../media/ffmpeg';

// Generic client name only: no user/project details leave the machine.
export const USER_AGENT = 'Omnicore/0.2 (desktop video production tool)';

export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface FetchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
  init?: RequestInit;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new CancelledError())), { once: true });
  });

/** fetch with timeout, cancellation and retries for network errors, 429 and 5xx. */
export async function fetchRetry(url: string, o: FetchOptions = {}): Promise<Response> {
  const retries = o.retries ?? 2;
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (o.signal?.aborted) throw new CancelledError();
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 20000);
    try {
      const res = await fetch(url, {
        ...o.init,
        headers: { 'User-Agent': USER_AGENT, ...(o.init?.headers ?? {}) },
        signal: ctrl.signal
      });
      if (res.ok) return res;
      last = new HttpError(`${new URL(url).host} answered HTTP ${res.status}`, res.status);
      if (res.status !== 429 && res.status < 500) throw last;
    } catch (e) {
      if (o.signal?.aborted) throw new CancelledError();
      if (e instanceof HttpError && e.status !== 429 && e.status < 500) throw e;
      last = e instanceof HttpError ? e : new Error(`Could not reach ${new URL(url).host}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
    }
    if (attempt < retries) await sleep(600 * 2 ** attempt, o.signal);
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Decode a response body honouring the declared charset (header or XML/HTML prolog); falls back to Windows-1252 for mislabelled feeds. */
export async function readText(res: Response): Promise<string> {
  const buf = Buffer.from(await res.arrayBuffer());
  const declared = /charset=["']?([\w-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1] ?? /<\?xml[^>]*encoding=["']([\w-]+)/i.exec(buf.subarray(0, 300).toString('latin1'))?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4000).toString('latin1'))?.[1];
  const tryDecode = (enc: string) => {
    try {
      return new TextDecoder(enc.toLowerCase(), { fatal: false }).decode(buf);
    } catch {
      return null;
    }
  };
  let text = (declared && tryDecode(declared)) || tryDecode('utf-8')!;
  if ((text.match(/\uFFFD/g)?.length ?? 0) > 2) text = tryDecode('windows-1252') ?? text;
  return text;
}

export async function fetchJson<T>(url: string, o: FetchOptions = {}): Promise<T> {
  const res = await fetchRetry(url, o);
  return (await res.json()) as T;
}

export async function downloadTo(url: string, file: string, o: FetchOptions = {}): Promise<void> {
  const res = await fetchRetry(url, { timeoutMs: 60000, ...o });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error(`Download from ${new URL(url).host} was empty or truncated.`);
  fs.writeFileSync(file, buf);
}
