#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import ts from 'typescript';
import { checkDependencies, manifestPaths } from './check-dependencies.mjs';

const runFile = promisify(execFile);
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const codexPath = 'apps/server/src/integrations/codex.ts';

function propertyName(node) {
  return node && (ts.isIdentifier(node) || ts.isStringLiteral(node))
    ? node.text
    : undefined;
}

function literalProperty(object, name) {
  if (
    !object ||
    !ts.isObjectLiteralExpression(object) ||
    object.properties.some(
      (property) =>
        ts.isSpreadAssignment(property) ||
        (property.name && ts.isComputedPropertyName(property.name)),
    )
  )
    throw new Error(`Expected a direct object literal for ${name}.`);
  const matches = object.properties.filter(
    (property) => propertyName(property.name) === name,
  );
  if (matches.length !== 1 || !ts.isPropertyAssignment(matches[0]))
    throw new Error(`Expected exactly one direct ${name} property.`);
  return matches[0].initializer;
}

/** Inspect the actual initialize request, never comments or unrelated versions. */
export function readCodexClientVersion(source) {
  const file = ts.createSourceFile(
    codexPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if (file.parseDiagnostics.length)
    throw new Error('Cannot parse the Codex adapter TypeScript.');
  const classes = file.statements.filter(
    (node) => ts.isClassDeclaration(node) && node.name?.text === 'CodexProcess',
  );
  if (classes.length !== 1)
    throw new Error('Expected exactly one CodexProcess class.');
  const methods = classes[0].members.filter(
    (node) =>
      ts.isMethodDeclaration(node) && propertyName(node.name) === 'initialize',
  );
  if (methods.length !== 1 || !methods[0].body)
    throw new Error('Expected one CodexProcess.initialize method body.');
  const calls = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
      node.expression.name.text === 'sendRequest' &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === 'initialize'
    )
      calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(methods[0].body);
  if (calls.length !== 1)
    throw new Error('Expected one literal initialize request in CodexProcess.');
  const clientInfo = literalProperty(calls[0].arguments[1], 'clientInfo');
  const version = literalProperty(clientInfo, 'version');
  if (!ts.isStringLiteral(version))
    throw new Error('Expected a string literal for clientInfo.version.');
  return version.text;
}

/** Evaluate the current checkout and host Linux target without changing its lock. */
export async function readNixVersions(root, execute = runFile) {
  const architecture = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
  if (process.platform !== 'linux' || !architecture)
    throw new Error(
      'Release metadata evaluation requires x86_64 or aarch64 Linux.',
    );
  const { stdout } = await execute(
    'nix',
    [
      'eval',
      '--json',
      '--no-write-lock-file',
      `.#packages.${architecture}-linux.thrallwright`,
      '--apply',
      'package: { application = package.version; dependencyCache = package.pnpmDeps.version; }',
    ],
    { cwd: root, timeout: 120_000, maxBuffer: 1024 * 1024 },
  );
  const versions = JSON.parse(stdout);
  if (
    !versions ||
    typeof versions.application !== 'string' ||
    typeof versions.dependencyCache !== 'string'
  )
    throw new Error(
      'Nix did not return application and dependency-cache versions.',
    );
  return versions;
}

/** Return all observed release mismatches; never rewrite metadata or publish. */
export async function checkRelease(
  rootDirectory,
  version,
  { evaluateNix = readNixVersions } = {},
) {
  if (
    typeof version !== 'string' ||
    !stableVersion.test(version) ||
    /\s/.test(version)
  )
    throw new Error(
      'Supply --version X.Y.Z using a stable version without leading zeroes.',
    );
  const root = resolve(rootDirectory);
  const errors = await checkDependencies(root);
  const mismatch = (label, actual) => {
    if (actual !== version)
      errors.push(
        `${label}: expected ${version}, found ${JSON.stringify(actual) ?? '(missing)'}`,
      );
  };
  let workspaceCount = 0;
  for (const path of await manifestPaths(root)) {
    const label = relative(root, path);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      // checkDependencies already reports missing or malformed JSON.
      continue;
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
      continue;
    if (label === 'package.json') {
      if (manifest.private !== true)
        errors.push(
          'package.json: the workspace coordinator must remain private.',
        );
      if (Object.hasOwn(manifest, 'version'))
        errors.push(
          'package.json: the workspace coordinator must remain unversioned.',
        );
    } else {
      workspaceCount += 1;
      mismatch(`${label} version`, manifest.version);
    }
  }
  if (!workspaceCount)
    errors.push('No first-party workspace manifests were found.');
  try {
    const versions = await evaluateNix(root);
    mismatch('Nix application version', versions.application);
    mismatch('Nix dependency-cache version', versions.dependencyCache);
  } catch (error) {
    errors.push(`Cannot evaluate Nix release metadata: ${error.message}`);
  }
  try {
    const source = await readFile(join(root, codexPath), 'utf8');
    mismatch(`${codexPath} clientInfo.version`, readCodexClientVersion(source));
  } catch (error) {
    errors.push(
      `Cannot inspect Codex client release metadata: ${error.message}`,
    );
  }
  return errors;
}

async function main() {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: just check-release --version X.Y.Z\nRun just setup first to verify the frozen lockfile. This command only inspects metadata.',
    );
    return;
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const errors = await checkRelease(root, values.version);
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log(
      `Release metadata matches ${values.version} on ${process.arch} Linux. This does not establish release readiness or authorization.`,
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(`Release metadata check failed: ${error.message}`);
    process.exitCode = 1;
  });
