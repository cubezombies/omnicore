import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC, type AppInfo } from '../shared/domain';
import type { Repository } from './db/repository';
import * as v from './validation';

type Handler = (...args: unknown[]) => unknown;

/**
 * Register every IPC handler. Each one checks the sender is our own top frame
 * and validates its arguments before touching the database.
 */
export function registerIpc(repo: Repository, info: AppInfo, isTrustedSender: (e: IpcMainInvokeEvent) => boolean): void {
  const handlers: Record<keyof typeof IPC, Handler> = {
    listChannels: () => repo.listChannels(),
    listContent: (channelId, stages) => repo.listContent(v.id(channelId, 'channelId'), v.stages(stages)),
    getContent: (id) => repo.getContent(v.id(id)),
    createContent: (channelId, draft) => repo.createContent(v.id(channelId, 'channelId'), v.draft(draft)),
    updateContent: (id, patch) => repo.updateContent(v.id(id), v.patch(patch)),
    moveContent: (id, to) => repo.moveContent(v.id(id), v.stage(to)),
    deleteContent: (id) => repo.deleteContent(v.id(id)),
    stageCounts: (channelId) => repo.stageCounts(v.id(channelId, 'channelId')),
    appInfo: () => info
  };

  for (const key of Object.keys(handlers) as (keyof typeof IPC)[]) {
    ipcMain.handle(IPC[key], (event, ...args) => {
      if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
      return handlers[key](...args);
    });
  }
}
