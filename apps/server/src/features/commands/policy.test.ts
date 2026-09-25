import { describe, expect, it } from 'vitest';
import type { Session } from '@thrallwright/contracts';
import { outcomeTransition, sessionCapabilities } from './policy.js';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'thread-1',
    title: 'Session',
    parentThreadId: null,
    ephemeral: false,
    owned: true,
    controllable: true,
    status: 'idle',
    freshness: 'live',
    activeTurnId: null,
    latestTurnOutcome: null,
    observedAt: '2026-09-25T00:00:00Z',
    history: { state: 'ready', complete: true, detail: 'Read.' },
    activities: [],
    ...overrides,
  };
}

describe('session capability policy', () => {
  it('allows input only for a current, owned idle session with auth', () => {
    expect(sessionCapabilities(session(), true, true)).toMatchObject({
      input: true,
      interrupt: false,
      resume: false,
    });
    for (const ineligible of [
      session({ controllable: false }),
      session({ freshness: 'cached' }),
      session({ status: 'running' }),
      session({ activeTurnId: 'turn-1' }),
    ])
      expect(sessionCapabilities(ineligible, true, true).input).toBe(false);
    expect(sessionCapabilities(session(), true, false).input).toBe(false);
    expect(sessionCapabilities(session(), false, true).input).toBe(false);
  });

  it('permits interrupting the known active turn even when auth is not ready', () => {
    const active = session({ status: 'running', activeTurnId: 'turn-1' });
    expect(sessionCapabilities(active, true, false)).toMatchObject({
      input: false,
      interrupt: true,
    });
    expect(
      sessionCapabilities(
        session({ status: 'waiting', activeTurnId: 'turn-1' }),
        true,
        false,
      ).interrupt,
    ).toBe(true);
    expect(sessionCapabilities(active, false, false).interrupt).toBe(false);
    expect(
      sessionCapabilities(
        session({ ...active, controllable: false }),
        true,
        false,
      ).interrupt,
    ).toBe(false);
  });

  it('requires an explicit, non-ephemeral historical session for resume', () => {
    const historical = session({
      freshness: 'history',
      status: 'historical',
      controllable: false,
    });
    expect(sessionCapabilities(historical, true, true).resume).toBe(true);
    expect(
      sessionCapabilities(
        session({ ...historical, freshness: 'cached' }),
        true,
        true,
      ).resume,
    ).toBe(true);
    expect(
      sessionCapabilities(
        session({ ...historical, ephemeral: true }),
        true,
        true,
      ).resume,
    ).toBe(false);
    expect(
      sessionCapabilities(
        session({
          ...historical,
          history: { state: 'deleted', complete: false, detail: 'Deleted.' },
        }),
        true,
        true,
      ).resume,
    ).toBe(false);
    expect(sessionCapabilities(historical, true, false).resume).toBe(false);
    expect(sessionCapabilities(historical, false, true).resume).toBe(false);
  });

  it('distinguishes an acknowledged interrupt from an observed interruption', () => {
    expect(outcomeTransition('interrupt', 'interrupted')).toMatchObject({
      phase: 'completed',
      detail: expect.stringContaining('was interrupted'),
    });
    expect(outcomeTransition('interrupt', 'completed')).toMatchObject({
      phase: 'completed',
      detail: expect.stringContaining('not observed'),
    });
  });
});
