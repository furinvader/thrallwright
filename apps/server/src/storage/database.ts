import Database from 'better-sqlite3';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Kysely, Migrator, SqliteDialect } from 'kysely';

export interface WorkspaceRow {
  path: string;
  last_opened_at: string;
}
export interface AppDatabase {
  workspaces: WorkspaceRow;
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
