const {
  buildExportReview,
  sanitizePersistedValue,
} = require('../persistence-controls');
const {
  GITHUB_CONTEXT_BUNDLE_SCHEMA_VERSION,
  buildGitHubContextBundleId,
  writeGitHubContextBundleArtifact,
} = require('./context-bundle-artifacts');

const DEFAULT_REPO_CONTEXT_LIMIT = 5;
const MAX_REPO_CONTEXT_LIMIT = 25;

function normalizeBundleKind(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['pr', 'issue', 'repo'].includes(normalized) ? normalized : null;
}

function normalizePositiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeContextLimit(value, fallback = DEFAULT_REPO_CONTEXT_LIMIT) {
  const parsed = normalizePositiveInteger(value);
  if (!parsed) {
    return fallback;
  }
  return Math.max(1, Math.min(parsed, MAX_REPO_CONTEXT_LIMIT));
}

function normalizeOptionalString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function uniqueWarnings(reports = []) {
  return Array.from(new Set(
    reports
      .flatMap((report) => (Array.isArray(report?.warnings) ? report.warnings : []))
      .map((warning) => String(warning || '').trim())
      .filter(Boolean)
  ));
}

function buildUsageReport(message) {
  return {
    success: false,
    error: 'USAGE',
    schemaVersion: GITHUB_CONTEXT_BUNDLE_SCHEMA_VERSION,
    message: message || 'Usage: liku github context bundle <pr|issue|repo> [selector] [--slug owner/repo] [--api false] [--limit 5] [--out-file <path>]',
    warnings: [],
  };
}

function buildRepositoryComponent(report = {}) {
  return {
    schemaVersion: report.schemaVersion || null,
    repoIdentity: report.repoIdentity || null,
    remote: report.remote || null,
    target: report.target || null,
    targetSource: report.targetSource || null,
    githubApi: {
      attempted: report.githubApi?.attempted === true,
      status: report.githubApi?.status ?? null,
      error: report.githubApi?.error || null,
      rateLimit: report.githubApi?.rateLimit || null,
      repository: report.githubApi?.repository || null,
    },
    warnings: Array.isArray(report.warnings) ? report.warnings.slice() : [],
  };
}

function buildIssueComponent(report = {}) {
  return {
    schemaVersion: report.schemaVersion || null,
    issueNumber: report.issueNumber ?? null,
    issue: report.issue || null,
    githubApi: {
      attempted: report.githubApi?.attempted === true,
      status: report.githubApi?.status ?? null,
      error: report.githubApi?.error || null,
    },
    warnings: Array.isArray(report.warnings) ? report.warnings.slice() : [],
  };
}

function buildPullRequestComponent(report = {}) {
  return {
    schemaVersion: report.schemaVersion || null,
    pullRequestNumber: report.pullRequestNumber ?? null,
    pullRequest: report.pullRequest || null,
    githubApi: {
      attempted: report.githubApi?.attempted === true,
      status: report.githubApi?.status ?? null,
      error: report.githubApi?.error || null,
    },
    warnings: Array.isArray(report.warnings) ? report.warnings.slice() : [],
  };
}

function buildDiffComponent(report = {}) {
  return {
    schemaVersion: report.schemaVersion || null,
    pullRequestNumber: report.pullRequestNumber ?? null,
    filters: report.filters || null,
    diffSummary: report.diffSummary || null,
    files: Array.isArray(report.files) ? report.files.slice() : [],
    githubApi: {
      attempted: report.githubApi?.attempted === true,
      status: report.githubApi?.status ?? null,
      error: report.githubApi?.error || null,
    },
    warnings: Array.isArray(report.warnings) ? report.warnings.slice() : [],
  };
}

function buildIssuesListComponent(report = {}) {
  return {
    schemaVersion: report.schemaVersion || null,
    filters: report.filters || null,
    count: Array.isArray(report.issues) ? report.issues.length : 0,
    issues: Array.isArray(report.issues) ? report.issues.slice() : [],
    githubApi: {
      attempted: report.githubApi?.attempted === true,
      status: report.githubApi?.status ?? null,
      error: report.githubApi?.error || null,
    },
    warnings: Array.isArray(report.warnings) ? report.warnings.slice() : [],
  };
}

function buildPullRequestListComponent(report = {}) {
  return {
    schemaVersion: report.schemaVersion || null,
    filters: report.filters || null,
    count: Array.isArray(report.pullRequests) ? report.pullRequests.length : 0,
    pullRequests: Array.isArray(report.pullRequests) ? report.pullRequests.slice() : [],
    githubApi: {
      attempted: report.githubApi?.attempted === true,
      status: report.githubApi?.status ?? null,
      error: report.githubApi?.error || null,
    },
    warnings: Array.isArray(report.warnings) ? report.warnings.slice() : [],
  };
}

function buildWorkflowRunsComponent(report = {}) {
  return {
    schemaVersion: report.schemaVersion || null,
    filters: report.filters || null,
    count: Array.isArray(report.workflowRuns) ? report.workflowRuns.length : 0,
    workflowRuns: Array.isArray(report.workflowRuns) ? report.workflowRuns.slice() : [],
    githubApi: {
      attempted: report.githubApi?.attempted === true,
      status: report.githubApi?.status ?? null,
      error: report.githubApi?.error || null,
      totalCount: report.githubApi?.totalCount ?? null,
    },
    warnings: Array.isArray(report.warnings) ? report.warnings.slice() : [],
  };
}

function buildBundleSummary(kind, components = {}) {
  if (kind === 'pr') {
    return {
      componentCount: 3,
      changedFileCount: components.pullRequestDiff?.diffSummary?.fileCount ?? 0,
      totalAdditions: components.pullRequestDiff?.diffSummary?.totalAdditions ?? 0,
      totalDeletions: components.pullRequestDiff?.diffSummary?.totalDeletions ?? 0,
      pullRequestState: components.pullRequest?.pullRequest?.state || null,
    };
  }

  if (kind === 'issue') {
    return {
      componentCount: 2,
      issueState: components.issue?.issue?.state || null,
      commentCount: components.issue?.issue?.comments ?? 0,
      labelCount: Array.isArray(components.issue?.issue?.labels) ? components.issue.issue.labels.length : 0,
    };
  }

  return {
    componentCount: 4,
    issueCount: components.issues?.count ?? 0,
    pullRequestCount: components.pullRequests?.count ?? 0,
    workflowRunCount: components.workflowRuns?.count ?? 0,
  };
}

async function executeNestedCapability(options = {}) {
  const executeGitHubCommand = options.executeGitHubCommand;
  if (typeof executeGitHubCommand !== 'function') {
    throw new Error('GitHub context bundle creation requires executeGitHubCommand().');
  }

  return executeGitHubCommand({
    source: options.source,
    area: options.area,
    action: options.action,
    positionals: options.positionals,
    options: options.runtimeOptions,
    executionPreferences: options.executionPreferences,
    cwd: options.cwd,
    env: options.env,
    aiService: options.aiService,
    featureFlagEnabled: options.featureFlagEnabled,
  });
}

async function buildGitHubContextBundle(options = {}) {
  const source = String(options.source || 'unknown').trim().toLowerCase() || 'unknown';
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const positionals = Array.isArray(options.positionals) ? options.positionals : [];
  const runtimeOptions = options.runtimeOptions && typeof options.runtimeOptions === 'object'
    ? options.runtimeOptions
    : {};
  const kind = normalizeBundleKind(runtimeOptions.kind || positionals[2]);
  const selector = normalizeOptionalString(runtimeOptions.selector || positionals[3]);
  const slug = normalizeOptionalString(runtimeOptions.slug);
  const outFile = normalizeOptionalString(runtimeOptions.outFile || runtimeOptions['out-file']);
  const limit = normalizeContextLimit(runtimeOptions.limit);

  if (!kind) {
    return buildUsageReport();
  }

  if ((kind === 'pr' || kind === 'issue') && !normalizePositiveInteger(selector)) {
    return buildUsageReport(`Usage: liku github context bundle ${kind} <number> [--slug owner/repo] [--api false] [--out-file <path>]`);
  }

  if (kind === 'repo' && selector) {
    return buildUsageReport('Usage: liku github context bundle repo [--slug owner/repo] [--api false] [--limit 5] [--out-file <path>]');
  }

  const baseRuntimeOptions = {
    slug,
    api: runtimeOptions.api,
  };

  const repoReport = await executeNestedCapability({
    ...options,
    source,
    area: 'repo',
    action: 'inspect',
    positionals: ['repo', 'inspect'],
    runtimeOptions: baseRuntimeOptions,
  });

  if (repoReport?.success === false) {
    return repoReport;
  }

  let contents = {
    repository: buildRepositoryComponent(repoReport),
  };
  let warnings = Array.isArray(repoReport?.warnings) ? repoReport.warnings.slice() : [];
  let targetSelector = selector;

  if (kind === 'pr') {
    const pullRequestNumber = normalizePositiveInteger(selector);
    const pullRequestReport = await executeNestedCapability({
      ...options,
      source,
      area: 'pr',
      action: 'inspect',
      positionals: ['pr', 'inspect', String(pullRequestNumber)],
      runtimeOptions: { ...baseRuntimeOptions, number: pullRequestNumber },
    });
    if (pullRequestReport?.success === false) {
      return pullRequestReport;
    }

    const diffReport = await executeNestedCapability({
      ...options,
      source,
      area: 'pr',
      action: 'diff',
      positionals: ['pr', 'diff', String(pullRequestNumber)],
      runtimeOptions: { ...baseRuntimeOptions, number: pullRequestNumber, limit },
    });
    if (diffReport?.success === false) {
      return diffReport;
    }

    contents = {
      ...contents,
      pullRequest: buildPullRequestComponent(pullRequestReport),
      pullRequestDiff: buildDiffComponent(diffReport),
    };
    warnings = uniqueWarnings([repoReport, pullRequestReport, diffReport]);
    targetSelector = String(pullRequestNumber);
  } else if (kind === 'issue') {
    const issueNumber = normalizePositiveInteger(selector);
    const issueReport = await executeNestedCapability({
      ...options,
      source,
      area: 'issues',
      action: 'inspect',
      positionals: ['issues', 'inspect', String(issueNumber)],
      runtimeOptions: { ...baseRuntimeOptions, number: issueNumber },
    });
    if (issueReport?.success === false) {
      return issueReport;
    }

    contents = {
      ...contents,
      issue: buildIssueComponent(issueReport),
    };
    warnings = uniqueWarnings([repoReport, issueReport]);
    targetSelector = String(issueNumber);
  } else {
    const issuesReport = await executeNestedCapability({
      ...options,
      source,
      area: 'issues',
      action: 'list',
      positionals: ['issues', 'list'],
      runtimeOptions: { ...baseRuntimeOptions, limit },
    });
    if (issuesReport?.success === false) {
      return issuesReport;
    }

    const pullRequestsReport = await executeNestedCapability({
      ...options,
      source,
      area: 'pr',
      action: 'list',
      positionals: ['pr', 'list'],
      runtimeOptions: { ...baseRuntimeOptions, limit },
    });
    if (pullRequestsReport?.success === false) {
      return pullRequestsReport;
    }

    const workflowRunsReport = await executeNestedCapability({
      ...options,
      source,
      area: 'workflow',
      action: 'runs',
      positionals: ['workflow', 'runs'],
      runtimeOptions: { ...baseRuntimeOptions, limit },
    });
    if (workflowRunsReport?.success === false) {
      return workflowRunsReport;
    }

    contents = {
      ...contents,
      issues: buildIssuesListComponent(issuesReport),
      pullRequests: buildPullRequestListComponent(pullRequestsReport),
      workflowRuns: buildWorkflowRunsComponent(workflowRunsReport),
    };
    warnings = uniqueWarnings([repoReport, issuesReport, pullRequestsReport, workflowRunsReport]);
    targetSelector = null;
  }

  const bundleId = buildGitHubContextBundleId();
  const createdAt = new Date().toISOString();
  const rawBundle = {
    schemaVersion: GITHUB_CONTEXT_BUNDLE_SCHEMA_VERSION,
    success: true,
    message: 'GitHub context bundle created.',
    featureFlagEnabled,
    source,
    bundleId,
    createdAt,
    target: {
      kind,
      selector: targetSelector,
      slug: repoReport?.target?.slug || slug || null,
    },
    repoContext: {
      repoIdentity: repoReport?.repoIdentity || null,
      remote: repoReport?.remote || null,
      target: repoReport?.target || null,
      targetSource: repoReport?.targetSource || null,
    },
    summary: buildBundleSummary(kind, contents),
    contents,
    warnings,
  };

  const sanitized = sanitizePersistedValue(rawBundle, { path: ['githubContextBundle'] });
  const review = buildExportReview({
    exportKind: 'github-context-bundle',
    redactions: sanitized.redactions,
    reviewRequired: true,
  });

  return writeGitHubContextBundleArtifact({
    bundleId,
    createdAt,
    filePath: outFile,
    payload: {
      ...sanitized.value,
      review,
    },
  });
}

module.exports = {
  DEFAULT_REPO_CONTEXT_LIMIT,
  GITHUB_CONTEXT_BUNDLE_SCHEMA_VERSION,
  MAX_REPO_CONTEXT_LIMIT,
  buildGitHubContextBundle,
  buildUsageReport,
  normalizeBundleKind,
  normalizeContextLimit,
};
