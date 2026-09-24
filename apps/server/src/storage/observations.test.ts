import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import type { Activity, Session } from '@thrallwright/contracts';
import { openDatabase, type AppDatabase } from './database.js';
import {
  observationStore,
  CACHE_BYTES,
  CACHE_SESSIONS,
} from './observations.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'thrallwright-observations-'));
  let db = await openDatabase(join(directory, 'application.sqlite'));
  cleanups.push(async () => {
    await db.destroy();
    await rm(directory, { recursive: true, force: true });
  });
  const workspace = '/project';
  await db
    .insertInto('workspaces')
    .values({ path: workspace, last_opened_at: '2026-09-25T00:00:00Z' })
    .execute();
  return {
    get db() {
      return db;
    },
    workspace,
    async reopen() {
      await db.destroy();
      db = await openDatabase(join(directory, 'application.sqlite'));
      return db;
    },
  };
}

function activity(id: string, text = 'Observed work.'): Activity {
  return {
    id,
    turnId: 'turn-1',
    kind: 'assistant',
    text,
    complete: true,
    origin: 'live',
    observedAt: '2026-09-25T00:00:00Z',
  };
}

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    parentThreadId: null,
    ephemeral: false,
    owned: true,
    controllable: true,
    status: 'running',
    freshness: 'live',
    activeTurnId: 'turn-1',
    latestTurnOutcome: null,
    observedAt: '2026-09-25T00:00:00Z',
    history: { state: 'ready', complete: true, detail: 'Source history.' },
    activities: [activity(`${id}-item`)],
    ...overrides,
  };
}

describe('observation storage', () => {
  it('reloads cached history without reviving live controls or source freshness', async () => {
    const context = await fixture();
    const store = observationStore(context.db, context.workspace);
    await store.save([
      session('owned'),
      session('external', {
        owned: false,
        controllable: false,
        status: 'historical',
        freshness: 'history',
      }),
    ]);

    const reopened = observationStore(
      await context.reopen(),
      context.workspace,
    );
    const loaded = await reopened.load();
    const owned = loaded.find((item) => item.id === 'owned');
    const external = loaded.find((item) => item.id === 'external');
    expect(owned).toMatchObject({
      status: 'disconnected',
      freshness: 'cached',
      controllable: false,
      activeTurnId: null,
    });
    expect(external).toMatchObject({
      status: 'historical',
      freshness: 'cached',
      controllable: false,
      activeTurnId: null,
    });
    expect(owned?.history.complete).toBe(false);
    expect(owned?.activities).toMatchObject([
      { id: 'owned-item', origin: 'cache' },
    ]);
    expect(external?.activities).toMatchObject([
      { id: 'external-item', origin: 'cache' },
    ]);
  });

  it('excludes ephemeral sessions and their activity from durable storage', async () => {
    const context = await fixture();
    const store = observationStore(context.db, context.workspace);
    await store.save([session('temporary', { ephemeral: true })]);
    expect(await store.load()).toEqual([]);
    expect(
      await context.db.selectFrom('sessions').selectAll().execute(),
    ).toEqual([]);
    expect(
      await context.db.selectFrom('activity_cache').selectAll().execute(),
    ).toEqual([]);
  });

  it('purges a previously cached session when it becomes ephemeral', async () => {
    const context = await fixture();
    const store = observationStore(context.db, context.workspace);
    await store.save([session('became-temporary')]);
    expect(
      await context.db.selectFrom('sessions').selectAll().execute(),
    ).toHaveLength(1);
    expect(
      await context.db.selectFrom('activity_cache').selectAll().execute(),
    ).toHaveLength(1);

    await store.save([session('became-temporary', { ephemeral: true })]);
    expect(await store.load()).toEqual([]);
    expect(
      await context.db.selectFrom('sessions').selectAll().execute(),
    ).toEqual([]);
    expect(
      await context.db.selectFrom('activity_cache').selectAll().execute(),
    ).toEqual([]);
  });

  it('evicts the oldest activity after the session limit while preserving owned metadata and journal', async () => {
    const context = await fixture();
    await context.db
      .insertInto('commands')
      .values({
        workspace: context.workspace,
        id: 'command-1',
        fingerprint: 'fingerprint',
        record: '{}',
        updated_at: '2026-09-25T00:00:00Z',
      })
      .execute();
    await context.db
      .updateTable('workspaces')
      .set({ workflow_path: '/project/tasks.json' })
      .where('path', '=', context.workspace)
      .execute();
    const sessions = Array.from({ length: CACHE_SESSIONS + 1 }, (_, index) =>
      session(`owned-${index}`, {
        observedAt: new Date(Date.UTC(2026, 8, 25, 0, 0, index)).toISOString(),
      }),
    );
    const store = observationStore(context.db, context.workspace);
    await store.save(sessions);

    const loaded = await store.load();
    expect(loaded).toHaveLength(CACHE_SESSIONS + 1);
    expect(loaded.find((item) => item.id === 'owned-0')).toMatchObject({
      status: 'disconnected',
      activities: [],
    });
    expect(
      loaded.find((item) => item.id === `owned-${CACHE_SESSIONS}`)?.activities,
    ).toHaveLength(1);
    expect(
      await context.db.selectFrom('activity_cache').selectAll().execute(),
    ).toHaveLength(CACHE_SESSIONS);
    expect(
      await context.db.selectFrom('commands').selectAll().execute(),
    ).toHaveLength(1);
    expect(
      (
        await context.db
          .selectFrom('workspaces')
          .select('workflow_path')
          .executeTakeFirstOrThrow()
      ).workflow_path,
    ).toBe('/project/tasks.json');
  });

  it('applies the byte limit without deleting owned session metadata', async () => {
    const context = await fixture();
    const store = observationStore(context.db, context.workspace);
    const largeText = 'x'.repeat(Math.floor(CACHE_BYTES / 2) + 1000);
    await store.save([
      session('older', {
        observedAt: '2026-09-25T00:00:00Z',
        activities: [activity('old', largeText)],
      }),
      session('newer', {
        observedAt: '2026-09-25T00:00:01Z',
        activities: [activity('new', largeText)],
      }),
    ]);
    const loaded = await store.load();
    expect(loaded).toHaveLength(2);
    expect(loaded.find((item) => item.id === 'older')?.activities).toEqual([]);
    expect(loaded.find((item) => item.id === 'newer')?.activities).toHaveLength(
      1,
    );
  });

  it('purges cached activity after an explicit source deletion', async () => {
    const context = await fixture();
    const store = observationStore(context.db, context.workspace);
    await store.save([session('deleted-later')]);
    expect(
      await context.db.selectFrom('activity_cache').selectAll().execute(),
    ).toHaveLength(1);

    await store.save([
      session('deleted-later', {
        history: {
          state: 'deleted',
          complete: false,
          detail: 'Deleted in Codex.',
        },
        activities: [],
      }),
    ]);
    expect(
      await context.db.selectFrom('activity_cache').selectAll().execute(),
    ).toEqual([]);
    expect((await store.load())[0]).toMatchObject({
      id: 'deleted-later',
      history: { state: 'deleted' },
      activities: [],
    });
  });
});

describe('observation migration', () => {
  it('upgrades an existing workspace row and persists its workflow configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'thrallwright-migration-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const filename = join(directory, 'legacy.sqlite');
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE workspaces (path TEXT PRIMARY KEY, last_opened_at TEXT NOT NULL);
      INSERT INTO workspaces VALUES ('/existing', '2026-09-24T00:00:00Z');
      CREATE TABLE kysely_migration (name TEXT PRIMARY KEY, timestamp TEXT NOT NULL);
      INSERT INTO kysely_migration VALUES ('001_workspaces', '2026-09-24T00:00:00Z');
    `);
    legacy.close();

    let db: Kysely<AppDatabase> = await openDatabase(filename);
    await db
      .updateTable('workspaces')
      .set({ workflow_path: '/existing/tasks.json' })
      .where('path', '=', '/existing')
      .execute();
    await db.destroy();
    db = await openDatabase(filename);
    expect(
      await db.selectFrom('workspaces').selectAll().execute(),
    ).toMatchObject([
      {
        path: '/existing',
        last_opened_at: '2026-09-24T00:00:00Z',
        workflow_path: '/existing/tasks.json',
      },
    ]);
    expect(await db.selectFrom('sessions').selectAll().execute()).toEqual([]);
    await db.destroy();
  });
});
