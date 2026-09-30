import { writeFile } from 'node:fs/promises';
import { test as base, expect } from '@playwright/test';
import { startService, type ServiceOptions } from './service-process';

export const test = base.extend<{
  serviceOptions: ServiceOptions;
  service: Awaited<ReturnType<typeof startService>>;
}>({
  serviceOptions: [{}, { option: true }],
  service: async ({ serviceOptions }, use, testInfo) => {
    const attachLog = async (name: string, body: string) => {
      const path = testInfo.outputPath(name);
      await writeFile(path, body);
      await testInfo.attach(name, { path, contentType: 'text/plain' });
    };
    let service: Awaited<ReturnType<typeof startService>>;
    try {
      service = await startService(serviceOptions);
    } catch (error) {
      await attachLog('service-startup.log', String(error));
      throw error;
    }
    try {
      await use(service);
    } finally {
      try {
        if (testInfo.status !== testInfo.expectedStatus) {
          await attachLog('service.log', service.output());
        }
      } finally {
        await service.dispose();
      }
    }
  },
});
export { expect };
