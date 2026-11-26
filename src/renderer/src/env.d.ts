import type { AppApi } from '../../shared/domain';

declare global {
  interface Window {
    api: AppApi;
  }
}

export {};
