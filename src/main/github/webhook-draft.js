const { buildCliApplyCommand } = require('./issue-comment-draft');
const { resolveGitHubRepoContext } = require('./context');
const { createGitHubWritePreviewArtifacts } = require('./write-artifacts');
const { normalizeWebhookId } = require('./webhook-inspect');

const GITHUB_WEBHOOK_CREATE_DRAFT_SCHEMA_VERSION = 'github.webhook-create-draft.v1';
const GITHUB_WEBHOOK_UPDATE_DRAFT_SCHEMA_VERSION = 'github.webhook-update-draft.v1';
const GITHUB_WEBHOOK_PING_DRAFT_SCHEMA_VERSION = 'github.webhook-ping-draft.v1';

function normalizeText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function parseBooleanOption(value, fallback = false) {
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

function parseOptionalBoolean(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return parseBooleanOption(value, false);
}

function buildCreateUsageMessage() {
  return 'Usage: liku github webhook create draft --events <csv> --target-url <url> --secret-ref repo:<ENV_NAME> [--content-type <json|form>] [--active true|false] [--slug owner/repo]';
}

function buildUpdateUsageMessage() {
  return 'Usage: liku github webhook update draft <id> [--events <csv>] [--target-url <url>] [--secret-ref repo:<ENV_NAME>] [--content-type <json|form>] [--active true|false] [--slug owner/repo]';
}

function buildPingUsageMessage() {
  return 'Usage: liku github webhook ping draft <id> [--slug owner/repo]';
}

function resolveWebhookEvents(value, options = {}) {
  const raw = normalizeText(value);
  if (!raw) {
    if (options.required) {
      return {
        ok: false,
        error: 'USAGE',
        message: String(options.usageMessage || buildCreateUsageMessage()).trim() || buildCreateUsageMessage(),
      };
    }
    return {
      ok: true,
      events: null,
    };
  }

  const seen = new Set();
  const events = [];
  for (const part of raw.split(',')) {
    const eventName = String(part || '').trim().toLowerCase();
    if (!eventName || seen.has(eventName)) {
      continue;
    }
    seen.add(eventName);
    events.push(eventName);
  }

  if (!events.length) {
    return {
      ok: false,
      error: 'INVALID_EVENTS',
      message: 'Webhook events must be a comma-separated list such as push,pull_request,workflow_run.',
    };
  }

  return {
    ok: true,
    events,
  };
}

function resolveWebhookTargetUrl(value, options = {}) {
  const targetUrl = normalizeText(value);
  if (!targetUrl) {
    if (options.required) {
      return {
        ok: false,
        error: 'USAGE',
        message: String(options.usageMessage || buildCreateUsageMessage()).trim() || buildCreateUsageMessage(),
      };
    }
    return {
      ok: true,
      targetUrl: null,
    };
  }

  try {
    const parsed = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('unsupported protocol');
    }
    return {
      ok: true,
      targetUrl: parsed.toString(),
    };
  } catch {
    return {
      ok: false,
      error: 'INVALID_TARGET_URL',
      message: 'Webhook target URLs must be valid http(s) URLs.',
    };
  }
}

function resolveWebhookSecretRef(value, options = {}) {
  const secretRef = normalizeText(value);
  if (!secretRef) {
    if (options.required) {
      return {
        ok: false,
        error: 'USAGE',
        message: 'GitHub webhook create drafts require --secret-ref repo:<ENV_NAME> so the secret stays out of preview artifacts.',
      };
    }
    return {
      ok: true,
      secretRef: null,
      secretEnvName: null,
    };
  }

  const match = secretRef.match(/^repo:([A-Za-z_][A-Za-z0-9_]*)$/);
  if (!match) {
    return {
      ok: false,
      error: 'INVALID_SECRET_REF',
      message: 'Webhook secret refs must use repo:<ENV_NAME> so apply can resolve the local environment variable without persisting the secret value.',
    };
  }

  return {
    ok: true,
    secretRef,
    secretEnvName: match[1],
  };
}

function resolveWebhookContentType(value, options = {}) {
  const fallback = normalizeText(options.defaultValue);
  const contentType = normalizeText(value);
  if (!contentType) {
    return {
      ok: true,
      contentType: fallback,
      source: fallback ? 'default' : 'none',
    };
  }

  const normalized = contentType.toLowerCase();
  if (!['json', 'form'].includes(normalized)) {
    return {
      ok: false,
      error: 'INVALID_CONTENT_TYPE',
      message: 'Webhook content type must be either json or form.',
    };
  }

  return {
    ok: true,
    contentType: normalized,
    source: 'explicit',
  };
}

function buildWebhookTitle(action, options = {}) {
  if (action === 'create') {
    return `Create repository webhook for ${options.targetUrl || 'target URL'}`;
  }
  if (action === 'update') {
    return `Update repository webhook ${options.webhookId || 'unknown'}`;
  }
  return `Ping repository webhook ${options.webhookId || 'unknown'}`;
}

function buildWebhookBodySummary(options = {}) {
  const lines = [];
  if (Number.isFinite(Number(options.webhookId))) {
    lines.push(`Webhook id: ${Number(options.webhookId)}`);
  }
  if (options.targetUrl) {
    lines.push(`Target URL: ${options.targetUrl}`);
  }
  if (Array.isArray(options.events) && options.events.length > 0) {
    lines.push(`Events: ${options.events.join(', ')}`);
  }
  if (options.contentType) {
    lines.push(`Content type: ${options.contentType}`);
  }
  if (options.secretRef) {
    lines.push(`Secret ref: ${options.secretRef}`);
  }
  if (options.secretEnvName) {
    lines.push(`Apply env: ${options.secretEnvName}`);
  }
  if (options.active === true || options.active === false) {
    lines.push(`Active: ${options.active ? 'true' : 'false'}`);
  }
  return lines.join('\n');
}

function buildSharedReport(options = {}, context, schemaVersion) {
  return {
    schemaVersion,
    success: true,
    featureFlagEnabled: options.featureFlagEnabled === true,
    writeFeatureFlagEnabled: options.writeFeatureFlagEnabled === true,
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: context.target,
    targetSource: context.targetSource,
    webhookId: null,
    previewId: null,
    review: null,
    previewArtifact: null,
    approvalArtifact: null,
    eventLog: null,
    draft: null,
    approval: null,
    instructions: null,
    warnings: context.warnings.slice(),
  };
}

function finalizePreviewReport(report, previewArtifacts, approvalRequirement, approvalMode, source, note) {
  report.previewId = previewArtifacts.previewId;
  report.review = previewArtifacts.review;
  report.previewArtifact = previewArtifacts.previewArtifact;
  report.approvalArtifact = previewArtifacts.approvalArtifact;
  report.eventLog = previewArtifacts.eventLog;
  report.approval = {
    status: previewArtifacts.approvalRecord?.status || 'requested',
    approvalRequirement,
    approvalMode,
    expiresAt: previewArtifacts.approvalRecord?.expiresAt || null,
    applyToken: source === 'cli' ? previewArtifacts.applyToken : null,
    applyTokenHint: previewArtifacts.applyTokenHint,
  };
  report.instructions = {
    cliApply: buildCliApplyCommand(previewArtifacts.previewId, previewArtifacts.approvalArtifact.filePath),
    note,
  };
  return report;
}

function buildSecretRefNote(secretRef, secretEnvName) {
  if (!secretRef || !secretEnvName) {
    return 'Webhook apply remains CLI-only.';
  }
  return `Apply resolves ${secretRef} from the local environment variable ${secretEnvName}. Webhook apply remains CLI-only.`;
}

function draftGitHubWebhookCreate(options = {}) {
  const context = resolveGitHubRepoContext(options);
  const report = buildSharedReport(options, context, GITHUB_WEBHOOK_CREATE_DRAFT_SCHEMA_VERSION);
  const source = String(options.source || 'unknown').trim() || 'unknown';
  const approvalMode = String(options.approvalMode || 'prompt').trim() || 'prompt';
  const approvalRequirement = String(options.approvalRequirement || 'explicit').trim() || 'explicit';
  const eventsResolution = resolveWebhookEvents(options.events, { required: true, usageMessage: buildCreateUsageMessage() });
  const targetUrlResolution = resolveWebhookTargetUrl(options.targetUrl || options['target-url'], { required: true, usageMessage: buildCreateUsageMessage() });
  const secretRefResolution = resolveWebhookSecretRef(options.secretRef || options['secret-ref'], { required: true });
  const contentTypeResolution = resolveWebhookContentType(options.contentType || options['content-type'], { defaultValue: 'json' });
  const active = parseBooleanOption(options.active, true);

  if (!context.target.raw) {
    report.success = false;
    report.error = 'TARGET_REQUIRED';
    report.message = 'GitHub webhook create drafts require a GitHub repository target. Use --slug owner/repo when no git remote is available.';
    return report;
  }

  if (!context.target.isGitHub || !context.target.slug) {
    report.success = false;
    report.error = 'TARGET_NOT_GITHUB';
    report.message = 'GitHub webhook create drafts require a GitHub repository target.';
    return report;
  }

  if (!eventsResolution.ok) {
    report.success = false;
    report.error = eventsResolution.error;
    report.message = eventsResolution.message;
    return report;
  }

  if (!targetUrlResolution.ok) {
    report.success = false;
    report.error = targetUrlResolution.error;
    report.message = targetUrlResolution.message;
    return report;
  }

  if (!secretRefResolution.ok) {
    report.success = false;
    report.error = secretRefResolution.error;
    report.message = secretRefResolution.message;
    return report;
  }

  if (!contentTypeResolution.ok) {
    report.success = false;
    report.error = contentTypeResolution.error;
    report.message = contentTypeResolution.message;
    return report;
  }

  const previewArtifacts = createGitHubWritePreviewArtifacts({
    source,
    capabilityKey: 'webhook.create.draft',
    previewType: 'webhook-create',
    approvalRequirement,
    approvalMode,
    title: buildWebhookTitle('create', { targetUrl: targetUrlResolution.targetUrl }),
    body: buildWebhookBodySummary({
      targetUrl: targetUrlResolution.targetUrl,
      events: eventsResolution.events,
      contentType: contentTypeResolution.contentType,
      secretRef: secretRefResolution.secretRef,
      secretEnvName: secretRefResolution.secretEnvName,
      active,
    }),
    bodySource: 'derived',
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: {
      kind: 'webhook-create',
      slug: context.target.slug,
      owner: context.target.owner,
      repo: context.target.repo,
      apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
      webhookName: 'web',
      targetUrl: targetUrlResolution.targetUrl,
      events: eventsResolution.events,
      contentType: contentTypeResolution.contentType,
      secretRef: secretRefResolution.secretRef,
      secretEnvName: secretRefResolution.secretEnvName,
      active,
      htmlUrl: context.target.htmlUrl || null,
    },
    targetSource: context.targetSource,
    inputMetadata: {
      eventCount: eventsResolution.events.length,
      hasSecretRef: true,
    },
    metadata: {
      commandSurface: source,
      draftKind: 'webhook-create',
      writeTargetClass: 'direct-api',
      riskLevel: 'medium',
      requiredPermissions: ['webhooks:write'],
      resourceFamily: 'webhook',
    },
  });

  report.draft = {
    type: 'webhook-create',
    webhookName: 'web',
    targetUrl: targetUrlResolution.targetUrl,
    events: eventsResolution.events,
    eventCount: eventsResolution.events.length,
    contentType: contentTypeResolution.contentType,
    secretRef: secretRefResolution.secretRef,
    secretEnvName: secretRefResolution.secretEnvName,
    active,
  };

  return finalizePreviewReport(
    report,
    previewArtifacts,
    approvalRequirement,
    approvalMode,
    source,
    `Review the webhook create preview before running the CLI apply command. ${buildSecretRefNote(secretRefResolution.secretRef, secretRefResolution.secretEnvName)}`
  );
}

function draftGitHubWebhookUpdate(options = {}) {
  const context = resolveGitHubRepoContext(options);
  const report = buildSharedReport(options, context, GITHUB_WEBHOOK_UPDATE_DRAFT_SCHEMA_VERSION);
  const source = String(options.source || 'unknown').trim() || 'unknown';
  const approvalMode = String(options.approvalMode || 'prompt').trim() || 'prompt';
  const approvalRequirement = String(options.approvalRequirement || 'explicit').trim() || 'explicit';
  const webhookId = normalizeWebhookId(options.webhookId || options.id || options.selector || options.positionalsWebhookId);
  const eventsResolution = resolveWebhookEvents(options.events, { required: false });
  const targetUrlResolution = resolveWebhookTargetUrl(options.targetUrl || options['target-url'], { required: false });
  const secretRefResolution = resolveWebhookSecretRef(options.secretRef || options['secret-ref'], { required: false });
  const contentTypeResolution = resolveWebhookContentType(options.contentType || options['content-type'], { defaultValue: null });
  const active = parseOptionalBoolean(options.active);

  report.webhookId = webhookId;

  if (!context.target.raw) {
    report.success = false;
    report.error = 'TARGET_REQUIRED';
    report.message = 'GitHub webhook update drafts require a GitHub repository target. Use --slug owner/repo when no git remote is available.';
    return report;
  }

  if (!context.target.isGitHub || !context.target.slug) {
    report.success = false;
    report.error = 'TARGET_NOT_GITHUB';
    report.message = 'GitHub webhook update drafts require a GitHub repository target.';
    return report;
  }

  if (!webhookId) {
    report.success = false;
    report.error = 'USAGE';
    report.message = buildUpdateUsageMessage();
    return report;
  }

  if (!eventsResolution.ok) {
    report.success = false;
    report.error = eventsResolution.error;
    report.message = eventsResolution.message;
    return report;
  }

  if (!targetUrlResolution.ok) {
    report.success = false;
    report.error = targetUrlResolution.error;
    report.message = targetUrlResolution.message;
    return report;
  }

  if (!secretRefResolution.ok) {
    report.success = false;
    report.error = secretRefResolution.error;
    report.message = secretRefResolution.message;
    return report;
  }

  if (!contentTypeResolution.ok) {
    report.success = false;
    report.error = contentTypeResolution.error;
    report.message = contentTypeResolution.message;
    return report;
  }

  const updateFields = [];
  if (Array.isArray(eventsResolution.events)) updateFields.push('events');
  if (targetUrlResolution.targetUrl) updateFields.push('target-url');
  if (secretRefResolution.secretRef) updateFields.push('secret-ref');
  if (contentTypeResolution.contentType) updateFields.push('content-type');
  if (active === true || active === false) updateFields.push('active');

  if (updateFields.length === 0) {
    report.success = false;
    report.error = 'USAGE';
    report.message = 'GitHub webhook update drafts require at least one mutable field: --events, --target-url, --secret-ref, --content-type, or --active.';
    return report;
  }

  const previewArtifacts = createGitHubWritePreviewArtifacts({
    source,
    capabilityKey: 'webhook.update.draft',
    previewType: 'webhook-update',
    approvalRequirement,
    approvalMode,
    title: buildWebhookTitle('update', { webhookId }),
    body: buildWebhookBodySummary({
      webhookId,
      targetUrl: targetUrlResolution.targetUrl,
      events: eventsResolution.events,
      contentType: contentTypeResolution.contentType,
      secretRef: secretRefResolution.secretRef,
      secretEnvName: secretRefResolution.secretEnvName,
      active,
    }),
    bodySource: 'derived',
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: {
      kind: 'webhook-update',
      slug: context.target.slug,
      owner: context.target.owner,
      repo: context.target.repo,
      apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
      webhookId,
      targetUrl: targetUrlResolution.targetUrl,
      events: eventsResolution.events,
      contentType: contentTypeResolution.contentType,
      secretRef: secretRefResolution.secretRef,
      secretEnvName: secretRefResolution.secretEnvName,
      active,
      htmlUrl: context.target.htmlUrl || null,
    },
    targetSource: context.targetSource,
    inputMetadata: {
      updateFields,
      eventCount: Array.isArray(eventsResolution.events) ? eventsResolution.events.length : 0,
      hasSecretRef: !!secretRefResolution.secretRef,
    },
    metadata: {
      commandSurface: source,
      draftKind: 'webhook-update',
      writeTargetClass: 'direct-api',
      riskLevel: 'medium',
      requiredPermissions: ['webhooks:write'],
      resourceFamily: 'webhook',
    },
  });

  report.draft = {
    type: 'webhook-update',
    webhookId,
    updates: updateFields,
    updateCount: updateFields.length,
    targetUrl: targetUrlResolution.targetUrl,
    events: Array.isArray(eventsResolution.events) ? eventsResolution.events : [],
    eventCount: Array.isArray(eventsResolution.events) ? eventsResolution.events.length : 0,
    contentType: contentTypeResolution.contentType,
    secretRef: secretRefResolution.secretRef,
    secretEnvName: secretRefResolution.secretEnvName,
    active,
  };

  return finalizePreviewReport(
    report,
    previewArtifacts,
    approvalRequirement,
    approvalMode,
    source,
    `Review the webhook update preview before running the CLI apply command. ${buildSecretRefNote(secretRefResolution.secretRef, secretRefResolution.secretEnvName)}`
  );
}

function draftGitHubWebhookPing(options = {}) {
  const context = resolveGitHubRepoContext(options);
  const report = buildSharedReport(options, context, GITHUB_WEBHOOK_PING_DRAFT_SCHEMA_VERSION);
  const source = String(options.source || 'unknown').trim() || 'unknown';
  const approvalMode = String(options.approvalMode || 'prompt').trim() || 'prompt';
  const approvalRequirement = String(options.approvalRequirement || 'explicit').trim() || 'explicit';
  const webhookId = normalizeWebhookId(options.webhookId || options.id || options.selector || options.positionalsWebhookId);

  report.webhookId = webhookId;

  if (!context.target.raw) {
    report.success = false;
    report.error = 'TARGET_REQUIRED';
    report.message = 'GitHub webhook ping drafts require a GitHub repository target. Use --slug owner/repo when no git remote is available.';
    return report;
  }

  if (!context.target.isGitHub || !context.target.slug) {
    report.success = false;
    report.error = 'TARGET_NOT_GITHUB';
    report.message = 'GitHub webhook ping drafts require a GitHub repository target.';
    return report;
  }

  if (!webhookId) {
    report.success = false;
    report.error = 'USAGE';
    report.message = buildPingUsageMessage();
    return report;
  }

  const previewArtifacts = createGitHubWritePreviewArtifacts({
    source,
    capabilityKey: 'webhook.ping.draft',
    previewType: 'webhook-ping',
    approvalRequirement,
    approvalMode,
    title: buildWebhookTitle('ping', { webhookId }),
    body: buildWebhookBodySummary({ webhookId }),
    bodySource: 'derived',
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: {
      kind: 'webhook-ping',
      slug: context.target.slug,
      owner: context.target.owner,
      repo: context.target.repo,
      apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
      webhookId,
      htmlUrl: context.target.htmlUrl || null,
    },
    targetSource: context.targetSource,
    metadata: {
      commandSurface: source,
      draftKind: 'webhook-ping',
      writeTargetClass: 'direct-api',
      riskLevel: 'low',
      requiredPermissions: ['webhooks:write'],
      resourceFamily: 'webhook',
    },
  });

  report.draft = {
    type: 'webhook-ping',
    webhookId,
  };

  return finalizePreviewReport(
    report,
    previewArtifacts,
    approvalRequirement,
    approvalMode,
    source,
    'Review the webhook ping preview before running the CLI apply command. Ping apply triggers one test delivery and remains CLI-only.'
  );
}

module.exports = {
  GITHUB_WEBHOOK_CREATE_DRAFT_SCHEMA_VERSION,
  GITHUB_WEBHOOK_PING_DRAFT_SCHEMA_VERSION,
  GITHUB_WEBHOOK_UPDATE_DRAFT_SCHEMA_VERSION,
  buildCreateUsageMessage,
  buildPingUsageMessage,
  buildUpdateUsageMessage,
  draftGitHubWebhookCreate,
  draftGitHubWebhookPing,
  draftGitHubWebhookUpdate,
};
