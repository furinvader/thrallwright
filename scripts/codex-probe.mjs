#!/usr/bin/env node
// Read-only by default. Never print raw harness traffic, paths, or account details.
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const args = process.argv.slice(2);
let workspace = process.cwd();
let output;
let smoke = false;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--workspace' && args[index + 1])
    workspace = args[++index];
  else if (args[index] === '--output' && args[index + 1])
    output = args[++index];
  else if (args[index] === '--smoke') smoke = true;
  else if (args[index] === '--help') {
    console.log(
      'Usage: node scripts/codex-probe.mjs [--workspace PATH] [--output FILE] [--smoke]',
    );
    console.log(
      'Default: read-only RPCs, no model calls. --smoke: temporary ephemeral thread and two small model turns, including interruption.',
    );
    process.exit(0);
  } else {
    console.error('Unknown or incomplete probe option. Use --help.');
    process.exit(2);
  }
}

const knownStatuses = new Set(['notLoaded', 'idle', 'systemError', 'active']);
const knownItems = new Set([
  'userMessage',
  'agentMessage',
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'plan',
  'reasoning',
  'collabAgentToolCall',
  'subAgentActivity',
]);
const status = (thread) =>
  knownStatuses.has(thread?.status?.type) ? thread.status.type : 'unknown';
const codeOf = (error) =>
  typeof error?.code === 'number' ? error.code : 'probe-error';
const safeVersion = (value) =>
  value?.match(
    /codex-cli [0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?/,
  )?.[0] ?? 'unavailable';
const pause = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

class ProbeClient {
  sequence = 0;
  pending = new Map();
  turnOutcomes = new Map();
  notificationCounts = new Map();
  requests = new Set();
  diagnostics = new Set();
  stderrBytes = 0;
  receivedBytes = 0;
  buffer = '';
  dead = false;
  failed = false;

  constructor(cwd) {
    this.child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.closed = new Promise((resolve) => {
      this.child.once('error', () => {
        this.fail();
        resolve({ code: null, signal: 'spawn-error' });
      });
      this.child.once('close', (code, signal) => {
        this.fail();
        resolve({ code, signal });
      });
    });
    this.child.stdin.on('error', () => this.fail());
    this.child.stderr.on('data', (chunk) => {
      this.stderrBytes += chunk.length;
      const value = String(chunk);
      if (/read.only/i.test(value)) this.diagnostics.add('read-only-storage');
      if (/permission denied/i.test(value))
        this.diagnostics.add('permission-denied');
      if (/unauthorized|authentication|login required/i.test(value))
        this.diagnostics.add('authentication');
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.receivedBytes += Buffer.byteLength(chunk);
      this.buffer += chunk;
      // Bound both one history response and the entire run; never write raw output.
      if (
        Buffer.byteLength(this.buffer) > 8 * 1024 * 1024 ||
        this.receivedBytes > 32 * 1024 * 1024
      ) {
        this.failed = true;
        this.fail();
        this.child.kill('SIGTERM');
        return;
      }
      let newline;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          this.receive(JSON.parse(line));
        } catch {
          this.failed = true;
          this.fail();
          this.child.kill('SIGTERM');
          return;
        }
      }
    });
  }

  fail() {
    this.dead = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex transport unavailable'));
    }
    this.pending.clear();
  }

  receive(message) {
    if (message.method && message.id !== undefined) {
      const supported = [
        'item/commandExecution/requestApproval',
        'item/fileChange/requestApproval',
      ];
      this.requests.add(
        supported.includes(message.method)
          ? message.method
          : 'unsupported-server-request',
      );
      // The smoke test never authorizes side effects. Unknown request shapes are rejected.
      this.send(
        supported.includes(message.method)
          ? { id: message.id, result: { decision: 'decline' } }
          : {
              id: message.id,
              error: {
                code: -32601,
                message: 'Probe does not support this request',
              },
            },
      );
    } else if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(
          Object.assign(new Error('Codex RPC rejected'), {
            code: message.error.code,
          }),
        );
      else pending.resolve(message.result);
    } else if (message.method) {
      const known = [
        'thread/started',
        'thread/status/changed',
        'turn/started',
        'turn/completed',
        'item/started',
        'item/completed',
        'item/agentMessage/delta',
        'serverRequest/resolved',
        'error',
      ];
      const method = known.includes(message.method) ? message.method : 'other';
      this.notificationCounts.set(
        method,
        (this.notificationCounts.get(method) ?? 0) + 1,
      );
      if (message.method === 'turn/completed' && this.turnOutcomes.size < 20) {
        const outcome = message.params?.turn;
        const allowed = ['completed', 'interrupted', 'failed'];
        if (typeof outcome?.id === 'string')
          this.turnOutcomes.set(
            outcome.id,
            allowed.includes(outcome.status) ? outcome.status : 'unknown',
          );
      }
    }
  }

  send(message) {
    if (this.dead) throw new Error('Codex transport unavailable');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (this.dead) {
        reject(new Error('Codex transport unavailable'));
        return;
      }
      const id = `probe-${++this.sequence}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex request timed out'));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Codex transport unavailable'));
      }
    });
  }

  async initialize() {
    const result = await this.request('initialize', {
      clientInfo: {
        name: 'thrallwright_probe',
        title: 'Thrallwright integration probe',
        version: '0.1.0',
      },
      capabilities: null,
    });
    this.send({ method: 'initialized', params: {} });
    return {
      initialized: true,
      platform: result.platformOs === 'linux' ? 'linux' : 'other',
    };
  }

  async waitForTurn(turnId, milliseconds = 25_000) {
    const until = Date.now() + milliseconds;
    while (!this.dead && !this.turnOutcomes.has(turnId) && Date.now() < until)
      await pause(50);
    return this.turnOutcomes.get(turnId) ?? 'unconfirmed';
  }

  async stop() {
    this.child.stdin.end();
    let result = await Promise.race([
      this.closed,
      pause(2_000).then(() => null),
    ]);
    if (result) return { ...result, forced: false };
    this.child.kill('SIGTERM');
    result = await Promise.race([this.closed, pause(2_000).then(() => null)]);
    if (result) return { ...result, forced: true };
    this.child.kill('SIGKILL');
    result = await this.closed;
    return { ...result, forced: true };
  }

  summary() {
    return {
      notifications: Object.fromEntries(this.notificationCounts),
      serverRequests: [...this.requests],
      stderrBytes: this.stderrBytes,
      diagnostics: [...this.diagnostics],
      outputLimitOrParseFailure: this.failed,
    };
  }
}

async function inspect(client, cwd) {
  const loadedBefore = await client.request('thread/loaded/list', {
    limit: 100,
  });
  const listed = await client.request('thread/list', {
    cwd,
    limit: 10,
    useStateDbOnly: true,
  });
  const first = listed.data?.[0];
  const report = {
    listedCount: listed.data?.length ?? 0,
    listHasMore: listed.nextCursor != null,
    statuses: (listed.data ?? []).map(status),
    loadedCount: loadedBefore.data?.length ?? 0,
    loadedHasMore: loadedBefore.nextCursor != null,
    history: { attempted: false },
  };
  if (first?.id) {
    try {
      const read = await client.request('thread/read', {
        threadId: first.id,
        includeTurns: true,
      });
      const turns = read.thread?.turns ?? [];
      report.history = {
        attempted: true,
        readable: true,
        status: status(read.thread),
        turnCount: turns.length,
        itemKinds: [
          ...new Set(
            turns.flatMap((turn) =>
              (turn.items ?? []).map((item) =>
                knownItems.has(item.type) ? item.type : 'other',
              ),
            ),
          ),
        ],
      };
    } catch (error) {
      report.history = {
        attempted: true,
        readable: false,
        errorCode: codeOf(error),
      };
    }
  }
  const loadedAfter = await client.request('thread/loaded/list', {
    limit: 100,
  });
  report.historyLoadedThread = first
    ? (loadedAfter.data?.includes(first.id) ?? false)
    : null;
  report.loadedAfterReadCount = loadedAfter.data?.length ?? 0;
  return report;
}

async function exerciseSmoke(client) {
  const cwd = await mkdtemp(join(tmpdir(), 'thrallwright-codex-smoke-'));
  const report = {
    temporaryWorkspace: true,
    ephemeral: true,
    approvalPolicyOverridden: false,
    sandboxOverridden: false,
  };
  let threadId;
  let activeTurn;
  try {
    const started = await client.request('thread/start', {
      cwd,
      ephemeral: true,
    });
    threadId = started.thread.id;
    report.started = true;
    report.initialStatus = status(started.thread);
    const first = await client.request('turn/start', {
      threadId,
      input: [
        {
          type: 'text',
          text: 'Reply exactly THRALLWRIGHT_PROBE_OK. Do not use tools or access files.',
        },
      ],
    });
    activeTurn = first.turn.id;
    report.completedTurn = await client.waitForTurn(activeTurn);
    if (report.completedTurn === 'unconfirmed') {
      await client.request('turn/interrupt', { threadId, turnId: activeTurn });
      report.cleanupOutcome = await client.waitForTurn(activeTurn, 5_000);
    } else {
      activeTurn = undefined;
    }
    if (report.completedTurn === 'completed') {
      const second = await client.request('turn/start', {
        threadId,
        input: [
          {
            type: 'text',
            text: 'Count from one to one hundred in words. Do not use tools or access files.',
          },
        ],
      });
      activeTurn = second.turn.id;
      await client.request('turn/interrupt', { threadId, turnId: activeTurn });
      report.interruptAcknowledged = true;
      report.interruptOutcome = await client.waitForTurn(activeTurn, 5_000);
      activeTurn = undefined;
    }
    report.finalStatus = status(
      (await client.request('thread/read', { threadId, includeTurns: false }))
        .thread,
    );
  } catch (error) {
    report.errorCode = codeOf(error);
  } finally {
    if (threadId && activeTurn && !client.dead) {
      try {
        await client.request('turn/interrupt', {
          threadId,
          turnId: activeTurn,
        });
      } catch {
        report.cleanupConfirmed = false;
      }
    }
    // These are only the probe-created temporary files, never the user's workspace.
    await rm(cwd, { recursive: true, force: true });
  }
  return report;
}

const report = {
  checkedAt: new Date().toISOString(),
  version: 'unavailable',
  mode: smoke ? 'smoke' : 'read-only',
  runs: [],
};
try {
  workspace = await realpath(workspace);
  const version = await promisify(execFile)('codex', ['--version'], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  report.version = safeVersion(version.stdout);
  // A second independent process verifies rediscovery, not survival of a live process.
  for (let attempt = 0; attempt < 2; attempt++) {
    const client = new ProbeClient(workspace);
    const run = { attempt: attempt + 1 };
    try {
      Object.assign(run, await client.initialize());
      const account = await client.request('account/read', {
        refreshToken: false,
      });
      run.authPresent = account.account != null;
      run.requiresOpenaiAuth = account.requiresOpenaiAuth === true;
      run.observation = await inspect(client, workspace);
      if (smoke && attempt === 0) run.smoke = await exerciseSmoke(client);
    } catch (error) {
      run.errorCode = codeOf(error);
      process.exitCode = 1;
    } finally {
      run.shutdown = await client.stop();
      run.transport = client.summary();
      report.runs.push(run);
    }
  }
  if (
    smoke &&
    (report.runs[0]?.smoke?.completedTurn !== 'completed' ||
      report.runs[0]?.smoke?.interruptOutcome !== 'interrupted')
  )
    process.exitCode = 1;
} catch {
  report.error =
    'Probe could not access the workspace or start the selected Codex executable';
  process.exitCode = 1;
}
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (output) {
  try {
    await writeFile(output, serialized, { mode: 0o600 });
  } catch {
    console.error('Could not write sanitized probe report');
    process.exitCode = 1;
  }
}
process.stdout.write(serialized);
