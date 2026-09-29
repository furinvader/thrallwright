import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { checkDependencies, manifestPaths } from './check-dependencies.mjs';

const fixtures = [];

afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(rootDependencies = {}) {
  const root = await mkdtemp(join(tmpdir(), 'thrallwright-deps-'));
  fixtures.push(root);
  await writeManifest(root, {
    name: 'test-root',
    private: true,
    ...rootDependencies,
  });
  await writeManifest(join(root, 'packages', 'contracts'), {
    name: '@test/contracts',
    version: '1.2.3-beta.2+build.004',
  });
  await writeManifest(join(root, 'apps', 'web'), {
    name: '@test/web',
    version: '2.0.0',
  });
  return root;
}

async function writeManifest(directory, value) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify(value));
}

test('accepts exact SemVer and matching workspace versions in every section', async () => {
  const root = await fixture({
    dependencies: {
      alpha: '1.2.3',
      '@test/contracts': 'workspace:1.2.3-beta.2+build.004',
    },
    devDependencies: { beta: '0.0.0-pre.1+build' },
    optionalDependencies: { gamma: '12.34.56+001' },
    peerDependencies: { delta: '1.0.0-rc.1' },
  });
  assert.deepEqual(await checkDependencies(root), []);
});

test('rejects ranges, tags, URLs, aliases, partial versions, and malformed SemVer', async () => {
  const specs = {
    caret: '^1.2.3',
    tilde: '~1.2.3',
    range: '>=1.2.3 <2',
    wildcard: '*',
    tag: 'latest',
    url: 'https://example.test/pkg.tgz',
    file: 'file:../pkg',
    alias: 'npm:other@1.2.3',
    partial: '1.2',
    leadingMajor: '01.2.3',
    leadingPrerelease: '1.2.3-01',
    emptyBuild: '1.2.3+',
    trailingNewline: '1.2.3\n',
  };
  const root = await fixture({ dependencies: specs });
  const errors = await checkDependencies(root);
  assert.equal(errors.length, Object.keys(specs).length);
  for (const name of Object.keys(specs))
    assert.ok(
      errors.some((error) =>
        error.includes(`package.json dependencies ${name}:`),
      ),
    );
});

test('requires the workspace target and exactly matching version', async () => {
  const root = await fixture({
    dependencies: {
      '@test/contracts': 'workspace:1.2.3',
      '@test/missing': 'workspace:1.0.0',
      '@test/web': 'workspace:*',
    },
  });
  assert.deepEqual(await checkDependencies(root), [
    'package.json dependencies @test/contracts: workspace target is 1.2.3-beta.2+build.004, requested 1.2.3',
    'package.json dependencies @test/missing: workspace target does not exist',
    'package.json dependencies @test/web: workspace: must specify exact SemVer',
  ]);
});

test('checks every first-party manifest but ignores generated nested package files', async () => {
  const root = await fixture();
  await writeManifest(join(root, 'apps', 'web'), {
    name: '@test/web',
    version: '2.0.0',
    peerDependencies: { bad: '^3.0.0' },
  });
  await writeManifest(join(root, 'apps', 'web', 'dist'), {
    name: 'generated',
    version: '1.0.0',
    dependencies: { ignored: 'latest' },
  });
  await writeManifest(join(root, 'apps', 'web', 'node_modules', 'tool'), {
    name: 'installed',
    version: '1.0.0',
    dependencies: { ignored: '*' },
  });
  await writeManifest(join(root, 'apps', 'dist'), {
    name: '@test/dist',
    version: '1.0.0',
    dependencies: { bad: 'latest' },
  });
  assert.deepEqual(await checkDependencies(root), [
    'apps/dist/package.json dependencies bad: expected exact SemVer, got "latest"',
    'apps/web/package.json peerDependencies bad: expected exact SemVer, got "^3.0.0"',
  ]);
});

test('reports malformed sections and invalid workspace versions', async () => {
  const root = await fixture({ optionalDependencies: ['bad'] });
  await writeManifest(join(root, 'packages', 'contracts'), {
    name: '@test/contracts',
    version: '1.2',
    dependencies: { other: 123 },
  });
  assert.deepEqual(await checkDependencies(root), [
    'packages/contracts/package.json: workspace package version must be exact SemVer',
    'package.json optionalDependencies: expected a dependency object',
    'packages/contracts/package.json dependencies other: expected an exact version string',
  ]);
});

for (const section of [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]) {
  test(`requires the workspace protocol for local packages in ${section}`, async () => {
    const root = await fixture({
      [section]: {
        '@test/contracts': '1.2.3-beta.2+build.004',
        '@test/web': '9.9.9',
        external: '2.0.0',
      },
    });
    assert.deepEqual(await checkDependencies(root), [
      `package.json ${section} @test/contracts: local package requires workspace:1.2.3-beta.2+build.004`,
      `package.json ${section} @test/web: local package requires workspace:2.0.0`,
    ]);
    await writeManifest(join(root, 'apps', 'web'), {
      name: '@test/web',
      version: '2.0.0',
      [section]: { '@test/contracts': 'workspace:1.2.3-beta.2+build.004' },
    });
    await writeManifest(root, {
      private: true,
      [section]: {
        '@test/contracts': 'workspace:1.2.3-beta.2+build.004',
        '@test/web': 'workspace:2.0.0',
        external: '2.0.0',
      },
    });
    assert.deepEqual(await checkDependencies(root), []);
  });
}

test('shared manifest discovery excludes generated, installed, and hidden files', async () => {
  const root = await fixture();
  for (const path of [
    ['apps', 'web', 'dist'],
    ['apps', 'web', 'node_modules', 'tool'],
    ['packages', '.hidden'],
    ['packages', 'node_modules'],
    ['node_modules', 'tool'],
  ]) {
    await writeManifest(join(root, ...path), { name: 'ignored' });
  }
  await mkdir(join(root, 'apps', 'no-manifest'));
  assert.deepEqual(await manifestPaths(root), [
    join(root, 'package.json'),
    join(root, 'apps', 'web', 'package.json'),
    join(root, 'packages', 'contracts', 'package.json'),
  ]);
});
