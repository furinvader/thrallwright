#!/usr/bin/env node
// A local Codex app-server stand-in for browser tests. It makes no model calls.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const workspace = process.cwd();
const log = process.env.THRALLWRIGHT_FAKE_CODEX_LOG;
const threads = new Map();
const loadedThreads = new Set();
const requests = new Map();
let nextThread = 1;
let nextTurn = 1;
let nextRequest = 1;
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => write({ method, params });
const record = (method) => {
  if (log) appendFileSync(log, `${method}\n`);
};
const threadSummary = (thread) => ({
  id: thread.id,
  cwd: thread.cwd,
  ephemeral: false,
  status: thread.status,
  name: thread.name,
  preview: thread.preview,
  parentThreadId: null,
});
const reply = (id, result) => write({ id, result });
const finishTurn = (thread, turn, status = 'completed') => {
  if (turn.status !== 'inProgress') return;
  turn.status = status;
  thread.status = { type: 'idle' };
  notify('turn/completed', {
    threadId: thread.id,
    turn: { id: turn.id, status: turn.status, items: turn.items },
  });
  notify('thread/status/changed', {
    threadId: thread.id,
    status: thread.status,
  });
};

if (process.env.THRALLWRIGHT_FAKE_CODEX_SAVED === '1') {
  threads.set('fixture-saved-thread', {
    id: 'fixture-saved-thread',
    cwd: workspace,
    name: 'Saved conversation',
    preview: 'Previously recorded work',
    status: { type: 'notLoaded' },
    turns: [],
  });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof request?.method !== 'string') {
    const pending = requests.get(String(request?.id));
    if (pending && request?.result?.decision) {
      requests.delete(String(request.id));
      record(`approval/response:${request.result.decision}`);
      notify('serverRequest/resolved', {
        threadId: pending.thread.id,
        requestId: request.id,
      });
      finishTurn(pending.thread, pending.turn);
    }
    return;
  }
  const { id, method, params = {} } = request;
  if (id === undefined) return;
  record(method);
  switch (method) {
    case 'initialize':
      reply(id, { capabilities: {} });
      break;
    case 'account/read':
      reply(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: true });
      break;
    case 'thread/loaded/list':
      reply(id, { data: [...loadedThreads], nextCursor: null });
      break;
    case 'thread/list':
      reply(id, {
        data: [...threads.values()]
          .filter((thread) => thread.cwd === params.cwd)
          .map(threadSummary),
        nextCursor: null,
      });
      break;
    case 'thread/read': {
      const thread = threads.get(params.threadId);
      if (thread)
        reply(id, {
          thread: { ...threadSummary(thread), turns: thread.turns },
        });
      else write({ id, error: { code: -32602, message: 'Unknown thread' } });
      break;
    }
    case 'thread/start': {
      const thread = {
        id: `fixture-thread-${nextThread++}`,
        cwd: params.cwd ?? workspace,
        name: 'Browser test session',
        preview: '',
        status: { type: 'idle' },
        turns: [],
      };
      threads.set(thread.id, thread);
      loadedThreads.add(thread.id);
      reply(id, { thread: threadSummary(thread) });
      notify('thread/started', { thread: threadSummary(thread) });
      break;
    }
    case 'thread/resume': {
      const thread = threads.get(params.threadId);
      if (!thread) {
        write({ id, error: { code: -32602, message: 'Unknown thread' } });
        break;
      }
      loadedThreads.add(thread.id);
      thread.status = { type: 'idle' };
      reply(id, { thread: threadSummary(thread) });
      notify('thread/started', { thread: threadSummary(thread) });
      break;
    }
    case 'turn/interrupt': {
      const thread = threads.get(params.threadId);
      const turn = thread?.turns.find((item) => item.id === params.turnId);
      if (!thread || !turn || turn.status !== 'inProgress') {
        write({ id, error: { code: -32602, message: 'Turn is not active' } });
        break;
      }
      reply(id, {});
      finishTurn(thread, turn, 'interrupted');
      break;
    }
    case 'turn/start': {
      const thread = threads.get(params.threadId);
      if (!thread) {
        write({ id, error: { code: -32602, message: 'Unknown thread' } });
        break;
      }
      const prompt =
        params.input?.find((entry) => entry.type === 'text')?.text ?? '';
      const turn = {
        id: `fixture-turn-${nextTurn++}`,
        status: 'inProgress',
        itemsView: 'full',
        items: [
          {
            type: 'userMessage',
            id: 'user-1',
            content: [{ type: 'text', text: prompt }],
          },
        ],
      };
      thread.turns.push(turn);
      thread.status = { type: 'active', activeFlags: [] };
      reply(id, { turn: { id: turn.id, status: turn.status, items: [] } });
      notify('turn/started', {
        threadId: thread.id,
        turn: { id: turn.id, status: turn.status, items: [] },
      });
      notify('thread/status/changed', {
        threadId: thread.id,
        status: thread.status,
      });
      const approvalType = prompt.includes('Request command approval')
        ? 'command'
        : prompt.includes('Request file approval')
          ? 'fileChange'
          : prompt.includes('Request unsupported approval')
            ? 'unsupported'
            : prompt.includes('Request stale approval')
              ? 'stale'
              : null;
      if (approvalType) {
        const requestId = `fixture-request-${nextRequest++}`;
        thread.status = {
          type: 'active',
          activeFlags: ['waitingOnApproval'],
        };
        notify('thread/status/changed', {
          threadId: thread.id,
          status: thread.status,
        });
        const method =
          approvalType === 'fileChange'
            ? 'item/fileChange/requestApproval'
            : approvalType === 'unsupported'
              ? 'item/permissions/requestApproval'
              : 'item/commandExecution/requestApproval';
        const details =
          approvalType === 'fileChange'
            ? { reason: 'Review fixture file change.' }
            : {
                kind: 'command',
                environmentId: null,
                command: 'echo fixture approval',
                reason: 'Review fixture command.',
              };
        requests.set(requestId, { thread, turn });
        write({
          id: requestId,
          method,
          params: {
            threadId: thread.id,
            turnId: turn.id,
            itemId: 'approval-item-1',
            startedAtMs: 0,
            ...details,
          },
        });
        if (approvalType === 'stale')
          setTimeout(() => {
            notify('serverRequest/resolved', {
              threadId: thread.id,
              requestId,
            });
            requests.delete(requestId);
            finishTurn(thread, turn);
          }, 250);
        break;
      }
      if (prompt.includes('Wait for interrupt')) break;
      setTimeout(() => {
        const item = {
          type: 'agentMessage',
          id: 'agent-1',
          text: 'Fixture agent observed the task.',
        };
        notify('item/started', {
          threadId: thread.id,
          turnId: turn.id,
          item: { ...item, text: '' },
        });
        notify('item/agentMessage/delta', {
          threadId: thread.id,
          turnId: turn.id,
          itemId: item.id,
          delta: item.text,
        });
        notify('item/completed', {
          threadId: thread.id,
          turnId: turn.id,
          item,
        });
        turn.items.push(item);
        finishTurn(thread, turn);
      }, 100);
      break;
    }
    default:
      write({
        id,
        error: { code: -32601, message: `Unsupported method: ${method}` },
      });
  }
});
