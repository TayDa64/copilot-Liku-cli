const { requestGitHubJson } = require('./client');
const { resolveGitHubRepoContext } = require('./context');
const { summarizeIssue } = require('./issues-list');

const GITHUB_ISSUE_INSPECT_SCHEMA_VERSION = 'github.issue-inspect.v1';

function normalizeIssueNumber(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function summarizeIssueDetail(issue) {
  const base = summarizeIssue(issue);
  if (!base) {
    return null;
  }

  return {
    ...base,
    body: typeof issue.body === 'string' ? issue.body : null,
    stateReason: issue.state_reason || null,
    closedAt: issue.closed_at || null,
    activeLockReason: issue.active_lock_reason || null,
    authorAssociation: issue.author_association || null,
    repositoryUrl: issue.repository_url || null,
    commentsUrl: issue.comments_url || null,
    isPullRequest: !!issue.pull_request,
    pullRequest: issue.pull_request
      ? {
          url: issue.pull_request.url || null,
          htmlUrl: issue.pull_request.html_url || null,
          diffUrl: issue.pull_request.diff_url || null,
          patchUrl: issue.pull_request.patch_url || null,
        }
      : null,
    reactions: issue.reactions
      ? {
          totalCount: Number.isFinite(Number(issue.reactions.total_count)) ? Number(issue.reactions.total_count) : null,
          plusOne: Number.isFinite(Number(issue.reactions['+1'])) ? Number(issue.reactions['+1']) : null,
          minusOne: Number.isFinite(Number(issue.reactions['-1'])) ? Number(issue.reactions['-1']) : null,
          laugh: Number.isFinite(Number(issue.reactions.laugh)) ? Number(issue.reactions.laugh) : null,
          hooray: Number.isFinite(Number(issue.reactions.hooray)) ? Number(issue.reactions.hooray) : null,
          confused: Number.isFinite(Number(issue.reactions.confused)) ? Number(issue.reactions.confused) : null,
          heart: Number.isFinite(Number(issue.reactions.heart)) ? Number(issue.reactions.heart) : null,
          rocket: Number.isFinite(Number(issue.reactions.rocket)) ? Number(issue.reactions.rocket) : null,
          eyes: Number.isFinite(Number(issue.reactions.eyes)) ? Number(issue.reactions.eyes) : null,
        }
      : null,
  };
}

async function inspectGitHubIssue(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const allowApi = options.api !== false;
  const issueNumber = normalizeIssueNumber(options.number || options.issueNumber || options.issue);
  const context = resolveGitHubRepoContext(options);

  const report = {
    schemaVersion: GITHUB_ISSUE_INSPECT_SCHEMA_VERSION,
    success: true,
    featureFlagEnabled,
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: context.target,
    targetSource: context.targetSource,
    issueNumber,
    githubApi: {
      ...context.githubApi,
    },
    issue: null,
    warnings: context.warnings.slice(),
  };

  if (!issueNumber) {
    report.success = false;
    report.error = 'USAGE';
    report.message = 'Usage: liku github issues inspect <number> [--slug owner/repo]';
    return report;
  }

  if (!context.target.raw) {
    report.warnings.push('No git remote detected; issue inspection needs a GitHub repository target.');
    return report;
  }

  if (!context.target.isGitHub || !context.target.slug) {
    report.warnings.push('Detected target is not a GitHub repository; issue inspection was skipped.');
    return report;
  }

  if (!allowApi) {
    report.warnings.push('GitHub issue inspection skipped by request.');
    return report;
  }

  const response = await requestGitHubJson({
    apiPath: `/repos/${encodeURIComponent(context.target.owner)}/${encodeURIComponent(context.target.repo)}/issues/${issueNumber}`,
    apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
    token: context.tokenInfo.token,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  report.githubApi.attempted = true;
  report.githubApi.status = response.status;
  report.githubApi.rateLimit = response.rateLimit || null;

  if (response.ok && response.data) {
    report.issue = summarizeIssueDetail(response.data);
    if (report.issue?.isPullRequest) {
      report.warnings.push('GitHub returned a pull request for this issue number; use `liku github pr inspect <number>` for pull-request-specific details.');
    }
    return report;
  }

  report.githubApi.error = response.error || response.data?.message || `GitHub issue inspection failed (${response.status})`;
  if (!context.tokenInfo.token) {
    report.warnings.push('Public issue inspection failed without GH_TOKEN/GITHUB_TOKEN; authenticated access may be required for private repositories or higher rate limits.');
  }
  return report;
}

module.exports = {
  GITHUB_ISSUE_INSPECT_SCHEMA_VERSION,
  inspectGitHubIssue,
  normalizeIssueNumber,
  summarizeIssueDetail,
};
