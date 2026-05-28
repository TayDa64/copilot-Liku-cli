const { resolveGitHubRepoContext } = require('./context');
const { createGovernanceReadReport } = require('./governance-redaction');
const { readGitHubEventArtifact } = require('./event-artifacts');

const GITHUB_EVENT_INSPECT_SCHEMA_VERSION = 'github.event-inspect.v1';

async function inspectGitHubEvent(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const eventId = String(options.id || options.eventId || options.selector || '').trim();
  const context = resolveGitHubRepoContext(options);
  const requestedSlug = String(options.slug || context.target?.slug || '').trim() || null;

  const report = createGovernanceReadReport({
    schemaVersion: GITHUB_EVENT_INSPECT_SCHEMA_VERSION,
    featureFlagEnabled,
    context,
    extra: {
      localOnly: true,
      eventId,
      artifact: null,
      event: null,
    },
  });

  if (!eventId) {
    report.success = false;
    report.error = 'USAGE';
    report.message = 'Usage: liku github event inspect <event-id> [--slug owner/repo]';
    return report;
  }

  let artifact;
  try {
    artifact = readGitHubEventArtifact({ eventId, filePath: options.filePath });
  } catch (error) {
    report.success = false;
    report.error = 'NOT_FOUND';
    report.message = error.message;
    return report;
  }

  const artifactSlug = String(artifact.target?.slug || '').trim() || null;
  if (requestedSlug && artifactSlug && requestedSlug.toLowerCase() !== artifactSlug.toLowerCase()) {
    report.success = false;
    report.error = 'NOT_FOUND';
    report.message = `GitHub event ${eventId} does not belong to ${requestedSlug}.`;
    return report;
  }

  report.target = artifact.target && typeof artifact.target === 'object'
    ? { ...artifact.target }
    : report.target;
  report.artifact = {
    eventId: artifact.eventId,
    filePath: artifact.filePath,
    recordedAt: artifact.recordedAt || null,
  };
  report.event = {
    eventId: artifact.eventId,
    recordedAt: artifact.recordedAt || null,
    receivedAt: artifact.receivedAt || null,
    source: artifact.source || null,
    slug: artifact.target?.slug || null,
    deliveryId: artifact.delivery?.deliveryId || null,
    eventName: artifact.delivery?.eventName || artifact.summary?.eventName || null,
    action: artifact.delivery?.action || artifact.summary?.action || null,
    hookId: artifact.delivery?.hookId ?? artifact.summary?.hookId ?? null,
    installationId: artifact.delivery?.installationId ?? artifact.summary?.installationId ?? null,
    senderLogin: artifact.summary?.senderLogin || null,
    payloadKeys: Array.isArray(artifact.summary?.payloadKeys) ? artifact.summary.payloadKeys.slice(0, 20) : [],
    payloadPreview: artifact.summary?.payloadPreview && typeof artifact.summary.payloadPreview === 'object'
      ? JSON.parse(JSON.stringify(artifact.summary.payloadPreview))
      : null,
    review: artifact.review && typeof artifact.review === 'object'
      ? { ...artifact.review }
      : null,
    headers: artifact.headers && typeof artifact.headers === 'object'
      ? JSON.parse(JSON.stringify(artifact.headers))
      : null,
    payload: artifact.payload === undefined ? null : JSON.parse(JSON.stringify(artifact.payload)),
  };

  return report;
}

module.exports = {
  GITHUB_EVENT_INSPECT_SCHEMA_VERSION,
  inspectGitHubEvent,
};
