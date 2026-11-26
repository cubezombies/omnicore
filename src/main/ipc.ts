import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { IPC, type AppApi, type AppInfo } from '../shared/domain';
import type { ProductionRepository } from './db/productions';
import type { Repository } from './db/repository';
import type { ProductionRunner } from './pipeline/runner';
import type { SoundLibrary } from './library';
import { installPiper } from './providers/piper';
import { checkProviders, narrator, type ProviderDirs } from './providers/registry';
import { installKokoro } from './providers/sherpa';
import { installAsr } from './qa/asr';
import type { AuditLedger } from './audit/ledger';
import type { OperatingEngine } from './autonomy/engine';
import type { OperationsRepository } from './db/operations';
import type { AutonomySettings } from '../shared/operations';

let autonomyListener: (s: AutonomySettings) => void = () => {};
/** Main process hook: apply tray/startup/engine changes when autonomy settings are saved. */
export const onAutonomySettingsChanged = (fn: (s: AutonomySettings) => void) => (autonomyListener = fn);
const onAutonomyChanged = (s: AutonomySettings) => autonomyListener(s);
import { VOICE_SAMPLE_TEXT, sampleUrl } from '../shared/production';
import * as v from './validation';

type Handler = (...args: unknown[]) => unknown;
type InvokeKey = Exclude<keyof AppApi, 'onProductionChanged'>;

export interface IpcDeps {
  repo: Repository;
  productions: ProductionRepository;
  runner: ProductionRunner;
  info: AppInfo;
  dirs: ProviderDirs;
  library: SoundLibrary;
  samplesDir: string;
  ops: OperationsRepository;
  audit: AuditLedger;
  engine: OperatingEngine;
  isTrustedSender: (e: IpcMainInvokeEvent) => boolean;
}

/**
 * Register every IPC handler. Each one checks the sender is our own top frame
 * and validates its arguments before touching the database or filesystem.
 */
export function registerIpc({ repo, productions, runner, info, dirs, library, samplesDir, ops, audit, engine, isTrustedSender }: IpcDeps): void {
  const brandId = () => repo.listChannels()[0].id;
  const handlers: Record<InvokeKey, Handler> = {
    listChannels: () => repo.listChannels(),
    listContent: (channelId, stages) => repo.listContent(v.id(channelId, 'channelId'), v.stages(stages)),
    getContent: (id) => repo.getContent(v.id(id)),
    createContent: (channelId, draft) => repo.createContent(v.id(channelId, 'channelId'), v.draft(draft)),
    updateContent: (id, patch) => repo.updateContent(v.id(id), v.patch(patch)),
    moveContent: (id, to) => repo.moveContent(v.id(id), v.stage(to)),
    deleteContent: (id) => repo.deleteContent(v.id(id)),
    stageCounts: (channelId) => repo.stageCounts(v.id(channelId, 'channelId')),
    appInfo: () => info,

    listProductions: (channelId) => productions.list(v.id(channelId, 'channelId')),
    getProduction: (id) => productions.get(v.id(id)),
    createProduction: (channelId, input) => {
      const cid = v.id(channelId, 'channelId');
      const np = v.newProduction(input);
      let notes = '';
      if (np.contentId !== undefined) {
        const item = repo.getContent(np.contentId);
        if (!item || item.channelId !== cid) throw new Error('Linked content item not found in this channel.');
        notes = item.researchNotes;
      }
      if (!repo.listChannels().some((c) => c.id === cid)) throw new Error(`Channel ${cid} not found`);
      const p = productions.create(cid, np.topic, np.contentId ?? null, notes, np.mode ?? 'explainer', { destinations: ops.resolveDestinations(cid) });
      audit.record({ actor: 'user', type: 'production.created', productionId: p.id, data: { topic: np.topic, mode: np.mode ?? 'explainer', destinations: p.destinations } });
      runner.enqueue(p.id);
      return productions.get(p.id);
    },
    retryProduction: (id) => runner.retry(v.id(id)),
    rerunProduction: (id, from) => runner.rerun(v.id(id), v.stepName(from)),
    cancelProduction: (id) => runner.cancel(v.id(id)),
    deleteProduction: (id) => runner.delete(v.id(id)),
    showProductionFile: (id) => {
      const pid = v.id(id);
      const p = productions.get(pid);
      const target = p.outputPath && fs.existsSync(p.outputPath) ? p.outputPath : runner.dirFor(pid);
      if (!fs.existsSync(target)) throw new Error('Nothing has been produced yet.');
      if (target === p.outputPath) shell.showItemInFolder(path.resolve(target));
      else void shell.openPath(path.resolve(target));
    },
    getSettings: () => productions.getSettings(),
    saveSettings: (s) => productions.saveSettings(v.settings(s)),
    checkProviders: () => checkProviders(productions.getSettings(), dirs),
    installPiper: async (voice) => {
      const r = await installPiper(dirs.toolsDir, v.piperVoiceId(voice), AbortSignal.timeout(20 * 60_000));
      return productions.saveSettings({ ...productions.getSettings(), narration: 'piper', piperPath: '', piperVoice: r.voicePath });
    },
    installKokoro: async () => {
      await installKokoro(dirs.toolsDir, AbortSignal.timeout(45 * 60_000));
      await installAsr(dirs.toolsDir, AbortSignal.timeout(45 * 60_000)); // independent speech check used by QA
      return productions.saveSettings({ ...productions.getSettings(), narration: 'sherpa' });
    },
    generateVoiceSample: async () => {
      const s = productions.getSettings();
      const n = narrator(s, dirs);
      fs.mkdirSync(samplesDir, { recursive: true });
      // Keep the folder small: remove all but the 8 newest samples.
      const old = fs.readdirSync(samplesDir).filter((f) => f.endsWith('.wav')).map((f) => ({ f, t: fs.statSync(path.join(samplesDir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const o of old.slice(8)) fs.rmSync(path.join(samplesDir, o.f), { force: true });
      const file = `sample-${n.id}-${Date.now()}.wav`;
      const r = await n.synthesize(VOICE_SAMPLE_TEXT, path.join(samplesDir, file), AbortSignal.timeout(180_000));
      const wordsPerSec = VOICE_SAMPLE_TEXT.split(/\s+/).length / r.durationSec;
      productions.saveSettings({ ...productions.getSettings(), voiceWordsPerSec: Math.round(wordsPerSec * 100) / 100 });
      return { url: sampleUrl(file), durationSec: r.durationSec, wordsPerSec, voice: r.voice, engine: n.label };
    },
    getAutonomy: () => ops.getAutonomy(),
    saveAutonomy: (s) => {
      const saved = ops.saveAutonomy(v.autonomy(s));
      audit.record({ actor: 'user', type: 'autonomy.settings', data: { ...saved } });
      onAutonomyChanged(saved);
      return saved;
    },
    engineStatus: () => engine.status(),
    runDiscoveryNow: () => engine.runDiscovery(brandId()),
    listIdeas: () => ops.listIdeas(brandId()),
    produceIdea: (id) => {
      if (runner.busy()) throw new Error('A production is already running or queued. Try again when it finishes.');
      return engine.produceIdea(v.id(id), 'user', 'chosen by user');
    },
    rejectIdea: (id, reason) => {
      const idea = ops.decideIdea(v.id(id), 'rejected', `rejected by user: ${v.shortText(reason, 'Reason', 300)}`);
      audit.record({ actor: 'user', type: 'idea.rejected', subjectType: 'idea', subjectId: idea.id, data: { topic: idea.topic, reason } });
    },
    listAccounts: () => ops.listAccounts(),
    addAccount: (platform, handle) => {
      const a = ops.addAccount(v.platform(platform), v.handle(handle));
      audit.record({ actor: 'user', type: 'account.added', subjectType: 'account', subjectId: a.id, data: { platform: a.platform, handle: a.handle, status: a.status } });
      return a;
    },
    disconnectAccount: (id) => {
      const a = ops.disconnectAccount(v.id(id));
      audit.record({ actor: 'user', type: 'account.disconnected', subjectType: 'account', subjectId: a.id, data: { platform: a.platform, handle: a.handle } });
      return a;
    },
    listDestinations: () => ops.listDestinations(brandId()),
    setDestination: (platform, accountId, enabled, privacy) => {
      const d = ops.setDestination(brandId(), v.platform(platform), { accountId: accountId === null ? null : v.id(accountId), enabled: v.bool(enabled), privacy: v.privacy(privacy) });
      audit.record({ actor: 'user', type: 'destination.set', subjectType: 'destination', subjectId: d.id, data: { ...d } });
      return d;
    },
    getBrandPresenter: () => ops.brandPresenter(brandId()),
    setBrandPresenter: (engineId, voice) => {
      const p = v.presenter(engineId, voice);
      ops.setBrandPresenter(brandId(), p.engine, p.voice);
      audit.record({ actor: 'user', type: 'brand.presenter', data: p });
    },
    qaRuns: (id) => ops.qaRuns(v.id(id)),
    runQa: (id) => runner.rerun(v.id(id), 'qa'),
    approveProduction: (id, note) => {
      const p = productions.get(v.id(id));
      if (p.approval !== 'awaiting_review') throw new Error(p.approval === 'blocked' ? 'This production failed critical QA checks and cannot be approved.' : `Nothing to approve (status: ${p.approval}).`);
      productions.update(p.id, { approval: 'approved' });
      audit.record({ actor: 'user', type: 'approval.granted', productionId: p.id, data: { note: v.shortText(note, 'Note', 500), destinations: p.destinations, publishes: false } });
    },
    rejectProduction: (id, note) => {
      const p = productions.get(v.id(id));
      productions.update(p.id, { approval: 'rejected' });
      audit.record({ actor: 'user', type: 'approval.rejected', productionId: p.id, data: { note: v.shortText(note, 'Note', 500) } });
    },
    exportAudit: (id) => {
      const pid = v.id(id);
      const r = audit.productionReport(pid);
      const dir = runner.dirFor(pid);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'audit-report.md'), r.markdown, 'utf8');
      fs.writeFileSync(path.join(dir, 'audit-report.json'), JSON.stringify(r.json, null, 2), 'utf8');
      shell.showItemInFolder(path.join(dir, 'audit-report.md'));
      return path.join(dir, 'audit-report.md');
    },
    verifyAudit: () => audit.verify(),
    auditEvents: (id) => audit.events({ productionId: v.id(id) }),
    listIncidents: () => ops.listIncidents(),
    addIncident: (kind, description, productionId, assetKey) => {
      const i = ops.addIncident(v.incidentKind(kind), v.shortText(description, 'Description', 2000), productionId === null ? null : v.id(productionId), v.shortText(assetKey ?? '', 'Asset', 500));
      audit.record({ actor: 'user', type: 'incident.recorded', productionId: i.productionId, subjectType: 'incident', subjectId: i.id, data: { kind: i.kind, assetKey: i.assetKey, description: i.description } });
      return i;
    },
    resolveIncident: (id) => {
      ops.resolveIncident(v.id(id));
      audit.record({ actor: 'user', type: 'incident.resolved', subjectType: 'incident', subjectId: Number(id) });
    },
    listSounds: () => library.list(),
    generateSound: (g) => library.generate(v.generatorId(g)),
    importSound: async (kind) => {
      const k = v.audioKind(kind);
      const win = BrowserWindow.getAllWindows()[0];
      const opts: Electron.OpenDialogOptions = {
        title: k === 'music' ? 'Import music' : 'Import sound effect',
        properties: ['openFile'],
        filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'] }]
      };
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      if (res.canceled || !res.filePaths[0]) return null;
      return library.import(res.filePaths[0], k);
    },
    updateSound: (id, patch) => library.update(v.id(id), v.trackPatch(patch)),
    deleteSound: (id) => library.delete(v.id(id))
  };

  for (const key of Object.keys(handlers) as InvokeKey[]) {
    ipcMain.handle(IPC[key], (event, ...args) => {
      if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
      return handlers[key](...args);
    });
  }
}
