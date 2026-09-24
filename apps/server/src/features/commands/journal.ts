import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import {
  commandRecordSchema,
  type CommandRecord,
  type StartCommand,
} from '@thrallwright/contracts';
import type { AppDatabase } from '../../storage/database.js';

export interface CommandJournal {
  load(): Promise<CommandRecord[]>;
  begin(
    command: StartCommand,
  ): Promise<{ record: CommandRecord; created: boolean }>;
  update(record: CommandRecord): Promise<void>;
}
export function commandJournal(
  db: Kysely<AppDatabase>,
  workspace: string,
): CommandJournal {
  return {
    async load() {
      const rows = await db
        .selectFrom('commands')
        .selectAll()
        .where('workspace', '=', workspace)
        .orderBy('updated_at', 'desc')
        .execute();
      const records: CommandRecord[] = [];
      for (const row of rows) {
        let record = commandRecordSchema.parse(JSON.parse(row.record));
        if (['intent', 'dispatching', 'accepted'].includes(record.phase)) {
          record = {
            ...record,
            phase: record.phase === 'intent' ? 'rejected' : 'uncertain',
            detail:
              record.phase === 'intent'
                ? 'Service stopped before dispatch. Nothing was sent.'
                : 'Service restarted before the outcome was confirmed. This command will not be resent.',
            updatedAt: new Date().toISOString(),
          };
          await this.update(record);
        }
        records.push(record);
      }
      return records;
    },
    async begin(command) {
      const fingerprint = createHash('sha256')
        .update(JSON.stringify(command))
        .digest('hex');
      const now = new Date().toISOString();
      const record: CommandRecord = {
        id: command.id,
        operation: command.operation,
        targetId: null,
        phase: 'intent',
        detail: 'Intent saved; not dispatched.',
        createdAt: now,
        updatedAt: now,
        resultSessionId: null,
        turnId: null,
      };
      const inserted = await db
        .insertInto('commands')
        .values({
          workspace,
          id: command.id,
          fingerprint,
          record: JSON.stringify(record),
          updated_at: now,
        })
        .onConflict((oc) => oc.columns(['workspace', 'id']).doNothing())
        .executeTakeFirst();
      const row = await db
        .selectFrom('commands')
        .selectAll()
        .where('workspace', '=', workspace)
        .where('id', '=', command.id)
        .executeTakeFirstOrThrow();
      if (row.fingerprint !== fingerprint)
        throw new Error(
          'This command ID was already used for different input. No command was sent.',
        );
      return {
        record: commandRecordSchema.parse(JSON.parse(row.record)),
        created: Number(inserted.numInsertedOrUpdatedRows) > 0,
      };
    },
    async update(record) {
      const result = await db
        .updateTable('commands')
        .set({ record: JSON.stringify(record), updated_at: record.updatedAt })
        .where('workspace', '=', workspace)
        .where('id', '=', record.id)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1)
        throw new Error('Command intent is missing.');
    },
  };
}
