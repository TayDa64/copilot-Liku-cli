const fs = require('fs');
const path = require('path');

const { requestGitHubJson } = require('./client');
const { resolveGitHubRepoContext } = require('./context');
const {
  appendUnauthenticatedWarning,
  createGovernanceReadReport,
  decodeGitHubContent,
  ensureGitHubRepositoryTarget,
  isLocalRepoTargetMatch,
  summarizeCodeownersText,
} = require('./governance-redaction');

const GITHUB_CODEOWNERS_INSPECT_SCHEMA_VERSION = 'github.codeowners-inspect.v1';
const CODEOWNERS_CANDIDATES = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'];

function listLocalRoots(context, options = {}) {
  const values = [
    options.cwd,
    context?.projectIdentity?.projectRoot,
  ].map((entry) => String(entry || '').trim()).filter(Boolean);

  return [...new Set(values.map((entry) => path.resolve(entry)))];
}

function applyLocalWorkspaceFallback(context, options = {}) {
  const cwd = String(options.cwd || '').trim();
  if (!cwd || context?.projectIdentity?.projectRoot) {
    return context;
  }

  const fallbackRoot = path.resolve(cwd);
  const repoName = path.basename(fallbackRoot) || 'workspace';
  return {
    ...context,
    projectIdentity: {
      ...(context.projectIdentity || {}),
      projectRoot: fallbackRoot,
      repoName: context.projectIdentity?.repoName || repoName,
      normalizedRepoName: context.projectIdentity?.normalizedRepoName || repoName.toLowerCase(),
    },
  };
}

function encodeContentPath(value) {
  return String(value || '').split('/').map((part) => encodeURIComponent(part)).join('/');
}

function inspectLocalCodeowners(context, options = {}) {
  for (const projectRoot of listLocalRoots(context, options)) {
    for (const relativePath of CODEOWNERS_CANDIDATES) {
      const absolutePath = path.join(projectRoot, ...relativePath.split('/'));
      if (!fs.existsSync(absolutePath)) {
        continue;
      }
      const stats = fs.statSync(absolutePath);
      if (!stats.isFile()) {
        continue;
      }
      const text = fs.readFileSync(absolutePath, 'utf8');
      return {
        source: 'local-workspace',
        codeowners: summarizeCodeownersText(text, relativePath),
      };
    }
  }

  return null;
}

async function inspectRemoteCodeowners(context, options) {
  let attempted = false;
  let status = null;
  let rateLimit = null;

  for (const relativePath of CODEOWNERS_CANDIDATES) {
    const response = await requestGitHubJson({
      apiPath: `/repos/${encodeURIComponent(context.target.owner)}/${encodeURIComponent(context.target.repo)}/contents/${encodeContentPath(relativePath)}`,
      apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
      token: context.tokenInfo.token,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });

    attempted = true;
    status = response.status;
    rateLimit = response.rateLimit || rateLimit;

    if (response.ok && response.data?.type === 'file') {
      const text = decodeGitHubContent(response.data.content, response.data.encoding);
      return {
        attempted,
        status,
        rateLimit,
        source: 'github-contents',
        codeowners: summarizeCodeownersText(text, response.data.path || relativePath),
      };
    }

    if (response.status === 404) {
      continue;
    }

    return {
      attempted,
      status,
      rateLimit,
      error: response.error || response.data?.message || `GitHub CODEOWNERS inspection failed (${response.status})`,
    };
  }

  return {
    attempted,
    status,
    rateLimit,
    notFound: true,
  };
}

async function inspectGitHubCodeowners(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const allowApi = options.api !== false;
  const context = applyLocalWorkspaceFallback(resolveGitHubRepoContext(options), options);

  const report = createGovernanceReadReport({
    schemaVersion: GITHUB_CODEOWNERS_INSPECT_SCHEMA_VERSION,
    featureFlagEnabled,
    context,
    githubApiExtra: {
      path: null,
    },
    extra: {
      searchedPaths: CODEOWNERS_CANDIDATES.slice(),
      codeowners: null,
    },
  });

  if (isLocalRepoTargetMatch(context)) {
    const localResult = inspectLocalCodeowners(context, options);
    if (localResult) {
      report.codeowners = {
        ...localResult.codeowners,
        source: localResult.source,
      };
      return report;
    }
  }

  if (!ensureGitHubRepositoryTarget(report, context, 'CODEOWNERS inspection', allowApi)) {
    if (!allowApi && isLocalRepoTargetMatch(context)) {
      report.warnings.push('No CODEOWNERS file found in the current workspace.');
    }
    return report;
  }

  const remoteResult = await inspectRemoteCodeowners(context, options);
  report.githubApi.attempted = remoteResult.attempted === true;
  report.githubApi.status = remoteResult.status;
  report.githubApi.rateLimit = remoteResult.rateLimit || null;

  if (remoteResult.codeowners) {
    report.githubApi.path = remoteResult.codeowners.path;
    report.codeowners = {
      ...remoteResult.codeowners,
      source: remoteResult.source,
    };
    return report;
  }

  if (remoteResult.error) {
    report.githubApi.error = remoteResult.error;
    appendUnauthenticatedWarning(report, context, 'CODEOWNERS inspection failed without GH_TOKEN/GITHUB_TOKEN; private repositories require authentication.');
    return report;
  }

  report.warnings.push('No CODEOWNERS file found in standard GitHub locations (root, .github/, docs/).');
  return report;
}

module.exports = {
  CODEOWNERS_CANDIDATES,
  GITHUB_CODEOWNERS_INSPECT_SCHEMA_VERSION,
  inspectGitHubCodeowners,
};
