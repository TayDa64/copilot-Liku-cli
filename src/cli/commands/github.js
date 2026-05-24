const { bold, dim, highlight, table, warn } = require('../util/output');
const { parseBooleanEnvFlag } = require('../feature-flags');
const { resolveGitHubAuthStatus } = require('../../main/github/auth-status');
const { inspectGitHubRepository } = require('../../main/github/repo-inspect');
const { inspectGitHubIssue } = require('../../main/github/issue-inspect');
const { listGitHubIssues } = require('../../main/github/issues-list');
const { inspectGitHubPullRequestDiff } = require('../../main/github/pr-diff-summary');
const { listGitHubPullRequests } = require('../../main/github/pr-list');
const { inspectGitHubPullRequest } = require('../../main/github/pr-inspect');
const { inspectGitHubRelease } = require('../../main/github/release-inspect');
const { listGitHubReleases } = require('../../main/github/releases-list');
const { inspectGitHubWorkflowRun } = require('../../main/github/workflow-inspect');
const { listGitHubWorkflowRuns } = require('../../main/github/workflow-runs');

function truncate(text, maxLength = 56) {
  const value = String(text || '').trim();
  if (!value) return '';
  if (value.length <= maxLength) return value;
  if (maxLength <= 1) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 1)}…`;
}

function relativeIsoTimestamp(value) {
  const timestamp = String(value || '').trim();
  if (!timestamp) return 'unknown';
  return timestamp.replace('T', ' ').replace(/:\d\d\.\d{3}Z$/, 'Z').replace(/:\d\dZ$/, 'Z');
}

function normalizeArea(area) {
  const value = String(area || '').trim().toLowerCase();
  if (value === 'issue') return 'issues';
  if (value === 'workflows') return 'workflow';
  if (value === 'release') return 'releases';
  return value;
}

function showHelp() {
  console.log(`
${bold('liku github')} — Read-only GitHub diagnostics and repository inspection

${highlight('USAGE:')}
  liku github auth status
  liku github repo inspect
  liku github issues list
  liku github issues inspect <number>
  liku github pr list
  liku github pr inspect <number>
  liku github pr diff <number>
  liku github workflow runs
  liku github workflow inspect <run-id>
  liku github releases list
  liku github releases inspect <latest|tag|id>
  liku github auth status --probe false --json
  liku github repo inspect --api false --json
  liku github issues list --state all --limit 20
  liku github issues inspect 321 --slug owner/repo
  liku github pr list --state all --limit 20
  liku github pr inspect 123 --slug owner/repo
  liku github pr diff 123 --limit 50
  liku github workflow runs --workflow ci.yml --limit 10
  liku github workflow inspect 9001 --slug owner/repo
  liku github releases list --limit 5 --slug owner/repo
  liku github releases inspect latest --slug owner/repo

${highlight('COMMANDS:')}
  auth status    Inspect Copilot/GitHub auth state without mutating anything
  repo inspect   Inspect the current repository identity and GitHub metadata
  issues list    List issues for the current or specified GitHub repo
  issues inspect Inspect one issue by number
  pr list        List pull requests for the current or specified GitHub repo
  pr inspect     Inspect one pull request by number
  pr diff        Summarize changed files for one pull request
  workflow runs  List workflow runs for the current or specified repo
  workflow inspect Inspect one workflow run by id
  releases list  List releases for the current or specified repo
  releases inspect Inspect one release by latest, tag, or numeric id

${highlight('OPTIONS:')}
  --json         Output machine-readable JSON
  --probe <bool> Enable or disable the live GitHub /user probe for auth status (default: true)
  --api <bool>   Enable or disable GitHub API lookup for repo inspect (default: true)
  --slug <owner/repo> Target a specific GitHub repository instead of the detected git remote
  --state <open|closed|all> Filter issue lists (default: open)
  --limit <n>    Bound issue/PR/workflow/release results (default: 10)
  --labels <csv> Filter issue lists by label names
  --base <name>  Filter pull-request lists to one base branch
  --head <name>  Filter pull-request lists to one head branch
  --workflow <id|file> Filter workflow runs to one workflow id or file name
  --branch <name> Filter workflow runs to one branch
  --status <value> Filter workflow runs by status/conclusion-compatible value
  --event <name> Filter workflow runs by triggering event

${highlight('NOTES:')}
  - These Phase 2 commands are read-only.
  - GH_TOKEN or GITHUB_TOKEN improves private-repo and authenticated REST inspection.
  - Existing Copilot auth state is reused when available, but GitHub REST prefers GH_TOKEN/GITHUB_TOKEN.
`);
}

function isGitHubFeatureFlagEnabled(options) {
  return options?.featureFlags?.enableGitHub === true;
}

function printWarnings(warnings = []) {
  if (!Array.isArray(warnings) || warnings.length === 0) {
    return;
  }
  console.log(`\n${highlight('Warnings:')}`);
  warnings.forEach((entry) => warn(entry));
}

function printUsageFailure(report) {
  if (!report?.message) {
    return;
  }
  warn(report.message);
}

function printAuthStatus(report) {
  console.log(`\n${bold('GitHub auth status')}\n`);
  console.log(`${highlight('Feature flag:')} ${report.featureFlagEnabled ? 'enabled' : dim('not explicitly enabled (explicit read-only command still allowed)')}`);
  console.log(`${highlight('Copilot auth:')} ${report.copilot.authenticated ? 'available' : 'not available'}`);
  console.log(`${highlight('Provider/model:')} ${report.copilot.provider || 'unknown'} / ${report.copilot.modelName || report.copilot.model || 'unknown'}`);

  if (report.copilot.tokenFile?.exists) {
    const savedAt = report.copilot.tokenFile.savedAt ? ` ${dim(`(saved ${report.copilot.tokenFile.savedAt})`)}` : '';
    console.log(`${highlight('Copilot token file:')} ${report.copilot.tokenFile.path}${savedAt}`);
  } else {
    console.log(`${highlight('Copilot token file:')} not found`);
  }

  const apiTokenLine = report.githubApi.tokenPresent
    ? `present via ${report.githubApi.tokenSource}${report.githubApi.tokenPreview ? ` ${dim(`(${report.githubApi.tokenPreview})`)}` : ''}`
    : 'not detected';
  console.log(`${highlight('GitHub API token:')} ${apiTokenLine}`);

  if (report.githubApi.probeAttempted) {
    console.log(`${highlight('GitHub API probe:')} ${report.githubApi.authenticated ? 'authenticated' : 'failed'}${report.githubApi.status ? ` ${dim(`(status ${report.githubApi.status})`)}` : ''}`);
    if (report.githubApi.viewer?.login) {
      console.log(`${highlight('GitHub viewer:')} ${report.githubApi.viewer.login}`);
    }
    if (Array.isArray(report.githubApi.scopes) && report.githubApi.scopes.length > 0) {
      console.log(`${highlight('GitHub scopes:')} ${report.githubApi.scopes.join(', ')}`);
    }
  } else {
    console.log(`${highlight('GitHub API probe:')} skipped`);
  }

  printWarnings(report.warnings);
}

function printRepoInspect(report) {
  console.log(`\n${bold('GitHub repo inspect')}\n`);
  console.log(`${highlight('Feature flag:')} ${report.featureFlagEnabled ? 'enabled' : dim('not explicitly enabled (explicit read-only command still allowed)')}`);
  console.log(`${highlight('Local repo:')} ${report.repoIdentity.repoName}`);
  console.log(`${highlight('Project root:')} ${report.repoIdentity.projectRoot}`);
  console.log(`${highlight('Git remote:')} ${report.repoIdentity.gitRemote || dim('not detected')}`);

  if (report.target?.slug) {
    console.log(`${highlight('GitHub slug:')} ${report.target.slug}`);
  }
  if (report.target?.htmlUrl) {
    console.log(`${highlight('GitHub URL:')} ${report.target.htmlUrl}`);
  }

  if (report.githubApi.repository) {
    const repo = report.githubApi.repository;
    console.log(`\n${highlight('GitHub repository:')}`);
    console.log(`  ${highlight('Full name:')} ${repo.fullName || repo.name}`);
    console.log(`  ${highlight('Visibility:')} ${repo.visibility || (repo.private ? 'private' : 'public')}`);
    console.log(`  ${highlight('Default branch:')} ${repo.defaultBranch || dim('unknown')}`);
    console.log(`  ${highlight('Language:')} ${repo.language || dim('unknown')}`);
    console.log(`  ${highlight('Issues:')} ${repo.openIssuesCount ?? dim('unknown')}`);
    console.log(`  ${highlight('Stars/Forks:')} ${(repo.stars ?? '?')}/${(repo.forks ?? '?')}`);
    if (repo.permissions) {
      const permissionSummary = Object.entries(repo.permissions)
        .filter(([, enabled]) => enabled === true)
        .map(([key]) => key)
        .join(', ');
      console.log(`  ${highlight('Viewer permissions:')} ${permissionSummary || dim('none reported')}`);
    }
  } else if (report.githubApi.attempted) {
    console.log(`\n${highlight('GitHub repository:')} unavailable ${dim(report.githubApi.error || 'unknown error')}`);
  } else {
    console.log(`\n${highlight('GitHub repository:')} ${dim('API inspection skipped')}`);
  }

  printWarnings(report.warnings);
}

function printIssuesList(report) {
  console.log(`\n${bold('GitHub issues list')}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity.repoName}`);
  console.log(`${highlight('Filters:')} state=${report.filters.state} limit=${report.filters.limit}${report.filters.labels.length ? ` labels=${report.filters.labels.join(',')}` : ''}`);

  if (Array.isArray(report.issues) && report.issues.length > 0) {
    table(
      report.issues.map((issue) => [
        `#${issue.number}`,
        issue.state || 'unknown',
        truncate(issue.title, 64),
        issue.author?.login || '-',
        relativeIsoTimestamp(issue.updatedAt),
      ]),
      ['Issue', 'State', 'Title', 'Author', 'Updated']
    );
  } else if (report.githubApi.attempted && !report.githubApi.error) {
    console.log(dim('No issues matched the requested filters.'));
  } else if (report.githubApi.attempted) {
    console.log(`${highlight('GitHub issues:')} unavailable ${dim(report.githubApi.error || 'unknown error')}`);
  } else {
    console.log(`${highlight('GitHub issues:')} ${dim('API inspection skipped')}`);
  }

  printWarnings(report.warnings);
}

function printIssueInspect(report) {
  console.log(`\n${bold('GitHub issue inspect')}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity.repoName}`);

  if (!report.issue) {
    if (report.githubApi.attempted) {
      console.log(`${highlight('GitHub issue:')} unavailable ${dim(report.githubApi.error || 'unknown error')}`);
    } else {
      console.log(`${highlight('GitHub issue:')} ${dim('API inspection skipped')}`);
    }
    printWarnings(report.warnings);
    return;
  }

  const issue = report.issue;
  console.log(`${highlight('Issue:')} #${issue.number} ${issue.title}`);
  console.log(`${highlight('State:')} ${issue.state || 'unknown'}${issue.stateReason ? ` ${dim(`(${issue.stateReason})`)}` : ''}`);
  console.log(`${highlight('Author:')} ${issue.author?.login || 'unknown'}`);
  console.log(`${highlight('Comments:')} ${issue.comments ?? 0}`);
  console.log(`${highlight('Updated:')} ${relativeIsoTimestamp(issue.updatedAt)}`);
  if (issue.milestone?.title) {
    console.log(`${highlight('Milestone:')} ${issue.milestone.title}`);
  }
  if (Array.isArray(issue.labels) && issue.labels.length > 0) {
    console.log(`${highlight('Labels:')} ${issue.labels.map((label) => label.name).filter(Boolean).join(', ')}`);
  }
  if (issue.htmlUrl) {
    console.log(`${highlight('URL:')} ${issue.htmlUrl}`);
  }

  printWarnings(report.warnings);
}

function printPullRequestInspect(report) {
  console.log(`\n${bold('GitHub pull request inspect')}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity.repoName}`);

  if (!report.pullRequest) {
    if (report.githubApi.attempted) {
      console.log(`${highlight('GitHub PR:')} unavailable ${dim(report.githubApi.error || 'unknown error')}`);
    } else {
      console.log(`${highlight('GitHub PR:')} ${dim('API inspection skipped')}`);
    }
    printWarnings(report.warnings);
    return;
  }

  const pr = report.pullRequest;
  console.log(`${highlight('PR:')} #${pr.number} ${pr.title}`);
  console.log(`${highlight('State:')} ${pr.state}${pr.draft ? ' draft' : ''}${pr.merged ? ' merged' : ''}`);
  console.log(`${highlight('Author:')} ${pr.author?.login || 'unknown'}`);
  console.log(`${highlight('Branches:')} ${pr.head?.ref || '?'} -> ${pr.base?.ref || '?'}`);
  console.log(`${highlight('Changes:')} +${pr.additions ?? '?'} / -${pr.deletions ?? '?'} across ${pr.changedFiles ?? '?'} files (${pr.commits ?? '?'} commits)`);
  console.log(`${highlight('Comments:')} issue=${pr.comments ?? 0} review=${pr.reviewComments ?? 0}`);
  console.log(`${highlight('Mergeability:')} ${pr.mergeable === null ? 'unknown' : (pr.mergeable ? 'mergeable' : 'not mergeable')}${pr.mergeableState ? ` ${dim(`(${pr.mergeableState})`)}` : ''}`);
  if (Array.isArray(pr.labels) && pr.labels.length > 0) {
    console.log(`${highlight('Labels:')} ${pr.labels.map((label) => label.name).filter(Boolean).join(', ')}`);
  }
  if (pr.htmlUrl) {
    console.log(`${highlight('URL:')} ${pr.htmlUrl}`);
  }

  printWarnings(report.warnings);
}

function printPullRequestDiffSummary(report) {
  console.log(`\n${bold('GitHub pull request diff summary')}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity.repoName}`);
  console.log(`${highlight('PR:')} #${report.pullRequestNumber}`);
  console.log(`${highlight('Files/Additions/Deletions:')} ${report.diffSummary.fileCount}/${report.diffSummary.totalAdditions}/${report.diffSummary.totalDeletions}`);

  if (Array.isArray(report.files) && report.files.length > 0) {
    table(
      report.files.map((file) => [
        truncate(file.filename, 56),
        file.status || '-',
        String(file.additions ?? '?'),
        String(file.deletions ?? '?'),
      ]),
      ['File', 'Status', '+', '-']
    );
  } else if (report.githubApi.attempted && !report.githubApi.error) {
    console.log(dim('No changed files were reported for this pull request.'));
  } else if (report.githubApi.attempted) {
    console.log(`${highlight('GitHub PR diff:')} unavailable ${dim(report.githubApi.error || 'unknown error')}`);
  } else {
    console.log(`${highlight('GitHub PR diff:')} ${dim('API inspection skipped')}`);
  }

  if (Array.isArray(report.diffSummary.directories) && report.diffSummary.directories.length > 0) {
    console.log(`${highlight('Top directories:')} ${report.diffSummary.directories.map((entry) => `${entry.path} (${entry.count})`).join(', ')}`);
  }

  printWarnings(report.warnings);
}

function printPullRequestList(report) {
  console.log(`\n${bold('GitHub pull request list')}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity.repoName}`);
  const filterBits = [
    `state=${report.filters.state}`,
    `limit=${report.filters.limit}`,
    report.filters.base ? `base=${report.filters.base}` : null,
    report.filters.head ? `head=${report.filters.head}` : null,
  ].filter(Boolean);
  console.log(`${highlight('Filters:')} ${filterBits.join(' ')}`);

  if (Array.isArray(report.pullRequests) && report.pullRequests.length > 0) {
    table(
      report.pullRequests.map((pr) => [
        `#${pr.number}`,
        pr.state || 'unknown',
        truncate(pr.title, 60),
        pr.author?.login || '-',
        relativeIsoTimestamp(pr.updatedAt),
      ]),
      ['PR', 'State', 'Title', 'Author', 'Updated']
    );
  } else if (report.githubApi.attempted && !report.githubApi.error) {
    console.log(dim('No pull requests matched the requested filters.'));
  } else if (report.githubApi.attempted) {
    console.log(`${highlight('GitHub PRs:')} unavailable ${dim(report.githubApi.error || 'unknown error')}`);
  } else {
    console.log(`${highlight('GitHub PRs:')} ${dim('API inspection skipped')}`);
  }

  printWarnings(report.warnings);
}

function printWorkflowRuns(report) {
  console.log(`\n${bold('GitHub workflow runs')}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity.repoName}`);
  const filterBits = [
    `limit=${report.filters.limit}`,
    report.filters.workflow ? `workflow=${report.filters.workflow}` : null,
    report.filters.branch ? `branch=${report.filters.branch}` : null,
    report.filters.status ? `status=${report.filters.status}` : null,
    report.filters.event ? `event=${report.filters.event}` : null,
  ].filter(Boolean);
  console.log(`${highlight('Filters:')} ${filterBits.join(' ')}`);

  if (Array.isArray(report.workflowRuns) && report.workflowRuns.length > 0) {
    table(
      report.workflowRuns.map((run) => [
        run.runNumber ? `#${run.runNumber}` : String(run.id || '?'),
        truncate(run.name || run.displayTitle || 'workflow', 40),
        [run.status, run.conclusion].filter(Boolean).join('/') || 'unknown',
        run.branch || '-',
        relativeIsoTimestamp(run.updatedAt),
      ]),
      ['Run', 'Workflow', 'Status', 'Branch', 'Updated']
    );
  } else if (report.githubApi.attempted && !report.githubApi.error) {
    console.log(dim('No workflow runs matched the requested filters.'));
  } else if (report.githubApi.attempted) {
    console.log(`${highlight('Workflow runs:')} unavailable ${dim(report.githubApi.error || 'unknown error')}`);
  } else {
    console.log(`${highlight('Workflow runs:')} ${dim('API inspection skipped')}`);
  }

  printWarnings(report.warnings);
}

function printWorkflowInspect(report) {
  console.log(`\n${bold('GitHub workflow inspect')}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity.repoName}`);

  if (!report.workflowRun) {
    if (report.githubApi.attempted) {
      console.log(`${highlight('Workflow run:')} unavailable ${dim(report.githubApi.error || 'unknown error')}`);
    } else {
      console.log(`${highlight('Workflow run:')} ${dim('API inspection skipped')}`);
    }
    printWarnings(report.warnings);
    return;
  }

  const run = report.workflowRun;
  console.log(`${highlight('Run:')} ${run.runNumber ? `#${run.runNumber}` : report.runId} ${run.name || run.displayTitle || dim('unnamed workflow')}`);
  console.log(`${highlight('Status:')} ${[run.status, run.conclusion].filter(Boolean).join('/') || 'unknown'}`);
  console.log(`${highlight('Workflow ID:')} ${run.workflowId ?? 'unknown'}`);
  console.log(`${highlight('Branch/SHA:')} ${run.branch || '?'} / ${truncate(run.sha || '?', 16)}`);
  console.log(`${highlight('Event:')} ${run.event || 'unknown'}`);
  console.log(`${highlight('Actor:')} ${run.actor?.login || run.triggeringActor?.login || 'unknown'}`);
  console.log(`${highlight('Updated:')} ${relativeIsoTimestamp(run.updatedAt)}`);
  if (run.headCommit?.message) {
    console.log(`${highlight('Head commit:')} ${truncate(run.headCommit.message, 96)}`);
  }
  if (run.htmlUrl) {
    console.log(`${highlight('URL:')} ${run.htmlUrl}`);
  }

  printWarnings(report.warnings);
}

function printReleasesList(report) {
  console.log(`\n${bold('GitHub releases list')}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity.repoName}`);
  console.log(`${highlight('Filters:')} limit=${report.filters.limit}`);

  if (Array.isArray(report.releases) && report.releases.length > 0) {
    table(
      report.releases.map((release) => [
        release.tagName || '-',
        release.draft ? 'draft' : (release.prerelease ? 'prerelease' : 'release'),
        truncate(release.name || release.tagName || 'release', 48),
        relativeIsoTimestamp(release.publishedAt || release.createdAt),
      ]),
      ['Tag', 'State', 'Name', 'Published']
    );
  } else if (report.githubApi.attempted && !report.githubApi.error) {
    console.log(dim('No releases were reported for the requested repository.'));
  } else if (report.githubApi.attempted) {
    console.log(`${highlight('GitHub releases:')} unavailable ${dim(report.githubApi.error || 'unknown error')}`);
  } else {
    console.log(`${highlight('GitHub releases:')} ${dim('API inspection skipped')}`);
  }

  printWarnings(report.warnings);
}

function printReleaseInspect(report) {
  console.log(`\n${bold('GitHub release inspect')}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity.repoName}`);

  if (!report.release) {
    if (report.githubApi.attempted) {
      console.log(`${highlight('GitHub release:')} unavailable ${dim(report.githubApi.error || 'unknown error')}`);
    } else {
      console.log(`${highlight('GitHub release:')} ${dim('API inspection skipped')}`);
    }
    printWarnings(report.warnings);
    return;
  }

  const release = report.release;
  console.log(`${highlight('Release:')} ${release.name || release.tagName || 'unnamed release'}`);
  console.log(`${highlight('Tag:')} ${release.tagName || 'unknown'}`);
  console.log(`${highlight('State:')} ${release.draft ? 'draft' : (release.prerelease ? 'prerelease' : 'release')}`);
  console.log(`${highlight('Target commitish:')} ${release.targetCommitish || 'unknown'}`);
  console.log(`${highlight('Assets:')} ${release.assetCount ?? 0}`);
  console.log(`${highlight('Published:')} ${relativeIsoTimestamp(release.publishedAt || release.createdAt)}`);
  if (release.author?.login) {
    console.log(`${highlight('Author:')} ${release.author.login}`);
  }
  if (release.htmlUrl) {
    console.log(`${highlight('URL:')} ${release.htmlUrl}`);
  }

  printWarnings(report.warnings);
}

async function run(args, options) {
  const area = normalizeArea(args[0]);
  const action = String(args[1] || '').trim().toLowerCase();
  const featureFlagEnabled = isGitHubFeatureFlagEnabled(options);

  if (area === 'help' || action === 'help') {
    if (!options.quiet) {
      showHelp();
    }
    return {
      success: true,
      schemaVersion: 'github.help.v1',
    };
  }

  if (!area || !action) {
    if (!options.json && !options.quiet) {
      showHelp();
    }
    return {
      success: false,
      error: 'USAGE',
      message: 'Usage: liku github <auth|repo|issues|pr|workflow|releases> <status|inspect|list|runs>',
    };
  }

  if (area === 'auth' && action === 'status') {
    const report = await resolveGitHubAuthStatus({
      env: process.env,
      featureFlagEnabled,
      probe: parseBooleanEnvFlag(options.probe, true),
    });
    if (!options.json && !options.quiet) {
      printAuthStatus(report);
    }
    return report;
  }

  if (area === 'repo' && action === 'inspect') {
    const report = await inspectGitHubRepository({
      cwd: process.cwd(),
      env: process.env,
      featureFlagEnabled,
      api: parseBooleanEnvFlag(options.api, true),
      slug: options.slug,
    });
    if (!options.json && !options.quiet) {
      printRepoInspect(report);
    }
    return report;
  }

  if (area === 'issues' && action === 'list') {
    const report = await listGitHubIssues({
      cwd: process.cwd(),
      env: process.env,
      featureFlagEnabled,
      api: parseBooleanEnvFlag(options.api, true),
      slug: options.slug,
      state: options.state,
      limit: options.limit,
      labels: options.labels,
    });
    if (!options.json && !options.quiet) {
      printIssuesList(report);
    }
    return report;
  }

  if (area === 'issues' && action === 'inspect') {
    const report = await inspectGitHubIssue({
      cwd: process.cwd(),
      env: process.env,
      featureFlagEnabled,
      api: parseBooleanEnvFlag(options.api, true),
      slug: options.slug,
      number: args[2],
    });
    if (!options.json && !options.quiet && report.success === false) {
      printUsageFailure(report);
      showHelp();
    } else if (!options.json && !options.quiet) {
      printIssueInspect(report);
    }
    return report;
  }

  if (area === 'pr' && action === 'list') {
    const report = await listGitHubPullRequests({
      cwd: process.cwd(),
      env: process.env,
      featureFlagEnabled,
      api: parseBooleanEnvFlag(options.api, true),
      slug: options.slug,
      state: options.state,
      limit: options.limit,
      base: options.base,
      head: options.head,
    });
    if (!options.json && !options.quiet) {
      printPullRequestList(report);
    }
    return report;
  }

  if (area === 'pr' && action === 'inspect') {
    const report = await inspectGitHubPullRequest({
      cwd: process.cwd(),
      env: process.env,
      featureFlagEnabled,
      api: parseBooleanEnvFlag(options.api, true),
      slug: options.slug,
      number: args[2],
    });
    if (!options.json && !options.quiet && report.success === false) {
      printUsageFailure(report);
      showHelp();
    } else if (!options.json && !options.quiet) {
      printPullRequestInspect(report);
    }
    return report;
  }

  if (area === 'pr' && action === 'diff') {
    const report = await inspectGitHubPullRequestDiff({
      cwd: process.cwd(),
      env: process.env,
      featureFlagEnabled,
      api: parseBooleanEnvFlag(options.api, true),
      slug: options.slug,
      number: args[2],
      limit: options.limit,
    });
    if (!options.json && !options.quiet && report.success === false) {
      printUsageFailure(report);
      showHelp();
    } else if (!options.json && !options.quiet) {
      printPullRequestDiffSummary(report);
    }
    return report;
  }

  if ((area === 'workflow' || area === 'workflows') && action === 'runs') {
    const report = await listGitHubWorkflowRuns({
      cwd: process.cwd(),
      env: process.env,
      featureFlagEnabled,
      api: parseBooleanEnvFlag(options.api, true),
      slug: options.slug,
      workflow: options.workflow,
      branch: options.branch,
      status: options.status,
      event: options.event,
      limit: options.limit,
    });
    if (!options.json && !options.quiet) {
      printWorkflowRuns(report);
    }
    return report;
  }

  if (area === 'workflow' && action === 'inspect') {
    const report = await inspectGitHubWorkflowRun({
      cwd: process.cwd(),
      env: process.env,
      featureFlagEnabled,
      api: parseBooleanEnvFlag(options.api, true),
      slug: options.slug,
      runId: args[2],
    });
    if (!options.json && !options.quiet && report.success === false) {
      printUsageFailure(report);
      showHelp();
    } else if (!options.json && !options.quiet) {
      printWorkflowInspect(report);
    }
    return report;
  }

  if (area === 'releases' && action === 'list') {
    const report = await listGitHubReleases({
      cwd: process.cwd(),
      env: process.env,
      featureFlagEnabled,
      api: parseBooleanEnvFlag(options.api, true),
      slug: options.slug,
      limit: options.limit,
    });
    if (!options.json && !options.quiet) {
      printReleasesList(report);
    }
    return report;
  }

  if (area === 'releases' && action === 'inspect') {
    const report = await inspectGitHubRelease({
      cwd: process.cwd(),
      env: process.env,
      featureFlagEnabled,
      api: parseBooleanEnvFlag(options.api, true),
      slug: options.slug,
      selector: args[2],
    });
    if (!options.json && !options.quiet && report.success === false) {
      printUsageFailure(report);
      showHelp();
    } else if (!options.json && !options.quiet) {
      printReleaseInspect(report);
    }
    return report;
  }

  if (!options.json && !options.quiet) {
    showHelp();
  }
  return {
    success: false,
    error: 'USAGE',
    message: `Unknown github command: ${area} ${action}`.trim(),
  };
}

module.exports = {
  run,
  showHelp,
};
