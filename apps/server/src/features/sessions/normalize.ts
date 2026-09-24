import { z } from 'zod';
import type { Activity, Session } from '@thrallwright/contracts';

export const MAX_ACTIVITIES = 100;
export const MAX_TEXT_BYTES = 8 * 1024;
export const sourceId = z.string().min(1).max(256);
export const statusSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('notLoaded') }),
  z.object({ type: z.literal('idle') }),
  z.object({ type: z.literal('systemError') }),
  z.object({
    type: z.literal('active'),
    activeFlags: z.array(z.string()).default([]),
  }),
]);
export const threadSchema = z.object({
  id: sourceId,
  cwd: z.string().min(1),
  ephemeral: z.boolean(),
  status: statusSchema,
  name: z.string().nullable().optional(),
  preview: z.string().optional(),
  parentThreadId: sourceId.nullable().optional(),
  turns: z.array(z.unknown()).optional(),
});
export const turnSchema = z.object({
  id: sourceId,
  status: z.enum(['inProgress', 'completed', 'interrupted', 'failed']),
  items: z.array(z.unknown()).optional(),
  itemsView: z.enum(['notLoaded', 'summary', 'full']).optional(),
});
export type SourceThread = z.infer<typeof threadSchema>;
export type SourceStatus = z.infer<typeof statusSchema>;

export function clipText(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= MAX_TEXT_BYTES)
    return { text, truncated: false };
  const marker = '\n[Truncated]';
  const prefix = Buffer.from(text)
    .subarray(0, MAX_TEXT_BYTES - Buffer.byteLength(marker))
    .toString('utf8')
    .replace(/\uFFFD$/, '');
  return { text: prefix + marker, truncated: true };
}

export const activityKey = (turnId: string, itemId: string) =>
  JSON.stringify([turnId, itemId]);

export function presentStatus(source: SourceStatus): Session['status'] {
  if (source.type === 'notLoaded') return 'historical';
  if (source.type === 'idle') return 'idle';
  if (source.type === 'systemError') return 'unknown';
  return source.activeFlags.some(
    (flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput',
  )
    ? 'waiting'
    : 'running';
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const string = (value: unknown) => (typeof value === 'string' ? value : '');
const textContent = (value: unknown): string =>
  Array.isArray(value)
    ? value
        .map((part) => {
          const item = record(part);
          return item?.type === 'text' ? string(item.text) : '';
        })
        .filter(Boolean)
        .join('\n')
    : '';

export interface NormalizedItem {
  activity: Activity | null;
  truncated: boolean;
  unsupported: boolean;
}

/** Only explicitly supported display fields cross into the public projection. */
export function normalizeItem(
  raw: unknown,
  turnId: string,
  origin: Activity['origin'],
  observedAt: string,
  complete: boolean,
): NormalizedItem {
  const item = record(raw);
  const id = sourceId.safeParse(item?.id);
  if (!item || !id.success || typeof item.type !== 'string')
    return { activity: null, truncated: false, unsupported: true };
  // Neither reasoning content nor reasoning deltas are exposed by this slice.
  if (item.type === 'reasoning' || item.type === 'hookPrompt')
    return { activity: null, truncated: false, unsupported: false };
  let kind: Activity['kind'];
  let text: string;
  switch (item.type) {
    case 'userMessage':
      kind = 'user';
      text = textContent(item.content) || '[Non-text user input]';
      break;
    case 'agentMessage':
      if (typeof item.text !== 'string')
        return { activity: null, truncated: false, unsupported: true };
      kind = 'assistant';
      text = item.text;
      break;
    case 'commandExecution':
      kind = 'tool';
      text = `Command: ${string(item.command)}\n${string(item.status)}\n${string(item.aggregatedOutput)}`;
      break;
    case 'fileChange':
      kind = 'tool';
      text = `File changes: ${string(item.status)}\n${
        Array.isArray(item.changes)
          ? item.changes
              .map((value) => {
                const change = record(value);
                return `${string(change?.path)}\n${string(change?.diff)}`;
              })
              .join('\n')
          : ''
      }`;
      break;
    case 'mcpToolCall': {
      kind = 'tool';
      const result = record(item.result);
      text = `Tool: ${string(item.server)} / ${string(item.tool)}\n${string(item.status)}\n${textContent(result?.content)}\n${string(record(item.error)?.message)}`;
      break;
    }
    case 'dynamicToolCall':
      kind = 'tool';
      text = `Tool: ${string(item.tool)}\n${string(item.status)}\n${textContent(item.contentItems)}`;
      break;
    case 'plan':
      kind = 'other';
      text = string(item.text);
      break;
    default:
      return { activity: null, truncated: false, unsupported: true };
  }
  const bounded = clipText(text);
  return {
    activity: {
      id: activityKey(turnId, id.data),
      turnId,
      kind,
      text: bounded.text,
      complete: complete && !bounded.truncated,
      origin,
      observedAt,
    },
    truncated: bounded.truncated,
    unsupported: false,
  };
}

export function normalizeHistory(
  rawTurns: unknown[] | undefined,
  observedAt: string,
) {
  const activities: Activity[] = [];
  let complete = rawTurns !== undefined;
  let latestTurnOutcome: string | null = null;
  for (const raw of rawTurns ?? []) {
    const parsed = turnSchema.safeParse(raw);
    if (!parsed.success) {
      complete = false;
      continue;
    }
    const turn = parsed.data;
    latestTurnOutcome = turn.status;
    if (turn.itemsView !== undefined && turn.itemsView !== 'full')
      complete = false;
    for (const rawItem of turn.items ?? []) {
      const result = normalizeItem(
        rawItem,
        turn.id,
        'history',
        observedAt,
        turn.status !== 'inProgress',
      );
      if (result.activity) activities.push(result.activity);
      if (result.truncated || result.unsupported) complete = false;
    }
    if (turn.items === undefined) complete = false;
  }
  const deduplicated = new Map(
    activities.map((activity) => [activity.id, activity]),
  );
  if (deduplicated.size > MAX_ACTIVITIES) complete = false;
  return {
    activities: [...deduplicated.values()].slice(-MAX_ACTIVITIES),
    complete,
    latestTurnOutcome,
  };
}
