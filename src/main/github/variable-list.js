const { requestGitHubJson } = require('./client');
const { resolveGitHubRepoContext } = require('./context');
const {
  appendUnauthenticatedWarning,
  createGovernanceReadReport,
  ensureGitHubRepositoryTarget,
  normalizeLimit,
  sanitizeVariableMetadata,
} = require('./governance-redaction');

const GITHUB_VARIABLE_LIST_SCHEMA_VERSION = 'github.variable-list.v1';

async function listGitHubVariables(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const allowApi = options.api !== false;
  const limit = normalizeLimit(options.limit, 50, 100);
  const context = resolveGitHubRepoContext(options);

  const report = createGovernanceReadReport({
    schemaVersion: GITHUB_VARIABLE_LIST_SCHEMA_VERSION,
    featureFlagEnabled,
    context,
    githubApiExtra: {
      totalCount: null,
    },
    extra: {
      filters: {
        limit,
      },
      variables: [],
      metadataOnly: true,
    },
  });

  if (!ensureGitHubRepositoryTarget(report, context, 'variable listing', allowApi)) {
    return report;
  }

  const response = await requestGitHubJson({
    apiPath: `/repos/${encodeURIComponent(context.target.owner)}/${encodeURIComponent(context.target.repo)}/actions/variables?per_page=${limit}`,
    apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
    token: context.tokenInfo.token,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  report.githubApi.attempted = true;
  report.githubApi.status = response.status;
  report.githubApi.rateLimit = response.rateLimit || null;

  const items = Array.isArray(response.data?.variables)
    ? response.data.variables
    : (Array.isArray(response.data) ? response.data : []);

  if (response.ok) {
    report.variables = items.slice(0, limit).map(sanitizeVariableMetadata).filter(Boolean);
    report.githubApi.totalCount = Number.isFinite(Number(response.data?.total_count))
      ? Number(response.data.total_count)
      : report.variables.length;
    return report;
  }

  report.githubApi.error = response.error || response.data?.message || `GitHub variable listing failed (${response.status})`;
  appendUnauthenticatedWarning(report, context, 'Variable listing failed without GH_TOKEN/GITHUB_TOKEN; repository administration access may also be required.');
  return report;
}

module.exports = {
  GITHUB_VARIABLE_LIST_SCHEMA_VERSION,
  listGitHubVariables,
};
