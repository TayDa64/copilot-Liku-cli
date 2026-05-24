const { requestGitHubJson } = require('./client');
const { resolveGitHubRepoContext } = require('./context');

const GITHUB_REPO_INSPECT_SCHEMA_VERSION = 'github.repo-inspect.v1';

function summarizePermissions(permissions) {
  if (!permissions || typeof permissions !== 'object') {
    return null;
  }
  return {
    admin: permissions.admin === true,
    maintain: permissions.maintain === true,
    push: permissions.push === true,
    triage: permissions.triage === true,
    pull: permissions.pull === true,
  };
}

function summarizeRepository(data) {
  if (!data || typeof data !== 'object') {
    return null;
  }

  return {
    id: Number.isFinite(Number(data.id)) ? Number(data.id) : null,
    name: data.name || null,
    fullName: data.full_name || null,
    description: data.description || null,
    private: data.private === true,
    visibility: data.visibility || null,
    defaultBranch: data.default_branch || null,
    archived: data.archived === true,
    fork: data.fork === true,
    language: data.language || null,
    stars: Number.isFinite(Number(data.stargazers_count)) ? Number(data.stargazers_count) : null,
    forks: Number.isFinite(Number(data.forks_count)) ? Number(data.forks_count) : null,
    watchers: Number.isFinite(Number(data.watchers_count)) ? Number(data.watchers_count) : null,
    openIssuesCount: Number.isFinite(Number(data.open_issues_count)) ? Number(data.open_issues_count) : null,
    htmlUrl: data.html_url || null,
    cloneUrl: data.clone_url || null,
    sshUrl: data.ssh_url || null,
    homepage: data.homepage || null,
    topics: Array.isArray(data.topics) ? data.topics.slice(0, 12) : [],
    license: data.license
      ? {
          key: data.license.key || null,
          spdxId: data.license.spdx_id || null,
          name: data.license.name || null,
        }
      : null,
    owner: data.owner
      ? {
          login: data.owner.login || null,
          type: data.owner.type || null,
          htmlUrl: data.owner.html_url || null,
        }
      : null,
    permissions: summarizePermissions(data.permissions),
    pushedAt: data.pushed_at || null,
    updatedAt: data.updated_at || null,
  };
}

async function inspectGitHubRepository(options = {}) {
  const cwd = options.cwd || process.cwd();
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const allowApi = options.api !== false;
  const context = resolveGitHubRepoContext({ ...options, cwd });

  const report = {
    schemaVersion: GITHUB_REPO_INSPECT_SCHEMA_VERSION,
    success: true,
    featureFlagEnabled,
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: context.target,
    targetSource: context.targetSource,
    githubApi: {
      ...context.githubApi,
      repository: null,
    },
    warnings: context.warnings.slice(),
  };

  if (!context.target.raw) {
    report.warnings.push('No git remote detected; only local repository identity is available.');
    return report;
  }

  if (!context.target.isGitHub || !context.target.slug) {
    report.warnings.push('Detected remote is not a GitHub repository; GitHub API inspection was skipped.');
    return report;
  }

  if (!allowApi) {
    report.warnings.push('GitHub API inspection skipped by request.');
    return report;
  }

  const response = await requestGitHubJson({
    apiPath: `/repos/${encodeURIComponent(context.target.owner)}/${encodeURIComponent(context.target.repo)}`,
    apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
    token: context.tokenInfo.token,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  report.githubApi.attempted = true;
  report.githubApi.status = response.status;
  report.githubApi.rateLimit = response.rateLimit || null;

  if (response.ok && response.data) {
    report.githubApi.repository = summarizeRepository(response.data);
    return report;
  }

  report.githubApi.error = response.error || response.data?.message || `GitHub API inspection failed (${response.status})`;
  if (!context.tokenInfo.token) {
    report.warnings.push('Public API inspection failed without GH_TOKEN/GITHUB_TOKEN; private repositories will require an authenticated token.');
  }
  return report;
}

module.exports = {
  GITHUB_REPO_INSPECT_SCHEMA_VERSION,
  inspectGitHubRepository,
  summarizeRepository,
};
