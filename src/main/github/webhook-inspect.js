const { requestGitHubJson } = require('./client');
const { resolveGitHubRepoContext } = require('./context');
const {
  appendUnauthenticatedWarning,
  createGovernanceReadReport,
  ensureGitHubRepositoryTarget,
  summarizeWebhook,
} = require('./governance-redaction');

const GITHUB_WEBHOOK_INSPECT_SCHEMA_VERSION = 'github.webhook-inspect.v1';

function normalizeWebhookId(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function inspectGitHubWebhook(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const allowApi = options.api !== false;
  const webhookId = normalizeWebhookId(options.id || options.webhookId || options.selector);
  const context = resolveGitHubRepoContext(options);

  const report = createGovernanceReadReport({
    schemaVersion: GITHUB_WEBHOOK_INSPECT_SCHEMA_VERSION,
    featureFlagEnabled,
    context,
    extra: {
      webhookId,
      webhook: null,
      metadataOnly: true,
    },
  });

  if (!webhookId) {
    report.success = false;
    report.error = 'USAGE';
    report.message = 'Usage: liku github webhook inspect <id> [--slug owner/repo]';
    return report;
  }

  if (!ensureGitHubRepositoryTarget(report, context, 'webhook inspection', allowApi)) {
    return report;
  }

  const response = await requestGitHubJson({
    apiPath: `/repos/${encodeURIComponent(context.target.owner)}/${encodeURIComponent(context.target.repo)}/hooks/${webhookId}`,
    apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
    token: context.tokenInfo.token,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  report.githubApi.attempted = true;
  report.githubApi.status = response.status;
  report.githubApi.rateLimit = response.rateLimit || null;

  if (response.ok && response.data) {
    report.webhook = summarizeWebhook(response.data);
    return report;
  }

  report.githubApi.error = response.error || response.data?.message || `GitHub webhook inspection failed (${response.status})`;
  appendUnauthenticatedWarning(report, context, 'Webhook inspection failed without GH_TOKEN/GITHUB_TOKEN; repository administration access may also be required.');
  return report;
}

module.exports = {
  GITHUB_WEBHOOK_INSPECT_SCHEMA_VERSION,
  inspectGitHubWebhook,
  normalizeWebhookId,
};
