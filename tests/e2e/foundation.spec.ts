import { expect, test } from './service';

test.use({ serviceOptions: { unavailableCodex: true } });

test('shows the workspace and a truthful unavailable Codex state', async ({
  page,
  service,
}) => {
  await page.goto(service.address);
  await expect(
    page.getByRole('heading', { name: 'Agent work, in view.' }),
  ).toBeVisible();
  await expect(
    page.getByText(service.directory, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'Connected' }),
  ).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'Unavailable' }),
  ).toBeVisible();
  await expect(page.getByText('Codex integration')).toBeVisible();
});
