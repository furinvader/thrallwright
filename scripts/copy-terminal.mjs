// Copy official, pinned npm assets locally. Keep third-party code out of app sources.
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const destination = resolve(root, 'thrallwright/static/vendor');
await mkdir(destination, { recursive: true });
for (const [source, target] of [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'terminal.css'],
  ['@xterm/xterm/LICENSE', 'XTERM-LICENSE'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
  ['@xterm/addon-fit/LICENSE', 'FIT-LICENSE'],
]) {
  await copyFile(resolve(root, 'node_modules', source), resolve(destination, target));
}
await writeFile(resolve(destination, 'terminal.js'),
  'import "./xterm.js";\nimport "./addon-fit.js";\n' +
  'export default {Terminal: globalThis.Terminal, FitAddon: globalThis.FitAddon.FitAddon};\n');
console.log('Terminal assets installed locally. Node is not needed to run the server.');
