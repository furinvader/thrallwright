import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { join } from 'node:path';
import { Subscription, Subject, auditTime } from 'rxjs';
import {
  clientMessageSchema,
  type Integration,
  type SnapshotMessage,
} from '@thrallwright/contracts';
import { createStorage, type StoragePaths } from './storage/paths.js';
import { openDatabase } from './storage/database.js';
import type { CodexAdapter } from './integrations/codex.js';
import { createSessionService } from './features/sessions/sessions.js';
import { createWorkflowSource } from './features/workflow/workflow.js';
import { observationStore } from './storage/observations.js';
import { commandJournal } from './features/commands/journal.js';
import { createCommandService } from './features/commands/commands.js';

export interface ApplicationOptions {
  workspace: string;
  paths: StoragePaths;
  codex: CodexAdapter;
  webRoot?: string;
  devOrigin?: string;
  workflowPath?: string;
}
export async function createApplication(options: ApplicationOptions) {
  await createStorage(options.paths);
  const db = await openDatabase(
    join(options.paths.data, 'thrallwright.sqlite'),
  );
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });
  const subscriptions = new Subscription();
  let sessions: ReturnType<typeof createSessionService> | undefined;
  let commands: ReturnType<typeof createCommandService> | undefined;
  let workflow: ReturnType<typeof createWorkflowSource> | undefined;
  let saveQueue: Promise<void> = Promise.resolve();
  const store = observationStore(db, options.workspace);
  const saveSessions = () => {
    if (!sessions) return Promise.resolve();
    const snapshot = sessions.getSnapshot().sessions;
    saveQueue = saveQueue.catch(() => {}).then(() => store.save(snapshot));
    return saveQueue;
  };
  app.addHook('onClose', async () => {
    subscriptions.unsubscribe();
    try {
      await options.codex.close();
    } finally {
      try {
        await commands?.close();
        sessions?.close();
        await workflow?.close();
        await saveSessions();
      } finally {
        await db.destroy();
      }
    }
  });
  try {
    const now = new Date().toISOString();
    const savedWorkspace = await db
      .selectFrom('workspaces')
      .selectAll()
      .where('path', '=', options.workspace)
      .executeTakeFirst();
    const workflowPath =
      options.workflowPath ?? savedWorkspace?.workflow_path ?? null;
    await db
      .insertInto('workspaces')
      .values({
        path: options.workspace,
        last_opened_at: now,
        workflow_path: workflowPath,
      })
      .onConflict((col) =>
        col
          .column('path')
          .doUpdateSet({ last_opened_at: now, workflow_path: workflowPath }),
      )
      .execute();
    let integration: Integration = {
      state: 'connecting',
      detail: 'Connecting to Codex.',
    };
    let revision = 0;
    let storageProblem: string | null = null;
    const changes = new Subject<void>();
    const changed = () => {
      revision++;
      changes.next();
    };
    const storageFailure = (message: string) => {
      storageProblem = message;
      changed();
    };
    sessions = createSessionService({
      workspace: options.workspace,
      codex: options.codex,
      initialSessions: await store.load(),
    });
    workflow = createWorkflowSource(workflowPath);
    const journal = commandJournal(db, options.workspace);
    commands = createCommandService({
      workspace: options.workspace,
      codex: options.codex,
      sessions,
      journal,
      initial: await journal.load(),
      saveSessions,
      storageFailure,
    });
    const snapshot = (): SnapshotMessage => ({
      type: 'snapshot',
      revision,
      workspace: options.workspace,
      integration,
      sessions: sessions!.getSnapshot().sessions,
      discovery: sessions!.getSnapshot().discovery,
      workflow: workflow!.getSnapshot(),
      commands: commands!.getSnapshot(),
      capabilities: {
        startSession: integration.state === 'available' && !storageProblem,
      },
      storageProblem,
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
          const message = command.data;
          const report = (error: unknown) => {
            if (socket.readyState === 1)
              socket.send(
                JSON.stringify({
                  type: 'error',
                  message:
                    error instanceof Error ? error.message : 'Request failed.',
                  ...(message.type === 'command'
                    ? {
                        commandId: message.id,
                        disposition:
                          commands!
                            .getSnapshot()
                            .find((record) => record.id === message.id)
                            ?.phase === 'uncertain'
                            ? 'uncertain'
                            : 'rejected',
                      }
                    : {}),
                }),
              );
          };
          if (message.type === 'command') {
            if (storageProblem)
              report(
                new Error(
                  'Application storage is unavailable. Nothing was sent.',
                ),
              );
            else void commands!.handle(message).catch(report);
          } else if (message.type === 'inspect') {
            void sessions!.readHistory(message.sessionId).catch(report);
          } else {
            void Promise.all([sessions!.refresh(), workflow!.refresh()]).catch(
              report,
            );
            socket.send(JSON.stringify(snapshot()));
          }
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
    subscriptions.add(
      changes.pipe(auditTime(50)).subscribe(() => {
        const message = JSON.stringify(snapshot());
        for (const client of app.websocketServer.clients) {
          if (client.bufferedAmount > 8 * 1024 * 1024) client.terminate();
          else if (client.readyState === 1) client.send(message);
        }
      }),
    );
    subscriptions.add(
      options.codex.state$.subscribe((next) => {
        integration = next;
        changed();
      }),
    );
    subscriptions.add(sessions.state$.subscribe(changed));
    subscriptions.add(workflow.state$.subscribe(changed));
    subscriptions.add(commands.state$.subscribe(changed));
    subscriptions.add(
      sessions.state$.pipe(auditTime(500)).subscribe(() => {
        void saveSessions().catch(() =>
          storageFailure(
            'Session activity could not be saved. Check application storage.',
          ),
        );
      }),
    );
    if (options.webRoot) {
      await app.register(staticFiles, { root: options.webRoot });
    }
    app.addHook('onReady', async () => {
      void workflow!.refresh();
      void options.codex.start().catch(() => {
        integration = {
          state: 'unavailable',
          detail: 'Codex connection failed.',
        };
        changed();
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
