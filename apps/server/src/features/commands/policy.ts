import type { Session } from '@thrallwright/contracts';

/** Capabilities are derived from current evidence; cached flags grant nothing. */
export function sessionCapabilities(
  session: Session,
  available: boolean,
  authenticated: boolean,
) {
  const known = session.history.state !== 'deleted';
  const live =
    available && session.controllable && session.freshness === 'live';
  return {
    resume:
      available &&
      authenticated &&
      known &&
      !session.ephemeral &&
      session.freshness !== 'live',
    input:
      live &&
      authenticated &&
      session.status === 'idle' &&
      session.activeTurnId === null,
    interrupt:
      live &&
      session.activeTurnId !== null &&
      (session.status === 'running' || session.status === 'waiting'),
  };
}

export function outcomeTransition(operation: string, outcome: string) {
  if (operation === 'interrupt')
    return {
      phase: 'completed' as const,
      detail:
        outcome === 'interrupted'
          ? 'Codex confirmed that the target turn was interrupted.'
          : `The target turn ${outcome}; interruption was not observed.`,
    };
  return {
    phase: 'completed' as const,
    detail: `Codex confirmed the ${operation === 'start' ? 'initial ' : ''}turn ${outcome}.`,
  };
}
