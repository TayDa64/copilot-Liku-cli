const { requestGitHubJson } = require('./client');
const { resolveGitHubRepoContext } = require('./context');
const {
  appendUnauthenticatedWarning,
  createGovernanceReadReport,
  ensureGitHubRepositoryTarget,
  normalizeLimit,
  summarizeRuleset,
} = require('./governance-redaction');

const GITHUB_RULESET_LIST_SCHEMA_VERSION = 'github.ruleset-list.v1';

async function listGitHubRulesets(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const allowApi = options.api !== false;
  const limit = normalizeLimit(options.limit, 20, 100);
  const context = resolveGitHubRepoContext(options);

  const report = createGovernanceReadReport({
    schemaVersion: GITHUB_RULESET_LIST_SCHEMA_VERSION,
    featureFlagEnabled,
    context,
    githubApiExtra: {
      totalCount: null,
    },
    extra: {
      filters: {
        limit,
      },
      rulesets: [],
    },
  });

  if (!ensureGitHubRepositoryTarget(report, context, 'ruleset listing', allowApi)) {
    return report;
  }

  const response = await requestGitHubJson({
    apiPath: `/repos/${encodeURIComponent(context.target.owner)}/${encodeURIComponent(context.target.repo)}/rulesets?per_page=${limit}`,
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
    : (Array.isArray(response.data?.rulesets) ? response.data.rulesets : []);

  if (response.ok) {
    report.rulesets = items.slice(0, limit).map(summarizeRuleset).filter(Boolean);
    report.githubApi.totalCount = Number.isFinite(Number(response.data?.total_count))
      ? Number(response.data.total_count)
      : report.rulesets.length;
    return report;
  }

  report.githubApi.error = response.error || response.data?.message || `GitHub ruleset listing failed (${response.status})`;
  appendUnauthenticatedWarning(report, context, 'Ruleset listing failed without GH_TOKEN/GITHUB_TOKEN; repository administration access may also be required.');
  return report;
}

module.exports = {
  GITHUB_RULESET_LIST_SCHEMA_VERSION,
  listGitHubRulesets,
};
