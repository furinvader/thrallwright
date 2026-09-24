#!/usr/bin/env node
// A local Codex app-server stand-in for browser tests. It makes no model calls.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const workspace = process.cwd();
const log = process.env.THRALLWRIGHT_FAKE_CODEX_LOG;
const threads = new Map();
let nextThread = 1;
let nextTurn = 1;
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

createInterface({ input: process.stdin }).on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof request?.method !== 'string') return;
  const { id, method, params = {} } = request;
  if (id === undefined) return;
  record(method);
  switch (method) {
    case 'initialize':
      reply(id, { capabilities: {} });
      break;
    case 'thread/loaded/list':
      reply(id, { data: [...threads.keys()], nextCursor: null });
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
      reply(id, { thread: threadSummary(thread) });
      notify('thread/started', { thread: threadSummary(thread) });
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
        turn.status = 'completed';
        thread.status = { type: 'idle' };
        notify('turn/completed', {
          threadId: thread.id,
          turn: { id: turn.id, status: turn.status, items: turn.items },
        });
        notify('thread/status/changed', {
          threadId: thread.id,
          status: thread.status,
        });
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
