const { requestGitHubJson } = require('./client');
const { resolveGitHubRepoContext } = require('./context');

const GITHUB_PR_INSPECT_SCHEMA_VERSION = 'github.pr-inspect.v1';

function normalizePullRequestNumber(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function summarizePullRequest(pullRequest) {
  if (!pullRequest || typeof pullRequest !== 'object') {
    return null;
  }

  return {
    number: Number.isFinite(Number(pullRequest.number)) ? Number(pullRequest.number) : null,
    title: pullRequest.title || null,
    state: pullRequest.state || null,
    draft: pullRequest.draft === true,
    merged: pullRequest.merged === true,
    mergeable: typeof pullRequest.mergeable === 'boolean' ? pullRequest.mergeable : null,
    mergeableState: pullRequest.mergeable_state || null,
    htmlUrl: pullRequest.html_url || null,
    createdAt: pullRequest.created_at || null,
    updatedAt: pullRequest.updated_at || null,
    closedAt: pullRequest.closed_at || null,
    mergedAt: pullRequest.merged_at || null,
    body: typeof pullRequest.body === 'string' ? pullRequest.body : null,
    author: pullRequest.user
      ? {
          login: pullRequest.user.login || null,
          type: pullRequest.user.type || null,
          htmlUrl: pullRequest.user.html_url || null,
        }
      : null,
    head: pullRequest.head
      ? {
          ref: pullRequest.head.ref || null,
          sha: pullRequest.head.sha || null,
          repoFullName: pullRequest.head.repo?.full_name || null,
        }
      : null,
    base: pullRequest.base
      ? {
          ref: pullRequest.base.ref || null,
          sha: pullRequest.base.sha || null,
          repoFullName: pullRequest.base.repo?.full_name || null,
        }
      : null,
    additions: Number.isFinite(Number(pullRequest.additions)) ? Number(pullRequest.additions) : null,
    deletions: Number.isFinite(Number(pullRequest.deletions)) ? Number(pullRequest.deletions) : null,
    changedFiles: Number.isFinite(Number(pullRequest.changed_files)) ? Number(pullRequest.changed_files) : null,
    commits: Number.isFinite(Number(pullRequest.commits)) ? Number(pullRequest.commits) : null,
    comments: Number.isFinite(Number(pullRequest.comments)) ? Number(pullRequest.comments) : null,
    reviewComments: Number.isFinite(Number(pullRequest.review_comments)) ? Number(pullRequest.review_comments) : null,
    reviewCommentUrl: pullRequest.review_comments_url || null,
    issueCommentUrl: pullRequest.comments_url || null,
    labels: Array.isArray(pullRequest.labels)
      ? pullRequest.labels.slice(0, 12).map((label) => ({
          name: label?.name || null,
          color: label?.color || null,
          description: label?.description || null,
        }))
      : [],
    requestedReviewers: Array.isArray(pullRequest.requested_reviewers)
      ? pullRequest.requested_reviewers.slice(0, 8).map((entry) => ({
          login: entry?.login || null,
          type: entry?.type || null,
        }))
      : [],
  };
}

async function inspectGitHubPullRequest(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const allowApi = options.api !== false;
  const pullRequestNumber = normalizePullRequestNumber(options.number || options.pullRequestNumber || options.pr);
  const context = resolveGitHubRepoContext(options);

  const report = {
    schemaVersion: GITHUB_PR_INSPECT_SCHEMA_VERSION,
    success: true,
    featureFlagEnabled,
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: context.target,
    targetSource: context.targetSource,
    pullRequestNumber,
    githubApi: {
      ...context.githubApi,
    },
    pullRequest: null,
    warnings: context.warnings.slice(),
  };

  if (!pullRequestNumber) {
    report.success = false;
    report.error = 'USAGE';
    report.message = 'Usage: liku github pr inspect <number> [--slug owner/repo]';
    return report;
  }

  if (!context.target.raw) {
    report.warnings.push('No git remote detected; pull request inspection needs a GitHub repository target.');
    return report;
  }

  if (!context.target.isGitHub || !context.target.slug) {
    report.warnings.push('Detected target is not a GitHub repository; pull request inspection was skipped.');
    return report;
  }

  if (!allowApi) {
    report.warnings.push('GitHub pull request inspection skipped by request.');
    return report;
  }

  const response = await requestGitHubJson({
    apiPath: `/repos/${encodeURIComponent(context.target.owner)}/${encodeURIComponent(context.target.repo)}/pulls/${pullRequestNumber}`,
    apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
    token: context.tokenInfo.token,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  report.githubApi.attempted = true;
  report.githubApi.status = response.status;
  report.githubApi.rateLimit = response.rateLimit || null;

  if (response.ok && response.data) {
    report.pullRequest = summarizePullRequest(response.data);
    return report;
  }

  report.githubApi.error = response.error || response.data?.message || `GitHub pull request inspection failed (${response.status})`;
  if (!context.tokenInfo.token) {
    report.warnings.push('Public pull request inspection failed without GH_TOKEN/GITHUB_TOKEN; authenticated access may be required for private repositories or higher rate limits.');
  }
  return report;
}

module.exports = {
  GITHUB_PR_INSPECT_SCHEMA_VERSION,
  inspectGitHubPullRequest,
  normalizePullRequestNumber,
  summarizePullRequest,
};
