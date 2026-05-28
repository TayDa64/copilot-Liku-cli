const { requestGitHubJson } = require('./client');
const { resolveGitHubRepoContext } = require('./context');
const {
  appendUnauthenticatedWarning,
  createGovernanceReadReport,
  ensureGitHubRepositoryTarget,
  normalizeLimit,
  summarizeWebhook,
} = require('./governance-redaction');

const GITHUB_WEBHOOK_LIST_SCHEMA_VERSION = 'github.webhook-list.v1';

async function listGitHubWebhooks(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const allowApi = options.api !== false;
  const limit = normalizeLimit(options.limit, 20, 100);
  const context = resolveGitHubRepoContext(options);

  const report = createGovernanceReadReport({
    schemaVersion: GITHUB_WEBHOOK_LIST_SCHEMA_VERSION,
    featureFlagEnabled,
    context,
    githubApiExtra: {
      totalCount: null,
    },
    extra: {
      filters: {
        limit,
      },
      webhooks: [],
      metadataOnly: true,
    },
  });

  if (!ensureGitHubRepositoryTarget(report, context, 'webhook listing', allowApi)) {
    return report;
  }

  const response = await requestGitHubJson({
    apiPath: `/repos/${encodeURIComponent(context.target.owner)}/${encodeURIComponent(context.target.repo)}/hooks?per_page=${limit}`,
    apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
    token: context.tokenInfo.token,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  report.githubApi.attempted = true;
  report.githubApi.status = response.status;
  report.githubApi.rateLimit = response.rateLimit || null;

  const items = Array.isArray(response.data)
    ? response.data
    : (Array.isArray(response.data?.hooks) ? response.data.hooks : []);

  if (response.ok) {
    report.webhooks = items.slice(0, limit).map(summarizeWebhook).filter(Boolean);
    report.githubApi.totalCount = Number.isFinite(Number(response.data?.total_count))
      ? Number(response.data.total_count)
      : report.webhooks.length;
    return report;
  }

  report.githubApi.error = response.error || response.data?.message || `GitHub webhook listing failed (${response.status})`;
  appendUnauthenticatedWarning(report, context, 'Webhook listing failed without GH_TOKEN/GITHUB_TOKEN; repository administration access may also be required.');
  return report;
}

module.exports = {
  GITHUB_WEBHOOK_LIST_SCHEMA_VERSION,
  listGitHubWebhooks,
};
