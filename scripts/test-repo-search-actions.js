#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  executeRepoSearchAction,
  grepRepo,
  semanticSearchRepo,
  pgrepProcess,
  tokenizeQuery
} = require(path.join(__dirname, '..', 'src', 'main', 'repo-search-actions.js'));

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

function createFixtureRepo() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-repo-search-'));
  fs.writeFileSync(
    path.join(tempDir, 'chat.js'),
    [
      'function routeContinuation(state) {',
      '  return state && state.continuationReady;',
      '}',
      ''
    ].join('\n'),
    'utf8'
  );
  fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, 'src', 'continuity.js'),
    [
      'export function buildContinuitySummary(lastTurn) {',
      '  return `verification=${lastTurn.verificationStatus}`;',
      '}',
      ''
    ].join('\n'),
    'utf8'
  );
  return tempDir;
}

async function main() {
  await test('tokenizeQuery keeps meaningful deduplicated tokens', async () => {
    const tokens = tokenizeQuery('where where continuation routing is decided');
    assert.deepStrictEqual(tokens, ['where', 'continuation', 'routing', 'decided']);
  });

  await test('grepRepo finds bounded matches in fixture repo', async () => {
    const tempDir = createFixtureRepo();
    const result = await grepRepo({
      pattern: 'continuationReady',
      cwd: tempDir,
      maxResults: 5,
      literal: true
    });

    assert.strictEqual(result.success, true);
    assert.ok(Array.isArray(result.results));
    assert.ok(result.results.length >= 1);
    assert.ok(result.results.some((entry) => String(entry.path).includes('chat.js')));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await test('semanticSearchRepo ranks continuity-oriented matches', async () => {
    const tempDir = createFixtureRepo();
    const result = await semanticSearchRepo({
      query: 'where continuation verification is summarized',
      cwd: tempDir,
      maxResults: 8
    });

    assert.strictEqual(result.success, true);
    assert.ok(Array.isArray(result.results));
    assert.ok(result.results.length >= 1);
    assert.ok(result.results[0].score >= 1);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await test('pgrepProcess returns compact process matches', async () => {
    const result = await pgrepProcess({ query: 'node', limit: 10 });
    assert.strictEqual(result.success, true);
    assert.ok(Array.isArray(result.results));
    assert.ok(result.results.length >= 1);
  });

  await test('executeRepoSearchAction routes supported actions', async () => {
    const tempDir = createFixtureRepo();
    const routed = await executeRepoSearchAction({
      type: 'grep_repo',
      pattern: 'buildContinuitySummary',
      cwd: tempDir
    });
    assert.strictEqual(routed.success, true);
    assert.ok(routed.count >= 1);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
}

main().catch((error) => {
  console.error('FAIL repo search actions');
  console.error(error.stack || error.message);
  process.exit(1);
});
