import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { checkDocumentation, markdownFiles } from './check-docs.mjs';

const execute = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'thrallwright-docs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execute('git', ['init', '--quiet', root]);
  return root;
}

test('discovers tracked and new Markdown, including hidden directories, without ignored or deleted inputs', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, '.github'));
  await mkdir(join(root, 'output'));
  await writeFile(join(root, '.gitignore'), 'output/\n');
  for (const file of ['tracked.md', 'deleted.md'])
    await writeFile(join(root, file), '# Tracked\n');
  await execute('git', ['add', '.'], { cwd: root });
  await rm(join(root, 'deleted.md'));
  await writeFile(join(root, '.github', 'new.md'), '# New\n');
  await writeFile(join(root, 'new file.markdown'), '# New\n');
  await writeFile(join(root, 'output', 'ignored.md'), '[bad](missing)\n');
  assert.deepEqual(await markdownFiles(root), [
    '.github/new.md',
    'new file.markdown',
    'tracked.md',
  ]);
});

test('checks local references and GitHub heading anchors while ignoring code examples and remote URLs', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, '.github'));
  await mkdir(join(root, 'folder'));
  await writeFile(
    join(root, 'target file.md'),
    '# Target heading\n\n## Duplicate\n\n## Duplicate\n',
  );
  await writeFile(
    join(root, '.github', 'template.md'),
    '[target](../target%20file.md#target-heading)\n',
  );
  await writeFile(
    join(root, 'README.md'),
    '# Local heading\n\n[local](#local-heading)\n[duplicate](target%20file.md#duplicate-1)\n[folder](folder/)\n[reference][target]\n\n[target]: target%20file.md#target-heading\n\n[remote](https://example.invalid/missing)\n\n```md\n[example](missing.md#missing)\n```\n',
  );
  const result = await checkDocumentation(root);
  assert.equal(result.files.length, 3);
});

test('fails for missing link targets and missing local or cross-file anchors', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'target.md'), '# Present\n');
  for (const link of ['missing.md', '#absent', 'target.md#absent']) {
    await writeFile(
      join(root, 'README.md'),
      `# Present\n\n[broken](${link})\n`,
    );
    await assert.rejects(
      checkDocumentation(root),
      /Documentation link check failed/,
    );
  }
});
