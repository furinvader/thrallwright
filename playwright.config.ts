import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never' }]],
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    launchOptions: process.env.THRALLWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.THRALLWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
});
