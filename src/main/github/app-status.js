const { resolveGitHubAuthStatus } = require('./auth-status');
const { requestGitHubAppInstallationData } = require('./app-installation-inspect');
const { resolveGitHubRepoContext } = require('./context');
const {
  appendUnauthenticatedWarning,
  createGovernanceReadReport,
  summarizeInstallation,
} = require('./governance-redaction');

const GITHUB_APP_STATUS_SCHEMA_VERSION = 'github.app-status.v1';

function mergeWarnings(report, warnings) {
  const existing = new Set(report.warnings);
  for (const warning of Array.isArray(warnings) ? warnings : []) {
    if (!warning || existing.has(warning)) {
      continue;
    }
    existing.add(warning);
    report.warnings.push(warning);
  }
}

function hasGovernanceScope(scopes) {
  const normalized = Array.isArray(scopes)
    ? scopes.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)
    : [];
  return normalized.some((scope) => ['repo', 'public_repo', 'admin:repo_hook', 'read:org'].includes(scope));
}

async function inspectGitHubAppStatus(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const allowApi = options.api !== false;
  const context = resolveGitHubRepoContext(options);

  const report = createGovernanceReadReport({
    schemaVersion: GITHUB_APP_STATUS_SCHEMA_VERSION,
    featureFlagEnabled,
    context,
    extra: {
      authStatus: null,
      installation: null,
      summary: {
        tokenPresent: false,
        authenticated: false,
        installationAccessible: false,
        installationDetected: false,
        repositorySelection: null,
        governanceScopeObserved: false,
      },
    },
  });

  const authStatus = await resolveGitHubAuthStatus({
    env: options.env,
    cwd: options.cwd,
    featureFlagEnabled,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    probe: options.probe,
  });

  report.authStatus = {
    copilot: authStatus.copilot,
    githubApi: authStatus.githubApi,
    governanceAccess: authStatus.governanceAccess,
  };
  report.summary.tokenPresent = authStatus.githubApi?.tokenPresent === true;
  report.summary.authenticated = authStatus.githubApi?.authenticated === true;
  report.summary.governanceScopeObserved = hasGovernanceScope(authStatus.githubApi?.scopes);
  mergeWarnings(report, authStatus.warnings);

  if (!allowApi) {
    report.warnings.push('GitHub app installation lookup skipped by request.');
    return report;
  }

  if (!context?.target?.raw) {
    report.warnings.push('No git remote detected; GitHub app installation lookup was skipped.');
    return report;
  }

  if (!context.target.isGitHub || !context.target.slug) {
    report.warnings.push('Detected target is not a GitHub repository; GitHub app installation lookup was skipped.');
    return report;
  }

  const response = await requestGitHubAppInstallationData(context, options);
  report.githubApi.attempted = true;
  report.githubApi.status = response.status;
  report.githubApi.rateLimit = response.rateLimit || null;

  if (response.ok && response.data) {
    report.installation = summarizeInstallation(response.data, true);
    report.summary.installationAccessible = true;
    report.summary.installationDetected = true;
    report.summary.repositorySelection = report.installation?.repositorySelection || null;
    return report;
  }

  report.githubApi.error = response.error || response.data?.message || `GitHub app status lookup failed (${response.status})`;
  appendUnauthenticatedWarning(report, context, 'GitHub app installation lookup failed without GH_TOKEN/GITHUB_TOKEN; repository administration access may also be required.');
  return report;
}

module.exports = {
  GITHUB_APP_STATUS_SCHEMA_VERSION,
  inspectGitHubAppStatus,
};
