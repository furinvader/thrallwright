#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const runFile = promisify(execFile);
const shaPattern = /^[0-9a-f]{40}$/i;
const titlePattern =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([a-z][a-z0-9-]*\))?!?: (.+)$/u;
const guidance =
  'Use type(scope)!: summary with a lowercase allowed type, optional scope and !, and a nonempty one-line summary.';

export function validTitle(title) {
  if (typeof title !== 'string' || /[\r\n\u2028\u2029]/u.test(title))
    return false;
  const match = titlePattern.exec(title);
  return match !== null && match[2].trim() === match[2];
}

function isSha(value) {
  return (
    typeof value === 'string' && value.length === 40 && shaPattern.test(value)
  );
}

function eventSha(value, label) {
  if (!isSha(value))
    throw new Error(`${label} must be a 40-character Git SHA.`);
  if (/^0+$/.test(value))
    throw new Error(`${label} cannot be an all-zero Git SHA.`);
  return value.toLowerCase();
}

export function getEventRange(eventName, event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event))
    throw new Error('GitHub event payload must be a JSON object.');
  if (eventName === 'pull_request') {
    const request = event.pull_request;
    if (
      request === null ||
      typeof request !== 'object' ||
      Array.isArray(request)
    )
      throw new Error('Pull request event has no pull_request object.');
    if (typeof request.title !== 'string')
      throw new Error('Pull request event has no title.');
    // The default Actions checkout may point at a synthetic merge commit.
    // Event SHAs select only the actual PR commits.
    return {
      from: eventSha(request.base?.sha, 'Pull request base SHA'),
      to: eventSha(request.head?.sha, 'Pull request head SHA'),
      title: request.title,
    };
  }
  if (eventName === 'push') {
    if (event.ref !== 'refs/heads/main')
      throw new Error('Only pushes to refs/heads/main are supported.');
    return {
      from: eventSha(event.before, 'Push before SHA'),
      to: eventSha(event.after, 'Push after SHA'),
    };
  }
  throw new Error(`Unsupported GitHub event: ${eventName || '(missing)'}.`);
}

async function git(args, cwd) {
  const { stdout } = await runFile('git', args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.replace(/\n$/, '');
}

async function resolveCommit(ref, cwd) {
  if (typeof ref !== 'string' || !ref)
    throw new Error('Both --from and --to need a Git reference.');
  // --end-of-options prevents a local ref from becoming a Git option. No shell
  // interprets any user-supplied text.
  const sha = await git(
    ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    cwd,
  );
  if (!isSha(sha)) throw new Error(`Could not resolve Git ref ${ref}.`);
  return sha;
}

export async function checkCommitTitles(
  { from, to, title },
  cwd = process.cwd(),
) {
  const base = await resolveCommit(from, cwd);
  const head = await resolveCommit(to, cwd);
  const listed = await git(['rev-list', '--reverse', `${base}..${head}`], cwd);
  const commits = listed ? listed.split('\n') : [];
  if (commits.length === 0)
    throw new Error('The selected Git range contains no commits.');
  const errors = [];
  if (title !== undefined && !validTitle(title))
    errors.push('Pull request title does not follow the commit convention.');
  for (const sha of commits) {
    if (!isSha(sha)) throw new Error('Git returned a malformed commit SHA.');
    // %s normalizes whitespace; inspect the stored first line instead.
    const subject = (await git(['show', '-s', '--format=%B', sha], cwd)).split(
      '\n',
      1,
    )[0];
    if (!validTitle(subject))
      errors.push(`Commit ${sha.slice(0, 12)} has an invalid subject.`);
  }
  return { commits: commits.length, errors };
}

async function main() {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      title: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: node scripts/check-commit-titles.mjs [--from REF --to REF [--title TEXT]]\nWith no arguments, check the GitHub Actions event.',
    );
    return;
  }
  const local =
    values.from !== undefined ||
    values.to !== undefined ||
    values.title !== undefined;
  let range;
  if (local) {
    if (values.from === undefined || values.to === undefined)
      throw new Error('Local mode requires both --from and --to.');
    range = values;
  } else {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath || !process.env.GITHUB_EVENT_NAME)
      throw new Error(
        'No GitHub event; use --from REF --to REF for local checks.',
      );
    const event = JSON.parse(await readFile(eventPath, 'utf8'));
    range = getEventRange(process.env.GITHUB_EVENT_NAME, event);
  }
  const result = await checkCommitTitles(range);
  if (result.errors.length) {
    for (const error of result.errors) console.error(error);
    console.error(guidance);
    process.exitCode = 1;
  } else {
    console.log(`Commit convention passed for ${result.commits} commit(s).`);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  main().catch((error) => {
    console.error(`Commit convention check failed: ${error.message}`);
    process.exitCode = 1;
  });
