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
  summarizeTemplateFileContent,
} = require('./governance-redaction');

const GITHUB_TEMPLATE_INSPECT_SCHEMA_VERSION = 'github.template-inspect.v1';
const PULL_REQUEST_TEMPLATE_CANDIDATES = [
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/pull_request_template.md',
  'docs/PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
  'PULL_REQUEST_TEMPLATE.md',
  'pull_request_template.md',
];
const ISSUE_TEMPLATE_DIRECTORY = '.github/ISSUE_TEMPLATE';
const ISSUE_TEMPLATE_EXTENSIONS = new Set(['.md', '.yml', '.yaml']);

function listLocalRoots(context, options = {}) {
  const values = [
    options.cwd,
    context?.projectIdentity?.projectRoot,
  ].map((entry) => String(entry || '').trim()).filter(Boolean);

  return [...new Set(values.map((entry) => path.resolve(entry)))];
}

function normalizeLocalFilePath(filePath) {
  const resolvedPath = path.resolve(String(filePath || ''));
  return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
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

function isTemplateFileName(fileName) {
  return ISSUE_TEMPLATE_EXTENSIONS.has(path.extname(String(fileName || '')).toLowerCase());
}

function inspectLocalTemplateFiles(context, options = {}) {
  for (const projectRoot of listLocalRoots(context, options)) {
    const pullRequestTemplates = [];
    const seenPullRequestTemplatePaths = new Set();
    for (const relativePath of PULL_REQUEST_TEMPLATE_CANDIDATES) {
      const absolutePath = path.join(projectRoot, ...relativePath.split('/'));
      if (!fs.existsSync(absolutePath)) {
        continue;
      }
      const stats = fs.statSync(absolutePath);
      if (!stats.isFile()) {
        continue;
      }
      const canonicalPath = normalizeLocalFilePath(absolutePath);
      if (seenPullRequestTemplatePaths.has(canonicalPath)) {
        continue;
      }
      seenPullRequestTemplatePaths.add(canonicalPath);
      const text = fs.readFileSync(absolutePath, 'utf8');
      pullRequestTemplates.push(summarizeTemplateFileContent(text, relativePath));
    }

    const issueTemplates = [];
    const issueTemplateDirectoryPath = path.join(projectRoot, ...ISSUE_TEMPLATE_DIRECTORY.split('/'));
    if (fs.existsSync(issueTemplateDirectoryPath)) {
      const stats = fs.statSync(issueTemplateDirectoryPath);
      if (stats.isDirectory()) {
        const entries = fs.readdirSync(issueTemplateDirectoryPath, { withFileTypes: true })
          .filter((entry) => entry.isFile() && isTemplateFileName(entry.name))
          .sort((left, right) => left.name.localeCompare(right.name));

        for (const entry of entries) {
          const relativePath = `${ISSUE_TEMPLATE_DIRECTORY}/${entry.name}`;
          const absolutePath = path.join(issueTemplateDirectoryPath, entry.name);
          const text = fs.readFileSync(absolutePath, 'utf8');
          issueTemplates.push(summarizeTemplateFileContent(text, relativePath));
        }
      }
    }

    if (pullRequestTemplates.length || issueTemplates.length) {
      return {
        source: 'local-workspace',
        templates: {
          pullRequestTemplates,
          issueTemplates,
        },
      };
    }
  }

  return null;
}

async function fetchRemoteTemplateFile(context, options, relativePath) {
  const response = await requestGitHubJson({
    apiPath: `/repos/${encodeURIComponent(context.target.owner)}/${encodeURIComponent(context.target.repo)}/contents/${encodeContentPath(relativePath)}`,
    apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
    token: context.tokenInfo.token,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  if (response.ok && response.data?.type === 'file') {
    const text = decodeGitHubContent(response.data.content, response.data.encoding);
    return {
      attempted: true,
      status: response.status,
      rateLimit: response.rateLimit || null,
      summary: summarizeTemplateFileContent(text, response.data.path || relativePath),
    };
  }

  if (response.status === 404) {
    return {
      attempted: true,
      status: response.status,
      rateLimit: response.rateLimit || null,
      missing: true,
    };
  }

  return {
    attempted: true,
    status: response.status,
    rateLimit: response.rateLimit || null,
    error: response.error || response.data?.message || `GitHub template inspection failed (${response.status})`,
  };
}

async function listRemoteIssueTemplateEntries(context, options) {
  const response = await requestGitHubJson({
    apiPath: `/repos/${encodeURIComponent(context.target.owner)}/${encodeURIComponent(context.target.repo)}/contents/${encodeContentPath(ISSUE_TEMPLATE_DIRECTORY)}`,
    apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
    token: context.tokenInfo.token,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  if (response.ok && Array.isArray(response.data)) {
    return {
      attempted: true,
      status: response.status,
      rateLimit: response.rateLimit || null,
      entries: response.data
        .filter((entry) => entry?.type === 'file' && isTemplateFileName(entry.path || entry.name))
        .map((entry) => entry.path || `${ISSUE_TEMPLATE_DIRECTORY}/${entry.name}`),
    };
  }

  if (response.status === 404) {
    return {
      attempted: true,
      status: response.status,
      rateLimit: response.rateLimit || null,
      entries: [],
    };
  }

  return {
    attempted: true,
    status: response.status,
    rateLimit: response.rateLimit || null,
    error: response.error || response.data?.message || `GitHub template directory inspection failed (${response.status})`,
  };
}

async function inspectRemoteTemplates(context, options) {
  let attempted = false;
  let status = null;
  let rateLimit = null;
  const pullRequestTemplates = [];
  const issueTemplates = [];

  for (const relativePath of PULL_REQUEST_TEMPLATE_CANDIDATES) {
    const result = await fetchRemoteTemplateFile(context, options, relativePath);
    attempted = attempted || result.attempted === true;
    status = result.status || status;
    rateLimit = result.rateLimit || rateLimit;
    if (result.summary) {
      pullRequestTemplates.push(result.summary);
    } else if (result.error) {
      return { attempted, status, rateLimit, error: result.error };
    }
  }

  const issueDirectoryResult = await listRemoteIssueTemplateEntries(context, options);
  attempted = attempted || issueDirectoryResult.attempted === true;
  status = issueDirectoryResult.status || status;
  rateLimit = issueDirectoryResult.rateLimit || rateLimit;

  if (issueDirectoryResult.error) {
    return { attempted, status, rateLimit, error: issueDirectoryResult.error };
  }

  for (const relativePath of issueDirectoryResult.entries || []) {
    const result = await fetchRemoteTemplateFile(context, options, relativePath);
    attempted = attempted || result.attempted === true;
    status = result.status || status;
    rateLimit = result.rateLimit || rateLimit;
    if (result.summary) {
      issueTemplates.push(result.summary);
    } else if (result.error) {
      return { attempted, status, rateLimit, error: result.error };
    }
  }

  return {
    attempted,
    status,
    rateLimit,
    templates: {
      pullRequestTemplates,
      issueTemplates,
    },
  };
}

async function inspectGitHubTemplates(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const allowApi = options.api !== false;
  const context = applyLocalWorkspaceFallback(resolveGitHubRepoContext(options), options);

  const report = createGovernanceReadReport({
    schemaVersion: GITHUB_TEMPLATE_INSPECT_SCHEMA_VERSION,
    featureFlagEnabled,
    context,
    extra: {
      templates: {
        source: null,
        totalCount: 0,
        pullRequestTemplates: [],
        issueTemplates: [],
      },
    },
  });

  if (isLocalRepoTargetMatch(context)) {
    const localResult = inspectLocalTemplateFiles(context, options);
    if (localResult) {
      report.templates = {
        source: localResult.source,
        totalCount: localResult.templates.pullRequestTemplates.length + localResult.templates.issueTemplates.length,
        pullRequestTemplates: localResult.templates.pullRequestTemplates,
        issueTemplates: localResult.templates.issueTemplates,
      };
      return report;
    }
  }

  if (!ensureGitHubRepositoryTarget(report, context, 'template inspection', allowApi)) {
    if (!allowApi && isLocalRepoTargetMatch(context)) {
      report.warnings.push('No issue or pull request templates were found in the current workspace.');
    }
    return report;
  }

  const remoteResult = await inspectRemoteTemplates(context, options);
  report.githubApi.attempted = remoteResult.attempted === true;
  report.githubApi.status = remoteResult.status;
  report.githubApi.rateLimit = remoteResult.rateLimit || null;

  if (remoteResult.error) {
    report.githubApi.error = remoteResult.error;
    appendUnauthenticatedWarning(report, context, 'Template inspection failed without GH_TOKEN/GITHUB_TOKEN; private repositories require authentication.');
    return report;
  }

  const pullRequestTemplates = remoteResult.templates?.pullRequestTemplates || [];
  const issueTemplates = remoteResult.templates?.issueTemplates || [];
  report.templates = {
    source: 'github-contents',
    totalCount: pullRequestTemplates.length + issueTemplates.length,
    pullRequestTemplates,
    issueTemplates,
  };

  if (report.templates.totalCount === 0) {
    report.warnings.push('No issue or pull request templates were found in standard GitHub template locations.');
  }

  return report;
}

module.exports = {
  GITHUB_TEMPLATE_INSPECT_SCHEMA_VERSION,
  ISSUE_TEMPLATE_DIRECTORY,
  PULL_REQUEST_TEMPLATE_CANDIDATES,
  inspectGitHubTemplates,
};
