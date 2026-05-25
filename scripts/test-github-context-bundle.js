#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-github-context-bundle-'));
process.env.LIKU_HOME_OVERRIDE = path.join(tempRoot, '.liku');
process.env.LIKU_HOME_OLD_OVERRIDE = path.join(tempRoot, '.liku-cli-old');

const {
  buildGitHubContextBundle,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'context-bundle.js'));
const {
  readGitHubContextBundleArtifact,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'context-bundle-artifacts.js'));

let pass = 0;

async function test(name, fn) {
  await fn();
  pass += 1;
  console.log(`PASS ${name}`);
}

function buildRepoInspectReport() {
  return {
    success: true,
    schemaVersion: 'github.repo-inspect.v1',
    repoIdentity: {
      repoName: 'copilot-Liku-cli',
      normalizedRepoName: 'copilot-liku-cli',
      projectRoot: 'C:/dev/copilot-Liku-cli',
      gitRemote: 'https://github.com/TayDa64/copilot-Liku-cli.git',
    },
    remote: {
      raw: 'https://github.com/TayDa64/copilot-Liku-cli.git',
    },
    target: {
      raw: 'https://github.com/TayDa64/copilot-Liku-cli.git',
      isGitHub: true,
      slug: 'TayDa64/copilot-Liku-cli',
      owner: 'TayDa64',
      repo: 'copilot-Liku-cli',
      htmlUrl: 'https://github.com/TayDa64/copilot-Liku-cli',
      apiBaseUrl: 'https://api.github.com',
    },
    targetSource: 'git-remote',
    githubApi: {
      attempted: true,
      status: 200,
      repository: {
        fullName: 'TayDa64/copilot-Liku-cli',
        description: 'Authorization: Bearer ghp_1234567890abcdefghijklmnop',
        defaultBranch: 'main',
        language: 'JavaScript',
      },
    },
    warnings: [],
  };
}

(async () => {
  try {
    await test('buildGitHubContextBundle creates a reviewed PR bundle and redacts sensitive fields', async () => {
      const calls = [];
      const report = await buildGitHubContextBundle({
        source: 'cli',
        positionals: ['context', 'bundle', 'pr', '7'],
        runtimeOptions: { api: true },
        featureFlagEnabled: true,
        async executeGitHubCommand(request) {
          calls.push({
            area: request.area,
            action: request.action,
            positionals: request.positionals,
            options: request.options,
          });

          if (request.area === 'repo' && request.action === 'inspect') {
            return buildRepoInspectReport();
          }
          if (request.area === 'pr' && request.action === 'inspect') {
            return {
              success: true,
              schemaVersion: 'github.pr-inspect.v1',
              pullRequestNumber: 7,
              pullRequest: {
                number: 7,
                title: 'Add reviewed bundle support',
                state: 'open',
                body: 'This is a very detailed pull request body that should not persist verbatim.',
                comments: 3,
                labels: [{ name: 'github' }],
              },
              githubApi: { attempted: true, status: 200 },
              warnings: [],
            };
          }
          if (request.area === 'pr' && request.action === 'diff') {
            return {
              success: true,
              schemaVersion: 'github.pr-diff-summary.v1',
              pullRequestNumber: 7,
              filters: { limit: 5 },
              diffSummary: {
                fileCount: 1,
                totalAdditions: 2,
                totalDeletions: 1,
                directories: [{ path: 'src', count: 1 }],
              },
              files: [
                {
                  filename: 'src/main/github/context-bundle.js',
                  status: 'modified',
                  additions: 2,
                  deletions: 1,
                  patchPreview: '@@ -1 +1 @@\n-const before = true;\n+const after = true;',
                },
              ],
              githubApi: { attempted: true, status: 200 },
              warnings: ['Diff summary is limited to the first 5 changed files.'],
            };
          }

          throw new Error(`Unexpected nested capability: ${request.area}.${request.action}`);
        },
      });

      assert.strictEqual(report.success, true);
      assert.strictEqual(report.schemaVersion, 'github.context-bundle.v1');
      assert.strictEqual(report.target.kind, 'pr');
      assert.strictEqual(report.target.selector, '7');
      assert.strictEqual(report.review.exportKind, 'github-context-bundle');
      assert.strictEqual(report.review.reviewRequired, true);
      assert.ok(report.review.redactionCount >= 3);
      assert.ok(report.contents.repository.githubApi.repository.description.includes('[redacted token]'));
      assert.ok(report.contents.pullRequest.pullRequest.body.includes('[redacted issue body'));
      assert.ok(report.contents.pullRequestDiff.files[0].patchPreview.includes('[redacted diff'));
      assert.ok(report.artifact.filePath);
      assert.ok(fs.existsSync(report.artifact.filePath));
      assert.deepStrictEqual(calls.map((entry) => `${entry.area}.${entry.action}`), ['repo.inspect', 'pr.inspect', 'pr.diff']);

      const saved = readGitHubContextBundleArtifact({ filePath: report.artifact.filePath });
      assert.strictEqual(saved.bundleId, report.bundleId);
      assert.strictEqual(saved.target.kind, 'pr');
      assert.strictEqual(saved.review.exportKind, 'github-context-bundle');
      assert.ok(saved.contents.pullRequest.pullRequest.body.includes('[redacted issue body'));
    });

    await test('buildGitHubContextBundle creates a reviewed issue bundle', async () => {
      const calls = [];
      const report = await buildGitHubContextBundle({
        source: 'slash',
        positionals: ['context', 'bundle', 'issue', '321'],
        runtimeOptions: { api: true },
        featureFlagEnabled: true,
        async executeGitHubCommand(request) {
          calls.push(`${request.area}.${request.action}`);
          if (request.area === 'repo' && request.action === 'inspect') {
            return buildRepoInspectReport();
          }
          if (request.area === 'issues' && request.action === 'inspect') {
            return {
              success: true,
              schemaVersion: 'github.issue-inspect.v1',
              issueNumber: 321,
              issue: {
                number: 321,
                title: 'Reviewed context bundle should sanitize issue bodies',
                state: 'open',
                body: 'This issue body contains details that should not persist verbatim.',
                comments: 4,
                labels: [{ name: 'phase-5' }],
              },
              githubApi: { attempted: true, status: 200 },
              warnings: [],
            };
          }
          throw new Error(`Unexpected nested capability: ${request.area}.${request.action}`);
        },
      });

      assert.strictEqual(report.success, true);
      assert.strictEqual(report.target.kind, 'issue');
      assert.strictEqual(report.target.selector, '321');
      assert.strictEqual(report.summary.issueState, 'open');
      assert.ok(report.contents.issue.issue.body.includes('[redacted issue body'));
      assert.ok(fs.existsSync(report.artifact.filePath));
      assert.deepStrictEqual(calls, ['repo.inspect', 'issues.inspect']);
    });

    await test('buildGitHubContextBundle creates a repo bundle and honors explicit output paths', async () => {
      const calls = [];
      const explicitPath = path.join(tempRoot, 'reviewed-repo-bundle.json');
      const report = await buildGitHubContextBundle({
        source: 'cli',
        positionals: ['context', 'bundle', 'repo'],
        runtimeOptions: { api: true, limit: 3, 'out-file': explicitPath },
        featureFlagEnabled: true,
        async executeGitHubCommand(request) {
          calls.push({ area: request.area, action: request.action, limit: request.options?.limit ?? null });
          if (request.area === 'repo' && request.action === 'inspect') {
            return buildRepoInspectReport();
          }
          if (request.area === 'issues' && request.action === 'list') {
            return {
              success: true,
              schemaVersion: 'github.issues-list.v1',
              filters: { state: 'open', limit: 3, labels: [] },
              issues: [
                { number: 11, title: 'First issue', state: 'open' },
                { number: 12, title: 'Second issue', state: 'open' },
              ],
              githubApi: { attempted: true, status: 200 },
              warnings: [],
            };
          }
          if (request.area === 'pr' && request.action === 'list') {
            return {
              success: true,
              schemaVersion: 'github.pr-list.v1',
              filters: { state: 'open', limit: 3, base: null, head: null },
              pullRequests: [
                { number: 21, title: 'First PR', state: 'open' },
              ],
              githubApi: { attempted: true, status: 200 },
              warnings: [],
            };
          }
          if (request.area === 'workflow' && request.action === 'runs') {
            return {
              success: true,
              schemaVersion: 'github.workflow-runs.v1',
              filters: { limit: 3, branch: null, status: null, event: null, workflow: null },
              workflowRuns: [
                { id: 31, name: 'CI', status: 'completed', conclusion: 'success' },
                { id: 32, name: 'Release', status: 'queued', conclusion: null },
              ],
              githubApi: { attempted: true, status: 200, totalCount: 2 },
              warnings: [],
            };
          }
          throw new Error(`Unexpected nested capability: ${request.area}.${request.action}`);
        },
      });

      assert.strictEqual(report.success, true);
      assert.strictEqual(report.target.kind, 'repo');
      assert.strictEqual(report.target.selector, null);
      assert.strictEqual(report.summary.issueCount, 2);
      assert.strictEqual(report.summary.pullRequestCount, 1);
      assert.strictEqual(report.summary.workflowRunCount, 2);
      assert.strictEqual(report.artifact.filePath, explicitPath);
      assert.ok(fs.existsSync(explicitPath));
      assert.deepStrictEqual(calls, [
        { area: 'repo', action: 'inspect', limit: null },
        { area: 'issues', action: 'list', limit: 3 },
        { area: 'pr', action: 'list', limit: 3 },
        { area: 'workflow', action: 'runs', limit: 3 },
      ]);
    });

    await test('buildGitHubContextBundle validates required selectors', async () => {
      const report = await buildGitHubContextBundle({
        source: 'cli',
        positionals: ['context', 'bundle', 'pr'],
        runtimeOptions: {},
      });

      assert.strictEqual(report.success, false);
      assert.strictEqual(report.error, 'USAGE');
      assert.ok(report.message.includes('Usage: liku github context bundle pr <number>'));
    });

    console.log(`PASS github context bundle (${pass} assertions)`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('FAIL github context bundle');
  console.error(error.stack || error.message);
  process.exit(1);
});
