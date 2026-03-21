#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { normalizePath } = require(path.join(__dirname, '..', 'src', 'shared', 'project-identity.js'));

async function runNode(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

async function main() {
  const repoRoot = path.join(__dirname, '..');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-cli-guard-'));

  try {
    const mismatch = await runNode([
      'src/cli/liku.js',
      'chat',
      '--project', tempDir,
      '--json'
    ], repoRoot);

    assert.strictEqual(mismatch.code, 1, 'mismatched project exits with failure');
    const mismatchPayload = JSON.parse(mismatch.output);
    assert.strictEqual(mismatchPayload.error, 'PROJECT_GUARD_MISMATCH');
    assert.strictEqual(mismatchPayload.expected.projectRoot, normalizePath(tempDir));
    assert.strictEqual(mismatchPayload.detected.packageName, 'copilot-liku-cli');

    const match = await runNode([
      'src/cli/liku.js',
      'doctor',
      '--project', repoRoot,
      '--repo', 'copilot-liku-cli',
      '--json'
    ], repoRoot);

    assert.strictEqual(match.code, 0, 'matching project guard allows command execution');
    const matchPayload = JSON.parse(match.output);
    assert.strictEqual(matchPayload.projectGuard.ok, true);
    assert.strictEqual(matchPayload.repoIdentity.normalizedRepoName, 'copilot-liku-cli');

    console.log('PASS cli project guard');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('FAIL cli project guard');
  console.error(error.stack || error.message);
  process.exit(1);
});