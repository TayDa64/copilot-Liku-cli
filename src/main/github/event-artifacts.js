const fs = require('fs');
const path = require('path');

const { LIKU_HOME } = require('../../shared/liku-home');

const GITHUB_EVENT_ARTIFACT_SCHEMA_VERSION = 'github.event-artifact.v1';
const GITHUB_EVENT_LOG_SCHEMA_VERSION = 'github.event-log.v1';
const GITHUB_EVENT_ARTIFACTS_DIR = path.join(LIKU_HOME, 'github', 'events');
const GITHUB_EVENT_LOG_FILE = path.join(GITHUB_EVENT_ARTIFACTS_DIR, 'github-events.jsonl');

function ensureGitHubEventArtifactsDir() {
  if (!fs.existsSync(GITHUB_EVENT_ARTIFACTS_DIR)) {
    fs.mkdirSync(GITHUB_EVENT_ARTIFACTS_DIR, { recursive: true, mode: 0o700 });
  }
}

function buildGitHubEventId(prefix = 'github-event') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildGitHubEventArtifactPath(eventId, suffix = 'event', extension = 'json') {
  return path.join(GITHUB_EVENT_ARTIFACTS_DIR, `${String(eventId || '').trim()}.${suffix}.${extension}`);
}

function buildGitHubEventLogPath(options = {}) {
  const explicitPath = String(options.filePath || '').trim();
  if (explicitPath) {
    return path.resolve(explicitPath);
  }
  return GITHUB_EVENT_LOG_FILE;
}

function writeArtifactFile(filePath, payload) {
  ensureGitHubEventArtifactsDir();
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function appendArtifactLine(filePath, payload) {
  ensureGitHubEventArtifactsDir();
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeLowerText(value) {
  return normalizeText(value).toLowerCase();
}

function cloneRecord(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function summarizeReview(review) {
  if (!review || typeof review !== 'object') {
    return null;
  }

  return {
    sensitivity: normalizeText(review.sensitivity) || null,
    redactionCount: Number.isFinite(Number(review.redactionCount)) ? Number(review.redactionCount) : 0,
    reviewRequired: review.reviewRequired === true,
    reviewRecommended: review.reviewRecommended === true,
  };
}

function summarizeGitHubEventArtifactRecord(record = {}, filePath = null) {
  const delivery = record.delivery && typeof record.delivery === 'object' ? record.delivery : {};
  const summary = record.summary && typeof record.summary === 'object' ? record.summary : {};
  const target = record.target && typeof record.target === 'object' ? record.target : {};

  return {
    schemaVersion: normalizeText(record.schemaVersion) || null,
    eventId: normalizeText(record.eventId) || null,
    recordedAt: normalizeText(record.recordedAt) || null,
    receivedAt: normalizeText(record.receivedAt) || null,
    eventName: normalizeText(delivery.eventName || summary.eventName) || null,
    action: normalizeText(delivery.action || summary.action) || null,
    deliveryId: normalizeText(delivery.deliveryId || summary.deliveryId) || null,
    source: normalizeText(record.source || summary.source) || null,
    slug: normalizeText(target.slug || summary.slug) || null,
    hookId: Number.isFinite(Number(delivery.hookId || summary.hookId)) ? Number(delivery.hookId || summary.hookId) : null,
    installationId: Number.isFinite(Number(delivery.installationId || summary.installationId)) ? Number(delivery.installationId || summary.installationId) : null,
    senderLogin: normalizeText(summary.senderLogin) || null,
    payloadKeys: Array.isArray(summary.payloadKeys) ? summary.payloadKeys.slice(0, 20) : [],
    payloadPreview: summary.payloadPreview && typeof summary.payloadPreview === 'object'
      ? cloneRecord(summary.payloadPreview)
      : null,
    review: summarizeReview(record.review),
    filePath: filePath ? String(filePath) : null,
  };
}

function summarizeGitHubEventLogRecord(record = {}, filePath = null) {
  const delivery = record.delivery && typeof record.delivery === 'object' ? record.delivery : {};
  const summary = record.summary && typeof record.summary === 'object' ? record.summary : {};
  const target = record.target && typeof record.target === 'object' ? record.target : {};
  const artifact = record.artifact && typeof record.artifact === 'object' ? record.artifact : {};

  return {
    schemaVersion: normalizeText(record.schemaVersion) || null,
    eventId: normalizeText(record.eventId) || null,
    recordedAt: normalizeText(record.recordedAt) || null,
    receivedAt: normalizeText(record.receivedAt) || null,
    eventName: normalizeText(delivery.eventName || summary.eventName) || null,
    action: normalizeText(delivery.action || summary.action) || null,
    deliveryId: normalizeText(delivery.deliveryId || summary.deliveryId) || null,
    source: normalizeText(record.source || summary.source) || null,
    slug: normalizeText(target.slug || summary.slug) || null,
    hookId: Number.isFinite(Number(delivery.hookId || summary.hookId)) ? Number(delivery.hookId || summary.hookId) : null,
    installationId: Number.isFinite(Number(delivery.installationId || summary.installationId)) ? Number(delivery.installationId || summary.installationId) : null,
    senderLogin: normalizeText(summary.senderLogin) || null,
    payloadKeys: Array.isArray(summary.payloadKeys) ? summary.payloadKeys.slice(0, 20) : [],
    payloadPreview: summary.payloadPreview && typeof summary.payloadPreview === 'object'
      ? cloneRecord(summary.payloadPreview)
      : null,
    review: summarizeReview(record.review),
    artifact: {
      eventId: normalizeText(artifact.eventId || record.eventId) || null,
      filePath: normalizeText(artifact.filePath) || null,
    },
    filePath: filePath ? String(filePath) : null,
  };
}

function writeGitHubEventArtifact(options = {}) {
  const eventId = normalizeText(options.eventId) || buildGitHubEventId();
  const recordedAt = new Date().toISOString();
  const filePath = String(options.filePath || '').trim()
    ? path.resolve(String(options.filePath || '').trim())
    : buildGitHubEventArtifactPath(eventId, 'event');
  const record = {
    schemaVersion: GITHUB_EVENT_ARTIFACT_SCHEMA_VERSION,
    eventId,
    recordedAt,
    receivedAt: normalizeText(options.receivedAt) || recordedAt,
    source: normalizeText(options.source) || 'github-webhook',
    target: options.target && typeof options.target === 'object' && !Array.isArray(options.target)
      ? cloneRecord(options.target)
      : {},
    delivery: options.delivery && typeof options.delivery === 'object' && !Array.isArray(options.delivery)
      ? cloneRecord(options.delivery)
      : {},
    summary: options.summary && typeof options.summary === 'object' && !Array.isArray(options.summary)
      ? cloneRecord(options.summary)
      : {},
    headers: options.headers && typeof options.headers === 'object' && !Array.isArray(options.headers)
      ? cloneRecord(options.headers)
      : {},
    payload: options.payload === undefined ? null : cloneRecord(options.payload),
    review: options.review && typeof options.review === 'object' && !Array.isArray(options.review)
      ? cloneRecord(options.review)
      : null,
    metadata: options.metadata && typeof options.metadata === 'object' && !Array.isArray(options.metadata)
      ? cloneRecord(options.metadata)
      : {},
  };

  writeArtifactFile(filePath, record);
  return summarizeGitHubEventArtifactRecord(record, filePath);
}

function appendGitHubEventLog(options = {}) {
  const eventId = normalizeText(options.eventId);
  if (!eventId) {
    throw new Error('A GitHub event id is required to append the event log.');
  }

  const filePath = buildGitHubEventLogPath(options);
  const record = {
    schemaVersion: GITHUB_EVENT_LOG_SCHEMA_VERSION,
    eventId,
    recordedAt: new Date().toISOString(),
    receivedAt: normalizeText(options.receivedAt) || null,
    source: normalizeText(options.source) || 'github-webhook',
    target: options.target && typeof options.target === 'object' && !Array.isArray(options.target)
      ? cloneRecord(options.target)
      : {},
    delivery: options.delivery && typeof options.delivery === 'object' && !Array.isArray(options.delivery)
      ? cloneRecord(options.delivery)
      : {},
    summary: options.summary && typeof options.summary === 'object' && !Array.isArray(options.summary)
      ? cloneRecord(options.summary)
      : {},
    review: options.review && typeof options.review === 'object' && !Array.isArray(options.review)
      ? cloneRecord(options.review)
      : null,
    artifact: options.artifact && typeof options.artifact === 'object' && !Array.isArray(options.artifact)
      ? cloneRecord(options.artifact)
      : null,
  };

  appendArtifactLine(filePath, record);
  return summarizeGitHubEventLogRecord(record, filePath);
}

function createGitHubEventArtifacts(options = {}) {
  const artifact = writeGitHubEventArtifact(options);
  const logEntry = appendGitHubEventLog({
    ...options,
    eventId: artifact.eventId,
    artifact,
  });

  return {
    eventId: artifact.eventId,
    artifact,
    logEntry,
  };
}

function resolveGitHubEventArtifactPath(options = {}) {
  const explicitPath = String(options.filePath || '').trim();
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  const eventId = normalizeText(options.eventId || options.id);
  if (!eventId) {
    throw new Error('A GitHub event artifact file path or event id is required.');
  }

  return buildGitHubEventArtifactPath(eventId, 'event');
}

function readGitHubEventArtifact(options = {}) {
  const filePath = resolveGitHubEventArtifactPath(options);
  if (!fs.existsSync(filePath)) {
    throw new Error(`GitHub event artifact not found: ${filePath}`);
  }

  const text = fs.readFileSync(filePath, 'utf8');
  const record = JSON.parse(text);
  return {
    ...record,
    filePath,
  };
}

function normalizeLimit(value, fallback = 20, max = 200) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(max, parsed));
}

function matchesFilter(record, options = {}) {
  const slugFilter = normalizeLowerText(options.slug);
  if (slugFilter) {
    const recordSlug = normalizeLowerText(record?.target?.slug || record?.summary?.slug);
    if (recordSlug !== slugFilter) {
      return false;
    }
  }

  const eventFilter = normalizeLowerText(options.eventName || options.event);
  if (eventFilter) {
    const recordEvent = normalizeLowerText(record?.delivery?.eventName || record?.summary?.eventName);
    if (recordEvent !== eventFilter) {
      return false;
    }
  }

  const sourceFilter = normalizeLowerText(options.deliverySource || options.source);
  if (sourceFilter) {
    const recordSource = normalizeLowerText(record?.source || record?.summary?.source);
    if (recordSource !== sourceFilter) {
      return false;
    }
  }

  return true;
}

function readGitHubEventLog(options = {}) {
  const filePath = buildGitHubEventLogPath(options);
  if (!fs.existsSync(filePath)) {
    return {
      schemaVersion: GITHUB_EVENT_LOG_SCHEMA_VERSION,
      filePath,
      totalCount: 0,
      events: [],
    };
  }

  const limit = normalizeLimit(options.limit, 20, 200);
  const text = fs.readFileSync(filePath, 'utf8');
  const records = text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((record) => matchesFilter(record, options))
    .reverse();

  return {
    schemaVersion: GITHUB_EVENT_LOG_SCHEMA_VERSION,
    filePath,
    totalCount: records.length,
    events: records.slice(0, limit).map((record) => summarizeGitHubEventLogRecord(record, filePath)),
  };
}

module.exports = {
  GITHUB_EVENT_ARTIFACT_SCHEMA_VERSION,
  GITHUB_EVENT_LOG_SCHEMA_VERSION,
  ensureGitHubEventArtifactsDir,
  buildGitHubEventId,
  buildGitHubEventArtifactPath,
  buildGitHubEventLogPath,
  writeGitHubEventArtifact,
  appendGitHubEventLog,
  createGitHubEventArtifacts,
  readGitHubEventArtifact,
  readGitHubEventLog,
  summarizeGitHubEventArtifactRecord,
  summarizeGitHubEventLogRecord,
};
