const fs = require('fs');
const path = require('path');

const { LIKU_HOME } = require('../../shared/liku-home');

const PLAN_ARTIFACTS_DIR = path.join(LIKU_HOME, 'github', 'plans');
const GITHUB_PLAN_ARTIFACT_SCHEMA_VERSION = 'github.plan-artifact.v1';
const GITHUB_PLAN_RESULT_ARTIFACT_SCHEMA_VERSION = 'github.plan-result-artifact.v1';
const GITHUB_PLAN_EVENT_SCHEMA_VERSION = 'github.plan-event.v1';
const GITHUB_PLAN_GUIDANCE_SCHEMA_VERSION = 'github.plan-guidance.v1';

function ensureGitHubPlanArtifactsDir() {
  if (!fs.existsSync(PLAN_ARTIFACTS_DIR)) {
    fs.mkdirSync(PLAN_ARTIFACTS_DIR, { recursive: true, mode: 0o700 });
  }
}

function buildArtifactId(prefix = 'github-plan') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildRunId() {
  return buildArtifactId('github-run');
}

function buildGuidanceId() {
  return buildArtifactId('github-guidance');
}

function buildArtifactPath(artifactId, suffix, extension = 'json') {
  return path.join(PLAN_ARTIFACTS_DIR, `${artifactId}.${suffix}.${extension}`);
}

function buildRunScopedArtifactPath(artifactId, runId, suffix, extension = 'json') {
  return path.join(PLAN_ARTIFACTS_DIR, `${artifactId}.${runId}.${suffix}.${extension}`);
}

function writeArtifactFile(filePath, payload) {
  ensureGitHubPlanArtifactsDir();
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function appendArtifactLine(filePath, payload) {
  ensureGitHubPlanArtifactsDir();
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function resolveArtifactId(options = {}) {
  const artifactId = String(options.artifactId || options.planArtifact?.artifactId || '').trim();
  if (!artifactId) {
    throw new Error('A plan artifact id is required.');
  }
  return artifactId;
}

function resolveRunId(options = {}) {
  const runId = String(options.runId || options.run?.runId || '').trim();
  if (!runId) {
    throw new Error('A run id is required.');
  }
  return runId;
}

function summarizeArtifactRecord(record = {}, filePath = null) {
  return {
    artifactId: String(record.artifactId || '').trim() || null,
    schemaVersion: String(record.schemaVersion || '').trim() || null,
    createdAt: String(record.createdAt || '').trim() || null,
    filePath: filePath ? String(filePath) : null,
  };
}

function summarizeEventRecord(record = {}, filePath = null) {
  return {
    schemaVersion: String(record.schemaVersion || '').trim() || null,
    artifactId: String(record.artifactId || '').trim() || null,
    runId: String(record.runId || '').trim() || null,
    timestamp: String(record.timestamp || '').trim() || null,
    sequence: Number.isFinite(Number(record.sequence)) ? Number(record.sequence) : null,
    eventName: String(record.eventName || '').trim() || null,
    filePath: filePath ? String(filePath) : null,
  };
}

function summarizeGuidanceArtifactRecord(record = {}, filePath = null) {
  return {
    schemaVersion: String(record.schemaVersion || '').trim() || null,
    artifactId: String(record.artifactId || '').trim() || null,
    runId: String(record.runId || '').trim() || null,
    guidanceId: String(record.guidanceId || '').trim() || null,
    status: String(record.status || '').trim() || null,
    createdAt: String(record.createdAt || '').trim() || null,
    filePath: filePath ? String(filePath) : null,
  };
}

function writeGitHubPlanArtifact(options = {}) {
  const artifactId = String(options.artifactId || buildArtifactId('github-plan')).trim() || buildArtifactId('github-plan');
  const createdAt = new Date().toISOString();
  const filePath = buildArtifactPath(artifactId, 'plan');
  const record = {
    schemaVersion: GITHUB_PLAN_ARTIFACT_SCHEMA_VERSION,
    artifactId,
    createdAt,
    source: String(options.source || '').trim() || 'unknown',
    metadata: options.metadata && typeof options.metadata === 'object'
      ? { ...options.metadata }
      : {},
    planReport: options.planReport && typeof options.planReport === 'object'
      ? options.planReport
      : null,
  };

  writeArtifactFile(filePath, record);
  return summarizeArtifactRecord(record, filePath);
}

function writeGitHubPlanResultArtifact(options = {}) {
  const artifactId = String(options.artifactId || buildArtifactId('github-plan-result')).trim() || buildArtifactId('github-plan-result');
  const createdAt = new Date().toISOString();
  const filePath = buildArtifactPath(artifactId, 'result');
  const record = {
    schemaVersion: GITHUB_PLAN_RESULT_ARTIFACT_SCHEMA_VERSION,
    artifactId,
    createdAt,
    source: String(options.source || '').trim() || 'unknown',
    metadata: options.metadata && typeof options.metadata === 'object'
      ? { ...options.metadata }
      : {},
    planArtifact: options.planArtifact && typeof options.planArtifact === 'object'
      ? { ...options.planArtifact }
      : null,
    execution: options.execution && typeof options.execution === 'object'
      ? { ...options.execution }
      : null,
    stepResults: Array.isArray(options.stepResults) ? options.stepResults.slice() : [],
  };

  writeArtifactFile(filePath, record);
  return summarizeArtifactRecord(record, filePath);
}

function resolvePlanResultArtifactPath(options = {}) {
  const explicitPath = String(options.filePath || '').trim();
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  const artifactId = String(options.artifactId || '').trim();
  if (!artifactId) {
    throw new Error('A plan result artifact file path or artifact id is required.');
  }

  return buildArtifactPath(artifactId, 'result');
}

function readGitHubPlanResultArtifact(options = {}) {
  const filePath = resolvePlanResultArtifactPath(options);
  if (!fs.existsSync(filePath)) {
    throw new Error(`GitHub plan result artifact not found: ${filePath}`);
  }

  const text = fs.readFileSync(filePath, 'utf8');
  const record = JSON.parse(text);
  return {
    ...record,
    filePath,
  };
}

function buildGitHubPlanEventLogPath(options = {}) {
  return buildRunScopedArtifactPath(resolveArtifactId(options), resolveRunId(options), 'events', 'jsonl');
}

function appendGitHubPlanEvent(options = {}) {
  const artifactId = resolveArtifactId(options);
  const runId = resolveRunId(options);
  const timestamp = new Date().toISOString();
  const filePath = String(options.filePath || '').trim()
    ? path.resolve(String(options.filePath || '').trim())
    : buildGitHubPlanEventLogPath({ artifactId, runId });
  const record = {
    schemaVersion: GITHUB_PLAN_EVENT_SCHEMA_VERSION,
    artifactId,
    runId,
    timestamp,
    sequence: Number.isFinite(Number(options.sequence)) ? Number(options.sequence) : null,
    eventName: String(options.eventName || '').trim() || 'unknown',
    status: String(options.status || '').trim() || 'unknown',
    source: String(options.source || '').trim() || 'unknown',
    step: options.step && typeof options.step === 'object' && !Array.isArray(options.step)
      ? { ...options.step }
      : null,
    details: options.details && typeof options.details === 'object' && !Array.isArray(options.details)
      ? { ...options.details }
      : {},
    guidance: options.guidance && typeof options.guidance === 'object' && !Array.isArray(options.guidance)
      ? { ...options.guidance }
      : null,
  };

  appendArtifactLine(filePath, record);
  return summarizeEventRecord(record, filePath);
}

function readGitHubPlanEventLog(options = {}) {
  const explicitPath = String(options.filePath || '').trim();
  const filePath = explicitPath
    ? path.resolve(explicitPath)
    : buildGitHubPlanEventLogPath(options);
  if (!fs.existsSync(filePath)) {
    throw new Error(`GitHub plan event log not found: ${filePath}`);
  }

  const text = fs.readFileSync(filePath, 'utf8');
  const events = text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  return {
    schemaVersion: GITHUB_PLAN_EVENT_SCHEMA_VERSION,
    artifactId: String(events[0]?.artifactId || options.artifactId || '').trim() || null,
    runId: String(events[0]?.runId || options.runId || '').trim() || null,
    filePath,
    events,
  };
}

function buildGitHubPlanGuidanceArtifactPath(options = {}) {
  return buildRunScopedArtifactPath(resolveArtifactId(options), resolveRunId(options), 'guidance');
}

function writeGitHubPlanGuidanceArtifact(options = {}) {
  const artifactId = resolveArtifactId(options);
  const runId = resolveRunId(options);
  const guidanceId = String(options.guidanceId || buildGuidanceId()).trim() || buildGuidanceId();
  const createdAt = new Date().toISOString();
  const filePath = String(options.filePath || '').trim()
    ? path.resolve(String(options.filePath || '').trim())
    : buildGitHubPlanGuidanceArtifactPath({ artifactId, runId });
  const record = {
    schemaVersion: GITHUB_PLAN_GUIDANCE_SCHEMA_VERSION,
    runId,
    artifactId,
    guidanceId,
    createdAt,
    status: String(options.status || 'requested').trim() || 'requested',
    reason: String(options.reason || 'user-clarification').trim() || 'user-clarification',
    resumeToken: String(options.resumeToken || '').trim() || null,
    requestedBy: options.requestedBy && typeof options.requestedBy === 'object' && !Array.isArray(options.requestedBy)
      ? { ...options.requestedBy }
      : null,
    questions: Array.isArray(options.questions)
      ? options.questions.map((entry) => (entry && typeof entry === 'object' && !Array.isArray(entry) ? { ...entry } : entry))
      : [],
    answers: options.answers === undefined
      ? null
      : (options.answers && typeof options.answers === 'object'
          ? (Array.isArray(options.answers)
              ? options.answers.map((entry) => (entry && typeof entry === 'object' && !Array.isArray(entry) ? { ...entry } : entry))
              : { ...options.answers })
          : options.answers),
    planArtifact: options.planArtifact && typeof options.planArtifact === 'object' && !Array.isArray(options.planArtifact)
      ? { ...options.planArtifact }
      : null,
    resultArtifact: options.resultArtifact && typeof options.resultArtifact === 'object' && !Array.isArray(options.resultArtifact)
      ? { ...options.resultArtifact }
      : null,
    execution: options.execution && typeof options.execution === 'object' && !Array.isArray(options.execution)
      ? { ...options.execution }
      : null,
    blockedStepIndex: Number.isFinite(Number(options.blockedStepIndex)) ? Number(options.blockedStepIndex) : null,
    stepResults: Array.isArray(options.stepResults)
      ? options.stepResults.map((entry) => (entry && typeof entry === 'object' && !Array.isArray(entry) ? { ...entry } : entry))
      : [],
  };

  writeArtifactFile(filePath, record);
  return summarizeGuidanceArtifactRecord(record, filePath);
}

function readGitHubPlanGuidanceArtifact(options = {}) {
  const explicitPath = String(options.filePath || '').trim();
  const filePath = explicitPath
    ? path.resolve(explicitPath)
    : buildGitHubPlanGuidanceArtifactPath(options);
  if (!fs.existsSync(filePath)) {
    throw new Error(`GitHub plan guidance artifact not found: ${filePath}`);
  }

  const text = fs.readFileSync(filePath, 'utf8');
  const record = JSON.parse(text);
  return {
    ...record,
    filePath,
  };
}

function resolvePlanArtifactPath(options = {}) {
  const explicitPath = String(options.filePath || '').trim();
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  const artifactId = String(options.artifactId || '').trim();
  if (!artifactId) {
    throw new Error('A plan artifact file path or artifact id is required.');
  }

  return buildArtifactPath(artifactId, 'plan');
}

function readGitHubPlanArtifact(options = {}) {
  const filePath = resolvePlanArtifactPath(options);
  if (!fs.existsSync(filePath)) {
    throw new Error(`GitHub plan artifact not found: ${filePath}`);
  }

  const text = fs.readFileSync(filePath, 'utf8');
  const record = JSON.parse(text);
  return {
    ...record,
    filePath,
  };
}

module.exports = {
  GITHUB_PLAN_EVENT_SCHEMA_VERSION,
  GITHUB_PLAN_GUIDANCE_SCHEMA_VERSION,
  GITHUB_PLAN_ARTIFACT_SCHEMA_VERSION,
  GITHUB_PLAN_RESULT_ARTIFACT_SCHEMA_VERSION,
  PLAN_ARTIFACTS_DIR,
  appendGitHubPlanEvent,
  buildArtifactId,
  buildGuidanceId,
  buildGitHubPlanEventLogPath,
  buildGitHubPlanGuidanceArtifactPath,
  buildRunId,
  ensureGitHubPlanArtifactsDir,
  readGitHubPlanArtifact,
  readGitHubPlanEventLog,
  readGitHubPlanGuidanceArtifact,
  readGitHubPlanResultArtifact,
  writeGitHubPlanArtifact,
  writeGitHubPlanGuidanceArtifact,
  writeGitHubPlanResultArtifact,
};
