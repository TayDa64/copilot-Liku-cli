#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-github-plan-ledger-'));
process.env.LIKU_HOME_OVERRIDE = path.join(tempRoot, '.liku');
process.env.LIKU_HOME_OLD_OVERRIDE = path.join(tempRoot, '.liku-cli-old');
process.env.LIKU_ENABLE_GITHUB = '1';

const { buildGitHubExecutionPlan } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'plan-builder.js'));
const { inspectGitHubPlanRun } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'plan-run-inspect.js'));
const { listGitHubPlanRuns } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'plan-run-list.js'));
const {
  GITHUB_PLAN_ARTIFACT_SCHEMA_VERSION,
  appendGitHubPlanEvent,
  ensureGitHubPlanArtifactsDir,
  writeGitHubPlanArtifact,
  writeGitHubPlanGuidanceArtifact,
  writeGitHubPlanResultArtifact,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'plan-artifacts.js'));

let pass = 0;

async function test(name, fn) {
  await fn();
  pass += 1;
  console.log(`PASS ${name}`);
}

function createGitHubEnv() {
  return {
    LIKU_ENABLE_GITHUB: '1',
    LIKU_HOME_OVERRIDE: process.env.LIKU_HOME_OVERRIDE,
    LIKU_HOME_OLD_OVERRIDE: process.env.LIKU_HOME_OLD_OVERRIDE,
  };
}

function buildPlanReport({ source = 'cli', area, action, selector, slug, runtimeOptions = {} }) {
  const positionals = ['plan', 'build', area, action];
  if (selector !== undefined && selector !== null) {
    positionals.push(String(selector));
  }

  return buildGitHubExecutionPlan({
    source,
    positionals,
    runtimeOptions: {
      slug,
      api: false,
      ...runtimeOptions,
    },
    featureFlagEnabled: true,
  });
}

function createCompletedRun(runId, slug) {
  const startedAt = new Date().toISOString();
  const finishedAt = new Date().toISOString();
  const planReport = buildPlanReport({
    area: 'pr',
    action: 'diff',
    selector: '7',
    slug,
    runtimeOptions: { limit: 30 },
  });
  const planArtifact = writeGitHubPlanArtifact({
    source: 'cli',
    metadata: { mode: 'bounded-executor', orchestrationMode: 'bounded-evented', runId },
    planReport,
  });

  appendGitHubPlanEvent({ artifactId: planArtifact.artifactId, runId, sequence: 1, eventName: 'execution.started', source: 'cli', status: 'running' });
  appendGitHubPlanEvent({ artifactId: planArtifact.artifactId, runId, sequence: 2, eventName: 'step.completed', source: 'cli', status: 'completed', step: { stepId: 'step-1', capabilityKey: 'pr.diff' } });
  appendGitHubPlanEvent({ artifactId: planArtifact.artifactId, runId, sequence: 3, eventName: 'execution.completed', source: 'cli', status: 'completed' });

  writeGitHubPlanResultArtifact({
    source: 'cli',
    metadata: { runId },
    planArtifact,
    execution: {
      planSource: 'runtime-build',
      status: 'completed',
      startedAt,
      lastUpdatedAt: finishedAt,
      finishedAt,
      elapsedMs: 42,
      timedOut: false,
      terminal: true,
      terminalEvent: 'execution.completed',
      maxStepsAllowed: 1,
      timeoutMsAllowed: 60000,
      stepsExecuted: 1,
    },
    stepResults: [
      {
        stepId: 'step-1',
        capabilityKey: 'pr.diff',
        success: true,
        schemaVersion: 'github.pr-diff.v1',
        result: {
          filters: {
            limit: 30,
          },
        },
      },
    ],
  });

  return { runId, planArtifact };
}

function createBlockedRun(runId, slug) {
  const planReport = buildPlanReport({
    area: 'issues',
    action: 'list',
    slug,
    runtimeOptions: { limit: 5 },
  });
  const resumeToken = `${runId}-resume-token`;
  const guidanceId = `${runId}-guidance`;
  const planArtifact = writeGitHubPlanArtifact({
    source: 'cli',
    metadata: { mode: 'bounded-executor', orchestrationMode: 'bounded-evented', runId },
    planReport,
  });

  appendGitHubPlanEvent({ artifactId: planArtifact.artifactId, runId, sequence: 1, eventName: 'execution.started', source: 'cli', status: 'running' });
  appendGitHubPlanEvent({ artifactId: planArtifact.artifactId, runId, sequence: 2, eventName: 'step.started', source: 'cli', status: 'running', step: { stepId: 'step-1', capabilityKey: 'issues.list' } });
  appendGitHubPlanEvent({ artifactId: planArtifact.artifactId, runId, sequence: 3, eventName: 'guidance.requested', source: 'cli', status: 'blocked', step: { stepId: 'step-1', capabilityKey: 'issues.list' }, guidance: { guidanceId, resumeToken } });

  writeGitHubPlanGuidanceArtifact({
    artifactId: planArtifact.artifactId,
    runId,
    guidanceId,
    status: 'requested',
    reason: 'user-clarification',
    resumeToken,
    requestedBy: { stepId: 'step-1', capabilityKey: 'issues.list' },
    questions: [
      {
        id: 'state',
        prompt: 'Which issue state should be used?',
        kind: 'single-select',
        targetType: 'option',
        targetField: 'state',
        allowFreeformInput: false,
        options: [
          { label: 'open', value: 'open' },
          { label: 'all', value: 'all' },
        ],
      },
    ],
    planArtifact,
    execution: {
      planSource: 'runtime-build',
      status: 'needs-guidance',
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      finishedAt: null,
      elapsedMs: 0,
      timedOut: false,
      terminal: false,
      stepsExecuted: 0,
    },
    blockedStepIndex: 0,
    stepResults: [],
  });

  return { runId, planArtifact, resumeToken };
}

function createAbortedRun(runId, slug) {
  const startedAt = new Date().toISOString();
  const finishedAt = new Date().toISOString();
  const planReport = buildPlanReport({
    area: 'issues',
    action: 'list',
    slug,
    runtimeOptions: { limit: 10, state: 'open' },
  });
  const planArtifact = writeGitHubPlanArtifact({
    source: 'cli',
    metadata: { mode: 'bounded-executor', orchestrationMode: 'bounded-evented', runId },
    planReport,
  });

  appendGitHubPlanEvent({ artifactId: planArtifact.artifactId, runId, sequence: 1, eventName: 'execution.started', source: 'cli', status: 'running' });
  appendGitHubPlanEvent({ artifactId: planArtifact.artifactId, runId, sequence: 2, eventName: 'execution.aborted', source: 'cli', status: 'aborted' });

  writeGitHubPlanResultArtifact({
    source: 'cli',
    metadata: { runId },
    planArtifact,
    execution: {
      planSource: 'runtime-build',
      status: 'aborted',
      startedAt,
      lastUpdatedAt: finishedAt,
      finishedAt,
      elapsedMs: 12,
      timedOut: false,
      terminal: true,
      terminalEvent: 'execution.aborted',
      maxStepsAllowed: 1,
      timeoutMsAllowed: 60000,
      stepsExecuted: 0,
    },
    stepResults: [],
  });

  return { runId, planArtifact };
}

(async () => {
  try {
    ensureGitHubPlanArtifactsDir();
    const planArtifactsDir = path.join(process.env.LIKU_HOME_OVERRIDE, 'github', 'plans');

    const completed = createCompletedRun('github-run-ledger-completed', 'owner/repo');
    const blocked = createBlockedRun('github-run-ledger-blocked', 'owner/repo');
    const aborted = createAbortedRun('github-run-ledger-aborted', 'other/repo');

    fs.writeFileSync(path.join(planArtifactsDir, 'broken.plan.json'), '{not-valid-json', 'utf8');

    await test('plan ledger lists repo-scoped runs and tolerates malformed scanned artifacts', async () => {
      const report = await listGitHubPlanRuns({
        cwd: tempRoot,
        env: createGitHubEnv(),
        featureFlagEnabled: true,
        slug: 'owner/repo',
        limit: 10,
        state: 'all',
      });

      assert.strictEqual(report.schemaVersion, 'github.plan-runs.v1');
      assert.strictEqual(report.success, true);
      assert.strictEqual(report.localOnly, true);
      assert.strictEqual(report.target.slug, 'owner/repo');
      assert.strictEqual(report.totalCount, 2);
      assert.strictEqual(report.runs.length, 2);
      assert.deepStrictEqual(report.runs.map((run) => run.runId).sort(), [blocked.runId, completed.runId].sort());
      assert.ok(report.warnings.some((warning) => warning.includes('GitHub plan artifact read failed')));
    });

    await test('plan ledger filters by state and warns when no repo target is detected', async () => {
      const report = await listGitHubPlanRuns({
        cwd: tempRoot,
        env: createGitHubEnv(),
        featureFlagEnabled: true,
        limit: 10,
        state: 'aborted',
      });

      assert.strictEqual(report.schemaVersion, 'github.plan-runs.v1');
      assert.strictEqual(report.success, true);
      assert.strictEqual(report.totalCount, 1);
      assert.strictEqual(report.runs.length, 1);
      assert.strictEqual(report.runs[0].runId, aborted.runId);
      assert.strictEqual(report.runs[0].slug, 'other/repo');
      assert.strictEqual(report.runs[0].state, 'aborted');
      assert.ok(report.warnings.some((warning) => warning.includes('No GitHub repo target detected')));
    });

    await test('plan inspect joins plan, guidance, and event log artifacts for blocked runs', async () => {
      const report = await inspectGitHubPlanRun({
        cwd: tempRoot,
        env: createGitHubEnv(),
        featureFlagEnabled: true,
        runId: blocked.runId,
        slug: 'owner/repo',
      });

      assert.strictEqual(report.schemaVersion, 'github.plan-inspect.v1');
      assert.strictEqual(report.success, true);
      assert.strictEqual(report.run.runId, blocked.runId);
      assert.strictEqual(report.run.state, 'blocked');
      assert.strictEqual(report.run.targetCapability.key, 'issues.list');
      assert.strictEqual(report.guidance.resumeToken, blocked.resumeToken);
      assert.strictEqual(report.execution.status, 'needs-guidance');
      assert.strictEqual(report.eventLog.eventCount, 3);
      assert.strictEqual(report.plan.requestedTarget.area, 'issues');
      assert.strictEqual(report.planArtifact.artifactId, blocked.planArtifact.artifactId);
    });

    await test('plan inspect enforces requested repo slug matches', async () => {
      const report = await inspectGitHubPlanRun({
        cwd: tempRoot,
        env: createGitHubEnv(),
        featureFlagEnabled: true,
        runId: blocked.runId,
        slug: 'other/repo',
      });

      assert.strictEqual(report.success, false);
      assert.strictEqual(report.error, 'NOT_FOUND');
      assert.ok(report.message.includes('does not belong to other/repo'));
    });

    await test('plan inspect can attach explicit plan and event log files from outside the scanned ledger dir', async () => {
      const explicitRunId = 'github-run-ledger-explicit';
      const explicitArtifactId = 'github-plan-ledger-explicit';
      const externalDir = path.join(tempRoot, 'external-ledger');
      const explicitPlanFile = path.join(externalDir, `${explicitArtifactId}.plan.json`);
      const explicitEventLogFile = path.join(externalDir, `${explicitArtifactId}.${explicitRunId}.events.jsonl`);
      const emptyLedgerDir = path.join(tempRoot, 'empty-ledger');
      const explicitPlanReport = buildPlanReport({
        area: 'issues',
        action: 'inspect',
        selector: '321',
        slug: 'owner/repo',
      });

      fs.mkdirSync(externalDir, { recursive: true });
      fs.mkdirSync(emptyLedgerDir, { recursive: true });
      fs.writeFileSync(explicitPlanFile, JSON.stringify({
        schemaVersion: GITHUB_PLAN_ARTIFACT_SCHEMA_VERSION,
        artifactId: explicitArtifactId,
        createdAt: new Date().toISOString(),
        source: 'cli',
        metadata: {
          mode: 'bounded-executor',
          orchestrationMode: 'bounded-evented',
          runId: explicitRunId,
        },
        planReport: explicitPlanReport,
      }, null, 2), 'utf8');
      appendGitHubPlanEvent({ artifactId: explicitArtifactId, runId: explicitRunId, sequence: 1, eventName: 'execution.started', source: 'cli', status: 'running', filePath: explicitEventLogFile });
      appendGitHubPlanEvent({ artifactId: explicitArtifactId, runId: explicitRunId, sequence: 2, eventName: 'execution.completed', source: 'cli', status: 'completed', filePath: explicitEventLogFile });

      const report = await inspectGitHubPlanRun({
        cwd: tempRoot,
        env: createGitHubEnv(),
        featureFlagEnabled: true,
        artifactDir: emptyLedgerDir,
        runId: explicitRunId,
        slug: 'owner/repo',
        planFile: explicitPlanFile,
        eventLogFile: explicitEventLogFile,
      });

      assert.strictEqual(report.schemaVersion, 'github.plan-inspect.v1');
      assert.strictEqual(report.success, true);
      assert.strictEqual(report.run.runId, explicitRunId);
      assert.strictEqual(report.run.state, 'completed');
      assert.strictEqual(report.run.slug, 'owner/repo');
      assert.strictEqual(path.resolve(report.planArtifact.filePath), path.resolve(explicitPlanFile));
      assert.strictEqual(path.resolve(report.eventLog.filePath), path.resolve(explicitEventLogFile));
      assert.strictEqual(report.eventLog.eventCount, 2);
    });

    await test('plan ledger matches runs when the repo slug was inferred from the git remote', async () => {
      const inferredRunId = 'github-run-ledger-inferred-slug';
      createCompletedRun(inferredRunId);

      const report = await listGitHubPlanRuns({
        cwd: path.join(__dirname, '..'),
        env: createGitHubEnv(),
        featureFlagEnabled: true,
        limit: 20,
        state: 'completed',
      });

      assert.strictEqual(report.schemaVersion, 'github.plan-runs.v1');
      assert.strictEqual(report.success, true);
      assert.ok(report.target?.slug);
      assert.ok(report.runs.some((run) => run.runId === inferredRunId));
    });

    await test('plan runs rejects unknown state filters', async () => {
      const report = await listGitHubPlanRuns({
        cwd: tempRoot,
        env: createGitHubEnv(),
        featureFlagEnabled: true,
        slug: 'owner/repo',
        state: 'mystery',
      });

      assert.strictEqual(report.success, false);
      assert.strictEqual(report.error, 'USAGE');
      assert.ok(report.message.includes('Usage: liku github plan runs'));
    });

    console.log(`PASS github plan ledger (${pass} assertions)`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
