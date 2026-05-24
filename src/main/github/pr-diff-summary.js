const { requestGitHubJson } = require('./client');
const { resolveGitHubRepoContext } = require('./context');
const { normalizePullRequestNumber } = require('./pr-inspect');

const GITHUB_PR_DIFF_SUMMARY_SCHEMA_VERSION = 'github.pr-diff-summary.v1';

function normalizeLimit(value, fallback = 30, max = 100) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(max, parsed));
}

function summarizePullRequestFile(file) {
  if (!file || typeof file !== 'object') {
    return null;
  }

  return {
    filename: file.filename || null,
    status: file.status || null,
    additions: Number.isFinite(Number(file.additions)) ? Number(file.additions) : null,
    deletions: Number.isFinite(Number(file.deletions)) ? Number(file.deletions) : null,
    changes: Number.isFinite(Number(file.changes)) ? Number(file.changes) : null,
    previousFilename: file.previous_filename || null,
    blobUrl: file.blob_url || null,
    rawUrl: file.raw_url || null,
    contentsUrl: file.contents_url || null,
    patchPreview: typeof file.patch === 'string' ? file.patch.slice(0, 240) : null,
  };
}

function buildDirectorySummary(files = []) {
  const counts = new Map();
  files.forEach((file) => {
    const name = String(file?.filename || '').trim();
    if (!name) return;
    const firstSegment = name.split('/')[0] || name;
    counts.set(firstSegment, (counts.get(firstSegment) || 0) + 1);
  });
  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 10)
    .map(([path, count]) => ({ path, count }));
}

function buildDiffSummary(files = []) {
  const valid = Array.isArray(files) ? files.filter(Boolean) : [];
  return {
    fileCount: valid.length,
    totalAdditions: valid.reduce((sum, file) => sum + (Number.isFinite(file.additions) ? file.additions : 0), 0),
    totalDeletions: valid.reduce((sum, file) => sum + (Number.isFinite(file.deletions) ? file.deletions : 0), 0),
    directories: buildDirectorySummary(valid),
  };
}

async function inspectGitHubPullRequestDiff(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const allowApi = options.api !== false;
  const pullRequestNumber = normalizePullRequestNumber(options.number || options.pullRequestNumber || options.pr);
  const limit = normalizeLimit(options.limit, 30, 100);
  const context = resolveGitHubRepoContext(options);

  const report = {
    schemaVersion: GITHUB_PR_DIFF_SUMMARY_SCHEMA_VERSION,
    success: true,
    featureFlagEnabled,
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: context.target,
    targetSource: context.targetSource,
    pullRequestNumber,
    filters: {
      limit,
    },
    githubApi: {
      ...context.githubApi,
      fileCount: 0,
    },
    diffSummary: {
      fileCount: 0,
      totalAdditions: 0,
      totalDeletions: 0,
      directories: [],
    },
    files: [],
    warnings: context.warnings.slice(),
  };

  if (!pullRequestNumber) {
    report.success = false;
    report.error = 'USAGE';
    report.message = 'Usage: liku github pr diff <number> [--slug owner/repo] [--limit N]';
    return report;
  }

  if (!context.target.raw) {
    report.warnings.push('No git remote detected; pull request diff inspection needs a GitHub repository target.');
    return report;
  }

  if (!context.target.isGitHub || !context.target.slug) {
    report.warnings.push('Detected target is not a GitHub repository; pull request diff inspection was skipped.');
    return report;
  }

  if (!allowApi) {
    report.warnings.push('GitHub pull request diff inspection skipped by request.');
    return report;
  }

  const response = await requestGitHubJson({
    apiPath: `/repos/${encodeURIComponent(context.target.owner)}/${encodeURIComponent(context.target.repo)}/pulls/${pullRequestNumber}/files?per_page=${limit}`,
    apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
    token: context.tokenInfo.token,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  report.githubApi.attempted = true;
  report.githubApi.status = response.status;
  report.githubApi.rateLimit = response.rateLimit || null;

  if (response.ok && Array.isArray(response.data)) {
    report.files = response.data.slice(0, limit).map(summarizePullRequestFile).filter(Boolean);
    report.githubApi.fileCount = report.files.length;
    report.diffSummary = buildDiffSummary(report.files);
    if (response.data.length >= limit) {
      report.warnings.push(`Diff summary is limited to the first ${limit} changed files.`);
    }
    return report;
  }

  report.githubApi.error = response.error || response.data?.message || `GitHub pull request diff inspection failed (${response.status})`;
  if (!context.tokenInfo.token) {
    report.warnings.push('Public pull request diff inspection failed without GH_TOKEN/GITHUB_TOKEN; authenticated access may be required for private repositories or higher rate limits.');
  }
  return report;
}

module.exports = {
  GITHUB_PR_DIFF_SUMMARY_SCHEMA_VERSION,
  buildDiffSummary,
  inspectGitHubPullRequestDiff,
  normalizeLimit,
  summarizePullRequestFile,
};
