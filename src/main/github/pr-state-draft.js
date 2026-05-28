const { resolveGitHubRepoContext } = require('./context');
const { buildCliApplyCommand } = require('./issue-comment-draft');
const { normalizePullRequestNumber } = require('./pr-inspect');
const { createGitHubWritePreviewArtifacts } = require('./write-artifacts');

const GITHUB_PR_CLOSE_DRAFT_SCHEMA_VERSION = 'github.pr-close-draft.v1';
const GITHUB_PR_REOPEN_DRAFT_SCHEMA_VERSION = 'github.pr-reopen-draft.v1';

const CLOSE_SPEC = {
  schemaVersion: GITHUB_PR_CLOSE_DRAFT_SCHEMA_VERSION,
  capabilityKey: 'pr.close.draft',
  previewType: 'pr-close',
  actionLabel: 'close',
  desiredState: 'closed',
};

const REOPEN_SPEC = {
  schemaVersion: GITHUB_PR_REOPEN_DRAFT_SCHEMA_VERSION,
  capabilityKey: 'pr.reopen.draft',
  previewType: 'pr-reopen',
  actionLabel: 'reopen',
  desiredState: 'open',
};

function buildUsageMessage(actionLabel = 'close') {
  return `Usage: liku github pr ${actionLabel} draft <number> [--slug owner/repo]`;
}

function createBaseReport(options = {}, context = {}, pullRequestNumber = null, spec = CLOSE_SPEC) {
  return {
    schemaVersion: spec.schemaVersion,
    success: true,
    featureFlagEnabled: options.featureFlagEnabled === true,
    writeFeatureFlagEnabled: options.writeFeatureFlagEnabled === true,
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
}

function buildStateTarget(context = {}, pullRequestNumber = null, spec = CLOSE_SPEC) {
  return {
    kind: spec.previewType,
    slug: context.target.slug,
    owner: context.target.owner,
    repo: context.target.repo,
    apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
    pullRequestNumber,
    desiredState: spec.desiredState,
    stateAction: spec.actionLabel,
    htmlUrl: context.target.htmlUrl ? `${context.target.htmlUrl}/pull/${pullRequestNumber}` : null,
  };
}

async function draftGitHubPullRequestStateChange(options = {}, spec = CLOSE_SPEC) {
  const pullRequestNumber = normalizePullRequestNumber(options.number || options.pullRequestNumber || options.pr);
  const context = resolveGitHubRepoContext(options);
  const source = String(options.source || 'unknown').trim() || 'unknown';
  const approvalMode = String(options.approvalMode || 'prompt').trim() || 'prompt';
  const approvalRequirement = String(options.approvalRequirement || 'explicit').trim() || 'explicit';
  const report = createBaseReport(options, context, pullRequestNumber, spec);

  if (!pullRequestNumber) {
    report.success = false;
    report.error = 'USAGE';
    report.message = buildUsageMessage(spec.actionLabel);
    return report;
  }

  if (!context.target.raw) {
    report.success = false;
    report.error = 'TARGET_REQUIRED';
    report.message = `GitHub pull request ${spec.actionLabel} drafts require a GitHub repository target. Use --slug owner/repo when no git remote is available.`;
    return report;
  }

  if (!context.target.isGitHub || !context.target.slug) {
    report.success = false;
    report.error = 'TARGET_NOT_GITHUB';
    report.message = `GitHub pull request ${spec.actionLabel} drafts require a GitHub repository target.`;
    return report;
  }

  const previewArtifacts = createGitHubWritePreviewArtifacts({
    source,
    capabilityKey: spec.capabilityKey,
    previewType: spec.previewType,
    approvalRequirement,
    approvalMode,
    body: '',
    bodySource: 'none',
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: buildStateTarget(context, pullRequestNumber, spec),
    targetSource: context.targetSource,
    inputMetadata: {
      desiredState: spec.desiredState,
      stateAction: spec.actionLabel,
    },
    metadata: {
      commandSurface: source,
      draftKind: spec.previewType,
    },
    includeApplyToken: source === 'cli',
  });

  report.previewId = previewArtifacts.previewId;
  report.review = previewArtifacts.review;
  report.previewArtifact = previewArtifacts.previewArtifact;
  report.approvalArtifact = previewArtifacts.approvalArtifact;
  report.eventLog = previewArtifacts.eventLog;
  report.draft = {
    type: 'pr-state',
    pullRequestNumber,
    stateAction: spec.actionLabel,
    desiredState: spec.desiredState,
    bodySource: 'none',
    bodyPreview: '',
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

  return report;
}

async function draftGitHubPullRequestClose(options = {}) {
  return draftGitHubPullRequestStateChange(options, CLOSE_SPEC);
}

async function draftGitHubPullRequestReopen(options = {}) {
  return draftGitHubPullRequestStateChange(options, REOPEN_SPEC);
}

module.exports = {
  CLOSE_SPEC,
  GITHUB_PR_CLOSE_DRAFT_SCHEMA_VERSION,
  GITHUB_PR_REOPEN_DRAFT_SCHEMA_VERSION,
  REOPEN_SPEC,
  buildUsageMessage,
  draftGitHubPullRequestClose,
  draftGitHubPullRequestReopen,
  draftGitHubPullRequestStateChange,
};
