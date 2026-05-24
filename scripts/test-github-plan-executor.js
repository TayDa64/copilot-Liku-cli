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
  GITHUB_PLAN_RESUME_SCHEMA_VERSION,
  resumeGitHubExecutionPlan,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'plan-executor.js'));
const {
  buildGitHubExecutionPlan,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'plan-builder.js'));
const {
  GITHUB_PLAN_EVENT_SCHEMA_VERSION,
  GITHUB_PLAN_GUIDANCE_SCHEMA_VERSION,
  appendGitHubPlanEvent,
  readGitHubPlanArtifact,
  readGitHubPlanEventLog,
  readGitHubPlanGuidanceArtifact,
  writeGitHubPlanResultArtifact,
  writeGitHubPlanArtifact,
  writeGitHubPlanGuidanceArtifact,
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
      assert.strictEqual(report.execution.terminalEvent, 'execution.completed');
      assert.strictEqual(report.planSummary.stepsTotal, 1);
      assert.ok(report.run.runId);
      assert.ok(report.eventLog.filePath);
      assert.ok(report.planArtifact.filePath);
      assert.ok(report.resultArtifact.filePath);
      assert.ok(fs.existsSync(report.eventLog.filePath));
      assert.ok(fs.existsSync(report.planArtifact.filePath));
      assert.ok(fs.existsSync(report.resultArtifact.filePath));
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0].area, 'pr');
      assert.strictEqual(requests[0].action, 'diff');
      assert.strictEqual(requests[0].positionals[2], '7');
      assert.strictEqual(requests[0].options.api, false);
      assert.ok(report.boundedExecutor.replayCommand.includes('--plan-file'));

      const eventLog = readGitHubPlanEventLog({ filePath: report.eventLog.filePath });
      assert.strictEqual(eventLog.schemaVersion, GITHUB_PLAN_EVENT_SCHEMA_VERSION);
      assert.strictEqual(eventLog.runId, report.run.runId);
      assert.deepStrictEqual(eventLog.events.map((entry) => entry.eventName), [
        'execution.started',
        'step.started',
        'step.completed',
        'execution.completed',
      ]);
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
      assert.ok(replay.run.runId);
      assert.notStrictEqual(replay.run.runId, initial.run.runId);
      assert.ok(replay.eventLog.filePath);
      assert.ok(fs.existsSync(replay.eventLog.filePath));
      assert.strictEqual(replayRequests.length, 1);
      assert.strictEqual(replayRequests[0].area, 'issues');
      assert.strictEqual(replayRequests[0].action, 'list');
      assert.strictEqual(replayRequests[0].options.state, 'all');
      const savedArtifact = readGitHubPlanArtifact({ filePath: initial.planArtifact.filePath });
      assert.strictEqual(savedArtifact.planReport.targetCapability.key, 'issues.list');
    });

    await test('executeGitHubExecutionPlan writes run-scoped guidance checkpoints for blocked execution', async () => {
      const report = await executeGitHubExecutionPlan({
        source: 'cli',
        positionals: ['plan', 'execute', 'pr', 'diff', '7'],
        runtimeOptions: { limit: 30, api: 'false' },
        executeGitHubCommand() {
          return Promise.resolve({
            success: false,
            status: 'needs-guidance',
            error: 'GUIDANCE_REQUIRED',
            message: 'Need a base branch before continuing.',
            guidance: {
              reason: 'user-clarification',
              questions: [
                {
                  id: 'base-branch',
                  prompt: 'Which base branch should the diff be compared against?',
                  kind: 'single-select',
                  allowFreeformInput: false,
                  options: [
                    { label: 'main', value: 'main' },
                    { label: 'develop', value: 'develop' },
                  ],
                },
              ],
            },
          });
        },
      });

      assert.strictEqual(report.success, false);
      assert.strictEqual(report.status, 'needs-guidance');
      assert.strictEqual(report.error, 'GUIDANCE_REQUIRED');
      assert.strictEqual(report.resultArtifact, null);
      assert.ok(report.run.runId);
      assert.ok(report.eventLog.filePath);
      assert.ok(report.guidanceArtifact.filePath);
      assert.ok(report.resume.resumeToken);
      assert.strictEqual(report.resume.guidanceFilePath, report.guidanceArtifact.filePath);
      assert.strictEqual(report.execution.terminal, false);
      assert.strictEqual(report.execution.finishedAt, null);
      assert.ok(fs.existsSync(report.eventLog.filePath));
      assert.ok(fs.existsSync(report.guidanceArtifact.filePath));

      const guidanceArtifact = readGitHubPlanGuidanceArtifact({ filePath: report.guidanceArtifact.filePath });
      assert.strictEqual(guidanceArtifact.schemaVersion, GITHUB_PLAN_GUIDANCE_SCHEMA_VERSION);
      assert.strictEqual(guidanceArtifact.runId, report.run.runId);
      assert.strictEqual(guidanceArtifact.questions.length, 1);
      assert.strictEqual(guidanceArtifact.questions[0].id, 'base-branch');

      const eventLog = readGitHubPlanEventLog({ filePath: report.eventLog.filePath });
      assert.deepStrictEqual(eventLog.events.map((entry) => entry.eventName), [
        'execution.started',
        'step.started',
        'guidance.requested',
      ]);
    });

    await test('resumeGitHubExecutionPlan continues a blocked run from its saved guidance checkpoint', async () => {
      const blocked = await executeGitHubExecutionPlan({
        source: 'cli',
        positionals: ['plan', 'execute', 'issues', 'list'],
        runtimeOptions: { limit: 5, api: 'false' },
        executeGitHubCommand(request) {
          if (!request.options.state) {
            return Promise.resolve({
              success: false,
              status: 'needs-guidance',
              error: 'GUIDANCE_REQUIRED',
              message: 'Need a state filter before continuing.',
              guidance: {
                reason: 'user-clarification',
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
              },
            });
          }

          return Promise.resolve({
            success: true,
            schemaVersion: 'github.issues-list.v1',
            filters: { limit: 5, state: request.options.state },
            issues: [],
            githubApi: { attempted: false },
          });
        },
      });

      const resumed = await resumeGitHubExecutionPlan({
        source: 'cli',
        runtimeOptions: {
          guidanceFile: blocked.guidanceArtifact.filePath,
          resumeToken: blocked.resume.resumeToken,
          answersJson: JSON.stringify({ state: 'all' }),
        },
        executeGitHubCommand(request) {
          return Promise.resolve({
            success: true,
            schemaVersion: 'github.issues-list.v1',
            filters: { limit: 5, state: request.options.state },
            issues: [],
            githubApi: { attempted: false },
          });
        },
      });

      assert.strictEqual(resumed.schemaVersion, GITHUB_PLAN_RESUME_SCHEMA_VERSION);
      assert.strictEqual(resumed.success, true);
      assert.strictEqual(resumed.status, 'completed');
      assert.strictEqual(resumed.run.runId, blocked.run.runId);
      assert.strictEqual(resumed.stepResults.length, 1);
      assert.strictEqual(resumed.stepResults[0].result.filters.state, 'all');

      const guidanceArtifact = readGitHubPlanGuidanceArtifact({ filePath: blocked.guidanceArtifact.filePath });
      assert.strictEqual(guidanceArtifact.status, 'completed');
      assert.strictEqual(guidanceArtifact.answers.state, 'all');
      assert.ok(guidanceArtifact.resultArtifact.filePath);

      const eventLog = readGitHubPlanEventLog({ filePath: resumed.eventLog.filePath });
      assert.deepStrictEqual(eventLog.events.map((entry) => entry.eventName), [
        'execution.started',
        'step.started',
        'guidance.requested',
        'guidance.responded',
        'step.started',
        'step.completed',
        'execution.completed',
      ]);
    });

    await test('resumeGitHubExecutionPlan can return the current terminal state without replaying completed steps', async () => {
      const buildReport = buildGitHubExecutionPlan({
        source: 'cli',
        positionals: ['plan', 'build', 'issues', 'list'],
        runtimeOptions: { limit: 5, api: 'false', state: 'all' },
      });
      const planArtifact = writeGitHubPlanArtifact({
        source: 'cli',
        metadata: { mode: 'bounded-executor', orchestrationMode: 'bounded-evented', runId: 'github-run-reuse' },
        planReport: buildReport,
      });

      appendGitHubPlanEvent({ artifactId: planArtifact.artifactId, runId: 'github-run-reuse', sequence: 1, eventName: 'execution.started', source: 'cli', status: 'running' });
      appendGitHubPlanEvent({ artifactId: planArtifact.artifactId, runId: 'github-run-reuse', sequence: 2, eventName: 'step.started', source: 'cli', status: 'running', step: { stepId: 'step-1', capabilityKey: 'issues.list' } });
      appendGitHubPlanEvent({ artifactId: planArtifact.artifactId, runId: 'github-run-reuse', sequence: 3, eventName: 'guidance.requested', source: 'cli', status: 'blocked', step: { stepId: 'step-1', capabilityKey: 'issues.list' }, guidance: { guidanceId: 'github-guidance-reuse', resumeToken: 'resume-token-reuse' } });

      const resultArtifact = writeGitHubPlanResultArtifact({
        source: 'cli',
        metadata: { outcome: 'success', runId: 'github-run-reuse' },
        planArtifact,
        execution: {
          planSource: 'guidance-resume',
          status: 'completed',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          elapsedMs: 5,
          timedOut: false,
          terminal: true,
          terminalEvent: 'execution.completed',
          stepsExecuted: 1,
        },
        stepResults: [
          {
            stepId: 'step-1',
            capabilityKey: 'issues.list',
            success: true,
            schemaVersion: 'github.issues-list.v1',
            error: null,
            message: null,
            result: {
              success: true,
              schemaVersion: 'github.issues-list.v1',
              filters: { state: 'all', limit: 5 },
              issues: [],
            },
            elapsedMs: 5,
          },
        ],
      });

      const guidanceArtifact = writeGitHubPlanGuidanceArtifact({
        artifactId: planArtifact.artifactId,
        runId: 'github-run-reuse',
        guidanceId: 'github-guidance-reuse',
        status: 'completed',
        reason: 'user-clarification',
        resumeToken: 'resume-token-reuse',
        requestedBy: { stepId: 'step-1', capabilityKey: 'issues.list' },
        questions: [
          {
            id: 'state',
            prompt: 'Which issue state should be used?',
            kind: 'single-select',
            targetType: 'option',
            targetField: 'state',
            options: [
              { label: 'all', value: 'all' },
            ],
          },
        ],
        answers: { state: 'all' },
        planArtifact,
        resultArtifact,
        execution: {
          planSource: 'guidance-resume',
          status: 'completed',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          elapsedMs: 5,
          timedOut: false,
          terminal: true,
          terminalEvent: 'execution.completed',
          stepsExecuted: 1,
        },
        blockedStepIndex: 0,
        stepResults: [
          {
            stepId: 'step-1',
            capabilityKey: 'issues.list',
            success: true,
            schemaVersion: 'github.issues-list.v1',
            error: null,
            message: null,
            result: {
              success: true,
              schemaVersion: 'github.issues-list.v1',
              filters: { state: 'all', limit: 5 },
              issues: [],
            },
            elapsedMs: 5,
          },
        ],
      });

      const resumed = await resumeGitHubExecutionPlan({
        source: 'cli',
        runtimeOptions: {
          guidanceFile: guidanceArtifact.filePath,
          resumeToken: 'resume-token-reuse',
          answersJson: JSON.stringify({ state: 'all' }),
        },
        executeGitHubCommand() {
          throw new Error('resume should not replay a completed run');
        },
      });

      assert.strictEqual(resumed.schemaVersion, GITHUB_PLAN_RESUME_SCHEMA_VERSION);
      assert.strictEqual(resumed.success, true);
      assert.strictEqual(resumed.status, 'completed');
      assert.strictEqual(resumed.stepResults.length, 1);
      assert.strictEqual(resumed.stepResults[0].result.filters.state, 'all');
      assert.strictEqual(resumed.resultArtifact.filePath, resultArtifact.filePath);
      assert.strictEqual(resumed.run.runId, 'github-run-reuse');
      const eventLog = readGitHubPlanEventLog({ filePath: resumed.eventLog.filePath });
      assert.deepStrictEqual(eventLog.events.map((entry) => entry.eventName), [
        'execution.started',
        'step.started',
        'guidance.requested',
      ]);
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
      assert.ok(report.run.runId);
      assert.ok(report.eventLog.filePath);
      assert.ok(report.resultArtifact.filePath);
      assert.ok(fs.existsSync(report.eventLog.filePath));
      assert.ok(fs.existsSync(report.resultArtifact.filePath));

      const eventLog = readGitHubPlanEventLog({ filePath: report.eventLog.filePath });
      assert.deepStrictEqual(eventLog.events.map((entry) => entry.eventName), ['execution.aborted']);
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
