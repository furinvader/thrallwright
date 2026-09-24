import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const repository = resolve(import.meta.dirname, '../..');
const harness = resolve(import.meta.dirname, 'fixtures/fake-codex.mjs');
const port = 4320;
const address = `http://127.0.0.1:${port}`;
let server: ChildProcess;
let directory: string;
let workflowFile: string;
let logFile: string;
let serverOutput = '';

function countHarnessCalls(method: string): number {
  try {
    return readFileSync(logFile, 'utf8')
      .split('\n')
      .filter((line) => line === method).length;
  } catch {
    return 0;
  }
}

test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'thrallwright-observation-'));
  workflowFile = join(directory, 'workflow.json');
  logFile = join(directory, 'harness.log');
  writeFileSync(
    workflowFile,
    JSON.stringify({ stage: 'review', tasks: ['inspect', { done: false }] }),
  );
  server = spawn(
    process.execPath,
    [
      'apps/server/dist/cli.js',
      '--workspace',
      directory,
      '--profile-dir',
      join(directory, 'profile'),
      '--workflow',
      workflowFile,
      '--port',
      String(port),
      '--codex',
      harness,
      '--no-open',
    ],
    {
      cwd: repository,
      stdio: 'pipe',
      env: { ...process.env, THRALLWRIGHT_FAKE_CODEX_LOG: logFile },
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
      /* Still starting. */
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

test('starts explicitly, observes activity, and inspects independent workflow JSON', async ({
  page,
}) => {
  await page.goto(address);
  await expect(page.getByText(directory, { exact: true })).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'Available' }),
  ).toBeVisible();
  const inspector = page.locator('[aria-label="Workflow JSON"]');
  await expect(inspector).toContainText('"stage": "review"');
  await expect(inspector).toContainText('"done": false');
  expect(countHarnessCalls('thread/start')).toBe(0);

  const task = 'Summarize the fixture workspace';
  await page.getByRole('textbox', { name: 'Initial task' }).fill(task);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(
    page.getByRole('button', { name: /Browser test session/ }),
  ).toBeVisible();
  await expect(
    page.getByText('Fixture agent observed the task.'),
  ).toBeVisible();
  await expect(
    page.locator('.activity-text').filter({ hasText: task }),
  ).toBeVisible();
  expect(countHarnessCalls('thread/start')).toBe(1);
  expect(countHarnessCalls('turn/start')).toBe(1);

  await page.reload();
  await expect(
    page.getByText('Fixture agent observed the task.'),
  ).toBeVisible();
  expect(countHarnessCalls('thread/start')).toBe(1);
  expect(countHarnessCalls('thread/read')).toBeGreaterThan(0);
  const readsBeforeRefresh = countHarnessCalls('thread/read');
  await page.getByRole('button', { name: 'Refresh activity' }).click();
  await expect
    .poll(() => countHarnessCalls('thread/read'))
    .toBeGreaterThan(readsBeforeRefresh);

  writeFileSync(workflowFile, '{');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('.workflow-card').getByRole('alert')).toBeVisible();
  expect(readFileSync(workflowFile, 'utf8')).toBe('{');

  writeFileSync(workflowFile, '42');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(inspector).toHaveText('42');
  writeFileSync(workflowFile, 'null');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(inspector).toHaveText('null');
  writeFileSync(
    workflowFile,
    '{"large":900719925474099312345,"exponent":1e400}',
  );
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(inspector).toContainText('900719925474099312345');
  await expect(inspector).toContainText('1e400');

  const closed = once(server, 'close');
  server.kill();
  await closed;
  await expect(page.getByText(/last known information/i)).toBeVisible();
  await expect(page.locator('.detail-heading .pill')).toContainText(
    'Last reported:',
  );
});
