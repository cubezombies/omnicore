import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type AppApi } from '../shared/domain';

// Narrow, typed bridge. The renderer never sees ipcRenderer itself.
const api: AppApi = {
  listChannels: () => ipcRenderer.invoke(IPC.listChannels),
  listContent: (channelId, stages) => ipcRenderer.invoke(IPC.listContent, channelId, stages),
  getContent: (id) => ipcRenderer.invoke(IPC.getContent, id),
  createContent: (channelId, draft) => ipcRenderer.invoke(IPC.createContent, channelId, draft),
  updateContent: (id, patch) => ipcRenderer.invoke(IPC.updateContent, id, patch),
  moveContent: (id, to) => ipcRenderer.invoke(IPC.moveContent, id, to),
  deleteContent: (id) => ipcRenderer.invoke(IPC.deleteContent, id),
  stageCounts: (channelId) => ipcRenderer.invoke(IPC.stageCounts, channelId),
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),

  listProductions: (channelId) => ipcRenderer.invoke(IPC.listProductions, channelId),
  getProduction: (id) => ipcRenderer.invoke(IPC.getProduction, id),
  createProduction: (channelId, input) => ipcRenderer.invoke(IPC.createProduction, channelId, input),
  retryProduction: (id) => ipcRenderer.invoke(IPC.retryProduction, id),
  rerunProduction: (id, from) => ipcRenderer.invoke(IPC.rerunProduction, id, from),
  cancelProduction: (id) => ipcRenderer.invoke(IPC.cancelProduction, id),
  deleteProduction: (id) => ipcRenderer.invoke(IPC.deleteProduction, id),
  showProductionFile: (id) => ipcRenderer.invoke(IPC.showProductionFile, id),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  saveSettings: (s) => ipcRenderer.invoke(IPC.saveSettings, s),
  checkProviders: () => ipcRenderer.invoke(IPC.checkProviders),
  installPiper: (voice) => ipcRenderer.invoke(IPC.installPiper, voice),
  installKokoro: () => ipcRenderer.invoke(IPC.installKokoro),
  generateVoiceSample: () => ipcRenderer.invoke(IPC.generateVoiceSample),
  listSounds: () => ipcRenderer.invoke(IPC.listSounds),
  generateSound: (g) => ipcRenderer.invoke(IPC.generateSound, g),
  importSound: (kind) => ipcRenderer.invoke(IPC.importSound, kind),
  updateSound: (id, patch) => ipcRenderer.invoke(IPC.updateSound, id, patch),
  deleteSound: (id) => ipcRenderer.invoke(IPC.deleteSound, id),
  getAutonomy: () => ipcRenderer.invoke(IPC.getAutonomy),
  saveAutonomy: (s) => ipcRenderer.invoke(IPC.saveAutonomy, s),
  engineStatus: () => ipcRenderer.invoke(IPC.engineStatus),
  runDiscoveryNow: () => ipcRenderer.invoke(IPC.runDiscoveryNow),
  listIdeas: () => ipcRenderer.invoke(IPC.listIdeas),
  produceIdea: (ideaId) => ipcRenderer.invoke(IPC.produceIdea, ideaId),
  rejectIdea: (ideaId, reason) => ipcRenderer.invoke(IPC.rejectIdea, ideaId, reason),
  listAccounts: () => ipcRenderer.invoke(IPC.listAccounts),
  addAccount: (platform, handle) => ipcRenderer.invoke(IPC.addAccount, platform, handle),
  disconnectAccount: (id) => ipcRenderer.invoke(IPC.disconnectAccount, id),
  listDestinations: () => ipcRenderer.invoke(IPC.listDestinations),
  setDestination: (platform, accountId, enabled, privacy) => ipcRenderer.invoke(IPC.setDestination, platform, accountId, enabled, privacy),
  getBrandPresenter: () => ipcRenderer.invoke(IPC.getBrandPresenter),
  setBrandPresenter: (engine, voice) => ipcRenderer.invoke(IPC.setBrandPresenter, engine, voice),
  qaRuns: (productionId) => ipcRenderer.invoke(IPC.qaRuns, productionId),
  runQa: (productionId) => ipcRenderer.invoke(IPC.runQa, productionId),
  approveProduction: (productionId, note) => ipcRenderer.invoke(IPC.approveProduction, productionId, note),
  rejectProduction: (productionId, note) => ipcRenderer.invoke(IPC.rejectProduction, productionId, note),
  exportAudit: (productionId) => ipcRenderer.invoke(IPC.exportAudit, productionId),
  verifyAudit: () => ipcRenderer.invoke(IPC.verifyAudit),
  auditEvents: (productionId) => ipcRenderer.invoke(IPC.auditEvents, productionId),
  listIncidents: () => ipcRenderer.invoke(IPC.listIncidents),
  addIncident: (kind, description, productionId, assetKey) => ipcRenderer.invoke(IPC.addIncident, kind, description, productionId, assetKey),
  resolveIncident: (id) => ipcRenderer.invoke(IPC.resolveIncident, id),
  platformApps: () => ipcRenderer.invoke(IPC.platformApps),
  savePlatformApp: (platform, app) => ipcRenderer.invoke(IPC.savePlatformApp, platform, app),
  connectAccount: (accountId) => ipcRenderer.invoke(IPC.connectAccount, accountId),
  publications: (productionId) => ipcRenderer.invoke(IPC.publications, productionId),
  publishBlockers: (productionId) => ipcRenderer.invoke(IPC.publishBlockers, productionId),
  publishProduction: (productionId, platform) => ipcRenderer.invoke(IPC.publishProduction, productionId, platform),
  onProductionChanged: (cb) => {
    const listener = (_e: IpcRendererEvent, id: unknown) => {
      if (typeof id === 'number') cb(id);
    };
    ipcRenderer.on(IPC.onProductionChanged, listener);
    return () => ipcRenderer.removeListener(IPC.onProductionChanged, listener);
  }
};

contextBridge.exposeInMainWorld('api', api);
