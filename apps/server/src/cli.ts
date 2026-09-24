#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createApplication } from './app.js';
import { storagePaths } from './storage/paths.js';
import { CodexProcess } from './integrations/codex.js';

async function main() {
  const { values } = parseArgs({
    options: {
      workspace: { type: 'string' },
      workflow: { type: 'string' },
      'profile-dir': { type: 'string' },
      port: { type: 'string', default: '4318' },
      codex: { type: 'string' },
      'no-open': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'thrallwright [--workspace PATH] [--workflow PATH] [--profile-dir PATH] [--port PORT] [--codex EXECUTABLE] [--no-open]\nStarts a local workbench. Workspace defaults to the caller’s working directory. Workflow paths are relative to the workspace and saved for future launches.',
    );
    return;
  }
  const workspace = await realpath(resolve(values.workspace ?? process.cwd()));
  if (!(await stat(workspace)).isDirectory())
    throw new Error('Workspace must be a directory.');
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('Port must be an integer between 0 and 65535.');
  const codex = new CodexProcess(
    values.codex ?? process.env['THRALLWRIGHT_CODEX_EXECUTABLE'] ?? 'codex',
    workspace,
  );
  const devOrigin = process.env['THRALLWRIGHT_DEV_ORIGIN'];
  const app = await createApplication({
    workspace,
    paths: storagePaths(values['profile-dir']),
    workflowPath: values.workflow
      ? resolve(workspace, values.workflow)
      : undefined,
    codex,
    webRoot: devOrigin
      ? undefined
      : (process.env['THRALLWRIGHT_WEB_ROOT'] ??
        fileURLToPath(new URL('../../web/dist/browser/', import.meta.url))),
    devOrigin,
  });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await app.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  let address: string;
  try {
    address = await app.listen({ port, host: '127.0.0.1' });
  } catch (error) {
    await app.close();
    throw error;
  }
  console.log(`Thrallwright: ${address}\nWorkspace: ${workspace}`);
  if (!values['no-open']) {
    const browser = spawn(
      process.env['THRALLWRIGHT_BROWSER_OPENER'] ?? 'xdg-open',
      [address],
      { stdio: 'ignore', detached: true },
    );
    browser.on('error', () =>
      console.error(`Open ${address} in your browser.`),
    );
    browser.unref();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Startup failed.');
  process.exitCode = 1;
});
