const { resolveGitHubRepoContext } = require('./context');
const { resolveBodyInput, buildCliApplyCommand } = require('./issue-comment-draft');
const { normalizePullRequestNumber } = require('./pr-inspect');
const { createGitHubWritePreviewArtifacts } = require('./write-artifacts');

const GITHUB_PR_COMMENT_DRAFT_SCHEMA_VERSION = 'github.pr-comment-draft.v1';

function buildUsageMessage() {
  return 'Usage: liku github pr comment draft <number> (--body <text> | --body-file <path>) [--slug owner/repo]';
}

async function draftGitHubPullRequestComment(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const writeFeatureFlagEnabled = options.writeFeatureFlagEnabled === true;
  const pullRequestNumber = normalizePullRequestNumber(options.number || options.pullRequestNumber || options.pr);
  const context = resolveGitHubRepoContext(options);
  const source = String(options.source || 'unknown').trim() || 'unknown';
  const approvalMode = String(options.approvalMode || 'prompt').trim() || 'prompt';
  const approvalRequirement = String(options.approvalRequirement || 'explicit').trim() || 'explicit';
  const bodyInput = resolveBodyInput({
    ...options,
    usageMessage: buildUsageMessage(),
    bodyFileLabel: 'Pull request comment body file',
    emptyBodyMessage: 'GitHub pull request comment drafts require a non-empty body.',
  });

  const report = {
    schemaVersion: GITHUB_PR_COMMENT_DRAFT_SCHEMA_VERSION,
    success: true,
    featureFlagEnabled,
    writeFeatureFlagEnabled,
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: context.target,
    targetSource: context.targetSource,
    pullRequestNumber,
    previewId: null,
    review: null,
    previewArtifact: null,
    approvalArtifact: null,
    eventLog: null,
    draft: null,
    approval: null,
    instructions: null,
    warnings: context.warnings.slice(),
  };

  if (!pullRequestNumber) {
    report.success = false;
    report.error = 'USAGE';
    report.message = buildUsageMessage();
    return report;
  }

  if (!context.target.raw) {
    report.success = false;
    report.error = 'TARGET_REQUIRED';
    report.message = 'GitHub pull request comment drafts require a GitHub repository target. Use --slug owner/repo when no git remote is available.';
    return report;
  }

  if (!context.target.isGitHub || !context.target.slug) {
    report.success = false;
    report.error = 'TARGET_NOT_GITHUB';
    report.message = 'GitHub pull request comment drafts require a GitHub repository target.';
    return report;
  }

  if (!bodyInput.ok) {
    report.success = false;
    report.error = bodyInput.error;
    report.message = bodyInput.message;
    return report;
  }

  const previewArtifacts = createGitHubWritePreviewArtifacts({
    source,
    capabilityKey: 'pr.comment.draft',
    previewType: 'pr-comment',
    approvalRequirement,
    approvalMode,
    body: bodyInput.body,
    bodySource: bodyInput.bodySource,
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: {
      kind: 'pr-comment',
      slug: context.target.slug,
      owner: context.target.owner,
      repo: context.target.repo,
      apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
      pullRequestNumber,
      issueNumber: pullRequestNumber,
      htmlUrl: context.target.htmlUrl ? `${context.target.htmlUrl}/pull/${pullRequestNumber}` : null,
    },
    targetSource: context.targetSource,
    inputMetadata: {
      bodyFilePath: bodyInput.bodyFilePath,
    },
    metadata: {
      commandSurface: source,
      draftKind: 'pr-comment',
    },
    includeApplyToken: source === 'cli',
  });

  report.previewId = previewArtifacts.previewId;
  report.review = previewArtifacts.review;
  report.previewArtifact = previewArtifacts.previewArtifact;
  report.approvalArtifact = previewArtifacts.approvalArtifact;
  report.eventLog = previewArtifacts.eventLog;
  report.draft = {
    type: 'pr-comment',
    pullRequestNumber,
    bodySource: bodyInput.bodySource,
    bodyFilePath: bodyInput.bodyFilePath,
    bodyPreview: previewArtifacts.previewRecord?.input?.bodyPreview || '',
    bodyStats: previewArtifacts.previewRecord?.input?.bodyStats || null,
  };
  report.approval = {
    status: previewArtifacts.approvalRecord?.status || 'requested',
    approvalRequirement,
    approvalMode,
    expiresAt: previewArtifacts.approvalRecord?.expiresAt || null,
    applyToken: source === 'cli' ? previewArtifacts.applyToken : null,
    applyTokenHint: previewArtifacts.applyTokenHint,
  };
  report.instructions = {
    cliApply: buildCliApplyCommand(previewArtifacts.previewId, previewArtifacts.approvalArtifact.filePath),
    note: 'Review the preview artifact before running the CLI apply command. Slash apply is intentionally unavailable in this reviewed GitHub write slice.',
  };

  if ((report.review?.redactionCount || 0) > 0) {
    report.warnings.push('The persisted pull-request comment preview was sanitized before local storage.');
  }

  return report;
}

module.exports = {
  GITHUB_PR_COMMENT_DRAFT_SCHEMA_VERSION,
  buildUsageMessage,
  draftGitHubPullRequestComment,
};