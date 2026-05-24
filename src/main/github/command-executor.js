const { writeTelemetry } = require('../telemetry/telemetry-writer');
const { findGitHubCapability } = require('./capability-registry');
const { evaluateGitHubCapabilityPolicy } = require('./capability-policy');
const { inspectGitHubCapabilityCatalogEntry, listGitHubCapabilityCatalog } = require('./capability-inspect');
const { buildGitHubExecutionPlan } = require('./plan-builder');
const { executeGitHubExecutionPlan, resumeGitHubExecutionPlan } = require('./plan-executor');
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
const { inspectGitHubRepository } = require('./repo-inspect');
const { inspectGitHubIssue } = require('./issue-inspect');
const { listGitHubIssues } = require('./issues-list');
const { inspectGitHubPullRequestDiff } = require('./pr-diff-summary');
const { listGitHubPullRequests } = require('./pr-list');
const { inspectGitHubPullRequest } = require('./pr-inspect');
const { inspectGitHubRelease } = require('./release-inspect');
const { listGitHubReleases } = require('./releases-list');
const { inspectGitHubWorkflowRun } = require('./workflow-inspect');
const { listGitHubWorkflowRuns } = require('./workflow-runs');

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
  return value;
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

function sanitizeRuntimeInput(capability, positionals, runtimeOptions) {
  const sanitizedOptions = {};
  const optionKeys = Array.isArray(capability?.optionKeys) ? capability.optionKeys : [];

  optionKeys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(runtimeOptions, key)) {
      sanitizedOptions[key] = sanitizeTelemetryValue(runtimeOptions[key]);
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
  const { aiService, cwd, env, featureFlagEnabled, positionals, runtimeOptions, source, executionPreferences } = context;

  switch (capability.key) {
    case 'capabilities.list':
      return {
        fn: adapters.listGitHubCapabilityCatalog,
        input: {},
      };
    case 'capabilities.inspect':
      return {
        fn: adapters.inspectGitHubCapabilityCatalogEntry,
        input: {
          key: positionals[2],
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
    default:
      return null;
  }
}

function createGitHubCommandExecutor(dependencies = {}) {
  const adapters = {
    buildGitHubExecutionPlan: dependencies.buildGitHubExecutionPlan || buildGitHubExecutionPlan,
    executeGitHubExecutionPlan: dependencies.executeGitHubExecutionPlan || executeGitHubExecutionPlan,
    resumeGitHubExecutionPlan: dependencies.resumeGitHubExecutionPlan || resumeGitHubExecutionPlan,
    inspectGitHubIssue: dependencies.inspectGitHubIssue || inspectGitHubIssue,
    inspectGitHubPullRequest: dependencies.inspectGitHubPullRequest || inspectGitHubPullRequest,
    inspectGitHubPullRequestDiff: dependencies.inspectGitHubPullRequestDiff || inspectGitHubPullRequestDiff,
    inspectGitHubCapabilityCatalogEntry: dependencies.inspectGitHubCapabilityCatalogEntry || inspectGitHubCapabilityCatalogEntry,
    listGitHubCapabilityCatalog: dependencies.listGitHubCapabilityCatalog || listGitHubCapabilityCatalog,
    inspectGitHubRelease: dependencies.inspectGitHubRelease || inspectGitHubRelease,
    inspectGitHubRepository: dependencies.inspectGitHubRepository || inspectGitHubRepository,
    inspectGitHubWorkflowRun: dependencies.inspectGitHubWorkflowRun || inspectGitHubWorkflowRun,
    listGitHubIssues: dependencies.listGitHubIssues || listGitHubIssues,
    listGitHubPullRequests: dependencies.listGitHubPullRequests || listGitHubPullRequests,
    listGitHubReleases: dependencies.listGitHubReleases || listGitHubReleases,
    listGitHubWorkflowRuns: dependencies.listGitHubWorkflowRuns || listGitHubWorkflowRuns,
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
    const action = String(request.action || '').trim().toLowerCase();
    const source = String(request.source || 'unknown').trim().toLowerCase() || 'unknown';
    const positionals = Array.isArray(request.positionals) ? request.positionals.slice() : [];
    const runtimeOptions = normalizeRuntimeOptions(request.options);
    const executionPreferences = request.executionPreferences && typeof request.executionPreferences === 'object'
      ? { ...request.executionPreferences }
      : {};
    const env = request.env || defaultEnv;
    const cwd = String(request.cwd || getCwd());
    const aiService = request.aiService || defaultAiService;
    const featureFlagEnabled = request.featureFlagEnabled === true;

    const capability = findCapability(area, action);
    if (!capability) {
      return buildUnknownUsageReport(area, action);
    }

    const policy = evaluatePolicy({
      capability,
      source,
      executionPreferences,
      runtimeOptions,
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
        }));
      } catch {}
      return deniedReport;
    }

    const adapterCall = buildAdapterCall(capability, {
      aiService,
      cwd,
      env,
      featureFlagEnabled,
      source,
      executionPreferences,
      positionals,
      runtimeOptions,
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
