import { BehaviorSubject, Subscription } from 'rxjs';
import { z } from 'zod';
import type { Auth, Integration } from '@thrallwright/contracts';
import type { CodexAdapter } from '../../integrations/codex.js';

const accountRead = z.object({
  account: z.object({}).passthrough().nullable(),
  requiresOpenaiAuth: z.boolean(),
});

/** Only auth availability is projected; account details remain with Codex. */
export function createAuthService(options: { codex: CodexAdapter }) {
  const state = new BehaviorSubject<Auth>({
    state: 'checking',
    detail: 'Checking Codex authentication.',
  });
  const subscriptions = new Subscription();
  let integration: Integration['state'] = 'connecting';
  let generation = 0;
  let closed = false;

  async function refresh(): Promise<void> {
    if (closed || integration !== 'available') return;
    const current = ++generation;
    state.next({ state: 'checking', detail: 'Checking Codex authentication.' });
    try {
      const response = accountRead.parse(
        await options.codex.request('account/read', { refreshToken: false }),
      );
      if (closed || current !== generation || integration !== 'available')
        return;
      if (!response.requiresOpenaiAuth || response.account !== null) {
        state.next({
          state: 'ready',
          detail: 'Codex authentication is available.',
        });
      } else {
        state.next({
          state: 'required',
          detail:
            'Codex sign-in is required. Run `codex login` in the environment that starts the workbench, then refresh.',
        });
      }
    } catch {
      if (closed || current !== generation || integration !== 'available')
        return;
      state.next({
        state: 'unavailable',
        detail:
          'Codex authentication status could not be checked. Refresh to try again.',
      });
    }
  }

  subscriptions.add(
    options.codex.state$.subscribe((next) => {
      const wasAvailable = integration === 'available';
      integration = next.state;
      if (next.state === 'available') {
        if (!wasAvailable) void refresh();
        return;
      }
      generation++;
      state.next(
        next.state === 'connecting'
          ? { state: 'checking', detail: 'Waiting for Codex to connect.' }
          : {
              state: 'unavailable',
              detail:
                'Codex is disconnected. Authentication must be checked again after reconnecting.',
            },
      );
    }),
  );
  subscriptions.add(
    options.codex.events$.subscribe((event) => {
      if (
        event.method === 'account/updated' ||
        event.method === 'account/login/completed'
      )
        void refresh();
    }),
  );

  return {
    state$: state.asObservable(),
    getSnapshot: () => state.value,
    refresh,
    close() {
      if (closed) return;
      closed = true;
      generation++;
      subscriptions.unsubscribe();
      state.complete();
    },
  };
}
