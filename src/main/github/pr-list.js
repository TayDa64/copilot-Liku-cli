const { requestGitHubJson } = require('./client');
const { resolveGitHubRepoContext } = require('./context');
const { summarizePullRequest } = require('./pr-inspect');

const GITHUB_PR_LIST_SCHEMA_VERSION = 'github.pr-list.v1';

function normalizeLimit(value, fallback = 10, max = 100) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(max, parsed));
}

function normalizePullRequestState(value, fallback = 'open') {
  const normalized = String(value || '').trim().toLowerCase();
  if (['open', 'closed', 'all'].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

async function listGitHubPullRequests(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const allowApi = options.api !== false;
  const limit = normalizeLimit(options.limit, 10, 100);
  const state = normalizePullRequestState(options.state, 'open');
  const base = String(options.base || '').trim() || null;
  const head = String(options.head || '').trim() || null;
  const context = resolveGitHubRepoContext(options);

  const report = {
    schemaVersion: GITHUB_PR_LIST_SCHEMA_VERSION,
    success: true,
    featureFlagEnabled,
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: context.target,
    targetSource: context.targetSource,
    filters: {
      state,
      limit,
      base,
      head,
    },
    githubApi: {
      ...context.githubApi,
      pullRequestCount: 0,
    },
    pullRequests: [],
    warnings: context.warnings.slice(),
  };

  if (!context.target.raw) {
    report.warnings.push('No git remote detected; pull request listing needs a GitHub repository target.');
    return report;
  }

  if (!context.target.isGitHub || !context.target.slug) {
    report.warnings.push('Detected target is not a GitHub repository; pull request listing was skipped.');
    return report;
  }

  if (!allowApi) {
    report.warnings.push('GitHub pull request listing skipped by request.');
    return report;
  }

  const params = new URLSearchParams({
    state,
    per_page: String(limit),
  });
  if (base) params.set('base', base);
  if (head) params.set('head', head);

  const response = await requestGitHubJson({
    apiPath: `/repos/${encodeURIComponent(context.target.owner)}/${encodeURIComponent(context.target.repo)}/pulls?${params.toString()}`,
    apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
    token: context.tokenInfo.token,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  report.githubApi.attempted = true;
  report.githubApi.status = response.status;
  report.githubApi.rateLimit = response.rateLimit || null;

  if (response.ok && Array.isArray(response.data)) {
    report.pullRequests = response.data.slice(0, limit).map(summarizePullRequest).filter(Boolean);
    report.githubApi.pullRequestCount = report.pullRequests.length;
    return report;
  }

  report.githubApi.error = response.error || response.data?.message || `GitHub pull request listing failed (${response.status})`;
  if (!context.tokenInfo.token) {
    report.warnings.push('Public pull request listing failed without GH_TOKEN/GITHUB_TOKEN; authenticated access may be required for private repositories or higher rate limits.');
  }
  return report;
}

module.exports = {
  GITHUB_PR_LIST_SCHEMA_VERSION,
  listGitHubPullRequests,
  normalizeLimit,
  normalizePullRequestState,
};
