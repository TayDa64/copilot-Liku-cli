const fs = require('fs');
const path = require('path');

const { buildCliApplyCommand } = require('./issue-comment-draft');
const { resolveGitHubRepoContext } = require('./context');
const { resolveCurrentGitBranch } = require('./git-branch');
const { createGitHubWritePreviewArtifacts } = require('./write-artifacts');

const GITHUB_WORKFLOW_DISPATCH_DRAFT_SCHEMA_VERSION = 'github.workflow-dispatch-draft.v1';
const GITHUB_WORKFLOW_RERUN_DRAFT_SCHEMA_VERSION = 'github.workflow-rerun-draft.v1';
const GITHUB_WORKFLOW_CANCEL_DRAFT_SCHEMA_VERSION = 'github.workflow-cancel-draft.v1';

function normalizeText(value) {
  const text = String(value || '').trim();
  return text || null;
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

function normalizeRunId(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function buildDispatchUsageMessage() {
  return 'Usage: liku github workflow dispatch draft <workflow-id|file> [--ref <branch|tag|sha>] [--inputs-json <json> | --inputs-file <path>] [--slug owner/repo]';
}

function buildRunUsageMessage(verb = 'rerun') {
  return `Usage: liku github workflow ${verb} draft <run-id> [--slug owner/repo]${verb === 'rerun' ? ' [--failed-only true|false]' : ''}`;
}

function resolveDispatchInputs(options = {}) {
  const inlineJson = normalizeText(options.inputsJson || options['inputs-json']);
  const inputsFileRaw = options.inputsFile || options['inputs-file'] || null;

  if (inlineJson && inputsFileRaw) {
    return {
      ok: false,
      error: 'USAGE',
      message: 'Specify either --inputs-json or --inputs-file, not both.',
    };
  }

  if (inputsFileRaw) {
    const inputsFilePath = path.resolve(String(options.cwd || process.cwd()), String(inputsFileRaw));
    if (!fs.existsSync(inputsFilePath)) {
      return {
        ok: false,
        error: 'INPUTS_FILE_NOT_FOUND',
        message: `Workflow dispatch inputs file not found: ${inputsFilePath}`,
      };
    }

    try {
      const value = JSON.parse(fs.readFileSync(inputsFilePath, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('must be a JSON object');
      }
      return {
        ok: true,
        inputs: value,
        inputsSource: 'file',
        inputsFilePath,
      };
    } catch (error) {
      return {
        ok: false,
        error: 'INVALID_INPUTS_JSON',
        message: `Workflow dispatch inputs file must contain a JSON object: ${error.message}`,
      };
    }
  }

  if (inlineJson) {
    try {
      const value = JSON.parse(inlineJson);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('must be a JSON object');
      }
      return {
        ok: true,
        inputs: value,
        inputsSource: 'inline-json',
        inputsFilePath: null,
      };
    } catch (error) {
      return {
        ok: false,
        error: 'INVALID_INPUTS_JSON',
        message: `Workflow dispatch inputs must be a JSON object: ${error.message}`,
      };
    }
  }

  return {
    ok: true,
    inputs: {},
    inputsSource: 'none',
    inputsFilePath: null,
  };
}

function resolveDispatchRef(options = {}) {
  const explicitRef = normalizeText(options.ref);
  if (explicitRef) {
    return {
      ref: explicitRef,
      source: 'explicit-ref',
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

  const branch = normalizeText(detected.currentBranch);
  if (branch) {
    return {
      ref: branch,
      source: normalizeText(detected.source) || 'git-head',
      warnings: Array.isArray(detected.warnings) ? detected.warnings.slice() : [],
    };
  }

  return {
    ref: null,
    source: normalizeText(detected.source) || 'git-head',
    warnings: ['Could not determine a default workflow dispatch ref automatically; use --ref <branch|tag|sha>.'],
  };
}

function buildDispatchTitle(workflow, ref) {
  return `Dispatch workflow ${workflow} on ${ref}`;
}

function buildRunTitle(verb, runId, failedOnly) {
  if (verb === 'rerun') {
    return failedOnly ? `Rerun failed jobs for workflow run ${runId}` : `Rerun workflow run ${runId}`;
  }
  return `Cancel workflow run ${runId}`;
}

function buildSharedReport(options = {}, context, schemaVersion) {
  return {
    schemaVersion,
    success: true,
    featureFlagEnabled: options.featureFlagEnabled === true,
    writeFeatureFlagEnabled: options.writeFeatureFlagEnabled === true,
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
}

function finalizePreviewReport(report, previewArtifacts, approvalRequirement, approvalMode, source, note) {
  report.previewId = previewArtifacts.previewId;
  report.review = previewArtifacts.review;
  report.previewArtifact = previewArtifacts.previewArtifact;
  report.approvalArtifact = previewArtifacts.approvalArtifact;
  report.eventLog = previewArtifacts.eventLog;
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
    note,
  };
  return report;
}

function draftGitHubWorkflowDispatch(options = {}) {
  const context = resolveGitHubRepoContext(options);
  const report = buildSharedReport(options, context, GITHUB_WORKFLOW_DISPATCH_DRAFT_SCHEMA_VERSION);
  const source = String(options.source || 'unknown').trim() || 'unknown';
  const approvalMode = String(options.approvalMode || 'prompt').trim() || 'prompt';
  const approvalRequirement = String(options.approvalRequirement || 'explicit').trim() || 'explicit';
  const workflow = normalizeText(options.workflow || options.workflowId || options.positionalsWorkflow);
  const refResolution = resolveDispatchRef(options);
  const inputsResolution = resolveDispatchInputs(options);

  if (!context.target.raw) {
    report.success = false;
    report.error = 'TARGET_REQUIRED';
    report.message = 'GitHub workflow dispatch drafts require a GitHub repository target. Use --slug owner/repo when no git remote is available.';
    return report;
  }

  if (!context.target.isGitHub || !context.target.slug) {
    report.success = false;
    report.error = 'TARGET_NOT_GITHUB';
    report.message = 'GitHub workflow dispatch drafts require a GitHub repository target.';
    return report;
  }

  if (!workflow) {
    report.success = false;
    report.error = 'USAGE';
    report.message = buildDispatchUsageMessage();
    return report;
  }

  report.warnings.push(...refResolution.warnings);
  if (!refResolution.ref) {
    report.success = false;
    report.error = 'REF_REQUIRED';
    report.message = 'GitHub workflow dispatch drafts require a ref. Use --ref <branch|tag|sha> when the current git branch cannot be determined.';
    return report;
  }

  if (!inputsResolution.ok) {
    report.success = false;
    report.error = inputsResolution.error;
    report.message = inputsResolution.message;
    return report;
  }

  const inputsText = Object.keys(inputsResolution.inputs).length > 0
    ? JSON.stringify(inputsResolution.inputs, null, 2)
    : '';
  const previewArtifacts = createGitHubWritePreviewArtifacts({
    source,
    capabilityKey: 'workflow.dispatch.draft',
    previewType: 'workflow-dispatch',
    approvalRequirement,
    approvalMode,
    title: buildDispatchTitle(workflow, refResolution.ref),
    body: inputsText,
    bodySource: inputsResolution.inputsSource,
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: {
      kind: 'workflow-dispatch',
      slug: context.target.slug,
      owner: context.target.owner,
      repo: context.target.repo,
      apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
      workflow,
      ref: refResolution.ref,
      inputs: inputsResolution.inputs,
      htmlUrl: context.target.htmlUrl || null,
    },
    targetSource: context.targetSource,
    inputMetadata: {
      inputsFilePath: inputsResolution.inputsFilePath,
      inputsCount: Object.keys(inputsResolution.inputs).length,
    },
    metadata: {
      commandSurface: source,
      draftKind: 'workflow-dispatch',
      writeTargetClass: 'direct-api',
      riskLevel: 'low',
      requiredPermissions: ['actions:write'],
      resourceFamily: 'workflow',
    },
  });

  report.draft = {
    type: 'workflow-dispatch',
    workflow,
    ref: refResolution.ref,
    refSource: refResolution.source,
    inputsSource: inputsResolution.inputsSource,
    inputsFilePath: inputsResolution.inputsFilePath,
    inputsCount: Object.keys(inputsResolution.inputs).length,
    inputsPreview: previewArtifacts.previewRecord?.input?.bodyPreview || '',
  };

  return finalizePreviewReport(
    report,
    previewArtifacts,
    approvalRequirement,
    approvalMode,
    source,
    'Review the workflow dispatch preview before running the CLI apply command. Dispatch apply triggers the target workflow but remains CLI-only.'
  );
}

function draftGitHubWorkflowRerun(options = {}) {
  const context = resolveGitHubRepoContext(options);
  const report = buildSharedReport(options, context, GITHUB_WORKFLOW_RERUN_DRAFT_SCHEMA_VERSION);
  const source = String(options.source || 'unknown').trim() || 'unknown';
  const approvalMode = String(options.approvalMode || 'prompt').trim() || 'prompt';
  const approvalRequirement = String(options.approvalRequirement || 'explicit').trim() || 'explicit';
  const runId = normalizeRunId(options.runId || options.positionalsRunId || options.id);
  const failedOnly = parseBooleanOption(options.failedOnly || options['failed-only'], false);

  if (!context.target.raw) {
    report.success = false;
    report.error = 'TARGET_REQUIRED';
    report.message = 'GitHub workflow rerun drafts require a GitHub repository target. Use --slug owner/repo when no git remote is available.';
    return report;
  }

  if (!context.target.isGitHub || !context.target.slug) {
    report.success = false;
    report.error = 'TARGET_NOT_GITHUB';
    report.message = 'GitHub workflow rerun drafts require a GitHub repository target.';
    return report;
  }

  if (!runId) {
    report.success = false;
    report.error = 'USAGE';
    report.message = buildRunUsageMessage('rerun');
    return report;
  }

  const previewArtifacts = createGitHubWritePreviewArtifacts({
    source,
    capabilityKey: 'workflow.rerun.draft',
    previewType: 'workflow-rerun',
    approvalRequirement,
    approvalMode,
    title: buildRunTitle('rerun', runId, failedOnly),
    body: '',
    bodySource: 'none',
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: {
      kind: 'workflow-rerun',
      slug: context.target.slug,
      owner: context.target.owner,
      repo: context.target.repo,
      apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
      runId,
      failedOnly,
      htmlUrl: context.target.htmlUrl || null,
    },
    targetSource: context.targetSource,
    metadata: {
      commandSurface: source,
      draftKind: 'workflow-rerun',
      writeTargetClass: 'direct-api',
      riskLevel: 'low',
      requiredPermissions: ['actions:write'],
      resourceFamily: 'workflow',
    },
  });

  report.draft = {
    type: 'workflow-rerun',
    runId,
    failedOnly,
  };

  return finalizePreviewReport(
    report,
    previewArtifacts,
    approvalRequirement,
    approvalMode,
    source,
    'Review the workflow rerun preview before running the CLI apply command. Rerun apply uses the direct GitHub Actions rerun API and remains CLI-only.'
  );
}

function draftGitHubWorkflowCancel(options = {}) {
  const context = resolveGitHubRepoContext(options);
  const report = buildSharedReport(options, context, GITHUB_WORKFLOW_CANCEL_DRAFT_SCHEMA_VERSION);
  const source = String(options.source || 'unknown').trim() || 'unknown';
  const approvalMode = String(options.approvalMode || 'prompt').trim() || 'prompt';
  const approvalRequirement = String(options.approvalRequirement || 'explicit').trim() || 'explicit';
  const runId = normalizeRunId(options.runId || options.positionalsRunId || options.id);

  if (!context.target.raw) {
    report.success = false;
    report.error = 'TARGET_REQUIRED';
    report.message = 'GitHub workflow cancel drafts require a GitHub repository target. Use --slug owner/repo when no git remote is available.';
    return report;
  }

  if (!context.target.isGitHub || !context.target.slug) {
    report.success = false;
    report.error = 'TARGET_NOT_GITHUB';
    report.message = 'GitHub workflow cancel drafts require a GitHub repository target.';
    return report;
  }

  if (!runId) {
    report.success = false;
    report.error = 'USAGE';
    report.message = buildRunUsageMessage('cancel');
    return report;
  }

  const previewArtifacts = createGitHubWritePreviewArtifacts({
    source,
    capabilityKey: 'workflow.cancel.draft',
    previewType: 'workflow-cancel',
    approvalRequirement,
    approvalMode,
    title: buildRunTitle('cancel', runId, false),
    body: '',
    bodySource: 'none',
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: {
      kind: 'workflow-cancel',
      slug: context.target.slug,
      owner: context.target.owner,
      repo: context.target.repo,
      apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
      runId,
      htmlUrl: context.target.htmlUrl || null,
    },
    targetSource: context.targetSource,
    metadata: {
      commandSurface: source,
      draftKind: 'workflow-cancel',
      writeTargetClass: 'direct-api',
      riskLevel: 'low',
      requiredPermissions: ['actions:write'],
      resourceFamily: 'workflow',
    },
  });

  report.draft = {
    type: 'workflow-cancel',
    runId,
  };

  return finalizePreviewReport(
    report,
    previewArtifacts,
    approvalRequirement,
    approvalMode,
    source,
    'Review the workflow cancel preview before running the CLI apply command. Cancel apply uses the direct GitHub Actions cancel API and remains CLI-only.'
  );
}

module.exports = {
  GITHUB_WORKFLOW_CANCEL_DRAFT_SCHEMA_VERSION,
  GITHUB_WORKFLOW_DISPATCH_DRAFT_SCHEMA_VERSION,
  GITHUB_WORKFLOW_RERUN_DRAFT_SCHEMA_VERSION,
  buildDispatchUsageMessage,
  buildRunUsageMessage,
  draftGitHubWorkflowCancel,
  draftGitHubWorkflowDispatch,
  draftGitHubWorkflowRerun,
  resolveDispatchInputs,
};
