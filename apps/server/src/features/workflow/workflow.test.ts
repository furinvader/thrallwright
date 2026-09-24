import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkflowSource } from './workflow.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'thrallwright-workflow-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'workflow.json') };
}

async function replace(path: string, contents: string) {
  const staging = `${path}.next`;
  await writeFile(staging, contents);
  await rename(staging, path);
}

describe('read-only JSON workflow source', () => {
  it.each([
    '900719925474099312345',
    '1e400',
    '{"amount":12345678901234567890,"amount":2}',
  ])('retains exact valid source tokens for %s', async (document) => {
    const { path } = await fixture();
    await writeFile(path, document);
    const source = createWorkflowSource(path, 60_000);
    cleanups.push(() => source.close());
    await source.refresh();
    expect(source.getSnapshot()).toMatchObject({ state: 'ready', document });
  });
  it.each([
    ['null', null],
    ['42', 42],
    ['true', true],
    ['"ready"', 'ready'],
    ['[1,{"stage":"build"}]', [1, { stage: 'build' }]],
    ['{"nested":{"items":[null,false]}}', { nested: { items: [null, false] } }],
  ])('preserves arbitrary JSON %s', async (text, expected) => {
    const { path } = await fixture();
    await writeFile(path, text);
    const source = createWorkflowSource(path, 60_000);
    cleanups.push(() => source.close());

    await source.refresh();
    const snapshot = source.getSnapshot();
    expect(snapshot.state).toBe('ready');
    if (snapshot.state === 'ready') {
      expect(snapshot.source).toBe(path);
      expect(snapshot.value).toEqual(expected);
      expect(Number.isNaN(Date.parse(snapshot.observedAt))).toBe(false);
    }
  });

  it('reports an unconfigured and a missing source explicitly', async () => {
    const { path } = await fixture();
    const unconfigured = createWorkflowSource(null, 60_000);
    cleanups.push(() => unconfigured.close());
    expect(unconfigured.getSnapshot()).toMatchObject({
      state: 'unconfigured',
      source: null,
    });

    const configured = createWorkflowSource(path, 60_000);
    cleanups.push(() => configured.close());
    await configured.refresh();
    expect(configured.getSnapshot()).toMatchObject({
      state: 'missing',
      source: path,
    });
  });

  it('shows malformed JSON and recovers after atomic external replacement', async () => {
    const { path } = await fixture();
    await writeFile(path, '{broken');
    const source = createWorkflowSource(path, 60_000);
    cleanups.push(() => source.close());

    await source.refresh();
    expect(source.getSnapshot()).toMatchObject({
      state: 'invalid',
      source: path,
    });
    await replace(path, '{"tasks":["one"]}');
    await source.refresh();
    expect(source.getSnapshot()).toMatchObject({
      state: 'ready',
      value: { tasks: ['one'] },
    });
    await replace(path, '[null,2]');
    await source.refresh();
    expect(source.getSnapshot()).toMatchObject({
      state: 'ready',
      value: [null, 2],
    });
  });

  it('reports a directory as unreadable instead of a successful empty workflow', async () => {
    const { directory } = await fixture();
    const source = createWorkflowSource(directory, 60_000);
    cleanups.push(() => source.close());
    await source.refresh();
    expect(source.getSnapshot()).toMatchObject({
      state: 'unreadable',
      source: directory,
    });
    expect(source.getSnapshot().detail).toContain('regular file');
  });

  it('rejects oversized and invalid UTF-8 input without changing the source', async () => {
    const { path } = await fixture();
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 1, 0x20);
    await writeFile(path, bytes);
    const source = createWorkflowSource(path, 60_000);
    cleanups.push(() => source.close());
    await source.refresh();
    expect(source.getSnapshot()).toMatchObject({
      state: 'unreadable',
      source: path,
    });
    expect(source.getSnapshot().detail).toContain('4 MiB');
    expect((await stat(path)).size).toBe(bytes.length);

    await writeFile(path, Buffer.from([0xff]));
    await source.refresh();
    expect(source.getSnapshot()).toMatchObject({
      state: 'unreadable',
      source: path,
    });
    expect(await readFile(path)).toEqual(Buffer.from([0xff]));
  });

  it('never rewrites a file during refresh', async () => {
    const { path } = await fixture();
    const exactText = '{ "owner": "external", "done": false }\n';
    await writeFile(path, exactText);
    const before = await stat(path, { bigint: true });
    const source = createWorkflowSource(path, 60_000);
    cleanups.push(() => source.close());

    await source.refresh();
    await source.refresh();
    const after = await stat(path, { bigint: true });
    expect(await readFile(path, 'utf8')).toBe(exactText);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
  });
});
