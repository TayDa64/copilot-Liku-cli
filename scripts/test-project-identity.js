#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  detectProjectRoot,
  normalizePath,
  normalizeName,
  resolveProjectIdentity,
  validateProjectIdentity
} = require(path.join(__dirname, '..', 'src', 'shared', 'project-identity.js'));

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

test('normalizeName canonicalizes repo aliases', () => {
  assert.strictEqual(normalizeName('copilot-Liku-cli'), 'copilot-liku-cli');
  assert.strictEqual(normalizeName(' Tay Liku Repo '), 'tay-liku-repo');
});

test('detectProjectRoot walks upward to package.json', () => {
  const nested = path.join(__dirname, '..', 'src', 'cli', 'commands');
  const root = detectProjectRoot(nested);
  assert.strictEqual(root, normalizePath(path.join(__dirname, '..')));
});

test('resolveProjectIdentity reads package metadata for current repo', () => {
  const identity = resolveProjectIdentity({ cwd: path.join(__dirname, '..') });
  assert.strictEqual(identity.projectRoot, normalizePath(path.join(__dirname, '..')));
  assert.strictEqual(identity.packageName, 'copilot-liku-cli');
  assert.strictEqual(identity.normalizedRepoName, 'copilot-liku-cli');
  assert(identity.aliases.includes('copilot-liku-cli'));
});

test('validateProjectIdentity accepts matching project and repo', () => {
  const validation = validateProjectIdentity({
    cwd: path.join(__dirname, '..'),
    expectedProjectRoot: path.join(__dirname, '..'),
    expectedRepo: 'copilot-liku-cli'
  });
  assert.strictEqual(validation.ok, true);
  assert.deepStrictEqual(validation.errors, []);
});

test('validateProjectIdentity rejects mismatched project root', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-project-guard-'));
  const validation = validateProjectIdentity({
    cwd: path.join(__dirname, '..'),
    expectedProjectRoot: tempDir
  });
  assert.strictEqual(validation.ok, false);
  assert(validation.errors.some((entry) => entry.includes('expected project')));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('validateProjectIdentity rejects mismatched repo alias', () => {
  const validation = validateProjectIdentity({
    cwd: path.join(__dirname, '..'),
    expectedRepo: 'muse-ai'
  });
  assert.strictEqual(validation.ok, false);
  assert(validation.errors.some((entry) => entry.includes('expected repo')));
});