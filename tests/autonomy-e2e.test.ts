// Real autonomous end-to-end: live discovery → editorial selection → research → Strata script →
// Kokoro Heart narration → visuals → render → independent QA (incl. speech-to-text) → audit →
// destination assignment, ending at "awaiting your review". Nothing is published.
// Needs internet, Strata at 127.0.0.1:8080, and Kokoro + Whisper in AIMO_TOOLS_DIR.
// Run: AIMO_E2E_AUTONOMY=1 AIMO_TOOLS_DIR=<tools> npx vitest run tests/autonomy-e2e.test.ts   (output kept in .tmp/autonomy-e2e)
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../src/main/db/database';
import { ProductionRepository } from '../src/main/db/productions';
import { OperationsRepository } from '../src/main/db/operations';
import { AuditLedger } from '../src/main/audit/ledger';
import { OperatingEngine } from '../src/main/autonomy/engine';
import { defaultDiscoverySources, discover } from '../src/main/autonomy/discovery';
import { probe, resolveFfmpeg } from '../src/main/media/ffmpeg';
import { ProductionRunner } from '../src/main/pipeline/runner';
import { SoundLibrary } from '../src/main/library';
import { SherpaWhisper } from '../src/main/qa/asr';
import { buildProviders } from '../src/main/providers/registry';

const run = process.env.AIMO_E2E_AUTONOMY === '1' ? describe : describe.skip;

run('autonomous operation (real providers)', () => {
  it('discovers an opportunity and takes it to QA-passed, audited, destination-assigned content awaiting review', async () => {
    const root = path.resolve(__dirname, '../.tmp/autonomy-e2e');
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    const dbPath = path.join(root, 'omnicore.db');
    const toolsDir = process.env.AIMO_TOOLS_DIR!;
    const build = () => {
      const db = openDatabase(dbPath);
      const productions = new ProductionRepository(db);
      const ops = new OperationsRepository(db);
      const audit = new AuditLedger(db, path.join(root, 'evidence'));
      const dirs = { tmpDir: path.join(root, 'tmp'), toolsDir };
      // Global narration deliberately set to something else: the brand presenter (Kokoro Heart) must win.
      productions.saveSettings({ ...productions.getSettings(), narration: 'windows-sapi', musicMode: 'auto', llmModel: process.env.AIMO_LLM_MODEL ?? '' });
      const runner = new ProductionRunner({
        ops, audit, asr: new SherpaWhisper(toolsDir), repo: productions,
        productionsDir: path.join(root, 'productions'),
        settings: () => productions.getSettings(),
        providers: (s) => buildProviders(s, dirs),
        library: new SoundLibrary(db, path.join(root, 'library'), () => resolveFfmpeg('')),
        ffmpeg: (s) => resolveFfmpeg(s.ffmpegPath),
        channel: () => ({ name: 'AI, Actually', niche: 'AI and technology' }),
        emit: () => {}
      });
      const engine = new OperatingEngine({ ops, productions, runner, audit, tickMs: 3600_000, discover: (_b, k, r, s) => discover(defaultDiscoverySources(), k, r, s) });
      return { db, productions, ops, audit, runner, engine };
    };

    // Session 1: the engine runs on its own.
    let s = build();
    s.ops.saveAutonomy({ ...s.ops.getAutonomy(), enabled: true, activeFromHour: 0, activeToHour: 24, maxProductionsPerDay: 1 });
    const t0 = Date.now();
    s.engine.start();
    await s.engine.tick();
    const ideas = s.ops.listIdeas(1);
    console.log(`DISCOVERY ${s.ops.lastRun('discovery:1')?.detail}`);
    for (const i of ideas.slice(0, 6)) console.log(`IDEA ${i.score} [${i.status}] ${i.topic} — ${i.headline}`);
    const selected = ideas.find((i) => i.status === 'selected');
    expect(selected, 'engine selected an idea').toBeTruthy();
    await s.runner.idle();
    const p = s.productions.get(selected!.productionId!);
    console.log(`PRODUCTION #${p.id} ${p.status} in ${Math.round((Date.now() - t0) / 1000)}s · writer ${p.storyboard?.writer} ${p.storyboard?.fallbackReason ?? ''} · approval ${p.approval}`);
    for (const st of p.steps) console.log(`STEP ${st.step}: ${st.status} ×${st.attempts} ${st.detail}`);
    const runs = s.ops.qaRuns(p.id);
    for (const r of runs) {
      console.log(`QA round ${r.round}: ${r.status} ${JSON.stringify(r.summary)}`);
      for (const f of r.findings.filter((x) => !x.passed || /intelligibility|loudness|duration/.test(x.checkId))) console.log(`  ${f.passed ? 'ok ' : 'FAIL'} ${f.severity} ${f.checkId}: ${f.message}`);
    }
    for (const sc of p.storyboard?.scenes ?? []) console.log(`SCENE ${sc.index + 1} ${sc.narration}`);
    for (const m of Object.values(p.metadata)) console.log(`META ${m.platform}: ${m.title}\n${m.caption}\nMANUAL ${m.manualSteps.join(' | ')}`);
    console.log(`DEST ${JSON.stringify(p.destinations)}`);
    console.log(`OUTPUT ${p.outputPath}`);

    expect(p.status).toBe('completed');
    expect(p.origin).toBe('autonomous');
    expect(runs.at(-1)!.status).toBe('passed');
    expect(p.approval).toBe('awaiting_review');
    expect(p.publishStatus).toBe('not_published');
    expect(p.destinations[0]).toMatchObject({ platform: 'tiktok', privacy: 'private' });
    expect(p.assets.find((a) => a.kind === 'narration')?.meta).toMatchObject({ voice: expect.stringMatching(/heart/i) });
    const info = await probe(resolveFfmpeg(''), p.outputPath!);
    expect(info.video).toMatchObject({ width: 1080, height: 1920, codec: 'h264' });
    const report = s.audit.productionReport(p.id);
    fs.writeFileSync(path.join(root, 'audit-report.md'), report.markdown);
    const types = new Set((report.json as { events: { type: string }[] }).events.map((e) => e.type));
    console.log(`AUDIT types: ${[...types].join(', ')}`);
    for (const t of ['idea.selected', 'production.destination', 'research.completed', 'script.version', 'narration.completed', 'asset.visual', 'render.output', 'qa.run']) expect(types, t).toContain(t);
    expect(s.audit.verify().ok).toBe(true);

    // Simulated crash mid-run, then restart recovery and graceful stop.
    s.ops.startRun('discovery:1');
    s.db.close();
    s = build();
    s.engine.start();
    expect(s.ops.lastRun('discovery:1')?.status).toBe('interrupted');
    await s.engine.stop('test complete');
    const v = s.audit.verify();
    console.log(`LEDGER ${JSON.stringify(v)}`);
    expect(v.ok).toBe(true);
    expect(s.engine.productionsToday()).toBe(1);
    s.db.close();
  }, 1_800_000);
});
