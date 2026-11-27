import { defineConfig } from 'vitest/config';

// Voice benchmark only (slow, uses the installed engines): npm run voice:bench -- <label> <engine:voice,...>
export default defineConfig({
  test: { include: ['bench/**/*.bench.ts'], environment: 'node', testTimeout: 3_600_000 }
});
