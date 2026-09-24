import { spawn } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packages = new Set(['server', 'web', 'contracts']);

async function run(args) {
  const child = spawn('pnpm', args, { cwd: root, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (status, signal) => resolve(signal ? 1 : status));
  });
  if (code !== 0) process.exit(code || 1);
}

const args = process.argv.slice(2);
const selected = packages.has(args[0]) ? args.shift() : undefined;
if (!selected && args.length > 0) {
  console.error(
    'Choose a package before passing runner arguments: server, web, or contracts.',
  );
  process.exit(2);
}

await run(['--filter', '@thrallwright/contracts', 'build']);
await run(
  selected
    ? ['--filter', `@thrallwright/${selected}`, 'test', ...args]
    : ['-r', 'test'],
);
