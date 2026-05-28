const fs = require('fs');
const path = require('path');

const { normalizeIssueNumber } = require('./issue-inspect');
const { resolveGitHubRepoContext } = require('./context');
const { createGitHubWritePreviewArtifacts } = require('./write-artifacts');

const GITHUB_ISSUE_COMMENT_DRAFT_SCHEMA_VERSION = 'github.issue-comment-draft.v1';

function buildUsageMessage() {
  return 'Usage: liku github issues comment draft <number> (--body <text> | --body-file <path>) [--slug owner/repo]';
}

function resolveBodyInput(options = {}) {
  const usageMessage = String(options.usageMessage || buildUsageMessage()).trim() || buildUsageMessage();
  const bodyFileLabel = String(options.bodyFileLabel || 'Issue comment body file').trim() || 'Issue comment body file';
  const emptyBodyMessage = String(options.emptyBodyMessage || 'GitHub issue comment drafts require a non-empty body.').trim()
    || 'GitHub issue comment drafts require a non-empty body.';
  const inlineBody = typeof options.body === 'string' ? options.body : null;
  const bodyFileRaw = options.bodyFile || options['body-file'] || null;

  if (inlineBody !== null && bodyFileRaw) {
    return {
      ok: false,
      error: 'USAGE',
      message: 'Specify either --body or --body-file, not both.',
    };
  }

  if (inlineBody === null && !bodyFileRaw) {
    return {
      ok: false,
      error: 'USAGE',
      message: usageMessage,
    };
  }

  if (bodyFileRaw) {
    const bodyFilePath = path.resolve(String(options.cwd || process.cwd()), String(bodyFileRaw));
    if (!fs.existsSync(bodyFilePath)) {
      return {
        ok: false,
        error: 'BODY_FILE_NOT_FOUND',
        message: `${bodyFileLabel} not found: ${bodyFilePath}`,
      };
    }

    const body = fs.readFileSync(bodyFilePath, 'utf8');
    if (!String(body || '').trim()) {
      return {
        ok: false,
        error: 'EMPTY_COMMENT_BODY',
        message: emptyBodyMessage,
      };
    }

    return {
      ok: true,
      body,
      bodySource: 'file',
      bodyFilePath,
    };
  }

  if (!String(inlineBody || '').trim()) {
    return {
      ok: false,
      error: 'EMPTY_COMMENT_BODY',
      message: emptyBodyMessage,
    };
  }

  return {
    ok: true,
    body: inlineBody,
    bodySource: 'inline',
    bodyFilePath: null,
  };
}

function buildCliApplyCommand(previewId, approvalArtifactPath) {
  return `liku github apply ${previewId} --approve --approval-file "${approvalArtifactPath}"`;
}

async function draftGitHubIssueComment(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const writeFeatureFlagEnabled = options.writeFeatureFlagEnabled === true;
  const issueNumber = normalizeIssueNumber(options.number || options.issueNumber || options.issue);
  const context = resolveGitHubRepoContext(options);
  const source = String(options.source || 'unknown').trim() || 'unknown';
  const approvalMode = String(options.approvalMode || 'prompt').trim() || 'prompt';
  const approvalRequirement = String(options.approvalRequirement || 'explicit').trim() || 'explicit';
  const bodyInput = resolveBodyInput(options);

  const report = {
    schemaVersion: GITHUB_ISSUE_COMMENT_DRAFT_SCHEMA_VERSION,
    success: true,
    featureFlagEnabled,
    writeFeatureFlagEnabled,
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: context.target,
    targetSource: context.targetSource,
    issueNumber,
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

  if (!issueNumber) {
    report.success = false;
    report.error = 'USAGE';
    report.message = buildUsageMessage();
    return report;
  }

  if (!context.target.raw) {
    report.success = false;
    report.error = 'TARGET_REQUIRED';
    report.message = 'GitHub issue comment drafts require a GitHub repository target. Use --slug owner/repo when no git remote is available.';
    return report;
  }

  if (!context.target.isGitHub || !context.target.slug) {
    report.success = false;
    report.error = 'TARGET_NOT_GITHUB';
    report.message = 'GitHub issue comment drafts require a GitHub repository target.';
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
    capabilityKey: 'issues.comment.draft',
    previewType: 'issue-comment',
    approvalRequirement,
    approvalMode,
    body: bodyInput.body,
    bodySource: bodyInput.bodySource,
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: {
      kind: 'issue-comment',
      slug: context.target.slug,
      owner: context.target.owner,
      repo: context.target.repo,
      apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
      issueNumber,
      htmlUrl: context.target.htmlUrl ? `${context.target.htmlUrl}/issues/${issueNumber}` : null,
    },
    targetSource: context.targetSource,
    inputMetadata: {
      bodyFilePath: bodyInput.bodyFilePath,
    },
    metadata: {
      commandSurface: source,
      draftKind: 'issue-comment',
    },
    includeApplyToken: source === 'cli',
  });

  report.previewId = previewArtifacts.previewId;
  report.review = previewArtifacts.review;
  report.previewArtifact = previewArtifacts.previewArtifact;
  report.approvalArtifact = previewArtifacts.approvalArtifact;
  report.eventLog = previewArtifacts.eventLog;
  report.draft = {
    type: 'issue-comment',
    issueNumber,
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
    note: 'Review the preview artifact before running the CLI apply command. Slash apply is intentionally unavailable in Phase 7.1/7.2.',
  };

  if ((report.review?.redactionCount || 0) > 0) {
    report.warnings.push('The persisted issue-comment preview was sanitized before local storage.');
  }

  return report;
}

module.exports = {
  GITHUB_ISSUE_COMMENT_DRAFT_SCHEMA_VERSION,
  buildCliApplyCommand,
  buildUsageMessage,
  draftGitHubIssueComment,
  resolveBodyInput,
};
