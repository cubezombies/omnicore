import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Tokens as stored (encrypted) per account. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** ISO time the access token expires. */
  expiresAt: string;
  refreshExpiresAt: string | null;
  scopes: string[];
  /** Platform user id (TikTok open_id, Instagram user id). */
  userId?: string;
}

/** Encrypts secrets with the OS key store (Electron safeStorage → Windows DPAPI). Injected so tests can use a fake. */
export interface SecretBox {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Uint8Array): string;
}

export const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** PKCE pair. TikTok's desktop flow wants the SHA-256 challenge hex-encoded; RFC 7636 (Google) wants base64url. */
export function pkce(encoding: 'hex' | 'base64url'): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48));
  const digest = createHash('sha256').update(verifier).digest();
  return { verifier, challenge: encoding === 'hex' ? digest.toString('hex') : b64url(digest) };
}

export class OAuthError extends Error {}

/**
 * Run an authorization-code flow through a loopback redirect (http://127.0.0.1:<port>/callback).
 * Opens the platform's own sign-in page in the user's browser; Omnicore never sees the password.
 */
export async function loopbackAuthorize(o: {
  port: number;
  buildAuthUrl: (redirectUri: string, state: string) => string;
  open: (url: string) => Promise<void> | void;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ code: string; redirectUri: string }> {
  const state = b64url(randomBytes(18));
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => reject(new OAuthError(e.code === 'EADDRINUSE' ? `Port ${o.port} is in use; close the other program or change the redirect port.` : e.message)));
    server.listen(o.port, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new OAuthError('Sign-in timed out.')), o.timeoutMs ?? 5 * 60_000);
      o.signal?.addEventListener('abort', () => (clearTimeout(timer), reject(new OAuthError('Sign-in cancelled.'))), { once: true });
      server.on('request', (req, res) => {
        const u = new URL(req.url ?? '/', redirectUri);
        if (u.pathname !== '/callback') return void res.writeHead(404).end();
        const err = u.searchParams.get('error');
        const ok = !err && u.searchParams.get('state') === state && u.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
          `<!doctype html><meta charset="utf-8"><title>Omnicore</title><body style="font:16px system-ui;background:#111;color:#eee;padding:3em">${ok ? 'Signed in. You can close this tab and return to Omnicore.' : 'Sign-in failed. Return to Omnicore and try again.'}</body>`
        );
        clearTimeout(timer);
        if (err) reject(new OAuthError(`${err}: ${u.searchParams.get('error_description') ?? ''}`.trim()));
        else if (u.searchParams.get('state') !== state) reject(new OAuthError('Sign-in response did not match this request (state mismatch).'));
        else resolve({ code: u.searchParams.get('code')!, redirectUri });
      });
      void Promise.resolve(o.open(o.buildAuthUrl(redirectUri, state))).catch(reject);
    });
  } finally {
    server.close();
  }
}

export const inSeconds = (s: number | undefined, fallback = 3600) => new Date(Date.now() + (Number(s) || fallback) * 1000).toISOString();
