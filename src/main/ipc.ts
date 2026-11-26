import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { IPC, type AppApi, type AppInfo } from '../shared/domain';
import type { ProductionRepository } from './db/productions';
import type { Repository } from './db/repository';
import type { ProductionRunner } from './pipeline/runner';
import { checkProviders } from './providers/registry';
import * as v from './validation';

type Handler = (...args: unknown[]) => unknown;
type InvokeKey = Exclude<keyof AppApi, 'onProductionChanged'>;

export interface IpcDeps {
  repo: Repository;
  productions: ProductionRepository;
  runner: ProductionRunner;
  info: AppInfo;
  tmpDir: string;
  isTrustedSender: (e: IpcMainInvokeEvent) => boolean;
}

/**
 * Register every IPC handler. Each one checks the sender is our own top frame
 * and validates its arguments before touching the database or filesystem.
 */
export function registerIpc({ repo, productions, runner, info, tmpDir, isTrustedSender }: IpcDeps): void {
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
      const p = productions.create(cid, np.topic, np.contentId ?? null, notes);
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
    checkProviders: () => checkProviders(productions.getSettings(), tmpDir)
  };

  for (const key of Object.keys(handlers) as InvokeKey[]) {
    ipcMain.handle(IPC[key], (event, ...args) => {
      if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
      return handlers[key](...args);
    });
  }
}
