import Database from 'better-sqlite3';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Kysely, Migrator, SqliteDialect, type Generated } from 'kysely';

export interface WorkspaceRow {
  path: string;
  last_opened_at: string;
  workflow_path: Generated<string | null>;
}
export interface SessionRow {
  workspace: string;
  id: string;
  metadata: string;
  owned: number;
  updated_at: string;
}
export interface ActivityCacheRow {
  workspace: string;
  session_id: string;
  payload: string;
  updated_at: string;
}
export interface CommandRow {
  workspace: string;
  id: string;
  fingerprint: string;
  record: string;
  updated_at: string;
}
export interface AppDatabase {
  workspaces: WorkspaceRow;
  sessions: SessionRow;
  activity_cache: ActivityCacheRow;
  commands: CommandRow;
}
export async function openDatabase(
  filename: string,
): Promise<Kysely<AppDatabase>> {
  if (filename !== ':memory:') {
    const file = await open(
      filename,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      if (!(await file.stat()).isFile())
        throw new Error('Database must be a regular file.');
      await file.chmod(0o600);
    } finally {
      await file.close();
    }
  }
  const sqlite = new Database(filename);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 1000');
  const db = new Kysely<AppDatabase>({
    dialect: new SqliteDialect({ database: sqlite }),
  });
  const migrator = new Migrator({
    db,
    provider: {
      getMigrations: async () => ({
        '001_workspaces': {
          up: async (migrationDb: Kysely<unknown>) => {
            await migrationDb.schema
              .createTable('workspaces')
              .addColumn('path', 'text', (col) => col.primaryKey())
              .addColumn('last_opened_at', 'text', (col) => col.notNull())
              .execute();
          },
        },
        '002_observation': {
          up: async (migrationDb: Kysely<unknown>) => {
            await migrationDb.schema
              .alterTable('workspaces')
              .addColumn('workflow_path', 'text')
              .execute();
            await migrationDb.schema
              .createTable('sessions')
              .addColumn('workspace', 'text', (col) => col.notNull())
              .addColumn('id', 'text', (col) => col.notNull())
              .addColumn('metadata', 'text', (col) => col.notNull())
              .addColumn('owned', 'integer', (col) => col.notNull())
              .addColumn('updated_at', 'text', (col) => col.notNull())
              .addPrimaryKeyConstraint('sessions_key', ['workspace', 'id'])
              .execute();
            await migrationDb.schema
              .createTable('activity_cache')
              .addColumn('workspace', 'text', (col) => col.notNull())
              .addColumn('session_id', 'text', (col) => col.notNull())
              .addColumn('payload', 'text', (col) => col.notNull())
              .addColumn('updated_at', 'text', (col) => col.notNull())
              .addPrimaryKeyConstraint('cache_key', ['workspace', 'session_id'])
              .execute();
            await migrationDb.schema
              .createTable('commands')
              .addColumn('workspace', 'text', (col) => col.notNull())
              .addColumn('id', 'text', (col) => col.notNull())
              .addColumn('fingerprint', 'text', (col) => col.notNull())
              .addColumn('record', 'text', (col) => col.notNull())
              .addColumn('updated_at', 'text', (col) => col.notNull())
              .addPrimaryKeyConstraint('commands_key', ['workspace', 'id'])
              .execute();
          },
        },
      }),
    },
  });
  const { error } = await migrator.migrateToLatest();
  if (error) {
    await db.destroy();
    throw error;
  }
  return db;
}
