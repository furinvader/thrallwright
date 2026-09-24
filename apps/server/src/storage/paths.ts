import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { chmod, mkdir } from 'node:fs/promises';

export interface StoragePaths {
  config: string;
  data: string;
  state: string;
  cache: string;
}
export function storagePaths(
  profile?: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): StoragePaths {
  if (profile) {
    const root = resolve(profile);
    return {
      config: join(root, 'config'),
      data: join(root, 'data'),
      state: join(root, 'state'),
      cache: join(root, 'cache'),
    };
  }
  const base = (variable: string, fallback: string) => {
    const value = env[variable];
    return join(
      value && isAbsolute(value) ? value : join(home, fallback),
      'thrallwright',
    );
  };
  return {
    config: base('XDG_CONFIG_HOME', '.config'),
    data: base('XDG_DATA_HOME', '.local/share'),
    state: base('XDG_STATE_HOME', '.local/state'),
    cache: base('XDG_CACHE_HOME', '.cache'),
  };
}
export async function createStorage(paths: StoragePaths): Promise<void> {
  await Promise.all(
    Object.values(paths).map(async (path) => {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chmod(path, 0o700);
    }),
  );
}
