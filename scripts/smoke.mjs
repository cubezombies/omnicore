// Launches the built app in smoke mode against a throwaway data dir and checks
// that the window loads, the renderer is sandboxed and the DB answers over IPC.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import electron from 'electron';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = (fs.mkdirSync(path.join(root, '.tmp'), { recursive: true }), fs.mkdtempSync(path.join(root, '.tmp', 'aimo-smoke-')));
const res = spawnSync(electron, [root], {
  env: Object.fromEntries(
    Object.entries({ ...process.env, AIMO_SMOKE: '1', AIMO_DATA_DIR: dataDir }).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE')
  ),
  encoding: 'utf8',
  timeout: 60000
});
process.stdout.write(res.stdout ?? '');
process.stderr.write(res.stderr ?? '');
const dbExists = fs.existsSync(path.join(dataDir, 'ai-media-operations.db'));
fs.rmSync(dataDir, { recursive: true, force: true });
if (res.status !== 0 || !/SMOKE OK/.test(res.stdout ?? '') || !dbExists) {
  console.error(`smoke failed (exit ${res.status}, db created: ${dbExists})`);
  process.exit(1);
}
console.log('smoke passed');
