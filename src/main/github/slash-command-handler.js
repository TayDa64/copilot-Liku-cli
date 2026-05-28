const { parseLongOptions, tokenize } = require('../ai-service/slash-command-helpers');
const { createGitHubCommandExecutor } = require('./command-executor');

function isFeatureFlagEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.LIKU_ENABLE_GITHUB || '').trim());
}

function isWriteFeatureFlagEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.LIKU_ENABLE_GITHUB_WRITES || '').trim());
}

function normalizeArea(area) {
  const value = String(area || '').trim().toLowerCase();
  if (value === 'issue') return 'issues';
  if (value === 'workflows') return 'workflow';
  if (value === 'release') return 'releases';
  if (value === 'rulesets') return 'ruleset';
  if (value === 'environments') return 'environment';
  if (value === 'events') return 'event';
  if (value === 'secrets') return 'secret';
  if (value === 'variables') return 'variable';
  if (value === 'codeowner') return 'codeowners';
  if (value === 'templates') return 'template';
  if (value === 'hooks' || value === 'webhooks') return 'webhook';
  if (value === 'apps') return 'app';
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
    '/github capabilities list',
    '/github capabilities inspect <capability-key>',
    '/github context bundle pr <number> [--slug owner/repo] [--api false] [--out-file <path>]',
    '/github context bundle issue <number> [--slug owner/repo] [--api false] [--out-file <path>]',
    '/github context bundle repo [--slug owner/repo] [--limit N] [--api false] [--out-file <path>]',
    '/github issues comment draft <number> (--body <text> | --body-file <path>) [--slug owner/repo]',
    '/github pr create draft --title <text> [--body <text> | --body-file <path>] [--base branch] [--head branch|owner:branch] [--draft true|false] [--slug owner/repo] [--api false]',
    '/github pr comment draft <number> (--body <text> | --body-file <path>) [--slug owner/repo]',
    '/github pr review draft <number> --event <comment|approve|request-changes> [--body <text> | --body-file <path>] [--slug owner/repo]',
    '/github pr close draft <number> [--slug owner/repo]',
    '/github pr reopen draft <number> [--slug owner/repo]',
    '/github plan build <auth|capabilities|repo|ruleset|environment|secret|variable|codeowners|template|webhook|app|issues|pr|workflow|releases> <status|inspect|list|diff|runs> [...]',
    '/github plan execute <auth|capabilities|repo|ruleset|environment|secret|variable|codeowners|template|webhook|app|issues|pr|workflow|releases> <status|inspect|list|diff|runs> [...]',
    '/github plan execute --plan-file <path>',
    '/github plan resume --guidance-file <path> --resume-token <token> [--answers-file <path> | --answers-json <json>]',
    '/github plan runs [--slug owner/repo] [--limit N] [--state completed|blocked|aborted|all]',
    '/github plan inspect <run-id> [--slug owner/repo] [--plan-file <path>] [--event-log-file <path>]',
    '/github repo inspect [--slug owner/repo] [--api false]',
    '/github ruleset list [--slug owner/repo] [--limit N] [--api false]',
    '/github ruleset inspect <id> [--slug owner/repo] [--api false]',
    '/github environment list [--slug owner/repo] [--limit N] [--api false]',
    '/github environment inspect <name> [--slug owner/repo] [--api false]',
    '/github secret list [--slug owner/repo] [--limit N] [--api false]',
    '/github secret inspect <name> [--slug owner/repo] [--api false]',
    '/github variable list [--slug owner/repo] [--limit N] [--api false]',
    '/github variable inspect <name> [--slug owner/repo] [--api false]',
    '/github codeowners inspect [--slug owner/repo] [--api false]',
    '/github codeowners create draft [--path <path>] [--body <text> | --body-file <path>] [--base branch] [--head branch] [--slug owner/repo] [--api false]',
    '/github codeowners update draft [--path <path>] [--body <text> | --body-file <path>] [--base branch] [--head branch] [--slug owner/repo] [--api false]',
    '/github template inspect [--slug owner/repo] [--api false]',
    '/github webhook list [--slug owner/repo] [--limit N] [--api false]',
    '/github webhook inspect <id> [--slug owner/repo] [--api false]',
    '/github webhook create draft --events <csv> --target-url <url> --secret-ref repo:<ENV_NAME> [--content-type <json|form>] [--active true|false] [--slug owner/repo]',
    '/github webhook update draft <id> [--events <csv>] [--target-url <url>] [--secret-ref repo:<ENV_NAME>] [--content-type <json|form>] [--active true|false] [--slug owner/repo]',
    '/github webhook ping draft <id> [--slug owner/repo]',
    '/github event list [--slug owner/repo] [--limit N] [--event <name>]',
    '/github event inspect <event-id> [--slug owner/repo]',
    '/github app status [--slug owner/repo] [--probe false] [--api false]',
    '/github app installation inspect [--slug owner/repo] [--api false]',
    '/github app permissions inspect [--slug owner/repo] [--api false]',
    '/github issues list [--slug owner/repo] [--state open|closed|all] [--limit N] [--labels a,b] [--api false]',
    '/github issues inspect <number> [--slug owner/repo] [--api false]',
    '/github pr list [--slug owner/repo] [--state open|closed|all] [--limit N] [--base branch] [--head branch] [--api false]',
    '/github pr status [--slug owner/repo] [--branch name] [--head owner:branch] [--state open|closed|all] [--api false]',
    '/github pr view [--slug owner/repo] [--branch name] [--head owner:branch] [--state open|closed|all] [--api false]',
    '/github pr feedback [<number>] [--slug owner/repo] [--branch name] [--head owner:branch] [--state open|closed|all] [--limit N] [--api false]',
    '/github pr inspect <number> [--slug owner/repo] [--api false]',
    '/github pr diff <number> [--slug owner/repo] [--limit N] [--api false]',
    '/github workflow runs [--slug owner/repo] [--workflow id|file] [--branch name] [--status value] [--event name] [--limit N] [--api false]',
    '/github workflow inspect <run-id> [--slug owner/repo] [--api false]',
    '/github workflow validate <path> [--body <text> | --body-file <path>] [--slug owner/repo]',
    '/github workflow permissions inspect <path> [--body <text> | --body-file <path>] [--slug owner/repo]',
    '/github workflow requirements inspect <path> [--body <text> | --body-file <path>] [--slug owner/repo]',
    '/github workflow create draft <path> [--body <text> | --body-file <path>] [--base branch] [--head branch] [--slug owner/repo] [--api false]',
    '/github workflow update draft <path> [--body <text> | --body-file <path>] [--base branch] [--head branch] [--slug owner/repo] [--api false]',
    '/github workflow dispatch draft <workflow-id|file> [--ref branch|tag|sha] [--inputs-json <json> | --inputs-file <path>] [--slug owner/repo]',
    '/github workflow rerun draft <run-id> [--failed-only true|false] [--slug owner/repo]',
    '/github workflow cancel draft <run-id> [--slug owner/repo]',
    '/github releases list [--slug owner/repo] [--limit N] [--api false]',
    '/github releases inspect <latest|tag|id> [--slug owner/repo] [--api false]',
    '',
    'Notes:',
    '- Uses the same typed GitHub adapters as `liku github ...`.',
    '- Every GitHub slash command is registered with capability metadata and passes the shared GitHub policy gate before execution.',
    '- Governance inventory surfaces are repo-scoped, read-only, and fail soft when tokens or repo-admin scopes are missing.',
    '- Secrets, variables, and webhook config stay metadata-only in model-visible output; values and sensitive config are redacted.',
    '- `/github codeowners inspect ...` and `/github template inspect ...` prefer the current workspace when it matches the target repo and can run offline with `--api false`.',
    '- `/github codeowners create draft ...` and `/github codeowners update draft ...` preview repo-content patches that apply through a dedicated branch plus draft pull request instead of mutating the default branch directly.',
    '- `/github webhook create draft ...` and `/github webhook update draft ...` persist only repo:<ENV_NAME> secret refs; the actual webhook secret is resolved from the local environment during CLI apply.',
    '- `/github webhook ping draft ...` previews one webhook test delivery through the same reviewed CLI-only apply seam.',
    '- `/github event list ...` and `/github event inspect ...` read the local GitHub event journal under the Liku home directory; this Phase 10B slice provides durable storage and inspection only, not a live webhook receiver.',
    '- `/github context bundle ...` writes a reviewed, sanitized local artifact for PR, issue, or repo context before any future orchestration consumes it.',
    '- `/github issues comment draft ...` writes a reviewed, sanitized local preview artifact but does not mutate GitHub yet.',
    '- `/github pr create draft ...` writes a reviewed, sanitized local preview artifact but does not mutate GitHub yet.',
    '- `/github pr comment draft ...` writes a reviewed, sanitized local preview artifact but does not mutate GitHub yet.',
    '- `/github pr review draft ...` writes a reviewed, sanitized local preview artifact but does not mutate GitHub yet.',
    '- `/github pr close draft ...` and `/github pr reopen draft ...` write reviewed, sanitized local preview artifacts but do not mutate GitHub yet.',
    '- `/github pr status ...` defaults to the current git branch; `/github pr view ...` is an alias for the same branch-associated lookup.',
    '- `/github pr feedback ...` accepts an explicit PR number or defaults to the same branch-associated lookup used by `/github pr status`.',
    '- `/github pr review draft ...` accepts `--event comment|approve|request-changes`; approve may omit a body, while comment/request-changes require one.',
    '- `/github pr close draft ...` and `/github pr reopen draft ...` are intended for reversible PR state transitions through the same CLI-only apply seam.',
    '- `/github pr create draft ...` defaults the head branch to the current git branch and can derive the base branch from the repository default branch when API lookup is allowed.',
    '- `/github workflow validate ...`, `/github workflow permissions inspect ...`, and `/github workflow requirements inspect ...` analyze workflow text locally and reuse the same workflow hardening rules enforced by repository verification.',
    '- `/github workflow create draft ...` and `/github workflow update draft ...` preview repo-content patches that apply through a dedicated branch plus draft pull request instead of mutating the default branch directly.',
    '- `/github workflow dispatch draft ...`, `/github workflow rerun draft ...`, and `/github workflow cancel draft ...` use the same reviewed preview/apply seam for GitHub Actions operational commands.',
    '- Actual apply remains intentionally CLI-only in this reviewed GitHub write slice: use `liku github apply <preview-id> --approve --approval-file <path>`.',
    '- `/github plan execute ...` writes replayable plan/result artifacts and can replay from `--plan-file`.',
    '- `/github plan resume ...` resumes a blocked bounded run from a saved guidance checkpoint without replaying completed steps.',
    '- `/github plan runs ...` and `/github plan inspect ...` read the local GitHub plan ledger under the Liku home directory; this Phase 10C slice adds durable run inspection only, not a new orchestration or apply path.',
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

  if (Array.isArray(report.governanceAccess?.hints) && report.governanceAccess.hints.length > 0) {
    lines.push('Governance hints:');
    report.governanceAccess.hints.forEach((hint) => lines.push(`- ${hint.title}`));
  }

  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatCapabilitiesList(report) {
  const lines = [
    'GitHub capabilities list',
    `Total: ${report.total ?? (Array.isArray(report.capabilities) ? report.capabilities.length : 0)}`,
  ];

  if (Array.isArray(report.capabilities) && report.capabilities.length > 0) {
    lines.push(...report.capabilities.map((entry) => `- ${entry.key} — ${entry.sideEffectClass || 'unknown'} / ${entry.riskLevel || 'unknown'} / ${entry.approvalRequirement || 'unknown'} — sources: ${Array.isArray(entry.allowedSources) && entry.allowedSources.length ? entry.allowedSources.join(', ') : '-'}`));
    lines.push('Use `/github capabilities inspect <capability-key>` for per-capability schema and policy details.');
  } else {
    lines.push('No GitHub capabilities are currently registered.');
  }

  return lines.join('\n');
}

function formatCapabilityInspect(report) {
  const lines = ['GitHub capability inspect'];

  if (!report.entry) {
    lines.push(report.message || 'GitHub capability not found.');
    if (Array.isArray(report.availableKeys) && report.availableKeys.length > 0) {
      lines.push(`Available keys: ${report.availableKeys.join(', ')}`);
    }
    return lines.join('\n');
  }

  const entry = report.entry;
  lines.push(
    `Capability: ${entry.key}`,
    `Description: ${entry.description || 'none provided'}`,
    `Schema: ${entry.responseSchemaVersion || 'none'}`,
    `Effect/Risk/Approval: ${entry.sideEffectClass || 'unknown'} / ${entry.riskLevel || 'unknown'} / ${entry.approvalRequirement || 'unknown'}`,
    `Sources: ${Array.isArray(entry.allowedSources) && entry.allowedSources.length > 0 ? entry.allowedSources.join(', ') : 'none'}`,
    `Positionals: ${Array.isArray(entry.positionalArguments) && entry.positionalArguments.length > 0 ? entry.positionalArguments.join(', ') : 'none'}`,
    `Options: ${Array.isArray(entry.optionKeys) && entry.optionKeys.length > 0 ? entry.optionKeys.map((key) => `--${key}`).join(', ') : 'none'}`
  );

  const policyBySource = entry.policyBySource && typeof entry.policyBySource === 'object' ? entry.policyBySource : {};
  const policySources = Object.keys(policyBySource);
  if (policySources.length > 0) {
    lines.push('Policy preview:');
    policySources.forEach((source) => {
      const policy = policyBySource[source] || {};
      lines.push(`- ${source}: ${policy.allowed ? 'allowed' : 'denied'} (${policy.reason || 'unknown'})`);
    });
  }

  return lines.join('\n');
}

function formatPlanBuild(report) {
  const lines = ['GitHub plan build'];

  if (!report.plan || !Array.isArray(report.plan.steps) || report.plan.steps.length === 0) {
    lines.push(report.message || 'GitHub plan was not created.');
    if (Array.isArray(report.availableTargets) && report.availableTargets.length > 0) {
      lines.push(`Available targets: ${report.availableTargets.join(', ')}`);
    }
    return lines.join('\n');
  }

  lines.push(
    `Planner: ${report.planner?.mode || 'unknown'} via ${report.planner?.source || 'unknown'}`,
    `Target capability: ${report.targetCapability?.key || 'unknown'}`,
    `Goal: ${report.plan.goal || 'none provided'}`,
    `Budget: maxSteps=${report.plan.budget?.maxSteps ?? '?'} timeoutMs=${report.plan.budget?.timeoutMs ?? '?'}`
  );

  lines.push(...report.plan.steps.map((step) => `- ${step.id || '-'} ${step.capabilityKey || '-'} — ${step.policy?.allowed ? 'allowed' : 'denied'} — ${step.expectedSchemaVersion || 'no schema'}`));

  const firstStep = report.plan.steps[0];
  if (firstStep?.runtimeInput && typeof firstStep.runtimeInput === 'object') {
    lines.push(`Runtime input preview: ${JSON.stringify(firstStep.runtimeInput)}`);
  }

  return lines.join('\n');
}

function formatPlanExecute(report) {
  const lines = [report?.capability?.key === 'plan.resume' ? 'GitHub plan resume' : 'GitHub plan execute'];

  if (!report.execution || !Array.isArray(report.stepResults)) {
    lines.push(report.message || 'GitHub execution plan did not run.');
    if (report.planArtifact?.filePath) {
      lines.push(`Plan artifact: ${report.planArtifact.filePath}`);
    }
    return lines.join('\n');
  }

  lines.push(
    `Bounded executor: ${report.boundedExecutor?.mode || 'unknown'} via ${report.boundedExecutor?.source || 'unknown'}`,
    `Run: ${report.run?.runId || 'unknown'} (${report.run?.status || report.status || 'unknown'})`,
    `Event log: ${report.eventLog?.filePath || 'n/a'}`,
    `Replay command: ${report.boundedExecutor?.replayCommand || 'unavailable'}`,
    `Plan source: ${report.execution.planSource || 'unknown'}`,
    `Budget: maxSteps=${report.planSummary?.budget?.maxSteps ?? '?'} timeoutMs=${report.planSummary?.budget?.timeoutMs ?? '?'}`,
    `Artifacts: plan=${report.planArtifact?.filePath || 'n/a'} result=${report.resultArtifact?.filePath || 'n/a'}`
  );

  if (report.status === 'needs-guidance') {
    lines.push(
      `Guidance: ${report.guidanceArtifact?.filePath || 'n/a'}`,
      `Resume token: ${report.resume?.resumeToken || 'n/a'}`
    );
  }

  lines.push(...report.stepResults.map((step) => `- ${step.stepId || '-'} ${step.capabilityKey || '-'} — ${step.success ? 'success' : 'failure'} — ${step.schemaVersion || 'no schema'}`));
  lines.push(`Execution summary: status=${report.execution.status || report.status || 'unknown'} elapsedMs=${report.execution.elapsedMs ?? '?'} stepsExecuted=${report.execution.stepsExecuted ?? '?'} timedOut=${report.execution.timedOut ? 'yes' : 'no'}`);

  return lines.join('\n');
}

function formatPlanRuns(report) {
  const lines = [
    'GitHub plan runs',
    `Target: ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'}`,
    `Artifact dir: ${report.artifactDir || 'n/a'}`,
    `Filters: limit=${report.filters?.limit ?? '?'} state=${report.filters?.state || 'all'}`,
  ];

  const runs = Array.isArray(report.runs) ? report.runs : [];
  if (runs.length > 0) {
    lines.push(...runs.map((run) => {
      const capability = run.targetCapability?.key || 'unknown';
      const slug = run.slug || report.target?.slug || 'unknown';
      const guidance = run.guidance?.status ? ` guidance=${run.guidance.status}` : '';
      const updatedAt = run.lastUpdatedAt || run.createdAt || null;
      return `- ${run.runId || 'unknown'} — ${run.state || 'unknown'} — ${capability} — ${slug} — updated=${compactTimestamp(updatedAt)}${guidance}`;
    }));
  } else {
    lines.push('No locally recorded GitHub plan runs matched the requested filters.');
  }

  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatPlanInspect(report) {
  const lines = [
    'GitHub plan inspect',
    `Target: ${report.target?.slug || report.repoIdentity?.repoName || report.run?.slug || 'unknown'}`,
  ];

  if (!report.run) {
    lines.push(report.message || 'GitHub plan run was not found.');
    if (report.artifactDir) {
      lines.push(`Artifact dir: ${report.artifactDir}`);
    }
    return [...lines, ...formatWarnings(report.warnings)].join('\n');
  }

  lines.push(
    `Run: ${report.run.runId || 'unknown'} (${report.run.state || 'unknown'})`,
    `Capability: ${report.run.targetCapability?.key || 'unknown'}`,
    `Artifacts: plan=${report.planArtifact?.filePath || 'n/a'} result=${report.resultArtifact?.filePath || 'n/a'} guidance=${report.guidanceArtifact?.filePath || 'n/a'}`,
    `Event log: ${report.eventLog?.filePath || 'n/a'}${report.eventLog?.eventCount ? ` (${report.eventLog.eventCount} events)` : ''}`
  );
  if (report.run.goal) {
    lines.push(`Goal: ${report.run.goal}`);
  }
  if (report.execution) {
    lines.push(`Execution: status=${report.execution.status || report.run.state || 'unknown'} source=${report.run.planSource || 'unknown'} steps=${report.execution.stepsExecuted ?? report.run.stepsExecuted ?? '?'} elapsedMs=${report.execution.elapsedMs ?? '?'} timedOut=${report.execution.timedOut ? 'yes' : 'no'}`);
  }
  if (report.run.latestEventName) {
    lines.push(`Latest event: ${report.run.latestEventName}${report.run.latestEventAt ? ` at ${compactTimestamp(report.run.latestEventAt)}` : ''}`);
  }
  if (report.guidance) {
    lines.push(`Guidance: ${report.guidance.status || 'unknown'}${report.guidance.reason ? ` (${report.guidance.reason})` : ''}`);
    if (report.guidance.resumeToken) {
      lines.push(`Resume token: ${report.guidance.resumeToken}`);
    }
  }
  if (report.plan?.requestedTarget) {
    lines.push(`Requested target: ${report.plan.requestedTarget.area || 'unknown'} ${report.plan.requestedTarget.action || 'unknown'}`.trim());
  }
  if (Array.isArray(report.stepResults) && report.stepResults.length > 0) {
    lines.push(...report.stepResults.map((step) => `- ${step.stepId || '-'} ${step.capabilityKey || '-'} — ${step.success ? 'success' : 'failure'} — ${step.schemaVersion || 'no schema'}`));
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

function formatInventoryList(title, report, collectionKey, formatItem, emptyMessage) {
  const lines = [
    title,
    `Target: ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'}`,
  ];

  if (report.filters?.limit) {
    lines.push(`Filters: limit=${report.filters.limit}`);
  }

  const items = Array.isArray(report[collectionKey]) ? report[collectionKey] : [];
  if (items.length > 0) {
    lines.push(...items.map((item) => `- ${formatItem(item)}`));
  } else if (report.githubApi?.attempted && !report.githubApi?.error) {
    lines.push(emptyMessage);
  } else if (report.githubApi?.attempted) {
    lines.push(`${title}: unavailable (${report.githubApi.error || 'unknown error'})`);
  } else {
    lines.push(`${title}: inspection skipped`);
  }

  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatInventoryInspect(title, report, key, missingLabel, renderDetails) {
  const lines = [
    title,
    `Target: ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'}`,
  ];

  const entry = report[key];
  if (!entry) {
    lines.push(report.githubApi?.attempted
      ? `${missingLabel}: unavailable (${report.githubApi.error || 'unknown error'})`
      : `${missingLabel}: inspection skipped`);
    return [...lines, ...formatWarnings(report.warnings)].join('\n');
  }

  lines.push(...renderDetails(entry, report));
  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatRulesetList(report) {
  return formatInventoryList('GitHub ruleset list', report, 'rulesets', (ruleset) => {
    return `#${ruleset.id ?? '?'} ${ruleset.enforcement || 'unknown'} ${ruleset.name || 'unnamed'} — target=${ruleset.target || 'unknown'} rules=${ruleset.rulesCount ?? 0} updated=${compactTimestamp(ruleset.updatedAt)}`;
  }, 'No rulesets were reported for the requested repository.');
}

function formatRulesetInspect(report) {
  return formatInventoryInspect('GitHub ruleset inspect', report, 'ruleset', 'GitHub ruleset', (ruleset) => {
    const lines = [
      `Ruleset: #${ruleset.id ?? '?'} ${ruleset.name || 'unnamed'}`,
      `Target/source: ${ruleset.target || 'unknown'} / ${ruleset.sourceType || 'unknown'}${ruleset.source ? ` (${ruleset.source})` : ''}`,
      `Enforcement: ${ruleset.enforcement || 'unknown'}${ruleset.currentUserCanBypass ? ' (viewer can bypass)' : ''}`,
      `Rules: ${ruleset.rulesCount ?? 0}${Array.isArray(ruleset.ruleTypes) && ruleset.ruleTypes.length > 0 ? ` (${ruleset.ruleTypes.join(', ')})` : ''}`,
      `Bypass actors: ${ruleset.bypassActorCount ?? 0}`,
      `Updated: ${compactTimestamp(ruleset.updatedAt)}`,
    ];
    if (ruleset.conditions?.refName?.include?.length) {
      lines.push(`Ref include: ${ruleset.conditions.refName.include.join(', ')}`);
    }
    if (ruleset.conditions?.refName?.exclude?.length) {
      lines.push(`Ref exclude: ${ruleset.conditions.refName.exclude.join(', ')}`);
    }
    return lines;
  });
}

function formatEnvironmentList(report) {
  return formatInventoryList('GitHub environment list', report, 'environments', (environment) => {
    return `${environment.name || 'unnamed'} — protections=${environment.protectionRuleCount ?? 0} reviewers=${environment.reviewerCount ?? 0} wait=${environment.waitTimer ?? 0}m updated=${compactTimestamp(environment.updatedAt)}`;
  }, 'No environments were reported for the requested repository.');
}

function formatEnvironmentInspect(report) {
  return formatInventoryInspect('GitHub environment inspect', report, 'environment', 'GitHub environment', (environment) => {
    const lines = [
      `Environment: ${environment.name || 'unnamed'}`,
      `Protection rules: ${environment.protectionRuleCount ?? 0}`,
      `Reviewers/wait timer: ${(environment.reviewerCount ?? 0)} / ${(environment.waitTimer ?? 0)}m`,
      `Admin bypass: ${environment.canAdminsBypass ? 'yes' : 'no'}`,
      `Updated: ${compactTimestamp(environment.updatedAt)}`,
    ];
    if (environment.deploymentBranchPolicy) {
      lines.push(`Deployment branches: protected=${environment.deploymentBranchPolicy.protectedBranches ? 'yes' : 'no'} custom=${environment.deploymentBranchPolicy.customBranchPolicies ? 'yes' : 'no'}`);
    }
    return lines;
  });
}

function formatSecretList(report) {
  return formatInventoryList('GitHub secret list', report, 'secrets', (secret) => {
    return `${secret.name || 'unnamed'} — visibility=${secret.visibility || 'unknown'} selectedRepos=${secret.selectedRepositoriesCount ?? 0} updated=${compactTimestamp(secret.updatedAt)}`;
  }, 'No Actions secrets were reported for the requested repository.');
}

function formatSecretInspect(report) {
  return formatInventoryInspect('GitHub secret inspect', report, 'secret', 'GitHub secret', (secret) => {
    return [
      `Secret: ${secret.name || 'unnamed'}`,
      `Visibility: ${secret.visibility || 'unknown'}`,
      `Selected repositories: ${secret.selectedRepositoriesCount ?? 0}`,
      `Updated: ${compactTimestamp(secret.updatedAt)}`,
      'Values: redacted (metadata only)',
    ];
  });
}

function formatVariableList(report) {
  return formatInventoryList('GitHub variable list', report, 'variables', (variable) => {
    return `${variable.name || 'unnamed'} — visibility=${variable.visibility || 'unknown'} selectedRepos=${variable.selectedRepositoriesCount ?? 0} updated=${compactTimestamp(variable.updatedAt)}`;
  }, 'No Actions variables were reported for the requested repository.');
}

function formatVariableInspect(report) {
  return formatInventoryInspect('GitHub variable inspect', report, 'variable', 'GitHub variable', (variable) => {
    return [
      `Variable: ${variable.name || 'unnamed'}`,
      `Visibility: ${variable.visibility || 'unknown'}`,
      `Selected repositories: ${variable.selectedRepositoriesCount ?? 0}`,
      `Updated: ${compactTimestamp(variable.updatedAt)}`,
      'Values: redacted (metadata only)',
    ];
  });
}

function formatCodeownersInspect(report) {
  const lines = [
    'GitHub CODEOWNERS inspect',
    `Target: ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'}`,
  ];

  if (!report.codeowners) {
    lines.push('CODEOWNERS: not found in standard locations');
    return [...lines, ...formatWarnings(report.warnings)].join('\n');
  }

  lines.push(
    `Path/source: ${report.codeowners.path || 'unknown'} / ${report.codeowners.source || 'unknown'}`,
    `Entries/owners: ${(report.codeowners.entryCount ?? 0)} / ${(report.codeowners.ownerCount ?? 0)}`
  );
  if (Array.isArray(report.codeowners.owners) && report.codeowners.owners.length > 0) {
    lines.push(`Owners: ${report.codeowners.owners.join(', ')}`);
  }
  if (Array.isArray(report.codeowners.entries) && report.codeowners.entries.length > 0) {
    lines.push('Preview:', ...report.codeowners.entries.map((entry) => `- ${entry.preview}`));
  }
  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatCodeownersDraft(report) {
  const actionLabel = report.draft?.changeOperation || (report.capability?.key === 'codeowners.update.draft' ? 'update' : 'create');
  const lines = [
    `GitHub CODEOWNERS ${actionLabel} draft`,
    `Target: ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'} ${report.codeownersPath || report.draft?.codeownersPath || ''}`.trim(),
    `Preview: ${report.previewId || 'unknown'}`,
    `Artifacts: preview=${report.previewArtifact?.filePath || 'n/a'} approval=${report.approvalArtifact?.filePath || 'n/a'}`,
    `Branches: ${report.draft?.headBranch || '?'} -> ${report.draft?.baseBranch || '?'}`,
    `Commit: ${report.draft?.commitMessagePreview || 'unknown'}`,
    `Pull request: ${report.draft?.pullRequestTitle || 'unknown'}`,
    `Entries/owners: ${(report.draft?.entryCount ?? 0)} / ${(report.draft?.ownerCount ?? 0)}`,
  ];

  if (Array.isArray(report.draft?.owners) && report.draft.owners.length > 0) {
    lines.push(`Owners: ${report.draft.owners.join(', ')}`);
  }
  if (report.instructions?.cliApply) {
    lines.push(`Apply via CLI: ${report.instructions.cliApply}`);
  }
  if (report.instructions?.note) {
    lines.push(`Note: ${report.instructions.note}`);
  }

  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatTemplateInspect(report) {
  const lines = [
    'GitHub template inspect',
    `Target: ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'}`,
    `Source: ${report.templates?.source || 'unknown'}`,
    `Total templates: ${report.templates?.totalCount ?? 0}`,
  ];

  const pullRequestTemplates = Array.isArray(report.templates?.pullRequestTemplates) ? report.templates.pullRequestTemplates : [];
  const issueTemplates = Array.isArray(report.templates?.issueTemplates) ? report.templates.issueTemplates : [];
  if (pullRequestTemplates.length > 0) {
    lines.push('Pull request templates:', ...pullRequestTemplates.map((template) => `- ${template.path || template.fileName}: ${template.title || 'untitled'}`));
  }
  if (issueTemplates.length > 0) {
    lines.push('Issue templates:', ...issueTemplates.map((template) => `- ${template.path || template.fileName}: ${template.title || 'untitled'}`));
  }
  if (!pullRequestTemplates.length && !issueTemplates.length) {
    lines.push('No issue or pull request templates were found.');
  }
  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatWebhookList(report) {
  return formatInventoryList('GitHub webhook list', report, 'webhooks', (hook) => {
    const url = hook.config?.url || hook.url || '-';
    return `#${hook.id ?? '?'} ${hook.active ? 'active' : 'inactive'} ${hook.name || 'web'} — events=${hook.eventCount ?? 0} url=${truncate(url, 72)}`;
  }, 'No webhooks were reported for the requested repository.');
}

function formatWebhookInspect(report) {
  return formatInventoryInspect('GitHub webhook inspect', report, 'webhook', 'GitHub webhook', (hook) => {
    const lines = [
      `Webhook: #${hook.id ?? '?'} ${hook.name || 'web'}`,
      `Active/events: ${hook.active ? 'yes' : 'no'} / ${Array.isArray(hook.events) ? hook.events.join(', ') : 'none'}`,
      `Updated: ${compactTimestamp(hook.updatedAt)}`,
    ];
    if (hook.config) {
      lines.push(`Config: ${JSON.stringify(hook.config)}`);
    }
    if (hook.lastResponse) {
      lines.push(`Last response: ${hook.lastResponse.status || 'unknown'}${hook.lastResponse.code ? ` (${hook.lastResponse.code})` : ''}${hook.lastResponse.message ? ` ${hook.lastResponse.message}` : ''}`);
    }
    return lines;
  });
}

function formatEventList(report) {
  return formatInventoryList('GitHub event list', report, 'events', (event) => {
    const action = event.action ? `/${event.action}` : '';
    const slug = event.slug || report.target?.slug || 'unknown';
    const delivery = event.deliveryId || event.eventId || '-';
    const timestamp = event.receivedAt || event.recordedAt || null;
    return `${event.eventName || 'unknown'}${action} — ${slug} — delivery=${truncate(delivery, 28)} recorded=${compactTimestamp(timestamp)}`;
  }, 'No locally recorded GitHub events matched the requested filters.');
}

function formatEventInspect(report) {
  return formatInventoryInspect('GitHub event inspect', report, 'event', 'GitHub event', (event) => {
    const lines = [
      `Event: ${event.eventName || 'unknown'}${event.action ? ` / ${event.action}` : ''}`,
      `Delivery: ${event.deliveryId || 'n/a'}${event.hookId ? ` hook=${event.hookId}` : ''}${event.installationId ? ` installation=${event.installationId}` : ''}`,
      `Target/source: ${event.slug || 'unknown'} / ${event.source || 'unknown'}`,
      `Recorded/received: ${compactTimestamp(event.recordedAt)} / ${compactTimestamp(event.receivedAt)}`,
    ];
    if (event.senderLogin) {
      lines.push(`Sender: ${event.senderLogin}`);
    }
    if (event.review) {
      lines.push(`Review: sensitivity=${event.review.sensitivity || 'unknown'} redactions=${event.review.redactionCount ?? 0} reviewRecommended=${event.review.reviewRecommended ? 'yes' : 'no'}`);
    }
    if (Array.isArray(event.payloadKeys) && event.payloadKeys.length > 0) {
      lines.push(`Payload keys: ${event.payloadKeys.join(', ')}`);
    }
    if (event.payloadPreview && typeof event.payloadPreview === 'object') {
      lines.push(`Payload preview: ${JSON.stringify(event.payloadPreview)}`);
    }
    if (report.artifact?.filePath) {
      lines.push(`Artifact: ${report.artifact.filePath}`);
    }
    return lines;
  });
}

function formatWebhookDraft(report) {
  const capabilityKey = String(report.capability?.key || '').trim().toLowerCase();
  const actionLabel = capabilityKey === 'webhook.update.draft'
    ? 'update'
    : (capabilityKey === 'webhook.ping.draft' ? 'ping' : 'create');
  const lines = [
    `GitHub webhook ${actionLabel} draft`,
    `Target: ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'}${report.webhookId ? ` #${report.webhookId}` : ''}`,
    `Preview: ${report.previewId || 'unknown'}`,
    `Artifacts: preview=${report.previewArtifact?.filePath || 'n/a'} approval=${report.approvalArtifact?.filePath || 'n/a'}`,
  ];

  if (report.draft?.webhookName) {
    lines.push(`Webhook: ${report.draft.webhookName}`);
  }
  if (Array.isArray(report.draft?.updates) && report.draft.updates.length > 0) {
    lines.push(`Updates: ${report.draft.updates.join(', ')}`);
  }
  if (report.draft?.targetUrl) {
    lines.push(`Target URL: ${report.draft.targetUrl}`);
  }
  if (Array.isArray(report.draft?.events) && report.draft.events.length > 0) {
    lines.push(`Events: ${report.draft.events.join(', ')}`);
  }
  if (report.draft?.contentType) {
    lines.push(`Content type: ${report.draft.contentType}`);
  }
  if (report.draft?.secretRef) {
    lines.push(`Secret ref: ${report.draft.secretRef}${report.draft.secretEnvName ? ` (env ${report.draft.secretEnvName})` : ''}`);
  }
  if (report.draft?.active === true || report.draft?.active === false) {
    lines.push(`Active: ${report.draft.active ? 'yes' : 'no'}`);
  }
  if (report.instructions?.cliApply) {
    lines.push(`Apply via CLI: ${report.instructions.cliApply}`);
  }
  if (report.instructions?.note) {
    lines.push(`Note: ${report.instructions.note}`);
  }

  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatAppStatus(report) {
  const lines = [
    'GitHub app status',
    `Target: ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'}`,
    `GitHub auth: token=${report.summary?.tokenPresent ? 'present' : 'missing'} authenticated=${report.summary?.authenticated ? 'yes' : 'no'} governanceScope=${report.summary?.governanceScopeObserved ? 'observed' : 'not observed'}`,
  ];

  if (report.installation) {
    lines.push(
      `Installation: ${report.installation.appSlug || 'unknown'} (${report.installation.repositorySelection || 'unknown'})`,
      `Permissions/events: ${Object.keys(report.installation.permissions || {}).length} / ${(report.installation.events || []).length}`
    );
  } else if (report.githubApi?.attempted) {
    lines.push(`Installation: unavailable (${report.githubApi.error || 'unknown error'})`);
  } else {
    lines.push('Installation: lookup skipped');
  }

  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatAppInstallationInspect(report) {
  return formatInventoryInspect('GitHub app installation inspect', report, 'installation', 'GitHub App installation', (installation) => {
    return [
      `App/account: ${installation.appSlug || 'unknown'} / ${installation.account?.login || 'unknown'}`,
      `Repository selection: ${installation.repositorySelection || 'unknown'}`,
      `Permissions/events: ${Object.keys(installation.permissions || {}).length} / ${(installation.events || []).length}`,
      `Updated: ${compactTimestamp(installation.updatedAt)}`,
    ];
  });
}

function formatAppPermissionsInspect(report) {
  const lines = [
    'GitHub app permissions inspect',
    `Target: ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'}`,
  ];

  if (!report.installation) {
    lines.push(report.githubApi?.attempted
      ? `GitHub App permissions: unavailable (${report.githubApi.error || 'unknown error'})`
      : 'GitHub App permissions: inspection skipped');
    return [...lines, ...formatWarnings(report.warnings)].join('\n');
  }

  lines.push(
    `Installation: ${report.installation.appSlug || 'unknown'} (${report.installation.repositorySelection || 'unknown'})`,
    `Permissions: ${report.permissionCount ?? 0}`,
    ...Object.entries(report.permissions || {}).map(([name, access]) => `- ${name}: ${access}`)
  );
  if (Array.isArray(report.events) && report.events.length > 0) {
    lines.push(`Events: ${report.events.join(', ')}`);
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

function formatIssueCommentDraft(report) {
  const lines = [
    'GitHub issue comment draft',
    `Target: ${(report.target?.slug || report.repoIdentity?.repoName || 'unknown')} #${report.issueNumber || '?'}`,
    `Preview: ${report.previewId || 'unknown'}`,
    `Artifacts: preview=${report.previewArtifact?.filePath || 'n/a'} approval=${report.approvalArtifact?.filePath || 'n/a'}`,
    `Review: sensitivity=${report.review?.sensitivity || 'unknown'} redactions=${report.review?.redactionCount ?? 0} reviewRequired=${report.review?.reviewRequired ? 'yes' : 'no'}`,
    `Body source: ${report.draft?.bodySource || 'unknown'}`,
  ];

  if (report.draft?.bodyPreview) {
    lines.push(`Preview text: ${report.draft.bodyPreview}`);
  }

  if (report.instructions?.cliApply) {
    lines.push(`Apply via CLI: ${report.instructions.cliApply}`);
  }

  if (report.instructions?.note) {
    lines.push(`Note: ${report.instructions.note}`);
  }

  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatPullRequestCommentDraft(report) {
  const lines = [
    'GitHub pull request comment draft',
    `Target: ${(report.target?.slug || report.repoIdentity?.repoName || 'unknown')} PR #${report.pullRequestNumber || '?'}`,
    `Preview: ${report.previewId || 'unknown'}`,
    `Artifacts: preview=${report.previewArtifact?.filePath || 'n/a'} approval=${report.approvalArtifact?.filePath || 'n/a'}`,
    `Review: sensitivity=${report.review?.sensitivity || 'unknown'} redactions=${report.review?.redactionCount ?? 0} reviewRequired=${report.review?.reviewRequired ? 'yes' : 'no'}`,
    `Body source: ${report.draft?.bodySource || 'unknown'}`,
  ];

  if (report.draft?.bodyPreview) {
    lines.push(`Preview text: ${report.draft.bodyPreview}`);
  }

  if (report.instructions?.cliApply) {
    lines.push(`Apply via CLI: ${report.instructions.cliApply}`);
  }

  if (report.instructions?.note) {
    lines.push(`Note: ${report.instructions.note}`);
  }

  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatPullRequestReviewDraft(report) {
  const lines = [
    'GitHub pull request review draft',
    `Target: ${(report.target?.slug || report.repoIdentity?.repoName || 'unknown')} PR #${report.pullRequestNumber || '?'}`,
    `Preview: ${report.previewId || 'unknown'}`,
    `Artifacts: preview=${report.previewArtifact?.filePath || 'n/a'} approval=${report.approvalArtifact?.filePath || 'n/a'}`,
    `Review: sensitivity=${report.review?.sensitivity || 'unknown'} redactions=${report.review?.redactionCount ?? 0} reviewRequired=${report.review?.reviewRequired ? 'yes' : 'no'}`,
    `Review event: ${report.draft?.reviewEvent || 'unknown'}${report.draft?.reviewEventApi ? ` (${report.draft.reviewEventApi})` : ''}`,
    `Body source: ${report.draft?.bodySource || 'unknown'}`,
  ];

  if (report.draft?.bodyPreview) {
    lines.push(`Preview text: ${report.draft.bodyPreview}`);
  }

  if (report.instructions?.cliApply) {
    lines.push(`Apply via CLI: ${report.instructions.cliApply}`);
  }

  if (report.instructions?.note) {
    lines.push(`Note: ${report.instructions.note}`);
  }

  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatPullRequestStateDraft(report) {
  const actionLabel = report.draft?.stateAction || (report.capability?.key === 'pr.reopen.draft' ? 'reopen' : 'close');
  const lines = [
    `GitHub pull request ${actionLabel} draft`,
    `Target: ${(report.target?.slug || report.repoIdentity?.repoName || 'unknown')} PR #${report.pullRequestNumber || '?'}`,
    `Preview: ${report.previewId || 'unknown'}`,
    `Artifacts: preview=${report.previewArtifact?.filePath || 'n/a'} approval=${report.approvalArtifact?.filePath || 'n/a'}`,
    `Review: sensitivity=${report.review?.sensitivity || 'unknown'} redactions=${report.review?.redactionCount ?? 0} reviewRequired=${report.review?.reviewRequired ? 'yes' : 'no'}`,
    `State change: ${actionLabel}${report.draft?.desiredState ? ` (${report.draft.desiredState})` : ''}`,
  ];

  if (report.instructions?.cliApply) {
    lines.push(`Apply via CLI: ${report.instructions.cliApply}`);
  }

  if (report.instructions?.note) {
    lines.push(`Note: ${report.instructions.note}`);
  }

  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatPullRequestCreateDraft(report) {
  const lines = [
    'GitHub pull request create draft',
    `Target: ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'}`,
    `Preview: ${report.previewId || 'unknown'}`,
    `Artifacts: preview=${report.previewArtifact?.filePath || 'n/a'} approval=${report.approvalArtifact?.filePath || 'n/a'}`,
    `Review: sensitivity=${report.review?.sensitivity || 'unknown'} redactions=${report.review?.redactionCount ?? 0} reviewRequired=${report.review?.reviewRequired ? 'yes' : 'no'}`,
    `Title: ${report.draft?.titlePreview || 'unknown'}`,
    `Branches: ${report.draft?.head || '?'} -> ${report.draft?.baseBranch || '?'}`,
    `Draft PR: ${report.draft?.draft ? 'yes' : 'no'}`,
    `Body source: ${report.draft?.bodySource || 'unknown'}`,
  ];

  if (report.draft?.bodyPreview) {
    lines.push(`Preview text: ${report.draft.bodyPreview}`);
  }

  if (report.instructions?.cliApply) {
    lines.push(`Apply via CLI: ${report.instructions.cliApply}`);
  }

  if (report.instructions?.note) {
    lines.push(`Note: ${report.instructions.note}`);
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

function formatPullRequestStatus(report) {
  const lines = [
    'GitHub pull request status',
    `Target: ${report.target?.slug || report.repoIdentity.repoName}`,
    `Branch: ${report.branchContext?.currentBranch || 'unknown'}${report.branchContext?.source ? ` (${report.branchContext.source})` : ''}${report.branchContext?.detached ? ' (detached HEAD)' : ''}`,
    `Lookup: ${report.lookup?.status || 'unknown'}${report.lookup?.headQuery ? ` (${report.lookup.headQuery})` : ''}`,
  ];

  if (report.pullRequest) {
    const pr = report.pullRequest;
    lines.push(
      `PR: #${pr.number} ${pr.title}`,
      `State: ${pr.state}${pr.draft ? ' draft' : ''}${pr.merged ? ' merged' : ''}`,
      `Author: ${pr.author?.login || 'unknown'}`,
      `Branches: ${pr.head?.ref || '?'} -> ${pr.base?.ref || '?'}`,
      `Comments: issue=${pr.comments ?? 0} review=${pr.reviewComments ?? 0}`,
      `Updated: ${compactTimestamp(pr.updatedAt)}`
    );
    if (pr.htmlUrl) {
      lines.push(`URL: ${pr.htmlUrl}`);
    }
  } else if (report.lookup?.status === 'multiple' && Array.isArray(report.pullRequests) && report.pullRequests.length > 0) {
    lines.push(...report.pullRequests.map((pr) => `- #${pr.number} ${pr.state || 'unknown'} ${truncate(pr.title, 88)} — ${pr.author?.login || '-'} — ${compactTimestamp(pr.updatedAt)}`));
  } else if (report.lookup?.status === 'not-found') {
    lines.push(`No pull request currently matches ${report.lookup?.headQuery || 'the requested branch'}.`);
  } else if (report.githubApi.attempted) {
    lines.push(`GitHub PR status: unavailable (${report.githubApi.error || 'unknown error'})`);
  } else {
    lines.push('GitHub PR status: API inspection skipped');
  }

  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatFeedbackEntryLine(entry) {
  if (!entry || typeof entry !== 'object') {
    return '- unknown feedback entry';
  }

  const author = entry.author?.login || 'unknown';
  const timestamp = compactTimestamp(entry.activityAt || entry.updatedAt || entry.submittedAt || entry.createdAt);
  const detailBits = [];
  if (entry.state) {
    detailBits.push(entry.state);
  }
  if (entry.path) {
    detailBits.push(entry.line ? `${entry.path}:${entry.line}` : entry.path);
  }
  const detailSuffix = detailBits.length > 0 ? ` (${detailBits.join(', ')})` : '';
  return `- ${author}${detailSuffix} — ${timestamp} — ${truncate(entry.bodyPreview || '(no body)', 88)}`;
}

function formatFeedbackEntries(label, entries, apiReport) {
  const lines = [`${label}:`];

  if (Array.isArray(entries) && entries.length > 0) {
    lines.push(...entries.map((entry) => formatFeedbackEntryLine(entry)));
    return lines;
  }

  if (apiReport?.attempted && apiReport?.error) {
    lines.push(`- unavailable (${apiReport.error})`);
    return lines;
  }

  if (apiReport?.attempted) {
    lines.push('- none reported within the requested limit');
    return lines;
  }

  lines.push('- API inspection skipped');
  return lines;
}

function formatPullRequestFeedback(report) {
  const lines = [
    'GitHub pull request feedback',
    `Target: ${report.target?.slug || report.repoIdentity.repoName}`,
    `Branch: ${report.branchContext?.currentBranch || 'n/a'}${report.branchContext?.source ? ` (${report.branchContext.source})` : ''}${report.branchContext?.detached ? ' (detached HEAD)' : ''}`,
    `Lookup: ${report.lookup?.status || 'unknown'}${report.lookup?.headQuery ? ` (${report.lookup.headQuery})` : ''}`,
    `Requested limit: ${report.filters?.limit ?? '?'}`,
  ];

  if (report.pullRequest) {
    const pr = report.pullRequest;
    lines.push(
      `PR: #${pr.number} ${pr.title}`,
      `State: ${pr.state}${pr.draft ? ' draft' : ''}${pr.merged ? ' merged' : ''}`,
      `Author: ${pr.author?.login || 'unknown'}`,
      `Branches: ${pr.head?.ref || '?'} -> ${pr.base?.ref || '?'}`,
      `Feedback counts: conversation=${report.feedbackSummary?.conversationCommentCount ?? 0} reviews=${report.feedbackSummary?.reviewCount ?? 0} review-comments=${report.feedbackSummary?.reviewCommentCount ?? 0}`,
      `Participants/latest: ${report.feedbackSummary?.participantCount ?? 0} / ${compactTimestamp(report.feedbackSummary?.latestActivityAt)}`
    );
    if (pr.htmlUrl) {
      lines.push(`URL: ${pr.htmlUrl}`);
    }
  } else if (report.pullRequestNumber) {
    lines.push(`PR: #${report.pullRequestNumber}`);
  } else if (report.lookup?.status === 'multiple' && Array.isArray(report.pullRequests) && report.pullRequests.length > 0) {
    lines.push(...report.pullRequests.map((pr) => `- #${pr.number} ${pr.state || 'unknown'} ${truncate(pr.title, 88)} — ${pr.author?.login || '-'} — ${compactTimestamp(pr.updatedAt)}`));
  } else if (report.lookup?.status === 'not-found') {
    lines.push(`No pull request currently matches ${report.lookup?.headQuery || 'the requested branch'}.`);
  } else if (report.githubApi.pullRequestLookup?.attempted) {
    lines.push(`GitHub PR feedback: unavailable (${report.githubApi.pullRequestLookup?.error || 'unknown error'})`);
  } else {
    lines.push('GitHub PR feedback: API inspection skipped');
  }

  if ((report.feedbackSummary?.totalCount ?? 0) > 0 || report.lookup?.status === 'matched') {
    lines.push(...formatFeedbackEntries('Conversation comments', report.conversationComments, report.githubApi?.conversationComments));
    lines.push(...formatFeedbackEntries('Reviews', report.reviews, report.githubApi?.reviews));
    lines.push(...formatFeedbackEntries('Review comments', report.reviewComments, report.githubApi?.reviewComments));
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

function formatWorkflowValidate(report) {
  const lines = [
    'GitHub workflow validate',
    `Target: ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'}`,
    `Workflow path: ${report.workflowPath || 'unknown'}`,
    `Workflow name: ${report.summary?.name || 'missing'}`,
    `Triggers/jobs: ${(report.summary?.triggers || []).join(', ') || 'none'} / ${report.summary?.jobCount ?? 0}`,
    `Validation: ${report.validation?.valid ? 'valid' : 'needs-attention'}`,
    `Policy violations: ${report.policyCheck?.violationCount ?? 0}`,
  ];

  if (Array.isArray(report.validation?.errors) && report.validation.errors.length > 0) {
    lines.push(...report.validation.errors.map((entry) => `- ${entry}`));
  }
  if (Array.isArray(report.policyCheck?.violations) && report.policyCheck.violations.length > 0) {
    lines.push(...report.policyCheck.violations.slice(0, 6).map((entry) => `- ${entry}`));
  }

  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatWorkflowPermissionsInspect(report) {
  const lines = [
    'GitHub workflow permissions inspect',
    `Target: ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'}`,
    `Workflow path: ${report.workflowPath || 'unknown'}`,
    `Top-level permissions: ${report.permissions?.hasTopLevelPermissions ? JSON.stringify(report.permissions.topLevelPermissions || {}) : 'missing'}`,
    `Write scopes: ${(report.permissions?.writeScopes || []).join(', ') || 'none'}`,
  ];

  if (Array.isArray(report.permissions?.jobs) && report.permissions.jobs.length > 0) {
    lines.push(...report.permissions.jobs.map((job) => `- ${job.id}${job.name ? ` (${job.name})` : ''}: ${job.permissions ? JSON.stringify(job.permissions) : 'inherits workflow default'}${job.environment ? ` [env ${job.environment}]` : ''}`));
  }

  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatWorkflowRequirementsInspect(report) {
  const lines = [
    'GitHub workflow requirements inspect',
    `Target: ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'}`,
    `Workflow path: ${report.workflowPath || 'unknown'}`,
    `Secrets: ${(report.requirements?.secrets || []).join(', ') || 'none'}`,
    `Vars: ${(report.requirements?.vars || []).join(', ') || 'none'}`,
    `Inputs: ${(report.requirements?.inputs || []).join(', ') || 'none'}`,
    `Environments: ${(report.requirements?.environments || []).join(', ') || 'none'}`,
    `Actions: ${(report.requirements?.actionReferences || []).length}`,
  ];

  if (Array.isArray(report.requirements?.actionReferences) && report.requirements.actionReferences.length > 0) {
    lines.push(...report.requirements.actionReferences.slice(0, 6).map((entry) => `- ${entry}`));
  }

  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatWorkflowContentDraft(report) {
  const actionLabel = report.draft?.changeOperation || (report.capability?.key === 'workflow.update.draft' ? 'update' : 'create');
  const lines = [
    `GitHub workflow ${actionLabel} draft`,
    `Target: ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'} ${report.workflowPath || ''}`.trim(),
    `Preview: ${report.previewId || 'unknown'}`,
    `Artifacts: preview=${report.previewArtifact?.filePath || 'n/a'} approval=${report.approvalArtifact?.filePath || 'n/a'}`,
    `Validation: ${report.validation?.valid ? 'valid' : 'needs-attention'} policyViolations=${report.draft?.policyViolationCount ?? 0}`,
    `Branches: ${report.draft?.headBranch || '?'} -> ${report.draft?.baseBranch || '?'}`,
    `Commit: ${report.draft?.commitMessagePreview || 'unknown'}`,
    `Pull request: ${report.draft?.pullRequestTitle || 'unknown'}`,
  ];

  if (report.instructions?.cliApply) {
    lines.push(`Apply via CLI: ${report.instructions.cliApply}`);
  }
  if (report.instructions?.note) {
    lines.push(`Note: ${report.instructions.note}`);
  }

  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

function formatWorkflowOperationDraft(report) {
  const actionLabel = String(report.draft?.type || 'workflow-operation').replace(/^workflow-/, '');
  const lines = [
    `GitHub workflow ${actionLabel} draft`,
    `Target: ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'}`,
    `Preview: ${report.previewId || 'unknown'}`,
    `Artifacts: preview=${report.previewArtifact?.filePath || 'n/a'} approval=${report.approvalArtifact?.filePath || 'n/a'}`,
  ];

  if (report.draft?.workflow) {
    lines.push(`Workflow/ref: ${report.draft.workflow} @ ${report.draft.ref || '?'}`);
    lines.push(`Inputs: ${report.draft.inputsCount ?? 0} (${report.draft.inputsSource || 'none'})`);
  }
  if (report.draft?.runId) {
    lines.push(`Run: ${report.draft.runId}${report.draft.failedOnly ? ' failed-only' : ''}`);
  }
  if (report.instructions?.cliApply) {
    lines.push(`Apply via CLI: ${report.instructions.cliApply}`);
  }
  if (report.instructions?.note) {
    lines.push(`Note: ${report.instructions.note}`);
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

function formatContextBundle(report) {
  const lines = [
    'GitHub context bundle',
    `Bundle: ${report.bundleId || 'unknown'} (${report.target?.kind || 'unknown'}${report.target?.selector ? ` ${report.target.selector}` : ''})`,
    `Target repo: ${report.target?.slug || report.repoContext?.target?.slug || report.repoContext?.repoIdentity?.repoName || 'unknown'}`,
    `Artifact: ${report.artifact?.filePath || 'n/a'}`,
    `Review: sensitivity=${report.review?.sensitivity || 'unknown'} redactions=${report.review?.redactionCount ?? 0} required=${report.review?.reviewRequired ? 'yes' : 'no'}`,
    `Components: ${report.summary?.componentCount ?? '?'}`,
  ];

  if (report.target?.kind === 'pr') {
    lines.push(
      `PR state: ${report.summary?.pullRequestState || 'unknown'}`,
      `Diff summary: files=${report.summary?.changedFileCount ?? 0} +${report.summary?.totalAdditions ?? 0} -${report.summary?.totalDeletions ?? 0}`
    );
  } else if (report.target?.kind === 'issue') {
    lines.push(`Issue state/comments: ${report.summary?.issueState || 'unknown'} / ${report.summary?.commentCount ?? 0}`);
  } else if (report.target?.kind === 'repo') {
    lines.push(`Repo summary: issues=${report.summary?.issueCount ?? 0} prs=${report.summary?.pullRequestCount ?? 0} workflowRuns=${report.summary?.workflowRunCount ?? 0}`);
  }

  if (Array.isArray(report.review?.reasons) && report.review.reasons.length > 0) {
    lines.push('Review notes:', ...report.review.reasons.map((reason) => `- ${reason}`));
  }

  return [...lines, ...formatWarnings(report.warnings)].join('\n');
}

const slashFormatters = {
  'auth.status': formatAuthStatus,
  'app.status': formatAppStatus,
  'app.installation.inspect': formatAppInstallationInspect,
  'app.permissions.inspect': formatAppPermissionsInspect,
  'capabilities.list': formatCapabilitiesList,
  'capabilities.inspect': formatCapabilityInspect,
  'codeowners.inspect': formatCodeownersInspect,
  'codeowners.create.draft': formatCodeownersDraft,
  'codeowners.update.draft': formatCodeownersDraft,
  'context.bundle': formatContextBundle,
  'event.list': formatEventList,
  'event.inspect': formatEventInspect,
  'environment.list': formatEnvironmentList,
  'environment.inspect': formatEnvironmentInspect,
  'issues.comment.draft': formatIssueCommentDraft,
  'ruleset.list': formatRulesetList,
  'ruleset.inspect': formatRulesetInspect,
  'secret.list': formatSecretList,
  'secret.inspect': formatSecretInspect,
  'template.inspect': formatTemplateInspect,
  'variable.list': formatVariableList,
  'variable.inspect': formatVariableInspect,
  'webhook.list': formatWebhookList,
  'webhook.inspect': formatWebhookInspect,
  'webhook.create.draft': formatWebhookDraft,
  'webhook.update.draft': formatWebhookDraft,
  'webhook.ping.draft': formatWebhookDraft,
  'pr.create.draft': formatPullRequestCreateDraft,
  'pr.comment.draft': formatPullRequestCommentDraft,
  'pr.review.draft': formatPullRequestReviewDraft,
  'pr.close.draft': formatPullRequestStateDraft,
  'pr.reopen.draft': formatPullRequestStateDraft,
  'plan.runs': formatPlanRuns,
  'plan.inspect': formatPlanInspect,
  'plan.build': formatPlanBuild,
  'plan.execute': formatPlanExecute,
  'plan.resume': formatPlanExecute,
  'repo.inspect': formatRepoInspect,
  'issues.list': formatIssuesList,
  'issues.inspect': formatIssueInspect,
  'pr.list': formatPullRequestList,
  'pr.status': formatPullRequestStatus,
  'pr.feedback': formatPullRequestFeedback,
  'pr.inspect': formatPullRequestInspect,
  'pr.diff': formatPullRequestDiff,
  'workflow.runs': formatWorkflowRuns,
  'workflow.inspect': formatWorkflowInspect,
  'workflow.validate': formatWorkflowValidate,
  'workflow.permissions.inspect': formatWorkflowPermissionsInspect,
  'workflow.requirements.inspect': formatWorkflowRequirementsInspect,
  'workflow.create.draft': formatWorkflowContentDraft,
  'workflow.update.draft': formatWorkflowContentDraft,
  'workflow.dispatch.draft': formatWorkflowOperationDraft,
  'workflow.rerun.draft': formatWorkflowOperationDraft,
  'workflow.cancel.draft': formatWorkflowOperationDraft,
  'releases.list': formatReleasesList,
  'releases.inspect': formatReleaseInspect,
};

function createGitHubSlashCommandHandler(dependencies = {}) {
  const tokenizeImpl = typeof dependencies.tokenize === 'function' ? dependencies.tokenize : tokenize;
  const parseLongOptionsImpl = typeof dependencies.parseLongOptions === 'function' ? dependencies.parseLongOptions : parseLongOptions;
  const env = dependencies.env || process.env;
  const getCwd = typeof dependencies.getCwd === 'function'
    ? dependencies.getCwd
    : () => String(dependencies.cwd || process.cwd());
  const aiService = dependencies.aiService || null;

  const helpText = formatHelp();
  const commandExecutor = createGitHubCommandExecutor({
    aiService,
    env,
    getCwd,
    evaluateGitHubCapabilityPolicy: dependencies.evaluateGitHubCapabilityPolicy,
    findGitHubCapability: dependencies.findGitHubCapability,
    inspectGitHubAppInstallation: dependencies.inspectGitHubAppInstallation,
    inspectGitHubAppPermissions: dependencies.inspectGitHubAppPermissions,
    inspectGitHubAppStatus: dependencies.inspectGitHubAppStatus,
    inspectGitHubCodeowners: dependencies.inspectGitHubCodeowners,
    inspectGitHubEnvironment: dependencies.inspectGitHubEnvironment,
    inspectGitHubIssue: dependencies.inspectGitHubIssue,
    inspectGitHubPullRequestFeedback: dependencies.inspectGitHubPullRequestFeedback,
    inspectGitHubPullRequest: dependencies.inspectGitHubPullRequest,
    inspectGitHubPullRequestDiff: dependencies.inspectGitHubPullRequestDiff,
    inspectGitHubPullRequestStatus: dependencies.inspectGitHubPullRequestStatus,
    draftGitHubPullRequestReview: dependencies.draftGitHubPullRequestReview,
    draftGitHubPullRequestClose: dependencies.draftGitHubPullRequestClose,
    draftGitHubPullRequestReopen: dependencies.draftGitHubPullRequestReopen,
    draftGitHubWorkflowCreate: dependencies.draftGitHubWorkflowCreate,
    draftGitHubWorkflowUpdate: dependencies.draftGitHubWorkflowUpdate,
    draftGitHubWorkflowDispatch: dependencies.draftGitHubWorkflowDispatch,
    draftGitHubWorkflowRerun: dependencies.draftGitHubWorkflowRerun,
    draftGitHubWorkflowCancel: dependencies.draftGitHubWorkflowCancel,
    inspectGitHubRelease: dependencies.inspectGitHubRelease,
    inspectGitHubRepository: dependencies.inspectGitHubRepository,
    inspectGitHubRuleset: dependencies.inspectGitHubRuleset,
    inspectGitHubSecret: dependencies.inspectGitHubSecret,
    inspectGitHubTemplates: dependencies.inspectGitHubTemplates,
    inspectGitHubVariable: dependencies.inspectGitHubVariable,
    inspectGitHubWebhook: dependencies.inspectGitHubWebhook,
    inspectGitHubWorkflowPermissions: dependencies.inspectGitHubWorkflowPermissions,
    inspectGitHubWorkflowRequirements: dependencies.inspectGitHubWorkflowRequirements,
    inspectGitHubWorkflowRun: dependencies.inspectGitHubWorkflowRun,
    listGitHubEnvironments: dependencies.listGitHubEnvironments,
    listGitHubIssues: dependencies.listGitHubIssues,
    listGitHubPullRequests: dependencies.listGitHubPullRequests,
    listGitHubReleases: dependencies.listGitHubReleases,
    listGitHubRulesets: dependencies.listGitHubRulesets,
    listGitHubSecrets: dependencies.listGitHubSecrets,
    listGitHubVariables: dependencies.listGitHubVariables,
    listGitHubWebhooks: dependencies.listGitHubWebhooks,
    listGitHubWorkflowRuns: dependencies.listGitHubWorkflowRuns,
    resolveGitHubAuthStatus: dependencies.resolveGitHubAuthStatus,
    validateGitHubWorkflow: dependencies.validateGitHubWorkflow,
    writeTelemetry: dependencies.writeTelemetry,
  });

  async function executeSlashCommand(command) {
    const parts = tokenizeImpl(String(command || '').trim());
    if ((parts[0] || '').toLowerCase() !== '/github') {
      return null;
    }

    const { positionals, options } = parseLongOptionsImpl(parts.slice(1));
    const area = normalizeArea(positionals[0]);
    const action = String(positionals[1] || '').trim().toLowerCase();
    const featureFlagEnabled = isFeatureFlagEnabled(env);
    const writeFeatureFlagEnabled = isWriteFeatureFlagEnabled(env);
    const cwd = getCwd();

    if (!area || area === 'help' || action === 'help') {
      return { type: 'info', message: helpText };
    }

    const report = await commandExecutor.execute({
      source: 'slash',
      area,
      action,
      positionals,
      options,
      cwd,
      env,
      aiService,
      featureFlagEnabled,
      writeFeatureFlagEnabled,
      executionPreferences: dependencies.executionPreferences,
    });

    const formatter = report?.capability?.key ? slashFormatters[report.capability.key] : null;

    if (report?.success === false) {
      if (report.error === 'USAGE') {
        return buildUsageResult(report.message, helpText);
      }
      if (typeof formatter === 'function') {
        return buildResult(report, formatter(report), 'error');
      }
      return buildResult(report, report.message || 'GitHub slash command failed.', 'error');
    }

    if (typeof formatter !== 'function') {
      return buildResult(report, report?.message || 'GitHub slash command completed.');
    }

    return buildResult(report, formatter(report));
  }

  return {
    executeSlashCommand,
    formatHelp,
  };
}

module.exports = {
  createGitHubSlashCommandHandler,
};
