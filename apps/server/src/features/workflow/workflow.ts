import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { BehaviorSubject } from 'rxjs';
import { z } from 'zod';
import type { Workflow } from '@thrallwright/contracts';

const MAX_BYTES = 4 * 1024 * 1024;

export function createWorkflowSource(source: string | null, intervalMs = 2000) {
  const state = new BehaviorSubject<Workflow>({
    state: 'unconfigured',
    source: null,
    detail: 'No workflow source configured. Start with --workflow PATH.',
    observedAt: null,
  });
  let closed = false;
  let reading: Promise<void> | undefined;
  async function read() {
    if (!source || closed) return;
    const observedAt = new Date().toISOString();
    let next: Workflow;
    try {
      const file = await open(
        source,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      let text: string;
      try {
        const info = await file.stat();
        if (!info.isFile())
          throw new Error('Workflow source must be a regular file.');
        if (info.size > MAX_BYTES)
          throw new Error('Workflow exceeds the 4 MiB display limit.');
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(
            buffer,
            length,
            buffer.length - length,
            null,
          );
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > MAX_BYTES)
          throw new Error('Workflow exceeds the 4 MiB display limit.');
        text = new TextDecoder('utf-8', { fatal: true }).decode(
          buffer.subarray(0, length),
        );
      } finally {
        await file.close();
      }
      try {
        const value: unknown = JSON.parse(text);
        let structured: z.infer<ReturnType<typeof z.json>> | undefined;
        try {
          const representable = z.json().safeParse(value);
          if (representable.success) structured = representable.data;
        } catch {
          // Deep or out-of-range values still have an exact source representation.
        }
        next = {
          state: 'ready',
          source,
          observedAt,
          detail: 'Read-only JSON source. Refreshed every two seconds.',
          value: structured,
          document: text,
        };
      } catch {
        next = {
          state: 'invalid',
          source,
          observedAt,
          detail:
            'The workflow file is not valid JSON. Its contents have not been changed.',
        };
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      next = {
        state: code === 'ENOENT' ? 'missing' : 'unreadable',
        source,
        observedAt,
        detail:
          code === 'ENOENT'
            ? 'The workflow file does not exist.'
            : `Cannot read workflow: ${error instanceof Error ? error.message : 'unknown read error'}`,
      };
    }
    if (!closed) state.next(next);
  }
  function refresh() {
    reading ??= read().finally(() => {
      reading = undefined;
    });
    return reading;
  }
  const timer = setInterval(() => {
    void refresh();
  }, intervalMs);
  timer.unref();
  return {
    state$: state.asObservable(),
    getSnapshot: () => state.value,
    refresh,
    async close() {
      closed = true;
      clearInterval(timer);
      await reading;
      state.complete();
    },
  };
}
