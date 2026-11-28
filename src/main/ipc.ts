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
import { installKokoroGpu } from './providers/kokoroGpuInstall';
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
import { VOICE_PASSAGE_TEXT, VOICE_PREVIEW_TEXT, VOICE_SAMPLE_TEXT, sampleUrl } from '../shared/production';
import { VoicePreviews, previewNarrator, previewStyle } from './providers/voicePreview';
import type { BusinessRepository } from './business/businesses';
import type { TopicRepository } from './business/topics';
import { checkPronunciations, englishWords, type PronunciationRepository } from './pronunciation/dictionary';
import type { PreviewEngine } from '../shared/production';
import { BusinessContextError, type BusinessContext, type OwnedKind } from './business/context';
import * as v from './validation';
import { discoverMusicFor } from './audio/discovery';
import { MUSIC_DISCOVERY_ENABLED } from './library';
import { destinationStatuses } from '../shared/publicationStatus';
import { effectiveQaStatus, reviewGate } from '../shared/review';
import { AUDIO_PIPELINE_VERSION } from '../shared/audioMix';
import { rightsHistory, trackRightsDetails } from './audio/compliance';
import { resolveEffects } from './audio/effects';
import type { JobRepository } from './automation/jobs';
import type { CircuitBreakers } from './automation/circuit';
import type { ComfyService } from './comfy/service';
import type { ComfyRuntime } from './comfy/runtime';
import { gpuInfo } from './comfy/gpu';

type Handler = (...args: unknown[]) => unknown;
type InvokeKey = Exclude<keyof AppApi, 'onProductionChanged' | 'onBusinessChanged'>;

export interface IpcDeps {
  comfy: ComfyService;
  comfyRuntime: ComfyRuntime;
  jobs: JobRepository;
  breakers: CircuitBreakers;
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
/** Tell every window that a production changed (they reload it), e.g. after an approval made outside the runner. */
function productionChanged(id: number): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.onProductionChanged, id);
}

export function registerIpc({ comfy, comfyRuntime, jobs, breakers, repo, productions, runner, info, dirs, library, samplesDir, ops, audit, engine, publisher, isTrustedSender, businesses, topics, business, pronunciations }: IpcDeps): void {
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
      runner.assertNotFrozen(); // checked before a record is created, so a frozen pipeline leaves nothing behind
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
    installKokoroGpu: async () => {
      // Installing never switches the engine: the user chooses it after listening.
      await installKokoroGpu(dirs.toolsDir, dirs.tmpDir, AbortSignal.timeout(90 * 60_000));
      return productions.getSettings();
    },
    previewVoice: (engine, voice, length, kokoroBackend) => {
      const p = v.previewVoice(engine, voice);
      // Auditions use the real engine and voice, with this business's pronunciation dictionary; nothing is saved.
      const text = length === 'passage' ? VOICE_PASSAGE_TEXT : VOICE_PREVIEW_TEXT;
      const backend = kokoroBackend === 'gpu' ? 'gpu' : kokoroBackend === 'sherpa' ? 'sherpa' : undefined;
      return previews.preview(p.engine, p.voice, undefined, { text, pronunciations: pronunciations.resolved(cur(), p.engine) }, backend);
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
    // ---- managed ComfyUI (runtime is shared; history and progress are per business) ----
    comfyStatus: async () => ({ runtime: await comfyRuntime.status(), gpu: await gpuInfo(), progress: comfy.progress(cur()), model: productions.getSettings().comfyCheckpoint }),
    comfyDetect: () => comfyRuntime.detect(),
    comfyStart: async () => {
      audit.record({ actor: 'user', businessId: cur(), type: 'comfy.start.requested', data: {} });
      return comfyRuntime.start();
    },
    comfyStop: async () => {
      audit.record({ actor: 'user', businessId: cur(), type: 'comfy.stop.requested', data: {} });
      return comfyRuntime.stop();
    },
    comfyRestart: async () => {
      audit.record({ actor: 'user', businessId: cur(), type: 'comfy.restart.requested', data: {} });
      return comfyRuntime.restart();
    },
    comfyModels: async () => {
      if (!comfyRuntime.modelsRoot()) await comfyRuntime.detect();
      return comfy.models();
    },
    comfyApproveModel: (file, license, licenseUrl, note) => comfy.approveModel(v.shortText(file, 'Model', 300), v.shortText(license, 'Licence', 200), v.shortText(licenseUrl ?? '', 'Licence URL', 500), v.shortText(note ?? '', 'Note', 500)),
    comfyRevokeModel: (file, note) => comfy.revokeModel(v.shortText(file, 'Model', 300), v.shortText(note ?? '', 'Note', 500)),
    comfyHistory: () => comfy.history(cur(), 30),

    // ---- automation reliability (active business only) ----
    productionActivity: (limit) => {
      const n = Math.max(1, Math.min(200, Number(limit) || 50));
      return audit.events({ businessId: cur(), limit: 2000 }).filter((e) => e.type === 'production.action').slice(-n).reverse();
    },
    automationStatus: () => ({ halt: ops.getAutomationHalt(cur()), breakers: breakers.status(), jobs: jobs.list(cur(), 30), reliability: ops.getReliability() }),
    clearAutomationHalt: (note) => {
      const bid = cur();
      const h = ops.getAutomationHalt(bid);
      if (!h) return;
      ops.clearAutomationHalt(bid);
      audit.record({ actor: 'user', businessId: bid, type: 'automation.resumed', productionId: h.productionId, data: { halt: h, note: v.shortText(note ?? '', 'Note', 500) } });
    },
    saveReliability: (r) => {
      const saved = ops.saveReliability(v.reliability(r));
      audit.record({ actor: 'user', businessId: cur(), type: 'reliability.updated', data: { ...saved } });
      return saved;
    },
    runDiscoveryNow: () => engine.runDiscovery(cur()),
    listIdeas: () => ops.listIdeas(cur()),
    produceIdea: (id, confirmOffTopic) => {
      const iid = own('idea', id);
      if (runner.busy()) throw new Error('A production is already running or queued. Try again when it finishes.');
      // Off-topic ideas need an explicit confirmation, which is recorded.
      const rel = engine.ideaRelevance(iid);
      if (!rel.onTopic && confirmOffTopic !== true) throw new Error(`OFF_TOPIC: This idea looks off topic for this business (${rel.reason}). Confirm to produce it anyway.`);
      if (!rel.onTopic) audit.record({ actor: 'user', businessId: cur(), type: 'idea.offtopic-confirmed', subjectType: 'idea', subjectId: iid, data: { reason: rel.reason } });
      return engine.produceIdea(iid, 'user', rel.onTopic ? 'chosen by user' : `chosen by user despite off-topic warning (${rel.reason})`);
    },
    ideaRelevance: (id) => engine.ideaRelevance(own('idea', id)),
    getSoundProfile: () => ops.getSoundProfile(cur()),
    getProductionEffects: (id) => ops.getProductionEffects(own('production', id)),
    setProductionEffects: (id, effects) => {
      const pid = own('production', id);
      if (!Array.isArray(effects)) throw new Error('Expected a list of effects.');
      const list = effects.map((e) => ({ trackId: v.id((e as { trackId: unknown }).trackId), atSec: Number((e as { atSec: unknown }).atSec), note: v.shortText(String((e as { note?: unknown }).note ?? ''), 'Note', 300) }));
      const resolved = resolveEffects(library, list); // rights check now; repeated at render time
      const saved = ops.setProductionEffects(pid, list);
      audit.record({ actor: 'user', businessId: cur(), type: list.length ? 'audio.effects.approved' : 'audio.effects.cleared', productionId: pid, data: { effects: resolved.map((r) => ({ trackId: r.track.id, title: r.track.title, atSec: r.atSec, note: r.note })) } });
      return saved;
    },
    productionFreeze: () => ops.productionFreeze(),
    verifyAudioPipeline: async () => {
      const profile = ops.getSoundProfile(cur()).mixProfile;
      audit.record({ actor: 'user', type: 'audio.verification.started', data: { profile } });
      const r = await runner.verifyAudioPipeline(cur(), profile, AbortSignal.timeout(15 * 60_000));
      const v = { version: AUDIO_PIPELINE_VERSION, at: new Date().toISOString(), passed: r.passed, profile: profile ?? 'balanced', track: r.track, narration: r.narration, durationSec: r.durationSec, findings: r.findings, dir: r.dir, renderSha256: r.sha256 };
      ops.recordAudioVerification(v);
      audit.record({ actor: 'user', type: 'audio.verification', data: { version: v.version, passed: v.passed, profile: v.profile, track: v.track, narration: v.narration, durationSec: v.durationSec, sha256: v.renderSha256, dir: v.dir, failed: r.findings.filter((f) => !f.passed).map((f) => f.checkId) } });
      return ops.productionFreeze();
    },
    releaseProduction: (note) => {
      const f = ops.releaseProduction(v.shortText(note ?? '', 'Note', 500));
      audit.record({ actor: 'user', type: 'production.released', data: { version: f.version, verifiedAt: f.verification?.at, renderSha256: f.verification?.renderSha256, note } });
      return f;
    },
    saveSoundProfile: (s) => {
      const bid = cur();
      const saved = ops.saveSoundProfile(bid, v.soundProfile(s));
      audit.record({ actor: 'user', businessId: bid, type: 'sound.profile', data: { ...saved } });
      return saved;
    },
    getMusicOverride: (id) => ops.getMusicOverride(own('production', id)),
    setMusicOverride: (id, o) => {
      const pid = own('production', id);
      const choice = v.musicOverride(o);
      if (choice.mode === 'track') {
        const t = library.get(choice.trackId!);
        if (t.kind !== 'music') throw new Error(`"${t.title}" is a sound effect, not music.`);
        // Only an approved track can be chosen (the render re-checks it as well).
        const r = library.revalidate(t.id);
        if (!r.ok) throw new Error(`"${t.title}" cannot be chosen: ${r.reason}`);
      }
      const before = ops.getMusicOverride(pid);
      ops.setMusicOverride(pid, choice);
      audit.record({ actor: 'user', businessId: cur(), type: 'audio.override', productionId: pid, data: { before, after: choice } });
      return ops.getMusicOverride(pid);
    },
    discoverMusic: async (m) => {
      // Finds openly licensed instrumental tracks for a mood and imports the ones whose licence checks out.
      if (!MUSIC_DISCOVERY_ENABLED) throw new Error('Music discovery is switched off after the rights incident of 2026-11-27. Tracks are only accepted when their source of record verifies them.');
      const mood = v.mood(m);
      const s = productions.getSettings();
      const r = await discoverMusicFor(mood, { allowShareAlike: s.allowShareAlike, limit: 4, signal: AbortSignal.timeout(180_000) });
      const imported = [];
      const refused = r.refused.map((x) => `${x.title}: ${x.reason}`);
      for (const a of r.found) {
        try {
          const t = await library.importDiscovered(a, mood, AbortSignal.timeout(180_000), s.allowShareAlike);
          imported.push(t);
          audit.record({ actor: 'user', businessId: cur(), type: 'audio.discovered', subjectType: 'audio', subjectId: String(t.id), data: { title: t.title, license: t.license, attribution: t.attribution, rights: t.rights } });
        } catch (e) {
          refused.push((e as Error).message);
        }
      }
      return { imported, refused };
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
      const gate = reviewGate(p.approval, ops.qaRuns(p.id).at(-1));
      if (!gate.canApprove) throw new Error(`${gate.label}. ${gate.reason}`);
      const previous = runner.snapshot(p.id);
      productions.update(p.id, { approval: 'approved' });
      audit.record({ actor: 'user', type: 'approval.granted', productionId: p.id, data: { note: v.shortText(note, 'Note', 500), destinations: p.destinations, publishes: false } });
      runner.act(p.id, { action: 'approve', initiator: 'user', outcome: 'succeeded', stage: 'review', jobId: null, previous, reason: v.shortText(note, 'Note', 500) });
      productionChanged(p.id); // the window shows the Post button at once
    },
    rejectProduction: (id, note) => {
      const p = productions.get(own('production', id));
      const previous = runner.snapshot(p.id);
      productions.update(p.id, { approval: 'rejected' });
      audit.record({ actor: 'user', type: 'approval.rejected', productionId: p.id, data: { note: v.shortText(note, 'Note', 500) } });
      runner.act(p.id, { action: 'reject', initiator: 'user', outcome: 'succeeded', stage: 'review', jobId: null, previous, reason: v.shortText(note, 'Note', 500) });
      productionChanged(p.id);
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
    // Read-only rights views; incidents and affected productions are limited to the active business.
    soundRightsDetails: (id) => trackRightsDetails(library.database, library, v.id(id), cur()),
    rightsHistory: () => rightsHistory(library.database, library, cur()),
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
    publicationHistory: () => publisher.publicationHistory(cur()),
    publicationOverview: () => {
      // Status per destination for every production of the active business (Content Library and Studio badges).
      const bid = cur();
      const pubs = publisher.publicationHistory(bid);
      return productions.list(bid).map((p) => ({ productionId: p.id, contentId: p.contentId ?? null, topic: p.topic, statuses: destinationStatuses(p, pubs.filter((x) => x.productionId === p.id), effectiveQaStatus(ops.qaRuns(p.id).at(-1))) }));
    },
    recordPublicationDeletion: (id, note) => publisher.recordDeletion(v.id(id), cur(), 'user', v.shortText(note ?? '', 'Note', 500)),
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
    revoiceScenes: (id, scenes) => runner.renarrateScenes(own('production', id), v.sceneList(scenes)),

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
