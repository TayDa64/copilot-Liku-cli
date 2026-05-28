const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { LIKU_HOME } = require('../../shared/liku-home');
const { addMsToIso, buildExportReview, sanitizePersistedText } = require('../persistence-controls');

const GITHUB_WRITE_ARTIFACTS_DIR = path.join(LIKU_HOME, 'github', 'writes');
const GITHUB_WRITE_PREVIEW_ARTIFACT_SCHEMA_VERSION = 'github.write-preview-artifact.v1';
const GITHUB_WRITE_APPLY_RESULT_SCHEMA_VERSION = 'github.write-apply-result.v1';
const GITHUB_WRITE_APPROVAL_SCHEMA_VERSION = 'github.write-approval.v1';
const GITHUB_WRITE_EVENT_SCHEMA_VERSION = 'github.write-event.v1';
const DEFAULT_GITHUB_WRITE_TTL_MS = 24 * 60 * 60 * 1000;

function ensureGitHubWriteArtifactsDir() {
  if (!fs.existsSync(GITHUB_WRITE_ARTIFACTS_DIR)) {
    fs.mkdirSync(GITHUB_WRITE_ARTIFACTS_DIR, { recursive: true, mode: 0o700 });
  }
}

function lineCount(value) {
  const text = String(value || '');
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

function buildWriteArtifactId(prefix = 'github-write') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildApplyToken() {
  return `ghwa_${crypto.randomBytes(18).toString('hex')}`;
}

function maskApplyToken(token) {
  const value = String(token || '').trim();
  if (!value) return null;
  if (value.length <= 12) {
    return `${value.slice(0, 4)}…${value.slice(-4)}`;
  }
  return `${value.slice(0, 6)}…${value.slice(-6)}`;
}

function buildWriteArtifactPath(previewId, suffix, extension = 'json') {
  return path.join(GITHUB_WRITE_ARTIFACTS_DIR, `${previewId}.${suffix}.${extension}`);
}

function buildGitHubWriteEventLogPath(previewId) {
  return buildWriteArtifactPath(previewId, 'events', 'jsonl');
}

function writeArtifactFile(filePath, payload) {
  ensureGitHubWriteArtifactsDir();
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function appendArtifactLine(filePath, payload) {
  ensureGitHubWriteArtifactsDir();
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function countExistingEventLines(filePath) {
  if (!fs.existsSync(filePath)) {
    return 0;
  }

  const text = fs.readFileSync(filePath, 'utf8');
  return text.split(/\r?\n/).filter(Boolean).length;
}

function resolvePreviewId(options = {}) {
  const previewId = String(options.previewId || options.artifactId || '').trim();
  if (!previewId) {
    throw new Error('A GitHub write preview id is required.');
  }
  return previewId;
}

function cloneJsonObject(value, fallback = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fallback;
  }
  return { ...value };
}

function summarizeGitHubWritePreviewArtifactRecord(record = {}, filePath = null) {
  return {
    previewId: String(record.previewId || '').trim() || null,
    schemaVersion: String(record.schemaVersion || '').trim() || null,
    createdAt: String(record.createdAt || '').trim() || null,
    expiresAt: String(record.expiresAt || '').trim() || null,
    capabilityKey: String(record.capabilityKey || '').trim() || null,
    previewType: String(record.previewType || '').trim() || null,
    filePath: filePath ? String(filePath) : null,
  };
}

function summarizeGitHubWriteApprovalArtifactRecord(record = {}, filePath = null) {
  return {
    previewId: String(record.previewId || '').trim() || null,
    schemaVersion: String(record.schemaVersion || '').trim() || null,
    createdAt: String(record.createdAt || '').trim() || null,
    updatedAt: String(record.updatedAt || '').trim() || null,
    expiresAt: String(record.expiresAt || '').trim() || null,
    status: String(record.status || '').trim() || null,
    approvalRequirement: String(record.approvalRequirement || '').trim() || null,
    approvalMode: String(record.approvalMode || '').trim() || null,
    applyTokenHint: maskApplyToken(record.applyToken),
    filePath: filePath ? String(filePath) : null,
  };
}

function summarizeGitHubWriteApplyResultArtifactRecord(record = {}, filePath = null) {
  return {
    previewId: String(record.previewId || '').trim() || null,
    schemaVersion: String(record.schemaVersion || '').trim() || null,
    createdAt: String(record.createdAt || '').trim() || null,
    status: String(record.status || '').trim() || null,
    success: record.success !== false,
    filePath: filePath ? String(filePath) : null,
  };
}

function summarizeGitHubWriteEventLog(options = {}) {
  const previewId = resolvePreviewId(options);
  return {
    previewId,
    schemaVersion: GITHUB_WRITE_EVENT_SCHEMA_VERSION,
    filePath: String(options.filePath || buildGitHubWriteEventLogPath(previewId)),
  };
}

function buildBodyPreviewText(value, maxChars = 280, maxLines = 8) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  const boundedLines = text
    .split(/\r?\n/)
    .slice(0, Math.max(1, maxLines));
  let preview = boundedLines.join('\n');

  if (preview.length > maxChars) {
    preview = `${preview.slice(0, Math.max(1, maxChars - 1))}…`;
  } else if (boundedLines.length < lineCount(text)) {
    preview = `${preview}…`;
  }

  return preview;
}

function sanitizeDraftText(value, options = {}) {
  const rawText = String(value ?? '');
  const sanitized = sanitizePersistedText(rawText, {
    path: Array.isArray(options.path) ? options.path : ['githubWrite', 'text'],
  });

  return {
    text: sanitized.value,
    preview: buildBodyPreviewText(
      sanitized.value,
      Number.isFinite(Number(options.maxChars)) ? Number(options.maxChars) : 280,
      Number.isFinite(Number(options.maxLines)) ? Number(options.maxLines) : 8
    ),
    rawLength: rawText.length,
    sanitizedLength: String(sanitized.value || '').length,
    lineCount: lineCount(sanitized.value),
    redactions: Array.isArray(sanitized.redactions) ? sanitized.redactions.slice() : [],
  };
}

function sanitizeDraftBody(body) {
  const sanitized = sanitizeDraftText(body, {
    path: ['githubWrite', 'body'],
    maxChars: 280,
    maxLines: 8,
  });
  return {
    body: sanitized.text,
    bodyPreview: sanitized.preview,
    rawLength: sanitized.rawLength,
    sanitizedLength: sanitized.sanitizedLength,
    lineCount: sanitized.lineCount,
    redactions: sanitized.redactions,
  };
}

function sanitizeDraftTitle(title) {
  const sanitized = sanitizeDraftText(title, {
    path: ['githubWrite', 'title'],
    maxChars: 160,
    maxLines: 2,
  });

  return {
    title: sanitized.text,
    titlePreview: sanitized.preview,
    rawLength: sanitized.rawLength,
    sanitizedLength: sanitized.sanitizedLength,
    lineCount: sanitized.lineCount,
    redactions: sanitized.redactions,
  };
}

function resolvePreviewArtifactPath(options = {}) {
  const explicitPath = String(options.filePath || '').trim();
  if (explicitPath) {
    return path.resolve(explicitPath);
  }
  return buildWriteArtifactPath(resolvePreviewId(options), 'preview');
}

function resolveApprovalArtifactPath(options = {}) {
  const explicitPath = String(options.filePath || '').trim();
  if (explicitPath) {
    return path.resolve(explicitPath);
  }
  return buildWriteArtifactPath(resolvePreviewId(options), 'approval');
}

function resolveApplyResultArtifactPath(options = {}) {
  const explicitPath = String(options.filePath || '').trim();
  if (explicitPath) {
    return path.resolve(explicitPath);
  }
  return buildWriteArtifactPath(resolvePreviewId(options), 'result');
}

function readArtifactJson(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }

  const text = fs.readFileSync(filePath, 'utf8');
  const record = JSON.parse(text);
  return {
    ...record,
    filePath,
  };
}

function readGitHubWritePreviewArtifact(options = {}) {
  return readArtifactJson(resolvePreviewArtifactPath(options), 'GitHub write preview artifact');
}

function readGitHubWriteApprovalArtifact(options = {}) {
  return readArtifactJson(resolveApprovalArtifactPath(options), 'GitHub write approval artifact');
}

function readGitHubWriteApplyResultArtifact(options = {}) {
  return readArtifactJson(resolveApplyResultArtifactPath(options), 'GitHub write apply result artifact');
}

function readGitHubWriteEventLog(options = {}) {
  const filePath = String(options.filePath || '').trim()
    ? path.resolve(String(options.filePath || '').trim())
    : buildGitHubWriteEventLogPath(resolvePreviewId(options));
  if (!fs.existsSync(filePath)) {
    throw new Error(`GitHub write event log not found: ${filePath}`);
  }

  const text = fs.readFileSync(filePath, 'utf8');
  const events = text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  return {
    schemaVersion: GITHUB_WRITE_EVENT_SCHEMA_VERSION,
    previewId: String(events[0]?.previewId || options.previewId || '').trim() || null,
    filePath,
    events,
  };
}

function appendGitHubWriteEvent(options = {}) {
  const previewId = resolvePreviewId(options);
  const filePath = String(options.filePath || '').trim()
    ? path.resolve(String(options.filePath || '').trim())
    : buildGitHubWriteEventLogPath(previewId);
  const record = {
    schemaVersion: GITHUB_WRITE_EVENT_SCHEMA_VERSION,
    previewId,
    timestamp: new Date().toISOString(),
    sequence: Number.isFinite(Number(options.sequence))
      ? Number(options.sequence)
      : countExistingEventLines(filePath) + 1,
    eventName: String(options.eventName || '').trim() || 'unknown',
    status: String(options.status || '').trim() || 'unknown',
    source: String(options.source || '').trim() || 'unknown',
    capabilityKey: String(options.capabilityKey || '').trim() || null,
    details: cloneJsonObject(options.details, {}),
  };

  appendArtifactLine(filePath, record);
  return {
    previewId,
    schemaVersion: GITHUB_WRITE_EVENT_SCHEMA_VERSION,
    timestamp: record.timestamp,
    sequence: record.sequence,
    eventName: record.eventName,
    filePath,
  };
}

function writeGitHubWritePreviewArtifact(options = {}) {
  const previewId = String(options.previewId || buildWriteArtifactId('github-write-preview')).trim() || buildWriteArtifactId('github-write-preview');
  const createdAt = String(options.createdAt || new Date().toISOString()).trim() || new Date().toISOString();
  const ttlMs = Number.isFinite(Number(options.ttlMs)) ? Number(options.ttlMs) : DEFAULT_GITHUB_WRITE_TTL_MS;
  const expiresAt = String(options.expiresAt || addMsToIso(createdAt, ttlMs) || createdAt).trim() || createdAt;
  const sanitizedTitle = options.sanitizedTitle && typeof options.sanitizedTitle === 'object'
    ? {
        title: String(options.sanitizedTitle.title || ''),
        titlePreview: String(options.sanitizedTitle.titlePreview || ''),
        rawLength: Number.isFinite(Number(options.sanitizedTitle.rawLength)) ? Number(options.sanitizedTitle.rawLength) : 0,
        sanitizedLength: Number.isFinite(Number(options.sanitizedTitle.sanitizedLength)) ? Number(options.sanitizedTitle.sanitizedLength) : 0,
        lineCount: Number.isFinite(Number(options.sanitizedTitle.lineCount)) ? Number(options.sanitizedTitle.lineCount) : 0,
        redactions: Array.isArray(options.sanitizedTitle.redactions) ? options.sanitizedTitle.redactions.slice() : [],
      }
    : ((options.title !== undefined && options.title !== null) ? sanitizeDraftTitle(options.title) : null);
  const sanitizedBody = options.sanitizedBody && typeof options.sanitizedBody === 'object'
    ? {
        body: String(options.sanitizedBody.body || ''),
        bodyPreview: String(options.sanitizedBody.bodyPreview || ''),
        rawLength: Number.isFinite(Number(options.sanitizedBody.rawLength)) ? Number(options.sanitizedBody.rawLength) : 0,
        sanitizedLength: Number.isFinite(Number(options.sanitizedBody.sanitizedLength)) ? Number(options.sanitizedBody.sanitizedLength) : 0,
        lineCount: Number.isFinite(Number(options.sanitizedBody.lineCount)) ? Number(options.sanitizedBody.lineCount) : 0,
        redactions: Array.isArray(options.sanitizedBody.redactions) ? options.sanitizedBody.redactions.slice() : [],
      }
    : sanitizeDraftBody(options.body || '');
  const reviewRedactions = [
    ...(Array.isArray(sanitizedTitle?.redactions) ? sanitizedTitle.redactions : []),
    ...(Array.isArray(sanitizedBody.redactions) ? sanitizedBody.redactions : []),
  ];
  const review = options.review && typeof options.review === 'object'
    ? { ...options.review }
    : buildExportReview({
        exportKind: 'github-write-preview',
        redactions: reviewRedactions,
        reviewRequired: true,
      });
  const filePath = resolvePreviewArtifactPath({ previewId });
  const record = {
    schemaVersion: GITHUB_WRITE_PREVIEW_ARTIFACT_SCHEMA_VERSION,
    previewId,
    createdAt,
    expiresAt,
    source: String(options.source || 'unknown').trim() || 'unknown',
    capabilityKey: String(options.capabilityKey || '').trim() || null,
    previewType: String(options.previewType || '').trim() || 'generic',
    approvalRequirement: String(options.approvalRequirement || 'explicit').trim() || 'explicit',
    approvalMode: String(options.approvalMode || 'prompt').trim() || 'prompt',
    repoIdentity: cloneJsonObject(options.repoIdentity),
    remote: cloneJsonObject(options.remote),
    target: cloneJsonObject(options.target),
    targetSource: String(options.targetSource || '').trim() || null,
    input: {
      ...(sanitizedTitle
        ? {
            title: sanitizedTitle.title,
            titlePreview: sanitizedTitle.titlePreview,
            titleStats: {
              rawLength: sanitizedTitle.rawLength,
              sanitizedLength: sanitizedTitle.sanitizedLength,
              lineCount: sanitizedTitle.lineCount,
            },
          }
        : {}),
      bodySource: String(options.bodySource || 'inline').trim() || 'inline',
      body: sanitizedBody.body,
      bodyPreview: sanitizedBody.bodyPreview,
      bodyStats: {
        rawLength: sanitizedBody.rawLength,
        sanitizedLength: sanitizedBody.sanitizedLength,
        lineCount: sanitizedBody.lineCount,
      },
      metadata: cloneJsonObject(options.inputMetadata, {}),
    },
    review,
    metadata: cloneJsonObject(options.metadata, {}),
  };

  writeArtifactFile(filePath, record);
  return summarizeGitHubWritePreviewArtifactRecord(record, filePath);
}

function writeGitHubWriteApprovalArtifact(options = {}) {
  const previewId = resolvePreviewId(options);
  const filePath = resolveApprovalArtifactPath({ previewId, filePath: options.filePath });
  const createdAt = String(options.createdAt || new Date().toISOString()).trim() || new Date().toISOString();
  const updatedAt = String(options.updatedAt || new Date().toISOString()).trim() || new Date().toISOString();
  const record = {
    schemaVersion: GITHUB_WRITE_APPROVAL_SCHEMA_VERSION,
    previewId,
    createdAt,
    updatedAt,
    expiresAt: String(options.expiresAt || '').trim() || null,
    source: String(options.source || 'unknown').trim() || 'unknown',
    capabilityKey: String(options.capabilityKey || '').trim() || null,
    status: String(options.status || 'requested').trim() || 'requested',
    approvalRequirement: String(options.approvalRequirement || 'explicit').trim() || 'explicit',
    approvalMode: String(options.approvalMode || 'prompt').trim() || 'prompt',
    applyToken: String(options.applyToken || '').trim() || null,
    reason: String(options.reason || '').trim() || null,
    approvedAt: String(options.approvedAt || '').trim() || null,
    appliedAt: String(options.appliedAt || '').trim() || null,
    failedAt: String(options.failedAt || '').trim() || null,
    rejectedAt: String(options.rejectedAt || '').trim() || null,
    expiredAt: String(options.expiredAt || '').trim() || null,
    previewArtifact: cloneJsonObject(options.previewArtifact),
    resultArtifact: cloneJsonObject(options.resultArtifact),
    error: cloneJsonObject(options.error),
    metadata: cloneJsonObject(options.metadata, {}),
  };

  writeArtifactFile(filePath, record);
  return summarizeGitHubWriteApprovalArtifactRecord(record, filePath);
}

function writeGitHubWriteApplyResultArtifact(options = {}) {
  const previewId = resolvePreviewId(options);
  const filePath = resolveApplyResultArtifactPath({ previewId, filePath: options.filePath });
  const createdAt = String(options.createdAt || new Date().toISOString()).trim() || new Date().toISOString();
  const record = {
    schemaVersion: GITHUB_WRITE_APPLY_RESULT_SCHEMA_VERSION,
    previewId,
    createdAt,
    source: String(options.source || 'unknown').trim() || 'unknown',
    capabilityKey: String(options.capabilityKey || '').trim() || null,
    status: String(options.status || 'unknown').trim() || 'unknown',
    success: options.success !== false,
    previewArtifact: cloneJsonObject(options.previewArtifact),
    approvalArtifact: cloneJsonObject(options.approvalArtifact),
    target: cloneJsonObject(options.target),
    repoIdentity: cloneJsonObject(options.repoIdentity),
    execution: cloneJsonObject(options.execution),
    githubApi: cloneJsonObject(options.githubApi),
    result: cloneJsonObject(options.result),
    error: cloneJsonObject(options.error),
    warnings: Array.isArray(options.warnings) ? options.warnings.slice() : [],
    metadata: cloneJsonObject(options.metadata, {}),
  };

  writeArtifactFile(filePath, record);
  return summarizeGitHubWriteApplyResultArtifactRecord(record, filePath);
}

function createGitHubWritePreviewArtifacts(options = {}) {
  const previewId = String(options.previewId || buildWriteArtifactId('github-write-preview')).trim() || buildWriteArtifactId('github-write-preview');
  const createdAt = String(options.createdAt || new Date().toISOString()).trim() || new Date().toISOString();
  const ttlMs = Number.isFinite(Number(options.ttlMs)) ? Number(options.ttlMs) : DEFAULT_GITHUB_WRITE_TTL_MS;
  const expiresAt = String(options.expiresAt || addMsToIso(createdAt, ttlMs) || createdAt).trim() || createdAt;
  const applyToken = String(options.applyToken || buildApplyToken()).trim() || buildApplyToken();

  const previewArtifact = writeGitHubWritePreviewArtifact({
    ...options,
    previewId,
    createdAt,
    expiresAt,
  });

  const approvalArtifact = writeGitHubWriteApprovalArtifact({
    previewId,
    createdAt,
    updatedAt: createdAt,
    expiresAt,
    source: options.source,
    capabilityKey: options.capabilityKey,
    status: options.status || 'requested',
    approvalRequirement: options.approvalRequirement,
    approvalMode: options.approvalMode,
    applyToken,
    previewArtifact,
    metadata: options.approvalMetadata,
  });

  appendGitHubWriteEvent({
    previewId,
    source: options.source,
    capabilityKey: options.capabilityKey,
    status: 'requested',
    eventName: 'preview.created',
    details: {
      previewType: options.previewType || 'generic',
    },
  });
  appendGitHubWriteEvent({
    previewId,
    source: options.source,
    capabilityKey: options.capabilityKey,
    status: 'requested',
    eventName: 'approval.requested',
    details: {
      approvalRequirement: String(options.approvalRequirement || 'explicit').trim() || 'explicit',
      approvalMode: String(options.approvalMode || 'prompt').trim() || 'prompt',
    },
  });

  const previewRecord = readGitHubWritePreviewArtifact({ previewId });
  const approvalRecord = readGitHubWriteApprovalArtifact({ previewId });

  return {
    previewId,
    applyToken,
    applyTokenHint: maskApplyToken(applyToken),
    review: previewRecord.review,
    previewRecord,
    approvalRecord,
    previewArtifact,
    approvalArtifact,
    eventLog: summarizeGitHubWriteEventLog({ previewId }),
  };
}

module.exports = {
  DEFAULT_GITHUB_WRITE_TTL_MS,
  GITHUB_WRITE_APPLY_RESULT_SCHEMA_VERSION,
  GITHUB_WRITE_APPROVAL_SCHEMA_VERSION,
  GITHUB_WRITE_ARTIFACTS_DIR,
  GITHUB_WRITE_EVENT_SCHEMA_VERSION,
  GITHUB_WRITE_PREVIEW_ARTIFACT_SCHEMA_VERSION,
  appendGitHubWriteEvent,
  buildApplyToken,
  buildBodyPreviewText,
  buildGitHubWriteEventLogPath,
  buildWriteArtifactId,
  createGitHubWritePreviewArtifacts,
  ensureGitHubWriteArtifactsDir,
  maskApplyToken,
  readGitHubWriteApplyResultArtifact,
  readGitHubWriteApprovalArtifact,
  readGitHubWriteEventLog,
  readGitHubWritePreviewArtifact,
  resolveApplyResultArtifactPath,
  resolveApprovalArtifactPath,
  resolvePreviewArtifactPath,
  sanitizeDraftBody,
  sanitizeDraftText,
  sanitizeDraftTitle,
  summarizeGitHubWriteApplyResultArtifactRecord,
  summarizeGitHubWriteApprovalArtifactRecord,
  summarizeGitHubWriteEventLog,
  summarizeGitHubWritePreviewArtifactRecord,
  writeGitHubWriteApplyResultArtifact,
  writeGitHubWriteApprovalArtifact,
  writeGitHubWritePreviewArtifact,
};
