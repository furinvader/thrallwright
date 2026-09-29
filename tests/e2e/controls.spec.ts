import { readFileSync } from 'node:fs';
import { expect, test } from './service';

test.use({ serviceOptions: { savedConversation: true } });

test('controls require clicks, and known approvals allow only one response', async ({
  page,
  service,
}) => {
  const { address, harnessLog } = service;
  const count = (method: string) =>
    readFileSync(harnessLog, 'utf8')
      .split('\n')
      .filter((line) => line === method).length;
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
