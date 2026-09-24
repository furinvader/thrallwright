import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorage, storagePaths } from './paths.js';
import { openDatabase } from './database.js';
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe('application storage', () => {
  it('uses absolute XDG overrides, ignoring relative values', () => {
    const paths = storagePaths(
      undefined,
      { XDG_DATA_HOME: '/custom/data', XDG_CONFIG_HOME: 'relative' },
      '/home/test',
    );
    expect(paths.data).toBe('/custom/data/thrallwright');
    expect(paths.config).toBe('/home/test/.config/thrallwright');
    expect(paths.state).toBe('/home/test/.local/state/thrallwright');
  });
  it('isolates a profile and retains workspace data when reopening migrations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'thrallwright-storage-'));
    directories.push(directory);
    const paths = storagePaths(directory, { XDG_DATA_HOME: '/not-used' });
    await mkdir(paths.data, { recursive: true });
    await chmod(paths.data, 0o755);
    await createStorage(paths);
    expect((await stat(paths.data)).mode & 0o777).toBe(0o700);
    const filename = join(paths.data, 'thrallwright.sqlite');
    const db = await openDatabase(filename);
    expect((await stat(filename)).mode & 0o777).toBe(0o600);
    await db
      .insertInto('workspaces')
      .values({ path: '/project', last_opened_at: '2026-09-25T00:00:00Z' })
      .execute();
    await db.destroy();
    const reopened = await openDatabase(filename);
    expect(
      await reopened.selectFrom('workspaces').selectAll().execute(),
    ).toHaveLength(1);
    await reopened.destroy();
  });
});
