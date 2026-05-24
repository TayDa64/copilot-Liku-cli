#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  buildGitHubExecutionPlan,
  GITHUB_EXECUTION_PLAN_SCHEMA_VERSION,
  GITHUB_PLAN_BUILD_SCHEMA_VERSION,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'plan-builder.js'));

let pass = 0;

async function test(name, fn) {
  await fn();
  pass += 1;
  console.log(`PASS ${name}`);
}

(async () => {
  await test('buildGitHubExecutionPlan creates a deterministic one-step plan for registered GitHub capabilities', async () => {
    const report = buildGitHubExecutionPlan({
      source: 'cli',
      positionals: ['plan', 'build', 'pr', 'diff', '7'],
      runtimeOptions: { limit: 30, api: 'false' },
      executionPreferences: { approvalMode: 'auto' },
      featureFlagEnabled: true,
    });

    assert.strictEqual(report.schemaVersion, GITHUB_PLAN_BUILD_SCHEMA_VERSION);
    assert.strictEqual(report.success, true);
    assert.strictEqual(report.planner.mode, 'registry-deterministic');
    assert.strictEqual(report.targetCapability.key, 'pr.diff');
    assert.strictEqual(report.plan.schemaVersion, GITHUB_EXECUTION_PLAN_SCHEMA_VERSION);
    assert.strictEqual(report.plan.steps.length, 1);
    assert.strictEqual(report.plan.steps[0].capabilityKey, 'pr.diff');
    assert.strictEqual(report.plan.steps[0].policy.allowed, true);
    assert.strictEqual(report.plan.steps[0].runtimeInput.number, '7');
    assert.strictEqual(report.plan.steps[0].runtimeInput.api, false);
    assert.strictEqual(report.plan.steps[0].runtimeInput.limit, 30);
  });

  await test('buildGitHubExecutionPlan returns usage guidance for incomplete planner requests', async () => {
    const report = buildGitHubExecutionPlan({
      source: 'slash',
      positionals: ['plan', 'build'],
    });

    assert.strictEqual(report.schemaVersion, GITHUB_PLAN_BUILD_SCHEMA_VERSION);
    assert.strictEqual(report.success, false);
    assert.strictEqual(report.error, 'USAGE');
    assert.ok(report.message.includes('Usage: liku github plan build'));
    assert.ok(Array.isArray(report.availableTargets));
    assert.ok(report.availableTargets.includes('pr.diff'));
    assert.ok(!report.availableTargets.includes('plan.execute'));
  });

  await test('buildGitHubExecutionPlan rejects unknown planner targets', async () => {
    const report = buildGitHubExecutionPlan({
      source: 'cli',
      positionals: ['plan', 'build', 'unknown', 'noop'],
    });

    assert.strictEqual(report.schemaVersion, GITHUB_PLAN_BUILD_SCHEMA_VERSION);
    assert.strictEqual(report.success, false);
    assert.strictEqual(report.error, 'UNKNOWN_TARGET');
    assert.strictEqual(report.requestedTarget.area, 'unknown');
    assert.strictEqual(report.requestedTarget.action, 'noop');
  });

  console.log(`PASS github plan builder (${pass} assertions)`);
})().catch((error) => {
  console.error('FAIL github plan builder');
  console.error(error.stack || error.message);
  process.exit(1);
});
