import type { Kysely } from 'kysely';
import { approvalSchema, type Approval } from '@thrallwright/contracts';
import type { AppDatabase } from './database.js';

export function approvalStore(db: Kysely<AppDatabase>, workspace: string) {
  return {
    async load() {
      const rows = await db
        .selectFrom('approval_cache')
        .selectAll()
        .where('workspace', '=', workspace)
        .orderBy('updated_at', 'desc')
        .limit(100)
        .execute();
      return rows.map((row) => ({
        ...approvalSchema.parse(JSON.parse(row.payload)),
        actionable: false,
      }));
    },
    async save(approvals: Approval[]) {
      await db.transaction().execute(async (tx) => {
        const retained = [...approvals]
          .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
          .slice(0, 100);
        await tx
          .deleteFrom('approval_cache')
          .where('workspace', '=', workspace)
          .execute();
        for (const approval of retained)
          await tx
            .insertInto('approval_cache')
            .values({
              workspace,
              id: approval.id,
              payload: JSON.stringify({ ...approval, actionable: false }),
              updated_at: approval.observedAt,
            })
            .execute();
      });
    },
  };
}
