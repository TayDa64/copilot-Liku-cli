const { writeTelemetry } = require('../telemetry/telemetry-writer');
const { findGitHubCapability } = require('./capability-registry');
const { evaluateGitHubCapabilityPolicy } = require('./capability-policy');
const { inspectGitHubCapabilityCatalogEntry, listGitHubCapabilityCatalog } = require('./capability-inspect');
const { buildGitHubContextBundle } = require('./context-bundle');
const { applyGitHubWritePreview } = require('./write-apply');
const { draftGitHubCodeownersCreate, draftGitHubCodeownersUpdate } = require('./codeowners-draft');
const { draftGitHubIssueComment } = require('./issue-comment-draft');
const { inspectGitHubPullRequestFeedback } = require('./pr-feedback');
const { draftGitHubPullRequestReview } = require('./pr-review-draft');
const { draftGitHubPullRequestClose, draftGitHubPullRequestReopen } = require('./pr-state-draft');
const { draftGitHubPullRequestCreate } = require('./pr-create-draft');
const { draftGitHubPullRequestComment } = require('./pr-comment-draft');
const { draftGitHubWebhookCreate, draftGitHubWebhookPing, draftGitHubWebhookUpdate } = require('./webhook-draft');
const { draftGitHubWorkflowCreate, draftGitHubWorkflowUpdate } = require('./workflow-content-draft');
const { draftGitHubWorkflowCancel, draftGitHubWorkflowDispatch, draftGitHubWorkflowRerun } = require('./workflow-run-draft');
const { inspectGitHubWorkflowPermissions } = require('./workflow-permissions-inspect');
const { inspectGitHubWorkflowRequirements } = require('./workflow-requirements-inspect');
const { inspectGitHubPullRequestStatus } = require('./pr-status');
const { buildGitHubExecutionPlan } = require('./plan-builder');
const { executeGitHubExecutionPlan, resumeGitHubExecutionPlan } = require('./plan-executor');
const { inspectGitHubPlanRun } = require('./plan-run-inspect');
const { listGitHubPlanRuns } = require('./plan-run-list');
const {
  appendGitHubPlanEvent,
  readGitHubPlanArtifact,
  readGitHubPlanEventLog,
  readGitHubPlanGuidanceArtifact,
  readGitHubPlanResultArtifact,
  writeGitHubPlanArtifact,
  writeGitHubPlanGuidanceArtifact,
  writeGitHubPlanResultArtifact,
} = require('./plan-artifacts');
const { resolveGitHubAuthStatus } = require('./auth-status');
const { inspectGitHubAppInstallation } = require('./app-installation-inspect');
const { inspectGitHubAppPermissions } = require('./app-permissions-inspect');
const { inspectGitHubAppStatus } = require('./app-status');
const { inspectGitHubCodeowners } = require('./codeowners-inspect');
const { inspectGitHubEvent } = require('./event-inspect');
const { inspectGitHubEnvironment } = require('./environment-inspect');
const { listGitHubEnvironments } = require('./environment-list');
const { listGitHubEvents } = require('./event-list');
const { inspectGitHubRepository } = require('./repo-inspect');
const { inspectGitHubRuleset } = require('./ruleset-inspect');
const { listGitHubRulesets } = require('./ruleset-list');
const { inspectGitHubSecret } = require('./secret-inspect');
const { listGitHubSecrets } = require('./secret-list');
const { inspectGitHubTemplates } = require('./template-inspect');
const { inspectGitHubVariable } = require('./variable-inspect');
const { listGitHubVariables } = require('./variable-list');
const { inspectGitHubWebhook } = require('./webhook-inspect');
const { listGitHubWebhooks } = require('./webhook-list');
const { inspectGitHubIssue } = require('./issue-inspect');
const { listGitHubIssues } = require('./issues-list');
const { inspectGitHubPullRequestDiff } = require('./pr-diff-summary');
const { listGitHubPullRequests } = require('./pr-list');
const { inspectGitHubPullRequest } = require('./pr-inspect');
const { inspectGitHubRelease } = require('./release-inspect');
const { listGitHubReleases } = require('./releases-list');
const { inspectGitHubWorkflowRun } = require('./workflow-inspect');
const { listGitHubWorkflowRuns } = require('./workflow-runs');
const { validateGitHubWorkflow } = require('./workflow-validate');

function parseBooleanOption(value, fallback = true) {
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

function normalizeArea(area) {
  const value = String(area || '').trim().toLowerCase();
  if (value === 'issue') return 'issues';
  if (value === 'workflows') return 'workflow';
  if (value === 'release') return 'releases';
  if (value === 'rulesets') return 'ruleset';
  if (value === 'environments') return 'environment';
  if (value === 'events') return 'event';
  if (value === 'secrets') return 'secret';
  if (value === 'variables') return 'variable';
  if (value === 'codeowner') return 'codeowners';
  if (value === 'templates') return 'template';
  if (value === 'hooks') return 'webhook';
  if (value === 'webhooks') return 'webhook';
  if (value === 'apps') return 'app';
  return value;
}

function normalizeAction(area, action, positionals = []) {
  const normalizedAction = String(action || '').trim().toLowerCase();
  if (area === 'issues'
    && normalizedAction === 'comment'
    && String(positionals[2] || '').trim().toLowerCase() === 'draft') {
    return 'comment-draft';
  }
  if (area === 'pr' && normalizedAction === 'view') {
    return 'status';
  }
  if (area === 'pr'
    && normalizedAction === 'create'
    && String(positionals[2] || '').trim().toLowerCase() === 'draft') {
    return 'create-draft';
  }
  if (area === 'pr'
    && normalizedAction === 'comment'
    && String(positionals[2] || '').trim().toLowerCase() === 'draft') {
    return 'comment-draft';
  }
  if (area === 'pr'
    && normalizedAction === 'review'
    && String(positionals[2] || '').trim().toLowerCase() === 'draft') {
    return 'review-draft';
  }
  if (area === 'pr'
    && normalizedAction === 'close'
    && String(positionals[2] || '').trim().toLowerCase() === 'draft') {
    return 'close-draft';
  }
  if (area === 'pr'
    && normalizedAction === 'reopen'
    && String(positionals[2] || '').trim().toLowerCase() === 'draft') {
    return 'reopen-draft';
  }
  if (area === 'workflow' && normalizedAction === 'permissions'
    && String(positionals[2] || '').trim().toLowerCase() === 'inspect') {
    return 'permissions-inspect';
  }
  if (area === 'workflow' && normalizedAction === 'requirements'
    && String(positionals[2] || '').trim().toLowerCase() === 'inspect') {
    return 'requirements-inspect';
  }
  if (area === 'app' && normalizedAction === 'installation'
    && String(positionals[2] || '').trim().toLowerCase() === 'inspect') {
    return 'installation-inspect';
  }
  if (area === 'app' && normalizedAction === 'permissions'
    && String(positionals[2] || '').trim().toLowerCase() === 'inspect') {
    return 'permissions-inspect';
  }
  if (area === 'codeowners'
    && ['create', 'update'].includes(normalizedAction)
    && String(positionals[2] || '').trim().toLowerCase() === 'draft') {
    return `${normalizedAction}-draft`;
  }
  if (area === 'webhook'
    && ['create', 'update', 'ping'].includes(normalizedAction)
    && String(positionals[2] || '').trim().toLowerCase() === 'draft') {
    return `${normalizedAction}-draft`;
  }
  if (area === 'workflow'
    && ['create', 'update', 'dispatch', 'rerun', 'cancel'].includes(normalizedAction)
    && String(positionals[2] || '').trim().toLowerCase() === 'draft') {
    return `${normalizedAction}-draft`;
  }
  if (area === 'apply') {
    return normalizedAction === 'execute' ? 'execute' : 'execute';
  }
  return normalizedAction;
}

function normalizeRuntimeOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return {};
  }
  return { ...options };
}

function buildCapabilityEnvelope(capability) {
  if (!capability || typeof capability !== 'object') {
    return null;
  }

  return {
    key: capability.key,
    area: capability.area,
    action: capability.action,
    description: capability.description,
    responseSchemaVersion: capability.responseSchemaVersion || null,
    sideEffectClass: capability.sideEffectClass,
    approvalRequirement: capability.approvalRequirement,
    riskLevel: capability.riskLevel,
    supportsDryRun: capability.supportsDryRun === true,
    writeTargetClass: capability.writeTargetClass || null,
    requiredPermissions: Array.isArray(capability.requiredPermissions) ? capability.requiredPermissions.slice() : [],
    allowedSources: Array.isArray(capability.allowedSources) ? capability.allowedSources.slice() : [],
    positionalArguments: Array.isArray(capability.positionalArguments) ? capability.positionalArguments.slice() : [],
    optionKeys: Array.isArray(capability.optionKeys) ? capability.optionKeys.slice() : [],
  };
}

function attachCapabilityMetadata(report, capability, policy) {
  const baseReport = report && typeof report === 'object'
    ? { ...report }
    : {
        success: false,
        error: 'INVALID_REPORT',
        message: 'GitHub command adapter returned an invalid result.',
      };

  baseReport.capability = buildCapabilityEnvelope(capability);
  baseReport.policy = policy && typeof policy === 'object'
    ? { ...policy }
    : null;

  return baseReport;
}

function buildUnknownUsageReport(area, action) {
  return {
    success: false,
    error: 'USAGE',
    message: `Unknown github command: ${[area, action].filter(Boolean).join(' ') || 'github'}`,
    capability: null,
    policy: {
      allowed: false,
      reason: 'unknown-capability',
      source: null,
      capabilityKey: null,
      sideEffectClass: null,
      riskLevel: null,
      approvalRequirement: null,
      approvalMode: 'default',
      requiresApproval: false,
      dryRunRequested: false,
      effectiveDryRun: false,
    },
  };
}

function buildPolicyDeniedReport(capability, policy) {
  return {
    success: false,
    error: 'POLICY_DENIED',
    message: `GitHub capability ${capability.key} is denied by policy (${policy.reason}).`,
    capability: buildCapabilityEnvelope(capability),
    policy: { ...policy },
  };
}

function sanitizeTelemetryValue(value) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((entry) => sanitizeTelemetryValue(entry));
  }
  return String(value);
}

function sanitizeRuntimeOptionValue(key, value) {
  const normalizedKey = String(key || '').trim().toLowerCase();
  if (!normalizedKey) {
    return sanitizeTelemetryValue(value);
  }

  if (normalizedKey === 'body') {
    return `[omitted body; ${String(value || '').length} chars]`;
  }

  if (/token/.test(normalizedKey)) {
    return '[redacted token]';
  }

  if (normalizedKey === 'answers-json') {
    return '[omitted inline json]';
  }

  return sanitizeTelemetryValue(value);
}

function sanitizeRuntimeInput(capability, positionals, runtimeOptions) {
  const sanitizedOptions = {};
  const optionKeys = Array.isArray(capability?.optionKeys) ? capability.optionKeys : [];

  optionKeys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(runtimeOptions, key)) {
      sanitizedOptions[key] = sanitizeRuntimeOptionValue(key, runtimeOptions[key]);
    }
  });

  return {
    positionals: Array.isArray(positionals)
      ? positionals.slice(0, 6).map((value) => sanitizeTelemetryValue(value))
      : [],
    options: sanitizedOptions,
  };
}

function buildTelemetryPayload({
  capability,
  policy,
  report,
  source,
  positionals,
  runtimeOptions,
  featureFlagEnabled,
  writeFeatureFlagEnabled,
}) {
  const outcome = report?.success === false ? 'failure' : 'success';

  return {
    task: `github:${capability.key}`,
    phase: 'execution',
    outcome,
    actions: [
      {
        type: 'github-capability',
        capability: capability.key,
        area: capability.area,
        action: capability.action,
        source,
        sideEffectClass: capability.sideEffectClass,
        approvalRequirement: capability.approvalRequirement,
        riskLevel: capability.riskLevel,
      },
    ],
    context: {
      source,
      featureFlagEnabled: featureFlagEnabled === true,
      writeFeatureFlagEnabled: writeFeatureFlagEnabled === true,
      capability: buildCapabilityEnvelope(capability),
      policy: policy && typeof policy === 'object' ? { ...policy } : null,
      input: sanitizeRuntimeInput(capability, positionals, runtimeOptions),
      target: report?.target?.slug || null,
      repo: report?.repoIdentity?.normalizedRepoName || report?.repoIdentity?.repoName || null,
      result: {
        success: report?.success !== false,
        error: report?.error || null,
        message: report?.message || null,
        schemaVersion: report?.schemaVersion || capability.responseSchemaVersion || null,
        githubApiAttempted: report?.githubApi?.attempted === true || report?.githubApi?.probeAttempted === true,
        githubApiError: report?.githubApi?.error || null,
      },
    },
  };
}

function buildAdapterCall(capability, context, adapters) {
  const {
    aiService,
    cwd,
    env,
    featureFlagEnabled,
    writeFeatureFlagEnabled,
    positionals,
    runtimeOptions,
    source,
    executionPreferences,
    policy,
  } = context;

  switch (capability.key) {
    case 'capabilities.list':
      return {
        fn: adapters.listGitHubCapabilityCatalog,
        input: {
          featureFlagEnabled,
          writeFeatureFlagEnabled,
        },
      };
    case 'capabilities.inspect':
      return {
        fn: adapters.inspectGitHubCapabilityCatalogEntry,
        input: {
          key: positionals[2],
          featureFlagEnabled,
          writeFeatureFlagEnabled,
        },
      };
    case 'plan.build':
      return {
        fn: adapters.buildGitHubExecutionPlan,
        input: {
          source,
          positionals,
          runtimeOptions,
          executionPreferences,
          featureFlagEnabled,
        },
      };
    case 'plan.execute':
      return {
        fn: adapters.executeGitHubExecutionPlan,
        input: {
          source,
          positionals,
          runtimeOptions,
          executionPreferences,
          featureFlagEnabled,
          cwd,
          env,
          aiService,
        },
      };
    case 'plan.resume':
      return {
        fn: adapters.resumeGitHubExecutionPlan,
        input: {
          source,
          positionals,
          runtimeOptions,
          executionPreferences,
          featureFlagEnabled,
          cwd,
          env,
          aiService,
        },
      };
    case 'plan.runs':
      return {
        fn: adapters.listGitHubPlanRuns,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          slug: runtimeOptions.slug,
          limit: runtimeOptions.limit,
          state: runtimeOptions.state,
        },
      };
    case 'plan.inspect':
      return {
        fn: adapters.inspectGitHubPlanRun,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          slug: runtimeOptions.slug,
          runId: positionals[2],
          planFile: runtimeOptions.planFile || runtimeOptions['plan-file'],
          eventLogFile: runtimeOptions.eventLogFile || runtimeOptions['event-log-file'],
        },
      };
    case 'context.bundle':
      return {
        fn: adapters.buildGitHubContextBundle,
        input: {
          source,
          positionals,
          runtimeOptions: {
            ...runtimeOptions,
            outFile: runtimeOptions.outFile || runtimeOptions['out-file'] || runtimeOptions.outfile || null,
          },
          executionPreferences,
          featureFlagEnabled,
          cwd,
          env,
          aiService,
        },
      };
    case 'auth.status':
      return {
        fn: adapters.resolveGitHubAuthStatus,
        input: {
          aiService,
          env,
          featureFlagEnabled,
          probe: parseBooleanOption(runtimeOptions.probe, true),
        },
      };
    case 'repo.inspect':
      return {
        fn: adapters.inspectGitHubRepository,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
        },
      };
    case 'ruleset.list':
      return {
        fn: adapters.listGitHubRulesets,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
          limit: runtimeOptions.limit,
        },
      };
    case 'ruleset.inspect':
      return {
        fn: adapters.inspectGitHubRuleset,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
          id: positionals[2],
        },
      };
    case 'environment.list':
      return {
        fn: adapters.listGitHubEnvironments,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
          limit: runtimeOptions.limit,
        },
      };
    case 'environment.inspect':
      return {
        fn: adapters.inspectGitHubEnvironment,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
          name: positionals[2],
        },
      };
    case 'secret.list':
      return {
        fn: adapters.listGitHubSecrets,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
          limit: runtimeOptions.limit,
        },
      };
    case 'secret.inspect':
      return {
        fn: adapters.inspectGitHubSecret,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
          name: positionals[2],
        },
      };
    case 'variable.list':
      return {
        fn: adapters.listGitHubVariables,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
          limit: runtimeOptions.limit,
        },
      };
    case 'variable.inspect':
      return {
        fn: adapters.inspectGitHubVariable,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
          name: positionals[2],
        },
      };
    case 'codeowners.inspect':
      return {
        fn: adapters.inspectGitHubCodeowners,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
        },
      };
    case 'codeowners.create.draft':
      return {
        fn: adapters.draftGitHubCodeownersCreate,
        input: {
          cwd,
          env,
          source,
          featureFlagEnabled,
          writeFeatureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
          path: runtimeOptions.path,
          body: runtimeOptions.body,
          bodyFile: runtimeOptions.bodyFile || runtimeOptions['body-file'],
          base: runtimeOptions.base,
          head: runtimeOptions.head || runtimeOptions.branch,
          approvalMode: policy?.approvalMode || executionPreferences.approvalMode,
          approvalRequirement: capability.approvalRequirement,
          fetchImpl: runtimeOptions.fetchImpl,
          timeoutMs: runtimeOptions.timeoutMs,
        },
      };
    case 'codeowners.update.draft':
      return {
        fn: adapters.draftGitHubCodeownersUpdate,
        input: {
          cwd,
          env,
          source,
          featureFlagEnabled,
          writeFeatureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
          path: runtimeOptions.path,
          body: runtimeOptions.body,
          bodyFile: runtimeOptions.bodyFile || runtimeOptions['body-file'],
          base: runtimeOptions.base,
          head: runtimeOptions.head || runtimeOptions.branch,
          approvalMode: policy?.approvalMode || executionPreferences.approvalMode,
          approvalRequirement: capability.approvalRequirement,
          fetchImpl: runtimeOptions.fetchImpl,
          timeoutMs: runtimeOptions.timeoutMs,
        },
      };
    case 'template.inspect':
      return {
        fn: adapters.inspectGitHubTemplates,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
        },
      };
    case 'webhook.list':
      return {
        fn: adapters.listGitHubWebhooks,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
          limit: runtimeOptions.limit,
        },
      };
    case 'webhook.inspect':
      return {
        fn: adapters.inspectGitHubWebhook,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
          id: positionals[2],
        },
      };
    case 'webhook.create.draft':
      return {
        fn: adapters.draftGitHubWebhookCreate,
        input: {
          cwd,
          env,
          source,
          featureFlagEnabled,
          writeFeatureFlagEnabled,
          slug: runtimeOptions.slug,
          events: runtimeOptions.events,
          targetUrl: runtimeOptions.targetUrl || runtimeOptions['target-url'],
          secretRef: runtimeOptions.secretRef || runtimeOptions['secret-ref'],
          contentType: runtimeOptions.contentType || runtimeOptions['content-type'],
          active: runtimeOptions.active,
          approvalMode: policy?.approvalMode || executionPreferences.approvalMode,
          approvalRequirement: capability.approvalRequirement,
        },
      };
    case 'webhook.update.draft':
      return {
        fn: adapters.draftGitHubWebhookUpdate,
        input: {
          cwd,
          env,
          source,
          featureFlagEnabled,
          writeFeatureFlagEnabled,
          slug: runtimeOptions.slug,
          webhookId: String(positionals[2] || '').trim().toLowerCase() === 'draft' ? positionals[3] : positionals[2],
          events: runtimeOptions.events,
          targetUrl: runtimeOptions.targetUrl || runtimeOptions['target-url'],
          secretRef: runtimeOptions.secretRef || runtimeOptions['secret-ref'],
          contentType: runtimeOptions.contentType || runtimeOptions['content-type'],
          active: runtimeOptions.active,
          approvalMode: policy?.approvalMode || executionPreferences.approvalMode,
          approvalRequirement: capability.approvalRequirement,
        },
      };
    case 'webhook.ping.draft':
      return {
        fn: adapters.draftGitHubWebhookPing,
        input: {
          cwd,
          env,
          source,
          featureFlagEnabled,
          writeFeatureFlagEnabled,
          slug: runtimeOptions.slug,
          webhookId: String(positionals[2] || '').trim().toLowerCase() === 'draft' ? positionals[3] : positionals[2],
          approvalMode: policy?.approvalMode || executionPreferences.approvalMode,
          approvalRequirement: capability.approvalRequirement,
        },
      };
    case 'event.list':
      return {
        fn: adapters.listGitHubEvents,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          slug: runtimeOptions.slug,
          limit: runtimeOptions.limit,
          eventName: runtimeOptions.event,
        },
      };
    case 'event.inspect':
      return {
        fn: adapters.inspectGitHubEvent,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          slug: runtimeOptions.slug,
          eventId: positionals[2],
        },
      };
    case 'app.status':
      return {
        fn: adapters.inspectGitHubAppStatus,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          probe: parseBooleanOption(runtimeOptions.probe, true),
          slug: runtimeOptions.slug,
        },
      };
    case 'app.installation.inspect':
      return {
        fn: adapters.inspectGitHubAppInstallation,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
        },
      };
    case 'app.permissions.inspect':
      return {
        fn: adapters.inspectGitHubAppPermissions,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
        },
      };
    case 'issues.list':
      return {
        fn: adapters.listGitHubIssues,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
          state: runtimeOptions.state,
          limit: runtimeOptions.limit,
          labels: runtimeOptions.labels,
        },
      };
    case 'issues.inspect':
      return {
        fn: adapters.inspectGitHubIssue,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
          number: positionals[2],
        },
      };
    case 'issues.comment.draft':
      {
        const issueNumber = String(positionals[2] || '').trim().toLowerCase() === 'draft'
          ? positionals[3]
          : (positionals[3] || positionals[2]);
      return {
        fn: adapters.draftGitHubIssueComment,
        input: {
          cwd,
          env,
          source,
          featureFlagEnabled,
          writeFeatureFlagEnabled,
          slug: runtimeOptions.slug,
          number: issueNumber,
          body: runtimeOptions.body,
          bodyFile: runtimeOptions.bodyFile || runtimeOptions['body-file'],
          approvalMode: policy?.approvalMode || executionPreferences.approvalMode,
          approvalRequirement: capability.approvalRequirement,
        },
      };
      }
    case 'pr.list':
      return {
        fn: adapters.listGitHubPullRequests,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
          state: runtimeOptions.state,
          limit: runtimeOptions.limit,
          base: runtimeOptions.base,
          head: runtimeOptions.head,
        },
      };
    case 'pr.inspect':
      return {
        fn: adapters.inspectGitHubPullRequest,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
          number: positionals[2],
        },
      };
    case 'pr.diff':
      return {
        fn: adapters.inspectGitHubPullRequestDiff,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
          number: positionals[2],
          limit: runtimeOptions.limit,
        },
      };
    case 'pr.status':
      return {
        fn: adapters.inspectGitHubPullRequestStatus,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
          state: runtimeOptions.state,
          branch: runtimeOptions.branch,
          head: runtimeOptions.head,
        },
      };
    case 'pr.feedback':
      return {
        fn: adapters.inspectGitHubPullRequestFeedback,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
          number: positionals[2],
          state: runtimeOptions.state,
          branch: runtimeOptions.branch,
          head: runtimeOptions.head,
          limit: runtimeOptions.limit,
        },
      };
    case 'pr.create.draft':
      return {
        fn: adapters.draftGitHubPullRequestCreate,
        input: {
          cwd,
          env,
          source,
          featureFlagEnabled,
          writeFeatureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
          title: runtimeOptions.title,
          body: runtimeOptions.body,
          bodyFile: runtimeOptions.bodyFile || runtimeOptions['body-file'],
          base: runtimeOptions.base,
          head: runtimeOptions.head,
          draft: runtimeOptions.draft,
          approvalMode: policy?.approvalMode || executionPreferences.approvalMode,
          approvalRequirement: capability.approvalRequirement,
          fetchImpl: runtimeOptions.fetchImpl,
          timeoutMs: runtimeOptions.timeoutMs,
        },
      };
    case 'pr.comment.draft':
      {
        const pullRequestNumber = String(positionals[2] || '').trim().toLowerCase() === 'draft'
          ? positionals[3]
          : (positionals[3] || positionals[2]);
      return {
        fn: adapters.draftGitHubPullRequestComment,
        input: {
          cwd,
          env,
          source,
          featureFlagEnabled,
          writeFeatureFlagEnabled,
          slug: runtimeOptions.slug,
          number: pullRequestNumber,
          body: runtimeOptions.body,
          bodyFile: runtimeOptions.bodyFile || runtimeOptions['body-file'],
          approvalMode: policy?.approvalMode || executionPreferences.approvalMode,
          approvalRequirement: capability.approvalRequirement,
        },
      };
      }
    case 'pr.review.draft':
      {
        const pullRequestNumber = String(positionals[2] || '').trim().toLowerCase() === 'draft'
          ? positionals[3]
          : (positionals[3] || positionals[2]);
      return {
        fn: adapters.draftGitHubPullRequestReview,
        input: {
          cwd,
          env,
          source,
          featureFlagEnabled,
          writeFeatureFlagEnabled,
          slug: runtimeOptions.slug,
          number: pullRequestNumber,
          event: runtimeOptions.event,
          body: runtimeOptions.body,
          bodyFile: runtimeOptions.bodyFile || runtimeOptions['body-file'],
          approvalMode: policy?.approvalMode || executionPreferences.approvalMode,
          approvalRequirement: capability.approvalRequirement,
        },
      };
      }
    case 'pr.close.draft':
      {
        const pullRequestNumber = String(positionals[2] || '').trim().toLowerCase() === 'draft'
          ? positionals[3]
          : (positionals[3] || positionals[2]);
      return {
        fn: adapters.draftGitHubPullRequestClose,
        input: {
          cwd,
          env,
          source,
          featureFlagEnabled,
          writeFeatureFlagEnabled,
          slug: runtimeOptions.slug,
          number: pullRequestNumber,
          approvalMode: policy?.approvalMode || executionPreferences.approvalMode,
          approvalRequirement: capability.approvalRequirement,
        },
      };
      }
    case 'pr.reopen.draft':
      {
        const pullRequestNumber = String(positionals[2] || '').trim().toLowerCase() === 'draft'
          ? positionals[3]
          : (positionals[3] || positionals[2]);
      return {
        fn: adapters.draftGitHubPullRequestReopen,
        input: {
          cwd,
          env,
          source,
          featureFlagEnabled,
          writeFeatureFlagEnabled,
          slug: runtimeOptions.slug,
          number: pullRequestNumber,
          approvalMode: policy?.approvalMode || executionPreferences.approvalMode,
          approvalRequirement: capability.approvalRequirement,
        },
      };
      }
    case 'workflow.runs':
      return {
        fn: adapters.listGitHubWorkflowRuns,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
          workflow: runtimeOptions.workflow,
          branch: runtimeOptions.branch,
          status: runtimeOptions.status,
          event: runtimeOptions.event,
          limit: runtimeOptions.limit,
        },
      };
    case 'workflow.validate':
      return {
        fn: adapters.validateGitHubWorkflow,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          slug: runtimeOptions.slug,
          path: runtimeOptions.path || positionals[2],
          body: runtimeOptions.body,
          bodyFile: runtimeOptions.bodyFile || runtimeOptions['body-file'],
        },
      };
    case 'workflow.permissions.inspect':
      return {
        fn: adapters.inspectGitHubWorkflowPermissions,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          slug: runtimeOptions.slug,
          path: runtimeOptions.path || (String(positionals[2] || '').trim().toLowerCase() === 'inspect' ? positionals[3] : positionals[2]),
          body: runtimeOptions.body,
          bodyFile: runtimeOptions.bodyFile || runtimeOptions['body-file'],
        },
      };
    case 'workflow.requirements.inspect':
      return {
        fn: adapters.inspectGitHubWorkflowRequirements,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          slug: runtimeOptions.slug,
          path: runtimeOptions.path || (String(positionals[2] || '').trim().toLowerCase() === 'inspect' ? positionals[3] : positionals[2]),
          body: runtimeOptions.body,
          bodyFile: runtimeOptions.bodyFile || runtimeOptions['body-file'],
        },
      };
    case 'workflow.inspect':
      return {
        fn: adapters.inspectGitHubWorkflowRun,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
          runId: positionals[2],
        },
      };
    case 'workflow.create.draft':
      return {
        fn: adapters.draftGitHubWorkflowCreate,
        input: {
          cwd,
          env,
          source,
          featureFlagEnabled,
          writeFeatureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
          path: runtimeOptions.path || (String(positionals[2] || '').trim().toLowerCase() === 'draft' ? positionals[3] : positionals[2]),
          body: runtimeOptions.body,
          bodyFile: runtimeOptions.bodyFile || runtimeOptions['body-file'],
          base: runtimeOptions.base,
          head: runtimeOptions.head || runtimeOptions.branch,
          approvalMode: policy?.approvalMode || executionPreferences.approvalMode,
          approvalRequirement: capability.approvalRequirement,
          fetchImpl: runtimeOptions.fetchImpl,
          timeoutMs: runtimeOptions.timeoutMs,
        },
      };
    case 'workflow.update.draft':
      return {
        fn: adapters.draftGitHubWorkflowUpdate,
        input: {
          cwd,
          env,
          source,
          featureFlagEnabled,
          writeFeatureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
          path: runtimeOptions.path || (String(positionals[2] || '').trim().toLowerCase() === 'draft' ? positionals[3] : positionals[2]),
          body: runtimeOptions.body,
          bodyFile: runtimeOptions.bodyFile || runtimeOptions['body-file'],
          base: runtimeOptions.base,
          head: runtimeOptions.head || runtimeOptions.branch,
          approvalMode: policy?.approvalMode || executionPreferences.approvalMode,
          approvalRequirement: capability.approvalRequirement,
          fetchImpl: runtimeOptions.fetchImpl,
          timeoutMs: runtimeOptions.timeoutMs,
        },
      };
    case 'workflow.dispatch.draft':
      return {
        fn: adapters.draftGitHubWorkflowDispatch,
        input: {
          cwd,
          env,
          source,
          featureFlagEnabled,
          writeFeatureFlagEnabled,
          slug: runtimeOptions.slug,
          workflow: runtimeOptions.workflow || (String(positionals[2] || '').trim().toLowerCase() === 'draft' ? positionals[3] : positionals[2]),
          ref: runtimeOptions.ref,
          inputsJson: runtimeOptions.inputsJson || runtimeOptions['inputs-json'],
          inputsFile: runtimeOptions.inputsFile || runtimeOptions['inputs-file'],
          approvalMode: policy?.approvalMode || executionPreferences.approvalMode,
          approvalRequirement: capability.approvalRequirement,
        },
      };
    case 'workflow.rerun.draft':
      return {
        fn: adapters.draftGitHubWorkflowRerun,
        input: {
          cwd,
          env,
          source,
          featureFlagEnabled,
          writeFeatureFlagEnabled,
          slug: runtimeOptions.slug,
          runId: String(positionals[2] || '').trim().toLowerCase() === 'draft' ? positionals[3] : positionals[2],
          failedOnly: runtimeOptions.failedOnly || runtimeOptions['failed-only'],
          approvalMode: policy?.approvalMode || executionPreferences.approvalMode,
          approvalRequirement: capability.approvalRequirement,
        },
      };
    case 'workflow.cancel.draft':
      return {
        fn: adapters.draftGitHubWorkflowCancel,
        input: {
          cwd,
          env,
          source,
          featureFlagEnabled,
          writeFeatureFlagEnabled,
          slug: runtimeOptions.slug,
          runId: String(positionals[2] || '').trim().toLowerCase() === 'draft' ? positionals[3] : positionals[2],
          approvalMode: policy?.approvalMode || executionPreferences.approvalMode,
          approvalRequirement: capability.approvalRequirement,
        },
      };
    case 'releases.list':
      return {
        fn: adapters.listGitHubReleases,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
          limit: runtimeOptions.limit,
        },
      };
    case 'releases.inspect':
      return {
        fn: adapters.inspectGitHubRelease,
        input: {
          cwd,
          env,
          featureFlagEnabled,
          api: parseBooleanOption(runtimeOptions.api, true),
          slug: runtimeOptions.slug,
          selector: positionals[2],
        },
      };
    case 'github.apply': {
      const previewId = String(positionals[1] || '').trim().toLowerCase() === 'execute'
        ? positionals[2]
        : positionals[1];
      return {
        fn: adapters.applyGitHubWritePreview,
        input: {
          cwd,
          env,
          source,
          featureFlagEnabled,
          writeFeatureFlagEnabled,
          previewId,
          approve: runtimeOptions.approve,
          applyToken: runtimeOptions.applyToken || runtimeOptions['apply-token'],
          approvalFile: runtimeOptions.approvalFile || runtimeOptions['approval-file'],
          timeoutMs: runtimeOptions.timeoutMs,
          fetchImpl: runtimeOptions.fetchImpl,
        },
      };
    }
    default:
      return null;
  }
}

function createGitHubCommandExecutor(dependencies = {}) {
  const adapters = {
    buildGitHubContextBundle: dependencies.buildGitHubContextBundle || buildGitHubContextBundle,
    buildGitHubExecutionPlan: dependencies.buildGitHubExecutionPlan || buildGitHubExecutionPlan,
    draftGitHubCodeownersCreate: dependencies.draftGitHubCodeownersCreate || draftGitHubCodeownersCreate,
    draftGitHubCodeownersUpdate: dependencies.draftGitHubCodeownersUpdate || draftGitHubCodeownersUpdate,
    draftGitHubIssueComment: dependencies.draftGitHubIssueComment || draftGitHubIssueComment,
    draftGitHubPullRequestCreate: dependencies.draftGitHubPullRequestCreate || draftGitHubPullRequestCreate,
    draftGitHubPullRequestComment: dependencies.draftGitHubPullRequestComment || draftGitHubPullRequestComment,
    draftGitHubPullRequestReview: dependencies.draftGitHubPullRequestReview || draftGitHubPullRequestReview,
    draftGitHubPullRequestClose: dependencies.draftGitHubPullRequestClose || draftGitHubPullRequestClose,
    draftGitHubPullRequestReopen: dependencies.draftGitHubPullRequestReopen || draftGitHubPullRequestReopen,
    draftGitHubWebhookCreate: dependencies.draftGitHubWebhookCreate || draftGitHubWebhookCreate,
    draftGitHubWebhookUpdate: dependencies.draftGitHubWebhookUpdate || draftGitHubWebhookUpdate,
    draftGitHubWebhookPing: dependencies.draftGitHubWebhookPing || draftGitHubWebhookPing,
    draftGitHubWorkflowCreate: dependencies.draftGitHubWorkflowCreate || draftGitHubWorkflowCreate,
    draftGitHubWorkflowUpdate: dependencies.draftGitHubWorkflowUpdate || draftGitHubWorkflowUpdate,
    draftGitHubWorkflowDispatch: dependencies.draftGitHubWorkflowDispatch || draftGitHubWorkflowDispatch,
    draftGitHubWorkflowRerun: dependencies.draftGitHubWorkflowRerun || draftGitHubWorkflowRerun,
    draftGitHubWorkflowCancel: dependencies.draftGitHubWorkflowCancel || draftGitHubWorkflowCancel,
    executeGitHubExecutionPlan: dependencies.executeGitHubExecutionPlan || executeGitHubExecutionPlan,
    resumeGitHubExecutionPlan: dependencies.resumeGitHubExecutionPlan || resumeGitHubExecutionPlan,
    inspectGitHubPlanRun: dependencies.inspectGitHubPlanRun || inspectGitHubPlanRun,
    listGitHubPlanRuns: dependencies.listGitHubPlanRuns || listGitHubPlanRuns,
    applyGitHubWritePreview: dependencies.applyGitHubWritePreview || applyGitHubWritePreview,
    inspectGitHubAppInstallation: dependencies.inspectGitHubAppInstallation || inspectGitHubAppInstallation,
    inspectGitHubAppPermissions: dependencies.inspectGitHubAppPermissions || inspectGitHubAppPermissions,
    inspectGitHubAppStatus: dependencies.inspectGitHubAppStatus || inspectGitHubAppStatus,
    inspectGitHubCodeowners: dependencies.inspectGitHubCodeowners || inspectGitHubCodeowners,
    inspectGitHubEvent: dependencies.inspectGitHubEvent || inspectGitHubEvent,
    inspectGitHubEnvironment: dependencies.inspectGitHubEnvironment || inspectGitHubEnvironment,
    inspectGitHubIssue: dependencies.inspectGitHubIssue || inspectGitHubIssue,
    inspectGitHubPullRequestFeedback: dependencies.inspectGitHubPullRequestFeedback || inspectGitHubPullRequestFeedback,
    inspectGitHubPullRequest: dependencies.inspectGitHubPullRequest || inspectGitHubPullRequest,
    inspectGitHubPullRequestDiff: dependencies.inspectGitHubPullRequestDiff || inspectGitHubPullRequestDiff,
    inspectGitHubPullRequestStatus: dependencies.inspectGitHubPullRequestStatus || inspectGitHubPullRequestStatus,
    inspectGitHubCapabilityCatalogEntry: dependencies.inspectGitHubCapabilityCatalogEntry || inspectGitHubCapabilityCatalogEntry,
    listGitHubCapabilityCatalog: dependencies.listGitHubCapabilityCatalog || listGitHubCapabilityCatalog,
    inspectGitHubRelease: dependencies.inspectGitHubRelease || inspectGitHubRelease,
    inspectGitHubRepository: dependencies.inspectGitHubRepository || inspectGitHubRepository,
    inspectGitHubRuleset: dependencies.inspectGitHubRuleset || inspectGitHubRuleset,
    inspectGitHubSecret: dependencies.inspectGitHubSecret || inspectGitHubSecret,
    inspectGitHubTemplates: dependencies.inspectGitHubTemplates || inspectGitHubTemplates,
    inspectGitHubVariable: dependencies.inspectGitHubVariable || inspectGitHubVariable,
    inspectGitHubWebhook: dependencies.inspectGitHubWebhook || inspectGitHubWebhook,
    inspectGitHubWorkflowPermissions: dependencies.inspectGitHubWorkflowPermissions || inspectGitHubWorkflowPermissions,
    inspectGitHubWorkflowRequirements: dependencies.inspectGitHubWorkflowRequirements || inspectGitHubWorkflowRequirements,
    inspectGitHubWorkflowRun: dependencies.inspectGitHubWorkflowRun || inspectGitHubWorkflowRun,
    listGitHubEnvironments: dependencies.listGitHubEnvironments || listGitHubEnvironments,
    listGitHubEvents: dependencies.listGitHubEvents || listGitHubEvents,
    listGitHubIssues: dependencies.listGitHubIssues || listGitHubIssues,
    listGitHubPullRequests: dependencies.listGitHubPullRequests || listGitHubPullRequests,
    listGitHubReleases: dependencies.listGitHubReleases || listGitHubReleases,
    listGitHubRulesets: dependencies.listGitHubRulesets || listGitHubRulesets,
    listGitHubSecrets: dependencies.listGitHubSecrets || listGitHubSecrets,
    listGitHubVariables: dependencies.listGitHubVariables || listGitHubVariables,
    listGitHubWebhooks: dependencies.listGitHubWebhooks || listGitHubWebhooks,
    listGitHubWorkflowRuns: dependencies.listGitHubWorkflowRuns || listGitHubWorkflowRuns,
    validateGitHubWorkflow: dependencies.validateGitHubWorkflow || validateGitHubWorkflow,
    appendGitHubPlanEvent: dependencies.appendGitHubPlanEvent || appendGitHubPlanEvent,
    readGitHubPlanArtifact: dependencies.readGitHubPlanArtifact || readGitHubPlanArtifact,
    readGitHubPlanEventLog: dependencies.readGitHubPlanEventLog || readGitHubPlanEventLog,
    readGitHubPlanGuidanceArtifact: dependencies.readGitHubPlanGuidanceArtifact || readGitHubPlanGuidanceArtifact,
    readGitHubPlanResultArtifact: dependencies.readGitHubPlanResultArtifact || readGitHubPlanResultArtifact,
    resolveGitHubAuthStatus: dependencies.resolveGitHubAuthStatus || resolveGitHubAuthStatus,
    writeGitHubPlanArtifact: dependencies.writeGitHubPlanArtifact || writeGitHubPlanArtifact,
    writeGitHubPlanGuidanceArtifact: dependencies.writeGitHubPlanGuidanceArtifact || writeGitHubPlanGuidanceArtifact,
    writeGitHubPlanResultArtifact: dependencies.writeGitHubPlanResultArtifact || writeGitHubPlanResultArtifact,
  };

  const findCapability = typeof dependencies.findGitHubCapability === 'function'
    ? dependencies.findGitHubCapability
    : findGitHubCapability;
  const evaluatePolicy = typeof dependencies.evaluateGitHubCapabilityPolicy === 'function'
    ? dependencies.evaluateGitHubCapabilityPolicy
    : evaluateGitHubCapabilityPolicy;
  const writeTelemetryImpl = typeof dependencies.writeTelemetry === 'function'
    ? dependencies.writeTelemetry
    : writeTelemetry;
  const defaultEnv = dependencies.env || process.env;
  const defaultAiService = dependencies.aiService || null;
  const getCwd = typeof dependencies.getCwd === 'function'
    ? dependencies.getCwd
    : () => String(dependencies.cwd || process.cwd());

  async function execute(request = {}) {
    const area = normalizeArea(request.area);
    const requestedAction = String(request.action || '').trim().toLowerCase();
    const source = String(request.source || 'unknown').trim().toLowerCase() || 'unknown';
    const positionals = Array.isArray(request.positionals) ? request.positionals.slice() : [];
    const runtimeOptions = normalizeRuntimeOptions(request.options);
    const executionPreferences = request.executionPreferences && typeof request.executionPreferences === 'object'
      ? { ...request.executionPreferences }
      : {};
    const env = request.env || defaultEnv;
    const cwd = String(request.cwd || getCwd());
    const aiService = request.aiService || defaultAiService;
    const featureFlagEnabled = request.featureFlagEnabled === true || runtimeOptions?.featureFlags?.enableGitHub === true;
    const writeFeatureFlagEnabled = request.writeFeatureFlagEnabled === true || runtimeOptions?.featureFlags?.enableGitHubWrites === true;
    const action = normalizeAction(area, requestedAction, positionals);

    const capability = findCapability(area, action);
    if (!capability) {
      return buildUnknownUsageReport(area, requestedAction || action);
    }

    const policy = evaluatePolicy({
      capability,
      source,
      executionPreferences,
      runtimeOptions,
      featureFlagEnabled,
      writeFeatureFlagEnabled,
    });

    if (!policy.allowed) {
      const deniedReport = buildPolicyDeniedReport(capability, policy);
      try {
        writeTelemetryImpl(buildTelemetryPayload({
          capability,
          policy,
          report: deniedReport,
          source,
          positionals,
          runtimeOptions,
          featureFlagEnabled,
          writeFeatureFlagEnabled,
        }));
      } catch {}
      return deniedReport;
    }

    const adapterCall = buildAdapterCall(capability, {
      aiService,
      cwd,
      env,
      featureFlagEnabled,
      writeFeatureFlagEnabled,
      source,
      executionPreferences,
      positionals,
      runtimeOptions,
      policy,
    }, adapters);

    if (!adapterCall || typeof adapterCall.fn !== 'function') {
      return attachCapabilityMetadata({
        success: false,
        error: 'UNIMPLEMENTED_CAPABILITY',
        message: `GitHub capability ${capability.key} is registered but has no executor.`,
      }, capability, {
        ...policy,
        allowed: false,
        reason: 'missing-executor',
      });
    }

    try {
      const enrichedInput = capability.area === 'capabilities'
        ? {
            ...adapterCall.input,
            evaluateGitHubCapabilityPolicy: evaluatePolicy,
            executionPreferences,
            runtimeOptions,
            featureFlagEnabled,
            writeFeatureFlagEnabled,
          }
        : capability.key === 'context.bundle'
          ? {
              ...adapterCall.input,
              executeGitHubCommand: execute,
            }
        : capability.key === 'plan.execute'
          ? {
              ...adapterCall.input,
              buildGitHubExecutionPlan: adapters.buildGitHubExecutionPlan,
              evaluateGitHubCapabilityPolicy: evaluatePolicy,
              executeGitHubCommand: execute,
              appendGitHubPlanEvent: adapters.appendGitHubPlanEvent,
              findGitHubCapability: findCapability,
              readGitHubPlanArtifact: adapters.readGitHubPlanArtifact,
              readGitHubPlanEventLog: adapters.readGitHubPlanEventLog,
              readGitHubPlanGuidanceArtifact: adapters.readGitHubPlanGuidanceArtifact,
              readGitHubPlanResultArtifact: adapters.readGitHubPlanResultArtifact,
              writeGitHubPlanArtifact: adapters.writeGitHubPlanArtifact,
              writeGitHubPlanGuidanceArtifact: adapters.writeGitHubPlanGuidanceArtifact,
              writeGitHubPlanResultArtifact: adapters.writeGitHubPlanResultArtifact,
            }
          : capability.key === 'plan.resume'
            ? {
                ...adapterCall.input,
                buildGitHubExecutionPlan: adapters.buildGitHubExecutionPlan,
                evaluateGitHubCapabilityPolicy: evaluatePolicy,
                executeGitHubCommand: execute,
                appendGitHubPlanEvent: adapters.appendGitHubPlanEvent,
                findGitHubCapability: findCapability,
                readGitHubPlanArtifact: adapters.readGitHubPlanArtifact,
                readGitHubPlanEventLog: adapters.readGitHubPlanEventLog,
                readGitHubPlanGuidanceArtifact: adapters.readGitHubPlanGuidanceArtifact,
                readGitHubPlanResultArtifact: adapters.readGitHubPlanResultArtifact,
                writeGitHubPlanArtifact: adapters.writeGitHubPlanArtifact,
                writeGitHubPlanGuidanceArtifact: adapters.writeGitHubPlanGuidanceArtifact,
                writeGitHubPlanResultArtifact: adapters.writeGitHubPlanResultArtifact,
              }
          : adapterCall.input;
      const report = await adapterCall.fn(enrichedInput);
      const finalReport = attachCapabilityMetadata(report, capability, policy);
      try {
        writeTelemetryImpl(buildTelemetryPayload({
          capability,
          policy,
          report: finalReport,
          source,
          positionals,
          runtimeOptions,
          featureFlagEnabled,
          writeFeatureFlagEnabled,
        }));
      } catch {}
      return finalReport;
    } catch (error) {
      const failureReport = attachCapabilityMetadata({
        success: false,
        error: 'EXECUTION_FAILED',
        message: error?.message || `GitHub capability ${capability.key} failed unexpectedly.`,
      }, capability, policy);

      try {
        writeTelemetryImpl(buildTelemetryPayload({
          capability,
          policy,
          report: failureReport,
          source,
          positionals,
          runtimeOptions,
          featureFlagEnabled,
          writeFeatureFlagEnabled,
        }));
      } catch {}

      throw error;
    }
  }

  return {
    execute,
  };
}

module.exports = {
  createGitHubCommandExecutor,
};
