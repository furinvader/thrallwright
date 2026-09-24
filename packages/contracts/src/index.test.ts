import { describe, expect, it } from 'vitest';
import { clientMessageSchema, serverMessageSchema } from './index.js';
describe('wire boundary', () => {
  it('rejects clients publishing authoritative state', () => {
    expect(
      clientMessageSchema.safeParse({ type: 'snapshot', workspace: '/' })
        .success,
    ).toBe(false);
    expect(
      clientMessageSchema.safeParse({ type: 'refresh', command: 'start' })
        .success,
    ).toBe(false);
  });
  it('rejects impossible snapshot revisions and availability states', () => {
    expect(
      serverMessageSchema.safeParse({
        type: 'snapshot',
        revision: -1,
        workspace: '/',
        integration: { state: 'running', detail: '' },
      }).success,
    ).toBe(false);
  });
});
