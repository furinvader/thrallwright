import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  githubReader,
  verifyRepositorySettings,
} from './check-repo-settings.mjs';

const ruleset = JSON.parse(
  await readFile(new URL('../.github/main-ruleset.json', import.meta.url)),
);
const settings = JSON.parse(
  await readFile(
    new URL('../.github/repository-settings.json', import.meta.url),
  ),
);

function fixture() {
  const prefix = 'repos/furinvader/thrallwright';
  const responses = new Map([
    [
      `${prefix}/rulesets?per_page=100`,
      [[{ id: 7, name: 'Other' }], [{ id: 42, name: ruleset.name }]],
    ],
    [
      `${prefix}/rulesets/42`,
      { ...structuredClone(ruleset), id: 42, extraDefault: false },
    ],
    [
      `${prefix}/rules/branches/main?per_page=100`,
      [
        ruleset.rules.map((rule) => ({
          ...structuredClone(rule),
          ruleset_id: 42,
        })),
      ],
    ],
    [prefix, { ...settings, unrelated: 'preserved' }],
    [
      `${prefix}/branches/main/protection`,
      Object.assign(new Error('not protected'), {
        status: 404,
        apiMessage: 'Branch not protected',
      }),
    ],
  ]);
  const requests = [];
  const get = async (path, options) => {
    requests.push({ path, options });
    assert.ok(responses.has(path), `unexpected request ${path}`);
    const response = responses.get(path);
    if (response instanceof Error) throw response;
    return response;
  };
  return { prefix, responses, requests, get, ruleset, settings };
}

test('finds paginated rulesets, accepts reordered rules/defaults, and reports additional policies', async () => {
  const f = fixture();
  f.responses.get(`${f.prefix}/rulesets/42`).rules.reverse();
  const effectivePages = f.responses.get(
    `${f.prefix}/rules/branches/main?per_page=100`,
  );
  effectivePages[0].reverse();
  effectivePages.push([{ type: 'creation', ruleset_id: 7 }]);
  f.responses.set(`${f.prefix}/branches/main/protection`, {
    required_linear_history: { enabled: true },
  });
  const result = await verifyRepositorySettings(f);
  assert.equal(result.rulesetId, 42);
  assert.equal(f.requests[0].options.paginate, true);
  assert.equal(
    f.requests.find(({ path }) => path.includes('/rules/branches/')).options
      .paginate,
    true,
  );
  assert.deepEqual(result.additionalEffectiveRules, [
    { type: 'creation', ruleset_id: 7 },
  ]);
  assert.equal(result.classicProtection.required_linear_history.enabled, true);
});

test('verifies owned rules across all pages and rejects incomplete page shapes', async () => {
  const f = fixture();
  const path = `${f.prefix}/rules/branches/main?per_page=100`;
  const pages = f.responses.get(path);
  pages.push([pages[0].pop()]);
  assert.equal((await verifyRepositorySettings(f)).rulesetId, 42);
  for (const malformed of [{}, [pages[0], null]]) {
    f.responses.set(path, malformed);
    await assert.rejects(verifyRepositorySettings(f), /invalid paginated data/);
  }
});

test('distinguishes absent classic protection from an incomplete API check', async () => {
  const f = fixture();
  assert.equal((await verifyRepositorySettings(f)).classicProtection, null);
  for (const error of [
    new Error('network unavailable'),
    Object.assign(new Error('Not Found'), {
      status: 404,
      apiMessage: 'Not Found',
    }),
    Object.assign(new Error('Forbidden'), { status: 403 }),
  ]) {
    f.responses.set(`${f.prefix}/branches/main/protection`, error);
    await assert.rejects(verifyRepositorySettings(f), error);
  }
});

test('rejects missing or duplicate owned rulesets', async () => {
  for (const listed of [
    [],
    [
      { id: 42, name: ruleset.name },
      { id: 43, name: ruleset.name },
    ],
  ]) {
    const f = fixture();
    f.responses.set(`${f.prefix}/rulesets?per_page=100`, [listed]);
    await assert.rejects(verifyRepositorySettings(f), /Expected one/);
  }
});

test('rejects changed enforcement, check origin, bypass actors and merge policy', async () => {
  for (const mutate of [
    (f) => {
      f.responses.get(`${f.prefix}/rulesets/42`).enforcement = 'disabled';
    },
    (f) => {
      f.responses
        .get(`${f.prefix}/rulesets/42`)
        .rules.find(
          (rule) => rule.type === 'required_status_checks',
        ).parameters.required_status_checks[0].integration_id = 999;
    },
    (f) => {
      f.responses.get(`${f.prefix}/rulesets/42`).bypass_actors.push({
        actor_id: 1,
        actor_type: 'Integration',
        bypass_mode: 'always',
      });
    },
    (f) => {
      f.responses.get(f.prefix).allow_auto_merge = true;
    },
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(verifyRepositorySettings(f));
  }
});

test('requires all effective rules to have the owned ruleset provenance', async () => {
  const f = fixture();
  f.responses.get(
    `${f.prefix}/rules/branches/main?per_page=100`,
  )[0][0].ruleset_id = 7;
  await assert.rejects(verifyRepositorySettings(f), /effective main rules/);
});

test('rejects duplicate check entries and unexpected owned rule types', async () => {
  const f = fixture();
  const actual = f.responses.get(`${f.prefix}/rulesets/42`);
  const checks = actual.rules.find(
    (rule) => rule.type === 'required_status_checks',
  ).parameters.required_status_checks;
  checks[1] = structuredClone(checks[0]);
  await assert.rejects(verifyRepositorySettings(f));
  const g = fixture();
  g.responses.get(`${g.prefix}/rulesets/42`).rules.push({ type: 'creation' });
  await assert.rejects(verifyRepositorySettings(g));
});

test('CLI reader uses GET for normal and paginated calls and preserves API failure identity', async () => {
  const calls = [];
  const get = githubReader(async (...args) => {
    calls.push(args);
    return { stdout: '[]' };
  });
  await get('repos/example/repo');
  await get('repos/example/repo/rulesets', { paginate: true });
  assert.deepEqual(
    calls.map((call) => call.slice(0, 2)),
    [
      ['gh', ['api', '--method', 'GET', 'repos/example/repo']],
      [
        'gh',
        [
          'api',
          '--method',
          'GET',
          '--paginate',
          '--slurp',
          'repos/example/repo/rulesets',
        ],
      ],
    ],
  );
  const failing = githubReader(async () => {
    throw Object.assign(new Error('gh failed'), {
      stdout: JSON.stringify({
        message: 'Branch not protected',
        status: '404',
      }),
    });
  });
  await assert.rejects(failing('repos/example/repo/branches/main/protection'), {
    status: 404,
    apiMessage: 'Branch not protected',
  });
});
