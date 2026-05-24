const fs = require('fs');
const path = require('path');

const { LIKU_HOME } = require('../../shared/liku-home');

const PLAN_ARTIFACTS_DIR = path.join(LIKU_HOME, 'github', 'plans');
const GITHUB_PLAN_ARTIFACT_SCHEMA_VERSION = 'github.plan-artifact.v1';
const GITHUB_PLAN_RESULT_ARTIFACT_SCHEMA_VERSION = 'github.plan-result-artifact.v1';

function ensureGitHubPlanArtifactsDir() {
  if (!fs.existsSync(PLAN_ARTIFACTS_DIR)) {
    fs.mkdirSync(PLAN_ARTIFACTS_DIR, { recursive: true, mode: 0o700 });
  }
}

function buildArtifactId(prefix = 'github-plan') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildArtifactPath(artifactId, suffix) {
  return path.join(PLAN_ARTIFACTS_DIR, `${artifactId}.${suffix}.json`);
}

function writeArtifactFile(filePath, payload) {
  ensureGitHubPlanArtifactsDir();
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function summarizeArtifactRecord(record = {}, filePath = null) {
  return {
    artifactId: String(record.artifactId || '').trim() || null,
    schemaVersion: String(record.schemaVersion || '').trim() || null,
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
  GITHUB_PLAN_ARTIFACT_SCHEMA_VERSION,
  GITHUB_PLAN_RESULT_ARTIFACT_SCHEMA_VERSION,
  PLAN_ARTIFACTS_DIR,
  buildArtifactId,
  ensureGitHubPlanArtifactsDir,
  readGitHubPlanArtifact,
  writeGitHubPlanArtifact,
  writeGitHubPlanResultArtifact,
};
