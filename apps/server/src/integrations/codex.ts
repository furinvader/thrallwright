import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { BehaviorSubject, Subject, type Observable } from 'rxjs';
import { z } from 'zod';
import type { Integration } from '@thrallwright/contracts';

const messageSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().min(1).optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z
      .object({ code: z.number(), message: z.string() })
      .passthrough()
      .optional(),
  })
  .refine((message) =>
    message.method !== undefined
      ? message.result === undefined && message.error === undefined
      : message.id !== undefined &&
        (message.result !== undefined) !== (message.error !== undefined),
  );

export interface HarnessEvent {
  method: string;
  params: unknown;
}
export interface HarnessRequest extends HarnessEvent {
  id: string | number;
}
export interface CodexAdapter {
  readonly state$: Observable<Integration>;
  readonly events$: Observable<HarnessEvent>;
  readonly requests$: Observable<HarnessRequest>;
  start(): Promise<void>;
  request(method: string, params?: unknown): Promise<unknown>;
  respond(id: string | number, result: unknown): void;
  close(): Promise<void>;
}

/** An explicit rejection differs from a lost transport or missing response. */
export class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'CodexRpcError';
  }
}

type CodexChild = Pick<
  ChildProcessWithoutNullStreams,
  'stdin' | 'stdout' | 'stderr' | 'exitCode' | 'signalCode' | 'kill' | 'on'
>;
interface ProcessOptions {
  createProcess?: (executable: string, workspace: string) => CodexChild;
  requestTimeoutMs?: number;
  shutdownGraceMs?: number;
  maxLineBytes?: number;
}

/** One process owned by application startup, never by a browser subscription. */
export class CodexProcess implements CodexAdapter {
  private readonly state = new BehaviorSubject<Integration>({
    state: 'connecting',
    detail: 'Connecting to Codex.',
  });
  private readonly events = new Subject<HarnessEvent>();
  private readonly requests = new Subject<HarnessRequest>();
  readonly state$ = this.state.asObservable();
  readonly events$ = this.events.asObservable();
  readonly requests$ = this.requests.asObservable();
  private child?: CodexChild;
  private sequence = 0;
  private closing = false;
  private failed = false;
  private ready = false;
  private buffer = '';
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private processDone: Promise<void> = Promise.resolve();
  private readonly pending = new Map<
    string | number,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(
    private readonly executable: string,
    private readonly workspace: string,
    private readonly options: ProcessOptions = {},
  ) {}

  start(): Promise<void> {
    if (this.closing) return Promise.resolve();
    return (this.startPromise ??= this.initialize());
  }

  private async initialize(): Promise<void> {
    try {
      const child =
        this.options.createProcess?.(this.executable, this.workspace) ??
        spawn(this.executable, ['app-server', '--listen', 'stdio://'], {
          cwd: this.workspace,
          stdio: 'pipe',
        });
      this.child = child;
      // Capture settlement immediately, including signal exits before close() is called.
      this.processDone = new Promise((resolve) => {
        child.on('error', () => {
          resolve();
          this.fail(
            'Cannot start Codex. Check the selected executable and harness storage access.',
          );
        });
        child.on('exit', () => {
          resolve();
          this.fail('Codex connection closed. Live state must be revalidated.');
        });
      });
      // Drain diagnostics without forwarding private harness configuration/transcripts.
      child.stderr.on('data', () => {});
      child.stdin.on('error', () =>
        this.fail('Codex input connection closed.'),
      );
      child.stdout.on('error', () =>
        this.fail('Codex output connection closed.'),
      );
      child.stdout.on('end', () =>
        this.fail('Codex output connection closed.'),
      );
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.receiveChunk(chunk));
      await this.sendRequest('initialize', {
        clientInfo: {
          name: 'thrallwright',
          title: 'Thrallwright',
          version: '0.1.0',
        },
        capabilities: null,
      });
      this.write({ method: 'initialized', params: {} });
      this.ready = true;
      this.state.next({
        state: 'available',
        detail:
          'Codex connected. Session capabilities are established from harness evidence.',
      });
    } catch {
      this.fail(
        'Codex initialization failed. Check the selected executable, configuration, and harness storage access.',
      );
      await this.stopTransport();
    }
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    if (!this.ready) return Promise.reject(new Error('Codex is unavailable.'));
    return this.sendRequest(method, params);
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    if (!this.child || this.exited() || this.closing || this.failed)
      return Promise.reject(new Error('Codex is unavailable.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out; outcome may be unknown.`));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  respond(id: string | number, result: unknown): void {
    if (!this.ready) throw new Error('Codex is unavailable.');
    this.write({ id, result });
  }

  private write(value: unknown): void {
    if (
      !this.child?.stdin.writable ||
      this.exited() ||
      this.closing ||
      this.failed
    )
      throw new Error('Codex connection is unavailable.');
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private receiveChunk(chunk: string): void {
    if (this.failed || this.closing) return;
    this.buffer += chunk;
    const limit = this.options.maxLineBytes ?? 8 * 1024 * 1024;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > limit) {
        this.fail('Codex protocol message exceeded the supported size.');
        return;
      }
      if (line.trim()) this.receive(line);
      if (this.failed || this.closing) return;
    }
    if (Buffer.byteLength(this.buffer) > limit)
      this.fail('Codex protocol message exceeded the supported size.');
  }

  private receive(line: string): void {
    let parsed;
    try {
      parsed = messageSchema.safeParse(JSON.parse(line));
    } catch {
      this.fail('Codex sent invalid protocol data.');
      return;
    }
    if (!parsed.success) {
      this.fail('Codex sent an unsupported protocol envelope.');
      return;
    }
    const message = parsed.data;
    // Server requests and client responses can use the same RPC id.
    if (message.method) {
      if (message.id !== undefined)
        this.requests.next({
          id: message.id,
          method: message.method,
          params: message.params,
        });
      else this.events.next({ method: message.method, params: message.params });
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error)
      pending.reject(
        new CodexRpcError(message.error.code, message.error.message),
      );
    else pending.resolve(message.result);
  }

  private fail(detail: string): void {
    if (this.failed || this.closing) return;
    this.failed = true;
    this.ready = false;
    this.buffer = '';
    this.state.next({ state: 'unavailable', detail });
    this.rejectPending(detail);
    void this.stopTransport();
  }

  private rejectPending(detail: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(detail));
    }
    this.pending.clear();
  }

  private exited(): boolean {
    return (
      !this.child ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    );
  }

  private waitForExit(): Promise<boolean> {
    if (this.exited()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve(false),
        this.options.shutdownGraceMs ?? 2_000,
      );
      void this.processDone.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private stopTransport(): Promise<void> {
    return (this.stopPromise ??= (async () => {
      const child = this.child;
      if (!child || this.exited()) return;
      child.stdin.end();
      if (await this.waitForExit()) return;
      child.kill('SIGTERM');
      if (await this.waitForExit()) return;
      child.kill('SIGKILL');
      await this.waitForExit();
      // Bound shutdown even if a broken transport never reports exit.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    })());
  }

  close(): Promise<void> {
    return (this.closePromise ??= (async () => {
      this.closing = true;
      this.ready = false;
      this.buffer = '';
      this.state.next({
        state: 'unavailable',
        detail: 'Codex connection closed.',
      });
      this.rejectPending('Codex connection closed.');
      await this.stopTransport();
      this.events.complete();
      this.requests.complete();
      this.state.complete();
    })());
  }
}
