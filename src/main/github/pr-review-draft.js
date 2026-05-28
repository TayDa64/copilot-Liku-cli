const fs = require('fs');
const path = require('path');

const { resolveGitHubRepoContext } = require('./context');
const { buildCliApplyCommand } = require('./issue-comment-draft');
const { normalizePullRequestNumber } = require('./pr-inspect');
const { createGitHubWritePreviewArtifacts } = require('./write-artifacts');

const GITHUB_PR_REVIEW_DRAFT_SCHEMA_VERSION = 'github.pr-review-draft.v1';

function buildUsageMessage() {
  return 'Usage: liku github pr review draft <number> --event <comment|approve|request-changes> [--body <text> | --body-file <path>] [--slug owner/repo]';
}

function normalizeReviewEvent(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === 'comment') {
    return {
      reviewEvent: 'comment',
      reviewEventApi: 'COMMENT',
      requiresBody: true,
    };
  }

  if (normalized === 'approve' || normalized === 'approved') {
    return {
      reviewEvent: 'approve',
      reviewEventApi: 'APPROVE',
      requiresBody: false,
    };
  }

  if (['request-changes', 'request_changes', 'requestchanges', 'changes-requested', 'request-change'].includes(normalized)) {
    return {
      reviewEvent: 'request-changes',
      reviewEventApi: 'REQUEST_CHANGES',
      requiresBody: true,
    };
  }

  return null;
}

function resolveReviewBodyInput(options = {}, reviewEvent = null) {
  const inlineBody = typeof options.body === 'string' ? options.body : null;
  const bodyFileRaw = options.bodyFile || options['body-file'] || null;
  const requiresBody = reviewEvent?.requiresBody === true;
  const eventLabel = reviewEvent?.reviewEvent || 'review';

  if (inlineBody !== null && bodyFileRaw) {
    return {
      ok: false,
      error: 'USAGE',
      message: 'Specify either --body or --body-file, not both.',
    };
  }

  if (bodyFileRaw) {
    const bodyFilePath = path.resolve(String(options.cwd || process.cwd()), String(bodyFileRaw));
    if (!fs.existsSync(bodyFilePath)) {
      return {
        ok: false,
        error: 'BODY_FILE_NOT_FOUND',
        message: `Pull request review body file not found: ${bodyFilePath}`,
      };
    }

    const body = fs.readFileSync(bodyFilePath, 'utf8');
    if (!String(body || '').trim()) {
      return {
        ok: false,
        error: 'EMPTY_REVIEW_BODY',
        message: `GitHub pull request review drafts for event '${eventLabel}' require a non-empty body when provided.`,
      };
    }

    return {
      ok: true,
      body,
      bodySource: 'file',
      bodyFilePath,
    };
  }

  if (inlineBody !== null) {
    if (!String(inlineBody || '').trim()) {
      return {
        ok: false,
        error: 'EMPTY_REVIEW_BODY',
        message: `GitHub pull request review drafts for event '${eventLabel}' require a non-empty body when provided.`,
      };
    }

    return {
      ok: true,
      body: inlineBody,
      bodySource: 'inline',
      bodyFilePath: null,
    };
  }

  if (requiresBody) {
    return {
      ok: false,
      error: 'BODY_REQUIRED',
      message: `GitHub pull request review drafts for event '${eventLabel}' require --body or --body-file.`,
    };
  }

  return {
    ok: true,
    body: '',
    bodySource: 'none',
    bodyFilePath: null,
  };
}

async function draftGitHubPullRequestReview(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const writeFeatureFlagEnabled = options.writeFeatureFlagEnabled === true;
  const pullRequestNumber = normalizePullRequestNumber(options.number || options.pullRequestNumber || options.pr);
  const context = resolveGitHubRepoContext(options);
  const source = String(options.source || 'unknown').trim() || 'unknown';
  const approvalMode = String(options.approvalMode || 'prompt').trim() || 'prompt';
  const approvalRequirement = String(options.approvalRequirement || 'explicit').trim() || 'explicit';
  const reviewEvent = normalizeReviewEvent(options.event);
  const bodyInput = resolveReviewBodyInput(options, reviewEvent);

  const report = {
    schemaVersion: GITHUB_PR_REVIEW_DRAFT_SCHEMA_VERSION,
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
    report.message = 'GitHub pull request review drafts require a GitHub repository target. Use --slug owner/repo when no git remote is available.';
    return report;
  }

  if (!context.target.isGitHub || !context.target.slug) {
    report.success = false;
    report.error = 'TARGET_NOT_GITHUB';
    report.message = 'GitHub pull request review drafts require a GitHub repository target.';
    return report;
  }

  if (!reviewEvent) {
    report.success = false;
    report.error = 'INVALID_REVIEW_EVENT';
    report.message = buildUsageMessage();
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
    capabilityKey: 'pr.review.draft',
    previewType: 'pr-review',
    approvalRequirement,
    approvalMode,
    body: bodyInput.body,
    bodySource: bodyInput.bodySource,
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: {
      kind: 'pr-review',
      slug: context.target.slug,
      owner: context.target.owner,
      repo: context.target.repo,
      apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
      pullRequestNumber,
      reviewEvent: reviewEvent.reviewEvent,
      reviewEventApi: reviewEvent.reviewEventApi,
      htmlUrl: context.target.htmlUrl ? `${context.target.htmlUrl}/pull/${pullRequestNumber}` : null,
    },
    targetSource: context.targetSource,
    inputMetadata: {
      bodyFilePath: bodyInput.bodyFilePath,
      reviewEvent: reviewEvent.reviewEvent,
      reviewEventApi: reviewEvent.reviewEventApi,
    },
    metadata: {
      commandSurface: source,
      draftKind: 'pr-review',
    },
    includeApplyToken: source === 'cli',
  });

  report.previewId = previewArtifacts.previewId;
  report.review = previewArtifacts.review;
  report.previewArtifact = previewArtifacts.previewArtifact;
  report.approvalArtifact = previewArtifacts.approvalArtifact;
  report.eventLog = previewArtifacts.eventLog;
  report.draft = {
    type: 'pr-review',
    pullRequestNumber,
    reviewEvent: reviewEvent.reviewEvent,
    reviewEventApi: reviewEvent.reviewEventApi,
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
    report.warnings.push('The persisted pull-request review preview was sanitized before local storage.');
  }

  return report;
}

module.exports = {
  GITHUB_PR_REVIEW_DRAFT_SCHEMA_VERSION,
  buildUsageMessage,
  draftGitHubPullRequestReview,
  normalizeReviewEvent,
  resolveReviewBodyInput,
};
