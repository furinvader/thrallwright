import { z } from 'zod';

export const integrationSchema = z.object({
  state: z.enum(['available', 'unavailable', 'connecting']),
  detail: z.string(),
});
export const activitySchema = z.object({
  id: z.string(),
  turnId: z.string(),
  kind: z.enum(['user', 'assistant', 'tool', 'status', 'approval', 'other']),
  text: z.string(),
  complete: z.boolean(),
  origin: z.enum(['history', 'live', 'cache']),
  observedAt: z.string(),
});
export const sessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  parentThreadId: z.string().nullable(),
  ephemeral: z.boolean(),
  owned: z.boolean(),
  controllable: z.boolean(),
  status: z.enum([
    'historical',
    'running',
    'waiting',
    'idle',
    'finished',
    'disconnected',
    'unknown',
  ]),
  freshness: z.enum(['live', 'history', 'cached']),
  activeTurnId: z.string().nullable(),
  latestTurnOutcome: z.string().nullable(),
  observedAt: z.string(),
  history: z.object({
    state: z.enum(['unread', 'loading', 'ready', 'unavailable', 'deleted']),
    complete: z.boolean(),
    detail: z.string(),
  }),
  activities: z.array(activitySchema),
});
export const discoverySchema = z.object({
  state: z.enum(['loading', 'ready', 'unavailable']),
  detail: z.string(),
});
export const workflowSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('unconfigured'),
    source: z.null(),
    detail: z.string(),
    observedAt: z.null(),
  }),
  z.object({
    state: z.literal('ready'),
    source: z.string(),
    detail: z.string(),
    observedAt: z.string(),
    value: z.json().optional(),
    document: z.string().optional(),
  }),
  z.object({
    state: z.enum(['missing', 'invalid', 'unreadable']),
    source: z.string(),
    detail: z.string(),
    observedAt: z.string(),
  }),
]);
export const commandRecordSchema = z.object({
  id: z.string(),
  operation: z.literal('start'),
  targetId: z.string().nullable(),
  phase: z.enum([
    'intent',
    'dispatching',
    'accepted',
    'completed',
    'rejected',
    'uncertain',
  ]),
  detail: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  resultSessionId: z.string().nullable(),
  turnId: z.string().nullable(),
});
export const snapshotMessageSchema = z.object({
  type: z.literal('snapshot'),
  revision: z.number().int().nonnegative(),
  workspace: z.string(),
  integration: integrationSchema,
  sessions: z.array(sessionSchema).default([]),
  discovery: discoverySchema.default({
    state: 'loading',
    detail: 'Discovering Codex sessions.',
  }),
  workflow: workflowSchema.default({
    state: 'unconfigured',
    source: null,
    detail: 'No workflow source configured.',
    observedAt: null,
  }),
  commands: z.array(commandRecordSchema).default([]),
  capabilities: z
    .object({ startSession: z.boolean() })
    .default({ startSession: false }),
  storageProblem: z.string().nullable().default(null),
});
export const serverMessageSchema = z.discriminatedUnion('type', [
  snapshotMessageSchema,
  z.object({
    type: z.literal('error'),
    message: z.string(),
    commandId: z.string().optional(),
    disposition: z.enum(['rejected', 'uncertain']).optional(),
  }),
]);
export const startCommandSchema = z
  .object({
    type: z.literal('command'),
    id: z.uuid(),
    operation: z.literal('start'),
    prompt: z.string().trim().min(1).max(32000),
  })
  .strict();
export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('refresh') }).strict(),
  z
    .object({
      type: z.literal('inspect'),
      sessionId: z.string().min(1).max(256),
    })
    .strict(),
  startCommandSchema,
]);
export type Activity = z.infer<typeof activitySchema>;
export type Session = z.infer<typeof sessionSchema>;
export type Discovery = z.infer<typeof discoverySchema>;
export type Workflow = z.infer<typeof workflowSchema>;
export type CommandRecord = z.infer<typeof commandRecordSchema>;
export type StartCommand = z.infer<typeof startCommandSchema>;
export type Integration = z.infer<typeof integrationSchema>;
export type SnapshotMessage = z.infer<typeof snapshotMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;
