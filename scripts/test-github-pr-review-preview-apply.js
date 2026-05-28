#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-github-pr-review-'));
process.env.LIKU_HOME_OVERRIDE = path.join(tempRoot, '.liku');
process.env.LIKU_HOME_OLD_OVERRIDE = path.join(tempRoot, '.liku-cli-old');

const {
  createGitHubCommandExecutor,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'command-executor.js'));
const {
  draftGitHubPullRequestReview,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'pr-review-draft.js'));
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
    url: 'https://api.github.com/repos/example/project/pulls/7/reviews',
    headers: createHeaders(headers),
    async text() {
      return JSON.stringify(payload);
    },
  };
}

(async () => {
  try {
    await test('draft preview writes reviewed sanitized artifacts for pull request reviews', async () => {
      const executor = createGitHubCommandExecutor({
        env: {
          GH_TOKEN: 'github_pat_test_pr_review_preview_apply_1234567890',
        },
        cwd: path.join(__dirname, '..'),
      });

      const report = await executor.execute({
        source: 'cli',
        area: 'pr',
        action: 'review',
        positionals: ['pr', 'review', 'draft', '7'],
        options: {
          slug: 'example/project',
          event: 'request-changes',
          body: 'Authorization: Bearer ghp_secret_token_12345678901234567890\nPlease add one more regression test.',
          featureFlags: {
            enableGitHub: true,
            enableGitHubWrites: true,
          },
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

      assert.strictEqual(report.success, true);
      assert.strictEqual(report.schemaVersion, 'github.pr-review-draft.v1');
      assert.strictEqual(report.capability.key, 'pr.review.draft');
      assert.strictEqual(report.policy.allowed, true);
      assert.strictEqual(report.policy.state, 'preview-allowed');
      assert.strictEqual(report.pullRequestNumber, 7);
      assert.strictEqual(report.draft.reviewEvent, 'request-changes');
      assert.strictEqual(report.draft.reviewEventApi, 'REQUEST_CHANGES');
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
      assert.strictEqual(previewArtifact.target.reviewEvent, 'request-changes');
      assert.strictEqual(previewArtifact.target.reviewEventApi, 'REQUEST_CHANGES');
      assert.strictEqual(approvalArtifact.status, 'requested');
      assert.ok(previewArtifact.input.body.includes('[redacted token]'));
      assert.ok(!previewArtifact.input.body.includes('ghp_secret_token_12345678901234567890'));
      assert.ok(Array.isArray(eventLog.events));
      assert.ok(eventLog.events.some((entry) => entry.eventName === 'preview.created'));
      assert.ok(eventLog.events.some((entry) => entry.eventName === 'approval.requested'));
    });

    await test('apply posts the pull request review once and replays the terminal result on duplicate apply', async () => {
      let fetchCalls = 0;
      const preview = await draftGitHubPullRequestReview({
        cwd: path.join(__dirname, '..'),
        source: 'cli',
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        slug: 'example/project',
        event: 'approve',
        body: 'Looks good overall.',
        number: 7,
        approvalMode: 'prompt',
        approvalRequirement: 'explicit',
      });

      const applyReport = await applyGitHubWritePreview({
        source: 'cli',
        env: {
          GH_TOKEN: 'github_pat_test_pr_review_preview_apply_1234567890',
        },
        previewId: preview.previewId,
        approve: true,
        approvalFile: preview.approvalArtifact.filePath,
        fetchImpl: async (url, init) => {
          fetchCalls += 1;
          assert.ok(String(url || '').includes('/pulls/7/reviews'));
          const body = JSON.parse(String(init.body || '{}'));
          assert.strictEqual(body.event, 'APPROVE');
          assert.strictEqual(body.body, 'Looks good overall.');
          return createJsonResponse(200, {
            id: 5001,
            node_id: 'PRR_kwDOReviewTest',
            html_url: 'https://github.com/example/project/pull/7#pullrequestreview-5001',
            body: body.body,
            state: 'APPROVED',
            submitted_at: '2026-05-27T00:00:00.000Z',
            commit_id: 'abc123',
            user: {
              login: 'octocat',
              type: 'User',
              html_url: 'https://github.com/octocat',
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
      assert.strictEqual(applyReport.result.type, 'pr-review');
      assert.strictEqual(applyReport.result.pullRequestNumber, 7);
      assert.strictEqual(applyReport.result.reviewEvent, 'approve');
      assert.strictEqual(applyReport.result.review.id, 5001);
      assert.strictEqual(applyReport.result.review.state, 'approved');
      assert.strictEqual(fetchCalls, 1);

      const approvalArtifact = readGitHubWriteApprovalArtifact({ previewId: preview.previewId });
      const resultArtifact = readGitHubWriteApplyResultArtifact({ previewId: preview.previewId });
      const eventLog = readGitHubWriteEventLog({ previewId: preview.previewId });
      assert.strictEqual(approvalArtifact.status, 'applied');
      assert.strictEqual(resultArtifact.success, true);
      assert.strictEqual(resultArtifact.result.type, 'pr-review');
      assert.strictEqual(resultArtifact.result.pullRequestNumber, 7);
      assert.ok(eventLog.events.some((entry) => entry.eventName === 'approval.approved'));
      assert.ok(eventLog.events.some((entry) => entry.eventName === 'apply.started'));
      assert.ok(eventLog.events.some((entry) => entry.eventName === 'apply.succeeded'));

      const replayReport = await applyGitHubWritePreview({
        source: 'cli',
        env: {
          GH_TOKEN: 'github_pat_test_pr_review_preview_apply_1234567890',
        },
        previewId: preview.previewId,
        approve: true,
        approvalFile: preview.approvalArtifact.filePath,
      });

      assert.strictEqual(replayReport.success, true);
      assert.strictEqual(replayReport.execution.status, 'replayed-terminal-result');
      assert.strictEqual(replayReport.execution.alreadyApplied, true);
      assert.strictEqual(replayReport.result.type, 'pr-review');
      assert.strictEqual(replayReport.result.review.id, 5001);
      assert.strictEqual(fetchCalls, 1);
    });

    await test('draft enforces review-event body requirements while allowing approve without a body', async () => {
      const missingBody = await draftGitHubPullRequestReview({
        cwd: path.join(__dirname, '..'),
        source: 'cli',
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        slug: 'example/project',
        number: 9,
        event: 'request-changes',
        approvalMode: 'prompt',
        approvalRequirement: 'explicit',
      });

      assert.strictEqual(missingBody.success, false);
      assert.strictEqual(missingBody.error, 'BODY_REQUIRED');
      assert.ok(missingBody.message.includes("require --body or --body-file"));

      const approveWithoutBody = await draftGitHubPullRequestReview({
        cwd: path.join(__dirname, '..'),
        source: 'cli',
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        slug: 'example/project',
        number: 9,
        event: 'approve',
        approvalMode: 'prompt',
        approvalRequirement: 'explicit',
      });

      assert.strictEqual(approveWithoutBody.success, true);
      assert.strictEqual(approveWithoutBody.draft.reviewEvent, 'approve');
      assert.strictEqual(approveWithoutBody.draft.bodySource, 'none');
    });

    console.log(`PASS github pr review preview/apply (${pass} assertions)`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('FAIL github pr review preview/apply');
  console.error(error.stack || error.message);
  process.exit(1);
});
