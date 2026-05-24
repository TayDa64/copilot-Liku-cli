const { requestGitHubJson } = require('./client');
const { resolveGitHubRepoContext } = require('./context');

const GITHUB_RELEASES_LIST_SCHEMA_VERSION = 'github.releases-list.v1';

function normalizeLimit(value, fallback = 10, max = 100) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(max, parsed));
}

function summarizeRelease(release) {
  if (!release || typeof release !== 'object') {
    return null;
  }

  return {
    id: Number.isFinite(Number(release.id)) ? Number(release.id) : null,
    tagName: release.tag_name || null,
    name: release.name || null,
    body: typeof release.body === 'string' ? release.body : null,
    draft: release.draft === true,
    prerelease: release.prerelease === true,
    createdAt: release.created_at || null,
    publishedAt: release.published_at || null,
    htmlUrl: release.html_url || null,
    tarballUrl: release.tarball_url || null,
    zipballUrl: release.zipball_url || null,
    targetCommitish: release.target_commitish || null,
    discussionUrl: release.discussion_url || null,
    author: release.author
      ? {
          login: release.author.login || null,
          type: release.author.type || null,
          htmlUrl: release.author.html_url || null,
        }
      : null,
    assetCount: Array.isArray(release.assets) ? release.assets.length : 0,
    assets: Array.isArray(release.assets)
      ? release.assets.slice(0, 12).map((asset) => ({
          id: Number.isFinite(Number(asset?.id)) ? Number(asset.id) : null,
          name: asset?.name || null,
          label: asset?.label || null,
          state: asset?.state || null,
          size: Number.isFinite(Number(asset?.size)) ? Number(asset.size) : null,
          downloadCount: Number.isFinite(Number(asset?.download_count)) ? Number(asset.download_count) : null,
          contentType: asset?.content_type || null,
          browserDownloadUrl: asset?.browser_download_url || null,
        }))
      : [],
  };
}

async function listGitHubReleases(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const allowApi = options.api !== false;
  const limit = normalizeLimit(options.limit, 10, 100);
  const context = resolveGitHubRepoContext(options);

  const report = {
    schemaVersion: GITHUB_RELEASES_LIST_SCHEMA_VERSION,
    success: true,
    featureFlagEnabled,
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: context.target,
    targetSource: context.targetSource,
    filters: {
      limit,
    },
    githubApi: {
      ...context.githubApi,
      releaseCount: 0,
    },
    releases: [],
    warnings: context.warnings.slice(),
  };

  if (!context.target.raw) {
    report.warnings.push('No git remote detected; release listing needs a GitHub repository target.');
    return report;
  }

  if (!context.target.isGitHub || !context.target.slug) {
    report.warnings.push('Detected target is not a GitHub repository; release listing was skipped.');
    return report;
  }

  if (!allowApi) {
    report.warnings.push('GitHub release listing skipped by request.');
    return report;
  }

  const response = await requestGitHubJson({
    apiPath: `/repos/${encodeURIComponent(context.target.owner)}/${encodeURIComponent(context.target.repo)}/releases?per_page=${limit}`,
    apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
    token: context.tokenInfo.token,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  report.githubApi.attempted = true;
  report.githubApi.status = response.status;
  report.githubApi.rateLimit = response.rateLimit || null;

  if (response.ok && Array.isArray(response.data)) {
    report.releases = response.data.slice(0, limit).map(summarizeRelease).filter(Boolean);
    report.githubApi.releaseCount = report.releases.length;
    return report;
  }

  report.githubApi.error = response.error || response.data?.message || `GitHub release listing failed (${response.status})`;
  if (!context.tokenInfo.token) {
    report.warnings.push('Public release listing failed without GH_TOKEN/GITHUB_TOKEN; authenticated access may be required for private repositories or higher rate limits.');
  }
  return report;
}

module.exports = {
  GITHUB_RELEASES_LIST_SCHEMA_VERSION,
  listGitHubReleases,
  normalizeLimit,
  summarizeRelease,
};
