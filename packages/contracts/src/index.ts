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
  capabilities: z
    .object({ resume: z.boolean(), input: z.boolean(), interrupt: z.boolean() })
    .optional(),
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
  operation: z.enum(['start', 'resume', 'input', 'interrupt', 'approval']),
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
  approvalId: z.string().nullable().default(null),
});
export const approvalSchema = z.object({
  id: z.string(),
  sessionId: z.string().nullable(),
  turnId: z.string().nullable(),
  itemId: z.string().nullable(),
  kind: z.enum(['command', 'fileChange', 'unsupported']),
  method: z.string(),
  summary: z.string(),
  reason: z.string().nullable(),
  status: z.enum(['pending', 'submitting', 'resolved', 'stale', 'unsupported']),
  actionable: z.boolean(),
  observedAt: z.string(),
  detail: z.string(),
  commandId: z.string().nullable(),
});
export const authSchema = z.object({
  state: z.enum(['checking', 'ready', 'required', 'unavailable']),
  detail: z.string(),
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
  approvals: z.array(approvalSchema).default([]),
  auth: authSchema.default({
    state: 'checking',
    detail: 'Checking Codex authentication.',
  }),
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
const commandBase = {
  type: z.literal('command'),
  id: z.uuid(),
  targetId: z.string().min(1).max(256),
};
export const executionCommandSchema = z.discriminatedUnion('operation', [
  startCommandSchema,
  z.object({ ...commandBase, operation: z.literal('resume') }).strict(),
  z
    .object({
      ...commandBase,
      operation: z.literal('input'),
      prompt: z.string().trim().min(1).max(32000),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      operation: z.literal('interrupt'),
      turnId: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      operation: z.literal('approval'),
      approvalId: z.string().min(1).max(512),
      decision: z.enum(['accept', 'decline']),
    })
    .strict(),
]);
export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('refresh') }).strict(),
  z
    .object({
      type: z.literal('inspect'),
      sessionId: z.string().min(1).max(256),
    })
    .strict(),
  executionCommandSchema,
]);
export type Activity = z.infer<typeof activitySchema>;
export type Session = z.infer<typeof sessionSchema>;
export type Discovery = z.infer<typeof discoverySchema>;
export type Workflow = z.infer<typeof workflowSchema>;
export type CommandRecord = z.infer<typeof commandRecordSchema>;
export type StartCommand = z.infer<typeof startCommandSchema>;
export type ExecutionCommand = z.infer<typeof executionCommandSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type Auth = z.infer<typeof authSchema>;
export type Integration = z.infer<typeof integrationSchema>;
export type SnapshotMessage = z.infer<typeof snapshotMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;
