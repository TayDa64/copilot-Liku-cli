const { buildCliApplyCommand, resolveBodyInput } = require('./issue-comment-draft');
const { resolveGitHubRepoContext } = require('./context');
const { inspectGitHubRepository } = require('./repo-inspect');
const { inspectGitHubCodeowners, CODEOWNERS_CANDIDATES } = require('./codeowners-inspect');
const { summarizeCodeownersText } = require('./governance-redaction');
const { createGitHubWritePreviewArtifacts } = require('./write-artifacts');

const GITHUB_CODEOWNERS_CREATE_DRAFT_SCHEMA_VERSION = 'github.codeowners-create-draft.v1';
const GITHUB_CODEOWNERS_UPDATE_DRAFT_SCHEMA_VERSION = 'github.codeowners-update-draft.v1';
const DEFAULT_CODEOWNERS_CREATE_PATH = '.github/CODEOWNERS';

function normalizeText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeCodeownersPath(value) {
  const text = normalizeText(value);
  if (!text) {
    return null;
  }

  return text
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .trim() || null;
}

function isSupportedCodeownersPath(value) {
  const normalized = normalizeCodeownersPath(value);
  return Boolean(normalized) && CODEOWNERS_CANDIDATES.includes(normalized);
}

function buildUsageMessage(verb = 'create') {
  return `Usage: liku github codeowners ${verb} draft [--path <${CODEOWNERS_CANDIDATES.join('|')}>] (--body <text> | --body-file <path>) [--slug owner/repo] [--base <branch>] [--head <branch>] [--api false]`;
}

async function resolveBaseBranch(options = {}) {
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

function slugifyPathForBranch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'codeowners';
}

function resolveHeadBranch(options = {}, changeOperation, codeownersPath) {
  const explicitHead = normalizeText(options.head || options.branch);
  if (explicitHead) {
    return {
      headBranch: explicitHead,
      source: 'explicit-head',
    };
  }

  return {
    headBranch: `liku/codeowners-${changeOperation}-${slugifyPathForBranch(codeownersPath)}-${Date.now()}`,
    source: 'generated-head',
  };
}

async function resolveCodeownersTargetPath(options = {}, context, changeOperation) {
  const explicitPath = normalizeCodeownersPath(options.path || options.codeownersPath || options['codeowners-path']);
  if (explicitPath && !isSupportedCodeownersPath(explicitPath)) {
    return {
      ok: false,
      error: 'INVALID_CODEOWNERS_PATH',
      message: `GitHub CODEOWNERS drafts only support standard locations: ${CODEOWNERS_CANDIDATES.join(', ')}.`,
      warnings: [],
    };
  }

  const inspection = await inspectGitHubCodeowners({
    cwd: options.cwd,
    env: options.env,
    featureFlagEnabled: options.featureFlagEnabled === true,
    api: options.api !== false,
    slug: context.target.slug,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  const warnings = Array.isArray(inspection?.warnings) ? inspection.warnings.slice() : [];
  const existingPath = normalizeCodeownersPath(inspection?.codeowners?.path);

  if (changeOperation === 'create') {
    if (existingPath) {
      return {
        ok: false,
        error: 'CODEOWNERS_ALREADY_EXISTS',
        message: `A CODEOWNERS file already exists at ${existingPath}; use 'liku github codeowners update draft' instead.`,
        warnings,
      };
    }

    const targetPath = explicitPath || DEFAULT_CODEOWNERS_CREATE_PATH;
    if (inspection?.githubApi?.error) {
      warnings.push('Could not confirm remote CODEOWNERS absence before drafting the create patch; apply may fail later if a CODEOWNERS file already exists.');
    }

    return {
      ok: true,
      path: targetPath,
      source: explicitPath ? 'explicit-path' : 'default-create-path',
      warnings,
      existingCodeowners: inspection?.codeowners || null,
    };
  }

  if (!existingPath) {
    return {
      ok: false,
      error: 'CODEOWNERS_NOT_FOUND',
      message: `No CODEOWNERS file was found in standard locations; use 'liku github codeowners create draft' to add one first.`,
      warnings,
    };
  }

  if (explicitPath && explicitPath !== existingPath) {
    return {
      ok: false,
      error: 'CODEOWNERS_PATH_MISMATCH',
      message: `Detected CODEOWNERS at ${existingPath}; update drafts currently require the detected standard path instead of ${explicitPath}.`,
      warnings,
    };
  }

  return {
    ok: true,
    path: existingPath,
    source: explicitPath ? 'explicit-path' : 'detected-existing-path',
    warnings,
    existingCodeowners: inspection?.codeowners || null,
  };
}

function buildDraftText(changeOperation, codeownersPath, summary) {
  const actionLabel = changeOperation === 'create' ? 'Add' : 'Update';
  const commitMessage = `${actionLabel} CODEOWNERS policy`;
  const pullRequestTitle = `${actionLabel} CODEOWNERS`;
  const bulletLines = [
    `- CODEOWNERS path: \`${codeownersPath}\``,
    `- Entries: ${summary?.entryCount ?? 0}`,
    `- Owners: ${summary?.ownerCount ?? 0}`,
  ];

  if (Array.isArray(summary?.owners) && summary.owners.length > 0) {
    bulletLines.push(`- Owner samples: ${summary.owners.slice(0, 6).join(', ')}`);
  }

  return {
    commitMessage,
    pullRequestTitle,
    pullRequestBody: `${actionLabel} the reviewed CODEOWNERS file through the dedicated repo-content patch lane.\n\n${bulletLines.join('\n')}`,
  };
}

async function draftGitHubCodeownersChange(options = {}, spec = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const writeFeatureFlagEnabled = options.writeFeatureFlagEnabled === true;
  const context = resolveGitHubRepoContext(options);
  const source = String(options.source || 'unknown').trim() || 'unknown';
  const approvalMode = String(options.approvalMode || 'prompt').trim() || 'prompt';
  const approvalRequirement = String(options.approvalRequirement || 'explicit').trim() || 'explicit';
  const bodyInput = resolveBodyInput({
    ...options,
    usageMessage: buildUsageMessage(spec.changeOperation || 'create'),
    bodyFileLabel: 'CODEOWNERS body file',
    emptyBodyMessage: 'GitHub CODEOWNERS drafts require a non-empty body.',
  });

  const report = {
    schemaVersion: spec.schemaVersion,
    success: true,
    featureFlagEnabled,
    writeFeatureFlagEnabled,
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: context.target,
    targetSource: context.targetSource,
    codeownersPath: null,
    previewId: null,
    review: null,
    previewArtifact: null,
    approvalArtifact: null,
    eventLog: null,
    codeowners: null,
    draft: null,
    approval: null,
    instructions: null,
    warnings: context.warnings.slice(),
  };

  if (!context.target.raw) {
    report.success = false;
    report.error = 'TARGET_REQUIRED';
    report.message = 'GitHub CODEOWNERS drafts require a GitHub repository target. Use --slug owner/repo when no git remote is available.';
    return report;
  }

  if (!context.target.isGitHub || !context.target.slug) {
    report.success = false;
    report.error = 'TARGET_NOT_GITHUB';
    report.message = 'GitHub CODEOWNERS drafts require a GitHub repository target.';
    return report;
  }

  if (!bodyInput.ok) {
    report.success = false;
    report.error = bodyInput.error;
    report.message = bodyInput.message;
    return report;
  }

  const targetPath = await resolveCodeownersTargetPath(options, context, spec.changeOperation);
  report.warnings.push(...targetPath.warnings);
  if (!targetPath.ok) {
    report.success = false;
    report.error = targetPath.error;
    report.message = targetPath.message;
    return report;
  }

  const baseResolution = await resolveBaseBranch({
    ...options,
    slug: context.target.slug,
  });
  report.warnings.push(...baseResolution.warnings);
  if (!baseResolution.available || !baseResolution.baseBranch) {
    report.success = false;
    report.error = 'BASE_BRANCH_REQUIRED';
    report.message = 'GitHub CODEOWNERS drafts require a base branch. Use --base <branch> or allow API default-branch inspection.';
    return report;
  }

  const headResolution = resolveHeadBranch(options, spec.changeOperation, targetPath.path);
  const summary = summarizeCodeownersText(bodyInput.body, targetPath.path);
  const draftText = buildDraftText(spec.changeOperation, targetPath.path, summary);

  const previewArtifacts = createGitHubWritePreviewArtifacts({
    source,
    capabilityKey: spec.capabilityKey,
    previewType: 'repo-content-patch',
    approvalRequirement,
    approvalMode,
    title: draftText.commitMessage,
    body: bodyInput.body,
    bodySource: bodyInput.bodySource,
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: {
      kind: 'repo-content-patch',
      resourceFamily: 'codeowners',
      slug: context.target.slug,
      owner: context.target.owner,
      repo: context.target.repo,
      apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
      path: targetPath.path,
      changeOperation: spec.changeOperation,
      baseBranch: baseResolution.baseBranch,
      headBranch: headResolution.headBranch,
      commitMessage: draftText.commitMessage,
      pullRequestTitle: draftText.pullRequestTitle,
      pullRequestBody: draftText.pullRequestBody,
      pullRequestDraft: true,
      htmlUrl: context.target.htmlUrl ? `${context.target.htmlUrl}/blob/${baseResolution.baseBranch}/${targetPath.path}` : null,
    },
    targetSource: context.targetSource,
    inputMetadata: {
      bodyFilePath: bodyInput.bodyFilePath,
      codeownersPath: targetPath.path,
      changeOperation: spec.changeOperation,
    },
    metadata: {
      commandSurface: source,
      draftKind: 'codeowners-content',
      writeTargetClass: 'repo-content-patch',
      riskLevel: 'medium',
      requiredPermissions: ['contents:write', 'pull_requests:write'],
      resourceFamily: 'codeowners',
    },
  });

  report.codeownersPath = targetPath.path;
  report.previewId = previewArtifacts.previewId;
  report.review = previewArtifacts.review;
  report.previewArtifact = previewArtifacts.previewArtifact;
  report.approvalArtifact = previewArtifacts.approvalArtifact;
  report.eventLog = previewArtifacts.eventLog;
  report.codeowners = summary;
  report.draft = {
    type: 'codeowners-content',
    changeOperation: spec.changeOperation,
    codeownersPath: targetPath.path,
    bodySource: bodyInput.bodySource,
    bodyFilePath: bodyInput.bodyFilePath,
    bodyPreview: previewArtifacts.previewRecord?.input?.bodyPreview || '',
    bodyStats: previewArtifacts.previewRecord?.input?.bodyStats || null,
    commitMessagePreview: previewArtifacts.previewRecord?.input?.titlePreview || draftText.commitMessage,
    baseBranch: baseResolution.baseBranch,
    headBranch: headResolution.headBranch,
    pullRequestTitle: draftText.pullRequestTitle,
    pullRequestBodyPreview: draftText.pullRequestBody.slice(0, 240),
    entryCount: summary?.entryCount ?? 0,
    ownerCount: summary?.ownerCount ?? 0,
    owners: Array.isArray(summary?.owners) ? summary.owners.slice() : [],
    existingSource: targetPath.source,
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
    note: 'Review the CODEOWNERS patch preview before running the CLI apply command. Apply opens a dedicated draft pull request instead of mutating the default branch directly.',
  };

  return report;
}

function draftGitHubCodeownersCreate(options = {}) {
  return draftGitHubCodeownersChange({
    ...options,
  }, {
    capabilityKey: 'codeowners.create.draft',
    changeOperation: 'create',
    schemaVersion: GITHUB_CODEOWNERS_CREATE_DRAFT_SCHEMA_VERSION,
  });
}

function draftGitHubCodeownersUpdate(options = {}) {
  return draftGitHubCodeownersChange({
    ...options,
  }, {
    capabilityKey: 'codeowners.update.draft',
    changeOperation: 'update',
    schemaVersion: GITHUB_CODEOWNERS_UPDATE_DRAFT_SCHEMA_VERSION,
  });
}

module.exports = {
  DEFAULT_CODEOWNERS_CREATE_PATH,
  GITHUB_CODEOWNERS_CREATE_DRAFT_SCHEMA_VERSION,
  GITHUB_CODEOWNERS_UPDATE_DRAFT_SCHEMA_VERSION,
  buildUsageMessage,
  draftGitHubCodeownersCreate,
  draftGitHubCodeownersUpdate,
  normalizeCodeownersPath,
};
