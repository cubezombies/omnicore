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
  onProductionChanged: (cb) => {
    const listener = (_e: IpcRendererEvent, id: unknown) => {
      if (typeof id === 'number') cb(id);
    };
    ipcRenderer.on(IPC.onProductionChanged, listener);
    return () => ipcRenderer.removeListener(IPC.onProductionChanged, listener);
  }
};

contextBridge.exposeInMainWorld('api', api);
