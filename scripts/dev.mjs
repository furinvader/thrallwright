import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = path.join(root, '.thrallwright-dev');
const children = new Map();
let closing = false;

function stop(exitCode = 0) {
  if (closing) return;
  closing = true;
  for (const child of children.values()) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // A process that already exited has no group left to stop.
    }
  }
  process.exitCode = exitCode;
}

process.on('SIGINT', () => stop(130));
process.on('SIGTERM', () => stop(143));

function start(name, args, env = {}) {
  const child = spawn('pnpm', args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    detached: true,
  });
  children.set(name, child);
  child.on('error', (error) => {
    console.error(`${name} failed to start: ${error.message}`);
    stop(1);
  });
  child.on('exit', (code, signal) => {
    children.delete(name);
    if (!closing) {
      console.error(`${name} exited (${signal ?? code ?? 'unknown'}).`);
      stop(code || 1);
    }
  });
}

async function ready(name, url) {
  for (let elapsed = 0; elapsed < 60 && !closing; elapsed++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        console.log(`${name} ready at ${url}`);
        return;
      }
    } catch {
      // The server has not bound its port yet.
    }
    await sleep(1000);
  }
  if (!closing) throw new Error(`${name} did not become ready at ${url}`);
}

try {
  const build = spawn(
    'pnpm',
    ['--filter', '@thrallwright/contracts', 'build'],
    {
      cwd: root,
      stdio: 'inherit',
    },
  );
  const code = await new Promise((resolve, reject) => {
    build.on('error', reject);
    build.on('exit', (status) => resolve(status));
  });
  if (code !== 0) process.exit(code || 1);

  start('contracts', ['--filter', '@thrallwright/contracts', 'dev']);
  start(
    'server',
    [
      '--filter',
      '@thrallwright/server',
      'dev',
      '--workspace',
      root,
      '--profile-dir',
      profile,
    ],
    {
      THRALLWRIGHT_DEV_ORIGIN: 'http://127.0.0.1:4200',
    },
  );
  start('browser', ['--filter', '@thrallwright/web', 'dev'], {
    NG_CLI_ANALYTICS: 'false',
  });

  await Promise.all([
    ready(
      'Server',
      process.env.THRALLWRIGHT_SERVER_READY_URL ??
        'http://127.0.0.1:4318/api/health',
    ),
    ready(
      'Browser',
      process.env.THRALLWRIGHT_WEB_READY_URL ?? 'http://127.0.0.1:4200/',
    ),
  ]);
  if (!closing) console.log('Press Ctrl+C to stop the development servers.');
} catch (error) {
  console.error(error);
  stop(1);
}
