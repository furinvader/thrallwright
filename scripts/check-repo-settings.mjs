#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repository = 'furinvader/thrallwright';

function canonical(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical).sort());
  if (value && typeof value === 'object')
    return JSON.stringify(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return JSON.stringify(value);
}

/** Extra object defaults are allowed; arrays must contain exactly the expected members. */
export function expectFields(actual, expected, location = 'configuration') {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length)
      throw new Error(`${location}: array length or type differs`);
    if (new Set(actual.map(canonical)).size !== actual.length)
      throw new Error(`${location}: duplicate array member`);
    const remaining = [...actual];
    for (const wanted of expected) {
      const index = remaining.findIndex((candidate) => {
        try {
          expectFields(candidate, wanted, location);
          return true;
        } catch {
          return false;
        }
      });
      if (index < 0)
        throw new Error(
          `${location}: missing expected member ${JSON.stringify(wanted)}`,
        );
      remaining.splice(index, 1);
    }
  } else if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual))
      throw new Error(`${location}: expected an object`);
    for (const [key, value] of Object.entries(expected)) {
      if (!Object.hasOwn(actual, key))
        throw new Error(`${location}.${key}: missing field`);
      expectFields(actual[key], value, `${location}.${key}`);
    }
  } else if (actual !== expected) {
    throw new Error(
      `${location}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

/** All calls, including pagination, explicitly use GET. No repair operation exists. */
export function githubReader(run = execute) {
  return async (path, { paginate = false } = {}) => {
    try {
      const { stdout } = await run(
        'gh',
        [
          'api',
          '--method',
          'GET',
          ...(paginate ? ['--paginate', '--slurp'] : []),
          path,
        ],
        { maxBuffer: 8 * 1024 * 1024 },
      );
      return JSON.parse(stdout);
    } catch (cause) {
      let response;
      try {
        response = JSON.parse(cause.stdout);
      } catch {
        /* Transport/CLI failure. */
      }
      const error = new Error(
        `Unable to verify ${path}: ${response?.message ?? cause.stderr?.trim() ?? cause.message}`,
        { cause },
      );
      error.status = Number(
        response?.status ?? cause.stderr?.match(/HTTP (\d{3})/)?.[1],
      );
      error.apiMessage = response?.message;
      throw error;
    }
  };
}

export async function verifyRepositorySettings({
  get,
  ruleset,
  settings,
  repo = repository,
}) {
  const prefix = `repos/${repo}`;
  const pages = await get(`${prefix}/rulesets?per_page=100`, {
    paginate: true,
  });
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)))
    throw new Error('Ruleset discovery returned invalid paginated data');
  const listed = pages.flat();
  const owned = listed.filter((candidate) => candidate.name === ruleset.name);
  if (owned.length !== 1)
    throw new Error(
      `Expected one ${ruleset.name} ruleset; found ${owned.length}`,
    );
  const actual = await get(`${prefix}/rulesets/${owned[0].id}`);
  expectFields(actual, ruleset, 'ruleset');
  if (
    new Set(actual.rules.map((rule) => rule.type)).size !== actual.rules.length
  )
    throw new Error('Owned ruleset has duplicate rule types');

  const effective = await get(`${prefix}/rules/branches/main`);
  if (!Array.isArray(effective))
    throw new Error('Effective rules response is not an array');
  const ownedEffective = effective.filter(
    (rule) => rule.ruleset_id === actual.id,
  );
  expectFields(ownedEffective, ruleset.rules, 'effective main rules');
  const actualSettings = await get(prefix);
  expectFields(actualSettings, settings, 'repository settings');

  let classicProtection;
  try {
    classicProtection = await get(`${prefix}/branches/main/protection`);
  } catch (error) {
    if (error.status !== 404 || error.apiMessage !== 'Branch not protected')
      throw error;
    classicProtection = null;
  }
  return {
    repository: repo,
    verifiedAt: new Date().toISOString(),
    rulesetId: actual.id,
    rulesetUrl:
      actual._links?.html?.href ??
      `https://github.com/${repo}/rules/${actual.id}`,
    result:
      'Expected configured and effective rules and merge settings verified',
    verifiedRules: ruleset.rules.map((rule) => rule.type),
    verifiedSettings: Object.fromEntries(
      Object.keys(settings).map((key) => [key, actualSettings[key]]),
    ),
    additionalEffectiveRules: effective.filter(
      (rule) => rule.ruleset_id !== actual.id,
    ),
    classicProtection,
    note: 'Additional policies are reported for maintainer inspection; this command does not modify GitHub.',
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const root = new URL('../.github/', import.meta.url);
    const ruleset = JSON.parse(
      await readFile(new URL('main-ruleset.json', root), 'utf8'),
    );
    const settings = JSON.parse(
      await readFile(new URL('repository-settings.json', root), 'utf8'),
    );
    console.log(
      JSON.stringify(
        await verifyRepositorySettings({
          get: githubReader(),
          ruleset,
          settings,
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(`Repository settings verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
