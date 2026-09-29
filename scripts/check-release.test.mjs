import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, test } from 'node:test';
import {
  checkRelease,
  readCodexClientVersion,
  readNixVersions,
} from './check-release.mjs';

const execute = promisify(execFile);
const version = '1.2.3';
const fixtures = [];
const codexPath = 'apps/server/src/integrations/codex.ts';
const source = (value) => `
// Ignore obsolete clientInfo: { version: '8.8.8' } examples.
export class CodexProcess {
  private async initialize(): Promise<void> {
    await this.sendRequest('initialize', {
      clientInfo: { name: 'thrallwright', version: '${value}' },
      capabilities: null,
    });
  }
}
`;

afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function put(root, path, value) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(
    join(root, path),
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'thrallwright-release-'));
  fixtures.push(root);
  await put(root, 'package.json', { private: true });
  for (const path of ['apps/server', 'apps/web', 'packages/contracts']) {
    await put(root, `${path}/package.json`, {
      name: `@test/${path.split('/')[1]}`,
      version,
      ...(path.startsWith('apps/')
        ? { dependencies: { '@test/contracts': `workspace:${version}` } }
        : {}),
    });
  }
  await put(root, codexPath, source(version));
  return root;
}

const nix = (application = version, dependencyCache = version) => ({
  evaluateNix: async () => ({ application, dependencyCache }),
});

test('aligned release metadata passes without rewriting inputs', async () => {
  const root = await fixture();
  const before = await readFile(join(root, codexPath), 'utf8');
  assert.deepEqual(await checkRelease(root, version, nix()), []);
  assert.equal(await readFile(join(root, codexPath), 'utf8'), before);
});

for (const path of ['apps/server', 'apps/web', 'packages/contracts']) {
  test(`reports a mismatched workspace version in ${path}`, async () => {
    const root = await fixture();
    await put(root, `${path}/package.json`, {
      name: `@test/${path.split('/')[1]}`,
      version: '9.9.9',
    });
    const errors = await checkRelease(root, version, nix());
    assert.ok(
      errors.includes(
        `${path}/package.json version: expected 1.2.3, found "9.9.9"`,
      ),
    );
  });
}

for (const path of ['apps/server', 'apps/web', 'packages/contracts']) {
  test(`rejects the missing required release manifest in ${path}`, async () => {
    const root = await fixture();
    await rm(join(root, path, 'package.json'));
    const errors = await checkRelease(root, version, nix());
    assert.ok(
      errors.includes(
        `${path}/package.json: required release manifest is missing.`,
      ),
    );
  });
}

test('rejects non-private or versioned coordinator metadata', async () => {
  const root = await fixture();
  await put(root, 'package.json', { private: false, version });
  assert.deepEqual(await checkRelease(root, version, nix()), [
    'package.json: the workspace coordinator must remain private.',
    'package.json: the workspace coordinator must remain unversioned.',
  ]);
});

test('retains workspace-reference and dependency policy validation', async () => {
  const root = await fixture();
  await put(root, 'package.json', {
    private: true,
    dependencies: { '@test/contracts': version },
  });
  assert.deepEqual(await checkRelease(root, version, nix()), [
    'package.json dependencies @test/contracts: local package requires workspace:1.2.3',
  ]);
});

for (const field of ['application', 'dependencyCache']) {
  test(`reports an independently mismatching Nix ${field} version`, async () => {
    const root = await fixture();
    const versions = {
      application: version,
      dependencyCache: version,
      [field]: '9.9.9',
    };
    const errors = await checkRelease(root, version, {
      evaluateNix: async () => versions,
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Nix .* version: expected 1.2.3, found "9.9.9"/);
  });
}

test('reports a mismatch in the actual Codex initialize metadata', async () => {
  const root = await fixture();
  await put(root, codexPath, source('9.9.9'));
  assert.deepEqual(await checkRelease(root, version, nix()), [
    `${codexPath} clientInfo.version: expected 1.2.3, found "9.9.9"`,
  ]);
});

test('rejects invalid requested versions before inspecting the checkout', async () => {
  for (const invalid of [
    undefined,
    '',
    'v1.2.3',
    '1.2',
    '01.2.3',
    '1.2.3-rc.1',
    '1.2.3+build',
    '1.2.3\n',
  ])
    await assert.rejects(
      checkRelease('/does-not-exist', invalid, nix()),
      /Supply --version X.Y.Z/,
    );
});

test('fails closed for missing manifests, source, or Nix metadata', async () => {
  const root = await fixture();
  await rm(join(root, 'package.json'));
  await rm(join(root, codexPath));
  const errors = await checkRelease(root, version, {
    evaluateNix: async () => {
      throw new Error('evaluation unavailable');
    },
  });
  assert.ok(
    errors.some((error) => error.includes('package.json: cannot read JSON')),
  );
  assert.ok(
    errors.includes(
      'Cannot evaluate Nix release metadata: evaluation unavailable',
    ),
  );
  assert.ok(
    errors.some((error) =>
      error.startsWith('Cannot inspect Codex client release metadata:'),
    ),
  );
});

test('AST inspection tolerates formatting and quoted property names', () => {
  assert.equal(
    readCodexClientVersion(
      source(version)
        .replaceAll('clientInfo:', '"clientInfo":')
        .replaceAll('version:', '"version":'),
    ),
    version,
  );
});

test('AST inspection rejects missing, ambiguous, dynamic, or overridden metadata', () => {
  for (const changed of [
    source(version).replace('CodexProcess', 'Renamed'),
    source(version).replace('async initialize()', 'async renamed()'),
    source(version).replace("'initialize'", "'other'"),
    source(version).replace(
      `version: '${version}'`,
      'version: selectedVersion',
    ),
    source(version).replace(
      `version: '${version}'`,
      `version: '${version}', version: '9.9.9'`,
    ),
    source(version).replace(
      'capabilities: null',
      '...other, capabilities: null',
    ),
    source(version).replace(
      `version: '${version}'`,
      `version: '${version}', ...other`,
    ),
    source(version).replace(
      `version: '${version}'`,
      `[selectedField]: '${version}'`,
    ),
    source(version).replaceAll('clientInfo:', 'otherInfo:'),
    source(version) + source(version),
    'export class {',
  ])
    assert.throws(() => readCodexClientVersion(changed));
});

test('Nix evaluation selects the host target and prohibits lockfile writes', async () => {
  const root = '/tmp/a checkout with spaces';
  const values = await readNixVersions(root, async (file, args, options) => {
    assert.equal(file, 'nix');
    assert.ok(args.includes('--no-write-lock-file'));
    assert.ok(
      args.includes(
        `.#packages.${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-linux.thrallwright`,
      ),
    );
    assert.equal(options.cwd, root);
    assert.equal(options.timeout, 120_000);
    return {
      stdout: JSON.stringify({
        application: version,
        dependencyCache: version,
      }),
    };
  });
  assert.deepEqual(values, { application: version, dependencyCache: version });
  await assert.rejects(
    readNixVersions(root, async () => ({ stdout: '{}' })),
    /Nix did not return/,
  );
  await assert.rejects(
    readNixVersions(root, async () => ({ stdout: 'invalid' })),
    /JSON/,
  );
});

test('CLI rejects missing version and unsupported options without running Nix', async () => {
  const script = fileURLToPath(new URL('./check-release.mjs', import.meta.url));
  for (const args of [
    [],
    ['--version', '1.2.3', '--publish'],
    ['--version', '1.2.3', 'unexpected'],
  ]) {
    await assert.rejects(
      execute(process.execPath, [script, ...args]),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Release metadata check failed:/);
        return true;
      },
    );
  }
});
