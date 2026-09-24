import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    ...devices['Desktop Chrome'],
    launchOptions: process.env.THRALLWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.THRALLWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
});
