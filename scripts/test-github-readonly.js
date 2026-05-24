#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const { parseGitHubRemote } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'remote.js'));
const { getEnvGitHubToken, maskToken } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'client.js'));
const { resolveGitHubAuthStatus } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'auth-status.js'));
const { inspectGitHubIssue } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'issue-inspect.js'));
const { inspectGitHubRepository } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'repo-inspect.js'));
const { listGitHubIssues } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'issues-list.js'));
const { inspectGitHubPullRequestDiff } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'pr-diff-summary.js'));
const { listGitHubPullRequests } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'pr-list.js'));
const { inspectGitHubPullRequest } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'pr-inspect.js'));
const { inspectGitHubRelease } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'release-inspect.js'));
const { listGitHubReleases } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'releases-list.js'));
const { inspectGitHubWorkflowRun } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'workflow-inspect.js'));
const { listGitHubWorkflowRuns } = require(path.join(__dirname, '..', 'src', 'main', 'github', 'workflow-runs.js'));

let pass = 0;

async function test(name, fn) {
  await fn();
  pass += 1;
  console.log(`PASS ${name}`);
}

function createHeaders(entries = {}) {
  const normalized = {};
  Object.keys(entries).forEach((key) => {
    normalized[String(key).toLowerCase()] = entries[key];
  });
  return {
    get(name) {
      return normalized[String(name || '').toLowerCase()] || null;
    },
  };
}

(async () => {
  await test('parseGitHubRemote supports SSH and HTTPS GitHub remotes', async () => {
    const ssh = parseGitHubRemote('git@github.com:TayDa64/copilot-Liku-cli.git');
    const https = parseGitHubRemote('https://github.com/TayDa64/copilot-Liku-cli.git');

    assert.strictEqual(ssh.isGitHub, true);
    assert.strictEqual(ssh.slug, 'TayDa64/copilot-Liku-cli');
    assert.strictEqual(ssh.protocol, 'ssh');
    assert.strictEqual(https.isGitHub, true);
    assert.strictEqual(https.slug, 'TayDa64/copilot-Liku-cli');
    assert.strictEqual(https.protocol, 'https');
  });

  await test('getEnvGitHubToken prefers GH_TOKEN and maskToken redacts output', async () => {
    const tokenInfo = getEnvGitHubToken({
      GH_TOKEN: 'ghp_test_1234567890',
      GITHUB_TOKEN: 'github_token_should_not_win',
    });

    assert.strictEqual(tokenInfo.source, 'GH_TOKEN');
    assert.strictEqual(tokenInfo.token, 'ghp_test_1234567890');
    assert.strictEqual(maskToken(tokenInfo.token), 'ghp_…7890');
  });

  await test('resolveGitHubAuthStatus reports no-token state without failing', async () => {
    let loadCalled = 0;
    const report = await resolveGitHubAuthStatus({
      env: {},
      featureFlagEnabled: true,
      probe: false,
      aiService: {
        loadCopilotTokenIfNeeded() {
          loadCalled += 1;
          return false;
        },
        getStatus() {
          return {
            provider: 'copilot',
            model: 'gpt-4o',
            modelName: 'GPT-4o',
            hasCopilotKey: false,
            availableProviders: ['copilot', 'openai'],
          };
        },
      },
      fsModule: {
        existsSync() {
          return false;
        },
        readFileSync() {
          throw new Error('should not read missing file');
        },
      },
      copilotTokenFile: 'C:/tmp/missing-copilot-token.json',
    });

    assert.strictEqual(loadCalled, 1);
    assert.strictEqual(report.schemaVersion, 'github.auth-status.v1');
    assert.strictEqual(report.success, true);
    assert.strictEqual(report.featureFlagEnabled, true);
    assert.strictEqual(report.githubApi.tokenPresent, false);
    assert.strictEqual(report.githubApi.probeAttempted, false);
    assert.strictEqual(report.copilot.tokenFile.exists, false);
  });

  await test('resolveGitHubAuthStatus probes the GitHub API when a token is present', async () => {
    const report = await resolveGitHubAuthStatus({
      env: {
        GH_TOKEN: 'ghp_probe_1234567890',
      },
      probe: true,
      aiService: {
        loadCopilotTokenIfNeeded() {
          return true;
        },
        getStatus() {
          return {
            provider: 'copilot',
            model: 'gpt-4o',
            modelName: 'GPT-4o',
            hasCopilotKey: true,
            availableProviders: ['copilot'],
          };
        },
      },
      fsModule: {
        existsSync() {
          return true;
        },
        readFileSync() {
          return JSON.stringify({ saved_at: '2026-05-23T00:00:00.000Z' });
        },
      },
      copilotTokenFile: 'C:/tmp/copilot-token.json',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: 'https://api.github.com/user',
        headers: createHeaders({
          'x-oauth-scopes': 'repo, read:org',
          'x-ratelimit-limit': '60',
          'x-ratelimit-remaining': '59',
          'x-ratelimit-reset': '1767225600',
        }),
        async text() {
          return JSON.stringify({
            login: 'octocat',
            id: 1,
            name: 'The Octocat',
            type: 'User',
            html_url: 'https://github.com/octocat',
          });
        },
      }),
    });

    assert.strictEqual(report.githubApi.tokenPresent, true);
    assert.strictEqual(report.githubApi.probeAttempted, true);
    assert.strictEqual(report.githubApi.authenticated, true);
    assert.strictEqual(report.githubApi.viewer.login, 'octocat');
    assert.deepStrictEqual(report.githubApi.scopes, ['repo', 'read:org']);
    assert.strictEqual(report.copilot.tokenFile.savedAt, '2026-05-23T00:00:00.000Z');
  });

  await test('inspectGitHubRepository returns local-only details when no remote exists', async () => {
    const report = await inspectGitHubRepository({
      api: true,
      resolveProjectIdentity() {
        return {
          repoName: 'copilot-liku-cli',
          normalizedRepoName: 'copilot-liku-cli',
          projectRoot: 'C:/dev/copilot-Liku-cli',
          gitRemote: null,
        };
      },
    });

    assert.strictEqual(report.success, true);
    assert.strictEqual(report.remote.raw, null);
    assert.strictEqual(report.githubApi.attempted, false);
    assert.ok(report.warnings.some((entry) => /No git remote detected/i.test(entry)));
  });

  await test('inspectGitHubRepository summarizes GitHub repo metadata through the API', async () => {
    const report = await inspectGitHubRepository({
      env: { GITHUB_TOKEN: 'github_pat_1234567890' },
      api: true,
      resolveProjectIdentity() {
        return {
          repoName: 'copilot-liku-cli',
          normalizedRepoName: 'copilot-liku-cli',
          projectRoot: 'C:/dev/copilot-Liku-cli',
          gitRemote: 'git@github.com:TayDa64/copilot-Liku-cli.git',
        };
      },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: 'https://api.github.com/repos/TayDa64/copilot-Liku-cli',
        headers: createHeaders({
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '4999',
          'x-ratelimit-reset': '1767225600',
        }),
        async text() {
          return JSON.stringify({
            id: 42,
            name: 'copilot-Liku-cli',
            full_name: 'TayDa64/copilot-Liku-cli',
            private: false,
            visibility: 'public',
            default_branch: 'main',
            archived: false,
            fork: false,
            language: 'JavaScript',
            stargazers_count: 7,
            forks_count: 2,
            watchers_count: 7,
            open_issues_count: 3,
            html_url: 'https://github.com/TayDa64/copilot-Liku-cli',
            clone_url: 'https://github.com/TayDa64/copilot-Liku-cli.git',
            ssh_url: 'git@github.com:TayDa64/copilot-Liku-cli.git',
            topics: ['copilot', 'electron'],
            permissions: { admin: false, push: true, pull: true },
            owner: { login: 'TayDa64', type: 'User', html_url: 'https://github.com/TayDa64' },
          });
        },
      }),
    });

    assert.strictEqual(report.schemaVersion, 'github.repo-inspect.v1');
    assert.strictEqual(report.remote.slug, 'TayDa64/copilot-Liku-cli');
    assert.strictEqual(report.githubApi.attempted, true);
    assert.strictEqual(report.githubApi.repository.fullName, 'TayDa64/copilot-Liku-cli');
    assert.strictEqual(report.githubApi.repository.defaultBranch, 'main');
    assert.strictEqual(report.githubApi.repository.permissions.push, true);
  });

  await test('listGitHubIssues filters out pull requests and preserves issue metadata', async () => {
    const report = await listGitHubIssues({
      env: { GITHUB_TOKEN: 'github_pat_1234567890' },
      state: 'all',
      limit: 5,
      labels: 'bug,needs-triage',
      resolveProjectIdentity() {
        return {
          repoName: 'copilot-liku-cli',
          normalizedRepoName: 'copilot-liku-cli',
          projectRoot: 'C:/dev/copilot-Liku-cli',
          gitRemote: 'git@github.com:TayDa64/copilot-Liku-cli.git',
        };
      },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: 'https://api.github.com/repos/TayDa64/copilot-Liku-cli/issues?state=all&per_page=5&labels=bug%2Cneeds-triage',
        headers: createHeaders({
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '4998',
          'x-ratelimit-reset': '1767225600',
        }),
        async text() {
          return JSON.stringify([
            {
              number: 7,
              title: 'Document slash command routing',
              state: 'open',
              comments: 2,
              created_at: '2026-05-22T12:00:00Z',
              updated_at: '2026-05-23T01:23:45Z',
              html_url: 'https://github.com/TayDa64/copilot-Liku-cli/issues/7',
              user: { login: 'octocat', type: 'User', html_url: 'https://github.com/octocat' },
              labels: [{ name: 'bug', color: 'd73a4a' }],
              assignees: [{ login: 'TayDa64', type: 'User' }],
            },
            {
              number: 8,
              title: 'This is actually a pull request and should be filtered',
              state: 'open',
              pull_request: { url: 'https://api.github.com/repos/TayDa64/copilot-Liku-cli/pulls/8' },
            },
          ]);
        },
      }),
    });

    assert.strictEqual(report.schemaVersion, 'github.issues-list.v1');
    assert.strictEqual(report.githubApi.attempted, true);
    assert.strictEqual(report.githubApi.issueCount, 1);
    assert.strictEqual(report.issues.length, 1);
    assert.strictEqual(report.issues[0].number, 7);
    assert.strictEqual(report.filters.state, 'all');
    assert.deepStrictEqual(report.filters.labels, ['bug', 'needs-triage']);
  });

  await test('inspectGitHubIssue summarizes one issue and flags pull-request overlaps', async () => {
    const report = await inspectGitHubIssue({
      env: { GITHUB_TOKEN: 'github_pat_1234567890' },
      number: 7,
      resolveProjectIdentity() {
        return {
          repoName: 'copilot-liku-cli',
          normalizedRepoName: 'copilot-liku-cli',
          projectRoot: 'C:/dev/copilot-Liku-cli',
          gitRemote: 'git@github.com:TayDa64/copilot-Liku-cli.git',
        };
      },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: 'https://api.github.com/repos/TayDa64/copilot-Liku-cli/issues/7',
        headers: createHeaders({
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '4998',
          'x-ratelimit-reset': '1767225600',
        }),
        async text() {
          return JSON.stringify({
            number: 7,
            title: 'Document slash command routing',
            state: 'open',
            state_reason: null,
            comments: 2,
            created_at: '2026-05-22T12:00:00Z',
            updated_at: '2026-05-23T01:23:45Z',
            html_url: 'https://github.com/TayDa64/copilot-Liku-cli/issues/7',
            body: 'We should route slash commands through typed adapters.',
            author_association: 'OWNER',
            pull_request: {
              url: 'https://api.github.com/repos/TayDa64/copilot-Liku-cli/pulls/7',
              html_url: 'https://github.com/TayDa64/copilot-Liku-cli/pull/7',
            },
            user: { login: 'octocat', type: 'User', html_url: 'https://github.com/octocat' },
            labels: [{ name: 'docs', color: '0e8a16' }],
          });
        },
      }),
    });

    assert.strictEqual(report.schemaVersion, 'github.issue-inspect.v1');
    assert.strictEqual(report.githubApi.attempted, true);
    assert.strictEqual(report.issue.number, 7);
    assert.strictEqual(report.issue.isPullRequest, true);
    assert.ok(report.warnings.some((entry) => /pull request/i.test(entry)));
  });

  await test('inspectGitHubPullRequest summarizes pull request details', async () => {
    const report = await inspectGitHubPullRequest({
      env: { GITHUB_TOKEN: 'github_pat_1234567890' },
      number: 42,
      resolveProjectIdentity() {
        return {
          repoName: 'copilot-liku-cli',
          normalizedRepoName: 'copilot-liku-cli',
          projectRoot: 'C:/dev/copilot-Liku-cli',
          gitRemote: 'git@github.com:TayDa64/copilot-Liku-cli.git',
        };
      },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: 'https://api.github.com/repos/TayDa64/copilot-Liku-cli/pulls/42',
        headers: createHeaders({
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '4998',
          'x-ratelimit-reset': '1767225600',
        }),
        async text() {
          return JSON.stringify({
            number: 42,
            title: 'Add read-only GitHub workflow inspection',
            state: 'open',
            draft: false,
            merged: false,
            mergeable: true,
            mergeable_state: 'clean',
            html_url: 'https://github.com/TayDa64/copilot-Liku-cli/pull/42',
            created_at: '2026-05-22T12:00:00Z',
            updated_at: '2026-05-23T01:23:45Z',
            additions: 120,
            deletions: 8,
            changed_files: 6,
            commits: 3,
            comments: 1,
            review_comments: 2,
            user: { login: 'octocat', type: 'User', html_url: 'https://github.com/octocat' },
            head: { ref: 'feature/github-phase2', sha: 'abc123', repo: { full_name: 'TayDa64/copilot-Liku-cli' } },
            base: { ref: 'main', sha: 'def456', repo: { full_name: 'TayDa64/copilot-Liku-cli' } },
            labels: [{ name: 'enhancement', color: '84b6eb' }],
            requested_reviewers: [{ login: 'TayDa64', type: 'User' }],
          });
        },
      }),
    });

    assert.strictEqual(report.schemaVersion, 'github.pr-inspect.v1');
    assert.strictEqual(report.githubApi.attempted, true);
    assert.strictEqual(report.pullRequest.number, 42);
    assert.strictEqual(report.pullRequest.mergeable, true);
    assert.strictEqual(report.pullRequest.head.ref, 'feature/github-phase2');
    assert.strictEqual(report.pullRequest.base.ref, 'main');
    assert.strictEqual(report.pullRequest.labels[0].name, 'enhancement');
  });

  await test('listGitHubPullRequests summarizes pull request collections and filters', async () => {
    const report = await listGitHubPullRequests({
      env: { GITHUB_TOKEN: 'github_pat_1234567890' },
      state: 'all',
      limit: 4,
      base: 'main',
      head: 'TayDa64:feature/github-phase2',
      resolveProjectIdentity() {
        return {
          repoName: 'copilot-liku-cli',
          normalizedRepoName: 'copilot-liku-cli',
          projectRoot: 'C:/dev/copilot-Liku-cli',
          gitRemote: 'git@github.com:TayDa64/copilot-Liku-cli.git',
        };
      },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: 'https://api.github.com/repos/TayDa64/copilot-Liku-cli/pulls?state=all&per_page=4&base=main&head=TayDa64%3Afeature%2Fgithub-phase2',
        headers: createHeaders({
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '4998',
          'x-ratelimit-reset': '1767225600',
        }),
        async text() {
          return JSON.stringify([
            {
              number: 42,
              title: 'Add read-only GitHub workflow inspection',
              state: 'open',
              draft: false,
              merged: false,
              mergeable: true,
              mergeable_state: 'clean',
              html_url: 'https://github.com/TayDa64/copilot-Liku-cli/pull/42',
              updated_at: '2026-05-23T01:23:45Z',
              user: { login: 'octocat', type: 'User', html_url: 'https://github.com/octocat' },
              head: { ref: 'feature/github-phase2', sha: 'abc123', repo: { full_name: 'TayDa64/copilot-Liku-cli' } },
              base: { ref: 'main', sha: 'def456', repo: { full_name: 'TayDa64/copilot-Liku-cli' } },
            },
          ]);
        },
      }),
    });

    assert.strictEqual(report.schemaVersion, 'github.pr-list.v1');
    assert.strictEqual(report.githubApi.attempted, true);
    assert.strictEqual(report.githubApi.pullRequestCount, 1);
    assert.strictEqual(report.pullRequests.length, 1);
    assert.strictEqual(report.pullRequests[0].number, 42);
    assert.strictEqual(report.filters.state, 'all');
    assert.strictEqual(report.filters.base, 'main');
  });

  await test('inspectGitHubPullRequestDiff summarizes changed files and directories', async () => {
    const report = await inspectGitHubPullRequestDiff({
      env: { GITHUB_TOKEN: 'github_pat_1234567890' },
      number: 42,
      limit: 3,
      resolveProjectIdentity() {
        return {
          repoName: 'copilot-liku-cli',
          normalizedRepoName: 'copilot-liku-cli',
          projectRoot: 'C:/dev/copilot-Liku-cli',
          gitRemote: 'git@github.com:TayDa64/copilot-Liku-cli.git',
        };
      },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: 'https://api.github.com/repos/TayDa64/copilot-Liku-cli/pulls/42/files?per_page=3',
        headers: createHeaders({
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '4998',
          'x-ratelimit-reset': '1767225600',
        }),
        async text() {
          return JSON.stringify([
            {
              filename: 'src/cli/commands/github.js',
              status: 'modified',
              additions: 20,
              deletions: 3,
              changes: 23,
              blob_url: 'https://github.com/TayDa64/copilot-Liku-cli/blob/main/src/cli/commands/github.js',
              patch: '@@ -1,3 +1,20 @@',
            },
            {
              filename: 'src/main/github/pr-diff-summary.js',
              status: 'added',
              additions: 120,
              deletions: 0,
              changes: 120,
              blob_url: 'https://github.com/TayDa64/copilot-Liku-cli/blob/main/src/main/github/pr-diff-summary.js',
            },
          ]);
        },
      }),
    });

    assert.strictEqual(report.schemaVersion, 'github.pr-diff-summary.v1');
    assert.strictEqual(report.githubApi.attempted, true);
    assert.strictEqual(report.files.length, 2);
    assert.strictEqual(report.diffSummary.fileCount, 2);
    assert.strictEqual(report.diffSummary.totalAdditions, 140);
    assert.ok(report.diffSummary.directories.some((entry) => entry.path === 'src'));
  });

  await test('listGitHubWorkflowRuns summarizes workflow runs and respects filters', async () => {
    const report = await listGitHubWorkflowRuns({
      env: { GITHUB_TOKEN: 'github_pat_1234567890' },
      workflow: 'ci.yml',
      branch: 'main',
      status: 'success',
      event: 'push',
      limit: 3,
      resolveProjectIdentity() {
        return {
          repoName: 'copilot-liku-cli',
          normalizedRepoName: 'copilot-liku-cli',
          projectRoot: 'C:/dev/copilot-Liku-cli',
          gitRemote: 'git@github.com:TayDa64/copilot-Liku-cli.git',
        };
      },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: 'https://api.github.com/repos/TayDa64/copilot-Liku-cli/actions/workflows/ci.yml/runs?per_page=3&branch=main&status=success&event=push',
        headers: createHeaders({
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '4998',
          'x-ratelimit-reset': '1767225600',
        }),
        async text() {
          return JSON.stringify({
            total_count: 1,
            workflow_runs: [{
              id: 9001,
              name: 'CI',
              display_title: 'CI for github phase 2',
              event: 'push',
              status: 'completed',
              conclusion: 'success',
              workflow_id: 77,
              run_number: 101,
              run_attempt: 1,
              head_branch: 'main',
              head_sha: 'abc123',
              html_url: 'https://github.com/TayDa64/copilot-Liku-cli/actions/runs/9001',
              created_at: '2026-05-22T12:00:00Z',
              updated_at: '2026-05-23T01:23:45Z',
              actor: { login: 'octocat', type: 'User', html_url: 'https://github.com/octocat' },
            }],
          });
        },
      }),
    });

    assert.strictEqual(report.schemaVersion, 'github.workflow-runs.v1');
    assert.strictEqual(report.githubApi.attempted, true);
    assert.strictEqual(report.githubApi.totalCount, 1);
    assert.strictEqual(report.workflowRuns.length, 1);
    assert.strictEqual(report.workflowRuns[0].workflowId, 77);
    assert.strictEqual(report.filters.workflow, 'ci.yml');
    assert.strictEqual(report.filters.branch, 'main');
  });

  await test('inspectGitHubWorkflowRun summarizes workflow run details', async () => {
    const report = await inspectGitHubWorkflowRun({
      env: { GITHUB_TOKEN: 'github_pat_1234567890' },
      runId: 9001,
      resolveProjectIdentity() {
        return {
          repoName: 'copilot-liku-cli',
          normalizedRepoName: 'copilot-liku-cli',
          projectRoot: 'C:/dev/copilot-Liku-cli',
          gitRemote: 'git@github.com:TayDa64/copilot-Liku-cli.git',
        };
      },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: 'https://api.github.com/repos/TayDa64/copilot-Liku-cli/actions/runs/9001',
        headers: createHeaders({
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '4998',
          'x-ratelimit-reset': '1767225600',
        }),
        async text() {
          return JSON.stringify({
            id: 9001,
            name: 'CI',
            display_title: 'CI for github phase 2',
            event: 'push',
            status: 'completed',
            conclusion: 'success',
            workflow_id: 77,
            run_number: 101,
            run_attempt: 1,
            head_branch: 'main',
            head_sha: 'abc123',
            html_url: 'https://github.com/TayDa64/copilot-Liku-cli/actions/runs/9001',
            run_started_at: '2026-05-23T01:00:00Z',
            updated_at: '2026-05-23T01:23:45Z',
            path: '.github/workflows/ci.yml',
            jobs_url: 'https://api.github.com/repos/TayDa64/copilot-Liku-cli/actions/runs/9001/jobs',
            logs_url: 'https://api.github.com/repos/TayDa64/copilot-Liku-cli/actions/runs/9001/logs',
            actor: { login: 'octocat', type: 'User', html_url: 'https://github.com/octocat' },
            head_commit: {
              id: 'abc123',
              message: 'Add workflow inspection command',
              timestamp: '2026-05-23T00:55:00Z',
              author: { name: 'The Octocat', email: 'octo@example.com' },
            },
          });
        },
      }),
    });

    assert.strictEqual(report.schemaVersion, 'github.workflow-inspect.v1');
    assert.strictEqual(report.githubApi.attempted, true);
    assert.strictEqual(report.workflowRun.id, 9001);
    assert.strictEqual(report.workflowRun.workflowId, 77);
    assert.strictEqual(report.workflowRun.headCommit.message, 'Add workflow inspection command');
  });

  await test('listGitHubReleases summarizes release metadata', async () => {
    const report = await listGitHubReleases({
      env: { GITHUB_TOKEN: 'github_pat_1234567890' },
      limit: 5,
      resolveProjectIdentity() {
        return {
          repoName: 'copilot-liku-cli',
          normalizedRepoName: 'copilot-liku-cli',
          projectRoot: 'C:/dev/copilot-Liku-cli',
          gitRemote: 'git@github.com:TayDa64/copilot-Liku-cli.git',
        };
      },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: 'https://api.github.com/repos/TayDa64/copilot-Liku-cli/releases?per_page=5',
        headers: createHeaders({
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '4998',
          'x-ratelimit-reset': '1767225600',
        }),
        async text() {
          return JSON.stringify([
            {
              id: 501,
              tag_name: 'v0.0.16',
              name: 'v0.0.16',
              draft: false,
              prerelease: false,
              created_at: '2026-05-22T12:00:00Z',
              published_at: '2026-05-23T01:23:45Z',
              html_url: 'https://github.com/TayDa64/copilot-Liku-cli/releases/tag/v0.0.16',
              target_commitish: 'main',
              author: { login: 'octocat', type: 'User', html_url: 'https://github.com/octocat' },
              assets: [{ id: 1, name: 'liku.tgz', size: 1024, download_count: 12, content_type: 'application/gzip' }],
            },
          ]);
        },
      }),
    });

    assert.strictEqual(report.schemaVersion, 'github.releases-list.v1');
    assert.strictEqual(report.githubApi.attempted, true);
    assert.strictEqual(report.githubApi.releaseCount, 1);
    assert.strictEqual(report.releases[0].tagName, 'v0.0.16');
    assert.strictEqual(report.releases[0].assetCount, 1);
  });

  await test('inspectGitHubRelease supports latest/tag/id selectors', async () => {
    const latestReport = await inspectGitHubRelease({
      env: { GITHUB_TOKEN: 'github_pat_1234567890' },
      selector: 'latest',
      resolveProjectIdentity() {
        return {
          repoName: 'copilot-liku-cli',
          normalizedRepoName: 'copilot-liku-cli',
          projectRoot: 'C:/dev/copilot-Liku-cli',
          gitRemote: 'git@github.com:TayDa64/copilot-Liku-cli.git',
        };
      },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: 'https://api.github.com/repos/TayDa64/copilot-Liku-cli/releases/latest',
        headers: createHeaders({
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '4998',
          'x-ratelimit-reset': '1767225600',
        }),
        async text() {
          return JSON.stringify({
            id: 501,
            tag_name: 'v0.0.16',
            name: 'v0.0.16',
            draft: false,
            prerelease: false,
            created_at: '2026-05-22T12:00:00Z',
            published_at: '2026-05-23T01:23:45Z',
            html_url: 'https://github.com/TayDa64/copilot-Liku-cli/releases/tag/v0.0.16',
            target_commitish: 'main',
            author: { login: 'octocat', type: 'User', html_url: 'https://github.com/octocat' },
            assets: [],
          });
        },
      }),
    });

    assert.strictEqual(latestReport.schemaVersion, 'github.release-inspect.v1');
    assert.strictEqual(latestReport.githubApi.attempted, true);
    assert.strictEqual(latestReport.release.tagName, 'v0.0.16');
    assert.strictEqual(latestReport.selector.kind, 'latest');
  });

  console.log(`PASS github readonly (${pass} assertions)`);
})().catch((error) => {
  console.error('FAIL github readonly');
  console.error(error.stack || error.message);
  process.exit(1);
});
