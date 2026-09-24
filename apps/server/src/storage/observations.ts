import type { Kysely } from 'kysely';
import {
  activitySchema,
  sessionSchema,
  type Session,
} from '@thrallwright/contracts';
import type { AppDatabase } from './database.js';

export const CACHE_SESSIONS = 20;
export const CACHE_BYTES = 8 * 1024 * 1024;

export function observationStore(db: Kysely<AppDatabase>, workspace: string) {
  return {
    async load(): Promise<Session[]> {
      const rows = await db
        .selectFrom('sessions')
        .selectAll()
        .where('workspace', '=', workspace)
        .orderBy('updated_at', 'desc')
        .execute();
      const cache = await db
        .selectFrom('activity_cache')
        .selectAll()
        .where('workspace', '=', workspace)
        .execute();
      return rows.map((row) => {
        const session = sessionSchema.parse(JSON.parse(row.metadata));
        const stored = cache.find((item) => item.session_id === row.id);
        const activities = stored
          ? activitySchema.array().parse(JSON.parse(stored.payload))
          : [];
        return {
          ...session,
          controllable: false,
          activeTurnId: null,
          freshness: 'cached',
          status: session.owned ? 'disconnected' : 'historical',
          activities: activities.map((item) => ({
            ...item,
            origin: 'cache' as const,
          })),
          history: {
            ...session.history,
            complete: false,
            detail: stored
              ? 'Cached activity; Codex remains authoritative.'
              : 'No cached activity; read Codex history when available.',
          },
        };
      });
    },
    async save(sessions: Session[]) {
      await db.transaction().execute(async (tx) => {
        for (const session of sessions) {
          if (session.ephemeral) {
            await tx
              .deleteFrom('activity_cache')
              .where('workspace', '=', workspace)
              .where('session_id', '=', session.id)
              .execute();
            await tx
              .deleteFrom('sessions')
              .where('workspace', '=', workspace)
              .where('id', '=', session.id)
              .execute();
            continue;
          }
          const metadata = {
            ...session,
            controllable: false,
            activeTurnId: null,
            freshness: 'cached',
            status: session.owned ? 'disconnected' : 'historical',
            activities: [],
          };
          await tx
            .insertInto('sessions')
            .values({
              workspace,
              id: session.id,
              metadata: JSON.stringify(metadata),
              owned: Number(session.owned),
              updated_at: session.observedAt,
            })
            .onConflict((oc) =>
              oc.columns(['workspace', 'id']).doUpdateSet({
                metadata: JSON.stringify(metadata),
                owned: Number(session.owned),
                updated_at: session.observedAt,
              }),
            )
            .execute();
          if (session.history.state === 'deleted') {
            await tx
              .deleteFrom('activity_cache')
              .where('workspace', '=', workspace)
              .where('session_id', '=', session.id)
              .execute();
          } else if (session.activities.length) {
            const payload = JSON.stringify(session.activities);
            await tx
              .insertInto('activity_cache')
              .values({
                workspace,
                session_id: session.id,
                payload,
                updated_at: session.observedAt,
              })
              .onConflict((oc) =>
                oc
                  .columns(['workspace', 'session_id'])
                  .doUpdateSet({ payload, updated_at: session.observedAt }),
              )
              .execute();
          }
        }
        const cached = await tx
          .selectFrom('activity_cache')
          .selectAll()
          .where('workspace', '=', workspace)
          .orderBy('updated_at', 'desc')
          .orderBy('session_id')
          .execute();
        let bytes = 0;
        for (let index = 0; index < cached.length; index++) {
          const row = cached[index]!;
          bytes += Buffer.byteLength(row.payload);
          if (index >= CACHE_SESSIONS || bytes > CACHE_BYTES)
            await tx
              .deleteFrom('activity_cache')
              .where('workspace', '=', workspace)
              .where('session_id', '=', row.session_id)
              .execute();
        }
        const retained = sessions.filter((s) => !s.ephemeral).map((s) => s.id);
        // Discovered metadata can be rebuilt; app-owned records cannot.
        let prune = tx
          .deleteFrom('sessions')
          .where('workspace', '=', workspace)
          .where('owned', '=', 0)
          .where(
            'id',
            'not in',
            tx
              .selectFrom('activity_cache')
              .select('session_id')
              .where('workspace', '=', workspace),
          );
        if (retained.length) prune = prune.where('id', 'not in', retained);
        await prune.execute();
      });
    },
  };
}
