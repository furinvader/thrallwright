import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { validTitle } from './check-commit-titles.mjs';

// These checks exercise the pinned Renovate implementation, not a second
// implementation of its matching, merge, extraction, or release-age rules.
const renovateRoot = process.env.THRALLWRIGHT_RENOVATE_ROOT;
if (!renovateRoot) {
  throw new Error('Run just check-renovate inside nix develop.');
}
const load = (path) =>
  import(pathToFileURL(resolve(renovateRoot, 'dist', path)).href);
const { init: initializeLogger } = await load('logger/index.js');
await initializeLogger();
const { getConfig } = await load('config/defaults.js');
const { mergeChildConfig } = await load('config/utils.js');
const { GlobalConfig } = await load('config/global.js');
const { applyPackageRules } = await load('util/package-rules/index.js');
const { getEnabledManagersList } = await load('modules/manager/index.js');
const { extractPackageFile: extractNpm } = await load(
  'modules/manager/npm/extract/index.js',
);
const { extractPackageFile: extractActions } = await load(
  'modules/manager/github-actions/extract.js',
);
const { filterInternalChecks } = await load(
  'workers/repository/process/lookup/filter-checks.js',
);
const { applyMinimumReleaseAgeToDigestUpdate } = await load(
  'workers/repository/process/lookup/digest.js',
);
const { api: npmVersioning } = await load('modules/versioning/npm/index.js');
const { generateBranchConfig } = await load(
  'workers/repository/updates/generate.js',
);
const config = mergeChildConfig(
  getConfig(),
  JSON.parse(await readFile(new URL('../renovate.json', import.meta.url))),
);
GlobalConfig.set({ localDir: process.cwd(), platform: 'github' });

async function dependency(manager, dep) {
  return applyPackageRules({ ...config, manager, ...dep });
}

test('extraction leaves toolchains and workspace versions manual', async () => {
  assert.deepEqual(getEnabledManagersList(config.enabledManagers).sort(), [
    'github-actions',
    'npm',
  ]);
  const manifest = {
    name: 'policy-fixture',
    packageManager: 'pnpm@10.34.5',
    engines: { node: '>=24.15 <25' },
    dependencies: {
      zod: '4.0.0',
      '@thrallwright/contracts': 'workspace:0.1.0',
    },
    devDependencies: { typescript: '6.0.3' },
    optionalDependencies: { esbuild: '0.27.0' },
    peerDependencies: { rxjs: '7.8.2' },
  };
  const extracted = await extractNpm(
    JSON.stringify(manifest),
    'package.json',
    config,
  );
  assert.ok(extracted);
  const byName = new Map();
  for (const dep of extracted.deps) {
    byName.set(dep.depName, await dependency('npm', dep));
  }
  for (const name of ['zod', 'typescript', 'esbuild', 'rxjs']) {
    assert.equal(byName.get(name)?.enabled, true, name);
    assert.equal(byName.get(name)?.rangeStrategy, 'pin', name);
  }
  for (const name of ['node', 'pnpm', '@thrallwright/contracts']) {
    assert.equal(byName.get(name)?.enabled, false, name);
  }
});

test('Action extraction enables immutable references but excludes runtime inputs and runners', async () => {
  const extracted = await extractActions(
    `name: Policy fixture
on: push
jobs:
  check:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4.2.2
      - uses: actions/setup-node@v4.4.0
        with:
          node-version: 24.15.0
  reusable:
    uses: example/workflows/.github/workflows/check.yml@v1.0.0
`,
    '.github/workflows/policy-fixture.yml',
    config,
  );
  assert.ok(extracted);
  const seen = new Set();
  for (const dep of extracted.deps) {
    seen.add(dep.depType);
    const resolved = await dependency('github-actions', dep);
    const allowed = ['action', 'workflow'].includes(dep.depType);
    assert.equal(resolved.enabled, allowed, dep.depName);
    if (allowed) assert.equal(resolved.pinDigests, true, dep.depName);
  }
  for (const type of ['action', 'workflow', 'uses-with', 'github-runner']) {
    assert.ok(seen.has(type), `fixture must exercise ${type}`);
  }
});

test('coupled Angular groups stay separate from unrelated compatibility updates', async () => {
  const groups = [];
  for (const name of [
    '@angular/core',
    '@angular/cli',
    '@angular/material',
    '@angular/cdk',
    'angular-eslint',
    '@angular-eslint/eslint-plugin',
    'typescript',
    'rxjs',
  ]) {
    const dep = await dependency('npm', {
      depName: name,
      packageName: name,
      depType: 'devDependencies',
    });
    groups.push(dep.groupName);
  }
  assert.equal(groups[0], groups[1]);
  assert.equal(groups[2], groups[3]);
  assert.equal(groups[4], groups[5]);
  assert.equal(new Set(groups.slice(0, 6)).size, 3);
  assert.equal(groups[6], null);
  assert.equal(groups[7], null);
  assert.equal(config.separateMajorMinor, true);
});

const daysAgo = (days) =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

test('routine release lookup holds young and undated versions while preserving dashboard approval', async () => {
  const dep = await dependency('npm', {
    depName: 'zod',
    packageName: 'zod',
    depType: 'dependencies',
    datasource: 'npm',
    currentVersion: '4.0.0',
  });
  for (const [timestamp, pending] of [
    [daysAgo(1), true],
    [undefined, true],
    [daysAgo(31), false],
  ]) {
    const result = await filterInternalChecks(dep, npmVersioning, 'latest', [
      { version: '4.0.1', releaseTimestamp: timestamp },
    ]);
    assert.equal(result.pendingChecks, pending);
  }
  assert.equal(dep.dependencyDashboardApproval, true);
  assert.equal(dep.draftPR, true);
  assert.equal(dep.automerge, false);
  assert.equal(dep.platformAutomerge, false);

  const action = await dependency('github-actions', {
    depName: 'actions/checkout',
    depType: 'action',
  });
  for (const updateType of ['digest', 'pinDigest']) {
    const update = { updateType };
    await applyMinimumReleaseAgeToDigestUpdate(
      update,
      action,
      {},
      true,
      undefined,
    );
    assert.equal(update.pendingChecks, true, updateType);
  }
});

test('security overrides remove preparation gates but retain draft, review and merge safeguards', async () => {
  const routine = await dependency('npm', {
    depName: 'zod',
    packageName: 'zod',
    depType: 'dependencies',
    datasource: 'npm',
    currentVersion: '4.0.0',
  });
  // Renovate applies vulnerabilityAlerts as a forced child configuration.
  const security = mergeChildConfig(routine, {
    force: routine.vulnerabilityAlerts,
  });
  const result = await filterInternalChecks(security, npmVersioning, 'latest', [
    { version: '4.0.1', releaseTimestamp: daysAgo(1) },
  ]);
  assert.equal(result.pendingChecks, false);
  assert.equal(security.dependencyDashboardApproval, false);
  assert.equal(security.prCreation, 'immediate');
  assert.equal(security.prConcurrentLimit, 0);
  assert.equal(security.vulnerabilityFixStrategy, 'lowest');
  assert.equal(security.draftPR, true);
  assert.equal(security.automerge, false);
  assert.equal(security.platformAutomerge, false);
  const manualToolchain = await dependency('npm', {
    depName: 'pnpm',
    depType: 'packageManager',
  });
  assert.equal(
    mergeChildConfig(manualToolchain, {
      force: manualToolchain.vulnerabilityAlerts,
    }).enabled,
    false,
    'security proposals must not re-enable manual toolchain changes',
  );

  const branch = generateBranchConfig([
    {
      ...security,
      newValue: '4.0.1',
      newVersion: '4.0.1',
      updateType: 'patch',
    },
  ]);
  assert.ok(validTitle(branch.prTitle), branch.prTitle);
  assert.ok(validTitle(branch.commitMessage), branch.commitMessage);
});
