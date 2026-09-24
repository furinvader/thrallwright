import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { join } from 'node:path';
import type { Subscription } from 'rxjs';
import {
  clientMessageSchema,
  type Integration,
  type SnapshotMessage,
} from '@thrallwright/contracts';
import { createStorage, type StoragePaths } from './storage/paths.js';
import { openDatabase } from './storage/database.js';
import type { CodexAdapter } from './integrations/codex.js';

export interface ApplicationOptions {
  workspace: string;
  paths: StoragePaths;
  codex: CodexAdapter;
  webRoot?: string;
  devOrigin?: string;
}
export async function createApplication(options: ApplicationOptions) {
  await createStorage(options.paths);
  const db = await openDatabase(
    join(options.paths.data, 'thrallwright.sqlite'),
  );
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });
  let subscription: Subscription | undefined;
  app.addHook('onClose', async () => {
    subscription?.unsubscribe();
    try {
      await options.codex.close();
    } finally {
      await db.destroy();
    }
  });
  try {
    const now = new Date().toISOString();
    await db
      .insertInto('workspaces')
      .values({ path: options.workspace, last_opened_at: now })
      .onConflict((col) =>
        col.column('path').doUpdateSet({ last_opened_at: now }),
      )
      .execute();
    let integration: Integration = {
      state: 'connecting',
      detail: 'Connecting to Codex.',
    };
    let revision = 0;
    const snapshot = (): SnapshotMessage => ({
      type: 'snapshot',
      revision,
      workspace: options.workspace,
      integration,
    });

    // Local control endpoints reject remote browser origins and DNS rebinding hosts.
    app.addHook('onRequest', async (request, reply) => {
      let host: URL;
      try {
        host = new URL(`http://${request.headers.host ?? ''}`);
      } catch {
        return reply.code(400).send({ error: 'Invalid host.' });
      }
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname))
        return reply.code(403).send({ error: 'Local connections only.' });
      const origin = request.headers.origin;
      if (origin && origin !== host.origin && origin !== options.devOrigin)
        return reply.code(403).send({ error: 'Origin is not allowed.' });
    });
    await app.register(websocket, { options: { maxPayload: 1_048_576 } });
    app.get('/api/health', async () => ({ status: 'ok' }));
    app.get('/ws', { websocket: true }, (socket) => {
      // Subscription and synchronous snapshot capture share a JS turn with state updates.
      socket.send(JSON.stringify(snapshot()));
      socket.on('message', (data) => {
        try {
          const command = clientMessageSchema.safeParse(
            JSON.parse(data.toString()),
          );
          if (!command.success) throw new Error('Unsupported message.');
          socket.send(JSON.stringify(snapshot()));
        } catch {
          socket.send(
            JSON.stringify({
              type: 'error',
              message: 'Invalid client message.',
            }),
          );
        }
      });
      socket.on('error', () => socket.terminate());
    });
    const publishIntegration = (next: Integration) => {
      integration = next;
      revision++;
      for (const client of app.websocketServer.clients)
        if (client.readyState === 1) client.send(JSON.stringify(snapshot()));
    };
    subscription = options.codex.state$.subscribe(publishIntegration);
    if (options.webRoot) {
      await app.register(staticFiles, { root: options.webRoot });
    }
    app.addHook('onReady', async () => {
      void options.codex.start().catch(() => {
        publishIntegration({
          state: 'unavailable',
          detail: 'Codex connection failed.',
        });
      });
    });
    app.addHook('preClose', async () => {
      for (const client of app.websocketServer.clients) client.terminate();
    });
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
