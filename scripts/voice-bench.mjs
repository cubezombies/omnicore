// npm run voice:bench -- <label> <engine:voice>[,<engine:voice>...]
import { spawnSync } from 'node:child_process';
const [label = 'run', voices = 'sherpa:af_heart'] = process.argv.slice(2);
const r = spawnSync('npx', ['vitest', 'run', '-c', 'vitest.bench.config.ts', '--reporter=dot'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, VOICE_BENCH_LABEL: label, VOICE_BENCH_VOICES: voices }
});
process.exit(r.status ?? 1);
