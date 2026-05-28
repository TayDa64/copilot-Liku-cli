const { requestGitHubJson } = require('./client');
const { resolveGitHubRepoContext } = require('./context');
const {
  appendUnauthenticatedWarning,
  createGovernanceReadReport,
  ensureGitHubRepositoryTarget,
  normalizeLimit,
  summarizeEnvironment,
} = require('./governance-redaction');

const GITHUB_ENVIRONMENT_LIST_SCHEMA_VERSION = 'github.environment-list.v1';

async function listGitHubEnvironments(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const allowApi = options.api !== false;
  const limit = normalizeLimit(options.limit, 20, 100);
  const context = resolveGitHubRepoContext(options);

  const report = createGovernanceReadReport({
    schemaVersion: GITHUB_ENVIRONMENT_LIST_SCHEMA_VERSION,
    featureFlagEnabled,
    context,
    githubApiExtra: {
      totalCount: null,
    },
    extra: {
      filters: {
        limit,
      },
      environments: [],
    },
  });

  if (!ensureGitHubRepositoryTarget(report, context, 'environment listing', allowApi)) {
    return report;
  }

  const response = await requestGitHubJson({
    apiPath: `/repos/${encodeURIComponent(context.target.owner)}/${encodeURIComponent(context.target.repo)}/environments?per_page=${limit}`,
    apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
    token: context.tokenInfo.token,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  report.githubApi.attempted = true;
  report.githubApi.status = response.status;
  report.githubApi.rateLimit = response.rateLimit || null;

  const items = Array.isArray(response.data?.environments)
    ? response.data.environments
    : (Array.isArray(response.data) ? response.data : []);

  if (response.ok) {
    report.environments = items.slice(0, limit).map(summarizeEnvironment).filter(Boolean);
    report.githubApi.totalCount = Number.isFinite(Number(response.data?.total_count))
      ? Number(response.data.total_count)
      : report.environments.length;
    return report;
  }

  report.githubApi.error = response.error || response.data?.message || `GitHub environment listing failed (${response.status})`;
  appendUnauthenticatedWarning(report, context, 'Environment listing failed without GH_TOKEN/GITHUB_TOKEN; repository administration access may also be required.');
  return report;
}

module.exports = {
  GITHUB_ENVIRONMENT_LIST_SCHEMA_VERSION,
  listGitHubEnvironments,
};
