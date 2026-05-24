#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-github-slash-'));
process.env.LIKU_HOME_OVERRIDE = path.join(tempRoot, '.liku');
process.env.LIKU_HOME_OLD_OVERRIDE = path.join(tempRoot, '.liku-cli-old');

const aiService = require(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'));

let pass = 0;

async function test(name, fn) {
  await fn();
  pass += 1;
  console.log(`PASS ${name}`);
}

(async () => {
  try {
    await test('aiService.handleCommand exposes shared /github help', async () => {
    const result = await aiService.handleCommand('/github help');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.message.includes('Shared GitHub slash commands:'));
    assert.ok(result.message.includes('/github capabilities list'));
    assert.ok(result.message.includes('/github plan build'));
    assert.ok(result.message.includes('/github plan execute'));
    assert.ok(result.message.includes('/github pr diff <number>'));
    assert.ok(result.message.includes('/github releases inspect <latest|tag|id>'));
    });

    await test('aiService.handleCommand exposes /github capabilities list through the registry catalog', async () => {
    const result = await aiService.handleCommand('/github capabilities list');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.capabilities-list.v1');
    assert.strictEqual(result.data.capability.key, 'capabilities.list');
    assert.strictEqual(result.data.policy.allowed, true);
    assert.ok(Array.isArray(result.data.capabilities));
    assert.ok(result.data.capabilities.some((entry) => entry.key === 'pr.diff'));
    assert.ok(result.message.includes('GitHub capabilities list'));
    });

    await test('aiService.handleCommand exposes /github capabilities inspect through the registry catalog', async () => {
    const result = await aiService.handleCommand('/github capabilities inspect pr.diff');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.capability-inspect.v1');
    assert.strictEqual(result.data.capability.key, 'capabilities.inspect');
    assert.strictEqual(result.data.policy.allowed, true);
    assert.strictEqual(result.data.entry.key, 'pr.diff');
    assert.strictEqual(result.data.entry.policyBySource.slash.allowed, true);
    assert.ok(result.message.includes('GitHub capability inspect'));
    });

    await test('aiService.handleCommand exposes /github plan build through the registry-backed planner', async () => {
    const result = await aiService.handleCommand('/github plan build pr diff 7 --limit 30 --api false');
    assert.ok(result);
    assert.strictEqual(result.type, 'info');
    assert.ok(result.data);
    assert.strictEqual(result.data.schemaVersion, 'github.plan-build.v1');
    assert.strictEqual(result.data.capability.key, 'plan.build');
    assert.strictEqual(result.data.policy.allowed, true);
    assert.strictEqual(result.data.targetCapability.key, 'pr.diff');
    assert.strictEqual(result.data.plan.schemaVersion, 'github.execution-plan.v1');
    assert.strictEqual(result.data.plan.steps[0].capabilityKey, 'pr.diff');
    assert.strictEqual(result.data.plan.steps[0].runtimeInput.api, false);
    assert.ok(result.message.includes('GitHub plan build'));
    });

    await test('aiService.handleCommand exposes /github plan execute through the bounded registry-backed executor', async () => {
      const result = await aiService.handleCommand('/github plan execute pr diff 7 --limit 30 --api false');
      assert.ok(result);
      assert.strictEqual(result.type, 'info');
      assert.ok(result.data);
      assert.strictEqual(result.data.schemaVersion, 'github.plan-execute.v1');
      assert.strictEqual(result.data.capability.key, 'plan.execute');
      assert.strictEqual(result.data.policy.allowed, true);
      assert.strictEqual(result.data.success, true);
      assert.strictEqual(result.data.targetCapability.key, 'pr.diff');
      assert.strictEqual(result.data.execution.stepsExecuted, 1);
      assert.strictEqual(result.data.execution.timedOut, false);
      assert.ok(result.data.planArtifact.filePath);
      assert.ok(result.data.resultArtifact.filePath);
      assert.ok(fs.existsSync(result.data.planArtifact.filePath));
      assert.ok(fs.existsSync(result.data.resultArtifact.filePath));
      assert.ok(result.message.includes('GitHub plan execute'));
    });

    await test('aiService.handleCommand replays /github plan execute from a saved plan artifact', async () => {
      const initial = await aiService.handleCommand('/github plan execute issues list --api false --limit 5 --state all');
      assert.ok(initial?.data?.planArtifact?.filePath);

      const replay = await aiService.handleCommand(`/github plan execute --plan-file "${initial.data.planArtifact.filePath}"`);
      assert.ok(replay);
      assert.strictEqual(replay.type, 'info');
      assert.ok(replay.data);
      assert.strictEqual(replay.data.schemaVersion, 'github.plan-execute.v1');
      assert.strictEqual(replay.data.success, true);
      assert.strictEqual(replay.data.execution.planSource, 'artifact-replay');
      assert.strictEqual(replay.data.capability.key, 'plan.execute');
      assert.ok(replay.message.includes('GitHub plan execute'));
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
    assert.strictEqual(result.data.capability.key, 'issues.list');
    assert.strictEqual(result.data.policy.allowed, true);
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
    assert.strictEqual(result.data.capability.key, 'pr.diff');
    assert.strictEqual(result.data.policy.allowed, true);
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
    assert.strictEqual(result.data.capability.key, 'releases.inspect');
    assert.strictEqual(result.data.policy.allowed, true);
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
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('FAIL ai-service github slash commands');
  console.error(error.stack || error.message);
  process.exit(1);
});
