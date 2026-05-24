const { parseLongOptions, tokenize } = require('../ai-service/slash-command-helpers');
const { resolveGitHubAuthStatus } = require('./auth-status');
const { inspectGitHubRepository } = require('./repo-inspect');
const { inspectGitHubIssue } = require('./issue-inspect');
const { listGitHubIssues } = require('./issues-list');
const { inspectGitHubPullRequestDiff } = require('./pr-diff-summary');
const { listGitHubPullRequests } = require('./pr-list');
const { inspectGitHubPullRequest } = require('./pr-inspect');
const { inspectGitHubRelease } = require('./release-inspect');
const { listGitHubReleases } = require('./releases-list');
const { inspectGitHubWorkflowRun } = require('./workflow-inspect');
const { listGitHubWorkflowRuns } = require('./workflow-runs');

function parseBooleanOption(value, fallback = true) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function isFeatureFlagEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.LIKU_ENABLE_GITHUB || '').trim());
}

function normalizeArea(area) {
  const value = String(area || '').trim().toLowerCase();
  if (value === 'issue') return 'issues';
  if (value === 'workflows') return 'workflow';
  if (value === 'release') return 'releases';
  return value;
}

function compactTimestamp(value) {
  const timestamp = String(value || '').trim();
  if (!timestamp) return 'unknown';
  return timestamp.replace('T', ' ').replace(/:\d\d\.\d{3}Z$/, 'Z').replace(/:\d\dZ$/, 'Z');
}

function truncate(value, maxLength = 72) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1))}…`;
}

function formatWarnings(warnings = []) {
  if (!Array.isArray(warnings) || warnings.length === 0) {
    return [];
  }
  return ['Warnings:', ...warnings.map((warning) => `- ${warning}`)];
}

function buildResult(report, message, type = 'info') {
  return {
    type,
    message,
    data: report,
  };
}

function buildUsageResult(message, helpText) {
  return {
    type: 'error',
    message: helpText ? `${message}\n\n${helpText}` : message,
  };
}

function formatHelp() {
  return [
    'Shared GitHub slash commands:',
    '/github auth status [--probe false]',
    '/github repo inspect [--slug owner/repo] [--api false]',
    '/github issues list [--slug owner/repo] [--state open|closed|all] [--limit N] [--labels a,b] [--api false]',
    '/github issues inspect <number> [--slug owner/repo] [--api false]',
    '/github pr list [--slug owner/repo] [--state open|closed|all] [--limit N] [--base branch] [--head branch] [--api false]',
    '/github pr inspect <number> [--slug owner/repo] [--api false]',
    '/github pr diff <number> [--slug owner/repo] [--limit N] [--api false]',
    '/github workflow runs [--slug owner/repo] [--workflow id|file] [--branch name] [--status value] [--event name] [--limit N] [--api false]',
    '/github workflow inspect <run-id> [--slug owner/repo] [--api false]',
    '/github releases list [--slug owner/repo] [--limit N] [--api false]',
    '/github releases inspect <latest|tag|id> [--slug owner/repo] [--api false]',
    '',
    'Notes:',
    '- Uses the same typed read-only GitHub adapters as `liku github ...`.',
    '- Slash-command responses are chat-friendly summaries; structured adapter reports are attached in the result `data` field.',
  ].join('\n');
}

function formatAuthStatus(report) {
  const lines = [
    'GitHub auth status',
    `Feature flag: ${report.featureFlagEnabled ? 'enabled' : 'not explicitly enabled (explicit read-only command still allowed)'}`,
    `Copilot auth: ${report.copilot.authenticated ? 'available' : 'not available'}`,
    `Provider/model: ${report.copilot.provider || 'unknown'} / ${report.copilot.modelName || report.copilot.model || 'unknown'}`,
    `GitHub API token: ${report.githubApi.tokenPresent ? `present via ${report.githubApi.tokenSource}${report.githubApi.tokenPreview ? ` (${report.githubApi.tokenPreview})` : ''}` : 'not detected'}`,
  ];

  if (report.githubApi.probeAttempted) {
    lines.push(`GitHub API probe: ${report.githubApi.authenticated ? 'authenticated' : 'failed'}${report.githubApi.status ? ` (status ${report.githubApi.status})` : ''}`);
    if (report.githubApi.viewer?.login) {
      lines.push(`GitHub viewer: ${report.githubApi.viewer.login}`);
    }
    if (Array.isArray(report.githubApi.scopes) && report.githubApi.scopes.length > 0) {
      lines.push(`GitHub scopes: ${report.githubApi.scopes.join(', ')}`);
    }
  } else {
    lines.push('GitHub API probe: skipped');
  }

  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatRepoInspect(report) {
  const lines = [
    'GitHub repo inspect',
    `Local repo: ${report.repoIdentity.repoName}`,
    `Project root: ${report.repoIdentity.projectRoot}`,
    `Git remote: ${report.repoIdentity.gitRemote || 'not detected'}`,
  ];

  if (report.target?.slug) {
    lines.push(`GitHub slug: ${report.target.slug}`);
  }

  if (report.githubApi.repository) {
    const repo = report.githubApi.repository;
    lines.push(
      `GitHub repository: ${repo.fullName || repo.name}`,
      `Visibility/default branch: ${repo.visibility || (repo.private ? 'private' : 'public')} / ${repo.defaultBranch || 'unknown'}`,
      `Language: ${repo.language || 'unknown'}`,
      `Issues: ${repo.openIssuesCount ?? 'unknown'}`,
      `Stars/Forks: ${(repo.stars ?? '?')}/${(repo.forks ?? '?')}`
    );
  } else if (report.githubApi.attempted) {
    lines.push(`GitHub repository: unavailable (${report.githubApi.error || 'unknown error'})`);
  } else {
    lines.push('GitHub repository: API inspection skipped');
  }

  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatIssuesList(report) {
  const lines = [
    'GitHub issues list',
    `Target: ${report.target?.slug || report.repoIdentity.repoName}`,
    `Filters: state=${report.filters.state} limit=${report.filters.limit}${report.filters.labels.length ? ` labels=${report.filters.labels.join(',')}` : ''}`,
  ];

  if (Array.isArray(report.issues) && report.issues.length > 0) {
    lines.push(...report.issues.map((issue) => `- #${issue.number} ${issue.state || 'unknown'} ${truncate(issue.title, 88)} — ${issue.author?.login || '-'} — ${compactTimestamp(issue.updatedAt)}`));
  } else if (report.githubApi.attempted && !report.githubApi.error) {
    lines.push('No issues matched the requested filters.');
  } else if (report.githubApi.attempted) {
    lines.push(`GitHub issues: unavailable (${report.githubApi.error || 'unknown error'})`);
  } else {
    lines.push('GitHub issues: API inspection skipped');
  }

  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatIssueInspect(report) {
  const lines = [
    'GitHub issue inspect',
    `Target: ${report.target?.slug || report.repoIdentity.repoName}`,
  ];

  if (!report.issue) {
    lines.push(report.githubApi.attempted
      ? `GitHub issue: unavailable (${report.githubApi.error || 'unknown error'})`
      : 'GitHub issue: API inspection skipped');
    return [...lines, ...formatWarnings(report.warnings)].join('\n');
  }

  const issue = report.issue;
  lines.push(
    `Issue: #${issue.number} ${issue.title}`,
    `State: ${issue.state || 'unknown'}${issue.stateReason ? ` (${issue.stateReason})` : ''}`,
    `Author: ${issue.author?.login || 'unknown'}`,
    `Comments: ${issue.comments ?? 0}`,
    `Updated: ${compactTimestamp(issue.updatedAt)}`
  );
  if (issue.milestone?.title) {
    lines.push(`Milestone: ${issue.milestone.title}`);
  }
  if (Array.isArray(issue.labels) && issue.labels.length > 0) {
    lines.push(`Labels: ${issue.labels.map((label) => label.name).filter(Boolean).join(', ')}`);
  }
  if (issue.htmlUrl) {
    lines.push(`URL: ${issue.htmlUrl}`);
  }

  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatPullRequestList(report) {
  const lines = [
    'GitHub pull request list',
    `Target: ${report.target?.slug || report.repoIdentity.repoName}`,
    `Filters: state=${report.filters.state} limit=${report.filters.limit}${report.filters.base ? ` base=${report.filters.base}` : ''}${report.filters.head ? ` head=${report.filters.head}` : ''}`,
  ];

  if (Array.isArray(report.pullRequests) && report.pullRequests.length > 0) {
    lines.push(...report.pullRequests.map((pullRequest) => `- #${pullRequest.number} ${pullRequest.state || 'unknown'} ${truncate(pullRequest.title, 88)} — ${pullRequest.author?.login || '-'} — ${compactTimestamp(pullRequest.updatedAt)}`));
  } else if (report.githubApi.attempted && !report.githubApi.error) {
    lines.push('No pull requests matched the requested filters.');
  } else if (report.githubApi.attempted) {
    lines.push(`GitHub pull requests: unavailable (${report.githubApi.error || 'unknown error'})`);
  } else {
    lines.push('GitHub pull requests: API inspection skipped');
  }

  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatPullRequestInspect(report) {
  const lines = [
    'GitHub pull request inspect',
    `Target: ${report.target?.slug || report.repoIdentity.repoName}`,
  ];

  if (!report.pullRequest) {
    lines.push(report.githubApi.attempted
      ? `GitHub PR: unavailable (${report.githubApi.error || 'unknown error'})`
      : 'GitHub PR: API inspection skipped');
    return [...lines, ...formatWarnings(report.warnings)].join('\n');
  }

  const pr = report.pullRequest;
  lines.push(
    `PR: #${pr.number} ${pr.title}`,
    `State: ${pr.state}${pr.draft ? ' draft' : ''}${pr.merged ? ' merged' : ''}`,
    `Author: ${pr.author?.login || 'unknown'}`,
    `Branches: ${pr.head?.ref || '?'} -> ${pr.base?.ref || '?'}`,
    `Changes: +${pr.additions ?? '?'} / -${pr.deletions ?? '?'} across ${pr.changedFiles ?? '?'} files (${pr.commits ?? '?'} commits)`,
    `Comments: issue=${pr.comments ?? 0} review=${pr.reviewComments ?? 0}`,
    `Mergeability: ${pr.mergeable === null ? 'unknown' : (pr.mergeable ? 'mergeable' : 'not mergeable')}${pr.mergeableState ? ` (${pr.mergeableState})` : ''}`
  );
  if (Array.isArray(pr.labels) && pr.labels.length > 0) {
    lines.push(`Labels: ${pr.labels.map((label) => label.name).filter(Boolean).join(', ')}`);
  }
  if (pr.htmlUrl) {
    lines.push(`URL: ${pr.htmlUrl}`);
  }

  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatPullRequestDiff(report) {
  const lines = [
    'GitHub pull request diff summary',
    `Target: ${report.target?.slug || report.repoIdentity.repoName}`,
    `PR: #${report.pullRequestNumber}`,
    `Files/Additions/Deletions: ${report.diffSummary.fileCount}/${report.diffSummary.totalAdditions}/${report.diffSummary.totalDeletions}`,
  ];

  if (Array.isArray(report.files) && report.files.length > 0) {
    lines.push(...report.files.map((file) => `- ${truncate(file.filename, 88)} (${file.status || '-'}) +${file.additions ?? '?'} -${file.deletions ?? '?'}`));
  } else if (report.githubApi.attempted && !report.githubApi.error) {
    lines.push('No changed files were reported for this pull request.');
  } else if (report.githubApi.attempted) {
    lines.push(`GitHub PR diff: unavailable (${report.githubApi.error || 'unknown error'})`);
  } else {
    lines.push('GitHub PR diff: API inspection skipped');
  }

  if (Array.isArray(report.diffSummary.directories) && report.diffSummary.directories.length > 0) {
    lines.push(`Top directories: ${report.diffSummary.directories.map((entry) => `${entry.path} (${entry.count})`).join(', ')}`);
  }

  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatWorkflowRuns(report) {
  const lines = [
    'GitHub workflow runs',
    `Target: ${report.target?.slug || report.repoIdentity.repoName}`,
    `Filters: limit=${report.filters.limit}${report.filters.workflow ? ` workflow=${report.filters.workflow}` : ''}${report.filters.branch ? ` branch=${report.filters.branch}` : ''}${report.filters.status ? ` status=${report.filters.status}` : ''}${report.filters.event ? ` event=${report.filters.event}` : ''}`,
  ];

  if (Array.isArray(report.workflowRuns) && report.workflowRuns.length > 0) {
    lines.push(...report.workflowRuns.map((run) => `- ${run.runNumber ? `#${run.runNumber}` : String(run.id || '?')} ${truncate(run.name || run.displayTitle || 'workflow', 72)} — ${[run.status, run.conclusion].filter(Boolean).join('/') || 'unknown'} — ${run.branch || '-'} — ${compactTimestamp(run.updatedAt)}`));
  } else if (report.githubApi.attempted && !report.githubApi.error) {
    lines.push('No workflow runs matched the requested filters.');
  } else if (report.githubApi.attempted) {
    lines.push(`Workflow runs: unavailable (${report.githubApi.error || 'unknown error'})`);
  } else {
    lines.push('Workflow runs: API inspection skipped');
  }

  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatWorkflowInspect(report) {
  const lines = [
    'GitHub workflow inspect',
    `Target: ${report.target?.slug || report.repoIdentity.repoName}`,
  ];

  if (!report.workflowRun) {
    lines.push(report.githubApi.attempted
      ? `Workflow run: unavailable (${report.githubApi.error || 'unknown error'})`
      : 'Workflow run: API inspection skipped');
    return [...lines, ...formatWarnings(report.warnings)].join('\n');
  }

  const run = report.workflowRun;
  lines.push(
    `Run: ${run.runNumber ? `#${run.runNumber}` : report.runId} ${run.name || run.displayTitle || 'workflow'}`,
    `Status: ${[run.status, run.conclusion].filter(Boolean).join('/') || 'unknown'}`,
    `Workflow ID: ${run.workflowId ?? 'unknown'}`,
    `Branch/SHA: ${run.branch || '?'} / ${truncate(run.sha || '?', 16)}`,
    `Event: ${run.event || 'unknown'}`,
    `Actor: ${run.actor?.login || run.triggeringActor?.login || 'unknown'}`,
    `Updated: ${compactTimestamp(run.updatedAt)}`
  );
  if (run.headCommit?.message) {
    lines.push(`Head commit: ${truncate(run.headCommit.message, 96)}`);
  }
  if (run.htmlUrl) {
    lines.push(`URL: ${run.htmlUrl}`);
  }

  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatReleasesList(report) {
  const lines = [
    'GitHub releases list',
    `Target: ${report.target?.slug || report.repoIdentity.repoName}`,
    `Filters: limit=${report.filters.limit}`,
  ];

  if (Array.isArray(report.releases) && report.releases.length > 0) {
    lines.push(...report.releases.map((release) => `- ${release.tagName || '-'} ${release.draft ? 'draft' : (release.prerelease ? 'prerelease' : 'release')} ${truncate(release.name || release.tagName || 'release', 72)} — ${compactTimestamp(release.publishedAt || release.createdAt)}`));
  } else if (report.githubApi.attempted && !report.githubApi.error) {
    lines.push('No releases were reported for the requested repository.');
  } else if (report.githubApi.attempted) {
    lines.push(`GitHub releases: unavailable (${report.githubApi.error || 'unknown error'})`);
  } else {
    lines.push('GitHub releases: API inspection skipped');
  }

  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatReleaseInspect(report) {
  const lines = [
    'GitHub release inspect',
    `Target: ${report.target?.slug || report.repoIdentity.repoName}`,
  ];

  if (!report.release) {
    lines.push(report.githubApi.attempted
      ? `GitHub release: unavailable (${report.githubApi.error || 'unknown error'})`
      : 'GitHub release: API inspection skipped');
    return [...lines, ...formatWarnings(report.warnings)].join('\n');
  }

  const release = report.release;
  lines.push(
    `Release: ${release.name || release.tagName || 'unnamed release'}`,
    `Tag: ${release.tagName || 'unknown'}`,
    `State: ${release.draft ? 'draft' : (release.prerelease ? 'prerelease' : 'release')}`,
    `Target commitish: ${release.targetCommitish || 'unknown'}`,
    `Assets: ${release.assetCount ?? 0}`,
    `Published: ${compactTimestamp(release.publishedAt || release.createdAt)}`
  );
  if (release.author?.login) {
    lines.push(`Author: ${release.author.login}`);
  }
  if (release.htmlUrl) {
    lines.push(`URL: ${release.htmlUrl}`);
  }

  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function createGitHubSlashCommandHandler(dependencies = {}) {
  const tokenizeImpl = typeof dependencies.tokenize === 'function' ? dependencies.tokenize : tokenize;
  const parseLongOptionsImpl = typeof dependencies.parseLongOptions === 'function' ? dependencies.parseLongOptions : parseLongOptions;
  const env = dependencies.env || process.env;
  const getCwd = typeof dependencies.getCwd === 'function'
    ? dependencies.getCwd
    : () => String(dependencies.cwd || process.cwd());
  const aiService = dependencies.aiService || null;

  const adapters = {
    inspectGitHubIssue: dependencies.inspectGitHubIssue || inspectGitHubIssue,
    inspectGitHubPullRequest: dependencies.inspectGitHubPullRequest || inspectGitHubPullRequest,
    inspectGitHubPullRequestDiff: dependencies.inspectGitHubPullRequestDiff || inspectGitHubPullRequestDiff,
    inspectGitHubRelease: dependencies.inspectGitHubRelease || inspectGitHubRelease,
    inspectGitHubRepository: dependencies.inspectGitHubRepository || inspectGitHubRepository,
    inspectGitHubWorkflowRun: dependencies.inspectGitHubWorkflowRun || inspectGitHubWorkflowRun,
    listGitHubIssues: dependencies.listGitHubIssues || listGitHubIssues,
    listGitHubPullRequests: dependencies.listGitHubPullRequests || listGitHubPullRequests,
    listGitHubReleases: dependencies.listGitHubReleases || listGitHubReleases,
    listGitHubWorkflowRuns: dependencies.listGitHubWorkflowRuns || listGitHubWorkflowRuns,
    resolveGitHubAuthStatus: dependencies.resolveGitHubAuthStatus || resolveGitHubAuthStatus,
  };

  const helpText = formatHelp();

  async function executeSlashCommand(command) {
    const parts = tokenizeImpl(String(command || '').trim());
    if ((parts[0] || '').toLowerCase() !== '/github') {
      return null;
    }

    const { positionals, options } = parseLongOptionsImpl(parts.slice(1));
    const area = normalizeArea(positionals[0]);
    const action = String(positionals[1] || '').trim().toLowerCase();
    const featureFlagEnabled = isFeatureFlagEnabled(env);
    const cwd = getCwd();

    if (!area || area === 'help' || action === 'help') {
      return { type: 'info', message: helpText };
    }

    if (area === 'auth' && action === 'status') {
      const report = await adapters.resolveGitHubAuthStatus({
        aiService,
        env,
        featureFlagEnabled,
        probe: parseBooleanOption(options.probe, true),
      });
      return buildResult(report, formatAuthStatus(report));
    }

    if (area === 'repo' && action === 'inspect') {
      const report = await adapters.inspectGitHubRepository({
        cwd,
        env,
        featureFlagEnabled,
        api: parseBooleanOption(options.api, true),
        slug: options.slug,
      });
      return buildResult(report, formatRepoInspect(report));
    }

    if (area === 'issues' && action === 'list') {
      const report = await adapters.listGitHubIssues({
        cwd,
        env,
        featureFlagEnabled,
        api: parseBooleanOption(options.api, true),
        slug: options.slug,
        state: options.state,
        limit: options.limit,
        labels: options.labels,
      });
      return buildResult(report, formatIssuesList(report));
    }

    if (area === 'issues' && action === 'inspect') {
      const report = await adapters.inspectGitHubIssue({
        cwd,
        env,
        featureFlagEnabled,
        api: parseBooleanOption(options.api, true),
        slug: options.slug,
        number: positionals[2],
      });
      if (report.success === false) {
        return buildUsageResult(report.message, helpText);
      }
      return buildResult(report, formatIssueInspect(report));
    }

    if (area === 'pr' && action === 'list') {
      const report = await adapters.listGitHubPullRequests({
        cwd,
        env,
        featureFlagEnabled,
        api: parseBooleanOption(options.api, true),
        slug: options.slug,
        state: options.state,
        limit: options.limit,
        base: options.base,
        head: options.head,
      });
      return buildResult(report, formatPullRequestList(report));
    }

    if (area === 'pr' && action === 'inspect') {
      const report = await adapters.inspectGitHubPullRequest({
        cwd,
        env,
        featureFlagEnabled,
        api: parseBooleanOption(options.api, true),
        slug: options.slug,
        number: positionals[2],
      });
      if (report.success === false) {
        return buildUsageResult(report.message, helpText);
      }
      return buildResult(report, formatPullRequestInspect(report));
    }

    if (area === 'pr' && action === 'diff') {
      const report = await adapters.inspectGitHubPullRequestDiff({
        cwd,
        env,
        featureFlagEnabled,
        api: parseBooleanOption(options.api, true),
        slug: options.slug,
        number: positionals[2],
        limit: options.limit,
      });
      if (report.success === false) {
        return buildUsageResult(report.message, helpText);
      }
      return buildResult(report, formatPullRequestDiff(report));
    }

    if (area === 'workflow' && action === 'runs') {
      const report = await adapters.listGitHubWorkflowRuns({
        cwd,
        env,
        featureFlagEnabled,
        api: parseBooleanOption(options.api, true),
        slug: options.slug,
        workflow: options.workflow,
        branch: options.branch,
        status: options.status,
        event: options.event,
        limit: options.limit,
      });
      return buildResult(report, formatWorkflowRuns(report));
    }

    if (area === 'workflow' && action === 'inspect') {
      const report = await adapters.inspectGitHubWorkflowRun({
        cwd,
        env,
        featureFlagEnabled,
        api: parseBooleanOption(options.api, true),
        slug: options.slug,
        runId: positionals[2],
      });
      if (report.success === false) {
        return buildUsageResult(report.message, helpText);
      }
      return buildResult(report, formatWorkflowInspect(report));
    }

    if (area === 'releases' && action === 'list') {
      const report = await adapters.listGitHubReleases({
        cwd,
        env,
        featureFlagEnabled,
        api: parseBooleanOption(options.api, true),
        slug: options.slug,
        limit: options.limit,
      });
      return buildResult(report, formatReleasesList(report));
    }

    if (area === 'releases' && action === 'inspect') {
      const report = await adapters.inspectGitHubRelease({
        cwd,
        env,
        featureFlagEnabled,
        api: parseBooleanOption(options.api, true),
        slug: options.slug,
        selector: positionals[2],
      });
      if (report.success === false) {
        return buildUsageResult(report.message, helpText);
      }
      return buildResult(report, formatReleaseInspect(report));
    }

    return buildUsageResult(`Unknown GitHub slash command: ${[area, action].filter(Boolean).join(' ') || '/github'}`, helpText);
  }

  return {
    executeSlashCommand,
    formatHelp,
  };
}

module.exports = {
  createGitHubSlashCommandHandler,
};
