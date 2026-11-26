import path from 'node:path';

export const DATA_DIR_ENV = 'AIMO_DATA_DIR';

export interface DataDirInput {
  env: Record<string, string | undefined>;
  /**
   * Electron's default per-user data dir. Lazy: app.getPath('userData') creates
   * the folder, so it is only called when no override is configured.
   */
  defaultUserData: () => string;
  /** Directory containing the running executable (the installation directory when packaged). */
  installDir: string;
  isPackaged: boolean;
}

const isInside = (child: string, parent: string): boolean => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * Resolve where all user data (database, media, Chromium profile) lives.
 * Order: AIMO_DATA_DIR env var, then Electron's per-user default.
 * Data must never live inside the installation directory: updates and
 * uninstalls replace that folder.
 */
export function resolveDataDir(i: DataDirInput): string {
  const fromEnv = i.env[DATA_DIR_ENV]?.trim();
  const dir = path.resolve(fromEnv ? fromEnv : i.defaultUserData());
  if (i.isPackaged && isInside(dir, i.installDir)) {
    throw new Error(`Data directory ${dir} is inside the installation directory ${i.installDir}.`);
  }
  return dir;
}
