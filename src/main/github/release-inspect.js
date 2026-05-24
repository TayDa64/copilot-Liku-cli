const { requestGitHubJson } = require('./client');
const { resolveGitHubRepoContext } = require('./context');
const { summarizeRelease } = require('./releases-list');

const GITHUB_RELEASE_INSPECT_SCHEMA_VERSION = 'github.release-inspect.v1';

function normalizeReleaseSelector(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^latest$/i.test(raw)) {
    return { kind: 'latest', value: 'latest' };
  }
  if (/^\d+$/.test(raw)) {
    return { kind: 'id', value: Number.parseInt(raw, 10) };
  }
  return { kind: 'tag', value: raw };
}

function buildReleaseApiPath(target, selector) {
  const base = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/releases`;
  if (selector.kind === 'latest') {
    return `${base}/latest`;
  }
  if (selector.kind === 'id') {
    return `${base}/${selector.value}`;
  }
  return `${base}/tags/${encodeURIComponent(selector.value)}`;
}

async function inspectGitHubRelease(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const allowApi = options.api !== false;
  const selector = normalizeReleaseSelector(options.selector || options.tag || options.id || options.release || options.name);
  const context = resolveGitHubRepoContext(options);

  const report = {
    schemaVersion: GITHUB_RELEASE_INSPECT_SCHEMA_VERSION,
    success: true,
    featureFlagEnabled,
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: context.target,
    targetSource: context.targetSource,
    selector,
    githubApi: {
      ...context.githubApi,
    },
    release: null,
    warnings: context.warnings.slice(),
  };

  if (!selector) {
    report.success = false;
    report.error = 'USAGE';
    report.message = 'Usage: liku github releases inspect <latest|tag|id> [--slug owner/repo]';
    return report;
  }

  if (!context.target.raw) {
    report.warnings.push('No git remote detected; release inspection needs a GitHub repository target.');
    return report;
  }

  if (!context.target.isGitHub || !context.target.slug) {
    report.warnings.push('Detected target is not a GitHub repository; release inspection was skipped.');
    return report;
  }

  if (!allowApi) {
    report.warnings.push('GitHub release inspection skipped by request.');
    return report;
  }

  const response = await requestGitHubJson({
    apiPath: buildReleaseApiPath(context.target, selector),
    apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
    token: context.tokenInfo.token,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  report.githubApi.attempted = true;
  report.githubApi.status = response.status;
  report.githubApi.rateLimit = response.rateLimit || null;

  if (response.ok && response.data) {
    report.release = summarizeRelease(response.data);
    return report;
  }

  report.githubApi.error = response.error || response.data?.message || `GitHub release inspection failed (${response.status})`;
  if (!context.tokenInfo.token) {
    report.warnings.push('Public release inspection failed without GH_TOKEN/GITHUB_TOKEN; authenticated access may be required for private repositories or higher rate limits.');
  }
  return report;
}

module.exports = {
  GITHUB_RELEASE_INSPECT_SCHEMA_VERSION,
  buildReleaseApiPath,
  inspectGitHubRelease,
  normalizeReleaseSelector,
};
