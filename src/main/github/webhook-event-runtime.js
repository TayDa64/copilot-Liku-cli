const { buildExportReview, sanitizePersistedValue } = require('../persistence-controls');
const { createGitHubEventArtifacts, buildGitHubEventId } = require('./event-artifacts');
const { truncateText } = require('./governance-redaction');

const GITHUB_EVENT_RUNTIME_SCHEMA_VERSION = 'github.event-runtime.v1';

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeHeaders(headers) {
  if (!headers) {
    return {};
  }

  if (typeof headers.entries === 'function') {
    return Array.from(headers.entries()).reduce((result, [key, value]) => {
      const normalizedKey = normalizeText(key).toLowerCase();
      if (normalizedKey) {
        result[normalizedKey] = Array.isArray(value) ? value.join(', ') : String(value);
      }
      return result;
    }, {});
  }

  if (Array.isArray(headers)) {
    return headers.reduce((result, entry) => {
      if (Array.isArray(entry) && entry.length >= 2) {
        const normalizedKey = normalizeText(entry[0]).toLowerCase();
        if (normalizedKey) {
          result[normalizedKey] = String(entry[1]);
        }
      }
      return result;
    }, {});
  }

  if (headers && typeof headers === 'object') {
    return Object.entries(headers).reduce((result, [key, value]) => {
      const normalizedKey = normalizeText(key).toLowerCase();
      if (normalizedKey) {
        result[normalizedKey] = Array.isArray(value) ? value.join(', ') : String(value);
      }
      return result;
    }, {});
  }

  return {};
}

function parsePayload(value) {
  if (value && typeof value === 'object') {
    return value;
  }

  const text = normalizeText(value);
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      rawPayload: text,
    };
  }
}

function normalizePositiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveDeliverySlug(options = {}, payload = {}, warnings = []) {
  const explicitSlug = normalizeText(options.slug);
  const payloadSlug = normalizeText(payload?.repository?.full_name);
  if (explicitSlug && payloadSlug && explicitSlug.toLowerCase() !== payloadSlug.toLowerCase()) {
    warnings.push(`Explicit slug ${explicitSlug} did not match payload repository ${payloadSlug}; using the explicit slug.`);
  }
  return explicitSlug || payloadSlug || null;
}

function sanitizeGitHubWebhookHeaders(headers) {
  const normalized = normalizeHeaders(headers);
  const result = {};
  const redactions = [];

  Object.entries(normalized).forEach(([key, value]) => {
    const pathParts = ['githubEvent', 'headers', key];
    if (/(authorization|cookie|token|secret|password|signature)/i.test(key)) {
      const sanitized = sanitizePersistedValue(String(value || ''), { path: pathParts, fieldKind: 'secret' });
      result[key] = '[redacted]';
      redactions.push(...sanitized.redactions);
      return;
    }

    const sanitized = sanitizePersistedValue(value, { path: pathParts });
    result[key] = sanitized.value;
    redactions.push(...sanitized.redactions);
  });

  return {
    value: result,
    redactions,
  };
}

function sanitizeGitHubWebhookPayload(payload) {
  return sanitizePersistedValue(payload, { path: ['githubEvent', 'payload'] });
}

function summarizePayloadPreview(eventName, payload = {}) {
  const normalizedEventName = normalizeText(eventName).toLowerCase();
  const action = normalizeText(payload.action) || null;

  if (normalizedEventName === 'push') {
    return {
      action,
      ref: normalizeText(payload.ref) || null,
      after: truncateText(normalizeText(payload.after), 40),
      commitCount: Array.isArray(payload.commits) ? payload.commits.length : 0,
      headCommitMessage: truncateText(payload.head_commit?.message, 120),
    };
  }

  if (normalizedEventName === 'pull_request') {
    return {
      action,
      number: Number.isFinite(Number(payload.number)) ? Number(payload.number) : null,
      state: normalizeText(payload.pull_request?.state) || null,
      title: truncateText(payload.pull_request?.title, 120),
      merged: payload.pull_request?.merged === true,
    };
  }

  if (normalizedEventName === 'issues') {
    return {
      action,
      number: Number.isFinite(Number(payload.issue?.number || payload.number)) ? Number(payload.issue?.number || payload.number) : null,
      state: normalizeText(payload.issue?.state) || null,
      title: truncateText(payload.issue?.title, 120),
    };
  }

  if (normalizedEventName === 'issue_comment') {
    return {
      action,
      issueNumber: Number.isFinite(Number(payload.issue?.number)) ? Number(payload.issue.number) : null,
      commentAuthor: normalizeText(payload.comment?.user?.login) || null,
      commentPreview: truncateText(payload.comment?.body, 120),
    };
  }

  if (normalizedEventName === 'workflow_run') {
    return {
      action,
      workflow: normalizeText(payload.workflow_run?.name) || null,
      runId: Number.isFinite(Number(payload.workflow_run?.id)) ? Number(payload.workflow_run.id) : null,
      status: normalizeText(payload.workflow_run?.status) || null,
      conclusion: normalizeText(payload.workflow_run?.conclusion) || null,
      event: normalizeText(payload.workflow_run?.event) || null,
    };
  }

  return {
    action,
    ref: normalizeText(payload.ref) || null,
    number: Number.isFinite(Number(payload.number)) ? Number(payload.number) : null,
    installationId: Number.isFinite(Number(payload.installation?.id)) ? Number(payload.installation.id) : null,
    keys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 12) : [],
  };
}

function summarizeGitHubWebhookEvent(normalized = {}, sanitizedPayload = {}) {
  const payload = sanitizedPayload && typeof sanitizedPayload === 'object' ? sanitizedPayload : {};
  return {
    eventId: normalizeText(normalized.eventId) || null,
    deliveryId: normalizeText(normalized.deliveryId) || null,
    eventName: normalizeText(normalized.eventName) || null,
    action: normalizeText(normalized.action) || null,
    source: normalizeText(normalized.source) || null,
    slug: normalizeText(normalized.slug) || null,
    hookId: Number.isFinite(Number(normalized.hookId)) ? Number(normalized.hookId) : null,
    installationId: Number.isFinite(Number(normalized.installationId)) ? Number(normalized.installationId) : null,
    senderLogin: normalizeText(payload.sender?.login) || null,
    receivedAt: normalizeText(normalized.receivedAt) || null,
    payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 20) : [],
    payloadPreview: summarizePayloadPreview(normalized.eventName, payload),
  };
}

function normalizeGitHubWebhookDelivery(options = {}) {
  const warnings = [];
  const headers = normalizeHeaders(options.headers || options.requestHeaders);
  const payload = parsePayload(options.payload);
  const eventId = normalizeText(options.eventId) || buildGitHubEventId();
  const eventName = normalizeText(options.eventName || headers['x-github-event']);
  const deliveryId = normalizeText(options.deliveryId || headers['x-github-delivery']) || null;
  const action = normalizeText(options.action || payload.action) || null;
  const slug = resolveDeliverySlug(options, payload, warnings);
  const source = normalizeText(options.source) || 'github-webhook';
  const hookId = normalizePositiveInteger(options.webhookId || headers['x-github-hook-id']);
  const installationId = normalizePositiveInteger(options.installationId || payload.installation?.id || headers['x-github-hook-installation-target-id']);
  const receivedAt = normalizeText(options.receivedAt) || new Date().toISOString();

  if (!eventName) {
    warnings.push('GitHub webhook delivery did not include an event name.');
  }

  if (!slug) {
    warnings.push('GitHub webhook delivery did not include a repository slug.');
  }

  return {
    eventId,
    eventName,
    deliveryId,
    action,
    slug,
    source,
    hookId,
    installationId,
    receivedAt,
    headers,
    payload,
    metadata: options.metadata && typeof options.metadata === 'object' && !Array.isArray(options.metadata)
      ? { ...options.metadata }
      : {},
    warnings,
  };
}

async function ingestGitHubWebhookEvent(options = {}) {
  const normalized = normalizeGitHubWebhookDelivery(options);
  if (!normalized.eventName) {
    return {
      schemaVersion: GITHUB_EVENT_RUNTIME_SCHEMA_VERSION,
      success: false,
      error: 'USAGE',
      message: 'A GitHub webhook event name is required.',
      warnings: normalized.warnings.slice(),
    };
  }

  const sanitizedHeaders = sanitizeGitHubWebhookHeaders(normalized.headers);
  const sanitizedPayload = sanitizeGitHubWebhookPayload(normalized.payload);
  const redactions = [...sanitizedHeaders.redactions, ...sanitizedPayload.redactions];
  const summary = summarizeGitHubWebhookEvent(normalized, sanitizedPayload.value);
  const review = buildExportReview({
    exportKind: 'github-event-runtime',
    redactions,
    reviewRequired: false,
  });

  const artifacts = createGitHubEventArtifacts({
    eventId: normalized.eventId,
    receivedAt: normalized.receivedAt,
    source: normalized.source,
    target: {
      slug: normalized.slug,
    },
    delivery: {
      eventName: normalized.eventName,
      action: normalized.action,
      deliveryId: normalized.deliveryId,
      hookId: normalized.hookId,
      installationId: normalized.installationId,
    },
    summary,
    headers: sanitizedHeaders.value,
    payload: sanitizedPayload.value,
    review,
    metadata: normalized.metadata,
  });

  return {
    schemaVersion: GITHUB_EVENT_RUNTIME_SCHEMA_VERSION,
    success: true,
    eventId: artifacts.eventId,
    source: normalized.source,
    target: {
      slug: normalized.slug,
    },
    delivery: {
      eventName: normalized.eventName,
      action: normalized.action,
      deliveryId: normalized.deliveryId,
      hookId: normalized.hookId,
      installationId: normalized.installationId,
    },
    summary,
    review,
    artifact: artifacts.artifact,
    logEntry: artifacts.logEntry,
    warnings: normalized.warnings.slice(),
  };
}

module.exports = {
  GITHUB_EVENT_RUNTIME_SCHEMA_VERSION,
  ingestGitHubWebhookEvent,
  normalizeGitHubWebhookDelivery,
  sanitizeGitHubWebhookHeaders,
  sanitizeGitHubWebhookPayload,
  summarizeGitHubWebhookEvent,
};
