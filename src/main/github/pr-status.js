const { resolveGitHubRepoContext } = require('./context');
const { resolveCurrentGitBranch } = require('./git-branch');
const { inspectGitHubPullRequest } = require('./pr-inspect');
const { listGitHubPullRequests, normalizePullRequestState } = require('./pr-list');

const GITHUB_PR_STATUS_SCHEMA_VERSION = 'github.pr-status.v1';

function normalizeText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function appendUniqueWarnings(target, warnings) {
  if (!Array.isArray(target) || !Array.isArray(warnings)) {
    return target;
  }

  warnings.forEach((warning) => {
    const text = String(warning || '').trim();
    if (text && !target.includes(text)) {
      target.push(text);
    }
  });

  return target;
}

function buildHeadQuery(owner, value) {
  const text = normalizeText(value);
  if (!text) {
    return null;
  }
  if (text.includes(':')) {
    return text;
  }
  return owner ? `${owner}:${text}` : text;
}

function extractBranchFromHeadQuery(value) {
  const text = normalizeText(value);
  if (!text) {
    return null;
  }

  const separatorIndex = text.indexOf(':');
  return separatorIndex >= 0 ? text.slice(separatorIndex + 1).trim() || null : text;
}

function resolvePullRequestBranchContext(options = {}, context = {}) {
  const explicitHead = normalizeText(options.head);
  if (explicitHead) {
    return {
      currentBranch: extractBranchFromHeadQuery(explicitHead),
      headQuery: buildHeadQuery(context.target?.owner || null, explicitHead),
      requestedBranch: null,
      requestedHead: explicitHead,
      headRef: null,
      detached: false,
      available: true,
      source: 'explicit-head',
      warnings: [],
    };
  }

  const explicitBranch = normalizeText(options.branch);
  if (explicitBranch) {
    return {
      currentBranch: explicitBranch,
      headQuery: buildHeadQuery(context.target?.owner || null, explicitBranch),
      requestedBranch: explicitBranch,
      requestedHead: null,
      headRef: null,
      detached: false,
      available: true,
      source: 'explicit-branch',
      warnings: [],
    };
  }

  const detected = (typeof options.resolveCurrentGitBranch === 'function'
    ? options.resolveCurrentGitBranch
    : resolveCurrentGitBranch)({
      cwd: options.cwd || process.cwd(),
      resolveProjectIdentity: options.resolveProjectIdentity,
      fsModule: options.fsModule,
    });

  return {
    currentBranch: normalizeText(detected.currentBranch),
    headQuery: buildHeadQuery(context.target?.owner || null, detected.currentBranch),
    requestedBranch: null,
    requestedHead: null,
    headRef: normalizeText(detected.headRef),
    detached: detected.detached === true,
    available: detected.available === true,
    source: normalizeText(detected.source) || 'git-head',
    warnings: Array.isArray(detected.warnings) ? detected.warnings.slice() : [],
  };
}

async function inspectGitHubPullRequestStatus(options = {}) {
  const cwd = options.cwd || process.cwd();
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const allowApi = options.api !== false;
  const state = normalizePullRequestState(options.state, 'open');
  const context = resolveGitHubRepoContext({ ...options, cwd });
  const branchContext = resolvePullRequestBranchContext({ ...options, cwd }, context);

  const report = {
    schemaVersion: GITHUB_PR_STATUS_SCHEMA_VERSION,
    success: true,
    featureFlagEnabled,
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: context.target,
    targetSource: context.targetSource,
    branchContext,
    filters: {
      state,
      branch: branchContext.currentBranch,
      head: branchContext.headQuery,
    },
    lookup: {
      status: branchContext.headQuery ? 'pending' : 'unavailable',
      headQuery: branchContext.headQuery,
      matchedCount: 0,
      selectedPullRequestNumber: null,
    },
    githubApi: {
      ...context.githubApi,
      pullRequestCount: 0,
      inspectStatus: null,
      inspectRateLimit: null,
      inspectError: null,
    },
    pullRequest: null,
    pullRequests: [],
    warnings: appendUniqueWarnings(context.warnings.slice(), branchContext.warnings),
  };

  if (!context.target.raw) {
    report.lookup.status = 'unavailable';
    report.warnings.push('No git remote detected; pull request status needs a GitHub repository target.');
    return report;
  }

  if (!context.target.isGitHub || !context.target.slug) {
    report.lookup.status = 'unavailable';
    report.warnings.push('Detected target is not a GitHub repository; pull request status was skipped.');
    return report;
  }

  if (!branchContext.headQuery) {
    report.lookup.status = 'unavailable';
    if (!report.warnings.some((warning) => /current branch|detached head/i.test(warning))) {
      report.warnings.push('Current branch could not be determined; pull request status was skipped.');
    }
    return report;
  }

  if (!allowApi) {
    report.lookup.status = 'unavailable';
    report.warnings.push('GitHub pull request status lookup skipped by request.');
    return report;
  }

  const listReport = await listGitHubPullRequests({
    ...options,
    cwd,
    env: options.env || process.env,
    featureFlagEnabled,
    api: true,
    slug: context.target.slug,
    state,
    limit: 5,
    head: branchContext.headQuery,
  });

  report.githubApi = {
    ...report.githubApi,
    ...listReport.githubApi,
    inspectStatus: null,
    inspectRateLimit: null,
    inspectError: null,
  };
  report.pullRequests = Array.isArray(listReport.pullRequests) ? listReport.pullRequests.slice() : [];
  appendUniqueWarnings(report.warnings, listReport.warnings);
  report.lookup.matchedCount = report.pullRequests.length;

  if (report.githubApi.error) {
    report.lookup.status = 'api-error';
    return report;
  }

  if (report.pullRequests.length === 0) {
    report.lookup.status = 'not-found';
    return report;
  }

  if (report.pullRequests.length > 1) {
    report.lookup.status = 'multiple';
    report.warnings.push(`Multiple pull requests matched ${branchContext.headQuery}; inspect one PR directly for exact status.`);
    return report;
  }

  const selected = report.pullRequests[0];
  report.lookup.status = 'matched';
  report.lookup.selectedPullRequestNumber = selected.number || null;

  const inspectReport = await inspectGitHubPullRequest({
    ...options,
    cwd,
    env: options.env || process.env,
    featureFlagEnabled,
    api: true,
    slug: context.target.slug,
    number: selected.number,
  });

  report.githubApi.inspectStatus = inspectReport.githubApi?.status || null;
  report.githubApi.inspectRateLimit = inspectReport.githubApi?.rateLimit || null;
  report.githubApi.inspectError = inspectReport.githubApi?.error || null;
  appendUniqueWarnings(report.warnings, inspectReport.warnings);
  report.pullRequest = inspectReport.pullRequest || selected;

  if (!inspectReport.pullRequest && inspectReport.githubApi?.error) {
    report.warnings.push(`GitHub pull request detail lookup failed for #${selected.number}; showing the branch-associated summary match instead.`);
  }

  return report;
}

module.exports = {
  GITHUB_PR_STATUS_SCHEMA_VERSION,
  buildHeadQuery,
  extractBranchFromHeadQuery,
  inspectGitHubPullRequestStatus,
  resolvePullRequestBranchContext,
};