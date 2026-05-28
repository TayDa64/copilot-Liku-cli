const { requestGitHubJson } = require('./client');
const { resolveGitHubRepoContext } = require('./context');
const {
  appendUnauthenticatedWarning,
  createGovernanceReadReport,
  ensureGitHubRepositoryTarget,
  summarizeRuleset,
} = require('./governance-redaction');

const GITHUB_RULESET_INSPECT_SCHEMA_VERSION = 'github.ruleset-inspect.v1';

function normalizeRulesetId(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function inspectGitHubRuleset(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const allowApi = options.api !== false;
  const rulesetId = normalizeRulesetId(options.id || options.rulesetId || options.selector);
  const context = resolveGitHubRepoContext(options);

  const report = createGovernanceReadReport({
    schemaVersion: GITHUB_RULESET_INSPECT_SCHEMA_VERSION,
    featureFlagEnabled,
    context,
    extra: {
      rulesetId,
      ruleset: null,
    },
  });

  if (!rulesetId) {
    report.success = false;
    report.error = 'USAGE';
    report.message = 'Usage: liku github ruleset inspect <id> [--slug owner/repo]';
    return report;
  }

  if (!ensureGitHubRepositoryTarget(report, context, 'ruleset inspection', allowApi)) {
    return report;
  }

  const response = await requestGitHubJson({
    apiPath: `/repos/${encodeURIComponent(context.target.owner)}/${encodeURIComponent(context.target.repo)}/rulesets/${rulesetId}`,
    apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
    token: context.tokenInfo.token,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  report.githubApi.attempted = true;
  report.githubApi.status = response.status;
  report.githubApi.rateLimit = response.rateLimit || null;

  if (response.ok && response.data) {
    report.ruleset = summarizeRuleset(response.data);
    return report;
  }

  report.githubApi.error = response.error || response.data?.message || `GitHub ruleset inspection failed (${response.status})`;
  appendUnauthenticatedWarning(report, context, 'Ruleset inspection failed without GH_TOKEN/GITHUB_TOKEN; repository administration access may also be required.');
  return report;
}

module.exports = {
  GITHUB_RULESET_INSPECT_SCHEMA_VERSION,
  inspectGitHubRuleset,
  normalizeRulesetId,
};
