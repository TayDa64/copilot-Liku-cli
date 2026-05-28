const { requestGitHubJson } = require('./client');
const { resolveGitHubRepoContext } = require('./context');
const {
  appendUnauthenticatedWarning,
  createGovernanceReadReport,
  ensureGitHubRepositoryTarget,
  summarizeEnvironment,
} = require('./governance-redaction');

const GITHUB_ENVIRONMENT_INSPECT_SCHEMA_VERSION = 'github.environment-inspect.v1';

function normalizeEnvironmentName(value) {
  const text = String(value || '').trim();
  return text || null;
}

async function inspectGitHubEnvironment(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const allowApi = options.api !== false;
  const environmentName = normalizeEnvironmentName(options.name || options.environment || options.selector);
  const context = resolveGitHubRepoContext(options);

  const report = createGovernanceReadReport({
    schemaVersion: GITHUB_ENVIRONMENT_INSPECT_SCHEMA_VERSION,
    featureFlagEnabled,
    context,
    extra: {
      environmentName,
      environment: null,
    },
  });

  if (!environmentName) {
    report.success = false;
    report.error = 'USAGE';
    report.message = 'Usage: liku github environment inspect <name> [--slug owner/repo]';
    return report;
  }

  if (!ensureGitHubRepositoryTarget(report, context, 'environment inspection', allowApi)) {
    return report;
  }

  const response = await requestGitHubJson({
    apiPath: `/repos/${encodeURIComponent(context.target.owner)}/${encodeURIComponent(context.target.repo)}/environments/${encodeURIComponent(environmentName)}`,
    apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
    token: context.tokenInfo.token,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  report.githubApi.attempted = true;
  report.githubApi.status = response.status;
  report.githubApi.rateLimit = response.rateLimit || null;

  if (response.ok && response.data) {
    report.environment = summarizeEnvironment(response.data);
    return report;
  }

  report.githubApi.error = response.error || response.data?.message || `GitHub environment inspection failed (${response.status})`;
  appendUnauthenticatedWarning(report, context, 'Environment inspection failed without GH_TOKEN/GITHUB_TOKEN; repository administration access may also be required.');
  return report;
}

module.exports = {
  GITHUB_ENVIRONMENT_INSPECT_SCHEMA_VERSION,
  inspectGitHubEnvironment,
  normalizeEnvironmentName,
};
