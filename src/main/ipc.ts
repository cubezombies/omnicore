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
import type { Publisher } from './publishing/publisher';
import { PLATFORMS } from '../shared/operations';
import type { OperationsRepository } from './db/operations';

let autonomyListener: () => void = () => {};
/** Main process hook: apply tray/startup/engine changes when autonomy settings are saved. */
export const onAutonomySettingsChanged = (fn: () => void) => (autonomyListener = fn);
const onAutonomyChanged = () => autonomyListener();
import { VOICE_SAMPLE_TEXT, sampleUrl } from '../shared/production';
import { VoicePreviews, previewNarrator, previewStyle } from './providers/voicePreview';
import type { BusinessRepository } from './business/businesses';
import type { TopicRepository } from './business/topics';
import { checkPronunciations, englishWords, type PronunciationRepository } from './pronunciation/dictionary';
import type { PreviewEngine } from '../shared/production';
import { BusinessContextError, type BusinessContext, type OwnedKind } from './business/context';
import * as v from './validation';

type Handler = (...args: unknown[]) => unknown;
type InvokeKey = Exclude<keyof AppApi, 'onProductionChanged' | 'onBusinessChanged'>;

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
  publisher: Publisher;
  isTrustedSender: (e: IpcMainInvokeEvent) => boolean;
  businesses: BusinessRepository;
  topics: TopicRepository;
  business: BusinessContext;
  pronunciations: PronunciationRepository;
}

/**
 * Register every IPC handler. Each one checks the sender is our own top frame
 * and validates its arguments before touching the database or filesystem.
 */
export function registerIpc({ repo, productions, runner, info, dirs, library, samplesDir, ops, audit, engine, publisher, isTrustedSender, businesses, topics, business, pronunciations }: IpcDeps): void {
  const previews = new VoicePreviews(samplesDir, previewNarrator(() => productions.getSettings(), dirs), () => previewStyle(productions.getSettings()));
  // Every business-owned request is checked against the active business (held here, in the main process) and
  // against the owner of the record it touches. Missing or invalid context throws; nothing falls back to another business.
  const cur = () => business.activeId();
  /** The engine and voice that narrate for a business (its presenter, else the global narration settings). */
  const presenterVoice = (bid: number): { engine: PreviewEngine; voice: string } => {
    const s = productions.getSettings();
    const pres = ops.brandPresenter(bid);
    if (pres.engine === 'sherpa') return { engine: 'sherpa', voice: pres.voice };
    if (pres.engine === 'windows-sapi' && pres.voice) return { engine: 'windows-sapi', voice: pres.voice };
    if (s.narration === 'sherpa') return { engine: 'sherpa', voice: s.sherpaVoice };
    if (s.narration === 'piper') return { engine: 'piper', voice: s.piperVoice };
    if (!s.voice) throw new Error('Choose a specific Windows voice (or a Kokoro presenter) to audition pronunciations.');
    return { engine: 'windows-sapi', voice: s.voice };
  };
  const own = (kind: OwnedKind, id: unknown) => business.own(kind, v.id(id));
  const handlers: Record<InvokeKey, Handler> = {
    // ---- businesses -----------------------------------------------------------------
    listChannels: () => businesses.list(),
    listBusinesses: (includeArchived) => businesses.list(v.bool(includeArchived ?? false)),
    activeBusiness: () => business.tryActive(),
    switchBusiness: (id) => {
      const b = business.setActive(id);
      audit.record({ actor: 'user', businessId: b.id, type: 'business.switched', data: { name: b.name } });
      return b;
    },
    createBusiness: (draft) => {
      const b = businesses.create(v.businessDraft(draft));
      audit.record({ actor: 'user', businessId: b.id, type: 'business.created', data: { name: b.name, type: b.businessType, modules: b.modules } });
      return b;
    },
    updateBusiness: (id, patch) => {
      const bid = business.require(id); // only the selected business can be edited
      const b = businesses.update(bid, v.businessPatch(patch));
      audit.record({ actor: 'user', businessId: bid, type: 'business.updated', data: { ...v.businessPatch(patch) } });
      return b;
    },
    archiveBusiness: (id) => {
      const bid = v.id(id);
      if (business.tryActive()?.id === bid) throw new BusinessContextError('Switch to another business before archiving this one.');
      const b = businesses.archive(bid);
      audit.record({ actor: 'user', businessId: bid, type: 'business.archived', data: { name: b.name } });
      return b;
    },
    restoreBusiness: (id) => {
      const b = businesses.restore(v.id(id));
      audit.record({ actor: 'user', businessId: b.id, type: 'business.restored', data: { name: b.name } });
      return b;
    },

    // ---- topics (always the active business) ---------------------------------------
    listTopics: () => topics.list(cur()),
    createTopic: (draft) => {
      const t = topics.create(cur(), v.topicDraft(draft));
      audit.record({ actor: 'user', businessId: t.businessId, type: 'topic.created', subjectType: 'topic', subjectId: t.id, data: { name: t.name, parentId: t.parentId } });
      return t;
    },
    updateTopic: (id, patch) => {
      const t = topics.update(cur(), v.id(id), v.topicPatch(patch));
      audit.record({ actor: 'user', businessId: t.businessId, type: 'topic.updated', subjectType: 'topic', subjectId: t.id, data: { ...v.topicPatch(patch) } });
      return t;
    },
    reorderTopics: (parentId, ids) => topics.reorder(cur(), parentId === null ? null : v.id(parentId), v.idList(ids)),
    archiveTopic: (id) => {
      const t = topics.archive(cur(), v.id(id));
      audit.record({ actor: 'user', businessId: t.businessId, type: 'topic.archived', subjectType: 'topic', subjectId: t.id, data: { name: t.name } });
      return t;
    },
    restoreTopic: (id) => topics.restore(cur(), v.id(id)),
    deleteTopic: (id) => {
      const bid = cur();
      const t = topics.get(bid, v.id(id));
      topics.delete(bid, t.id);
      audit.record({ actor: 'user', businessId: bid, type: 'topic.deleted', subjectType: 'topic', subjectId: t.id, data: { name: t.name } });
    },
    decideTopicProposal: (id, accept) => {
      const bid = cur();
      const t = topics.decideProposal(bid, v.id(id), v.bool(accept));
      audit.record({ actor: 'user', businessId: bid, type: accept ? 'topic.proposal.accepted' : 'topic.proposal.rejected', subjectType: 'topic', subjectId: Number(id) });
      return t;
    },

    // ---- content ----------------------------------------------------------------------
    listContent: (channelId, stages) => repo.listContent(business.require(channelId), v.stages(stages)),
    getContent: (id) => repo.getContent(own('content', id)),
    createContent: (channelId, draft) => repo.createContent(business.require(channelId), v.draft(draft)),
    updateContent: (id, patch) => repo.updateContent(own('content', id), v.patch(patch)),
    moveContent: (id, to) => repo.moveContent(own('content', id), v.stage(to)),
    deleteContent: (id) => repo.deleteContent(own('content', id)),
    stageCounts: (channelId) => repo.stageCounts(business.require(channelId)),
    appInfo: () => info,

    // ---- productions ------------------------------------------------------------------
    listProductions: (channelId) => productions.list(business.require(channelId)),
    getProduction: (id) => productions.get(own('production', id)),
    createProduction: (channelId, input) => {
      const cid = business.require(channelId);
      const np = v.newProduction(input);
      let notes = '';
      if (np.contentId !== undefined) {
        own('content', np.contentId);
        notes = repo.getContent(np.contentId)!.researchNotes;
      }
      const p = productions.create(cid, np.topic, np.contentId ?? null, notes, np.mode ?? 'explainer', { destinations: ops.resolveDestinations(cid), format: np.format ?? 'standard' });
      audit.record({ actor: 'user', type: 'production.created', productionId: p.id, data: { topic: np.topic, mode: np.mode ?? 'explainer', format: np.format ?? 'standard', destinations: p.destinations } });
      runner.enqueue(p.id);
      return productions.get(p.id);
    },
    retryProduction: (id) => runner.retry(own('production', id)),
    rerunProduction: (id, from) => runner.rerun(own('production', id), v.stepName(from)),
    cancelProduction: (id) => runner.cancel(own('production', id)),
    deleteProduction: (id) => runner.delete(own('production', id)),
    showProductionFile: (id) => {
      const pid = own('production', id);
      const p = productions.get(pid);
      const target = p.outputPath && fs.existsSync(p.outputPath) ? p.outputPath : runner.dirFor(pid);
      if (!fs.existsSync(target)) throw new Error('Nothing has been produced yet.');
      if (target === p.outputPath) shell.showItemInFolder(path.resolve(target));
      else void shell.openPath(path.resolve(target));
    },

    // ---- shared runtime (models, voices, tools): Omnicore core, not business data ---------
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
      const old = fs.readdirSync(samplesDir).filter((f) => f.startsWith('sample-') && f.endsWith('.wav')).map((f) => ({ f, t: fs.statSync(path.join(samplesDir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const o of old.slice(8)) fs.rmSync(path.join(samplesDir, o.f), { force: true });
      const file = `sample-${n.id}-${Date.now()}.wav`;
      const r = await n.synthesize(VOICE_SAMPLE_TEXT, path.join(samplesDir, file), AbortSignal.timeout(180_000));
      const wordsPerSec = VOICE_SAMPLE_TEXT.split(/\s+/).length / r.durationSec;
      productions.saveSettings({ ...productions.getSettings(), voiceWordsPerSec: Math.round(wordsPerSec * 100) / 100 });
      return { url: sampleUrl(file), durationSec: r.durationSec, wordsPerSec, voice: r.voice, engine: n.label };
    },
    previewVoice: (engine, voice) => {
      const p = v.previewVoice(engine, voice);
      return previews.preview(p.engine, p.voice);
    },

    // ---- analytics and automation (active business) -----------------------------------
    getAnalytics: () => publisher.analytics(cur()),
    getAutonomy: () => ops.getAutonomy(cur()),
    saveAutonomy: (s) => {
      const bid = cur();
      const saved = ops.saveAutonomy(bid, v.autonomy(s));
      audit.record({ actor: 'user', businessId: bid, type: 'autonomy.settings', data: { ...saved } });
      onAutonomyChanged();
      return saved;
    },
    engineStatus: () => engine.status(cur()),
    runDiscoveryNow: () => engine.runDiscovery(cur()),
    listIdeas: () => ops.listIdeas(cur()),
    produceIdea: (id) => {
      const iid = own('idea', id);
      if (runner.busy()) throw new Error('A production is already running or queued. Try again when it finishes.');
      return engine.produceIdea(iid, 'user', 'chosen by user');
    },
    rejectIdea: (id, reason) => {
      const idea = ops.decideIdea(own('idea', id), 'rejected', `rejected by user: ${v.shortText(reason, 'Reason', 300)}`);
      audit.record({ actor: 'user', businessId: idea.brandId, type: 'idea.rejected', subjectType: 'idea', subjectId: idea.id, data: { topic: idea.topic, reason } });
    },

    // ---- accounts & channels (active business) ----------------------------------------
    listAccounts: () => ops.listAccounts(cur()),
    addAccount: (platform, handle) => {
      const bid = cur();
      const a = ops.addAccount(bid, v.platform(platform), v.handle(handle));
      audit.record({ actor: 'user', businessId: bid, type: 'account.added', subjectType: 'account', subjectId: a.id, data: { platform: a.platform, handle: a.handle, status: a.status } });
      return a;
    },
    disconnectAccount: (id) => {
      const a = ops.disconnectAccount(own('account', id));
      audit.record({ actor: 'user', businessId: a.businessId, type: 'account.disconnected', subjectType: 'account', subjectId: a.id, data: { platform: a.platform, handle: a.handle } });
      publisher.refreshDestinations(cur());
      return a;
    },
    listDestinations: () => ops.listDestinations(cur()),
    setDestination: (platform, accountId, enabled, privacy) => {
      const bid = cur();
      if (accountId !== null) own('account', accountId);
      const d = ops.setDestination(bid, v.platform(platform), { accountId: accountId === null ? null : v.id(accountId), enabled: v.bool(enabled), privacy: v.privacy(privacy) });
      audit.record({ actor: 'user', businessId: bid, type: 'destination.set', subjectType: 'destination', subjectId: d.id, data: { ...d } });
      publisher.refreshDestinations(bid);
      return d;
    },
    getBrandPresenter: () => ops.brandPresenter(cur()),
    setBrandPresenter: (engineId, voice) => {
      const bid = cur();
      const p = v.presenter(engineId, voice);
      ops.setBrandPresenter(bid, p.engine, p.voice);
      audit.record({ actor: 'user', businessId: bid, type: 'brand.presenter', data: p });
    },
    platformApps: () => PLATFORMS.map((pl) => publisher.appSummary(pl, cur())),
    savePlatformApp: (platform, app) => publisher.saveApp(cur(), v.platform(platform), v.platformApp(app)),
    connectAccount: async (id) => {
      const a = await publisher.connect(own('account', id), AbortSignal.timeout(6 * 60_000));
      publisher.refreshDestinations(a.businessId!);
      return a;
    },

    // ---- review, QA, rights and publishing (production must belong to the active business) ----
    qaRuns: (id) => ops.qaRuns(own('production', id)),
    runQa: (id) => runner.rerun(own('production', id), 'qa'),
    approveProduction: (id, note) => {
      const p = productions.get(own('production', id));
      if (p.approval !== 'awaiting_review') throw new Error(p.approval === 'blocked' ? 'This production failed critical QA checks and cannot be approved.' : `Nothing to approve (status: ${p.approval}).`);
      const qa = ops.qaRuns(p.id).at(-1);
      if (qa?.status !== 'passed') throw new Error(`Only videos that passed the quality check can be approved (last result: ${qa?.status ?? 'not run'}). Fix the issues or re-run QA first.`);
      productions.update(p.id, { approval: 'approved' });
      audit.record({ actor: 'user', type: 'approval.granted', productionId: p.id, data: { note: v.shortText(note, 'Note', 500), destinations: p.destinations, publishes: false } });
    },
    rejectProduction: (id, note) => {
      const p = productions.get(own('production', id));
      productions.update(p.id, { approval: 'rejected' });
      audit.record({ actor: 'user', type: 'approval.rejected', productionId: p.id, data: { note: v.shortText(note, 'Note', 500) } });
    },
    exportAudit: (id) => {
      const pid = own('production', id);
      const r = audit.productionReport(pid);
      const dir = runner.dirFor(pid);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'audit-report.md'), r.markdown, 'utf8');
      fs.writeFileSync(path.join(dir, 'audit-report.json'), JSON.stringify(r.json, null, 2), 'utf8');
      shell.showItemInFolder(path.join(dir, 'audit-report.md'));
      return path.join(dir, 'audit-report.md');
    },
    verifyAudit: () => audit.verify(),
    auditEvents: (id) => audit.events({ productionId: own('production', id) }),
    listIncidents: () => ops.listIncidents(cur()),
    addIncident: (kind, description, productionId, assetKey) => {
      const bid = cur();
      const pid = productionId === null ? null : own('production', productionId);
      const i = ops.addIncident(bid, v.incidentKind(kind), v.shortText(description, 'Description', 2000), pid, v.shortText(assetKey ?? '', 'Asset', 500));
      audit.record({ actor: 'user', businessId: bid, type: 'incident.recorded', productionId: i.productionId, subjectType: 'incident', subjectId: i.id, data: { kind: i.kind, assetKey: i.assetKey, description: i.description } });
      return i;
    },
    resolveIncident: (id) => {
      ops.resolveIncident(own('incident', id));
      audit.record({ actor: 'user', businessId: cur(), type: 'incident.resolved', subjectType: 'incident', subjectId: Number(id) });
    },
    publications: (id) => publisher.publications(own('production', id)),
    publishBlockers: (id) => {
      const p = productions.get(own('production', id));
      return Object.fromEntries(p.destinations.map((d) => [d.platform, publisher.blockers(p.id, d.platform)]));
    },
    publishProduction: (id, platform, tiktok) => {
      const pid = own('production', id);
      const pl = v.platform(platform);
      // TikTok posts from the UI must come from the posting screen (privacy chosen by the user, no default).
      if (pl === 'tiktok' && tiktok === undefined) throw new Error('Open the TikTok posting screen to choose privacy and settings.');
      return publisher.publish(pid, pl, 'user', undefined, pl === 'tiktok' ? v.tiktokPost(tiktok) : undefined);
    },
    tiktokCreatorInfo: (id) => publisher.tiktokCreatorInfo(own('production', id)),

    // ---- pronunciation dictionary (shared entries + the active business's own) ---------------
    listPronunciations: () => pronunciations.list(cur()),
    savePronunciation: (draft) => {
      const bid = cur();
      const e = pronunciations.save(bid, v.pronunciationDraft(draft));
      audit.record({ actor: 'user', businessId: bid, type: 'pronunciation.saved', subjectType: 'pronunciation', subjectId: e.id, data: { term: e.term, say: e.say, engineSay: e.engineSay, scope: e.businessId === null ? 'global' : 'business' } });
      return e;
    },
    deletePronunciation: (id) => {
      const bid = cur();
      const e = pronunciations.delete(bid, v.id(id));
      audit.record({ actor: 'user', businessId: bid, type: 'pronunciation.deleted', subjectType: 'pronunciation', subjectId: e.id, data: { term: e.term, scope: e.businessId === null ? 'global' : 'business' } });
    },
    pronunciationReport: (id) => {
      const p = productions.get(own('production', id));
      return p.storyboard ? checkPronunciations(p.storyboard, pronunciations.list(p.channelId), englishWords(dirs.toolsDir)) : [];
    },
    auditionPronunciation: (req) => {
      const bid = cur();
      const r = v.audition(req);
      const voice = presenterVoice(bid);
      // The business's dictionary, with the draft correction (if any) applied on top, spoken by its presenter.
      const base = pronunciations.resolved(bid, voice.engine).filter((x) => !r.term || x.term.toLowerCase() !== r.term.toLowerCase());
      return previews.preview(voice.engine, voice.voice, AbortSignal.timeout(180_000), { text: r.text, pronunciations: r.term && r.say ? [...base, { term: r.term, say: r.say }] : base });
    },
    revoiceScenes: (id, scenes) => runner.renarrateScenes(own('production', id), v.idList(scenes).map((n) => n)),

    // ---- sound library: licensed assets shared by all businesses (core) ------------------
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
