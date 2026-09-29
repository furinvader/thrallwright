import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from './service';

test.use({
  serviceOptions: {
    workflow: JSON.stringify({
      stage: 'review',
      tasks: ['inspect', { done: false }],
    }),
  },
});

test('starts explicitly, observes activity, and inspects independent workflow JSON', async ({
  page,
  service,
}) => {
  const { address, directory, workflowFile, harnessLog } = service;
  const countHarnessCalls = (method: string) =>
    readFileSync(harnessLog, 'utf8')
      .split('\n')
      .filter((line) => line === method).length;
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

  await service.stop();
  await expect(page.getByText(/last known information/i)).toBeVisible();
  await expect(page.locator('.detail-heading .pill')).toContainText(
    'Last reported:',
  );
});
