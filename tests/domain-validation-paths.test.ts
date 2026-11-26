import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { canTransition, nextStage, previousStage, STAGES, LIMITS } from '../src/shared/domain';
import * as v from '../src/main/validation';
import { resolveDataDir, resolveMediaPath, DATA_DIR_ENV } from '../src/main/paths';

describe('workflow rules', () => {
  it('only allows one step forward or any step back', () => {
    expect(canTransition('idea', 'research')).toBe(true);
    expect(canTransition('idea', 'script')).toBe(false);
    expect(canTransition('review', 'published')).toBe(true);
    expect(canTransition('published', 'review')).toBe(true);
    expect(canTransition('review', 'idea')).toBe(true);
    expect(canTransition('script', 'script')).toBe(false);
  });
  it('knows stage neighbours', () => {
    expect(nextStage('idea')).toBe('research');
    expect(nextStage('published')).toBeNull();
    expect(previousStage('idea')).toBeNull();
    expect(previousStage('published')).toBe('review');
    expect(STAGES).toHaveLength(6);
  });
});

describe('IPC validation', () => {
  it('accepts positive integer ids only', () => {
    expect(v.id(3)).toBe(3);
    for (const bad of [0, -1, 1.5, '1', null, undefined, NaN]) expect(() => v.id(bad)).toThrow(v.ValidationError);
  });
  it('validates stages', () => {
    expect(v.stage('review')).toBe('review');
    expect(() => v.stage('drop table')).toThrow(v.ValidationError);
    expect(v.stages(undefined)).toBeUndefined();
    expect(() => v.stages('idea')).toThrow(v.ValidationError);
  });
  it('requires and trims a title on drafts', () => {
    expect(v.draft({ title: '  Hello  ' }).title).toBe('Hello');
    expect(() => v.draft({ title: '   ' })).toThrow(/required/);
    expect(() => v.draft({})).toThrow(v.ValidationError);
    expect(() => v.draft(null)).toThrow(v.ValidationError);
    expect(() => v.draft({ title: 'x'.repeat(LIMITS.title + 1) })).toThrow(/exceeds/);
    expect(() => v.draft({ title: 'ok', script: 42 })).toThrow(v.ValidationError);
  });
  it('drops unknown keys from patches', () => {
    expect(v.patch({ script: 'a', stage: 'published', channelId: 9 })).toEqual({ script: 'a' });
    expect(() => v.patch({ title: '' })).toThrow(/required/);
  });
});

describe('data directory', () => {
  const defaultDir = 'F:\\Users\\x\\AppData\\AI Media Operations';
  const base = { defaultUserData: () => defaultDir, installDir: 'F:\\Apps\\AIMO', isPackaged: true };
  it('defaults to the per-user data dir', () => {
    expect(resolveDataDir({ ...base, env: {} })).toBe(path.resolve(defaultDir));
  });
  it('honours the env override without touching the default dir', () => {
    const untouched = () => {
      throw new Error('default dir must not be resolved');
    };
    expect(resolveDataDir({ ...base, defaultUserData: untouched, env: { [DATA_DIR_ENV]: 'F:\\Data\\AIMO' } })).toBe(
      path.resolve('F:\\Data\\AIMO')
    );
  });
  it('refuses a data dir inside the installation directory', () => {
    expect(() => resolveDataDir({ ...base, env: { [DATA_DIR_ENV]: 'F:\\Apps\\AIMO\\data' } })).toThrow(/installation/);
    expect(() => resolveDataDir({ ...base, env: { [DATA_DIR_ENV]: 'F:\\Apps\\AIMO' } })).toThrow(/installation/);
  });
  it('allows sibling folders with a shared prefix', () => {
    expect(resolveDataDir({ ...base, env: { [DATA_DIR_ENV]: 'F:\\Apps\\AIMO-data' } })).toBe(path.resolve('F:\\Apps\\AIMO-data'));
  });
});

describe('media URL resolution', () => {
  const root = path.resolve('/media-root/productions');
  it('maps production media URLs into that production folder', () => {
    expect(resolveMediaPath(root, 'omnicore-media://p/3/images/scene-01.jpg?v=2')).toBe(path.resolve(root, '3', 'images', 'scene-01.jpg'));
  });
  it('keeps URL-normalised dot segments inside the productions folder', () => {
    // The URL parser resolves %2E%2E itself; the result can only be another production's file.
    expect(resolveMediaPath(root, 'omnicore-media://p/3/%2E%2E/4/final.mp4')).toBe(path.resolve(root, '4', 'final.mp4'));
    expect(resolveMediaPath(root, 'omnicore-media://p/3/%2E%2E/%2E%2E/x.db')).toBeNull();
  });
  it('rejects traversal, other hosts and malformed ids', () => {
    for (const u of [
      'omnicore-media://p/3/..%2F..%2Fai-media-operations.db',
      'omnicore-media://p/3/images/..%5C..%5Cx.db',
      'omnicore-media://p/3/C%3A%5CWindows%5Cwin.ini',
      'omnicore-media://x/3/final.mp4',
      'omnicore-media://p/abc/final.mp4',
      'omnicore-media://p/3',
      'omnicore-media://p/3/%E0%A4%A'
    ]) {
      expect(resolveMediaPath(root, u), u).toBeNull();
    }
  });
});
