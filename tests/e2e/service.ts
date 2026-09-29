import { test as base, expect } from '@playwright/test';
import { startService, type ServiceOptions } from './service-process';

export const test = base.extend<{
  serviceOptions: ServiceOptions;
  service: Awaited<ReturnType<typeof startService>>;
}>({
  serviceOptions: [{}, { option: true }],
  service: async ({ serviceOptions }, use) => {
    const service = await startService(serviceOptions);
    try {
      await use(service);
    } finally {
      await service.dispose();
    }
  },
});
export { expect };
