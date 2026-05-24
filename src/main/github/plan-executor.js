const {
  findGitHubCapability,
} = require('./capability-registry');
const {
  buildGitHubExecutionPlan,
  GITHUB_EXECUTION_PLAN_SCHEMA_VERSION,
} = require('./plan-builder');
const {
  GITHUB_PLAN_EVENT_SCHEMA_VERSION,
  GITHUB_PLAN_GUIDANCE_SCHEMA_VERSION,
  GITHUB_PLAN_ARTIFACT_SCHEMA_VERSION,
  appendGitHubPlanEvent,
  buildArtifactId,
  buildGuidanceId,
  buildGitHubPlanEventLogPath,
  buildRunId,
  readGitHubPlanArtifact,
  readGitHubPlanEventLog,
  readGitHubPlanGuidanceArtifact,
  readGitHubPlanResultArtifact,
  writeGitHubPlanArtifact,
  writeGitHubPlanGuidanceArtifact,
  writeGitHubPlanResultArtifact,
} = require('./plan-artifacts');

const GITHUB_PLAN_EXECUTE_SCHEMA_VERSION = 'github.plan-execute.v1';
const GITHUB_PLAN_RESUME_SCHEMA_VERSION = 'github.plan-resume.v1';
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

function cloneArrayOfObjects(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return entry;
    }
    return { ...entry };
  });
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

function summarizeExecution(planSource, budget, stepResults, startedAt, finishedAt, options = {}) {
  const startTime = Number.isFinite(Number(options.startedAtTime)) ? Number(options.startedAtTime) : (typeof startedAt === 'number' ? startedAt : Date.now());
  const checkpointTime = Number.isFinite(Number(options.lastUpdatedAtTime)) ? Number(options.lastUpdatedAtTime) : (typeof finishedAt === 'number' ? finishedAt : Date.now());
  const terminal = options.terminal !== false;
  const finishTime = terminal ? checkpointTime : null;
  const elapsedMs = Number.isFinite(Number(options.elapsedMsOverride))
    ? Math.max(0, Number(options.elapsedMsOverride))
    : Math.max(0, checkpointTime - startTime);

  return {
    planSource,
    status: String(options.status || (terminal ? 'completed' : 'in-progress')).trim() || (terminal ? 'completed' : 'in-progress'),
    terminal,
    startedAt: new Date(startTime).toISOString(),
    lastUpdatedAt: new Date(checkpointTime).toISOString(),
    finishedAt: finishTime === null ? null : new Date(finishTime).toISOString(),
    elapsedMs,
    timedOut: options.timedOut === true,
    terminalEvent: terminal ? (String(options.terminalEvent || '').trim() || null) : null,
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

function buildRunEnvelope(runId, status, eventLog = null) {
  return {
    runId: String(runId || '').trim() || null,
    status: String(status || '').trim() || 'unknown',
    eventLog: eventLog && typeof eventLog === 'object'
      ? { ...eventLog }
      : null,
  };
}

function buildEventLogEnvelope(artifactId, runId, filePath = null) {
  const normalizedArtifactId = String(artifactId || '').trim();
  const normalizedRunId = String(runId || '').trim();
  if (!normalizedArtifactId || !normalizedRunId) {
    return null;
  }

  return {
    schemaVersion: GITHUB_PLAN_EVENT_SCHEMA_VERSION,
    artifactId: normalizedArtifactId,
    runId: normalizedRunId,
    filePath: String(filePath || buildGitHubPlanEventLogPath({ artifactId: normalizedArtifactId, runId: normalizedRunId })).trim() || null,
  };
}

function normalizeGuidanceQuestion(question, index) {
  if (!question || typeof question !== 'object' || Array.isArray(question)) {
    return {
      id: `question-${index + 1}`,
      prompt: String(question || '').trim() || `Question ${index + 1}`,
      kind: 'text',
      required: true,
      allowFreeformInput: true,
      options: [],
    };
  }

  return {
    id: String(question.id || `question-${index + 1}`).trim() || `question-${index + 1}`,
    prompt: String(question.prompt || question.question || `Question ${index + 1}`).trim() || `Question ${index + 1}`,
    kind: String(question.kind || 'text').trim() || 'text',
    targetType: String(question.targetType || question.target || 'runtimeInput').trim() || 'runtimeInput',
    targetField: String(question.targetField || question.field || question.key || question.id || `question-${index + 1}`).trim() || `question-${index + 1}`,
    targetIndex: Number.isFinite(Number(question.targetIndex)) ? Number(question.targetIndex) : null,
    required: question.required !== false,
    allowFreeformInput: question.allowFreeformInput !== false,
    options: Array.isArray(question.options)
      ? question.options.map((entry) => (entry && typeof entry === 'object' && !Array.isArray(entry) ? { ...entry } : entry))
      : [],
  };
}

function isGuidanceRequiredReport(report) {
  if (!report || typeof report !== 'object') {
    return false;
  }

  const status = String(report.status || '').trim().toLowerCase();
  const error = String(report.error || '').trim().toUpperCase();
  const questions = Array.isArray(report.guidance?.questions) ? report.guidance.questions : [];

  return status === 'needs-guidance' || error === 'GUIDANCE_REQUIRED' || questions.length > 0;
}

function normalizeGuidanceRequest(step, report, planArtifact, runId) {
  const guidance = report && typeof report === 'object' && report.guidance && typeof report.guidance === 'object' && !Array.isArray(report.guidance)
    ? report.guidance
    : {};
  const guidanceId = String(guidance.guidanceId || report?.guidanceId || buildGuidanceId()).trim() || buildGuidanceId();
  const resumeToken = String(guidance.resumeToken || report?.resumeToken || buildArtifactId('github-resume')).trim() || buildArtifactId('github-resume');
  const questions = (Array.isArray(guidance.questions) ? guidance.questions : []).map(normalizeGuidanceQuestion);
  const requestedBy = guidance.requestedBy && typeof guidance.requestedBy === 'object' && !Array.isArray(guidance.requestedBy)
    ? { ...guidance.requestedBy }
    : {
        stepId: step?.id || null,
        capabilityKey: step?.capabilityKey || null,
      };

  return {
    schemaVersion: GITHUB_PLAN_GUIDANCE_SCHEMA_VERSION,
    runId: String(runId || '').trim() || null,
    artifactId: String(planArtifact?.artifactId || '').trim() || null,
    guidanceId,
    status: 'requested',
    reason: String(guidance.reason || report?.reason || 'user-clarification').trim() || 'user-clarification',
    resumeToken,
    requestedBy,
    questions,
    answers: null,
    message: String(report?.message || '').trim() || `GitHub execution plan requires guidance before ${step?.id || step?.capabilityKey || 'the current step'} can continue.`,
  };
}

function normalizeGuidanceAnswersInput(value) {
  if (value === undefined || value === null || value === '') {
    return {};
  }

  if (Array.isArray(value)) {
    const answers = {};
    value.forEach((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return;
      }
      const id = String(entry.id || entry.key || '').trim();
      if (!id) {
        return;
      }
      answers[id] = Object.prototype.hasOwnProperty.call(entry, 'value') ? entry.value : entry.answer;
    });
    return answers;
  }

  if (value && typeof value === 'object') {
    return { ...value };
  }

  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return {};
  }

  return JSON.parse(trimmed);
}

function readGuidanceAnswersFromFile(filePath) {
  const fs = require('fs');
  const path = require('path');
  const resolvedPath = path.resolve(String(filePath || '').trim());
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`GitHub guidance answers file not found: ${resolvedPath}`);
  }
  const text = fs.readFileSync(resolvedPath, 'utf8');
  return normalizeGuidanceAnswersInput(text);
}

function applyGuidanceAnswersToStep(step, questions, answers) {
  const nextStep = step && typeof step === 'object' ? { ...step } : {};
  nextStep.invocation = nextStep.invocation && typeof nextStep.invocation === 'object' ? { ...nextStep.invocation } : {};
  nextStep.invocation.args = normalizeInvocationArray(nextStep.invocation.args);
  nextStep.invocation.options = cloneObject(nextStep.invocation.options);
  nextStep.runtimeInput = nextStep.runtimeInput && typeof nextStep.runtimeInput === 'object' && !Array.isArray(nextStep.runtimeInput)
    ? { ...nextStep.runtimeInput }
    : {};

  for (const question of questions) {
    if (!question || typeof question !== 'object' || Array.isArray(question)) {
      continue;
    }

    const answerValue = answers && Object.prototype.hasOwnProperty.call(answers, question.id)
      ? answers[question.id]
      : undefined;

    if (answerValue === undefined) {
      continue;
    }

    const targetType = String(question.targetType || 'runtimeInput').trim().toLowerCase();
    const targetField = String(question.targetField || question.id || '').trim() || question.id;
    if (targetType === 'arg') {
      const targetIndex = Number.isFinite(Number(question.targetIndex)) ? Number(question.targetIndex) : Number(targetField);
      if (Number.isFinite(targetIndex) && targetIndex >= 0) {
        nextStep.invocation.args[targetIndex] = answerValue;
      }
      continue;
    }

    if (targetType === 'option') {
      nextStep.invocation.options[targetField] = answerValue;
      nextStep.runtimeInput[targetField] = answerValue;
      continue;
    }

    nextStep.runtimeInput[targetField] = answerValue;
    if (Object.prototype.hasOwnProperty.call(nextStep.invocation.options, targetField)) {
      nextStep.invocation.options[targetField] = answerValue;
    }
  }

  return nextStep;
}

function buildResumeUsageFailure(message, extra = {}) {
  return {
    schemaVersion: GITHUB_PLAN_RESUME_SCHEMA_VERSION,
    success: false,
    error: 'USAGE',
    message,
    ...extra,
  };
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
  const responseSchemaVersion = String(options.responseSchemaVersion || GITHUB_PLAN_EXECUTE_SCHEMA_VERSION).trim() || GITHUB_PLAN_EXECUTE_SCHEMA_VERSION;
  const runId = String(options.runId || buildRunId()).trim() || buildRunId();
  const buildPlan = typeof options.buildGitHubExecutionPlan === 'function'
    ? options.buildGitHubExecutionPlan
    : buildGitHubExecutionPlan;
  const executeGitHubCommand = typeof options.executeGitHubCommand === 'function'
    ? options.executeGitHubCommand
    : null;
  const readPlanArtifact = typeof options.readGitHubPlanArtifact === 'function'
    ? options.readGitHubPlanArtifact
    : readGitHubPlanArtifact;
  const readPlanEventLogImpl = typeof options.readGitHubPlanEventLog === 'function'
    ? options.readGitHubPlanEventLog
    : readGitHubPlanEventLog;
  const readGuidanceArtifact = typeof options.readGitHubPlanGuidanceArtifact === 'function'
    ? options.readGitHubPlanGuidanceArtifact
    : readGitHubPlanGuidanceArtifact;
  const readResultArtifact = typeof options.readGitHubPlanResultArtifact === 'function'
    ? options.readGitHubPlanResultArtifact
    : readGitHubPlanResultArtifact;
  const writePlanArtifact = typeof options.writeGitHubPlanArtifact === 'function'
    ? options.writeGitHubPlanArtifact
    : writeGitHubPlanArtifact;
  const appendPlanEvent = typeof options.appendGitHubPlanEvent === 'function'
    ? options.appendGitHubPlanEvent
    : appendGitHubPlanEvent;
  const writeGuidanceArtifact = typeof options.writeGitHubPlanGuidanceArtifact === 'function'
    ? options.writeGitHubPlanGuidanceArtifact
    : writeGitHubPlanGuidanceArtifact;
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
  let planArtifact = options.planArtifact && typeof options.planArtifact === 'object' ? { ...options.planArtifact } : null;
  let planSource = String(options.planSource || 'runtime-build').trim() || 'runtime-build';
  let guidanceArtifact = options.guidanceArtifact && typeof options.guidanceArtifact === 'object' ? { ...options.guidanceArtifact } : null;
  let eventLog = options.eventLog && typeof options.eventLog === 'object' ? { ...options.eventLog } : null;
  let eventSequence = Number.isFinite(Number(options.eventSequenceStart)) ? Number(options.eventSequenceStart) : 0;
  const guidanceState = options.guidanceState && typeof options.guidanceState === 'object' && !Array.isArray(options.guidanceState)
    ? { ...options.guidanceState }
    : null;
  let stepResults = cloneArrayOfObjects(options.initialStepResults || guidanceState?.stepResults);
  let startStepIndex = Number.isFinite(Number(options.startStepIndex)) ? Number(options.startStepIndex) : 0;
  let carriedElapsedMs = Number.isFinite(Number(options.carriedElapsedMs)) ? Number(options.carriedElapsedMs) : 0;
  const persistedStartedAt = String(options.startedAt || guidanceState?.execution?.startedAt || '').trim();
  const parsedPersistedStartedAt = persistedStartedAt ? Date.parse(persistedStartedAt) : NaN;
  const executionStartedAtMs = Number.isFinite(parsedPersistedStartedAt) ? parsedPersistedStartedAt : Date.now();
  const activeSessionStartedAt = Date.now();

  if (guidanceState && Number.isFinite(Number(guidanceState.blockedStepIndex))) {
    startStepIndex = Number(guidanceState.blockedStepIndex);
  }
  if (guidanceState?.execution && Number.isFinite(Number(guidanceState.execution.elapsedMs))) {
    carriedElapsedMs = Number(guidanceState.execution.elapsedMs);
  }
  if (!eventLog && guidanceState?.planArtifact?.artifactId && guidanceState?.runId) {
    eventLog = buildEventLogEnvelope(guidanceState.planArtifact.artifactId, guidanceState.runId);
  }

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
        orchestrationMode: 'bounded-evented',
        cwd,
        runId,
      },
      planReport,
    });
  }

  if (!planArtifact && planReport) {
    planArtifact = writePlanArtifact({
      source,
      metadata: {
        mode: 'bounded-executor',
        orchestrationMode: 'bounded-evented',
        origin: options.planReport ? 'provided-plan-report' : 'runtime-build',
        cwd,
        runId,
      },
      planReport,
    });

    if (options.planReport) {
      planSource = 'provided-report';
    }
  }

  if (!eventLog && planArtifact?.artifactId) {
    eventLog = buildEventLogEnvelope(planArtifact.artifactId, runId);
  }

  if (eventLog?.filePath && eventSequence === 0) {
    try {
      const existingEventLog = readPlanEventLogImpl({ filePath: eventLog.filePath });
      eventSequence = Array.isArray(existingEventLog.events) ? existingEventLog.events.length : 0;
    } catch {}
  }

  function recordEvent(eventName, payload = {}) {
    if (!planArtifact?.artifactId) {
      return null;
    }

    eventSequence += 1;
    const record = appendPlanEvent({
      artifactId: planArtifact.artifactId,
      runId,
      sequence: eventSequence,
      eventName,
      source,
      status: payload.status,
      step: payload.step,
      details: payload.details,
      guidance: payload.guidance,
    });
    eventLog = buildEventLogEnvelope(planArtifact.artifactId, runId, record?.filePath || null);
    return record;
  }

  const validation = validateExecutionPlan(planReport, {
    findGitHubCapability: findCapability,
  });
  if (!validation.success) {
    const abortedAt = Date.now();
    recordEvent('execution.aborted', {
      status: 'aborted',
      details: {
        error: validation.error || 'INVALID_PLAN',
        message: validation.message || 'GitHub execution plan validation failed.',
        timedOut: false,
      },
    });
    const execution = summarizeExecution(planSource, validation.budget || null, [], abortedAt, abortedAt, {
      status: 'aborted',
      timedOut: false,
      terminalEvent: 'execution.aborted',
    });
    const resultArtifact = writeResultArtifact({
      source,
      metadata: {
        outcome: 'validation-failure',
        cwd,
        runId,
      },
      planArtifact,
      execution,
      stepResults: [],
    });

    return {
      ...validation,
      schemaVersion: responseSchemaVersion,
      run: buildRunEnvelope(runId, 'aborted', eventLog),
      eventLog,
      planArtifact,
      guidanceArtifact: null,
      resume: null,
      resultArtifact,
      execution,
    };
  }

  const { budget, steps } = validation;
  let timedOut = false;
  let overallSuccess = true;
  let failureCode = null;
  let failureMessage = null;

  if (options.resumeMode !== true) {
    recordEvent('execution.started', {
      status: 'running',
      details: {
        budget: { ...budget },
        requestedTarget: planReport.requestedTarget || null,
      },
    });
  }

  for (let stepIndex = startStepIndex; stepIndex < steps.length; stepIndex += 1) {
    const step = steps[stepIndex];
    const elapsedMs = carriedElapsedMs + (Date.now() - activeSessionStartedAt);
    const remainingMs = budget.timeoutMs - elapsedMs;
    if (remainingMs <= 0) {
      timedOut = true;
      overallSuccess = false;
      failureCode = 'PLAN_TIMEOUT';
      failureMessage = `GitHub execution plan exceeded the overall timeout budget of ${budget.timeoutMs}ms.`;
      break;
    }

    const invocation = step.invocation || {};
    const stepEnvelope = {
      stepId: step.id || null,
      capabilityKey: step.capabilityKey || null,
    };
    const stepPositionals = [
      String(invocation.area || '').trim(),
      String(invocation.action || '').trim(),
      ...normalizeInvocationArray(invocation.args),
    ];

    const stepRuntimeOptions = buildStepRuntimeOptions(step, invocation);
    const stepStartedAt = Date.now();

    recordEvent('step.started', {
      status: 'running',
      step: stepEnvelope,
      details: {
        sequence: stepIndex + 1,
      },
    });

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

      if (isGuidanceRequiredReport(report)) {
        const guidanceRequest = normalizeGuidanceRequest(step, report, planArtifact, runId);

        recordEvent('guidance.requested', {
          status: 'blocked',
          step: stepEnvelope,
          details: {
            reason: guidanceRequest.reason,
          },
          guidance: {
            guidanceId: guidanceRequest.guidanceId,
            resumeToken: guidanceRequest.resumeToken,
            questions: guidanceRequest.questions,
          },
        });

        const blockedAt = Date.now();
        const execution = {
          ...summarizeExecution(planSource, budget, stepResults, executionStartedAtMs, blockedAt, {
            status: 'needs-guidance',
            terminal: false,
            startedAtTime: executionStartedAtMs,
            lastUpdatedAtTime: blockedAt,
            elapsedMsOverride: carriedElapsedMs + Math.max(0, blockedAt - activeSessionStartedAt),
          }),
          blockedAt: new Date(blockedAt).toISOString(),
          blockedStepId: step.id || null,
          blockedCapabilityKey: step.capabilityKey || null,
        };

        guidanceArtifact = writeGuidanceArtifact({
          artifactId: planArtifact.artifactId,
          runId,
          filePath: guidanceArtifact?.filePath,
          guidanceId: guidanceRequest.guidanceId,
          status: guidanceRequest.status,
          reason: guidanceRequest.reason,
          resumeToken: guidanceRequest.resumeToken,
          requestedBy: guidanceRequest.requestedBy,
          questions: guidanceRequest.questions,
          answers: null,
          planArtifact,
          execution,
          blockedStepIndex: stepIndex,
          stepResults,
        });

        return {
          schemaVersion: responseSchemaVersion,
          success: false,
          status: 'needs-guidance',
          error: 'GUIDANCE_REQUIRED',
          message: guidanceRequest.message,
          boundedExecutor: {
            mode: 'registry-bounded-readonly',
            source,
            featureFlagEnabled,
            runId,
            guidanceSupported: true,
            replayCommand: planArtifact?.filePath
              ? `liku github plan execute --plan-file "${planArtifact.filePath}"`
              : null,
          },
          run: buildRunEnvelope(runId, 'needs-guidance', eventLog),
          eventLog,
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
          resultArtifact: null,
          guidanceArtifact,
          guidance: {
            guidanceId: guidanceRequest.guidanceId,
            status: guidanceRequest.status,
            reason: guidanceRequest.reason,
            requestedBy: { ...guidanceRequest.requestedBy },
            questions: guidanceRequest.questions.map((entry) => ({ ...entry })),
            answers: null,
          },
          resume: {
            runId,
            artifactId: planArtifact?.artifactId || null,
            guidanceId: guidanceRequest.guidanceId,
            resumeToken: guidanceRequest.resumeToken,
            guidanceFilePath: guidanceArtifact?.filePath || null,
          },
          execution,
          stepResults,
        };
      }

      const stepElapsedMs = Math.max(0, Date.now() - stepStartedAt);
      const summary = {
        ...summarizeStepResult(step, report),
        elapsedMs: stepElapsedMs,
      };
      stepResults.push(summary);
      if (report?.success === false) {
        overallSuccess = false;
        failureCode = report.error || 'STEP_FAILED';
        failureMessage = report.message || `GitHub execution plan step ${step.id || step.capabilityKey} failed.`;
        recordEvent('step.failed', {
          status: 'aborted',
          step: stepEnvelope,
          details: {
            sequence: stepResults.length,
            error: failureCode,
            message: failureMessage,
          },
        });
        break;
      }

      recordEvent('step.completed', {
        status: 'running',
        step: stepEnvelope,
        details: {
          sequence: stepResults.length,
          elapsedMs: stepElapsedMs,
          resultSchemaVersion: summary.schemaVersion,
        },
      });
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
        elapsedMs: Math.max(0, Date.now() - stepStartedAt),
      });
      recordEvent('step.failed', {
        status: 'aborted',
        step: stepEnvelope,
        details: {
          sequence: stepResults.length,
          error: code,
          message: failureMessage,
        },
      });
      break;
    }
  }

  const finishedAt = Date.now();
  const terminalEvent = overallSuccess ? 'execution.completed' : 'execution.aborted';
  recordEvent(terminalEvent, {
    status: overallSuccess ? 'completed' : 'aborted',
    details: {
      stepsExecuted: stepResults.length,
      error: overallSuccess ? null : failureCode,
      message: overallSuccess
        ? 'GitHub execution plan completed successfully.'
        : (failureMessage || 'GitHub execution plan failed.'),
      timedOut,
    },
  });
  const execution = summarizeExecution(planSource, budget, stepResults, executionStartedAtMs, finishedAt, {
    timedOut,
    status: overallSuccess ? 'completed' : 'aborted',
    terminalEvent,
    startedAtTime: executionStartedAtMs,
    lastUpdatedAtTime: finishedAt,
    elapsedMsOverride: carriedElapsedMs + Math.max(0, finishedAt - activeSessionStartedAt),
  });
  const resultArtifact = writeResultArtifact({
    source,
    metadata: {
      outcome: overallSuccess ? 'success' : 'failure',
      cwd,
      runId,
    },
    planArtifact,
    execution,
    stepResults,
  });

  return {
    schemaVersion: responseSchemaVersion,
    success: overallSuccess,
    error: overallSuccess ? null : failureCode,
    message: overallSuccess
      ? 'GitHub execution plan completed successfully.'
      : (failureMessage || 'GitHub execution plan failed.'),
    boundedExecutor: {
      mode: 'registry-bounded-readonly',
      source,
      featureFlagEnabled,
      runId,
      guidanceSupported: true,
      replayCommand: planArtifact?.filePath
        ? `liku github plan execute --plan-file "${planArtifact.filePath}"`
        : null,
    },
    status: overallSuccess ? 'completed' : 'aborted',
    run: buildRunEnvelope(runId, overallSuccess ? 'completed' : 'aborted', eventLog),
    eventLog,
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
    guidanceArtifact,
    resume: null,
    execution,
    stepResults,
  };
}

async function resumeGitHubExecutionPlan(options = {}) {
  const source = String(options.source || 'unknown').trim().toLowerCase() || 'unknown';
  const runtimeOptions = cloneObject(options.runtimeOptions || options.options);
  const executionPreferences = cloneObject(options.executionPreferences);
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const cwd = String(options.cwd || process.cwd());
  const env = options.env || process.env;
  const aiService = options.aiService || null;
  const readGuidanceArtifact = typeof options.readGitHubPlanGuidanceArtifact === 'function'
    ? options.readGitHubPlanGuidanceArtifact
    : readGitHubPlanGuidanceArtifact;
  const readPlanArtifact = typeof options.readGitHubPlanArtifact === 'function'
    ? options.readGitHubPlanArtifact
    : readGitHubPlanArtifact;
  const readResultArtifact = typeof options.readGitHubPlanResultArtifact === 'function'
    ? options.readGitHubPlanResultArtifact
    : readGitHubPlanResultArtifact;
  const readPlanEventLogImpl = typeof options.readGitHubPlanEventLog === 'function'
    ? options.readGitHubPlanEventLog
    : readGitHubPlanEventLog;
  const appendPlanEvent = typeof options.appendGitHubPlanEvent === 'function'
    ? options.appendGitHubPlanEvent
    : appendGitHubPlanEvent;
  const writeGuidanceArtifact = typeof options.writeGitHubPlanGuidanceArtifact === 'function'
    ? options.writeGitHubPlanGuidanceArtifact
    : writeGitHubPlanGuidanceArtifact;

  const guidanceFile = String(
    runtimeOptions.guidanceFile
      || runtimeOptions['guidance-file']
      || runtimeOptions.guidancefile
      || ''
  ).trim();
  if (!guidanceFile) {
    return buildResumeUsageFailure('Usage: liku github plan resume --guidance-file <path> --resume-token <token> [--answers-file <path> | --answers-json <json>]');
  }

  let guidanceRecord;
  try {
    guidanceRecord = readGuidanceArtifact({ filePath: guidanceFile });
  } catch (error) {
    return buildExecutionFailure('GUIDANCE_ARTIFACT_NOT_FOUND', error.message, {
      schemaVersion: GITHUB_PLAN_RESUME_SCHEMA_VERSION,
      guidanceFile,
    });
  }

  if (guidanceRecord.schemaVersion !== GITHUB_PLAN_GUIDANCE_SCHEMA_VERSION) {
    return buildExecutionFailure('INVALID_GUIDANCE_ARTIFACT', `Unsupported GitHub plan guidance schema: ${guidanceRecord.schemaVersion || 'unknown'}`, {
      schemaVersion: GITHUB_PLAN_RESUME_SCHEMA_VERSION,
      guidanceFile,
    });
  }

  let planArtifactRecord;
  try {
    planArtifactRecord = readPlanArtifact({
      filePath: guidanceRecord.planArtifact?.filePath,
      artifactId: guidanceRecord.artifactId,
    });
  } catch (error) {
    return buildExecutionFailure('PLAN_ARTIFACT_NOT_FOUND', error.message, {
      schemaVersion: GITHUB_PLAN_RESUME_SCHEMA_VERSION,
      guidanceFile,
    });
  }

  const planArtifact = {
    artifactId: String(planArtifactRecord.artifactId || '').trim() || null,
    schemaVersion: String(planArtifactRecord.schemaVersion || '').trim() || null,
    createdAt: String(planArtifactRecord.createdAt || '').trim() || null,
    filePath: planArtifactRecord.filePath,
  };

  const runId = String(guidanceRecord.runId || '').trim() || buildRunId();
  let eventSequence = 0;
  let eventLog = buildEventLogEnvelope(planArtifact.artifactId, runId);
  if (eventLog?.filePath) {
    try {
      const existingEventLog = readPlanEventLogImpl({ filePath: eventLog.filePath });
      eventSequence = Array.isArray(existingEventLog.events) ? existingEventLog.events.length : 0;
    } catch {}
  }

  const existingResultArtifact = guidanceRecord.resultArtifact?.filePath || guidanceRecord.resultArtifact?.artifactId
    ? (() => {
        try {
          return readResultArtifact({
            filePath: guidanceRecord.resultArtifact?.filePath,
            artifactId: guidanceRecord.resultArtifact?.artifactId,
          });
        } catch {
          return null;
        }
      })()
    : null;

  if (guidanceRecord.status !== 'requested') {
    if (existingResultArtifact) {
      return {
        schemaVersion: GITHUB_PLAN_RESUME_SCHEMA_VERSION,
        success: existingResultArtifact.metadata?.outcome !== 'failure' && existingResultArtifact.execution?.status !== 'aborted',
        error: existingResultArtifact.execution?.status === 'aborted' ? 'ALREADY_RESUMED' : null,
        message: 'GitHub plan resume returned the current terminal state without replaying completed steps.',
        status: String(existingResultArtifact.execution?.status || guidanceRecord.status || 'completed').trim() || 'completed',
        boundedExecutor: {
          mode: 'registry-bounded-readonly',
          source,
          featureFlagEnabled,
          runId,
          guidanceSupported: true,
          replayCommand: planArtifact.filePath
            ? `liku github plan execute --plan-file "${planArtifact.filePath}"`
            : null,
        },
        run: buildRunEnvelope(runId, existingResultArtifact.execution?.status || guidanceRecord.status || 'completed', eventLog),
        eventLog,
        requestedTarget: planArtifactRecord.planReport?.requestedTarget || null,
        targetCapability: planArtifactRecord.planReport?.targetCapability || null,
        planSummary: {
          schemaVersion: planArtifactRecord.planReport?.plan?.schemaVersion || GITHUB_EXECUTION_PLAN_SCHEMA_VERSION,
          goal: planArtifactRecord.planReport?.plan?.goal || null,
          constraints: Array.isArray(planArtifactRecord.planReport?.plan?.constraints) ? planArtifactRecord.planReport.plan.constraints.slice() : [],
          budget: normalizeBudget(planArtifactRecord.planReport?.plan || {}),
          stepsTotal: Array.isArray(planArtifactRecord.planReport?.plan?.steps) ? planArtifactRecord.planReport.plan.steps.length : 0,
        },
        planArtifact,
        resultArtifact: {
          artifactId: String(existingResultArtifact.artifactId || '').trim() || null,
          schemaVersion: String(existingResultArtifact.schemaVersion || '').trim() || null,
          createdAt: String(existingResultArtifact.createdAt || '').trim() || null,
          filePath: existingResultArtifact.filePath,
        },
        guidanceArtifact: {
          artifactId: String(guidanceRecord.artifactId || '').trim() || null,
          schemaVersion: String(guidanceRecord.schemaVersion || '').trim() || null,
          createdAt: String(guidanceRecord.createdAt || '').trim() || null,
          guidanceId: String(guidanceRecord.guidanceId || '').trim() || null,
          status: String(guidanceRecord.status || '').trim() || null,
          filePath: guidanceRecord.filePath,
        },
        resume: null,
        execution: existingResultArtifact.execution || null,
        stepResults: Array.isArray(existingResultArtifact.stepResults) ? existingResultArtifact.stepResults.slice() : [],
      };
    }

    return buildExecutionFailure('GUIDANCE_NOT_PENDING', 'GitHub guidance artifact is no longer awaiting answers and cannot be resumed again.', {
      schemaVersion: GITHUB_PLAN_RESUME_SCHEMA_VERSION,
      guidanceFile,
      guidanceArtifact: {
        artifactId: String(guidanceRecord.artifactId || '').trim() || null,
        schemaVersion: String(guidanceRecord.schemaVersion || '').trim() || null,
        createdAt: String(guidanceRecord.createdAt || '').trim() || null,
        guidanceId: String(guidanceRecord.guidanceId || '').trim() || null,
        status: String(guidanceRecord.status || '').trim() || null,
        filePath: guidanceRecord.filePath,
      },
    });
  }

  const resumeToken = String(
    runtimeOptions.resumeToken
      || runtimeOptions['resume-token']
      || runtimeOptions.resumetoken
      || ''
  ).trim();
  if (!resumeToken) {
    return buildResumeUsageFailure('Usage: liku github plan resume --guidance-file <path> --resume-token <token> [--answers-file <path> | --answers-json <json>]', {
      guidanceFile,
    });
  }
  if (resumeToken !== String(guidanceRecord.resumeToken || '').trim()) {
    return buildExecutionFailure('INVALID_RESUME_TOKEN', 'GitHub plan resume token did not match the pending guidance checkpoint.', {
      schemaVersion: GITHUB_PLAN_RESUME_SCHEMA_VERSION,
      guidanceFile,
      guidanceId: String(guidanceRecord.guidanceId || '').trim() || null,
    });
  }

  let answers = null;
  const answersFile = String(
    runtimeOptions.answersFile
      || runtimeOptions['answers-file']
      || runtimeOptions.answersfile
      || ''
  ).trim();
  const answersJson = runtimeOptions.answersJson || runtimeOptions['answers-json'] || runtimeOptions.answersjson;

  try {
    if (answersFile) {
      answers = readGuidanceAnswersFromFile(answersFile);
    } else if (answersJson !== undefined && answersJson !== null && answersJson !== '') {
      answers = normalizeGuidanceAnswersInput(answersJson);
    } else if (guidanceRecord.answers && typeof guidanceRecord.answers === 'object') {
      answers = normalizeGuidanceAnswersInput(guidanceRecord.answers);
    } else {
      answers = {};
    }
  } catch (error) {
    return buildExecutionFailure('INVALID_GUIDANCE_ANSWERS', error.message, {
      schemaVersion: GITHUB_PLAN_RESUME_SCHEMA_VERSION,
      guidanceFile,
    });
  }

  const questions = Array.isArray(guidanceRecord.questions)
    ? guidanceRecord.questions.map(normalizeGuidanceQuestion)
    : [];
  const missingQuestions = questions
    .filter((entry) => entry.required !== false && !Object.prototype.hasOwnProperty.call(answers, entry.id))
    .map((entry) => entry.id);
  if (missingQuestions.length > 0) {
    return buildExecutionFailure('GUIDANCE_ANSWERS_INCOMPLETE', `GitHub plan resume is missing required guidance answer(s): ${missingQuestions.join(', ')}`, {
      schemaVersion: GITHUB_PLAN_RESUME_SCHEMA_VERSION,
      guidanceFile,
      missingQuestions,
    });
  }

  const planReport = planArtifactRecord.planReport && typeof planArtifactRecord.planReport === 'object'
    ? {
        ...planArtifactRecord.planReport,
        plan: planArtifactRecord.planReport.plan && typeof planArtifactRecord.planReport.plan === 'object'
          ? {
              ...planArtifactRecord.planReport.plan,
              steps: Array.isArray(planArtifactRecord.planReport.plan.steps)
                ? planArtifactRecord.planReport.plan.steps.map((step) => (step && typeof step === 'object' && !Array.isArray(step) ? { ...step } : step))
                : [],
            }
          : null,
      }
    : null;

  if (!planReport?.plan || !Array.isArray(planReport.plan.steps)) {
    return buildExecutionFailure('INVALID_PLAN', 'GitHub plan resume could not load a valid plan from the saved plan artifact.', {
      schemaVersion: GITHUB_PLAN_RESUME_SCHEMA_VERSION,
      guidanceFile,
    });
  }

  let blockedStepIndex = Number.isFinite(Number(guidanceRecord.blockedStepIndex)) ? Number(guidanceRecord.blockedStepIndex) : -1;
  if (blockedStepIndex < 0) {
    blockedStepIndex = planReport.plan.steps.findIndex((step) => step?.id === guidanceRecord.requestedBy?.stepId);
  }
  if (blockedStepIndex < 0) {
    return buildExecutionFailure('INVALID_GUIDANCE_ARTIFACT', 'GitHub plan resume could not identify the blocked step referenced by the guidance checkpoint.', {
      schemaVersion: GITHUB_PLAN_RESUME_SCHEMA_VERSION,
      guidanceFile,
    });
  }

  planReport.plan.steps[blockedStepIndex] = applyGuidanceAnswersToStep(planReport.plan.steps[blockedStepIndex], questions, answers);

  const guidanceRespondedRecord = appendPlanEvent({
    artifactId: planArtifact.artifactId,
    runId,
    sequence: eventSequence + 1,
    eventName: 'guidance.responded',
    source,
    status: 'running',
    guidance: {
      guidanceId: String(guidanceRecord.guidanceId || '').trim() || null,
      resumeToken,
      answerCount: Object.keys(answers).length,
    },
    details: {
      answerCount: Object.keys(answers).length,
    },
  });
  eventSequence += 1;
  eventLog = buildEventLogEnvelope(planArtifact.artifactId, runId, guidanceRespondedRecord?.filePath || null);

  const respondedGuidanceArtifact = writeGuidanceArtifact({
    artifactId: planArtifact.artifactId,
    runId,
    filePath: guidanceRecord.filePath,
    guidanceId: guidanceRecord.guidanceId,
    status: 'responded',
    reason: guidanceRecord.reason,
    resumeToken,
    requestedBy: guidanceRecord.requestedBy,
    questions,
    answers,
    planArtifact,
    execution: guidanceRecord.execution,
    blockedStepIndex,
    stepResults: Array.isArray(guidanceRecord.stepResults) ? guidanceRecord.stepResults : [],
  });

  const result = await executeGitHubExecutionPlan({
    source,
    positionals: ['plan', 'resume'],
    runtimeOptions,
    executionPreferences,
    featureFlagEnabled,
    cwd,
    env,
    aiService,
    responseSchemaVersion: GITHUB_PLAN_RESUME_SCHEMA_VERSION,
    runId,
    planReport,
    planArtifact,
    planSource: 'guidance-resume',
    guidanceArtifact: respondedGuidanceArtifact,
    guidanceState: {
      ...guidanceRecord,
      answers,
      planArtifact,
      blockedStepIndex,
    },
    initialStepResults: Array.isArray(guidanceRecord.stepResults) ? guidanceRecord.stepResults : [],
    startStepIndex: blockedStepIndex,
    carriedElapsedMs: guidanceRecord.execution?.elapsedMs,
    startedAt: guidanceRecord.execution?.startedAt || guidanceRecord.createdAt,
    eventLog,
    eventSequenceStart: eventSequence,
    resumeMode: true,
    buildGitHubExecutionPlan: options.buildGitHubExecutionPlan,
    executeGitHubCommand: options.executeGitHubCommand,
    appendGitHubPlanEvent: appendPlanEvent,
    readGitHubPlanArtifact: readPlanArtifact,
    readGitHubPlanEventLog: readPlanEventLogImpl,
    readGitHubPlanGuidanceArtifact: readGuidanceArtifact,
    readGitHubPlanResultArtifact: readResultArtifact,
    writeGitHubPlanArtifact: options.writeGitHubPlanArtifact,
    writeGitHubPlanGuidanceArtifact: writeGuidanceArtifact,
    writeGitHubPlanResultArtifact: options.writeGitHubPlanResultArtifact,
    findGitHubCapability: options.findGitHubCapability,
    evaluateGitHubCapabilityPolicy: options.evaluateGitHubCapabilityPolicy,
  });

  if (result?.status === 'needs-guidance' || result?.error === 'GUIDANCE_REQUIRED') {
    return result;
  }

  if (result?.resultArtifact?.filePath) {
    const finalizedGuidanceArtifact = writeGuidanceArtifact({
      artifactId: planArtifact.artifactId,
      runId,
      filePath: guidanceRecord.filePath,
      guidanceId: guidanceRecord.guidanceId,
      status: result.status || 'completed',
      reason: guidanceRecord.reason,
      resumeToken,
      requestedBy: guidanceRecord.requestedBy,
      questions,
      answers,
      planArtifact,
      resultArtifact: result.resultArtifact,
      execution: result.execution,
      blockedStepIndex,
      stepResults: result.stepResults,
    });
    result.guidanceArtifact = finalizedGuidanceArtifact;
  }

  return result;
}

module.exports = {
  DEFAULT_GITHUB_PLAN_EXECUTE_TIMEOUT_MS,
  GITHUB_PLAN_EXECUTE_SCHEMA_VERSION,
  GITHUB_PLAN_RESUME_SCHEMA_VERSION,
  MAX_GITHUB_PLAN_STEPS,
  MAX_GITHUB_PLAN_TIMEOUT_MS,
  buildStepRuntimeOptions,
  executeGitHubExecutionPlan,
  resumeGitHubExecutionPlan,
  validateExecutionPlan,
};
