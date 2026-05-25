#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

async function runNode(args, cwd, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const repoRoot = path.join(__dirname, '..');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-github-cli-'));
  try {
    const sharedEnv = {
      LIKU_ENABLE_GITHUB: '1',
      LIKU_DISABLE_RUNTIME_TRACE: '1',
      LIKU_CHAT_TRANSCRIPT_QUIET: '1',
      LIKU_HOME_OVERRIDE: path.join(tempRoot, '.liku'),
      LIKU_HOME_OLD_OVERRIDE: path.join(tempRoot, '.liku-cli-old'),
    };

    process.env.LIKU_HOME_OVERRIDE = sharedEnv.LIKU_HOME_OVERRIDE;
    process.env.LIKU_HOME_OLD_OVERRIDE = sharedEnv.LIKU_HOME_OLD_OVERRIDE;

    const { buildGitHubExecutionPlan } = require(path.join(repoRoot, 'src', 'main', 'github', 'plan-builder.js'));
    const {
      appendGitHubPlanEvent,
      writeGitHubPlanArtifact,
      writeGitHubPlanGuidanceArtifact,
    } = require(path.join(repoRoot, 'src', 'main', 'github', 'plan-artifacts.js'));

    const help = await runNode(['src/cli/liku.js', '--help'], repoRoot, sharedEnv);
    assert.strictEqual(help.code, 0, 'top-level help exits 0');
    assert(help.stdout.includes('github'), 'top-level help lists the github command');
    assert(help.stdout.includes('liku github releases list --limit 5'), 'top-level help shows release listing example');

    const githubHelp = await runNode(['src/cli/liku.js', 'github', 'help'], repoRoot, sharedEnv);
    assert.strictEqual(githubHelp.code, 0, 'github help exits 0');
    assert(githubHelp.stdout.includes('liku github capabilities list'), 'github help lists capability listing');
    assert(githubHelp.stdout.includes('liku github capabilities inspect pr.diff'), 'github help lists capability inspect');
    assert(githubHelp.stdout.includes('liku github context bundle pr 123 --slug owner/repo'), 'github help lists context bundle pr');
    assert(githubHelp.stdout.includes('liku github context bundle repo --limit 5 --out-file'), 'github help lists context bundle repo');
    assert(githubHelp.stdout.includes('liku github plan build pr diff 123 --limit 50'), 'github help lists plan build');
    assert(githubHelp.stdout.includes('liku github plan execute pr diff 123 --limit 50'), 'github help lists plan execute');
    assert(githubHelp.stdout.includes('liku github plan resume --guidance-file'), 'github help lists plan resume');
    assert(githubHelp.stdout.includes('liku github issues inspect <number>'), 'github help lists issue inspect');
    assert(githubHelp.stdout.includes('liku github pr list'), 'github help lists pr list');
    assert(githubHelp.stdout.includes('liku github pr diff <number>'), 'github help lists pr diff');
    assert(githubHelp.stdout.includes('liku github workflow inspect <run-id>'), 'github help lists workflow inspect');
    assert(githubHelp.stdout.includes('liku github releases list'), 'github help lists release listing');
    assert(githubHelp.stdout.includes('liku github releases inspect <latest|tag|id>'), 'github help lists release inspect');

    const authStatus = await runNode([
      'src/cli/liku.js',
      'github',
      'auth',
      'status',
      '--json',
      '--probe',
      'false',
    ], repoRoot, sharedEnv);
    assert.strictEqual(authStatus.code, 0, 'github auth status exits 0');
    const authPayload = JSON.parse(authStatus.stdout);
    assert.strictEqual(authPayload.schemaVersion, 'github.auth-status.v1');
    assert.strictEqual(authPayload.featureFlagEnabled, true);
    assert.strictEqual(authPayload.githubApi.probeAttempted, false);
    assert.strictEqual(authPayload.capability.key, 'auth.status');
    assert.strictEqual(authPayload.policy.allowed, true);

    const capabilitiesList = await runNode([
      'src/cli/liku.js',
      'github',
      'capabilities',
      'list',
      '--json',
    ], repoRoot, sharedEnv);
    assert.strictEqual(capabilitiesList.code, 0, 'github capabilities list exits 0');
    const capabilitiesListPayload = JSON.parse(capabilitiesList.stdout);
    assert.strictEqual(capabilitiesListPayload.schemaVersion, 'github.capabilities-list.v1');
    assert.strictEqual(capabilitiesListPayload.capability.key, 'capabilities.list');
    assert.strictEqual(capabilitiesListPayload.policy.allowed, true);
    assert.ok(Array.isArray(capabilitiesListPayload.capabilities));
    assert.ok(capabilitiesListPayload.capabilities.some((entry) => entry.key === 'pr.diff'));

    const capabilityInspect = await runNode([
      'src/cli/liku.js',
      'github',
      'capabilities',
      'inspect',
      'pr.diff',
      '--json',
    ], repoRoot, sharedEnv);
    assert.strictEqual(capabilityInspect.code, 0, 'github capabilities inspect exits 0');
    const capabilityInspectPayload = JSON.parse(capabilityInspect.stdout);
    assert.strictEqual(capabilityInspectPayload.schemaVersion, 'github.capability-inspect.v1');
    assert.strictEqual(capabilityInspectPayload.capability.key, 'capabilities.inspect');
    assert.strictEqual(capabilityInspectPayload.policy.allowed, true);
    assert.strictEqual(capabilityInspectPayload.entry.key, 'pr.diff');
    assert.strictEqual(capabilityInspectPayload.entry.policyBySource.cli.allowed, true);

    const contextBundle = await runNode([
      'src/cli/liku.js',
      'github',
      'context',
      'bundle',
      'pr',
      '7',
      '--json',
      '--api',
      'false',
    ], repoRoot, sharedEnv);
    assert.strictEqual(contextBundle.code, 0, 'github context bundle exits 0');
    const contextBundlePayload = JSON.parse(contextBundle.stdout);
    assert.strictEqual(contextBundlePayload.schemaVersion, 'github.context-bundle.v1');
    assert.strictEqual(contextBundlePayload.capability.key, 'context.bundle');
    assert.strictEqual(contextBundlePayload.policy.allowed, true);
    assert.strictEqual(contextBundlePayload.target.kind, 'pr');
    assert.strictEqual(contextBundlePayload.target.selector, '7');
    assert.strictEqual(contextBundlePayload.review.exportKind, 'github-context-bundle');
    assert.strictEqual(contextBundlePayload.review.reviewRequired, true);
    assert.ok(contextBundlePayload.artifact.filePath);
    assert.ok(fs.existsSync(contextBundlePayload.artifact.filePath));

    const planBuild = await runNode([
      'src/cli/liku.js',
      'github',
      'plan',
      'build',
      'pr',
      'diff',
      '7',
      '--json',
      '--limit',
      '30',
      '--api',
      'false',
    ], repoRoot, sharedEnv);
    assert.strictEqual(planBuild.code, 0, 'github plan build exits 0');
    const planBuildPayload = JSON.parse(planBuild.stdout);
    assert.strictEqual(planBuildPayload.schemaVersion, 'github.plan-build.v1');
    assert.strictEqual(planBuildPayload.capability.key, 'plan.build');
    assert.strictEqual(planBuildPayload.policy.allowed, true);
    assert.strictEqual(planBuildPayload.targetCapability.key, 'pr.diff');
    assert.strictEqual(planBuildPayload.plan.schemaVersion, 'github.execution-plan.v1');
    assert.strictEqual(planBuildPayload.plan.steps[0].capabilityKey, 'pr.diff');
    assert.strictEqual(planBuildPayload.plan.steps[0].runtimeInput.number, '7');
    assert.strictEqual(planBuildPayload.plan.steps[0].runtimeInput.api, false);

    const planExecute = await runNode([
      'src/cli/liku.js',
      'github',
      'plan',
      'execute',
      'pr',
      'diff',
      '7',
      '--json',
      '--limit',
      '30',
      '--api',
      'false',
    ], repoRoot, sharedEnv);
    assert.strictEqual(planExecute.code, 0, 'github plan execute exits 0');
    const planExecutePayload = JSON.parse(planExecute.stdout);
    assert.strictEqual(planExecutePayload.schemaVersion, 'github.plan-execute.v1');
    assert.strictEqual(planExecutePayload.capability.key, 'plan.execute');
    assert.strictEqual(planExecutePayload.policy.allowed, true);
    assert.strictEqual(planExecutePayload.success, true);
    assert.strictEqual(planExecutePayload.targetCapability.key, 'pr.diff');
    assert.strictEqual(planExecutePayload.execution.stepsExecuted, 1);
    assert.strictEqual(planExecutePayload.execution.timedOut, false);
    assert.strictEqual(planExecutePayload.execution.terminalEvent, 'execution.completed');
    assert.ok(planExecutePayload.run.runId);
    assert.ok(planExecutePayload.eventLog.filePath);
    assert.ok(planExecutePayload.planArtifact.filePath);
    assert.ok(planExecutePayload.resultArtifact.filePath);
    assert.ok(fs.existsSync(planExecutePayload.eventLog.filePath));
    assert.ok(fs.existsSync(planExecutePayload.planArtifact.filePath));
    assert.ok(fs.existsSync(planExecutePayload.resultArtifact.filePath));

    const planReplay = await runNode([
      'src/cli/liku.js',
      'github',
      'plan',
      'execute',
      '--json',
      '--plan-file',
      planExecutePayload.planArtifact.filePath,
    ], repoRoot, sharedEnv);
    assert.strictEqual(planReplay.code, 0, 'github plan execute replay exits 0');
    const planReplayPayload = JSON.parse(planReplay.stdout);
    assert.strictEqual(planReplayPayload.schemaVersion, 'github.plan-execute.v1');
    assert.strictEqual(planReplayPayload.success, true);
    assert.strictEqual(planReplayPayload.execution.planSource, 'artifact-replay');
    assert.strictEqual(planReplayPayload.capability.key, 'plan.execute');
    assert.ok(planReplayPayload.run.runId);
    assert.ok(planReplayPayload.eventLog.filePath);
    assert.ok(fs.existsSync(planReplayPayload.eventLog.filePath));

    const resumePlanReport = buildGitHubExecutionPlan({
      source: 'cli',
      positionals: ['plan', 'build', 'issues', 'list'],
      runtimeOptions: { limit: 5, api: false },
    });
    const resumeRunId = 'github-run-cli-resume';
    const resumeToken = 'resume-token-cli';
    const resumePlanArtifact = writeGitHubPlanArtifact({
      source: 'cli',
      metadata: { mode: 'bounded-executor', orchestrationMode: 'bounded-evented', runId: resumeRunId },
      planReport: resumePlanReport,
    });
    appendGitHubPlanEvent({ artifactId: resumePlanArtifact.artifactId, runId: resumeRunId, sequence: 1, eventName: 'execution.started', source: 'cli', status: 'running' });
    appendGitHubPlanEvent({ artifactId: resumePlanArtifact.artifactId, runId: resumeRunId, sequence: 2, eventName: 'step.started', source: 'cli', status: 'running', step: { stepId: 'step-1', capabilityKey: 'issues.list' } });
    appendGitHubPlanEvent({ artifactId: resumePlanArtifact.artifactId, runId: resumeRunId, sequence: 3, eventName: 'guidance.requested', source: 'cli', status: 'blocked', step: { stepId: 'step-1', capabilityKey: 'issues.list' }, guidance: { guidanceId: 'github-guidance-cli', resumeToken } });
    const resumeGuidanceArtifact = writeGitHubPlanGuidanceArtifact({
      artifactId: resumePlanArtifact.artifactId,
      runId: resumeRunId,
      guidanceId: 'github-guidance-cli',
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
      planArtifact: resumePlanArtifact,
      execution: {
        planSource: 'runtime-build',
        status: 'needs-guidance',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        elapsedMs: 0,
        timedOut: false,
        terminal: false,
        stepsExecuted: 0,
      },
      blockedStepIndex: 0,
      stepResults: [],
    });
    const resumeAnswersPath = path.join(tempRoot, 'resume-answers.json');
    fs.writeFileSync(resumeAnswersPath, JSON.stringify({ state: 'all' }, null, 2));

    const planResume = await runNode([
      'src/cli/liku.js',
      'github',
      'plan',
      'resume',
      '--json',
      '--guidance-file',
      resumeGuidanceArtifact.filePath,
      '--resume-token',
      resumeToken,
      '--answers-file',
      resumeAnswersPath,
    ], repoRoot, sharedEnv);
    assert.strictEqual(planResume.code, 0, 'github plan resume exits 0');
    const planResumePayload = JSON.parse(planResume.stdout);
    assert.strictEqual(planResumePayload.schemaVersion, 'github.plan-resume.v1');
    assert.strictEqual(planResumePayload.capability.key, 'plan.resume');
    assert.strictEqual(planResumePayload.policy.allowed, true);
    assert.strictEqual(planResumePayload.success, true);
    assert.strictEqual(planResumePayload.run.runId, resumeRunId);
    assert.strictEqual(planResumePayload.execution.status, 'completed');
    assert.strictEqual(planResumePayload.stepResults[0].result.filters.state, 'all');
    assert.ok(planResumePayload.resultArtifact.filePath);
    assert.ok(fs.existsSync(planResumePayload.resultArtifact.filePath));
    assert.ok(planResumePayload.eventLog.filePath);
    assert.ok(fs.existsSync(planResumePayload.eventLog.filePath));

    const repoInspect = await runNode([
      'src/cli/liku.js',
      'github',
      'repo',
      'inspect',
      '--json',
      '--api',
      'false',
    ], repoRoot, sharedEnv);
    assert.strictEqual(repoInspect.code, 0, 'github repo inspect exits 0');
    const repoPayload = JSON.parse(repoInspect.stdout);
    assert.strictEqual(repoPayload.schemaVersion, 'github.repo-inspect.v1');
    assert.strictEqual(repoPayload.success, true);
    assert.strictEqual(repoPayload.featureFlagEnabled, true);
    assert.strictEqual(repoPayload.githubApi.attempted, false);
    assert.strictEqual(repoPayload.repoIdentity.normalizedRepoName, 'copilot-liku-cli');
    assert.strictEqual(repoPayload.remote.isGitHub, true);

    const issuesList = await runNode([
      'src/cli/liku.js',
      'github',
      'issues',
      'list',
      '--json',
      '--api',
      'false',
      '--state',
      'all',
      '--limit',
      '5',
    ], repoRoot, sharedEnv);
    assert.strictEqual(issuesList.code, 0, 'github issues list exits 0');
    const issuesPayload = JSON.parse(issuesList.stdout);
    assert.strictEqual(issuesPayload.schemaVersion, 'github.issues-list.v1');
    assert.strictEqual(issuesPayload.githubApi.attempted, false);
    assert.strictEqual(issuesPayload.filters.state, 'all');
    assert.strictEqual(issuesPayload.filters.limit, 5);
    assert.strictEqual(issuesPayload.capability.key, 'issues.list');
    assert.strictEqual(issuesPayload.policy.allowed, true);

    const issueInspect = await runNode([
      'src/cli/liku.js',
      'github',
      'issues',
      'inspect',
      '7',
      '--json',
      '--api',
      'false',
    ], repoRoot, sharedEnv);
    assert.strictEqual(issueInspect.code, 0, 'github issues inspect exits 0');
    const issuePayload = JSON.parse(issueInspect.stdout);
    assert.strictEqual(issuePayload.schemaVersion, 'github.issue-inspect.v1');
    assert.strictEqual(issuePayload.issueNumber, 7);
    assert.strictEqual(issuePayload.githubApi.attempted, false);

    const prList = await runNode([
      'src/cli/liku.js',
      'github',
      'pr',
      'list',
      '--json',
      '--api',
      'false',
      '--state',
      'all',
      '--limit',
      '4',
    ], repoRoot, sharedEnv);
    assert.strictEqual(prList.code, 0, 'github pr list exits 0');
    const prListPayload = JSON.parse(prList.stdout);
    assert.strictEqual(prListPayload.schemaVersion, 'github.pr-list.v1');
    assert.strictEqual(prListPayload.githubApi.attempted, false);
    assert.strictEqual(prListPayload.filters.state, 'all');
    assert.strictEqual(prListPayload.filters.limit, 4);

    const prDiff = await runNode([
      'src/cli/liku.js',
      'github',
      'pr',
      'diff',
      '7',
      '--json',
      '--api',
      'false',
      '--limit',
      '30',
    ], repoRoot, sharedEnv);
    assert.strictEqual(prDiff.code, 0, 'github pr diff exits 0');
    const prDiffPayload = JSON.parse(prDiff.stdout);
    assert.strictEqual(prDiffPayload.schemaVersion, 'github.pr-diff-summary.v1');
    assert.strictEqual(prDiffPayload.pullRequestNumber, 7);
    assert.strictEqual(prDiffPayload.githubApi.attempted, false);
    assert.strictEqual(prDiffPayload.filters.limit, 30);
    assert.strictEqual(prDiffPayload.capability.key, 'pr.diff');
    assert.strictEqual(prDiffPayload.policy.allowed, true);

    const prInspect = await runNode([
      'src/cli/liku.js',
      'github',
      'pr',
      'inspect',
      '7',
      '--json',
      '--api',
      'false',
    ], repoRoot, sharedEnv);
    assert.strictEqual(prInspect.code, 0, 'github pr inspect exits 0');
    const prPayload = JSON.parse(prInspect.stdout);
    assert.strictEqual(prPayload.schemaVersion, 'github.pr-inspect.v1');
    assert.strictEqual(prPayload.pullRequestNumber, 7);
    assert.strictEqual(prPayload.githubApi.attempted, false);

    const workflowRuns = await runNode([
      'src/cli/liku.js',
      'github',
      'workflow',
      'runs',
      '--json',
      '--api',
      'false',
      '--workflow',
      'ci.yml',
      '--limit',
      '3',
    ], repoRoot, sharedEnv);
    assert.strictEqual(workflowRuns.code, 0, 'github workflow runs exits 0');
    const workflowPayload = JSON.parse(workflowRuns.stdout);
    assert.strictEqual(workflowPayload.schemaVersion, 'github.workflow-runs.v1');
    assert.strictEqual(workflowPayload.githubApi.attempted, false);
    assert.strictEqual(workflowPayload.filters.workflow, 'ci.yml');
    assert.strictEqual(workflowPayload.filters.limit, 3);

    const workflowInspect = await runNode([
      'src/cli/liku.js',
      'github',
      'workflow',
      'inspect',
      '9001',
      '--json',
      '--api',
      'false',
    ], repoRoot, sharedEnv);
    assert.strictEqual(workflowInspect.code, 0, 'github workflow inspect exits 0');
    const workflowInspectPayload = JSON.parse(workflowInspect.stdout);
    assert.strictEqual(workflowInspectPayload.schemaVersion, 'github.workflow-inspect.v1');
    assert.strictEqual(workflowInspectPayload.runId, 9001);
    assert.strictEqual(workflowInspectPayload.githubApi.attempted, false);

    const releasesList = await runNode([
      'src/cli/liku.js',
      'github',
      'releases',
      'list',
      '--json',
      '--api',
      'false',
      '--limit',
      '5',
    ], repoRoot, sharedEnv);
    assert.strictEqual(releasesList.code, 0, 'github releases list exits 0');
    const releasesPayload = JSON.parse(releasesList.stdout);
    assert.strictEqual(releasesPayload.schemaVersion, 'github.releases-list.v1');
    assert.strictEqual(releasesPayload.githubApi.attempted, false);
    assert.strictEqual(releasesPayload.filters.limit, 5);

    const releaseInspect = await runNode([
      'src/cli/liku.js',
      'github',
      'releases',
      'inspect',
      'latest',
      '--json',
      '--api',
      'false',
    ], repoRoot, sharedEnv);
    assert.strictEqual(releaseInspect.code, 0, 'github releases inspect exits 0');
    const releaseInspectPayload = JSON.parse(releaseInspect.stdout);
    assert.strictEqual(releaseInspectPayload.schemaVersion, 'github.release-inspect.v1');
    assert.strictEqual(releaseInspectPayload.selector.kind, 'latest');
    assert.strictEqual(releaseInspectPayload.githubApi.attempted, false);

    console.log('PASS cli github command');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('FAIL cli github command');
  console.error(error.stack || error.message);
  process.exit(1);
});
