const {
  findGitHubCapability,
} = require('./capability-registry');
const {
  buildGitHubExecutionPlan,
  GITHUB_EXECUTION_PLAN_SCHEMA_VERSION,
} = require('./plan-builder');
const {
  GITHUB_PLAN_ARTIFACT_SCHEMA_VERSION,
  readGitHubPlanArtifact,
  writeGitHubPlanArtifact,
  writeGitHubPlanResultArtifact,
} = require('./plan-artifacts');

const GITHUB_PLAN_EXECUTE_SCHEMA_VERSION = 'github.plan-execute.v1';
const MAX_GITHUB_PLAN_STEPS = 5;
const MAX_GITHUB_PLAN_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_GITHUB_PLAN_EXECUTE_TIMEOUT_MS = 60 * 1000;

function cloneObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...value };
}

function normalizeInvocationArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice();
}

function createTimeoutPromise(timeoutMs, message) {
  return new Promise((_, reject) => {
    const timeout = setTimeout(() => {
      const error = new Error(message || `GitHub plan execution exceeded timeout (${timeoutMs}ms)`);
      error.code = 'PLAN_TIMEOUT';
      reject(error);
    }, timeoutMs);
    timeout.unref?.();
  });
}

async function raceWithTimeout(promise, timeoutMs, message) {
  if (!Number.isFinite(Number(timeoutMs)) || Number(timeoutMs) <= 0) {
    return promise;
  }
  return Promise.race([
    promise,
    createTimeoutPromise(Number(timeoutMs), message),
  ]);
}

function buildUsageFailure(message, extra = {}) {
  return {
    schemaVersion: GITHUB_PLAN_EXECUTE_SCHEMA_VERSION,
    success: false,
    error: 'USAGE',
    message,
    ...extra,
  };
}

function buildExecutionFailure(error, message, extra = {}) {
  return {
    schemaVersion: GITHUB_PLAN_EXECUTE_SCHEMA_VERSION,
    success: false,
    error,
    message,
    ...extra,
  };
}

function summarizeStepResult(step, report) {
  return {
    stepId: step.id || null,
    capabilityKey: step.capabilityKey || null,
    success: report?.success !== false,
    schemaVersion: report?.schemaVersion || null,
    error: report?.error || null,
    message: report?.message || null,
    result: report,
  };
}

function summarizeExecution(planSource, budget, stepResults, startedAt, finishedAt, timedOut = false) {
  const startTime = typeof startedAt === 'number' ? startedAt : Date.now();
  const finishTime = typeof finishedAt === 'number' ? finishedAt : Date.now();
  const elapsedMs = Math.max(0, finishTime - startTime);

  return {
    planSource,
    startedAt: new Date(startTime).toISOString(),
    finishedAt: new Date(finishTime).toISOString(),
    elapsedMs,
    timedOut: timedOut === true,
    maxStepsAllowed: Number.isFinite(Number(budget?.maxSteps)) ? Number(budget.maxSteps) : null,
    timeoutMsAllowed: Number.isFinite(Number(budget?.timeoutMs)) ? Number(budget.timeoutMs) : null,
    stepsExecuted: Array.isArray(stepResults) ? stepResults.length : 0,
  };
}

function buildStepRuntimeOptions(step, invocation) {
  const runtimeInput = step && typeof step === 'object' && step.runtimeInput && typeof step.runtimeInput === 'object' && !Array.isArray(step.runtimeInput)
    ? step.runtimeInput
    : null;

  if (runtimeInput && runtimeInput.options && typeof runtimeInput.options === 'object' && !Array.isArray(runtimeInput.options)) {
    return cloneObject(runtimeInput.options);
  }

  if (runtimeInput) {
    const normalizedOptions = cloneObject(runtimeInput);
    delete normalizedOptions.positionals;
    return normalizedOptions;
  }

  return cloneObject(invocation?.options);
}

function normalizeBudget(plan = {}) {
  const budget = plan && typeof plan === 'object' && plan.budget && typeof plan.budget === 'object'
    ? plan.budget
    : {};
  const maxSteps = Number.isFinite(Number(budget.maxSteps)) ? Number(budget.maxSteps) : 1;
  const timeoutMs = Number.isFinite(Number(budget.timeoutMs)) ? Number(budget.timeoutMs) : DEFAULT_GITHUB_PLAN_EXECUTE_TIMEOUT_MS;

  return {
    maxSteps,
    timeoutMs,
  };
}

function validateExecutionPlan(planReport, options = {}) {
  if (!planReport || typeof planReport !== 'object') {
    return buildExecutionFailure('INVALID_PLAN', 'GitHub plan execution requires a plan report object.');
  }

  const plan = planReport.plan && typeof planReport.plan === 'object' ? planReport.plan : null;
  if (!plan) {
    return buildExecutionFailure('INVALID_PLAN', 'GitHub plan report is missing the nested execution plan.');
  }

  if (plan.schemaVersion !== GITHUB_EXECUTION_PLAN_SCHEMA_VERSION) {
    return buildExecutionFailure('INVALID_PLAN', `Unsupported GitHub execution plan schema: ${plan.schemaVersion || 'unknown'}`);
  }

  const steps = Array.isArray(plan.steps) ? plan.steps.slice() : [];
  if (steps.length === 0) {
    return buildExecutionFailure('INVALID_PLAN', 'GitHub execution plan has no steps to execute.');
  }

  const budget = normalizeBudget(plan);
  if (budget.maxSteps <= 0) {
    return buildExecutionFailure('INVALID_PLAN', 'GitHub execution plan maxSteps must be greater than zero.');
  }
  if (budget.maxSteps > MAX_GITHUB_PLAN_STEPS) {
    return buildExecutionFailure('PLAN_BUDGET_EXCEEDED', `GitHub execution plan maxSteps exceeds the bounded executor limit (${MAX_GITHUB_PLAN_STEPS}).`, {
      budget,
    });
  }
  if (steps.length > budget.maxSteps) {
    return buildExecutionFailure('PLAN_BUDGET_EXCEEDED', `GitHub execution plan has ${steps.length} step(s), exceeding the maxSteps budget of ${budget.maxSteps}.`, {
      budget,
    });
  }
  if (budget.timeoutMs <= 0) {
    return buildExecutionFailure('INVALID_PLAN', 'GitHub execution plan timeoutMs must be greater than zero.', {
      budget,
    });
  }
  if (budget.timeoutMs > MAX_GITHUB_PLAN_TIMEOUT_MS) {
    return buildExecutionFailure('PLAN_BUDGET_EXCEEDED', `GitHub execution plan timeout exceeds the bounded executor limit (${MAX_GITHUB_PLAN_TIMEOUT_MS}ms).`, {
      budget,
    });
  }

  const resolveCapability = typeof options.findGitHubCapability === 'function'
    ? options.findGitHubCapability
    : findGitHubCapability;

  for (const step of steps) {
    if (step?.type !== 'github-capability') {
      return buildExecutionFailure('INVALID_PLAN_STEP', `Unsupported GitHub execution plan step type: ${step?.type || 'unknown'}.`, {
        step,
      });
    }
    if (!step.capabilityKey || String(step.capabilityKey).startsWith('plan.')) {
      return buildExecutionFailure('INVALID_PLAN_STEP', 'GitHub execution plans cannot recursively execute nested plan.* capabilities.', {
        step,
      });
    }

    const invocation = step.invocation && typeof step.invocation === 'object' ? step.invocation : null;
    if (!invocation?.area || !invocation?.action) {
      return buildExecutionFailure('INVALID_PLAN_STEP', 'GitHub execution plan step invocation must include area and action.', {
        step,
      });
    }

    const capability = resolveCapability(invocation.area, invocation.action);
    if (!capability) {
      return buildExecutionFailure('INVALID_PLAN_STEP', `GitHub execution plan step references an unknown capability: ${invocation.area} ${invocation.action}`, {
        step,
      });
    }
    if (capability.key !== step.capabilityKey) {
      return buildExecutionFailure('INVALID_PLAN_STEP', `GitHub execution plan step capability key mismatch: expected ${capability.key}, got ${step.capabilityKey}.`, {
        step,
      });
    }
    if (String(capability.sideEffectClass || '').trim().toLowerCase() !== 'read') {
      return buildExecutionFailure('POLICY_DENIED', `GitHub execution plan step ${capability.key} is not read-only and cannot be executed by the bounded executor.`, {
        step,
      });
    }
    if (step.policy?.allowed !== true) {
      return buildExecutionFailure('POLICY_DENIED', `GitHub execution plan step ${capability.key} is denied by policy (${step.policy?.reason || 'unknown'}).`, {
        step,
      });
    }
  }

  return {
    success: true,
    budget,
    steps,
  };
}

async function executeGitHubExecutionPlan(options = {}) {
  const source = String(options.source || 'unknown').trim().toLowerCase() || 'unknown';
  const positionals = Array.isArray(options.positionals) ? options.positionals.slice() : [];
  const runtimeOptions = cloneObject(options.runtimeOptions || options.options);
  const executionPreferences = cloneObject(options.executionPreferences);
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const cwd = String(options.cwd || process.cwd());
  const env = options.env || process.env;
  const aiService = options.aiService || null;
  const buildPlan = typeof options.buildGitHubExecutionPlan === 'function'
    ? options.buildGitHubExecutionPlan
    : buildGitHubExecutionPlan;
  const executeGitHubCommand = typeof options.executeGitHubCommand === 'function'
    ? options.executeGitHubCommand
    : null;
  const readPlanArtifact = typeof options.readGitHubPlanArtifact === 'function'
    ? options.readGitHubPlanArtifact
    : readGitHubPlanArtifact;
  const writePlanArtifact = typeof options.writeGitHubPlanArtifact === 'function'
    ? options.writeGitHubPlanArtifact
    : writeGitHubPlanArtifact;
  const writeResultArtifact = typeof options.writeGitHubPlanResultArtifact === 'function'
    ? options.writeGitHubPlanResultArtifact
    : writeGitHubPlanResultArtifact;
  const findCapability = typeof options.findGitHubCapability === 'function'
    ? options.findGitHubCapability
    : findGitHubCapability;

  if (typeof executeGitHubCommand !== 'function') {
    return buildExecutionFailure('EXECUTOR_UNAVAILABLE', 'GitHub bounded executor is unavailable because no command execution function was provided.');
  }

  let planReport = options.planReport && typeof options.planReport === 'object' ? options.planReport : null;
  let planArtifact = null;
  let planSource = 'runtime-build';

  const planFile = String(
    runtimeOptions.planFile
      || runtimeOptions['plan-file']
      || runtimeOptions.planfile
      || ''
  ).trim();
  if (planFile) {
    let planArtifactRecord;
    try {
      planArtifactRecord = readPlanArtifact({ filePath: planFile });
    } catch (error) {
      return buildExecutionFailure('PLAN_ARTIFACT_NOT_FOUND', error.message, {
        planFile,
      });
    }

    if (planArtifactRecord.schemaVersion !== GITHUB_PLAN_ARTIFACT_SCHEMA_VERSION) {
      return buildExecutionFailure('INVALID_PLAN_ARTIFACT', `Unsupported GitHub plan artifact schema: ${planArtifactRecord.schemaVersion || 'unknown'}`, {
        planFile,
      });
    }

    planReport = planArtifactRecord.planReport;
    planArtifact = {
      artifactId: String(planArtifactRecord.artifactId || '').trim() || null,
      schemaVersion: String(planArtifactRecord.schemaVersion || '').trim() || null,
      createdAt: String(planArtifactRecord.createdAt || '').trim() || null,
      filePath: planArtifactRecord.filePath,
    };
    planSource = 'artifact-replay';
  }

  if (!planReport) {
    const buildPositionals = positionals.length >= 2
      ? ['plan', 'build', ...positionals.slice(2)]
      : ['plan', 'build'];
    const buildReport = buildPlan({
      source,
      positionals: buildPositionals,
      runtimeOptions,
      executionPreferences,
      featureFlagEnabled,
      findGitHubCapability: findCapability,
      evaluateGitHubCapabilityPolicy: options.evaluateGitHubCapabilityPolicy,
    });

    if (!buildReport || buildReport.success === false) {
      return buildExecutionFailure(buildReport?.error || 'PLAN_BUILD_FAILED', buildReport?.message || 'GitHub plan build failed.', {
        planBuild: buildReport || null,
      });
    }

    planReport = buildReport;
    planArtifact = writePlanArtifact({
      source,
      metadata: {
        mode: 'bounded-executor',
        cwd,
      },
      planReport,
    });
  }

  if (!planArtifact && planReport) {
    planArtifact = writePlanArtifact({
      source,
      metadata: {
        mode: 'bounded-executor',
        origin: options.planReport ? 'provided-plan-report' : 'runtime-build',
        cwd,
      },
      planReport,
    });

    if (options.planReport) {
      planSource = 'provided-report';
    }
  }

  const validation = validateExecutionPlan(planReport, {
    findGitHubCapability: findCapability,
  });
  if (!validation.success) {
    const resultArtifact = writeResultArtifact({
      source,
      metadata: {
        outcome: 'validation-failure',
        cwd,
      },
      planArtifact,
      execution: {
        planSource,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        elapsedMs: 0,
        timedOut: false,
        maxStepsAllowed: validation.budget?.maxSteps || null,
        timeoutMsAllowed: validation.budget?.timeoutMs || null,
        stepsExecuted: 0,
      },
      stepResults: [],
    });

    return {
      ...validation,
      schemaVersion: GITHUB_PLAN_EXECUTE_SCHEMA_VERSION,
      planArtifact,
      resultArtifact,
    };
  }

  const { budget, steps } = validation;
  const startedAt = Date.now();
  const stepResults = [];
  let timedOut = false;
  let overallSuccess = true;
  let failureCode = null;
  let failureMessage = null;

  for (const step of steps) {
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = budget.timeoutMs - elapsedMs;
    if (remainingMs <= 0) {
      timedOut = true;
      overallSuccess = false;
      failureCode = 'PLAN_TIMEOUT';
      failureMessage = `GitHub execution plan exceeded the overall timeout budget of ${budget.timeoutMs}ms.`;
      break;
    }

    const invocation = step.invocation || {};
    const stepPositionals = [
      String(invocation.area || '').trim(),
      String(invocation.action || '').trim(),
      ...normalizeInvocationArray(invocation.args),
    ];

    const stepRuntimeOptions = buildStepRuntimeOptions(step, invocation);

    try {
      const report = await raceWithTimeout(
        Promise.resolve(executeGitHubCommand({
          source: step.policy?.source || source,
          area: invocation.area,
          action: invocation.action,
          positionals: stepPositionals,
          options: stepRuntimeOptions,
          executionPreferences,
          featureFlagEnabled,
          cwd,
          env,
          aiService,
        })),
        remainingMs,
        `GitHub execution plan step ${step.id || step.capabilityKey || 'unknown'} exceeded the remaining timeout budget (${remainingMs}ms).`
      );

      const summary = summarizeStepResult(step, report);
      stepResults.push(summary);
      if (report?.success === false) {
        overallSuccess = false;
        failureCode = report.error || 'STEP_FAILED';
        failureMessage = report.message || `GitHub execution plan step ${step.id || step.capabilityKey} failed.`;
        break;
      }
    } catch (error) {
      const code = error?.code === 'PLAN_TIMEOUT' ? 'PLAN_TIMEOUT' : 'STEP_FAILED';
      if (code === 'PLAN_TIMEOUT') {
        timedOut = true;
      }
      overallSuccess = false;
      failureCode = code;
      failureMessage = error?.message || `GitHub execution plan step ${step.id || step.capabilityKey} failed unexpectedly.`;
      stepResults.push({
        stepId: step.id || null,
        capabilityKey: step.capabilityKey || null,
        success: false,
        schemaVersion: null,
        error: code,
        message: failureMessage,
        result: null,
      });
      break;
    }
  }

  const finishedAt = Date.now();
  const execution = summarizeExecution(planSource, budget, stepResults, startedAt, finishedAt, timedOut);
  const resultArtifact = writeResultArtifact({
    source,
    metadata: {
      outcome: overallSuccess ? 'success' : 'failure',
      cwd,
    },
    planArtifact,
    execution,
    stepResults,
  });

  return {
    schemaVersion: GITHUB_PLAN_EXECUTE_SCHEMA_VERSION,
    success: overallSuccess,
    error: overallSuccess ? null : failureCode,
    message: overallSuccess
      ? 'GitHub execution plan completed successfully.'
      : (failureMessage || 'GitHub execution plan failed.'),
    boundedExecutor: {
      mode: 'registry-bounded-readonly',
      source,
      featureFlagEnabled,
      replayCommand: planArtifact?.filePath
        ? `liku github plan execute --plan-file "${planArtifact.filePath}"`
        : null,
    },
    requestedTarget: planReport.requestedTarget || null,
    targetCapability: planReport.targetCapability || null,
    planSummary: {
      schemaVersion: planReport.plan?.schemaVersion || GITHUB_EXECUTION_PLAN_SCHEMA_VERSION,
      goal: planReport.plan?.goal || null,
      constraints: Array.isArray(planReport.plan?.constraints) ? planReport.plan.constraints.slice() : [],
      budget,
      stepsTotal: steps.length,
    },
    planArtifact,
    resultArtifact,
    execution,
    stepResults,
  };
}

module.exports = {
  DEFAULT_GITHUB_PLAN_EXECUTE_TIMEOUT_MS,
  GITHUB_PLAN_EXECUTE_SCHEMA_VERSION,
  MAX_GITHUB_PLAN_STEPS,
  MAX_GITHUB_PLAN_TIMEOUT_MS,
  buildStepRuntimeOptions,
  executeGitHubExecutionPlan,
  validateExecutionPlan,
};
