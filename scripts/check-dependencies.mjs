#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sections = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const workspaceParents = ['apps', 'packages'];
const versionPattern =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function isExactSemver(value) {
  if (typeof value !== 'string') return false;
  const match = versionPattern.exec(value);
  if (!match || match[0] !== value) return false;
  if (match.slice(1, 4).some((part) => part.length > 1 && part[0] === '0'))
    return false;
  return !match[4]
    ?.split('.')
    .some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === '0');
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function manifestPaths(root) {
  const paths = [join(root, 'package.json')];
  // The first-party workspace patterns are apps/* and packages/*.
  // Only their immediate child manifests count; installed and generated nested
  // package.json files are never traversed.
  for (const parent of workspaceParents) {
    let entries;
    try {
      entries = await readdir(join(root, parent), { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith('.') ||
        entry.name === 'node_modules'
      )
        continue;
      const path = join(root, parent, entry.name, 'package.json');
      try {
        await readFile(path);
        paths.push(path);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  return paths;
}

/** Return readable policy errors for a checkout or a temporary test fixture. */
export async function checkDependencies(rootDirectory) {
  const root = resolve(
    rootDirectory ?? fileURLToPath(new URL('..', import.meta.url)),
  );
  const errors = [];
  const manifests = [];
  for (const path of await manifestPaths(root)) {
    const label = relative(root, path);
    try {
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (!plainObject(value)) {
        errors.push(`${label}: manifest must be a JSON object`);
        continue;
      }
      manifests.push({ label, value });
    } catch (error) {
      errors.push(`${label}: cannot read JSON: ${error.message}`);
    }
  }

  const workspace = new Map();
  for (const { label, value } of manifests) {
    if (label === 'package.json') continue;
    if (typeof value.name !== 'string' || !value.name) {
      errors.push(`${label}: workspace package must have a name`);
      continue;
    }
    if (!isExactSemver(value.version)) {
      errors.push(`${label}: workspace package version must be exact SemVer`);
      continue;
    }
    if (workspace.has(value.name)) {
      errors.push(`${label}: duplicate workspace package name ${value.name}`);
      continue;
    }
    workspace.set(value.name, value.version);
  }

  for (const { label, value } of manifests) {
    for (const section of sections) {
      if (value[section] === undefined) continue;
      if (!plainObject(value[section])) {
        errors.push(`${label} ${section}: expected a dependency object`);
        continue;
      }
      for (const [name, spec] of Object.entries(value[section])) {
        const location = `${label} ${section} ${name}`;
        if (typeof spec !== 'string') {
          errors.push(`${location}: expected an exact version string`);
        } else if (spec.startsWith('workspace:')) {
          const requested = spec.slice('workspace:'.length);
          if (!isExactSemver(requested))
            errors.push(`${location}: workspace: must specify exact SemVer`);
          else if (!workspace.has(name))
            errors.push(`${location}: workspace target does not exist`);
          else if (workspace.get(name) !== requested)
            errors.push(
              `${location}: workspace target is ${workspace.get(name)}, requested ${requested}`,
            );
        } else if (!isExactSemver(spec)) {
          errors.push(
            `${location}: expected exact SemVer, got ${JSON.stringify(spec)}`,
          );
        }
      }
    }
  }
  return errors;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const errors = await checkDependencies(process.argv[2]);
    if (errors.length) {
      for (const error of errors) process.stderr.write(`${error}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write('First-party dependency versions are exact.\n');
    }
  } catch (error) {
    process.stderr.write(`Dependency check failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
