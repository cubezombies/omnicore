// Keep test temp files inside the project (this machine's OS temp dir is on C:).
import fs from 'node:fs';
import path from 'node:path';
const dir = path.resolve(__dirname, '../.tmp');
fs.mkdirSync(dir, { recursive: true });
process.env.TMP = process.env.TEMP = process.env.TMPDIR = dir;
