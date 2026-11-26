// Real end-to-end production with the default free providers (Wikipedia, Windows
// speech, Wikimedia Commons, title cards, bundled FFmpeg). Needs internet + Windows.
// Run: AIMO_E2E=1 npx vitest run tests/e2e.test.ts   (output kept in .tmp/e2e)
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../src/main/db/database';
import { ProductionRepository } from '../src/main/db/productions';
import { probe, resolveFfmpeg } from '../src/main/media/ffmpeg';
import { ProductionRunner } from '../src/main/pipeline/runner';
import { SoundLibrary } from '../src/main/library';
import { installPiper } from '../src/main/providers/piper';
import { buildProviders } from '../src/main/providers/registry';

const run = process.env.AIMO_E2E === '1' ? describe : describe.skip;

run('end-to-end (real providers)', () => {
  it('produces a playable 1080x1920 MP4 from a topic', async () => {
    const root = path.resolve(__dirname, '../.tmp/e2e');
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    const db = openDatabase(path.join(root, 'e2e.db'));
    const repo = new ProductionRepository(db);
    // Optional: AIMO_E2E_NARRATION=piper (needs Piper in AIMO_TOOLS_DIR), AIMO_E2E_MUSIC=auto, AIMO_E2E_SFX=1
    const settings = {
      ...repo.getSettings(),
      ...(process.env.AIMO_E2E_NARRATION === 'piper' ? { narration: 'piper' as const } : process.env.AIMO_E2E_NARRATION === 'sapi' ? { narration: 'windows-sapi' as const } : {}),
      ...(process.env.AIMO_E2E_MUSIC === 'auto' ? { musicMode: 'auto' as const } : {}),
      ...(process.env.AIMO_E2E_SFX === '1' ? { sfxTransitions: true } : {})
    };
    const dirs = { tmpDir: path.join(root, 'tmp'), toolsDir: process.env.AIMO_TOOLS_DIR || path.join(root, 'tools') };
    if (settings.narration === 'piper') {
      await installPiper(dirs.toolsDir, 'en_US-john-medium', AbortSignal.timeout(15 * 60_000), (m) => console.log(m));
    }
    const library = new SoundLibrary(db, path.join(root, 'library'), () => resolveFfmpeg(''));
    const runner = new ProductionRunner({
      repo,
      productionsDir: path.join(root, 'productions'),
      settings: () => settings,
      providers: (s) => buildProviders(s, dirs),
      library,
      ffmpeg: (s) => resolveFfmpeg(s.ffmpegPath),
      channel: () => ({ name: 'AI, Actually', niche: 'AI and technology' }),
      emit: () => {}
    });
    const topic = process.env.AIMO_E2E_TOPIC || 'large language models';
    const p = repo.create(1, topic, null, '', process.env.AIMO_E2E_MODE === 'news' ? 'news' : 'explainer');
    runner.enqueue(p.id);
    await runner.idle();
    const r = repo.get(p.id);
    console.log(JSON.stringify({ status: r.status, error: r.error, out: r.outputPath, steps: r.steps.map((s) => `${s.step}: ${s.detail}`) }, null, 1));
    console.log(`WRITER ${r.storyboard?.writer} ${r.storyboard?.fallbackReason ?? ''}`);
    for (const sc of r.storyboard?.scenes ?? []) console.log(`SCENE ${sc.index + 1} [${sc.role}] {${sc.sourceIds.join(',')}} ${sc.narration} | on-screen: ${sc.onScreenText} | visual: ${sc.visualQuery}`);
    expect(r.error).toBeNull();
    if (process.env.AIMO_E2E_REQUIRE_LLM === '1') {
      expect(r.storyboard!.writer).toMatch(/^openai-compatible:/);
      expect(r.storyboard!.fallbackReason).toBeUndefined();
    }
    const info = await probe(resolveFfmpeg(''), r.outputPath!);
    expect(info.video).toMatchObject({ width: 1080, height: 1920, codec: 'h264' });
    expect(info.audio?.codec).toBe('aac');
    db.close();
  }, 600_000);
});
