import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startService } from '../tests/e2e/service-process.ts';

async function fakeCli(t, source) {
  const directory = await mkdtemp(join(tmpdir(), 'thrallwright-service-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cliPath = join(directory, 'cli.mjs');
  const record = join(directory, 'record.json');
  await writeFile(
    cliPath,
    `
    import { writeFileSync } from 'node:fs';
    const workspace = process.argv[process.argv.indexOf('--workspace') + 1];
    writeFileSync(process.env.SERVICE_TEST_RECORD, JSON.stringify({ pid: process.pid, workspace }));
    ${source}
  `,
  );
  return { cliPath, env: { SERVICE_TEST_RECORD: record }, record };
}

async function assertCleaned(record) {
  const { pid, workspace } = JSON.parse(await readFile(record, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await assert.rejects(readFile(join(workspace, 'workflow.json')), {
    code: 'ENOENT',
  });
  const { stat } = await import('node:fs/promises');
  await assert.rejects(stat(workspace), { code: 'ENOENT' });
}

test('service startup failure includes bounded logs and removes its process and state', async (t) => {
  const fake = await fakeCli(
    t,
    "process.stderr.write('x'.repeat(100_000) + 'startup failed'); process.exitCode = 7;",
  );
  await assert.rejects(startService(fake), (error) => {
    assert.match(error.message, /Service exited with 7/);
    assert.match(error.message, /startup failed/);
    assert.ok(error.message.length < 66_000);
    return true;
  });
  await assertCleaned(fake.record);
});

test('startup timeout kills a service that ignores SIGTERM and removes its state', async (t) => {
  const fake = await fakeCli(
    t,
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
  );
  await assert.rejects(
    startService({ ...fake, startupTimeoutMs: 1_000, stopTimeoutMs: 100 }),
    /Timed out waiting/,
  );
  await assertCleaned(fake.record);
});

test('announced but unresponsive health endpoint has a bounded startup wait', async (t) => {
  const fake = await fakeCli(
    t,
    `
    const { createServer } = await import('node:http');
    const server = createServer(() => {});
    server.listen(0, '127.0.0.1', () => console.log('Thrallwright: http://127.0.0.1:' + server.address().port));
  `,
  );
  await assert.rejects(
    startService({ ...fake, startupTimeoutMs: 1_000, stopTimeoutMs: 100 }),
    /Timed out waiting/,
  );
  await assertCleaned(fake.record);
});

test('parallel services have distinct addresses and state; stop is idempotent', async (t) => {
  const fake = await fakeCli(
    t,
    `
    const { createServer } = await import('node:http');
    const server = createServer((_, response) => response.end('ok'));
    server.listen(0, '127.0.0.1', () => {
      process.stdout.write('Thrall');
      setTimeout(() => console.log('wright: http://127.0.0.1:' + server.address().port), 10);
    });
  `,
  );
  const services = [];
  t.after(() => Promise.all(services.map((service) => service.dispose())));
  for (const service of await Promise.all([
    startService(fake),
    startService(fake),
  ]))
    services.push(service);
  assert.notEqual(services[0].address, services[1].address);
  assert.notEqual(services[0].directory, services[1].directory);
  assert.notEqual(services[0].profileDirectory, services[1].profileDirectory);
  for (const service of services) {
    await Promise.all([service.stop(), service.stop()]);
    await assert.rejects(fetch(service.address));
    await service.dispose();
  }
});
