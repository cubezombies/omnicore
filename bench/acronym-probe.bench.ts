import fs from 'node:fs';
import path from 'node:path';
import { it } from 'vitest';
import { PiperNarration } from '../src/main/providers/piper';
import { SapiNarration } from '../src/main/providers/narration';
import { SherpaWhisper } from '../src/main/qa/asr';
const DATA = process.env.AIMO_DATA_DIR ?? path.resolve('data');
const tools = path.join(DATA, 'tools');
const tmp = path.join(DATA, 'tmp', 'probe');
it('probe', { timeout: 1_800_000 }, async () => {
  fs.mkdirSync(tmp, { recursive: true });
  const asr = new SherpaWhisper(tools);
  const forms = (process.env.FORMS ?? '').split('|');
  const engines = {
    piper: new PiperNarration(path.join(tools, 'piper', 'piper.exe'), path.join(tools, 'piper', 'voices', 'en_US-john-medium.onnx'), tmp, 0, []),
    sapi: new SapiNarration(tmp, 'Microsoft Zira Desktop', 0, [])
  };
  for (const [name, n] of Object.entries(engines)) {
    for (const f of forms) {
      const wav = path.join(tmp, `${name}.wav`);
      await n.synthesize(`Today the ${f} handle thousands of tasks.`, wav, AbortSignal.timeout(60_000));
      console.log(`PROBE ${name} | ${f} | ${(await asr.transcribe(wav)).trim()}`);
    }
  }
});
