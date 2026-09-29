#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('..', import.meta.url));

/** Include hidden directories and uncommitted documentation, but no ignored output. */
export async function markdownFiles(root = repository) {
  const { stdout } = await execute(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      '*.md',
      '*.markdown',
    ],
    { cwd: root, maxBuffer: 8 * 1024 * 1024 },
  );
  const files = [];
  for (const file of new Set(stdout.split('\0').filter(Boolean))) {
    try {
      if ((await stat(resolve(root, file))).isFile()) files.push(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return files.sort();
}

/** Delegate Markdown parsing and GitHub-style heading anchors to Lychee. */
export async function checkDocumentation(root = repository) {
  const files = await markdownFiles(root);
  if (files.length === 0)
    throw new Error('No Markdown files found to validate.');
  try {
    const { stdout, stderr } = await execute(
      'lychee',
      [
        '--offline',
        '--include-fragments=anchor-only',
        '--no-progress',
        '--',
        ...files,
      ],
      { cwd: root, maxBuffer: 8 * 1024 * 1024 },
    );
    return { files, output: stdout + stderr };
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        'Lychee is unavailable; run this command in nix develop.',
      );
    }
    throw new Error(
      `Documentation link check failed:\n${error.stdout ?? ''}${error.stderr ?? error.message}`,
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { files, output } = await checkDocumentation();
    process.stdout.write(output);
    console.log(
      `Local documentation links and anchors passed (${files.length} Markdown files). External URLs were not checked.`,
    );
    await execute(
      'pnpm',
      [
        'exec',
        'prettier',
        '--check',
        '.github/ISSUE_TEMPLATE',
        '.github/PULL_REQUEST_TEMPLATE.md',
      ],
      { cwd: repository },
    );
    console.log(
      'GitHub template formatting passed; wording and rendering still require review.',
    );
  } catch (error) {
    console.error(error.stdout ?? '');
    console.error(error.stderr ?? error.message);
    process.exitCode = 1;
  }
}
