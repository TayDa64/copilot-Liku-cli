const { findGitHubCapability, listGitHubCapabilities } = require('./capability-registry');
const { evaluateGitHubCapabilityPolicy } = require('./capability-policy');

const GITHUB_PLAN_BUILD_SCHEMA_VERSION = 'github.plan-build.v1';
const GITHUB_EXECUTION_PLAN_SCHEMA_VERSION = 'github.execution-plan.v1';
const DEFAULT_GITHUB_PLAN_TIMEOUT_MS = 60000;

function normalizeArea(area) {
  const value = String(area || '').trim().toLowerCase();
  if (value === 'issue') return 'issues';
  if (value === 'workflows') return 'workflow';
  if (value === 'release') return 'releases';
  return value;
}

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

function cloneRuntimeOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return {};
  }
  return { ...options };
}

function listAvailablePlanTargets(options = {}) {
  const listCapabilities = typeof options.listGitHubCapabilities === 'function'
    ? options.listGitHubCapabilities
    : listGitHubCapabilities;

  return listCapabilities()
    .map((entry) => entry.key)
    .filter((key) => !String(key || '').startsWith('plan.'));
}

function buildTargetRuntimeInput(targetCapability, targetPositionals, runtimeOptions) {
  switch (targetCapability.key) {
    case 'capabilities.list':
      return {};
    case 'capabilities.inspect':
      return {
        key: targetPositionals[2],
      };
    case 'auth.status':
      return {
        probe: parseBooleanOption(runtimeOptions.probe, true),
      };
    case 'repo.inspect':
      return {
        api: parseBooleanOption(runtimeOptions.api, true),
        slug: runtimeOptions.slug,
      };
    case 'issues.list':
      return {
        api: parseBooleanOption(runtimeOptions.api, true),
        slug: runtimeOptions.slug,
        state: runtimeOptions.state,
        limit: runtimeOptions.limit,
        labels: runtimeOptions.labels,
      };
    case 'issues.inspect':
      return {
        api: parseBooleanOption(runtimeOptions.api, true),
        slug: runtimeOptions.slug,
        number: targetPositionals[2],
      };
    case 'pr.list':
      return {
        api: parseBooleanOption(runtimeOptions.api, true),
        slug: runtimeOptions.slug,
        state: runtimeOptions.state,
        limit: runtimeOptions.limit,
        base: runtimeOptions.base,
        head: runtimeOptions.head,
      };
    case 'pr.inspect':
      return {
        api: parseBooleanOption(runtimeOptions.api, true),
        slug: runtimeOptions.slug,
        number: targetPositionals[2],
      };
    case 'pr.diff':
      return {
        api: parseBooleanOption(runtimeOptions.api, true),
        slug: runtimeOptions.slug,
        number: targetPositionals[2],
        limit: runtimeOptions.limit,
      };
    case 'workflow.runs':
      return {
        api: parseBooleanOption(runtimeOptions.api, true),
        slug: runtimeOptions.slug,
        workflow: runtimeOptions.workflow,
        branch: runtimeOptions.branch,
        status: runtimeOptions.status,
        event: runtimeOptions.event,
        limit: runtimeOptions.limit,
      };
    case 'workflow.inspect':
      return {
        api: parseBooleanOption(runtimeOptions.api, true),
        slug: runtimeOptions.slug,
        runId: targetPositionals[2],
      };
    case 'releases.list':
      return {
        api: parseBooleanOption(runtimeOptions.api, true),
        slug: runtimeOptions.slug,
        limit: runtimeOptions.limit,
      };
    case 'releases.inspect':
      return {
        api: parseBooleanOption(runtimeOptions.api, true),
        slug: runtimeOptions.slug,
        selector: targetPositionals[2],
      };
    default:
      return {
        positionals: targetPositionals.slice(2),
        options: cloneRuntimeOptions(runtimeOptions),
      };
  }
}

function createStepBudget(targetCapability) {
  const base = {
    maxSteps: 1,
    timeoutMs: DEFAULT_GITHUB_PLAN_TIMEOUT_MS,
  };

  if (targetCapability.key === 'workflow.runs' || targetCapability.key === 'workflow.inspect') {
    return {
      ...base,
      timeoutMs: 90000,
    };
  }

  return base;
}

function buildUsageFailure(message) {
  return {
    schemaVersion: GITHUB_PLAN_BUILD_SCHEMA_VERSION,
    success: false,
    error: 'USAGE',
    message,
    availableTargets: listAvailablePlanTargets(),
  };
}

function buildGitHubExecutionPlan(options = {}) {
  const source = String(options.source || 'unknown').trim().toLowerCase() || 'unknown';
  const positionals = Array.isArray(options.positionals) ? options.positionals.slice() : [];
  const runtimeOptions = cloneRuntimeOptions(options.runtimeOptions || options.options);
  const executionPreferences = options.executionPreferences && typeof options.executionPreferences === 'object'
    ? { ...options.executionPreferences }
    : {};
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const findCapability = typeof options.findGitHubCapability === 'function'
    ? options.findGitHubCapability
    : findGitHubCapability;
  const evaluatePolicy = typeof options.evaluateGitHubCapabilityPolicy === 'function'
    ? options.evaluateGitHubCapabilityPolicy
    : evaluateGitHubCapabilityPolicy;

  const targetPositionals = positionals.slice(2);
  const targetArea = normalizeArea(targetPositionals[0]);
  const targetAction = String(targetPositionals[1] || '').trim().toLowerCase();

  if (!targetArea || !targetAction) {
    return buildUsageFailure('Usage: liku github plan build <auth|capabilities|repo|issues|pr|workflow|releases> <status|inspect|list|diff|runs> [...]');
  }

  const targetCapability = findCapability(targetArea, targetAction);
  if (!targetCapability) {
    return {
      schemaVersion: GITHUB_PLAN_BUILD_SCHEMA_VERSION,
      success: false,
      error: 'UNKNOWN_TARGET',
      message: `Cannot build a GitHub plan for unknown target: ${targetArea} ${targetAction}`,
      requestedTarget: {
        area: targetArea,
        action: targetAction,
      },
      availableTargets: listAvailablePlanTargets(options),
    };
  }

  if (String(targetCapability.key || '').startsWith('plan.')) {
    return {
      schemaVersion: GITHUB_PLAN_BUILD_SCHEMA_VERSION,
      success: false,
      error: 'UNSUPPORTED_TARGET',
      message: `Recursive planning for \`${targetCapability.key}\` is not supported.`,
      requestedTarget: {
        area: targetArea,
        action: targetAction,
      },
    };
  }

  const targetPolicy = evaluatePolicy({
    capability: targetCapability,
    source,
    executionPreferences,
    runtimeOptions,
  });
  const runtimeInput = buildTargetRuntimeInput(targetCapability, targetPositionals, runtimeOptions);
  const budget = createStepBudget(targetCapability);
  const requestedOptions = cloneRuntimeOptions(runtimeOptions);
  const requestedArgs = targetPositionals.slice(2);

  return {
    schemaVersion: GITHUB_PLAN_BUILD_SCHEMA_VERSION,
    success: true,
    planner: {
      mode: 'registry-deterministic',
      source,
      featureFlagEnabled,
    },
    requestedTarget: {
      area: targetArea,
      action: targetAction,
      args: requestedArgs,
      options: requestedOptions,
    },
    targetCapability: {
      key: targetCapability.key,
      description: targetCapability.description,
      responseSchemaVersion: targetCapability.responseSchemaVersion || null,
      sideEffectClass: targetCapability.sideEffectClass,
      approvalRequirement: targetCapability.approvalRequirement,
      riskLevel: targetCapability.riskLevel,
    },
    plan: {
      schemaVersion: GITHUB_EXECUTION_PLAN_SCHEMA_VERSION,
      planner: 'github.plan.build',
      goal: targetCapability.description,
      budget,
      constraints: [
        'registered-github-capabilities-only',
        'read-only-policy-gated',
        'no-free-form-shell-execution',
      ],
      steps: [
        {
          id: 'step-1',
          type: 'github-capability',
          capabilityKey: targetCapability.key,
          description: targetCapability.description,
          expectedSchemaVersion: targetCapability.responseSchemaVersion || null,
          invocation: {
            area: targetArea,
            action: targetAction,
            args: requestedArgs,
            options: requestedOptions,
          },
          runtimeInput,
          policy: targetPolicy,
        },
      ],
    },
  };
}

module.exports = {
  DEFAULT_GITHUB_PLAN_TIMEOUT_MS,
  GITHUB_EXECUTION_PLAN_SCHEMA_VERSION,
  GITHUB_PLAN_BUILD_SCHEMA_VERSION,
  buildGitHubExecutionPlan,
  buildTargetRuntimeInput,
  createStepBudget,
};
