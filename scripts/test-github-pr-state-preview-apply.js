#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-github-pr-state-'));
process.env.LIKU_HOME_OVERRIDE = path.join(tempRoot, '.liku');
process.env.LIKU_HOME_OLD_OVERRIDE = path.join(tempRoot, '.liku-cli-old');

const {
  createGitHubCommandExecutor,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'command-executor.js'));
const {
  draftGitHubPullRequestClose,
  draftGitHubPullRequestReopen,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'pr-state-draft.js'));
const {
  applyGitHubWritePreview,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'issue-comment-apply.js'));
const {
  readGitHubWriteApplyResultArtifact,
  readGitHubWriteApprovalArtifact,
  readGitHubWriteEventLog,
  readGitHubWritePreviewArtifact,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'write-artifacts.js'));

let pass = 0;

async function test(name, fn) {
  await fn();
  pass += 1;
  console.log(`PASS ${name}`);
}

function createHeaders(values = {}) {
  return {
    get(name) {
      return values[String(name || '').toLowerCase()] || values[name] || null;
    },
  };
}

function createJsonResponse(status, payload, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: 'https://api.github.com/repos/example/project/pulls/7',
    headers: createHeaders(headers),
    async text() {
      return JSON.stringify(payload);
    },
  };
}

(async () => {
  try {
    await test('draft preview writes reviewed artifacts for pull request close previews', async () => {
      const executor = createGitHubCommandExecutor({
        env: {
          GH_TOKEN: 'github_pat_test_pr_state_preview_apply_1234567890',
        },
        cwd: path.join(__dirname, '..'),
      });

      const report = await executor.execute({
        source: 'cli',
        area: 'pr',
        action: 'close',
        positionals: ['pr', 'close', 'draft', '7'],
        options: {
          slug: 'example/project',
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

      assert.strictEqual(report.success, true);
      assert.strictEqual(report.schemaVersion, 'github.pr-close-draft.v1');
      assert.strictEqual(report.capability.key, 'pr.close.draft');
      assert.strictEqual(report.policy.allowed, true);
      assert.strictEqual(report.policy.state, 'preview-allowed');
      assert.strictEqual(report.pullRequestNumber, 7);
      assert.strictEqual(report.draft.stateAction, 'close');
      assert.strictEqual(report.draft.desiredState, 'closed');
      assert.ok(report.previewId);
      assert.ok(report.review.reviewRequired);
      assert.ok(report.approval.applyToken);
      assert.ok(fs.existsSync(report.previewArtifact.filePath));
      assert.ok(fs.existsSync(report.approvalArtifact.filePath));

      const previewArtifact = readGitHubWritePreviewArtifact({ previewId: report.previewId });
      const approvalArtifact = readGitHubWriteApprovalArtifact({ previewId: report.previewId });
      const eventLog = readGitHubWriteEventLog({ previewId: report.previewId });

      assert.strictEqual(previewArtifact.review.exportKind, 'github-write-preview');
      assert.strictEqual(previewArtifact.target.pullRequestNumber, 7);
      assert.strictEqual(previewArtifact.target.stateAction, 'close');
      assert.strictEqual(previewArtifact.target.desiredState, 'closed');
      assert.strictEqual(approvalArtifact.status, 'requested');
      assert.ok(Array.isArray(eventLog.events));
      assert.ok(eventLog.events.some((entry) => entry.eventName === 'preview.created'));
      assert.ok(eventLog.events.some((entry) => entry.eventName === 'approval.requested'));
    });

    await test('apply closes the pull request once and replays the terminal result on duplicate apply', async () => {
      let fetchCalls = 0;
      const preview = await draftGitHubPullRequestClose({
        cwd: path.join(__dirname, '..'),
        source: 'cli',
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        slug: 'example/project',
        number: 7,
        approvalMode: 'prompt',
        approvalRequirement: 'explicit',
      });

      const applyReport = await applyGitHubWritePreview({
        source: 'cli',
        env: {
          GH_TOKEN: 'github_pat_test_pr_state_preview_apply_1234567890',
        },
        previewId: preview.previewId,
        approve: true,
        approvalFile: preview.approvalArtifact.filePath,
        fetchImpl: async (url, init) => {
          fetchCalls += 1;
          assert.ok(String(url || '').includes('/pulls/7'));
          assert.strictEqual(String(init.method || '').toUpperCase(), 'PATCH');
          const body = JSON.parse(String(init.body || '{}'));
          assert.strictEqual(body.state, 'closed');
          return createJsonResponse(200, {
            number: 7,
            title: 'State change test PR',
            state: 'closed',
            draft: false,
            merged: false,
            html_url: 'https://github.com/example/project/pull/7',
            created_at: '2026-05-26T00:00:00.000Z',
            updated_at: '2026-05-27T00:00:00.000Z',
            closed_at: '2026-05-27T00:00:00.000Z',
            user: {
              login: 'octocat',
              type: 'User',
              html_url: 'https://github.com/octocat',
            },
            head: {
              ref: 'feature/demo',
              sha: 'abc123',
              repo: { full_name: 'example/project' },
            },
            base: {
              ref: 'main',
              sha: 'def456',
              repo: { full_name: 'example/project' },
            },
          }, {
            'x-ratelimit-limit': '5000',
            'x-ratelimit-remaining': '4999',
            'x-ratelimit-reset': '1767225600',
          });
        },
      });

      assert.strictEqual(applyReport.success, true);
      assert.strictEqual(applyReport.schemaVersion, 'github.write-apply.v1');
      assert.strictEqual(applyReport.approval.status, 'applied');
      assert.strictEqual(applyReport.result.type, 'pr-close');
      assert.strictEqual(applyReport.result.pullRequestNumber, 7);
      assert.strictEqual(applyReport.result.desiredState, 'closed');
      assert.strictEqual(applyReport.result.pullRequest.state, 'closed');
      assert.strictEqual(fetchCalls, 1);

      const approvalArtifact = readGitHubWriteApprovalArtifact({ previewId: preview.previewId });
      const resultArtifact = readGitHubWriteApplyResultArtifact({ previewId: preview.previewId });
      const eventLog = readGitHubWriteEventLog({ previewId: preview.previewId });
      assert.strictEqual(approvalArtifact.status, 'applied');
      assert.strictEqual(resultArtifact.success, true);
      assert.strictEqual(resultArtifact.result.type, 'pr-close');
      assert.strictEqual(resultArtifact.result.pullRequestNumber, 7);
      assert.ok(eventLog.events.some((entry) => entry.eventName === 'approval.approved'));
      assert.ok(eventLog.events.some((entry) => entry.eventName === 'apply.started'));
      assert.ok(eventLog.events.some((entry) => entry.eventName === 'apply.succeeded'));

      const replayReport = await applyGitHubWritePreview({
        source: 'cli',
        env: {
          GH_TOKEN: 'github_pat_test_pr_state_preview_apply_1234567890',
        },
        previewId: preview.previewId,
        approve: true,
        approvalFile: preview.approvalArtifact.filePath,
      });

      assert.strictEqual(replayReport.success, true);
      assert.strictEqual(replayReport.execution.status, 'replayed-terminal-result');
      assert.strictEqual(replayReport.execution.alreadyApplied, true);
      assert.strictEqual(replayReport.result.type, 'pr-close');
      assert.strictEqual(replayReport.result.pullRequest.state, 'closed');
      assert.strictEqual(fetchCalls, 1);
    });

    await test('draft and apply reopen a closed pull request through the same preview/apply seam', async () => {
      let fetchCalls = 0;
      const preview = await draftGitHubPullRequestReopen({
        cwd: path.join(__dirname, '..'),
        source: 'cli',
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        slug: 'example/project',
        number: 7,
        approvalMode: 'prompt',
        approvalRequirement: 'explicit',
      });

      assert.strictEqual(preview.success, true);
      assert.strictEqual(preview.schemaVersion, 'github.pr-reopen-draft.v1');
      assert.strictEqual(preview.draft.stateAction, 'reopen');
      assert.strictEqual(preview.draft.desiredState, 'open');

      const applyReport = await applyGitHubWritePreview({
        source: 'cli',
        env: {
          GH_TOKEN: 'github_pat_test_pr_state_preview_apply_1234567890',
        },
        previewId: preview.previewId,
        approve: true,
        approvalFile: preview.approvalArtifact.filePath,
        fetchImpl: async (url, init) => {
          fetchCalls += 1;
          assert.ok(String(url || '').includes('/pulls/7'));
          assert.strictEqual(String(init.method || '').toUpperCase(), 'PATCH');
          const body = JSON.parse(String(init.body || '{}'));
          assert.strictEqual(body.state, 'open');
          return createJsonResponse(200, {
            number: 7,
            title: 'State change test PR',
            state: 'open',
            draft: false,
            merged: false,
            html_url: 'https://github.com/example/project/pull/7',
            created_at: '2026-05-26T00:00:00.000Z',
            updated_at: '2026-05-27T00:05:00.000Z',
            closed_at: null,
            user: {
              login: 'octocat',
              type: 'User',
              html_url: 'https://github.com/octocat',
            },
            head: {
              ref: 'feature/demo',
              sha: 'abc123',
              repo: { full_name: 'example/project' },
            },
            base: {
              ref: 'main',
              sha: 'def456',
              repo: { full_name: 'example/project' },
            },
          }, {
            'x-ratelimit-limit': '5000',
            'x-ratelimit-remaining': '4999',
            'x-ratelimit-reset': '1767225600',
          });
        },
      });

      assert.strictEqual(applyReport.success, true);
      assert.strictEqual(applyReport.result.type, 'pr-reopen');
      assert.strictEqual(applyReport.result.pullRequestNumber, 7);
      assert.strictEqual(applyReport.result.desiredState, 'open');
      assert.strictEqual(applyReport.result.pullRequest.state, 'open');
      assert.strictEqual(applyReport.result.pullRequest.closedAt, null);
      assert.strictEqual(fetchCalls, 1);
    });

    console.log(`PASS github pr state preview/apply (${pass} assertions)`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('FAIL github pr state preview/apply');
  console.error(error.stack || error.message);
  process.exit(1);
});
