const { requestGitHubJson } = require('./client');
const { resolveGitHubRepoContext } = require('./context');
const {
  appendUnauthenticatedWarning,
  createGovernanceReadReport,
  ensureGitHubRepositoryTarget,
  sanitizeSecretMetadata,
} = require('./governance-redaction');

const GITHUB_SECRET_INSPECT_SCHEMA_VERSION = 'github.secret-inspect.v1';

function normalizeSecretName(value) {
  const text = String(value || '').trim();
  return text || null;
}

async function inspectGitHubSecret(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const allowApi = options.api !== false;
  const secretName = normalizeSecretName(options.name || options.secret || options.selector);
  const context = resolveGitHubRepoContext(options);

  const report = createGovernanceReadReport({
    schemaVersion: GITHUB_SECRET_INSPECT_SCHEMA_VERSION,
    featureFlagEnabled,
    context,
    extra: {
      secretName,
      secret: null,
      metadataOnly: true,
    },
  });

  if (!secretName) {
    report.success = false;
    report.error = 'USAGE';
    report.message = 'Usage: liku github secret inspect <name> [--slug owner/repo]';
    return report;
  }

  if (!ensureGitHubRepositoryTarget(report, context, 'secret inspection', allowApi)) {
    return report;
  }

  const response = await requestGitHubJson({
    apiPath: `/repos/${encodeURIComponent(context.target.owner)}/${encodeURIComponent(context.target.repo)}/actions/secrets/${encodeURIComponent(secretName)}`,
    apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
    token: context.tokenInfo.token,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  report.githubApi.attempted = true;
  report.githubApi.status = response.status;
  report.githubApi.rateLimit = response.rateLimit || null;

  if (response.ok && response.data) {
    report.secret = sanitizeSecretMetadata(response.data);
    return report;
  }

  report.githubApi.error = response.error || response.data?.message || `GitHub secret inspection failed (${response.status})`;
  appendUnauthenticatedWarning(report, context, 'Secret inspection failed without GH_TOKEN/GITHUB_TOKEN; repository administration access may also be required.');
  return report;
}

module.exports = {
  GITHUB_SECRET_INSPECT_SCHEMA_VERSION,
  inspectGitHubSecret,
  normalizeSecretName,
};
