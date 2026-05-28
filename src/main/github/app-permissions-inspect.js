const { requestGitHubAppInstallationData } = require('./app-installation-inspect');
const { resolveGitHubRepoContext } = require('./context');
const {
  appendUnauthenticatedWarning,
  createGovernanceReadReport,
  ensureGitHubRepositoryTarget,
  summarizeInstallation,
} = require('./governance-redaction');

const GITHUB_APP_PERMISSIONS_INSPECT_SCHEMA_VERSION = 'github.app-permissions-inspect.v1';

async function inspectGitHubAppPermissions(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const allowApi = options.api !== false;
  const context = resolveGitHubRepoContext(options);

  const report = createGovernanceReadReport({
    schemaVersion: GITHUB_APP_PERMISSIONS_INSPECT_SCHEMA_VERSION,
    featureFlagEnabled,
    context,
    extra: {
      installation: null,
      permissions: {},
      permissionCount: 0,
      events: [],
      eventCount: 0,
    },
  });

  if (!ensureGitHubRepositoryTarget(report, context, 'app permissions inspection', allowApi)) {
    return report;
  }

  const response = await requestGitHubAppInstallationData(context, options);
  report.githubApi.attempted = true;
  report.githubApi.status = response.status;
  report.githubApi.rateLimit = response.rateLimit || null;

  if (response.ok && response.data) {
    report.installation = summarizeInstallation(response.data, false);
    report.permissions = response.data.permissions && typeof response.data.permissions === 'object'
      ? { ...response.data.permissions }
      : {};
    report.permissionCount = Object.keys(report.permissions).length;
    report.events = Array.isArray(response.data.events) ? response.data.events.slice() : [];
    report.eventCount = report.events.length;
    return report;
  }

  report.githubApi.error = response.error || response.data?.message || `GitHub App permissions inspection failed (${response.status})`;
  appendUnauthenticatedWarning(report, context, 'GitHub App permissions inspection failed without GH_TOKEN/GITHUB_TOKEN; repository administration access may also be required.');
  return report;
}

module.exports = {
  GITHUB_APP_PERMISSIONS_INSPECT_SCHEMA_VERSION,
  inspectGitHubAppPermissions,
};
