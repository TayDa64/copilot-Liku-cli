const fs = require('fs');
const path = require('path');

const { resolveGitHubRepoContext } = require('./context');
const { resolveCurrentGitBranch } = require('./git-branch');
const { buildCliApplyCommand } = require('./issue-comment-draft');
const { inspectGitHubRepository } = require('./repo-inspect');
const { createGitHubWritePreviewArtifacts } = require('./write-artifacts');

const GITHUB_PR_CREATE_DRAFT_SCHEMA_VERSION = 'github.pr-create-draft.v1';

function buildUsageMessage() {
  return 'Usage: liku github pr create draft --title <text> [--body <text> | --body-file <path>] [--base <branch>] [--head <branch|owner:branch>] [--draft <bool>] [--slug owner/repo] [--api false]';
}

function parseBooleanOption(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function resolveOptionalBodyInput(options = {}) {
  const usageMessage = String(options.usageMessage || buildUsageMessage()).trim() || buildUsageMessage();
  const inlineBody = typeof options.body === 'string' ? options.body : null;
  const bodyFileRaw = options.bodyFile || options['body-file'] || null;

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
        message: `Pull request body file not found: ${bodyFilePath}`,
      };
    }

    return {
      ok: true,
      body: fs.readFileSync(bodyFilePath, 'utf8'),
      bodySource: 'file',
      bodyFilePath,
    };
  }

  if (inlineBody !== null) {
    return {
      ok: true,
      body: inlineBody,
      bodySource: 'inline',
      bodyFilePath: null,
    };
  }

  return {
    ok: true,
    body: '',
    bodySource: 'none',
    bodyFilePath: null,
    message: usageMessage,
  };
}

function normalizeTitleInput(options = {}) {
  const title = normalizeText(options.title);
  if (!title) {
    return {
      ok: false,
      error: 'USAGE',
      message: buildUsageMessage(),
    };
  }

  return {
    ok: true,
    title,
  };
}

function extractHeadBranch(value) {
  const text = normalizeText(value);
  if (!text) {
    return null;
  }

  const separatorIndex = text.indexOf(':');
  return separatorIndex >= 0 ? text.slice(separatorIndex + 1).trim() || null : text;
}

function resolvePullRequestHead(options = {}) {
  const explicitHead = normalizeText(options.head);
  if (explicitHead) {
    return {
      head: explicitHead,
      headBranch: extractHeadBranch(explicitHead),
      source: 'explicit-head',
      available: true,
      detached: false,
      warnings: [],
    };
  }

  const detected = (typeof options.resolveCurrentGitBranch === 'function'
    ? options.resolveCurrentGitBranch
    : resolveCurrentGitBranch)({
      cwd: options.cwd || process.cwd(),
      resolveProjectIdentity: options.resolveProjectIdentity,
      fsModule: options.fsModule,
    });

  return {
    head: normalizeText(detected.currentBranch),
    headBranch: normalizeText(detected.currentBranch),
    source: normalizeText(detected.source) || 'git-head',
    available: detected.available === true,
    detached: detected.detached === true,
    warnings: Array.isArray(detected.warnings) ? detected.warnings.slice() : [],
  };
}

async function resolvePullRequestBase(options = {}) {
  const explicitBase = normalizeText(options.base);
  if (explicitBase) {
    return {
      baseBranch: explicitBase,
      source: 'explicit-base',
      available: true,
      warnings: [],
      repository: null,
    };
  }

  if (options.api === false) {
    return {
      baseBranch: null,
      source: 'api-skipped',
      available: false,
      warnings: ['GitHub repository default-branch lookup skipped by request; use --base to continue.'],
      repository: null,
    };
  }

  const repoReport = await (typeof options.inspectGitHubRepository === 'function'
    ? options.inspectGitHubRepository
    : inspectGitHubRepository)({
      ...options,
      api: true,
      slug: options.slug,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });

  const defaultBranch = normalizeText(repoReport?.githubApi?.repository?.defaultBranch);
  const warnings = Array.isArray(repoReport?.warnings) ? repoReport.warnings.slice() : [];

  if (defaultBranch) {
    return {
      baseBranch: defaultBranch,
      source: 'repo-default-branch',
      available: true,
      warnings,
      repository: repoReport.githubApi.repository,
    };
  }

  if (!warnings.some((warning) => /default branch|--base/i.test(String(warning || '')))) {
    warnings.push('Could not determine the repository default branch automatically; use --base to continue.');
  }

  return {
    baseBranch: null,
    source: 'repo-default-branch-unavailable',
    available: false,
    warnings,
    repository: repoReport?.githubApi?.repository || null,
  };
}

async function draftGitHubPullRequestCreate(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const writeFeatureFlagEnabled = options.writeFeatureFlagEnabled === true;
  const context = resolveGitHubRepoContext(options);
  const source = String(options.source || 'unknown').trim() || 'unknown';
  const approvalMode = String(options.approvalMode || 'prompt').trim() || 'prompt';
  const approvalRequirement = String(options.approvalRequirement || 'explicit').trim() || 'explicit';
  const titleInput = normalizeTitleInput(options);
  const bodyInput = resolveOptionalBodyInput(options);
  const draftPullRequest = parseBooleanOption(options.draft, false);

  const report = {
    schemaVersion: GITHUB_PR_CREATE_DRAFT_SCHEMA_VERSION,
    success: true,
    featureFlagEnabled,
    writeFeatureFlagEnabled,
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: context.target,
    targetSource: context.targetSource,
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

  if (!context.target.raw) {
    report.success = false;
    report.error = 'TARGET_REQUIRED';
    report.message = 'GitHub pull request create drafts require a GitHub repository target. Use --slug owner/repo when no git remote is available.';
    return report;
  }

  if (!context.target.isGitHub || !context.target.slug) {
    report.success = false;
    report.error = 'TARGET_NOT_GITHUB';
    report.message = 'GitHub pull request create drafts require a GitHub repository target.';
    return report;
  }

  if (!titleInput.ok) {
    report.success = false;
    report.error = titleInput.error;
    report.message = titleInput.message;
    return report;
  }

  if (!bodyInput.ok) {
    report.success = false;
    report.error = bodyInput.error;
    report.message = bodyInput.message;
    return report;
  }

  const headContext = resolvePullRequestHead(options);
  report.warnings.push(...headContext.warnings);
  if (!headContext.available || !headContext.head || !headContext.headBranch) {
    report.success = false;
    report.error = 'HEAD_REQUIRED';
    report.message = 'GitHub pull request create drafts require a current or explicit head branch. Use --head <branch|owner:branch> when the current branch is unavailable.';
    return report;
  }

  const baseContext = await resolvePullRequestBase({
    ...options,
    slug: context.target.slug,
    inspectGitHubRepository: options.inspectGitHubRepository,
  });
  report.warnings.push(...baseContext.warnings);
  if (!baseContext.available || !baseContext.baseBranch) {
    report.success = false;
    report.error = 'BASE_REQUIRED';
    report.message = 'GitHub pull request create drafts require a base branch. Use --base <branch> or allow GitHub API lookup for the repository default branch.';
    return report;
  }

  if (normalizeText(baseContext.baseBranch)?.toLowerCase() === normalizeText(headContext.headBranch)?.toLowerCase()) {
    report.success = false;
    report.error = 'HEAD_BASE_CONFLICT';
    report.message = 'GitHub pull request create drafts require different head and base branches.';
    return report;
  }

  const previewArtifacts = createGitHubWritePreviewArtifacts({
    source,
    capabilityKey: 'pr.create.draft',
    previewType: 'pr-create',
    approvalRequirement,
    approvalMode,
    title: titleInput.title,
    body: bodyInput.body,
    bodySource: bodyInput.bodySource,
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: {
      kind: 'pr-create',
      slug: context.target.slug,
      owner: context.target.owner,
      repo: context.target.repo,
      apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
      baseBranch: baseContext.baseBranch,
      baseSource: baseContext.source,
      head: headContext.head,
      headBranch: headContext.headBranch,
      headSource: headContext.source,
      draft: draftPullRequest,
      htmlUrl: context.target.htmlUrl || null,
    },
    targetSource: context.targetSource,
    inputMetadata: {
      bodyFilePath: bodyInput.bodyFilePath,
      baseSource: baseContext.source,
      headSource: headContext.source,
    },
    metadata: {
      commandSurface: source,
      draftKind: 'pr-create',
      repositoryDefaultBranch: baseContext.repository?.defaultBranch || null,
    },
    includeApplyToken: source === 'cli',
  });

  report.previewId = previewArtifacts.previewId;
  report.review = previewArtifacts.review;
  report.previewArtifact = previewArtifacts.previewArtifact;
  report.approvalArtifact = previewArtifacts.approvalArtifact;
  report.eventLog = previewArtifacts.eventLog;
  report.draft = {
    type: 'pr-create',
    titlePreview: previewArtifacts.previewRecord?.input?.titlePreview || titleInput.title,
    titleStats: previewArtifacts.previewRecord?.input?.titleStats || null,
    bodySource: bodyInput.bodySource,
    bodyFilePath: bodyInput.bodyFilePath,
    bodyPreview: previewArtifacts.previewRecord?.input?.bodyPreview || '',
    bodyStats: previewArtifacts.previewRecord?.input?.bodyStats || null,
    baseBranch: baseContext.baseBranch,
    baseSource: baseContext.source,
    head: headContext.head,
    headBranch: headContext.headBranch,
    headSource: headContext.source,
    draft: draftPullRequest,
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
    report.warnings.push('The persisted pull-request-create preview was sanitized before local storage.');
  }

  return report;
}

module.exports = {
  GITHUB_PR_CREATE_DRAFT_SCHEMA_VERSION,
  buildUsageMessage,
  draftGitHubPullRequestCreate,
  extractHeadBranch,
  resolveOptionalBodyInput,
  resolvePullRequestBase,
  resolvePullRequestHead,
};