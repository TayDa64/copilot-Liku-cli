#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-github-pr-create-'));
process.env.LIKU_HOME_OVERRIDE = path.join(tempRoot, '.liku');
process.env.LIKU_HOME_OLD_OVERRIDE = path.join(tempRoot, '.liku-cli-old');

const {
  draftGitHubPullRequestCreate,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'pr-create-draft.js'));
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
    url: 'https://api.github.com/repos/example/project/pulls',
    headers: createHeaders(headers),
    async text() {
      return JSON.stringify(payload);
    },
  };
}

(async () => {
  try {
    await test('draft preview resolves default head/base and writes reviewed sanitized artifacts for pull request creation', async () => {
      let repoInspectCalls = 0;
      const report = await draftGitHubPullRequestCreate({
        cwd: path.join(__dirname, '..'),
        source: 'cli',
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        slug: 'example/project',
        api: true,
        title: 'Authorization: Bearer ghp_secret_token_12345678901234567890 Add overlay diagnostics',
        body: 'Authorization: Bearer ghp_secret_token_12345678901234567890 Implements the next PR slice.',
        approvalMode: 'prompt',
        approvalRequirement: 'explicit',
        resolveCurrentGitBranch() {
          return {
            currentBranch: 'feature/overlay-diagnostics',
            source: 'git-head',
            available: true,
            detached: false,
            warnings: [],
          };
        },
        async inspectGitHubRepository() {
          repoInspectCalls += 1;
          return {
            success: true,
            githubApi: {
              attempted: true,
              repository: {
                fullName: 'example/project',
                defaultBranch: 'main',
              },
            },
            warnings: [],
          };
        },
      });

      assert.strictEqual(report.success, true);
      assert.strictEqual(report.schemaVersion, 'github.pr-create-draft.v1');
      assert.strictEqual(repoInspectCalls, 1);
      assert.ok(report.previewId);
      assert.ok(report.review.reviewRequired);
      assert.ok(report.approval.applyToken);
      assert.strictEqual(report.draft.baseBranch, 'main');
      assert.strictEqual(report.draft.baseSource, 'repo-default-branch');
      assert.strictEqual(report.draft.head, 'feature/overlay-diagnostics');
      assert.strictEqual(report.draft.headBranch, 'feature/overlay-diagnostics');
      assert.strictEqual(report.draft.headSource, 'git-head');
      assert.strictEqual(report.draft.draft, false);
      assert.ok(fs.existsSync(report.previewArtifact.filePath));
      assert.ok(fs.existsSync(report.approvalArtifact.filePath));

      const previewArtifact = readGitHubWritePreviewArtifact({ previewId: report.previewId });
      const approvalArtifact = readGitHubWriteApprovalArtifact({ previewId: report.previewId });
      const eventLog = readGitHubWriteEventLog({ previewId: report.previewId });

      assert.strictEqual(previewArtifact.review.exportKind, 'github-write-preview');
      assert.strictEqual(previewArtifact.target.kind, 'pr-create');
      assert.strictEqual(previewArtifact.target.baseBranch, 'main');
      assert.strictEqual(previewArtifact.target.head, 'feature/overlay-diagnostics');
      assert.strictEqual(previewArtifact.target.headBranch, 'feature/overlay-diagnostics');
      assert.strictEqual(previewArtifact.target.draft, false);
      assert.strictEqual(approvalArtifact.status, 'requested');
      assert.ok(previewArtifact.input.title.includes('[redacted token]'));
      assert.ok(previewArtifact.input.body.includes('[redacted token]'));
      assert.ok(!previewArtifact.input.title.includes('ghp_secret_token_12345678901234567890'));
      assert.ok(!previewArtifact.input.body.includes('ghp_secret_token_12345678901234567890'));
      assert.ok(Array.isArray(eventLog.events));
      assert.ok(eventLog.events.some((entry) => entry.eventName === 'preview.created'));
      assert.ok(eventLog.events.some((entry) => entry.eventName === 'approval.requested'));
    });

    await test('apply creates the pull request once and replays the terminal result on duplicate apply', async () => {
      let fetchCalls = 0;
      const preview = await draftGitHubPullRequestCreate({
        cwd: path.join(__dirname, '..'),
        source: 'cli',
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        slug: 'example/project',
        api: false,
        title: 'Add overlay diagnostics',
        body: 'Implements the next PR slice.',
        base: 'main',
        head: 'example:feature/overlay-diagnostics',
        draft: true,
        approvalMode: 'prompt',
        approvalRequirement: 'explicit',
      });

      const applyReport = await applyGitHubWritePreview({
        source: 'cli',
        env: {
          GH_TOKEN: 'github_pat_test_pr_create_preview_apply_1234567890',
        },
        previewId: preview.previewId,
        approve: true,
        approvalFile: preview.approvalArtifact.filePath,
        fetchImpl: async (url, init) => {
          fetchCalls += 1;
          assert.ok(String(url || '').includes('/repos/example/project/pulls'));
          const body = JSON.parse(String(init.body || '{}'));
          assert.strictEqual(body.title, 'Add overlay diagnostics');
          assert.strictEqual(body.body, 'Implements the next PR slice.');
          assert.strictEqual(body.base, 'main');
          assert.strictEqual(body.head, 'example:feature/overlay-diagnostics');
          assert.strictEqual(body.draft, true);
          return createJsonResponse(201, {
            number: 42,
            title: body.title,
            state: 'open',
            draft: true,
            merged: false,
            mergeable: true,
            mergeable_state: 'clean',
            html_url: 'https://github.com/example/project/pull/42',
            created_at: '2026-05-27T00:00:00.000Z',
            updated_at: '2026-05-27T00:00:00.000Z',
            body: body.body,
            user: {
              login: 'octocat',
              type: 'User',
              html_url: 'https://github.com/octocat',
            },
            head: {
              ref: 'feature/overlay-diagnostics',
              sha: 'abc123',
              repo: { full_name: 'example/project' },
            },
            base: {
              ref: 'main',
              sha: 'def456',
              repo: { full_name: 'example/project' },
            },
            additions: 12,
            deletions: 3,
            changed_files: 2,
            commits: 1,
            comments: 0,
            review_comments: 0,
            review_comments_url: 'https://api.github.com/repos/example/project/pulls/42/comments',
            comments_url: 'https://api.github.com/repos/example/project/issues/42/comments',
            labels: [],
            requested_reviewers: [],
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
      assert.strictEqual(applyReport.result.type, 'pr-create');
      assert.strictEqual(applyReport.result.pullRequestNumber, 42);
      assert.strictEqual(applyReport.result.baseBranch, 'main');
      assert.strictEqual(applyReport.result.head, 'example:feature/overlay-diagnostics');
      assert.strictEqual(applyReport.result.headBranch, 'feature/overlay-diagnostics');
      assert.strictEqual(applyReport.result.draft, true);
      assert.strictEqual(applyReport.result.pullRequest.number, 42);
      assert.strictEqual(applyReport.result.pullRequest.htmlUrl, 'https://github.com/example/project/pull/42');
      assert.strictEqual(fetchCalls, 1);

      const approvalArtifact = readGitHubWriteApprovalArtifact({ previewId: preview.previewId });
      const resultArtifact = readGitHubWriteApplyResultArtifact({ previewId: preview.previewId });
      const eventLog = readGitHubWriteEventLog({ previewId: preview.previewId });
      assert.strictEqual(approvalArtifact.status, 'applied');
      assert.strictEqual(resultArtifact.success, true);
      assert.strictEqual(resultArtifact.result.type, 'pr-create');
      assert.strictEqual(resultArtifact.result.pullRequestNumber, 42);
      assert.ok(eventLog.events.some((entry) => entry.eventName === 'approval.approved'));
      assert.ok(eventLog.events.some((entry) => entry.eventName === 'apply.started'));
      assert.ok(eventLog.events.some((entry) => entry.eventName === 'apply.succeeded'));

      const replayReport = await applyGitHubWritePreview({
        source: 'cli',
        previewId: preview.previewId,
        approve: true,
        approvalFile: preview.approvalArtifact.filePath,
      });

      assert.strictEqual(replayReport.success, true);
      assert.strictEqual(replayReport.execution.status, 'replayed-terminal-result');
      assert.strictEqual(replayReport.execution.alreadyApplied, true);
      assert.strictEqual(replayReport.result.type, 'pr-create');
      assert.strictEqual(replayReport.result.pullRequestNumber, 42);
      assert.strictEqual(fetchCalls, 1);
    });

    await test('apply rejects invalid tokens and expired pull request create previews', async () => {
      const invalidPreview = await draftGitHubPullRequestCreate({
        cwd: path.join(__dirname, '..'),
        source: 'cli',
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        slug: 'example/project',
        api: false,
        title: 'Token validation proof',
        body: 'Validate reviewed apply token handling.',
        base: 'main',
        head: 'feature/token-proof',
        approvalMode: 'prompt',
        approvalRequirement: 'explicit',
      });

      const invalidApply = await applyGitHubWritePreview({
        source: 'cli',
        previewId: invalidPreview.previewId,
        approve: true,
        'apply-token': 'ghwa_invalid',
      });

      assert.strictEqual(invalidApply.success, false);
      assert.strictEqual(invalidApply.error, 'INVALID_APPLY_TOKEN');

      const expiredPreview = await draftGitHubPullRequestCreate({
        cwd: path.join(__dirname, '..'),
        source: 'cli',
        featureFlagEnabled: true,
        writeFeatureFlagEnabled: true,
        slug: 'example/project',
        api: false,
        title: 'Expiration proof',
        body: 'Validate expiration handling.',
        base: 'main',
        head: 'feature/expiration-proof',
        approvalMode: 'prompt',
        approvalRequirement: 'explicit',
      });

      const expiredPreviewArtifact = readGitHubWritePreviewArtifact({ previewId: expiredPreview.previewId });
      const expiredApprovalArtifact = readGitHubWriteApprovalArtifact({ previewId: expiredPreview.previewId });
      expiredPreviewArtifact.expiresAt = '2000-01-01T00:00:00.000Z';
      expiredApprovalArtifact.expiresAt = '2000-01-01T00:00:00.000Z';
      fs.writeFileSync(expiredPreviewArtifact.filePath, JSON.stringify(expiredPreviewArtifact, null, 2));
      fs.writeFileSync(expiredApprovalArtifact.filePath, JSON.stringify(expiredApprovalArtifact, null, 2));

      const expiredApply = await applyGitHubWritePreview({
        source: 'cli',
        previewId: expiredPreview.previewId,
        approve: true,
        approvalFile: expiredPreview.approvalArtifact.filePath,
      });

      assert.strictEqual(expiredApply.success, false);
      assert.strictEqual(expiredApply.error, 'EXPIRED_PREVIEW');
      const updatedApproval = readGitHubWriteApprovalArtifact({ previewId: expiredPreview.previewId });
      const eventLog = readGitHubWriteEventLog({ previewId: expiredPreview.previewId });
      assert.strictEqual(updatedApproval.status, 'expired');
      assert.ok(eventLog.events.some((entry) => entry.eventName === 'preview.expired'));
    });

    console.log(`PASS github pr create preview/apply (${pass} assertions)`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('FAIL github pr create preview/apply');
  console.error(error.stack || error.message);
  process.exit(1);
});
