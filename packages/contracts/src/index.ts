import { z } from 'zod';

export const integrationSchema = z.object({
  state: z.enum(['available', 'unavailable', 'connecting']),
  detail: z.string(),
});
export const snapshotMessageSchema = z.object({
  type: z.literal('snapshot'),
  revision: z.number().int().nonnegative(),
  workspace: z.string(),
  integration: integrationSchema,
});
export const serverMessageSchema = z.discriminatedUnion('type', [
  snapshotMessageSchema,
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export const clientMessageSchema = z
  .object({ type: z.literal('refresh') })
  .strict();
export type Integration = z.infer<typeof integrationSchema>;
export type SnapshotMessage = z.infer<typeof snapshotMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;
