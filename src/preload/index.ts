import { contextBridge, ipcRenderer } from 'electron';
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
  appInfo: () => ipcRenderer.invoke(IPC.appInfo)
};

contextBridge.exposeInMainWorld('api', api);
