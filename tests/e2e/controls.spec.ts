import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const repository = resolve(import.meta.dirname, '../..');
const harness = resolve(import.meta.dirname, 'fixtures/fake-codex.mjs');
const port = 4321;
const address = `http://127.0.0.1:${port}`;
let server: ChildProcess;
let directory: string;
let logFile: string;
let serverOutput = '';

function count(method: string): number {
  try {
    return readFileSync(logFile, 'utf8')
      .split('\n')
      .filter((line) => line === method).length;
  } catch {
    return 0;
  }
}

test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'thrallwright-controls-'));
  logFile = join(directory, 'harness.log');
  server = spawn(
    process.execPath,
    [
      'apps/server/dist/cli.js',
      '--workspace',
      directory,
      '--profile-dir',
      join(directory, 'profile'),
      '--port',
      String(port),
      '--codex',
      harness,
      '--no-open',
    ],
    {
      cwd: repository,
      stdio: 'pipe',
      env: {
        ...process.env,
        THRALLWRIGHT_FAKE_CODEX_LOG: logFile,
        THRALLWRIGHT_FAKE_CODEX_SAVED: '1',
      },
    },
  );
  server.stdout?.on('data', (chunk: Buffer) => {
    serverOutput += chunk.toString();
  });
  server.stderr?.on('data', (chunk: Buffer) => {
    serverOutput += chunk.toString();
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null)
      throw new Error(`Server exited: ${serverOutput}`);
    try {
      if ((await fetch(`${address}/api/health`)).ok) return;
    } catch {
      /* Starting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for service: ${serverOutput}`);
});

test.afterAll(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    const closed = once(server, 'close');
    server.kill();
    await closed;
  }
  if (directory) rmSync(directory, { recursive: true, force: true });
});

test('controls require clicks, and known approvals allow only one response', async ({
  page,
}) => {
  await page.goto(address);
  await expect(page.getByText('Authentication: ready.')).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Saved conversation/ }),
  ).toBeVisible();
  expect(count('thread/resume')).toBe(0);
  expect(count('turn/start')).toBe(0);

  await page.reload();
  expect(count('thread/resume')).toBe(0);
  await page.getByRole('button', { name: 'Resume saved conversation' }).click();
  await expect.poll(() => count('thread/resume')).toBe(1);
  const input = page.getByRole('textbox', {
    name: 'Input for this idle session',
  });
  await expect(input).toBeVisible();
  await page.reload();
  expect(count('thread/resume')).toBe(1);

  await input.fill('Wait for interrupt');
  await page.getByRole('button', { name: 'Send input' }).click();
  await expect.poll(() => count('turn/start')).toBe(1);
  await expect(
    page.getByRole('button', { name: /Interrupt active turn/ }),
  ).toBeVisible();
  await page.reload();
  expect(count('turn/start')).toBe(1);
  await page.getByRole('button', { name: /Interrupt active turn/ }).click();
  await expect.poll(() => count('turn/interrupt')).toBe(1);
  await expect(input).toBeVisible();
  await page.reload();
  expect(count('turn/interrupt')).toBe(1);

  await input.fill('Request command approval');
  await page.getByRole('button', { name: 'Send input' }).click();
  await expect(
    page.locator('.approval-item').filter({ hasText: 'Command' }),
  ).toContainText(
    'Session: fixture-saved-thread · Turn: fixture-turn-2 · Item: approval-item-1',
  );
  await page.getByRole('button', { name: 'View session activity' }).click();
  expect(count('approval/response:accept')).toBe(0);
  await expect(
    page
      .locator('.approval-item')
      .filter({ hasText: 'Command' })
      .getByRole('button', { name: 'Allow once' }),
  ).toBeVisible();
  await page
    .locator('.approval-item')
    .filter({ hasText: 'Command' })
    .getByRole('button', { name: 'Allow once' })
    .click();
  await expect.poll(() => count('approval/response:accept')).toBe(1);
  await expect(page.getByRole('button', { name: 'Allow once' })).toHaveCount(0);
  await page.reload();
  expect(count('approval/response:accept')).toBe(1);

  await input.fill('Request file approval');
  await page.getByRole('button', { name: 'Send input' }).click();
  await expect(
    page
      .locator('.approval-item')
      .filter({ hasText: 'File change' })
      .getByRole('button', { name: 'Decline' }),
  ).toBeVisible();
  await page
    .locator('.approval-item')
    .filter({ hasText: 'File change' })
    .getByRole('button', { name: 'Decline' })
    .click();
  await expect.poll(() => count('approval/response:decline')).toBe(1);

  await input.fill('Request stale approval');
  await page.getByRole('button', { name: 'Send input' }).click();
  await expect(
    page.locator('.approval-item').filter({ hasText: /resolved|stale/ }),
  ).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Allow once' })).toHaveCount(0);
  expect(count('approval/response:accept')).toBe(1);

  await input.fill('Request unsupported approval');
  await page.getByRole('button', { name: 'Send input' }).click();
  await expect(page.getByText('Unsupported request')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow once' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Decline' })).toHaveCount(0);
});
