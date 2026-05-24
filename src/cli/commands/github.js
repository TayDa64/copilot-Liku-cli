const { bold, dim, highlight, table, warn } = require('../util/output');
const { parseBooleanEnvFlag } = require('../feature-flags');
const { createGitHubCommandExecutor } = require('../../main/github/command-executor');

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
  liku github capabilities list
  liku github capabilities inspect pr.diff
  liku github plan build pr diff 123 --limit 50
  liku github plan execute pr diff 123 --limit 50
  liku github plan execute --plan-file C:\\Users\\you\\.liku\\github\\plans\\github-plan-example.plan.json
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
  capabilities list    List registered GitHub capabilities and policy metadata
  capabilities inspect Inspect one registered GitHub capability by key
  plan build     Build a deterministic one-step execution plan for a registered GitHub capability
  plan execute   Execute a deterministic read-only GitHub plan within bounded budgets
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
  --plan-file <path> Replay and execute a saved GitHub plan artifact instead of building a new plan

${highlight('NOTES:')}
  - These Phase 2 commands are read-only.
  - Every GitHub command is registered with capability metadata and passes a read-only policy gate before execution.
  - The plan execute path writes replayable plan/result artifacts under the Liku home directory.
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

function printCapabilitiesList(report) {
  console.log(`\n${bold('GitHub capabilities list')}\n`);
  console.log(`${highlight('Total:')} ${report.total ?? (Array.isArray(report.capabilities) ? report.capabilities.length : 0)}`);

  if (Array.isArray(report.capabilities) && report.capabilities.length > 0) {
    table(
      report.capabilities.map((entry) => [
        entry.key,
        entry.sideEffectClass || 'unknown',
        entry.riskLevel || 'unknown',
        entry.approvalRequirement || 'unknown',
        Array.isArray(entry.allowedSources) ? entry.allowedSources.join(',') : '-',
      ]),
      ['Capability', 'Effect', 'Risk', 'Approval', 'Sources']
    );
    console.log(`\n${dim('Use `liku github capabilities inspect <capability-key>` for per-capability schema and policy details.')}`);
  } else {
    console.log(dim('No GitHub capabilities are currently registered.'));
  }
}

function printCapabilityInspect(report) {
  console.log(`\n${bold('GitHub capability inspect')}\n`);

  if (!report.entry) {
    warn(report.message || 'GitHub capability not found.');
    if (Array.isArray(report.availableKeys) && report.availableKeys.length > 0) {
      console.log(`${highlight('Available keys:')} ${report.availableKeys.join(', ')}`);
    }
    return;
  }

  const entry = report.entry;
  console.log(`${highlight('Capability:')} ${entry.key}`);
  console.log(`${highlight('Description:')} ${entry.description || dim('none provided')}`);
  console.log(`${highlight('Schema:')} ${entry.responseSchemaVersion || dim('none')}`);
  console.log(`${highlight('Effect/Risk/Approval:')} ${entry.sideEffectClass || 'unknown'} / ${entry.riskLevel || 'unknown'} / ${entry.approvalRequirement || 'unknown'}`);
  console.log(`${highlight('Sources:')} ${Array.isArray(entry.allowedSources) && entry.allowedSources.length > 0 ? entry.allowedSources.join(', ') : dim('none')}`);
  console.log(`${highlight('Positionals:')} ${Array.isArray(entry.positionalArguments) && entry.positionalArguments.length > 0 ? entry.positionalArguments.join(', ') : dim('none')}`);
  console.log(`${highlight('Options:')} ${Array.isArray(entry.optionKeys) && entry.optionKeys.length > 0 ? entry.optionKeys.map((key) => `--${key}`).join(', ') : dim('none')}`);

  const policyBySource = entry.policyBySource && typeof entry.policyBySource === 'object' ? entry.policyBySource : {};
  const policySources = Object.keys(policyBySource);
  if (policySources.length > 0) {
    console.log(`\n${highlight('Policy preview:')}`);
    policySources.forEach((source) => {
      const policy = policyBySource[source] || {};
      console.log(`  ${highlight(source + ':')} ${policy.allowed ? 'allowed' : 'denied'} ${dim(`(${policy.reason || 'unknown'})`)}`);
    });
  }
}

function printPlanBuild(report) {
  console.log(`\n${bold('GitHub plan build')}\n`);

  if (!report.plan || !Array.isArray(report.plan.steps) || report.plan.steps.length === 0) {
    warn(report.message || 'GitHub plan was not created.');
    if (Array.isArray(report.availableTargets) && report.availableTargets.length > 0) {
      console.log(`${highlight('Available targets:')} ${report.availableTargets.join(', ')}`);
    }
    return;
  }

  console.log(`${highlight('Planner:')} ${report.planner?.mode || 'unknown'} via ${report.planner?.source || 'unknown'}`);
  console.log(`${highlight('Target capability:')} ${report.targetCapability?.key || 'unknown'}`);
  console.log(`${highlight('Goal:')} ${report.plan.goal || dim('none provided')}`);
  console.log(`${highlight('Budget:')} maxSteps=${report.plan.budget?.maxSteps ?? '?'} timeoutMs=${report.plan.budget?.timeoutMs ?? '?'}`);

  table(
    report.plan.steps.map((step) => [
      step.id || '-',
      step.capabilityKey || '-',
      step.policy?.allowed ? 'allowed' : 'denied',
      step.expectedSchemaVersion || '-',
    ]),
    ['Step', 'Capability', 'Policy', 'Schema']
  );

  const firstStep = report.plan.steps[0];
  if (firstStep?.runtimeInput && typeof firstStep.runtimeInput === 'object') {
    console.log(`\n${highlight('Runtime input preview:')} ${JSON.stringify(firstStep.runtimeInput)}`);
  }
}

function printPlanExecute(report) {
  console.log(`\n${bold('GitHub plan execute')}\n`);

  if (!report.execution || !Array.isArray(report.stepResults)) {
    warn(report.message || 'GitHub execution plan did not run.');
    if (report.planArtifact?.filePath) {
      console.log(`${highlight('Plan artifact:')} ${report.planArtifact.filePath}`);
    }
    return;
  }

  console.log(`${highlight('Bounded executor:')} ${report.boundedExecutor?.mode || 'unknown'} via ${report.boundedExecutor?.source || 'unknown'}`);
  console.log(`${highlight('Replay command:')} ${report.boundedExecutor?.replayCommand || dim('unavailable')}`);
  console.log(`${highlight('Plan source:')} ${report.execution.planSource || 'unknown'}`);
  console.log(`${highlight('Budget:')} maxSteps=${report.planSummary?.budget?.maxSteps ?? '?'} timeoutMs=${report.planSummary?.budget?.timeoutMs ?? '?'}`);
  console.log(`${highlight('Artifacts:')} plan=${report.planArtifact?.filePath || 'n/a'} result=${report.resultArtifact?.filePath || 'n/a'}`);

  table(
    report.stepResults.map((step) => [
      step.stepId || '-',
      step.capabilityKey || '-',
      step.success ? 'success' : 'failure',
      step.schemaVersion || '-',
    ]),
    ['Step', 'Capability', 'Result', 'Schema']
  );

  console.log(`\n${highlight('Execution summary:')} elapsedMs=${report.execution.elapsedMs ?? '?'} stepsExecuted=${report.execution.stepsExecuted ?? '?'} timedOut=${report.execution.timedOut ? 'yes' : 'no'}`);
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

const commandExecutor = createGitHubCommandExecutor();

const printHandlers = {
  'auth.status': printAuthStatus,
  'capabilities.list': printCapabilitiesList,
  'capabilities.inspect': printCapabilityInspect,
  'plan.build': printPlanBuild,
  'plan.execute': printPlanExecute,
  'repo.inspect': printRepoInspect,
  'issues.list': printIssuesList,
  'issues.inspect': printIssueInspect,
  'pr.list': printPullRequestList,
  'pr.inspect': printPullRequestInspect,
  'pr.diff': printPullRequestDiffSummary,
  'workflow.runs': printWorkflowRuns,
  'workflow.inspect': printWorkflowInspect,
  'releases.list': printReleasesList,
  'releases.inspect': printReleaseInspect,
};

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
      message: 'Usage: liku github <auth|capabilities|plan|repo|issues|pr|workflow|releases> <status|inspect|list|build|execute|runs>',
    };
  }

  const report = await commandExecutor.execute({
    source: 'cli',
    area,
    action,
    positionals: args,
    options: {
      ...options,
      probe: parseBooleanEnvFlag(options.probe, true),
      api: parseBooleanEnvFlag(options.api, true),
    },
    executionPreferences: options.executionPreferences,
    cwd: process.cwd(),
    env: process.env,
    featureFlagEnabled,
  });

  if (!options.json && !options.quiet) {
    const handler = report?.capability?.key ? printHandlers[report.capability.key] : null;
    if (report?.success === false) {
      printUsageFailure(report);
      if (report.error === 'USAGE') {
        showHelp();
      }
    } else if (typeof handler === 'function') {
      handler(report);
    }
  }

  return report;
}

module.exports = {
  run,
  showHelp,
};
