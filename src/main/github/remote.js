function emptyRemote(raw = null) {
  return {
    raw: raw ? String(raw) : null,
    protocol: null,
    host: null,
    owner: null,
    repo: null,
    slug: null,
    isGitHub: false,
    htmlUrl: null,
    apiBaseUrl: null,
  };
}

function trimDotGit(value) {
  return String(value || '').trim().replace(/\.git$/i, '');
}

function parseGitHubRemote(remote) {
  const raw = String(remote || '').trim();
  if (!raw) {
    return emptyRemote(null);
  }

  const patterns = [
    {
      protocol: 'ssh',
      regex: /^git@([^:]+):([^/]+)\/(.+?)$/i,
      groups: ['host', 'owner', 'repo'],
    },
    {
      protocol: 'ssh',
      regex: /^ssh:\/\/git@([^/]+)\/([^/]+)\/(.+?)$/i,
      groups: ['host', 'owner', 'repo'],
    },
    {
      protocol: 'https',
      regex: /^https:\/\/([^/]+)\/([^/]+)\/(.+?)$/i,
      groups: ['host', 'owner', 'repo'],
    },
    {
      protocol: 'http',
      regex: /^http:\/\/([^/]+)\/([^/]+)\/(.+?)$/i,
      groups: ['host', 'owner', 'repo'],
    },
    {
      protocol: 'git',
      regex: /^git:\/\/([^/]+)\/([^/]+)\/(.+?)$/i,
      groups: ['host', 'owner', 'repo'],
    },
  ];

  for (const candidate of patterns) {
    const match = raw.match(candidate.regex);
    if (!match) continue;

    const host = String(match[1] || '').trim().replace(/^www\./i, '').toLowerCase();
    const owner = String(match[2] || '').trim();
    const repo = trimDotGit(match[3]);
    const slug = owner && repo ? `${owner}/${repo}` : null;
    const isGitHub = host === 'github.com';

    return {
      raw,
      protocol: candidate.protocol,
      host: host || null,
      owner: owner || null,
      repo: repo || null,
      slug,
      isGitHub,
      htmlUrl: isGitHub && slug ? `https://${host}/${slug}` : null,
      apiBaseUrl: isGitHub ? 'https://api.github.com' : null,
    };
  }

  return emptyRemote(raw);
}

module.exports = {
  parseGitHubRemote,
};
