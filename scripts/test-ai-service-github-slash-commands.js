#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const aiService = require(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'));

let pass = 0;

async function test(name, fn) {
  await fn();
  pass += 1;
  console.log(`PASS ${name}`);
}

(async () => {
  await test('aiService.handleCommand exposes shared /github help', async () => {
    const result = await aiService.handleCommand('/github help');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.message.includes('Shared GitHub slash commands:'));
    assert.ok(result.message.includes('/github pr diff <number>'));
    assert.ok(result.message.includes('/github releases inspect <latest|tag|id>'));
  });

  await test('aiService.handleCommand routes /github issues list through typed adapters', async () => {
    const result = await aiService.handleCommand('/github issues list --api false --state all --limit 5');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.issues-list.v1');
    assert.strictEqual(result.data.filters.state, 'all');
    assert.strictEqual(result.data.filters.limit, 5);
    assert.strictEqual(result.data.githubApi.attempted, false);
    assert.ok(result.message.includes('GitHub issues list'));
  });

  await test('aiService.handleCommand routes /github pr diff through typed adapters', async () => {
    const result = await aiService.handleCommand('/github pr diff 7 --api false --limit 30');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.pr-diff-summary.v1');
    assert.strictEqual(result.data.pullRequestNumber, 7);
    assert.strictEqual(result.data.filters.limit, 30);
    assert.strictEqual(result.data.githubApi.attempted, false);
    assert.ok(result.message.includes('GitHub pull request diff summary'));
  });

  await test('aiService.handleCommand routes /github releases inspect through typed adapters', async () => {
    const result = await aiService.handleCommand('/github releases inspect latest --api false');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.release-inspect.v1');
    assert.strictEqual(result.data.selector.kind, 'latest');
    assert.strictEqual(result.data.githubApi.attempted, false);
    assert.ok(result.message.includes('GitHub release inspect'));
  });

  await test('aiService.handleCommand reports usage errors for incomplete /github inspect calls', async () => {
    const result = await aiService.handleCommand('/github pr inspect');
    assert.ok(result);
    assert.strictEqual(result.type, 'error');
    assert.ok(result.message.includes('Usage: liku github pr inspect <number>'));
    assert.ok(result.message.includes('Shared GitHub slash commands:'));
  });

  console.log(`PASS ai-service github slash commands (${pass} assertions)`);
})().catch((error) => {
  console.error('FAIL ai-service github slash commands');
  console.error(error.stack || error.message);
  process.exit(1);
});
