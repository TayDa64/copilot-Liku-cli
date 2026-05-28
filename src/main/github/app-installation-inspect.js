const { requestGitHubJson } = require('./client');
const { resolveGitHubRepoContext } = require('./context');
const {
  appendUnauthenticatedWarning,
  createGovernanceReadReport,
  ensureGitHubRepositoryTarget,
  summarizeInstallation,
} = require('./governance-redaction');

const GITHUB_APP_INSTALLATION_INSPECT_SCHEMA_VERSION = 'github.app-installation-inspect.v1';

async function requestGitHubAppInstallationData(context, options = {}) {
  return requestGitHubJson({
    apiPath: `/repos/${encodeURIComponent(context.target.owner)}/${encodeURIComponent(context.target.repo)}/installation`,
    apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
    token: context.tokenInfo.token,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
}

async function inspectGitHubAppInstallation(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const allowApi = options.api !== false;
  const context = resolveGitHubRepoContext(options);

  const report = createGovernanceReadReport({
    schemaVersion: GITHUB_APP_INSTALLATION_INSPECT_SCHEMA_VERSION,
    featureFlagEnabled,
    context,
    extra: {
      installation: null,
      installationAccessible: false,
    },
  });

  if (!ensureGitHubRepositoryTarget(report, context, 'app installation inspection', allowApi)) {
    return report;
  }

  const response = await requestGitHubAppInstallationData(context, options);
  report.githubApi.attempted = true;
  report.githubApi.status = response.status;
  report.githubApi.rateLimit = response.rateLimit || null;

  if (response.ok && response.data) {
    report.installation = summarizeInstallation(response.data, true);
    report.installationAccessible = true;
    return report;
  }

  report.githubApi.error = response.error || response.data?.message || `GitHub App installation inspection failed (${response.status})`;
  appendUnauthenticatedWarning(report, context, 'GitHub App installation inspection failed without GH_TOKEN/GITHUB_TOKEN; repository administration access may also be required.');
  return report;
}

module.exports = {
  GITHUB_APP_INSTALLATION_INSPECT_SCHEMA_VERSION,
  inspectGitHubAppInstallation,
  requestGitHubAppInstallationData,
};
