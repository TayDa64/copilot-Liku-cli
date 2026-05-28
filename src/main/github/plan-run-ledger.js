const fs = require('fs');
const path = require('path');

const {
  GITHUB_PLAN_ARTIFACT_SCHEMA_VERSION,
  GITHUB_PLAN_EVENT_SCHEMA_VERSION,
  GITHUB_PLAN_GUIDANCE_SCHEMA_VERSION,
  GITHUB_PLAN_RESULT_ARTIFACT_SCHEMA_VERSION,
  PLAN_ARTIFACTS_DIR,
  readGitHubPlanArtifact,
  readGitHubPlanEventLog,
  readGitHubPlanGuidanceArtifact,
  readGitHubPlanResultArtifact,
} = require('./plan-artifacts');
const { normalizeLimit } = require('./governance-redaction');

const PLAN_RUN_STATE_VALUES = ['all', 'completed', 'blocked', 'aborted', 'in-progress'];

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeLowerText(value) {
  return normalizeText(value).toLowerCase();
}

function cloneRecord(value) {
  if (value === null || value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

function toTimestamp(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return Number.NaN;
  }
  return Date.parse(normalized);
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function extractFirstText(values = []) {
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function extractTargetSlugFromPlanRecord(record) {
  const requestedTarget = isObject(record?.planReport?.requestedTarget) ? record.planReport.requestedTarget : {};
  const firstStep = Array.isArray(record?.planReport?.plan?.steps) ? record.planReport.plan.steps[0] : null;
  const runtimeInput = isObject(firstStep?.runtimeInput) ? firstStep.runtimeInput : {};
  const invocationOptions = isObject(firstStep?.invocation?.options) ? firstStep.invocation.options : {};
  const runtimeOptions = isObject(runtimeInput.options) ? runtimeInput.options : {};

  return extractFirstText([
    requestedTarget?.options?.slug,
    runtimeInput.slug,
    runtimeOptions.slug,
    invocationOptions.slug,
  ]);
}

function normalizePlanRunStateFilter(value) {
  const normalized = normalizeLowerText(value);
  if (!normalized || normalized === 'all') {
    return 'all';
  }
  if (normalized === 'needs-guidance' || normalized === 'requested' || normalized === 'responded') {
    return 'blocked';
  }
  if (PLAN_RUN_STATE_VALUES.includes(normalized)) {
    return normalized;
  }
  return null;
}

function chooseLatestRecord(currentRecord, nextRecord, ...timestamps) {
  if (!nextRecord) {
    return currentRecord || null;
  }
  if (!currentRecord) {
    return nextRecord;
  }

  const currentTimestamp = timestamps
    .map((selector) => Number(selector(currentRecord)))
    .find((value) => Number.isFinite(value));
  const nextTimestamp = timestamps
    .map((selector) => Number(selector(nextRecord)))
    .find((value) => Number.isFinite(value));

  if (!Number.isFinite(currentTimestamp) && !Number.isFinite(nextTimestamp)) {
    return nextRecord;
  }
  if (!Number.isFinite(currentTimestamp)) {
    return nextRecord;
  }
  if (!Number.isFinite(nextTimestamp)) {
    return currentRecord;
  }
  return nextTimestamp >= currentTimestamp ? nextRecord : currentRecord;
}

function buildEmptyRunEntry(runId) {
  return {
    runId: normalizeText(runId) || null,
    planArtifactId: null,
    planRecord: null,
    resultRecord: null,
    guidanceRecord: null,
    eventLogRecord: null,
  };
}

function upsertRunEntry(runsByRunId, runId) {
  const normalizedRunId = normalizeText(runId);
  if (!normalizedRunId) {
    return null;
  }

  const existing = runsByRunId.get(normalizedRunId);
  if (existing) {
    return existing;
  }

  const entry = buildEmptyRunEntry(normalizedRunId);
  runsByRunId.set(normalizedRunId, entry);
  return entry;
}

function listArtifactFiles(artifactDir) {
  const directory = path.resolve(String(artifactDir || PLAN_ARTIFACTS_DIR));
  if (!fs.existsSync(directory)) {
    return {
      artifactDir: directory,
      planFiles: [],
      resultFiles: [],
      guidanceFiles: [],
      eventLogFiles: [],
    };
  }

  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(directory, entry.name));

  return {
    artifactDir: directory,
    planFiles: files.filter((filePath) => /\.plan\.json$/i.test(filePath)),
    resultFiles: files.filter((filePath) => /\.result\.json$/i.test(filePath)),
    guidanceFiles: files.filter((filePath) => /\.guidance\.json$/i.test(filePath)),
    eventLogFiles: files.filter((filePath) => /\.events\.jsonl$/i.test(filePath)),
  };
}

function readArtifactFileSafe(reader, filePath, warnings, label) {
  try {
    return reader({ filePath });
  } catch (error) {
    if (Array.isArray(warnings)) {
      warnings.push(`${label} read failed for ${filePath}: ${error.message}`);
    }
    return null;
  }
}

function summarizeArtifact(record) {
  if (!record || typeof record !== 'object') {
    return null;
  }

  return {
    artifactId: normalizeText(record.artifactId) || null,
    schemaVersion: normalizeText(record.schemaVersion) || null,
    createdAt: extractFirstText([record.createdAt, record.recordedAt]) || null,
    filePath: normalizeText(record.filePath) || null,
  };
}

function summarizeGuidanceArtifact(record) {
  if (!record || typeof record !== 'object') {
    return null;
  }

  return {
    ...summarizeArtifact(record),
    runId: normalizeText(record.runId) || null,
    guidanceId: normalizeText(record.guidanceId) || null,
    status: normalizeText(record.status) || null,
    reason: normalizeText(record.reason) || null,
    questionCount: Array.isArray(record.questions) ? record.questions.length : 0,
  };
}

function summarizeEventLog(record) {
  if (!record || typeof record !== 'object') {
    return null;
  }

  const events = Array.isArray(record.events) ? record.events : [];
  const latestEvent = events.length > 0 ? events[events.length - 1] : null;

  return {
    schemaVersion: normalizeText(record.schemaVersion) || null,
    artifactId: normalizeText(record.artifactId) || null,
    runId: normalizeText(record.runId) || null,
    filePath: normalizeText(record.filePath) || null,
    eventCount: events.length,
    latestEventName: normalizeText(latestEvent?.eventName) || null,
    latestTimestamp: normalizeText(latestEvent?.timestamp) || null,
    terminalEvent: normalizeText(latestEvent?.eventName) || null,
    events: events.map((event) => ({
      sequence: Number.isFinite(Number(event?.sequence)) ? Number(event.sequence) : null,
      timestamp: normalizeText(event?.timestamp) || null,
      eventName: normalizeText(event?.eventName) || null,
      status: normalizeText(event?.status) || null,
      step: isObject(event?.step) ? cloneRecord(event.step) : null,
      details: isObject(event?.details) ? cloneRecord(event.details) : {},
      guidance: isObject(event?.guidance) ? cloneRecord(event.guidance) : null,
    })),
  };
}

function deriveExecutionState(entry) {
  const resultStatus = normalizeLowerText(entry?.resultRecord?.execution?.status);
  if (resultStatus === 'completed') {
    return 'completed';
  }
  if (resultStatus === 'aborted') {
    return 'aborted';
  }

  const guidanceExecutionStatus = normalizeLowerText(entry?.guidanceRecord?.execution?.status);
  const guidanceStatus = normalizeLowerText(entry?.guidanceRecord?.status);
  if (guidanceExecutionStatus === 'needs-guidance' || ['requested', 'responded'].includes(guidanceStatus)) {
    return 'blocked';
  }

  const latestEventName = normalizeLowerText(entry?.eventLogRecord?.events?.[entry.eventLogRecord.events.length - 1]?.eventName);
  if (latestEventName === 'execution.completed') {
    return 'completed';
  }
  if (latestEventName === 'execution.aborted') {
    return 'aborted';
  }
  if (latestEventName === 'guidance.requested') {
    return 'blocked';
  }

  if (entry?.eventLogRecord || entry?.planRecord) {
    return 'in-progress';
  }

  return 'unknown';
}

function deriveExecutionSummary(entry) {
  const recordExecution = isObject(entry?.resultRecord?.execution)
    ? entry.resultRecord.execution
    : (isObject(entry?.guidanceRecord?.execution) ? entry.guidanceRecord.execution : null);

  if (recordExecution) {
    return cloneRecord(recordExecution);
  }

  const state = deriveExecutionState(entry);
  const eventLog = Array.isArray(entry?.eventLogRecord?.events) ? entry.eventLogRecord.events : [];
  const firstEvent = eventLog.length > 0 ? eventLog[0] : null;
  const latestEvent = eventLog.length > 0 ? eventLog[eventLog.length - 1] : null;

  return {
    status: state,
    terminal: state === 'completed' || state === 'aborted',
    startedAt: extractFirstText([firstEvent?.timestamp, entry?.planRecord?.createdAt, entry?.guidanceRecord?.createdAt, entry?.resultRecord?.createdAt]) || null,
    lastUpdatedAt: extractFirstText([latestEvent?.timestamp, entry?.guidanceRecord?.createdAt, entry?.resultRecord?.createdAt, entry?.planRecord?.createdAt]) || null,
    finishedAt: state === 'completed' || state === 'aborted'
      ? extractFirstText([latestEvent?.timestamp, entry?.resultRecord?.createdAt]) || null
      : null,
    elapsedMs: null,
    timedOut: false,
    terminalEvent: normalizeText(latestEvent?.eventName) || null,
    stepsExecuted: eventLog.filter((event) => normalizeLowerText(event?.eventName) === 'step.completed').length,
  };
}

function summarizeRunEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const execution = deriveExecutionSummary(entry);
  const planReport = isObject(entry.planRecord?.planReport) ? entry.planRecord.planReport : {};
  const targetCapability = isObject(planReport.targetCapability)
    ? cloneRecord(planReport.targetCapability)
    : null;
  const requestedTarget = isObject(planReport.requestedTarget)
    ? cloneRecord(planReport.requestedTarget)
    : null;
  const eventLog = Array.isArray(entry?.eventLogRecord?.events) ? entry.eventLogRecord.events : [];
  const latestEvent = eventLog.length > 0 ? eventLog[eventLog.length - 1] : null;
  const guidanceRecord = isObject(entry.guidanceRecord) ? entry.guidanceRecord : null;
  const guidanceSummary = guidanceRecord
    ? {
        guidanceId: normalizeText(guidanceRecord.guidanceId) || null,
        status: normalizeText(guidanceRecord.status) || null,
        reason: normalizeText(guidanceRecord.reason) || null,
        questionCount: Array.isArray(guidanceRecord.questions) ? guidanceRecord.questions.length : 0,
      }
    : null;

  const createdAt = extractFirstText([
    entry.planRecord?.createdAt,
    entry.guidanceRecord?.createdAt,
    entry.resultRecord?.createdAt,
    eventLog[0]?.timestamp,
  ]);
  const lastUpdatedAt = extractFirstText([
    execution?.lastUpdatedAt,
    latestEvent?.timestamp,
    entry.resultRecord?.createdAt,
    entry.guidanceRecord?.createdAt,
    entry.planRecord?.createdAt,
  ]);

  return {
    runId: normalizeText(entry.runId) || null,
    state: deriveExecutionState(entry),
    slug: extractTargetSlugFromPlanRecord(entry.planRecord),
    artifactId: extractFirstText([
      entry.planArtifactId,
      entry.planRecord?.artifactId,
      entry.eventLogRecord?.artifactId,
      entry.guidanceRecord?.artifactId,
      entry.resultRecord?.planArtifact?.artifactId,
    ]),
    createdAt,
    startedAt: extractFirstText([execution?.startedAt, createdAt]) || null,
    lastUpdatedAt,
    finishedAt: extractFirstText([execution?.finishedAt]) || null,
    elapsedMs: Number.isFinite(Number(execution?.elapsedMs)) ? Number(execution.elapsedMs) : null,
    timedOut: execution?.timedOut === true,
    targetCapability,
    requestedTarget,
    goal: extractFirstText([planReport?.plan?.goal]) || null,
    planSource: extractFirstText([execution?.planSource]) || null,
    stepsExecuted: Number.isFinite(Number(execution?.stepsExecuted))
      ? Number(execution.stepsExecuted)
      : (Array.isArray(entry?.resultRecord?.stepResults) ? entry.resultRecord.stepResults.length : 0),
    eventCount: eventLog.length,
    latestEventName: normalizeText(latestEvent?.eventName) || null,
    latestEventStatus: normalizeText(latestEvent?.status) || null,
    latestEventAt: normalizeText(latestEvent?.timestamp) || null,
    guidance: guidanceSummary,
    planArtifact: summarizeArtifact(entry.planRecord),
    resultArtifact: summarizeArtifact(entry.resultRecord),
    guidanceArtifact: summarizeGuidanceArtifact(entry.guidanceRecord),
    eventLog: summarizeEventLog(entry.eventLogRecord),
  };
}

function sortRunsByMostRecent(runs = []) {
  return runs.slice().sort((left, right) => {
    const rightTimestamp = toTimestamp(right?.lastUpdatedAt || right?.createdAt);
    const leftTimestamp = toTimestamp(left?.lastUpdatedAt || left?.createdAt);
    if (!Number.isFinite(leftTimestamp) && !Number.isFinite(rightTimestamp)) {
      return String(right?.runId || '').localeCompare(String(left?.runId || ''));
    }
    if (!Number.isFinite(leftTimestamp)) {
      return 1;
    }
    if (!Number.isFinite(rightTimestamp)) {
      return -1;
    }
    return rightTimestamp - leftTimestamp;
  });
}

function matchesRunFilters(summary, options = {}) {
  if (!summary || typeof summary !== 'object') {
    return false;
  }

  const slugFilter = normalizeLowerText(options.slug);
  if (slugFilter) {
    const summarySlug = normalizeLowerText(summary.slug);
    if (!summarySlug || summarySlug !== slugFilter) {
      return false;
    }
  }

  const stateFilter = normalizePlanRunStateFilter(options.state);
  if (stateFilter && stateFilter !== 'all') {
    if (normalizeLowerText(summary.state) !== stateFilter) {
      return false;
    }
  }

  return true;
}

function buildPlanRunLedger(options = {}) {
  const warnings = Array.isArray(options.warnings) ? options.warnings : [];
  const files = listArtifactFiles(options.artifactDir || PLAN_ARTIFACTS_DIR);
  const planArtifactsByArtifactId = new Map();
  const runsByRunId = new Map();

  for (const filePath of files.planFiles) {
    const record = readArtifactFileSafe(readGitHubPlanArtifact, filePath, warnings, 'GitHub plan artifact');
    if (!record || normalizeText(record.schemaVersion) !== GITHUB_PLAN_ARTIFACT_SCHEMA_VERSION) {
      continue;
    }

    const artifactId = normalizeText(record.artifactId);
    if (artifactId) {
      const current = planArtifactsByArtifactId.get(artifactId);
      planArtifactsByArtifactId.set(
        artifactId,
        chooseLatestRecord(
          current,
          record,
          (value) => toTimestamp(value?.createdAt),
          (value) => toTimestamp(value?.metadata?.createdAt)
        )
      );
    }

    const runId = normalizeText(record?.metadata?.runId);
    if (runId) {
      const entry = upsertRunEntry(runsByRunId, runId);
      entry.planArtifactId = artifactId || entry.planArtifactId;
      entry.planRecord = chooseLatestRecord(
        entry.planRecord,
        record,
        (value) => toTimestamp(value?.createdAt)
      );
    }
  }

  for (const filePath of files.guidanceFiles) {
    const record = readArtifactFileSafe(readGitHubPlanGuidanceArtifact, filePath, warnings, 'GitHub plan guidance artifact');
    if (!record || normalizeText(record.schemaVersion) !== GITHUB_PLAN_GUIDANCE_SCHEMA_VERSION) {
      continue;
    }

    const entry = upsertRunEntry(runsByRunId, record.runId);
    if (!entry) {
      continue;
    }
    entry.planArtifactId = normalizeText(record.artifactId) || entry.planArtifactId;
    entry.guidanceRecord = chooseLatestRecord(
      entry.guidanceRecord,
      record,
      (value) => toTimestamp(value?.execution?.lastUpdatedAt),
      (value) => toTimestamp(value?.createdAt)
    );
  }

  for (const filePath of files.eventLogFiles) {
    const record = readArtifactFileSafe(readGitHubPlanEventLog, filePath, warnings, 'GitHub plan event log');
    if (!record || normalizeText(record.schemaVersion) !== GITHUB_PLAN_EVENT_SCHEMA_VERSION) {
      continue;
    }

    const entry = upsertRunEntry(runsByRunId, record.runId);
    if (!entry) {
      continue;
    }
    entry.planArtifactId = normalizeText(record.artifactId) || entry.planArtifactId;
    entry.eventLogRecord = chooseLatestRecord(
      entry.eventLogRecord,
      record,
      (value) => toTimestamp(value?.events?.[value.events.length - 1]?.timestamp),
      (value) => toTimestamp(value?.events?.[0]?.timestamp)
    );
  }

  for (const filePath of files.resultFiles) {
    const record = readArtifactFileSafe(readGitHubPlanResultArtifact, filePath, warnings, 'GitHub plan result artifact');
    if (!record || normalizeText(record.schemaVersion) !== GITHUB_PLAN_RESULT_ARTIFACT_SCHEMA_VERSION) {
      continue;
    }

    const runId = normalizeText(record?.metadata?.runId);
    if (!runId) {
      continue;
    }

    const entry = upsertRunEntry(runsByRunId, runId);
    entry.planArtifactId = normalizeText(record?.planArtifact?.artifactId) || entry.planArtifactId;
    entry.resultRecord = chooseLatestRecord(
      entry.resultRecord,
      record,
      (value) => toTimestamp(value?.execution?.lastUpdatedAt),
      (value) => toTimestamp(value?.execution?.finishedAt),
      (value) => toTimestamp(value?.createdAt)
    );
  }

  for (const entry of runsByRunId.values()) {
    if (!entry.planRecord && entry.planArtifactId && planArtifactsByArtifactId.has(entry.planArtifactId)) {
      entry.planRecord = planArtifactsByArtifactId.get(entry.planArtifactId) || null;
    }
    if (!entry.planArtifactId) {
      entry.planArtifactId = extractFirstText([
        entry.planRecord?.artifactId,
        entry.guidanceRecord?.artifactId,
        entry.eventLogRecord?.artifactId,
        entry.resultRecord?.planArtifact?.artifactId,
      ]);
    }
  }

  return {
    artifactDir: files.artifactDir,
    warnings,
    runsByRunId,
    planArtifactsByArtifactId,
  };
}

function attachExplicitPlanArtifact(ledger, runId, filePath) {
  const record = readGitHubPlanArtifact({ filePath });
  if (normalizeText(record.schemaVersion) !== GITHUB_PLAN_ARTIFACT_SCHEMA_VERSION) {
    throw new Error(`Unsupported GitHub plan artifact schema: ${record.schemaVersion || 'unknown'}`);
  }

  const artifactRunId = normalizeText(record?.metadata?.runId);
  if (artifactRunId && normalizeLowerText(artifactRunId) !== normalizeLowerText(runId)) {
    throw new Error(`GitHub plan artifact ${filePath} belongs to ${artifactRunId}, not ${runId}.`);
  }

  const entry = upsertRunEntry(ledger.runsByRunId, artifactRunId || runId);
  entry.planArtifactId = normalizeText(record.artifactId) || entry.planArtifactId;
  entry.planRecord = record;
  ledger.planArtifactsByArtifactId.set(normalizeText(record.artifactId), record);
  return entry;
}

function attachExplicitEventLog(ledger, runId, filePath) {
  const record = readGitHubPlanEventLog({ filePath });
  if (normalizeText(record.schemaVersion) !== GITHUB_PLAN_EVENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported GitHub plan event log schema: ${record.schemaVersion || 'unknown'}`);
  }

  const artifactRunId = normalizeText(record.runId);
  if (artifactRunId && normalizeLowerText(artifactRunId) !== normalizeLowerText(runId)) {
    throw new Error(`GitHub plan event log ${filePath} belongs to ${artifactRunId}, not ${runId}.`);
  }

  const entry = upsertRunEntry(ledger.runsByRunId, artifactRunId || runId);
  entry.planArtifactId = normalizeText(record.artifactId) || entry.planArtifactId;
  entry.eventLogRecord = record;
  if (!entry.planRecord && entry.planArtifactId && ledger.planArtifactsByArtifactId.has(entry.planArtifactId)) {
    entry.planRecord = ledger.planArtifactsByArtifactId.get(entry.planArtifactId) || null;
  }
  return entry;
}

function listGitHubPlanRunsLedger(options = {}) {
  const warnings = [];
  const state = normalizePlanRunStateFilter(options.state);
  const limit = normalizeLimit(options.limit, 20, 200);
  const ledger = buildPlanRunLedger({ artifactDir: options.artifactDir, warnings });
  const allRuns = Array.from(ledger.runsByRunId.values())
    .map(summarizeRunEntry)
    .filter(Boolean)
    .filter((summary) => matchesRunFilters(summary, { slug: options.slug, state }));
  const runs = sortRunsByMostRecent(allRuns);

  return {
    artifactDir: ledger.artifactDir,
    warnings,
    invalidState: state === null ? normalizeText(options.state) || null : null,
    totalCount: runs.length,
    runs: runs.slice(0, limit),
  };
}

function inspectGitHubPlanRunLedger(options = {}) {
  const normalizedRunId = normalizeText(options.runId);
  if (!normalizedRunId) {
    throw new Error('A GitHub plan run id is required.');
  }

  const warnings = [];
  const ledger = buildPlanRunLedger({ artifactDir: options.artifactDir, warnings });

  if (options.planFile) {
    attachExplicitPlanArtifact(ledger, normalizedRunId, options.planFile);
  }
  if (options.eventLogFile) {
    attachExplicitEventLog(ledger, normalizedRunId, options.eventLogFile);
  }

  const normalizedRequestedRunId = normalizeLowerText(normalizedRunId);
  const entry = Array.from(ledger.runsByRunId.values())
    .find((candidate) => normalizeLowerText(candidate?.runId) === normalizedRequestedRunId) || null;

  if (!entry) {
    return {
      artifactDir: ledger.artifactDir,
      warnings,
      run: null,
    };
  }

  if (!entry.planRecord && entry.planArtifactId && ledger.planArtifactsByArtifactId.has(entry.planArtifactId)) {
    entry.planRecord = ledger.planArtifactsByArtifactId.get(entry.planArtifactId) || null;
  }

  const run = summarizeRunEntry(entry);
  const execution = deriveExecutionSummary(entry);

  return {
    artifactDir: ledger.artifactDir,
    warnings,
    run,
    planArtifact: summarizeArtifact(entry.planRecord),
    resultArtifact: summarizeArtifact(entry.resultRecord),
    guidanceArtifact: summarizeGuidanceArtifact(entry.guidanceRecord),
    eventLog: summarizeEventLog(entry.eventLogRecord),
    plan: isObject(entry.planRecord?.planReport) ? cloneRecord(entry.planRecord.planReport) : null,
    execution,
    stepResults: Array.isArray(entry?.resultRecord?.stepResults)
      ? cloneRecord(entry.resultRecord.stepResults)
      : (Array.isArray(entry?.guidanceRecord?.stepResults) ? cloneRecord(entry.guidanceRecord.stepResults) : []),
    guidance: isObject(entry.guidanceRecord)
      ? {
          runId: normalizeText(entry.guidanceRecord.runId) || null,
          guidanceId: normalizeText(entry.guidanceRecord.guidanceId) || null,
          status: normalizeText(entry.guidanceRecord.status) || null,
          reason: normalizeText(entry.guidanceRecord.reason) || null,
          resumeToken: normalizeText(entry.guidanceRecord.resumeToken) || null,
          requestedBy: isObject(entry.guidanceRecord.requestedBy) ? cloneRecord(entry.guidanceRecord.requestedBy) : null,
          blockedStepIndex: Number.isFinite(Number(entry.guidanceRecord.blockedStepIndex)) ? Number(entry.guidanceRecord.blockedStepIndex) : null,
          questions: Array.isArray(entry.guidanceRecord.questions) ? cloneRecord(entry.guidanceRecord.questions) : [],
          answers: entry.guidanceRecord.answers === undefined ? null : cloneRecord(entry.guidanceRecord.answers),
        }
      : null,
  };
}

module.exports = {
  PLAN_RUN_STATE_VALUES,
  normalizePlanRunStateFilter,
  listGitHubPlanRunsLedger,
  inspectGitHubPlanRunLedger,
  summarizeRunEntry,
};
