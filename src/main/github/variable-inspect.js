const { requestGitHubJson } = require('./client');
const { resolveGitHubRepoContext } = require('./context');
const {
  appendUnauthenticatedWarning,
  createGovernanceReadReport,
  ensureGitHubRepositoryTarget,
  sanitizeVariableMetadata,
} = require('./governance-redaction');

const GITHUB_VARIABLE_INSPECT_SCHEMA_VERSION = 'github.variable-inspect.v1';

function normalizeVariableName(value) {
  const text = String(value || '').trim();
  return text || null;
}

async function inspectGitHubVariable(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const allowApi = options.api !== false;
  const variableName = normalizeVariableName(options.name || options.variable || options.selector);
  const context = resolveGitHubRepoContext(options);

  const report = createGovernanceReadReport({
    schemaVersion: GITHUB_VARIABLE_INSPECT_SCHEMA_VERSION,
    featureFlagEnabled,
    context,
    extra: {
      variableName,
      variable: null,
      metadataOnly: true,
    },
  });

  if (!variableName) {
    report.success = false;
    report.error = 'USAGE';
    report.message = 'Usage: liku github variable inspect <name> [--slug owner/repo]';
    return report;
  }

  if (!ensureGitHubRepositoryTarget(report, context, 'variable inspection', allowApi)) {
    return report;
  }

  const response = await requestGitHubJson({
    apiPath: `/repos/${encodeURIComponent(context.target.owner)}/${encodeURIComponent(context.target.repo)}/actions/variables/${encodeURIComponent(variableName)}`,
    apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
    token: context.tokenInfo.token,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  report.githubApi.attempted = true;
  report.githubApi.status = response.status;
  report.githubApi.rateLimit = response.rateLimit || null;

  if (response.ok && response.data) {
    report.variable = sanitizeVariableMetadata(response.data);
    return report;
  }

  report.githubApi.error = response.error || response.data?.message || `GitHub variable inspection failed (${response.status})`;
  appendUnauthenticatedWarning(report, context, 'Variable inspection failed without GH_TOKEN/GITHUB_TOKEN; repository administration access may also be required.');
  return report;
}

module.exports = {
  GITHUB_VARIABLE_INSPECT_SCHEMA_VERSION,
  inspectGitHubVariable,
  normalizeVariableName,
};
