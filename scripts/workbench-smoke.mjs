#!/usr/bin/env node
// Explicit real-model/browser check. Prints only sanitized verification results.
import { chromium, expect } from '@playwright/test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createApplication } from '../apps/server/dist/app.js';
import { CodexProcess } from '../apps/server/dist/integrations/codex.js';
import { storagePaths } from '../apps/server/dist/storage/paths.js';

const { values } = parseArgs({
  options: { workspace: { type: 'string' }, output: { type: 'string' } },
});
const workspace = await realpath(resolve(values.workspace ?? process.cwd()));
const temporary = await mkdtemp(
  join(tmpdir(), 'thrallwright-workbench-smoke-'),
);
const workflowPath = join(temporary, 'workflow.json');
await writeFile(
  workflowPath,
  JSON.stringify({
    stage: 'observation',
    checks: ['live activity', 'workflow', 'reload'],
  }),
);
const codex = new CodexProcess(
  process.env.THRALLWRIGHT_CODEX_EXECUTABLE ?? 'codex',
  workspace,
);
const execution = [];
const originalRequest = codex.request.bind(codex);
codex.request = (method, params) => {
  if (
    ['thread/start', 'thread/resume', 'turn/start', 'turn/interrupt'].includes(
      method,
    )
  )
    execution.push(method);
  return originalRequest(method, params);
};
let app;
let browser;
const report = {
  checkedAt: new Date().toISOString(),
  workspaceKind: 'Thrallwright checkout',
  realCodex: true,
  checks: [],
};
try {
  app = await createApplication({
    workspace,
    workflowPath,
    paths: storagePaths(join(temporary, 'profile')),
    codex,
    webRoot: fileURLToPath(
      new URL('../apps/web/dist/browser/', import.meta.url),
    ),
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.THRALLWRIGHT_CHROMIUM_EXECUTABLE,
  });
  const page = await browser.newPage();
  await page.goto(address);
  await expect(page.getByLabel('Workflow JSON')).toContainText('observation');
  await page
    .getByLabel('Initial task')
    .fill(
      'Reply exactly THRALLWRIGHT_OBSERVATION_OK. Do not run tools or change files.',
    );
  await expect(
    page.getByRole('button', { name: 'Start', exact: true }),
  ).toBeEnabled({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(
    page
      .locator('.activity-item')
      .filter({ has: page.locator('.activity-kind', { hasText: 'assistant' }) })
      .last(),
  ).toContainText('THRALLWRIGHT_OBSERVATION_OK', { timeout: 120_000 });
  await expect(
    page.getByText(/Codex confirmed the initial turn completed/),
  ).toBeVisible({ timeout: 30_000 });
  report.checks.push(
    'Explicit browser start produced real assistant activity and a confirmed turn outcome.',
  );
  if (
    execution.filter((method) => method === 'thread/start').length !== 1 ||
    execution.filter((method) => method === 'turn/start').length !== 1
  )
    throw new Error('Unexpected execution count.');
  await writeFile(workflowPath, 'null');
  await expect(page.getByLabel('Workflow JSON')).toHaveText('null', {
    timeout: 10_000,
  });
  const prior = execution.length;
  await page.reload();
  await expect(
    page
      .locator('.activity-text')
      .filter({ hasText: 'THRALLWRIGHT_OBSERVATION_OK' })
      .last(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel('Workflow JSON')).toHaveText('null');
  if (execution.length !== prior)
    throw new Error('Browser reload changed harness execution.');
  report.checks.push(
    'External scalar/null workflow updates and browser reload preserved observation without execution.',
  );
  report.executionMethods = execution;
  report.success = true;
} finally {
  await browser?.close();
  await app?.close();
  await rm(temporary, { recursive: true, force: true });
}
const serialized = JSON.stringify(report, null, 2) + '\n';
if (values.output) await writeFile(values.output, serialized, { mode: 0o600 });
process.stdout.write(serialized);
