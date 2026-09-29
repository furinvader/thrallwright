import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const repository = resolve(import.meta.dirname, '../..');
const outputLimit = 64 * 1024;

export interface ServiceOptions {
  unavailableCodex?: boolean;
  savedConversation?: boolean;
  workflow?: string;
}

// Overrides exist for lifecycle tests; browser scenarios use the built CLI.
interface LaunchOptions extends ServiceOptions {
  cliPath?: string;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export async function startService(options: LaunchOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'thrallwright-e2e-'));
  const profileDirectory = join(directory, 'profile');
  const workflowFile = join(directory, 'workflow.json');
  const harnessLog = join(directory, 'harness.log');
  const stopTimeout = options.stopTimeoutMs ?? 2_000;
  let output = Buffer.alloc(0);
  let stdout = '';
  let address: string | undefined;
  let spawnError: Error | undefined;
  let exited = false;
  let stopping: Promise<void> | undefined;

  try {
    if (options.workflow !== undefined)
      await writeFile(workflowFile, options.workflow);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  const child = spawn(
    process.execPath,
    [
      options.cliPath ?? join(repository, 'apps/server/dist/cli.js'),
      '--workspace',
      directory,
      '--profile-dir',
      profileDirectory,
      '--port',
      '0',
      '--codex',
      options.unavailableCodex
        ? join(directory, 'missing-codex')
        : join(import.meta.dirname, 'fixtures/fake-codex.mjs'),
      '--no-open',
      ...(options.workflow === undefined ? [] : ['--workflow', workflowFile]),
    ],
    {
      cwd: repository,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        THRALLWRIGHT_FAKE_CODEX_LOG: harnessLog,
        THRALLWRIGHT_FAKE_CODEX_SAVED: options.savedConversation ? '1' : '',
        ...options.env,
      },
    },
  );
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => {
      exited = true;
      resolve();
    });
  });
  child.once('error', (error) => {
    spawnError = error;
  });
  const capture = (chunk: Buffer) => {
    output = Buffer.concat([output, chunk]).subarray(-outputLimit);
  };
  child.stderr.on('data', capture);
  child.stdout.on('data', (chunk: Buffer) => {
    capture(chunk);
    if (!address) {
      stdout = (stdout + chunk.toString()).slice(-8_192);
      address = stdout.match(
        /(?:^|\n)Thrallwright: (http:\/\/127\.0\.0\.1:\d+)\r?\n/,
      )?.[1];
    }
  });

  const signalGroup = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const waitForClose = async (timeout: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closed,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const stop = () =>
    (stopping ??= (async () => {
      signalGroup('SIGTERM');
      await waitForClose(stopTimeout);
      // Also reap descendants when the service exited before its harness.
      signalGroup('SIGKILL');
      await waitForClose(stopTimeout);
      if (!exited) throw new Error('Service did not close after SIGKILL');
    })());
  const dispose = async () => {
    try {
      await stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };

  try {
    const deadline = Date.now() + (options.startupTimeoutMs ?? 10_000);
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (exited)
        throw new Error(
          `Service exited with ${child.exitCode ?? child.signalCode}`,
        );
      if (address) {
        try {
          const response = await fetch(`${address}/api/health`, {
            signal: AbortSignal.timeout(
              Math.max(1, Math.min(1_000, deadline - Date.now())),
            ),
          });
          await response.body?.cancel();
          if (response.ok)
            return {
              address,
              directory,
              profileDirectory,
              workflowFile,
              harnessLog,
              output: () => output.toString(),
              stop,
              dispose,
            };
        } catch {
          /* Wait for this process's service to become healthy. */
        }
      }
      await delay(50);
    }
    throw new Error('Timed out waiting for the local service');
  } catch (error) {
    await dispose();
    throw new Error(`${String(error)}\n${output.toString()}`, { cause: error });
  }
}
