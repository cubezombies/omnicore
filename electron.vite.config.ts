import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Strict CSP for packaged builds; dev needs inline scripts + websocket for React Fast Refresh / HMR.
const CSP_PROD =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: omnicore-media:; font-src 'self'; " +
  "connect-src 'self'; media-src 'self' omnicore-media:; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'";
const CSP_DEV =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: omnicore-media:; media-src 'self' omnicore-media:; " +
  "connect-src 'self' ws://localhost:*; object-src 'none'";

function csp(): Plugin {
  let dev = false;
  return {
    name: 'aimo-csp',
    configResolved(c) {
      dev = c.command === 'serve';
    },
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: dev ? CSP_DEV : CSP_PROD }, injectTo: 'head-prepend' }
    ]
  };
}

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react(), csp()]
  }
});
