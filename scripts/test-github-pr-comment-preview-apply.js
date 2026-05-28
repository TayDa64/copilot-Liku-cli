#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-github-pr-write-'));
process.env.LIKU_HOME_OVERRIDE = path.join(tempRoot, '.liku');
process.env.LIKU_HOME_OLD_OVERRIDE = path.join(tempRoot, '.liku-cli-old');

const {
  createGitHubCommandExecutor,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'command-executor.js'));
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
    url: 'https://api.github.com/repos/example/project/issues/7/comments',
    headers: createHeaders(headers),
    async text() {
      return JSON.stringify(payload);
    },
  };
}

(async () => {
  try {
    const executor = createGitHubCommandExecutor({
      env: {
        GH_TOKEN: 'github_pat_test_pr_preview_apply_1234567890',
      },
      cwd: path.join(__dirname, '..'),
    });

    await test('draft preview writes reviewed sanitized artifacts and approval state for pull request comments', async () => {
      const report = await executor.execute({
        source: 'cli',
        area: 'pr',
        action: 'comment',
        positionals: ['pr', 'comment', 'draft', '7'],
        options: {
          slug: 'example/project',
          body: 'Authorization: Bearer ghp_secret_token_12345678901234567890\nLooks good overall.',
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
      assert.strictEqual(report.schemaVersion, 'github.pr-comment-draft.v1');
      assert.strictEqual(report.capability.key, 'pr.comment.draft');
      assert.strictEqual(report.policy.allowed, true);
      assert.strictEqual(report.policy.state, 'preview-allowed');
      assert.strictEqual(report.pullRequestNumber, 7);
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
      assert.strictEqual(previewArtifact.target.issueNumber, 7);
      assert.strictEqual(approvalArtifact.status, 'requested');
      assert.ok(previewArtifact.input.body.includes('[redacted token]'));
      assert.ok(!previewArtifact.input.body.includes('ghp_secret_token_12345678901234567890'));
      assert.ok(Array.isArray(eventLog.events));
      assert.ok(eventLog.events.some((entry) => entry.eventName === 'preview.created'));
      assert.ok(eventLog.events.some((entry) => entry.eventName === 'approval.requested'));
    });

    await test('apply posts the pull request conversation comment once and replays the terminal result on duplicate apply', async () => {
      let fetchCalls = 0;
      const preview = await executor.execute({
        source: 'cli',
        area: 'pr',
        action: 'comment',
        positionals: ['pr', 'comment', 'draft', '7'],
        options: {
          slug: 'example/project',
          body: 'Please double-check the shader pipeline before merge.',
          featureFlags: {
            enableGitHub: true,
            enableGitHubWrites: true,
          },
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

      const applyReport = await executor.execute({
        source: 'cli',
        area: 'apply',
        action: preview.previewId,
        positionals: ['apply', preview.previewId],
        options: {
          approve: true,
          approvalFile: preview.approvalArtifact.filePath,
          featureFlags: {
            enableGitHub: true,
            enableGitHubWrites: true,
          },
          fetchImpl: async (url, init) => {
            fetchCalls += 1;
            assert.ok(String(url || '').includes('/issues/7/comments'));
            const body = JSON.parse(String(init.body || '{}'));
            assert.strictEqual(body.body, 'Please double-check the shader pipeline before merge.');
            return createJsonResponse(201, {
              id: 9002,
              node_id: 'IC_kwDOPrTest',
              body: body.body,
              html_url: 'https://github.com/example/project/pull/7#issuecomment-9002',
              created_at: '2026-05-26T00:00:00.000Z',
              updated_at: '2026-05-26T00:00:00.000Z',
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
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

      assert.strictEqual(applyReport.success, true);
      assert.strictEqual(applyReport.schemaVersion, 'github.write-apply.v1');
      assert.strictEqual(applyReport.capability.key, 'github.apply');
      assert.strictEqual(applyReport.policy.state, 'apply-allowed');
      assert.strictEqual(applyReport.approval.status, 'applied');
      assert.strictEqual(applyReport.result.type, 'pr-comment');
      assert.strictEqual(applyReport.result.pullRequestNumber, 7);
      assert.strictEqual(applyReport.result.comment.id, 9002);
      assert.strictEqual(fetchCalls, 1);

      const approvalArtifact = readGitHubWriteApprovalArtifact({ previewId: preview.previewId });
      const resultArtifact = readGitHubWriteApplyResultArtifact({ previewId: preview.previewId });
      const eventLog = readGitHubWriteEventLog({ previewId: preview.previewId });
      assert.strictEqual(approvalArtifact.status, 'applied');
      assert.strictEqual(resultArtifact.success, true);
      assert.strictEqual(resultArtifact.result.type, 'pr-comment');
      assert.strictEqual(resultArtifact.result.pullRequestNumber, 7);
      assert.ok(eventLog.events.some((entry) => entry.eventName === 'approval.approved'));
      assert.ok(eventLog.events.some((entry) => entry.eventName === 'apply.started'));
      assert.ok(eventLog.events.some((entry) => entry.eventName === 'apply.succeeded'));

      const replayReport = await executor.execute({
        source: 'cli',
        area: 'apply',
        action: preview.previewId,
        positionals: ['apply', preview.previewId],
        options: {
          approve: true,
          approvalFile: preview.approvalArtifact.filePath,
          featureFlags: {
            enableGitHub: true,
            enableGitHubWrites: true,
          },
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

      assert.strictEqual(replayReport.success, true);
      assert.strictEqual(replayReport.execution.status, 'replayed-terminal-result');
      assert.strictEqual(replayReport.execution.alreadyApplied, true);
      assert.strictEqual(replayReport.result.type, 'pr-comment');
      assert.strictEqual(replayReport.result.comment.id, 9002);
      assert.strictEqual(fetchCalls, 1);
    });

    await test('apply rejects invalid tokens and expired pull request comment previews', async () => {
      const invalidPreview = await executor.execute({
        source: 'cli',
        area: 'pr',
        action: 'comment',
        positionals: ['pr', 'comment', 'draft', '7'],
        options: {
          slug: 'example/project',
          body: 'Token validation proof.',
          featureFlags: {
            enableGitHub: true,
            enableGitHubWrites: true,
          },
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

      const invalidApply = await executor.execute({
        source: 'cli',
        area: 'apply',
        action: invalidPreview.previewId,
        positionals: ['apply', invalidPreview.previewId],
        options: {
          approve: true,
          'apply-token': 'ghwa_invalid',
          featureFlags: {
            enableGitHub: true,
            enableGitHubWrites: true,
          },
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

      assert.strictEqual(invalidApply.success, false);
      assert.strictEqual(invalidApply.error, 'INVALID_APPLY_TOKEN');

      const expiredPreview = await executor.execute({
        source: 'cli',
        area: 'pr',
        action: 'comment',
        positionals: ['pr', 'comment', 'draft', '7'],
        options: {
          slug: 'example/project',
          body: 'Expiration proof.',
          featureFlags: {
            enableGitHub: true,
            enableGitHubWrites: true,
          },
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

      const expiredPreviewArtifact = readGitHubWritePreviewArtifact({ previewId: expiredPreview.previewId });
      const expiredApprovalArtifact = readGitHubWriteApprovalArtifact({ previewId: expiredPreview.previewId });
      expiredPreviewArtifact.expiresAt = '2000-01-01T00:00:00.000Z';
      expiredApprovalArtifact.expiresAt = '2000-01-01T00:00:00.000Z';
      fs.writeFileSync(expiredPreviewArtifact.filePath, JSON.stringify(expiredPreviewArtifact, null, 2));
      fs.writeFileSync(expiredApprovalArtifact.filePath, JSON.stringify(expiredApprovalArtifact, null, 2));

      const expiredApply = await executor.execute({
        source: 'cli',
        area: 'apply',
        action: expiredPreview.previewId,
        positionals: ['apply', expiredPreview.previewId],
        options: {
          approve: true,
          approvalFile: expiredPreview.approvalArtifact.filePath,
          featureFlags: {
            enableGitHub: true,
            enableGitHubWrites: true,
          },
        },
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        executionPreferences: { approvalMode: 'prompt', dryRunDefault: false },
      });

      assert.strictEqual(expiredApply.success, false);
      assert.strictEqual(expiredApply.error, 'EXPIRED_PREVIEW');
      const expiredApproval = readGitHubWriteApprovalArtifact({ previewId: expiredPreview.previewId });
      assert.strictEqual(expiredApproval.status, 'expired');
    });

    console.log(`PASS github pr comment preview/apply (${pass} assertions)`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('FAIL github pr comment preview/apply');
  console.error(error.stack || error.message);
  process.exit(1);
});
