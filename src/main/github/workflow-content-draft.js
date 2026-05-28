const { buildCliApplyCommand } = require('./issue-comment-draft');
const { resolveGitHubRepoContext } = require('./context');
const { inspectGitHubRepository } = require('./repo-inspect');
const { createGitHubWritePreviewArtifacts } = require('./write-artifacts');
const { analyzeWorkflowDefinition, normalizeWorkflowPath, resolveWorkflowTextInput } = require('./workflow-analyzer');

const GITHUB_WORKFLOW_CREATE_DRAFT_SCHEMA_VERSION = 'github.workflow-create-draft.v1';
const GITHUB_WORKFLOW_UPDATE_DRAFT_SCHEMA_VERSION = 'github.workflow-update-draft.v1';

function normalizeText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function buildUsageMessage(verb = 'create') {
  return `Usage: liku github workflow ${verb} draft <path> (--body <text> | --body-file <path> | <path>) [--slug owner/repo] [--base <branch>] [--head <branch>] [--api false]`;
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
    .replace(/\.ya?ml$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'workflow';
}

function resolveHeadBranch(options = {}, changeOperation, workflowPath) {
  const explicitHead = normalizeText(options.head || options.branch);
  if (explicitHead) {
    return {
      headBranch: explicitHead,
      source: 'explicit-head',
    };
  }

  return {
    headBranch: `liku/workflow-${changeOperation}-${slugifyPathForBranch(workflowPath)}-${Date.now()}`,
    source: 'generated-head',
  };
}

function buildDraftText(changeOperation, workflowPath, analysis) {
  const actionLabel = changeOperation === 'create' ? 'Add' : 'Update';
  const displayName = analysis?.summary?.name || normalizeWorkflowPath(workflowPath) || 'workflow';
  const commitMessage = `${actionLabel} GitHub workflow ${displayName}`;
  const pullRequestTitle = `${actionLabel} workflow ${normalizeWorkflowPath(workflowPath)}`;
  const bulletLines = [
    `- Workflow path: \`${normalizeWorkflowPath(workflowPath)}\``,
    `- Workflow name: ${analysis?.summary?.name || 'unknown'}`,
    `- Triggers: ${(analysis?.summary?.triggers || []).join(', ') || 'none detected'}`,
    `- Jobs: ${analysis?.summary?.jobCount ?? 0}`,
  ];
  if ((analysis?.policy?.violationCount || 0) > 0) {
    bulletLines.push(`- Policy warnings: ${analysis.policy.violationCount}`);
  }

  return {
    commitMessage,
    pullRequestTitle,
    pullRequestBody: `${actionLabel} the reviewed workflow file for ${normalizeWorkflowPath(workflowPath)}.\n\n${bulletLines.join('\n')}`,
  };
}

async function draftGitHubWorkflowContentChange(options = {}, spec = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const writeFeatureFlagEnabled = options.writeFeatureFlagEnabled === true;
  const context = resolveGitHubRepoContext(options);
  const source = String(options.source || 'unknown').trim() || 'unknown';
  const approvalMode = String(options.approvalMode || 'prompt').trim() || 'prompt';
  const approvalRequirement = String(options.approvalRequirement || 'explicit').trim() || 'explicit';
  const workflowPathArgument = options.path || options.workflowPath || options['workflow-path'] || options.filePath || options.positionalsPath || null;
  const input = resolveWorkflowTextInput({
    ...options,
    path: workflowPathArgument,
    usageMessage: buildUsageMessage(spec.changeOperation || 'create'),
    requirePath: true,
    emptyBodyMessage: 'GitHub workflow drafts require non-empty workflow YAML.',
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
    workflowPath: normalizeWorkflowPath(workflowPathArgument),
    previewId: null,
    review: null,
    previewArtifact: null,
    approvalArtifact: null,
    eventLog: null,
    validation: null,
    permissions: null,
    requirements: null,
    draft: null,
    approval: null,
    instructions: null,
    warnings: context.warnings.slice(),
  };

  if (!context.target.raw) {
    report.success = false;
    report.error = 'TARGET_REQUIRED';
    report.message = 'GitHub workflow drafts require a GitHub repository target. Use --slug owner/repo when no git remote is available.';
    return report;
  }

  if (!context.target.isGitHub || !context.target.slug) {
    report.success = false;
    report.error = 'TARGET_NOT_GITHUB';
    report.message = 'GitHub workflow drafts require a GitHub repository target.';
    return report;
  }

  if (!input.ok) {
    report.success = false;
    report.error = input.error;
    report.message = input.message;
    return report;
  }

  const workflowPath = normalizeWorkflowPath(input.workflowPath || workflowPathArgument);
  if (!workflowPath) {
    report.success = false;
    report.error = 'USAGE';
    report.message = buildUsageMessage(spec.changeOperation || 'create');
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
    report.message = 'GitHub workflow drafts require a base branch. Use --base <branch> or allow API default-branch inspection.';
    return report;
  }

  const headResolution = resolveHeadBranch(options, spec.changeOperation, workflowPath);
  const analysis = analyzeWorkflowDefinition({
    text: input.body,
    workflowPath,
  });
  const draftText = buildDraftText(spec.changeOperation, workflowPath, analysis);

  const previewArtifacts = createGitHubWritePreviewArtifacts({
    source,
    capabilityKey: spec.capabilityKey,
    previewType: 'repo-content-patch',
    approvalRequirement,
    approvalMode,
    title: draftText.commitMessage,
    body: input.body,
    bodySource: input.bodySource,
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: {
      kind: 'repo-content-patch',
      resourceFamily: 'workflow',
      slug: context.target.slug,
      owner: context.target.owner,
      repo: context.target.repo,
      apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
      path: workflowPath,
      changeOperation: spec.changeOperation,
      baseBranch: baseResolution.baseBranch,
      headBranch: headResolution.headBranch,
      commitMessage: draftText.commitMessage,
      pullRequestTitle: draftText.pullRequestTitle,
      pullRequestBody: draftText.pullRequestBody,
      pullRequestDraft: true,
      htmlUrl: context.target.htmlUrl ? `${context.target.htmlUrl}/blob/${baseResolution.baseBranch}/${workflowPath}` : null,
    },
    targetSource: context.targetSource,
    inputMetadata: {
      bodyFilePath: input.bodyFilePath,
      workflowPath,
    },
    metadata: {
      commandSurface: source,
      draftKind: 'workflow-content',
      writeTargetClass: 'repo-content-patch',
      riskLevel: 'medium',
      requiredPermissions: ['contents:write', 'pull_requests:write'],
      resourceFamily: 'workflow',
    },
  });

  report.workflowPath = workflowPath;
  report.previewId = previewArtifacts.previewId;
  report.review = previewArtifacts.review;
  report.previewArtifact = previewArtifacts.previewArtifact;
  report.approvalArtifact = previewArtifacts.approvalArtifact;
  report.eventLog = previewArtifacts.eventLog;
  report.validation = analysis.validation;
  report.permissions = analysis.permissions;
  report.requirements = analysis.requirements;
  report.draft = {
    type: 'workflow-content',
    changeOperation: spec.changeOperation,
    workflowPath,
    bodySource: input.bodySource,
    bodyFilePath: input.bodyFilePath,
    bodyPreview: previewArtifacts.previewRecord?.input?.bodyPreview || '',
    bodyStats: previewArtifacts.previewRecord?.input?.bodyStats || null,
    commitMessagePreview: previewArtifacts.previewRecord?.input?.titlePreview || draftText.commitMessage,
    baseBranch: baseResolution.baseBranch,
    headBranch: headResolution.headBranch,
    pullRequestTitle: draftText.pullRequestTitle,
    pullRequestBodyPreview: draftText.pullRequestBody.slice(0, 240),
    validation: analysis.validation,
    policyViolationCount: analysis.policy.violationCount,
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
    note: 'Review the workflow patch preview before running the CLI apply command. Apply opens a dedicated draft pull request instead of mutating the default branch directly.',
  };

  report.warnings.push(...analysis.warnings);
  if (!analysis.validation.valid) {
    report.warnings.push('The reviewed workflow preview includes validation issues; inspect the validation report before applying it.');
  }
  if ((analysis.policy?.violationCount || 0) > 0) {
    report.warnings.push('The reviewed workflow preview violates one or more workflow hardening policy checks.');
  }

  return report;
}

function draftGitHubWorkflowCreate(options = {}) {
  return draftGitHubWorkflowContentChange({
    ...options,
  }, {
    capabilityKey: 'workflow.create.draft',
    changeOperation: 'create',
    schemaVersion: GITHUB_WORKFLOW_CREATE_DRAFT_SCHEMA_VERSION,
  });
}

function draftGitHubWorkflowUpdate(options = {}) {
  return draftGitHubWorkflowContentChange({
    ...options,
  }, {
    capabilityKey: 'workflow.update.draft',
    changeOperation: 'update',
    schemaVersion: GITHUB_WORKFLOW_UPDATE_DRAFT_SCHEMA_VERSION,
  });
}

module.exports = {
  GITHUB_WORKFLOW_CREATE_DRAFT_SCHEMA_VERSION,
  GITHUB_WORKFLOW_UPDATE_DRAFT_SCHEMA_VERSION,
  buildUsageMessage,
  draftGitHubWorkflowCreate,
  draftGitHubWorkflowUpdate,
};
