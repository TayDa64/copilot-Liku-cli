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

    const help = await runNode(['src/cli/liku.js', '--help'], repoRoot, sharedEnv);
    assert.strictEqual(help.code, 0, 'top-level help exits 0');
    assert(help.stdout.includes('github'), 'top-level help lists the github command');
    assert(help.stdout.includes('liku github releases list --limit 5'), 'top-level help shows release listing example');

    const githubHelp = await runNode(['src/cli/liku.js', 'github', 'help'], repoRoot, sharedEnv);
    assert.strictEqual(githubHelp.code, 0, 'github help exits 0');
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
