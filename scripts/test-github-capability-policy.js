#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  inspectGitHubCapabilityCatalogEntry,
  listGitHubCapabilityCatalog,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'capability-inspect.js'));
const {
  findGitHubCapability,
  listGitHubCapabilities,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'capability-registry.js'));
const {
  evaluateGitHubCapabilityPolicy,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'capability-policy.js'));
const {
  createGitHubCommandExecutor,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'command-executor.js'));

let pass = 0;

async function test(name, fn) {
  await fn();
  pass += 1;
  console.log(`PASS ${name}`);
}

(async () => {
  await test('registry exposes read-only metadata for current GitHub capabilities', async () => {
    const capabilities = listGitHubCapabilities();
    assert.ok(capabilities.length >= 12);

    const keys = capabilities.map((entry) => entry.key);
    assert.ok(keys.includes('auth.status'));
    assert.ok(keys.includes('capabilities.list'));
    assert.ok(keys.includes('capabilities.inspect'));
    assert.ok(keys.includes('plan.build'));
    assert.ok(keys.includes('plan.execute'));
    assert.ok(keys.includes('plan.resume'));
    assert.ok(keys.includes('issues.list'));
    assert.ok(keys.includes('pr.diff'));
    assert.ok(keys.includes('workflow.inspect'));
    assert.ok(keys.includes('releases.inspect'));

    const issueList = findGitHubCapability('issues', 'list');
    assert.ok(issueList);
    assert.strictEqual(issueList.responseSchemaVersion, 'github.issues-list.v1');
    assert.strictEqual(issueList.sideEffectClass, 'read');
    assert.strictEqual(issueList.approvalRequirement, 'none');
    assert.strictEqual(issueList.riskLevel, 'low');
    assert.deepStrictEqual(issueList.allowedSources.slice().sort(), ['cli', 'slash']);
  });

  await test('capability catalog helpers summarize registered GitHub capabilities with policy previews', async () => {
    const listReport = listGitHubCapabilityCatalog();
    assert.strictEqual(listReport.success, true);
    assert.strictEqual(listReport.schemaVersion, 'github.capabilities-list.v1');
    assert.ok(Array.isArray(listReport.capabilities));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'capabilities.list'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'plan.build'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'plan.execute'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'plan.resume'));

    const inspectReport = inspectGitHubCapabilityCatalogEntry({ key: 'pr.diff' });
    assert.strictEqual(inspectReport.success, true);
    assert.strictEqual(inspectReport.schemaVersion, 'github.capability-inspect.v1');
    assert.strictEqual(inspectReport.entry.key, 'pr.diff');
    assert.strictEqual(inspectReport.entry.policyBySource.cli.allowed, true);
    assert.strictEqual(inspectReport.entry.policyBySource.slash.allowed, true);
  });

  await test('policy allows registered read-only GitHub capabilities from supported sources', async () => {
    const capability = findGitHubCapability('pr', 'inspect');
    const cliPolicy = evaluateGitHubCapabilityPolicy({
      capability,
      source: 'cli',
      executionPreferences: { approvalMode: 'never' },
    });
    const slashPolicy = evaluateGitHubCapabilityPolicy({
      capability,
      source: 'slash',
      executionPreferences: { approvalMode: 'auto' },
    });

    assert.strictEqual(cliPolicy.allowed, true);
    assert.strictEqual(cliPolicy.reason, 'read-only-capability-allowed');
    assert.strictEqual(cliPolicy.approvalMode, 'never');
    assert.strictEqual(cliPolicy.requiresApproval, false);
    assert.strictEqual(slashPolicy.allowed, true);
    assert.strictEqual(slashPolicy.source, 'slash');
  });

  await test('policy denies unsupported sources and non-read capabilities', async () => {
    const issueList = findGitHubCapability('issues', 'list');
    const deniedSource = evaluateGitHubCapabilityPolicy({
      capability: issueList,
      source: 'background',
    });
    const deniedMutation = evaluateGitHubCapabilityPolicy({
      capability: {
        key: 'issues.create',
        area: 'issues',
        action: 'create',
        allowedSources: ['cli'],
        sideEffectClass: 'write',
        approvalRequirement: 'explicit',
        riskLevel: 'medium',
        supportsDryRun: true,
      },
      source: 'cli',
      executionPreferences: { dryRunDefault: true },
    });

    assert.strictEqual(deniedSource.allowed, false);
    assert.strictEqual(deniedSource.reason, 'source-not-allowed');
    assert.strictEqual(deniedMutation.allowed, false);
    assert.strictEqual(deniedMutation.reason, 'mutation-capability-disabled');
    assert.strictEqual(deniedMutation.effectiveDryRun, true);
  });

  await test('executor attaches capability and policy metadata to successful reports', async () => {
    const telemetry = [];
    let authInput = null;
    const executor = createGitHubCommandExecutor({
      env: {},
      cwd: 'C:/dev/copilot-Liku-cli',
      resolveGitHubAuthStatus(input) {
        authInput = input;
        return Promise.resolve({
          success: true,
          schemaVersion: 'github.auth-status.v1',
          featureFlagEnabled: true,
          warnings: [],
          copilot: {
            authenticated: false,
            provider: 'copilot',
            model: 'gpt-4o',
            modelName: 'GPT-4o',
          },
          githubApi: {
            tokenPresent: false,
            probeAttempted: false,
          },
        });
      },
      writeTelemetry(payload) {
        telemetry.push(payload);
        return payload;
      },
    });

    const report = await executor.execute({
      source: 'slash',
      area: 'auth',
      action: 'status',
      positionals: ['auth', 'status'],
      options: { probe: 'false' },
      featureFlagEnabled: true,
    });

    assert.ok(authInput);
    assert.strictEqual(authInput.probe, false);
    assert.strictEqual(report.capability.key, 'auth.status');
    assert.strictEqual(report.policy.allowed, true);
    assert.strictEqual(report.policy.reason, 'read-only-capability-allowed');
    assert.strictEqual(telemetry.length, 1);
    assert.strictEqual(telemetry[0].outcome, 'success');
    assert.strictEqual(telemetry[0].actions[0].capability, 'auth.status');
    assert.strictEqual(telemetry[0].context.policy.allowed, true);
  });

  await test('executor records failure telemetry for usage-level adapter failures', async () => {
    const telemetry = [];
    const executor = createGitHubCommandExecutor({
      env: {},
      cwd: 'C:/dev/copilot-Liku-cli',
      inspectGitHubPullRequest() {
        return Promise.resolve({
          success: false,
          error: 'USAGE',
          message: 'Usage: liku github pr inspect <number>',
          warnings: [],
        });
      },
      writeTelemetry(payload) {
        telemetry.push(payload);
        return payload;
      },
    });

    const report = await executor.execute({
      source: 'cli',
      area: 'pr',
      action: 'inspect',
      positionals: ['pr', 'inspect'],
      options: {},
      featureFlagEnabled: true,
      executionPreferences: { approvalMode: 'auto' },
    });

    assert.strictEqual(report.success, false);
    assert.strictEqual(report.error, 'USAGE');
    assert.strictEqual(report.capability.key, 'pr.inspect');
    assert.strictEqual(report.policy.allowed, true);
    assert.strictEqual(telemetry.length, 1);
    assert.strictEqual(telemetry[0].outcome, 'failure');
    assert.strictEqual(telemetry[0].actions[0].capability, 'pr.inspect');
    assert.strictEqual(telemetry[0].context.result.error, 'USAGE');
  });

  console.log(`PASS github capability registry/policy (${pass} assertions)`);
})().catch((error) => {
  console.error('FAIL github capability registry/policy');
  console.error(error.stack || error.message);
  process.exit(1);
});
