const { resolveProjectIdentity } = require('../../shared/project-identity');
const { getEnvGitHubToken, maskToken } = require('./client');
const { parseGitHubRemote } = require('./remote');

function parseGitHubSlug(raw) {
  const text = String(raw || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
  if (!text) return null;
  const match = text.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) return null;

  const owner = String(match[1] || '').trim();
  const repo = String(match[2] || '').trim();
  const slug = owner && repo ? `${owner}/${repo}` : null;
  if (!slug) return null;

  return {
    raw: slug,
    protocol: null,
    host: 'github.com',
    owner,
    repo,
    slug,
    isGitHub: true,
    htmlUrl: `https://github.com/${slug}`,
    apiBaseUrl: 'https://api.github.com',
    source: 'explicit-slug',
  };
}

function buildGitHubApiState(tokenInfo) {
  return {
    tokenPresent: !!tokenInfo?.token,
    tokenSource: tokenInfo?.source || null,
    tokenPreview: maskToken(tokenInfo?.token),
    attempted: false,
    status: null,
    rateLimit: null,
    error: null,
  };
}

function resolveGitHubRepoContext(options = {}) {
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const slugOverride = parseGitHubSlug(options.slug);
  const projectIdentity = (options.resolveProjectIdentity || resolveProjectIdentity)({ cwd });
  const remote = (options.parseGitHubRemote || parseGitHubRemote)(projectIdentity.gitRemote);
  const tokenInfo = options.tokenInfo || getEnvGitHubToken(env);
  const warnings = [];

  if (options.slug && !slugOverride) {
    warnings.push(`Invalid GitHub slug: ${options.slug}. Expected owner/repo.`);
  }

  const target = slugOverride || remote;
  const targetSource = slugOverride ? 'explicit-slug' : 'git-remote';

  return {
    projectIdentity,
    remote,
    target,
    targetSource,
    tokenInfo,
    githubApi: buildGitHubApiState(tokenInfo),
    warnings,
  };
}

module.exports = {
  buildGitHubApiState,
  parseGitHubSlug,
  resolveGitHubRepoContext,
};
