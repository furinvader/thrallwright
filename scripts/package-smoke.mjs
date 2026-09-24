import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const packageRoot = process.argv[2];
if (!packageRoot || !path.isAbsolute(packageRoot)) {
  console.error('Usage: node scripts/package-smoke.mjs ABSOLUTE_NIX_PACKAGE');
  process.exit(2);
}

const temporary = await mkdtemp(path.join(tmpdir(), 'thrallwright-package-'));
const profile = path.join(temporary, 'profile');
const database = path.join(profile, 'data', 'thrallwright.sqlite');
const executable = path.join(packageRoot, 'bin', 'thrallwright');

async function launch() {
  const child = spawn(
    executable,
    [
      '--workspace',
      '.',
      '--profile-dir',
      profile,
      '--port',
      '0',
      '--no-open',
      '--codex',
      '/nonexistent',
    ],
    {
      cwd: temporary,
      env: { ...process.env, PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  const closed = new Promise((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  );
  let startupTimer;
  try {
    const address = await Promise.race([
      new Promise((resolve, reject) => {
        child.once('error', reject);
        child.stdout.on('data', (chunk) => {
          output += chunk.toString();
          const match = output.match(
            /Thrallwright: (http:\/\/127\.0\.0\.1:\d+)/,
          );
          if (match) resolve(match[1]);
        });
        child.stderr.on('data', (chunk) => {
          output += chunk.toString();
          if (output.length > 16_384) output = output.slice(-16_384);
        });
        child.once('close', (code) =>
          reject(
            new Error(`Packaged app exited before ready: ${code}; ${output}`),
          ),
        );
      }),
      new Promise((_, reject) => {
        startupTimer = setTimeout(
          () => reject(new Error('Packaged app startup timed out')),
          15_000,
        );
      }),
    ]);
    return { child, closed, address };
  } catch (error) {
    child.kill('SIGTERM');
    await closed;
    throw error;
  } finally {
    clearTimeout(startupTimer);
  }
}

async function checkRunning(app) {
  const health = await fetch(`${app.address}/api/health`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!health.ok || (await health.json()).status !== 'ok')
    throw new Error('Packaged health endpoint failed');

  const page = await fetch(app.address, { signal: AbortSignal.timeout(3000) });
  const html = await page.text();
  if (!page.ok || !html.includes('<app-root'))
    throw new Error('Packaged browser page failed');
  const script = html.match(/src="([^" ]+\.js)"/)?.[1];
  if (!script) throw new Error('Packaged page has no JavaScript asset');
  const asset = await fetch(new URL(script, app.address), {
    signal: AbortSignal.timeout(3000),
  });
  if (!asset.ok) throw new Error('Packaged browser asset failed');
  await stat(database);
}

async function stop(app) {
  app.child.kill('SIGTERM');
  let shutdownTimer;
  const result = await Promise.race([
    app.closed,
    new Promise((resolve) => {
      shutdownTimer = setTimeout(() => resolve(null), 5000);
    }),
  ]);
  clearTimeout(shutdownTimer);
  if (!result) {
    app.child.kill('SIGKILL');
    await app.closed;
    throw new Error('Packaged app did not stop promptly');
  }
  if (result.code !== 0)
    throw new Error(`Packaged app exited with ${result.code ?? result.signal}`);
}

function storedWorkspace() {
  const query = spawnSync(
    'python3',
    [
      '-c',
      'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute("select path from workspaces").fetchone()[0])',
      database,
    ],
    { encoding: 'utf8' },
  );
  if (query.status !== 0)
    throw new Error(`Could not inspect packaged database: ${query.stderr}`);
  return query.stdout.trim();
}

try {
  let firstDatabase;
  for (let attempt = 0; attempt < 2; attempt++) {
    const app = await launch();
    try {
      await checkRunning(app);
    } finally {
      await stop(app);
    }
    const currentDatabase = await stat(database);
    if (attempt === 0) firstDatabase = currentDatabase;
    else if (currentDatabase.ino !== firstDatabase.ino)
      throw new Error('Profile database was replaced on restart');
    if (storedWorkspace() !== temporary)
      throw new Error('Caller-relative workspace was not persisted');
  }
  const page = await readFile(
    path.join(packageRoot, 'lib/thrallwright/web/index.html'),
    'utf8',
  );
  if (!page.includes('<app-root'))
    throw new Error('Installed browser asset is missing');
  console.log(
    'Packaged service, browser assets, native SQLite, and profile restart passed.',
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
