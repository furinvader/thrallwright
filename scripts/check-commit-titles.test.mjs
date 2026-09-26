import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import {
  checkCommitTitles,
  getEventRange,
  validTitle,
} from './check-commit-titles.mjs';

const script = fileURLToPath(
  new URL('./check-commit-titles.mjs', import.meta.url),
);
const fixtures = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((dir) => rm(dir, { recursive: true })),
  );
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function repository() {
  const dir = await mkdtemp(join(tmpdir(), 'thrallwright-commits-'));
  fixtures.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Commit Test');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(
    dir,
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'Historical unprefixed subject',
  );
  return { dir, initial: git(dir, 'rev-parse', 'HEAD') };
}

function commit(dir, title) {
  git(dir, 'commit', '-q', '--allow-empty', '--cleanup=verbatim', '-m', title);
  return git(dir, 'rev-parse', 'HEAD');
}

async function eventRun(dir, name, payload) {
  const path = join(dir, 'event.json');
  await writeFile(path, JSON.stringify(payload));
  return spawnSync(process.execPath, [script], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: path },
  });
}

test('accepts allowed types, lowercase scopes, and breaking markers', () => {
  for (const title of [
    'feat: add workflow view',
    'fix(server): preserve state',
    'docs!: replace the guide',
    'ci(commit-check)!: enforce titles',
    'style: format files',
    'refactor: simplify wiring',
    'perf: reduce polling',
    'test: cover restart',
    'build: pin dependency',
    'chore: prepare release',
    'revert: undo migration',
  ])
    assert.equal(validTitle(title), true, title);
});

test('rejects ranges, temporary subjects, bad scopes, and multiline or empty summaries', () => {
  for (const title of [
    'Initial commit',
    'Feat: add view',
    'feature: add view',
    'feat(Web): add view',
    'feat(): add view',
    'feat: ',
    'feat:  extra leading space',
    'feat: trailing space ',
    'feat: first\nsecond',
    'fixup! feat: original',
    'feat: first\u2028second',
  ])
    assert.equal(validTitle(title), false, title);
});

test('selects PR head/base and main push before/after, rejecting bad metadata', () => {
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const merge = 'c'.repeat(40);
  const pr = {
    action: 'edited',
    after: merge,
    pull_request: {
      title: 'docs: update guide',
      base: { sha: base },
      head: { sha: head },
    },
  };
  assert.deepEqual(getEventRange('pull_request', pr), {
    from: base,
    to: head,
    title: 'docs: update guide',
  });
  assert.deepEqual(
    getEventRange('push', {
      ref: 'refs/heads/main',
      before: base,
      after: merge,
    }),
    { from: base, to: merge },
  );
  assert.throws(() =>
    getEventRange('push', {
      ref: 'refs/heads/topic',
      before: base,
      after: head,
    }),
  );
  assert.throws(() =>
    getEventRange('push', {
      ref: 'refs/heads/main',
      before: '0'.repeat(40),
      after: head,
    }),
  );
  assert.throws(() =>
    getEventRange('push', {
      ref: 'refs/heads/main',
      before: `${base}\n`,
      after: head,
    }),
  );
  assert.throws(() =>
    getEventRange('pull_request', {
      pull_request: {
        title: 'feat: x',
        base: { sha: 'HEAD' },
        head: { sha: head },
      },
    }),
  );
  assert.throws(() => getEventRange('workflow_dispatch', {}));
  assert.throws(() => getEventRange('pull_request', null));
});

test('checks only real PR commits, not a synthetic checkout merge or old history', async () => {
  const { dir, initial } = await repository();
  git(dir, 'switch', '-q', '-c', 'feature');
  commit(dir, 'feat: first change');
  const head = commit(dir, 'fix(server): second change');
  git(dir, 'switch', '-q', 'main');
  const base = commit(dir, 'chore: update main');
  git(
    dir,
    'merge',
    '-q',
    '--no-ff',
    'feature',
    '-m',
    'Synthetic merge without prefix',
  );
  assert.notEqual(git(dir, 'rev-parse', 'HEAD'), head);
  const good = await eventRun(dir, 'pull_request', {
    action: 'edited',
    pull_request: {
      title: 'feat: add two changes',
      base: { sha: base },
      head: { sha: head },
    },
  });
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /2 commit\(s\)/);
  const local = spawnSync(
    process.execPath,
    [script, '--from', base, '--to', head, '--title', 'feat: add two changes'],
    { cwd: dir, encoding: 'utf8' },
  );
  assert.equal(local.status, 0, local.stderr);
  const badTitle = await eventRun(dir, 'pull_request', {
    action: 'edited',
    pull_request: {
      title: 'Add two changes',
      base: { sha: base },
      head: { sha: head },
    },
  });
  assert.equal(badTitle.status, 1);
  assert.match(badTitle.stderr, /Pull request title/);
  const push = await eventRun(dir, 'push', {
    ref: 'refs/heads/main',
    before: initial,
    after: base,
  });
  assert.equal(push.status, 0, push.stderr);
  assert.match(push.stdout, /1 commit\(s\)/);
});

test('rejects invalid commits within the selected range and never evaluates shell text', async () => {
  const { dir, initial } = await repository();
  const marker = join(dir, 'injected');
  commit(dir, `feat: $(touch ${marker})`);
  assert.deepEqual(
    (await checkCommitTitles({ from: initial, to: 'HEAD' }, dir)).errors,
    [],
  );
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await assert.rejects(
    checkCommitTitles({ from: `$(touch ${marker})`, to: 'HEAD' }, dir),
  );
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  const beforeBad = git(dir, 'rev-parse', 'HEAD');
  const bad = commit(dir, 'temporary work');
  const result = await checkCommitTitles({ from: initial, to: bad }, dir);
  assert.equal(result.commits, 2);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], new RegExp(bad.slice(0, 12)));
  assert.deepEqual(
    (await checkCommitTitles({ from: initial, to: beforeBad }, dir)).errors,
    [],
  );
});

test('rejects a malformed merge subject, fixup subject, and trailing-space subject', async () => {
  const { dir, initial } = await repository();
  git(dir, 'switch', '-q', '-c', 'feature');
  commit(dir, 'feat: valid branch commit');
  git(dir, 'switch', '-q', '-c', 'side', initial);
  commit(dir, 'test: valid side commit');
  git(dir, 'switch', '-q', 'feature');
  const merge = git(
    dir,
    'merge',
    '-q',
    '--no-ff',
    'side',
    '-m',
    'Merge side branch',
  );
  assert.equal(merge, '');
  commit(dir, 'fixup! feat: valid branch commit');
  commit(dir, 'feat: trailing space ');
  const result = await checkCommitTitles({ from: initial, to: 'HEAD' }, dir);
  assert.equal(result.commits, 5);
  assert.equal(result.errors.length, 3, JSON.stringify(result));
});

test('fails closed on missing or malformed GitHub event data and empty ranges', async () => {
  const { dir, initial } = await repository();
  const empty = await eventRun(dir, 'push', {
    ref: 'refs/heads/main',
    before: initial,
    after: initial,
  });
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /contains no commits/);
  const unsupported = await eventRun(dir, 'repository_dispatch', {});
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /Unsupported GitHub event/);
  const unavailableOldHead = await eventRun(dir, 'push', {
    ref: 'refs/heads/main',
    before: 'f'.repeat(40),
    after: initial,
  });
  assert.equal(unavailableOldHead.status, 1);
  const path = join(dir, 'broken.json');
  await writeFile(path, '{bad JSON');
  const malformed = spawnSync(process.execPath, [script], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: path },
  });
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /Commit convention check failed/);
});
