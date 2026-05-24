const { requestGitHubJson } = require('./client');
const { resolveGitHubRepoContext } = require('./context');

const GITHUB_ISSUES_LIST_SCHEMA_VERSION = 'github.issues-list.v1';

function normalizeLimit(value, fallback = 10, max = 100) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(max, parsed));
}

function normalizeIssueState(value, fallback = 'open') {
  const normalized = String(value || '').trim().toLowerCase();
  if (['open', 'closed', 'all'].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeLabels(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function summarizeIssue(issue) {
  if (!issue || typeof issue !== 'object') {
    return null;
  }
  return {
    number: Number.isFinite(Number(issue.number)) ? Number(issue.number) : null,
    title: issue.title || null,
    state: issue.state || null,
    locked: issue.locked === true,
    comments: Number.isFinite(Number(issue.comments)) ? Number(issue.comments) : 0,
    createdAt: issue.created_at || null,
    updatedAt: issue.updated_at || null,
    htmlUrl: issue.html_url || null,
    author: issue.user
      ? {
          login: issue.user.login || null,
          type: issue.user.type || null,
          htmlUrl: issue.user.html_url || null,
        }
      : null,
    labels: Array.isArray(issue.labels)
      ? issue.labels.slice(0, 12).map((label) => (typeof label === 'string'
        ? { name: label }
        : {
            name: label?.name || null,
            color: label?.color || null,
            description: label?.description || null,
          }))
      : [],
    assignees: Array.isArray(issue.assignees)
      ? issue.assignees.slice(0, 8).map((entry) => ({
          login: entry?.login || null,
          type: entry?.type || null,
        }))
      : [],
    milestone: issue.milestone
      ? {
          number: Number.isFinite(Number(issue.milestone.number)) ? Number(issue.milestone.number) : null,
          title: issue.milestone.title || null,
          state: issue.milestone.state || null,
        }
      : null,
  };
}

async function listGitHubIssues(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const allowApi = options.api !== false;
  const limit = normalizeLimit(options.limit, 10, 100);
  const state = normalizeIssueState(options.state, 'open');
  const labels = normalizeLabels(options.labels);
  const context = resolveGitHubRepoContext(options);

  const report = {
    schemaVersion: GITHUB_ISSUES_LIST_SCHEMA_VERSION,
    success: true,
    featureFlagEnabled,
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: context.target,
    targetSource: context.targetSource,
    filters: {
      state,
      limit,
      labels,
    },
    githubApi: {
      ...context.githubApi,
      issueCount: 0,
    },
    issues: [],
    warnings: context.warnings.slice(),
  };

  if (!context.target.raw) {
    report.warnings.push('No git remote detected; issue listing needs a GitHub repository target.');
    return report;
  }

  if (!context.target.isGitHub || !context.target.slug) {
    report.warnings.push('Detected target is not a GitHub repository; issue listing was skipped.');
    return report;
  }

  if (!allowApi) {
    report.warnings.push('GitHub issue listing skipped by request.');
    return report;
  }

  const params = new URLSearchParams({
    state,
    per_page: String(limit),
  });
  if (labels.length > 0) {
    params.set('labels', labels.join(','));
  }

  const response = await requestGitHubJson({
    apiPath: `/repos/${encodeURIComponent(context.target.owner)}/${encodeURIComponent(context.target.repo)}/issues?${params.toString()}`,
    apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
    token: context.tokenInfo.token,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  report.githubApi.attempted = true;
  report.githubApi.status = response.status;
  report.githubApi.rateLimit = response.rateLimit || null;

  if (response.ok && Array.isArray(response.data)) {
    report.issues = response.data
      .filter((entry) => !entry?.pull_request)
      .slice(0, limit)
      .map(summarizeIssue)
      .filter(Boolean);
    report.githubApi.issueCount = report.issues.length;
    return report;
  }

  report.githubApi.error = response.error || response.data?.message || `GitHub issue listing failed (${response.status})`;
  if (!context.tokenInfo.token) {
    report.warnings.push('Public issue listing failed without GH_TOKEN/GITHUB_TOKEN; authenticated access may be required for private repositories or higher rate limits.');
  }
  return report;
}

module.exports = {
  GITHUB_ISSUES_LIST_SCHEMA_VERSION,
  listGitHubIssues,
  normalizeIssueState,
  summarizeIssue,
};
