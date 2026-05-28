const { resolveGitHubRepoContext } = require('./context');
const { createGovernanceReadReport, normalizeLimit } = require('./governance-redaction');
const { readGitHubEventLog } = require('./event-artifacts');

const GITHUB_EVENT_LIST_SCHEMA_VERSION = 'github.event-list.v1';

async function listGitHubEvents(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const limit = normalizeLimit(options.limit, 20, 200);
  const requestedEventName = String(options.eventName || options.event || '').trim() || null;
  const context = resolveGitHubRepoContext(options);
  const effectiveSlug = String(options.slug || context.target?.slug || '').trim() || null;

  const report = createGovernanceReadReport({
    schemaVersion: GITHUB_EVENT_LIST_SCHEMA_VERSION,
    featureFlagEnabled,
    context,
    extra: {
      localOnly: true,
      filters: {
        limit,
        event: requestedEventName,
      },
      totalCount: 0,
      eventLog: null,
      events: [],
    },
  });

  if (!effectiveSlug) {
    report.warnings.push('No GitHub repo target detected; listing all locally recorded GitHub events.');
  }

  const journal = readGitHubEventLog({
    limit,
    slug: effectiveSlug,
    eventName: requestedEventName,
  });

  report.target = effectiveSlug
    ? {
        ...(report.target && typeof report.target === 'object' ? report.target : {}),
        slug: effectiveSlug,
      }
    : report.target;
  report.eventLog = {
    filePath: journal.filePath,
  };
  report.totalCount = journal.totalCount;
  report.events = journal.events;

  return report;
}

module.exports = {
  GITHUB_EVENT_LIST_SCHEMA_VERSION,
  listGitHubEvents,
};
