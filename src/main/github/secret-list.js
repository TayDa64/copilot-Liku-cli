const { requestGitHubJson } = require('./client');
const { resolveGitHubRepoContext } = require('./context');
const {
  appendUnauthenticatedWarning,
  createGovernanceReadReport,
  ensureGitHubRepositoryTarget,
  normalizeLimit,
  sanitizeSecretMetadata,
} = require('./governance-redaction');

const GITHUB_SECRET_LIST_SCHEMA_VERSION = 'github.secret-list.v1';

async function listGitHubSecrets(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const allowApi = options.api !== false;
  const limit = normalizeLimit(options.limit, 50, 100);
  const context = resolveGitHubRepoContext(options);

  const report = createGovernanceReadReport({
    schemaVersion: GITHUB_SECRET_LIST_SCHEMA_VERSION,
    featureFlagEnabled,
    context,
    githubApiExtra: {
      totalCount: null,
    },
    extra: {
      filters: {
        limit,
      },
      secrets: [],
      metadataOnly: true,
    },
  });

  if (!ensureGitHubRepositoryTarget(report, context, 'secret listing', allowApi)) {
    return report;
  }

  const response = await requestGitHubJson({
    apiPath: `/repos/${encodeURIComponent(context.target.owner)}/${encodeURIComponent(context.target.repo)}/actions/secrets?per_page=${limit}`,
    apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
    token: context.tokenInfo.token,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  report.githubApi.attempted = true;
  report.githubApi.status = response.status;
  report.githubApi.rateLimit = response.rateLimit || null;

  const items = Array.isArray(response.data?.secrets)
    ? response.data.secrets
    : (Array.isArray(response.data) ? response.data : []);

  if (response.ok) {
    report.secrets = items.slice(0, limit).map(sanitizeSecretMetadata).filter(Boolean);
    report.githubApi.totalCount = Number.isFinite(Number(response.data?.total_count))
      ? Number(response.data.total_count)
      : report.secrets.length;
    return report;
  }

  report.githubApi.error = response.error || response.data?.message || `GitHub secret listing failed (${response.status})`;
  appendUnauthenticatedWarning(report, context, 'Secret listing failed without GH_TOKEN/GITHUB_TOKEN; repository administration access may also be required.');
  return report;
}

module.exports = {
  GITHUB_SECRET_LIST_SCHEMA_VERSION,
  listGitHubSecrets,
};
