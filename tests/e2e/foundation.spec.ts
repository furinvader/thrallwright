import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const repository = resolve(import.meta.dirname, '../..');
const port = 4319;
const address = `http://127.0.0.1:${port}`;
let server: ChildProcess;
let testDirectory: string;

test.beforeAll(async () => {
  testDirectory = mkdtempSync(join(tmpdir(), 'thrallwright-e2e-'));
  server = spawn(
    process.execPath,
    [
      'apps/server/dist/cli.js',
      '--workspace',
      testDirectory,
      '--profile-dir',
      join(testDirectory, 'profile'),
      '--port',
      String(port),
      '--codex',
      join(testDirectory, 'missing-codex'),
      '--no-open',
    ],
    { cwd: repository, stdio: 'pipe' },
  );

  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null)
      throw new Error(`Server exited with status ${server.exitCode}`);
    try {
      const response = await fetch(`${address}/api/health`);
      if (response.ok) return;
    } catch {
      /* Still starting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the local service');
});

test.afterAll(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    const closed = once(server, 'close');
    server.kill();
    await closed;
  }
  if (testDirectory) rmSync(testDirectory, { recursive: true, force: true });
});

test('shows the workspace and a truthful unavailable Codex state', async ({
  page,
}) => {
  await page.goto(address);
  await expect(
    page.getByRole('heading', { name: 'Agent work, in view.' }),
  ).toBeVisible();
  await expect(page.getByText(testDirectory, { exact: true })).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'Connected' }),
  ).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'Unavailable' }),
  ).toBeVisible();
  await expect(page.getByText('Codex integration')).toBeVisible();
});
