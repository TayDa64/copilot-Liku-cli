#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  clearProjectIdentityCache,
  detectProjectRoot,
  getProjectIdentityCacheStats,
  invalidateProjectIdentityCache,
  normalizePath,
  normalizeName,
  resolveProjectIdentity,
  validateProjectIdentity
} = require(path.join(__dirname, '..', 'src', 'shared', 'project-identity.js'));
const { buildExecutionContextEnvelope } = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'execution-context.js'));

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

test('resolveProjectIdentity caches stable repo identity while returning fresh cwd values', () => {
  clearProjectIdentityCache();
  const repoRoot = path.join(__dirname, '..');
  const nested = path.join(repoRoot, 'src', 'cli');

  const rootIdentity = resolveProjectIdentity({ cwd: repoRoot });
  const nestedIdentity = resolveProjectIdentity({ cwd: nested });
  const stats = getProjectIdentityCacheStats();

  assert.strictEqual(rootIdentity.projectRoot, nestedIdentity.projectRoot);
  assert.strictEqual(rootIdentity.repoName, nestedIdentity.repoName);
  assert.strictEqual(rootIdentity.cwd, normalizePath(repoRoot));
  assert.strictEqual(nestedIdentity.cwd, normalizePath(nested));
  assert.strictEqual(stats.projectIdentityEntries, 1, 'same repo should reuse one stable identity cache entry');
  assert(stats.cwdProjectRootEntries >= 2, 'cwd cache should track repeated repo lookups');

  clearProjectIdentityCache();
});

test('invalidateProjectIdentityCache clears temp repo identity entries deterministically', () => {
  clearProjectIdentityCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-project-identity-'));
  fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'cache-test-repo', version: '1.0.0' }, null, 2));

  const identity = resolveProjectIdentity({ cwd: tempDir });
  assert.strictEqual(identity.repoName, 'cache-test-repo');
  assert.strictEqual(getProjectIdentityCacheStats().projectIdentityEntries, 1);

  invalidateProjectIdentityCache({ projectRoot: tempDir });
  assert.strictEqual(getProjectIdentityCacheStats().projectIdentityEntries, 0);

  fs.rmSync(tempDir, { recursive: true, force: true });
  clearProjectIdentityCache();
});

test('execution context envelope keeps repo identity stable while foreground signals stay dynamic', () => {
  clearProjectIdentityCache();
  const repoRoot = path.join(__dirname, '..');

  const codeEnvelope = buildExecutionContextEnvelope({
    cwd: repoRoot,
    foreground: { processName: 'code', title: 'README.md - Visual Studio Code' },
    userMessage: 'continue inspecting this VS Code workspace'
  });

  const browserEnvelope = buildExecutionContextEnvelope({
    cwd: repoRoot,
    foreground: { processName: 'msedge', title: 'Example Domain - Microsoft Edge' },
    userMessage: 'continue browser research'
  });

  assert.strictEqual(codeEnvelope.repo.projectRoot, browserEnvelope.repo.projectRoot);
  assert.strictEqual(codeEnvelope.repo.name, browserEnvelope.repo.name);
  assert.strictEqual(codeEnvelope.foreground.appId, 'code');
  assert.strictEqual(browserEnvelope.foreground.appId, 'msedge');
  assert.notStrictEqual(codeEnvelope.compartmentKey, browserEnvelope.compartmentKey, 'dynamic foreground/task signals should still change the compartment key');
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