#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-github-plan-exec-'));
process.env.LIKU_HOME_OVERRIDE = path.join(tempRoot, '.liku');
process.env.LIKU_HOME_OLD_OVERRIDE = path.join(tempRoot, '.liku-cli-old');

const {
  executeGitHubExecutionPlan,
  GITHUB_PLAN_EXECUTE_SCHEMA_VERSION,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'plan-executor.js'));
const {
  buildGitHubExecutionPlan,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'plan-builder.js'));
const {
  readGitHubPlanArtifact,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'plan-artifacts.js'));

let pass = 0;

async function test(name, fn) {
  await fn();
  pass += 1;
  console.log(`PASS ${name}`);
}

(async () => {
  try {
    await test('executeGitHubExecutionPlan builds, executes, and persists replayable artifacts', async () => {
      const requests = [];
      const report = await executeGitHubExecutionPlan({
        source: 'cli',
        positionals: ['plan', 'execute', 'pr', 'diff', '7'],
        runtimeOptions: { limit: 30, api: 'false' },
        executionPreferences: { approvalMode: 'auto' },
        featureFlagEnabled: true,
        executeGitHubCommand(request) {
          requests.push(request);
          return Promise.resolve({
            success: true,
            schemaVersion: 'github.pr-diff-summary.v1',
            pullRequestNumber: 7,
            filters: { limit: 30 },
            githubApi: { attempted: false },
            capability: { key: 'pr.diff' },
            policy: { allowed: true },
          });
        },
      });

      assert.strictEqual(report.schemaVersion, GITHUB_PLAN_EXECUTE_SCHEMA_VERSION);
      assert.strictEqual(report.success, true);
      assert.strictEqual(report.execution.stepsExecuted, 1);
      assert.strictEqual(report.execution.timedOut, false);
      assert.strictEqual(report.planSummary.stepsTotal, 1);
      assert.ok(report.planArtifact.filePath);
      assert.ok(report.resultArtifact.filePath);
      assert.ok(fs.existsSync(report.planArtifact.filePath));
      assert.ok(fs.existsSync(report.resultArtifact.filePath));
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0].area, 'pr');
      assert.strictEqual(requests[0].action, 'diff');
      assert.strictEqual(requests[0].positionals[2], '7');
      assert.strictEqual(requests[0].options.api, false);
      assert.ok(report.boundedExecutor.replayCommand.includes('--plan-file'));
    });

    await test('executeGitHubExecutionPlan replays a saved plan artifact via --plan-file', async () => {
      const buildReport = buildGitHubExecutionPlan({
        source: 'cli',
        positionals: ['plan', 'build', 'issues', 'list'],
        runtimeOptions: { limit: 5, api: 'false', state: 'all' },
      });
      const initial = await executeGitHubExecutionPlan({
        source: 'cli',
        positionals: ['plan', 'execute', 'issues', 'list'],
        runtimeOptions: { limit: 5, api: 'false', state: 'all' },
        planReport: buildReport,
        executeGitHubCommand() {
          return Promise.resolve({
            success: true,
            schemaVersion: 'github.issues-list.v1',
            filters: { limit: 5, state: 'all' },
            issues: [],
            githubApi: { attempted: false },
          });
        },
      });

      const replayRequests = [];
      const replay = await executeGitHubExecutionPlan({
        source: 'cli',
        positionals: ['plan', 'execute'],
        runtimeOptions: { planFile: initial.planArtifact.filePath },
        executeGitHubCommand(request) {
          replayRequests.push(request);
          return Promise.resolve({
            success: true,
            schemaVersion: 'github.issues-list.v1',
            filters: { limit: 5, state: 'all' },
            issues: [],
            githubApi: { attempted: false },
          });
        },
      });

      assert.strictEqual(replay.success, true);
      assert.strictEqual(replay.execution.planSource, 'artifact-replay');
      assert.strictEqual(replayRequests.length, 1);
      assert.strictEqual(replayRequests[0].area, 'issues');
      assert.strictEqual(replayRequests[0].action, 'list');
      assert.strictEqual(replayRequests[0].options.state, 'all');
      const savedArtifact = readGitHubPlanArtifact({ filePath: initial.planArtifact.filePath });
      assert.strictEqual(savedArtifact.planReport.targetCapability.key, 'issues.list');
    });

    await test('executeGitHubExecutionPlan enforces bounded step budgets', async () => {
      const report = await executeGitHubExecutionPlan({
        source: 'cli',
        planReport: {
          schemaVersion: 'github.plan-build.v1',
          success: true,
          targetCapability: { key: 'pr.diff', description: 'Summarize changed files', responseSchemaVersion: 'github.pr-diff-summary.v1' },
          plan: {
            schemaVersion: 'github.execution-plan.v1',
            goal: 'Too many steps',
            budget: { maxSteps: 1, timeoutMs: 60000 },
            constraints: [],
            steps: [
              {
                id: 'step-1',
                type: 'github-capability',
                capabilityKey: 'pr.diff',
                invocation: { area: 'pr', action: 'diff', args: ['7'], options: {} },
                policy: { allowed: true, source: 'cli' },
              },
              {
                id: 'step-2',
                type: 'github-capability',
                capabilityKey: 'issues.list',
                invocation: { area: 'issues', action: 'list', args: [], options: {} },
                policy: { allowed: true, source: 'cli' },
              },
            ],
          },
        },
        executeGitHubCommand() {
          throw new Error('should not execute when budget validation fails');
        },
      });

      assert.strictEqual(report.schemaVersion, GITHUB_PLAN_EXECUTE_SCHEMA_VERSION);
      assert.strictEqual(report.success, false);
      assert.strictEqual(report.error, 'PLAN_BUDGET_EXCEEDED');
      assert.ok(report.resultArtifact.filePath);
      assert.ok(fs.existsSync(report.resultArtifact.filePath));
    });

    console.log(`PASS github plan executor (${pass} assertions)`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('FAIL github plan executor');
  console.error(error.stack || error.message);
  process.exit(1);
});
