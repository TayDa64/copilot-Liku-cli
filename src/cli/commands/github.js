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
  if (value === 'rulesets') return 'ruleset';
  if (value === 'environments') return 'environment';
  if (value === 'events') return 'event';
  if (value === 'secrets') return 'secret';
  if (value === 'variables') return 'variable';
  if (value === 'codeowner') return 'codeowners';
  if (value === 'templates') return 'template';
  if (value === 'hooks') return 'webhook';
  if (value === 'webhooks') return 'webhook';
  if (value === 'apps') return 'app';
  return value;
}

function showHelp() {
  console.log(`
${bold('liku github')} — GitHub diagnostics, reviewed previews, and explicit apply flows

${highlight('USAGE:')}
  liku github auth status
  liku github capabilities list
  liku github capabilities inspect pr.diff
  liku github context bundle pr 123 --slug owner/repo
  liku github context bundle issue 321 --slug owner/repo
  liku github context bundle repo --limit 5 --out-file C:\\Users\\you\\bundle.json
  liku github issues comment draft 321 --body "Thanks for the report" --slug owner/repo
  liku github pr create draft --title "Add overlay diagnostics" --body "Implements the next PR slice" --base main --slug owner/repo
  liku github issues comment draft 321 --body-file C:\\Users\\you\\comment.md --slug owner/repo
    liku github pr comment draft 123 --body "Looks good overall" --slug owner/repo
    liku github pr comment draft 123 --body-file C:\\Users\\you\\review.md --slug owner/repo
  liku github apply github-write-preview-123 --approve --approval-file C:\\Users\\you\\.liku\\github\\writes\\github-write-preview-123.approval.json
  liku github plan build pr diff 123 --limit 50
  liku github plan execute pr diff 123 --limit 50
  liku github plan execute --plan-file C:\\Users\\you\\.liku\\github\\plans\\github-plan-example.plan.json
    liku github plan resume --guidance-file C:\\Users\\you\\.liku\\github\\plans\\github-plan-example.github-run-123.guidance.json --resume-token <token> --answers-json {"base-branch":"main"}
  liku github plan runs --slug owner/repo --limit 10 --state blocked
  liku github plan inspect github-run-123 --slug owner/repo
  liku github repo inspect
  liku github ruleset list --slug owner/repo --limit 10
  liku github ruleset inspect 12 --slug owner/repo
  liku github environment list --slug owner/repo --limit 10
  liku github environment inspect production --slug owner/repo
  liku github secret list --slug owner/repo --api false --json
  liku github variable inspect FEATURE_FLAG --slug owner/repo --api false --json
  liku github codeowners inspect --api false
  liku github codeowners create draft --body-file C:\\Users\\you\\CODEOWNERS --base main --slug owner/repo
  liku github codeowners update draft --body-file C:\Users\you\CODEOWNERS --base main --slug owner/repo
  liku github template inspect --api false
  liku github webhook list --slug owner/repo --limit 10
  liku github webhook inspect 9001 --slug owner/repo
  liku github webhook create draft --events push,pull_request,workflow_run --target-url https://assistant.example.com/github/webhook --secret-ref repo:LIKU_WEBHOOK_SECRET --content-type json --slug owner/repo
  liku github webhook update draft 9001 --events workflow_run,pull_request_review --target-url https://assistant.example.com/github/webhook --secret-ref repo:LIKU_WEBHOOK_SECRET --slug owner/repo
  liku github webhook ping draft 9001 --slug owner/repo
  liku github event list --slug owner/repo --limit 10 --event push
  liku github event inspect github-event-123 --slug owner/repo
  liku github app status --slug owner/repo
  liku github app installation inspect --slug owner/repo
  liku github app permissions inspect --slug owner/repo
  liku github issues list
  liku github issues inspect <number>
  liku github pr list
  liku github pr status --branch feature/demo --slug owner/repo
  liku github pr view --branch feature/demo --slug owner/repo
  liku github pr feedback --branch feature/demo --slug owner/repo
  liku github pr feedback 123 --limit 5 --slug owner/repo
  liku github pr review draft 123 --event approve --body "Looks good overall" --slug owner/repo
  liku github pr close draft 123 --slug owner/repo
  liku github pr reopen draft 123 --slug owner/repo
  liku github pr create draft --title "Add overlay diagnostics" --base main --head feature/demo --slug owner/repo
  liku github pr inspect <number>
  liku github pr diff <number>
  liku github workflow runs
  liku github workflow inspect <run-id>
  liku github workflow validate .github/workflows/ci.yml
  liku github workflow permissions inspect .github/workflows/ci.yml
  liku github workflow requirements inspect .github/workflows/ci.yml
  liku github workflow create draft .github/workflows/ci.yml --body-file C:\Users\you\ci.yml --slug owner/repo
  liku github workflow update draft .github/workflows/ci.yml --body-file C:\Users\you\ci.yml --slug owner/repo
  liku github workflow dispatch draft ci.yml --ref main --slug owner/repo
  liku github workflow rerun draft 9001 --slug owner/repo
  liku github workflow cancel draft 9001 --slug owner/repo
  liku github releases list
  liku github releases inspect <latest|tag|id>
  liku github auth status --probe false --json
  liku github repo inspect --api false --json
  liku github issues list --state all --limit 20
  liku github issues inspect 321 --slug owner/repo
  liku github pr list --state all --limit 20
  liku github pr status --branch feature/demo --slug owner/repo
  liku github pr feedback --branch feature/demo --slug owner/repo --limit 5
  liku github pr review draft 123 --event request-changes --body "Please add a regression test." --slug owner/repo
  liku github pr close draft 123 --slug owner/repo
  liku github pr reopen draft 123 --slug owner/repo
  liku github pr create draft --title "Add overlay diagnostics" --base main --head feature/demo --slug owner/repo
  liku github pr inspect 123 --slug owner/repo
  liku github pr diff 123 --limit 50
  liku github workflow runs --workflow ci.yml --limit 10
  liku github workflow inspect 9001 --slug owner/repo
  liku github workflow validate .github/workflows/ci.yml --body-file C:\Users\you\ci.yml --slug owner/repo
  liku github workflow permissions inspect .github/workflows/ci.yml --slug owner/repo
  liku github workflow requirements inspect .github/workflows/ci.yml --slug owner/repo
  liku github workflow create draft .github/workflows/ci.yml --body-file C:\Users\you\ci.yml --base main --slug owner/repo
  liku github workflow update draft .github/workflows/ci.yml --body-file C:\Users\you\ci.yml --base main --slug owner/repo
  liku github workflow dispatch draft ci.yml --ref main --inputs-json {"target":"staging"} --slug owner/repo
  liku github workflow rerun draft 9001 --failed-only true --slug owner/repo
  liku github workflow cancel draft 9001 --slug owner/repo
  liku github releases list --limit 5 --slug owner/repo
  liku github releases inspect latest --slug owner/repo
  liku github issues comment draft 321 --body "Please retest with 0.0.16" --json
  liku github apply github-write-preview-123 --approve --approval-file C:\\Users\\you\\.liku\\github\\writes\\github-write-preview-123.approval.json --json

${highlight('COMMANDS:')}
  auth status    Inspect Copilot/GitHub auth state without mutating anything
  capabilities list    List registered GitHub capabilities and policy metadata
  capabilities inspect Inspect one registered GitHub capability by key
  context bundle Build a reviewed, sanitized GitHub context bundle for PR, issue, or repo context
  apply          Apply one reviewed GitHub write preview artifact from the CLI
  plan build     Build a deterministic one-step execution plan for a registered GitHub capability
  plan execute   Execute a deterministic read-only GitHub plan within bounded budgets
  plan resume    Resume a blocked read-only GitHub plan from a saved guidance checkpoint
  plan runs      List locally recorded GitHub plan runs from the durable plan ledger
  plan inspect   Inspect one locally recorded GitHub plan run from the durable plan ledger
  repo inspect   Inspect the current repository identity and GitHub metadata
  ruleset list   List repository rulesets and summarize enforcement metadata
  ruleset inspect Inspect one repository ruleset by id
  environment list List repository environments and summarize protection metadata
  environment inspect Inspect one repository environment by name
  secret list    List repository Actions secrets as metadata-only inventory
  secret inspect Inspect one repository Actions secret as metadata-only inventory
  variable list  List repository Actions variables as metadata-only inventory
  variable inspect Inspect one repository Actions variable as metadata-only inventory
  codeowners inspect Inspect CODEOWNERS from the current workspace or standard GitHub locations
  codeowners create draft Create a reviewed local preview for adding a CODEOWNERS file through a dedicated branch and draft pull request
  codeowners update draft Create a reviewed local preview for updating the detected CODEOWNERS file through a dedicated branch and draft pull request
  template inspect Inspect issue and pull request templates from the current workspace or GitHub contents
  webhook list   List repository webhooks as metadata-only inventory
  webhook inspect Inspect one repository webhook as metadata-only inventory
  webhook create draft Create a reviewed local preview for creating one repository webhook without mutating GitHub yet
  webhook update draft Create a reviewed local preview for updating one repository webhook without mutating GitHub yet
  webhook ping draft Create a reviewed local preview for pinging one repository webhook without mutating GitHub yet
  event list     List locally recorded GitHub webhook events from the durable event journal
  event inspect  Inspect one locally recorded GitHub webhook event from the durable event journal
  app status     Summarize GitHub auth posture and App installation visibility for the target repository
  app installation inspect Inspect the GitHub App installation metadata for the target repository
  app permissions inspect Inspect the GitHub App installation permissions and subscribed events
  issues list    List issues for the current or specified GitHub repo
  issues inspect Inspect one issue by number
  issues comment draft Create a reviewed local preview for one issue comment without mutating GitHub yet
  pr list        List pull requests for the current or specified GitHub repo
  pr status      Show the pull-request status for the current or requested branch (alias: pr view)
  pr feedback    Summarize pull-request conversation comments, reviews, and review comments
  pr review draft Create a reviewed local preview for one pull-request review submission without mutating GitHub yet
  pr close draft Create a reviewed local preview for closing one pull request without mutating GitHub yet
  pr reopen draft Create a reviewed local preview for reopening one pull request without mutating GitHub yet
  pr create draft Create a reviewed local preview for one pull request creation without mutating GitHub yet
  pr inspect     Inspect one pull request by number
  pr diff        Summarize changed files for one pull request
  pr comment draft Create a reviewed local preview for one pull-request conversation comment without mutating GitHub yet
  workflow runs  List workflow runs for the current or specified repo
  workflow inspect Inspect one workflow run by id
  workflow validate Validate one workflow definition and summarize hardening findings without mutating GitHub
  workflow permissions inspect Inspect top-level and per-job workflow permissions without mutating GitHub
  workflow requirements inspect Inspect workflow secrets, vars, inputs, environments, and action refs
  workflow create draft Create a reviewed local preview for adding one workflow file through a dedicated branch and draft pull request
  workflow update draft Create a reviewed local preview for updating one workflow file through a dedicated branch and draft pull request
  workflow dispatch draft Create a reviewed local preview for dispatching one workflow run without mutating GitHub yet
  workflow rerun draft Create a reviewed local preview for rerunning one workflow run without mutating GitHub yet
  workflow cancel draft Create a reviewed local preview for canceling one workflow run without mutating GitHub yet
  releases list  List releases for the current or specified repo
  releases inspect Inspect one release by latest, tag, or numeric id

${highlight('OPTIONS:')}
  --json         Output machine-readable JSON
  --probe <bool> Enable or disable the live GitHub /user probe for auth status (default: true)
  --api <bool>   Enable or disable GitHub API lookup for repo inspect (default: true)
  --slug <owner/repo> Target a specific GitHub repository instead of the detected git remote
  --state <value> Filter issue lists (open|closed|all) or plan runs (completed|blocked|aborted|all)
  --limit <n>    Bound issue/PR/workflow/event/release results (default: 10)
  --labels <csv> Filter issue lists by label names
  --base <name>  Filter pull-request lists or set the base branch for 'pr create draft'
  --head <name>  Filter pull-request lists, override 'pr status', or set the head branch for 'pr create draft'
  --title <text> Title text for 'pr create draft'
  --path <path>  Relative workflow file path or CODEOWNERS path for workflow/codeowners validate or draft commands
  --body <text>  Inline body text for reviewed draft commands or inline workflow YAML for workflow validate/create/update
  --body-file <path> File containing a reviewed draft body or workflow YAML content for workflow validate/create/update
  --draft <bool> Create the pull request as a GitHub draft when applying 'pr create draft'
  --approve      Explicitly approve a pending reviewed GitHub write preview for apply
  --apply-token <token> Opaque apply token returned during preview creation (CLI only)
  --approval-file <path> Approval artifact file written during preview creation
  --workflow <id|file> Filter workflow runs to one workflow id or file name
  --branch <name> Filter workflow runs to one branch or override the current branch for 'pr status'
  --events <csv> Comma-separated webhook events for 'webhook create draft' or 'webhook update draft'
  --target-url <url> Destination URL for 'webhook create draft' or 'webhook update draft'
  --secret-ref <repo:ENV_NAME> Secret reference resolved from local env during webhook apply
  --content-type <json|form> Delivery content type for 'webhook create draft' or 'webhook update draft'
  --active <bool> Enable or disable the webhook when previewing webhook create/update
  --ref <value>  Branch, tag, or SHA used when previewing 'workflow dispatch draft'
  --inputs-json <json> Inline JSON object passed to 'workflow dispatch draft'
  --inputs-file <path> JSON file passed to 'workflow dispatch draft'
  --failed-only <bool> Restrict 'workflow rerun draft' to failed jobs only
  --status <value> Filter workflow runs by status/conclusion-compatible value
  --event <name> Filter workflow runs by triggering event, filter 'event list' results, or set the review event for 'pr review draft'
  --out-file <path> Write a reviewed context bundle artifact to an explicit file path
  --plan-file <path> Replay a saved GitHub plan artifact during execute or attach one explicitly during plan inspect
  --event-log-file <path> Attach an explicit saved GitHub plan event log during plan inspect
  --guidance-file <path> Resume a blocked GitHub plan from a saved guidance checkpoint artifact
  --resume-token <token> Single-use token that authorizes one blocked plan resume
  --answers-file <path> JSON file containing guidance answers keyed by question id
  --answers-json <json> Inline JSON object containing guidance answers keyed by question id

${highlight('NOTES:')}
  - The Phase 2 read-only commands remain unchanged.
  - Governance inventory surfaces are repo-scoped, read-only, and fail soft when tokens or repo-admin scopes are missing.
  - Secrets, variables, and webhook config stay metadata-only in model-visible output; values and sensitive config are redacted.
  - 'codeowners inspect' and 'template inspect' prefer the current workspace when it matches the target repo and can run offline with --api false.
  - 'codeowners create draft' and 'codeowners update draft' preview repo-content patches that apply via a dedicated branch plus draft pull request instead of mutating the default branch directly.
  - 'webhook create draft' and 'webhook update draft' persist only repo:<ENV_NAME> secret refs; the actual webhook secret is resolved from the local environment during CLI apply.
  - 'webhook ping draft' previews a single test delivery through the same reviewed CLI-only apply seam.
  - 'event list' and 'event inspect' read the local GitHub event journal under the Liku home directory; this Phase 10B slice provides durable storage and inspection only, not a live webhook receiver.
  - 'issues comment draft ...' writes a reviewed, sanitized local preview artifact under the Liku home directory.
  - 'pr create draft ...' writes a reviewed, sanitized local preview artifact under the Liku home directory.
  - 'pr comment draft ...' writes a reviewed, sanitized local preview artifact under the Liku home directory.
  - 'pr status' defaults to the current git branch; 'pr view' is an alias for the same branch-associated lookup.
  - 'pr feedback' accepts an explicit PR number or defaults to the branch-associated lookup used by 'pr status'.
  - 'pr review draft' accepts --event comment|approve|request-changes; approve may omit a body, while comment/request-changes require one.
  - 'pr close draft' and 'pr reopen draft' preview reversible PR state changes before the CLI apply step.
  - 'pr create draft' defaults the head branch to the current git branch and can derive the base branch from the repository default branch when API lookup is allowed.
  - 'workflow validate', 'workflow permissions inspect', and 'workflow requirements inspect' analyze workflow text locally and reuse the same hardening-policy rules enforced by the repository verification script.
  - 'workflow create draft' and 'workflow update draft' preview repo-content patches that apply via a dedicated branch plus draft pull request instead of mutating the default branch directly.
  - 'workflow dispatch draft', 'workflow rerun draft', and 'workflow cancel draft' reuse the reviewed preview/apply seam for GitHub Actions operational commands.
  - 'github apply ...' is CLI-only in the current reviewed GitHub write slice and requires both LIKU_ENABLE_GITHUB=1 and LIKU_ENABLE_GITHUB_WRITES=1.
  - Every GitHub command is registered with capability metadata and passes a policy gate before execution.
  - The context bundle path writes a reviewed, sanitized local artifact under the Liku home directory unless --out-file is provided.
  - The plan execute path writes replayable plan/result artifacts under the Liku home directory.
  - The plan resume path reads a saved guidance checkpoint and continues the bounded run without replaying completed steps.
  - 'plan runs' and 'plan inspect' read the local GitHub plan ledger under the Liku home directory; this Phase 10C slice adds durable run inspection only, not a new orchestration or apply path.
  - Slash commands may create reviewed previews, but actual apply remains intentionally CLI-only in this slice.
  - GH_TOKEN or GITHUB_TOKEN improves private-repo and authenticated REST inspection.
  - Existing Copilot auth state is reused when available, but GitHub REST prefers GH_TOKEN/GITHUB_TOKEN.
`);
}

function isGitHubFeatureFlagEnabled(options) {
  return options?.featureFlags?.enableGitHub === true;
}

function isGitHubWriteFeatureFlagEnabled(options) {
  return options?.featureFlags?.enableGitHubWrites === true;
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

  if (Array.isArray(report.governanceAccess?.hints) && report.governanceAccess.hints.length > 0) {
    console.log(`${highlight('Governance hints:')}`);
    report.governanceAccess.hints.forEach((hint) => console.log(`  - ${hint.title}`));
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
  const heading = report?.capability?.key === 'plan.resume' ? 'GitHub plan resume' : 'GitHub plan execute';
  console.log(`\n${bold(heading)}\n`);

  if (!report.execution || !Array.isArray(report.stepResults)) {
    warn(report.message || 'GitHub execution plan did not run.');
    if (report.planArtifact?.filePath) {
      console.log(`${highlight('Plan artifact:')} ${report.planArtifact.filePath}`);
    }
    return;
  }

  console.log(`${highlight('Bounded executor:')} ${report.boundedExecutor?.mode || 'unknown'} via ${report.boundedExecutor?.source || 'unknown'}`);
  console.log(`${highlight('Run:')} ${report.run?.runId || 'unknown'} (${report.run?.status || report.status || 'unknown'})`);
  console.log(`${highlight('Event log:')} ${report.eventLog?.filePath || 'n/a'}`);
  console.log(`${highlight('Replay command:')} ${report.boundedExecutor?.replayCommand || dim('unavailable')}`);
  console.log(`${highlight('Plan source:')} ${report.execution.planSource || 'unknown'}`);
  console.log(`${highlight('Budget:')} maxSteps=${report.planSummary?.budget?.maxSteps ?? '?'} timeoutMs=${report.planSummary?.budget?.timeoutMs ?? '?'}`);
  console.log(`${highlight('Artifacts:')} plan=${report.planArtifact?.filePath || 'n/a'} result=${report.resultArtifact?.filePath || 'n/a'}`);

  if (report.status === 'needs-guidance') {
    console.log(`${highlight('Guidance:')} ${report.guidanceArtifact?.filePath || 'n/a'}`);
    console.log(`${highlight('Resume token:')} ${report.resume?.resumeToken || 'n/a'}`);
  }

  table(
    report.stepResults.map((step) => [
      step.stepId || '-',
      step.capabilityKey || '-',
      step.success ? 'success' : 'failure',
      step.schemaVersion || '-',
    ]),
    ['Step', 'Capability', 'Result', 'Schema']
  );

  console.log(`\n${highlight('Execution summary:')} status=${report.execution.status || report.status || 'unknown'} elapsedMs=${report.execution.elapsedMs ?? '?'} stepsExecuted=${report.execution.stepsExecuted ?? '?'} timedOut=${report.execution.timedOut ? 'yes' : 'no'}`);
}

function printPlanRuns(report) {
  console.log(`\n${bold('GitHub plan runs')}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'}`);
  console.log(`${highlight('Artifact dir:')} ${report.artifactDir || 'n/a'}`);
  console.log(`${highlight('Filters:')} limit=${report.filters?.limit ?? '?'} state=${report.filters?.state || 'all'}`);

  const runs = Array.isArray(report.runs) ? report.runs : [];
  if (runs.length > 0) {
    runs.forEach((run) => {
      const capability = run.targetCapability?.key || 'unknown';
      const slug = run.slug || report.target?.slug || 'unknown';
      const guidance = run.guidance?.status ? ` guidance=${run.guidance.status}` : '';
      const updatedAt = run.lastUpdatedAt || run.createdAt || null;
      console.log(`- ${run.runId || 'unknown'} — ${run.state || 'unknown'} — ${capability} — ${slug} — updated=${relativeIsoTimestamp(updatedAt)}${guidance}`);
    });
  } else {
    console.log(dim('No locally recorded GitHub plan runs matched the requested filters.'));
  }

  printWarnings(report.warnings);
}

function printPlanInspect(report) {
  console.log(`\n${bold('GitHub plan inspect')}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity?.repoName || report.run?.slug || 'unknown'}`);

  if (!report.run) {
    warn(report.message || 'GitHub plan run was not found.');
    if (report.artifactDir) {
      console.log(`${highlight('Artifact dir:')} ${report.artifactDir}`);
    }
    printWarnings(report.warnings);
    return;
  }

  console.log(`${highlight('Run:')} ${report.run.runId || 'unknown'} (${report.run.state || 'unknown'})`);
  console.log(`${highlight('Capability:')} ${report.run.targetCapability?.key || 'unknown'}`);
  if (report.run.goal) {
    console.log(`${highlight('Goal:')} ${report.run.goal}`);
  }
  console.log(`${highlight('Artifacts:')} plan=${report.planArtifact?.filePath || 'n/a'} result=${report.resultArtifact?.filePath || 'n/a'} guidance=${report.guidanceArtifact?.filePath || 'n/a'}`);
  console.log(`${highlight('Event log:')} ${report.eventLog?.filePath || 'n/a'}${report.eventLog?.eventCount ? ` (${report.eventLog.eventCount} events)` : ''}`);

  if (report.execution) {
    console.log(`${highlight('Execution:')} status=${report.execution.status || report.run.state || 'unknown'} source=${report.run.planSource || 'unknown'} steps=${report.execution.stepsExecuted ?? report.run.stepsExecuted ?? '?'} elapsedMs=${report.execution.elapsedMs ?? '?'} timedOut=${report.execution.timedOut ? 'yes' : 'no'}`);
  }
  if (report.run.latestEventName) {
    console.log(`${highlight('Latest event:')} ${report.run.latestEventName}${report.run.latestEventAt ? ` at ${relativeIsoTimestamp(report.run.latestEventAt)}` : ''}`);
  }
  if (report.guidance) {
    console.log(`${highlight('Guidance:')} ${report.guidance.status || 'unknown'}${report.guidance.reason ? ` (${report.guidance.reason})` : ''}`);
    if (report.guidance.resumeToken) {
      console.log(`${highlight('Resume token:')} ${report.guidance.resumeToken}`);
    }
  }
  if (report.plan?.requestedTarget) {
    const requestedTarget = report.plan.requestedTarget;
    console.log(`${highlight('Requested target:')} ${requestedTarget.area || 'unknown'} ${requestedTarget.action || 'unknown'}`.trim());
  }

  if (Array.isArray(report.stepResults) && report.stepResults.length > 0) {
    table(
      report.stepResults.map((step) => [
        step.stepId || '-',
        step.capabilityKey || '-',
        step.success ? 'success' : 'failure',
        step.schemaVersion || '-',
      ]),
      ['Step', 'Capability', 'Result', 'Schema']
    );
  }

  printWarnings(report.warnings);
}

function printContextBundle(report) {
  console.log(`\n${bold('GitHub context bundle')}\n`);
  console.log(`${highlight('Bundle:')} ${report.bundleId || 'unknown'} (${report.target?.kind || 'unknown'}${report.target?.selector ? ` ${report.target.selector}` : ''})`);
  console.log(`${highlight('Target repo:')} ${report.target?.slug || report.repoContext?.target?.slug || report.repoContext?.repoIdentity?.repoName || 'unknown'}`);
  console.log(`${highlight('Artifact:')} ${report.artifact?.filePath || 'n/a'}`);
  console.log(`${highlight('Review:')} sensitivity=${report.review?.sensitivity || 'unknown'} redactions=${report.review?.redactionCount ?? 0} reviewRequired=${report.review?.reviewRequired ? 'yes' : 'no'}`);
  console.log(`${highlight('Components:')} ${report.summary?.componentCount ?? '?'}`);

  if (report.target?.kind === 'pr') {
    console.log(`${highlight('PR state:')} ${report.summary?.pullRequestState || 'unknown'}`);
    console.log(`${highlight('Diff summary:')} files=${report.summary?.changedFileCount ?? 0} +${report.summary?.totalAdditions ?? 0} -${report.summary?.totalDeletions ?? 0}`);
  } else if (report.target?.kind === 'issue') {
    console.log(`${highlight('Issue state/comments:')} ${report.summary?.issueState || 'unknown'} / ${report.summary?.commentCount ?? 0}`);
  } else if (report.target?.kind === 'repo') {
    console.log(`${highlight('Repo summary:')} issues=${report.summary?.issueCount ?? 0} prs=${report.summary?.pullRequestCount ?? 0} workflowRuns=${report.summary?.workflowRunCount ?? 0}`);
  }

  if (Array.isArray(report.review?.reasons) && report.review.reasons.length > 0) {
    console.log(`\n${highlight('Review notes:')}`);
    report.review.reasons.forEach((reason) => console.log(`- ${reason}`));
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

function printInventoryList(title, report, collectionKey, formatItem, emptyMessage) {
  console.log(`\n${bold(title)}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'}`);
  if (report.filters?.limit) {
    console.log(`${highlight('Filters:')} limit=${report.filters.limit}`);
  }

  const items = Array.isArray(report[collectionKey]) ? report[collectionKey] : [];
  if (items.length > 0) {
    items.forEach((item) => console.log(`- ${formatItem(item)}`));
  } else if (report.githubApi?.attempted && !report.githubApi?.error) {
    console.log(dim(emptyMessage));
  } else if (report.githubApi?.attempted) {
    console.log(`${highlight(title + ':')} unavailable ${dim(report.githubApi.error || 'unknown error')}`);
  } else {
    console.log(`${highlight(title + ':')} ${dim('inspection skipped')}`);
  }

  printWarnings(report.warnings);
}

function printInventoryInspect(title, report, key, missingLabel, renderDetails) {
  console.log(`\n${bold(title)}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'}`);

  const entry = report[key];
  if (!entry) {
    if (report.githubApi?.attempted) {
      console.log(`${highlight(missingLabel + ':')} unavailable ${dim(report.githubApi.error || 'unknown error')}`);
    } else {
      console.log(`${highlight(missingLabel + ':')} ${dim('inspection skipped')}`);
    }
    printWarnings(report.warnings);
    return;
  }

  renderDetails(entry, report);
  printWarnings(report.warnings);
}

function printRulesetList(report) {
  printInventoryList('GitHub ruleset list', report, 'rulesets', (ruleset) => {
    return `#${ruleset.id ?? '?'} ${ruleset.enforcement || 'unknown'} ${ruleset.name || 'unnamed'} — target=${ruleset.target || 'unknown'} rules=${ruleset.rulesCount ?? 0} updated=${relativeIsoTimestamp(ruleset.updatedAt)}`;
  }, 'No rulesets were reported for the requested repository.');
}

function printRulesetInspect(report) {
  printInventoryInspect('GitHub ruleset inspect', report, 'ruleset', 'GitHub ruleset', (ruleset) => {
    console.log(`${highlight('Ruleset:')} #${ruleset.id ?? '?'} ${ruleset.name || 'unnamed'}`);
    console.log(`${highlight('Target/source:')} ${ruleset.target || 'unknown'} / ${ruleset.sourceType || 'unknown'}${ruleset.source ? ` (${ruleset.source})` : ''}`);
    console.log(`${highlight('Enforcement:')} ${ruleset.enforcement || 'unknown'}${ruleset.currentUserCanBypass ? ' (viewer can bypass)' : ''}`);
    console.log(`${highlight('Rules:')} ${ruleset.rulesCount ?? 0}${Array.isArray(ruleset.ruleTypes) && ruleset.ruleTypes.length > 0 ? ` (${ruleset.ruleTypes.join(', ')})` : ''}`);
    console.log(`${highlight('Bypass actors:')} ${ruleset.bypassActorCount ?? 0}`);
    if (ruleset.conditions?.refName?.include?.length) {
      console.log(`${highlight('Ref include:')} ${ruleset.conditions.refName.include.join(', ')}`);
    }
    if (ruleset.conditions?.refName?.exclude?.length) {
      console.log(`${highlight('Ref exclude:')} ${ruleset.conditions.refName.exclude.join(', ')}`);
    }
    console.log(`${highlight('Updated:')} ${relativeIsoTimestamp(ruleset.updatedAt)}`);
  });
}

function printEnvironmentList(report) {
  printInventoryList('GitHub environment list', report, 'environments', (environment) => {
    return `${environment.name || 'unnamed'} — protections=${environment.protectionRuleCount ?? 0} reviewers=${environment.reviewerCount ?? 0} wait=${environment.waitTimer ?? 0}m updated=${relativeIsoTimestamp(environment.updatedAt)}`;
  }, 'No environments were reported for the requested repository.');
}

function printEnvironmentInspect(report) {
  printInventoryInspect('GitHub environment inspect', report, 'environment', 'GitHub environment', (environment) => {
    console.log(`${highlight('Environment:')} ${environment.name || 'unnamed'}`);
    console.log(`${highlight('Protection rules:')} ${environment.protectionRuleCount ?? 0}`);
    console.log(`${highlight('Reviewers/wait timer:')} ${(environment.reviewerCount ?? 0)} / ${(environment.waitTimer ?? 0)}m`);
    if (environment.deploymentBranchPolicy) {
      console.log(`${highlight('Deployment branches:')} protected=${environment.deploymentBranchPolicy.protectedBranches ? 'yes' : 'no'} custom=${environment.deploymentBranchPolicy.customBranchPolicies ? 'yes' : 'no'}`);
    }
    console.log(`${highlight('Admin bypass:')} ${environment.canAdminsBypass ? 'yes' : 'no'}`);
    console.log(`${highlight('Updated:')} ${relativeIsoTimestamp(environment.updatedAt)}`);
  });
}

function printSecretList(report) {
  printInventoryList('GitHub secret list', report, 'secrets', (secret) => {
    return `${secret.name || 'unnamed'} — visibility=${secret.visibility || 'unknown'} selectedRepos=${secret.selectedRepositoriesCount ?? 0} updated=${relativeIsoTimestamp(secret.updatedAt)}`;
  }, 'No Actions secrets were reported for the requested repository.');
}

function printSecretInspect(report) {
  printInventoryInspect('GitHub secret inspect', report, 'secret', 'GitHub secret', (secret) => {
    console.log(`${highlight('Secret:')} ${secret.name || 'unnamed'}`);
    console.log(`${highlight('Visibility:')} ${secret.visibility || 'unknown'}`);
    console.log(`${highlight('Selected repositories:')} ${secret.selectedRepositoriesCount ?? 0}`);
    console.log(`${highlight('Updated:')} ${relativeIsoTimestamp(secret.updatedAt)}`);
    console.log(`${highlight('Values:')} redacted (metadata only)`);
  });
}

function printVariableList(report) {
  printInventoryList('GitHub variable list', report, 'variables', (variable) => {
    return `${variable.name || 'unnamed'} — visibility=${variable.visibility || 'unknown'} selectedRepos=${variable.selectedRepositoriesCount ?? 0} updated=${relativeIsoTimestamp(variable.updatedAt)}`;
  }, 'No Actions variables were reported for the requested repository.');
}

function printVariableInspect(report) {
  printInventoryInspect('GitHub variable inspect', report, 'variable', 'GitHub variable', (variable) => {
    console.log(`${highlight('Variable:')} ${variable.name || 'unnamed'}`);
    console.log(`${highlight('Visibility:')} ${variable.visibility || 'unknown'}`);
    console.log(`${highlight('Selected repositories:')} ${variable.selectedRepositoriesCount ?? 0}`);
    console.log(`${highlight('Updated:')} ${relativeIsoTimestamp(variable.updatedAt)}`);
    console.log(`${highlight('Values:')} redacted (metadata only)`);
  });
}

function printCodeownersInspect(report) {
  console.log(`\n${bold('GitHub CODEOWNERS inspect')}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'}`);

  if (!report.codeowners) {
    console.log(`${highlight('CODEOWNERS:')} ${dim('not found in standard locations')}`);
    printWarnings(report.warnings);
    return;
  }

  console.log(`${highlight('Path/source:')} ${report.codeowners.path || 'unknown'} / ${report.codeowners.source || 'unknown'}`);
  console.log(`${highlight('Entries/owners:')} ${(report.codeowners.entryCount ?? 0)} / ${(report.codeowners.ownerCount ?? 0)}`);
  if (Array.isArray(report.codeowners.owners) && report.codeowners.owners.length > 0) {
    console.log(`${highlight('Owners:')} ${report.codeowners.owners.join(', ')}`);
  }
  if (Array.isArray(report.codeowners.entries) && report.codeowners.entries.length > 0) {
    console.log(`${highlight('Preview:')}`);
    report.codeowners.entries.forEach((entry) => console.log(`  - ${entry.preview}`));
  }

  printWarnings(report.warnings);
}

function printCodeownersDraft(report) {
  const actionLabel = report.draft?.changeOperation || (report.capability?.key === 'codeowners.update.draft' ? 'update' : 'create');
  console.log(`\n${bold(`GitHub CODEOWNERS ${actionLabel} draft`)}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'} ${report.codeownersPath || report.draft?.codeownersPath || ''}`.trim());
  console.log(`${highlight('Preview:')} ${report.previewId || 'unknown'}`);
  console.log(`${highlight('Artifacts:')} preview=${report.previewArtifact?.filePath || 'n/a'} approval=${report.approvalArtifact?.filePath || 'n/a'}`);
  console.log(`${highlight('Review:')} sensitivity=${report.review?.sensitivity || 'unknown'} redactions=${report.review?.redactionCount ?? 0} reviewRequired=${report.review?.reviewRequired ? 'yes' : 'no'}`);
  console.log(`${highlight('Branches:')} ${report.draft?.headBranch || '?'} -> ${report.draft?.baseBranch || '?'}`);
  console.log(`${highlight('Commit:')} ${report.draft?.commitMessagePreview || dim('unknown')}`);
  console.log(`${highlight('Pull request:')} ${report.draft?.pullRequestTitle || dim('unknown')}`);
  console.log(`${highlight('Entries/owners:')} ${(report.draft?.entryCount ?? 0)} / ${(report.draft?.ownerCount ?? 0)}`);
  if (Array.isArray(report.draft?.owners) && report.draft.owners.length > 0) {
    console.log(`${highlight('Owners:')} ${report.draft.owners.join(', ')}`);
  }
  if (Array.isArray(report.codeowners?.entries) && report.codeowners.entries.length > 0) {
    console.log(`${highlight('Preview:')}`);
    report.codeowners.entries.forEach((entry) => console.log(`  - ${entry.preview}`));
  }
  if (report.instructions?.cliApply) {
    console.log(`${highlight('CLI apply:')} ${report.instructions.cliApply}`);
  }
  if (report.instructions?.note) {
    console.log(`${highlight('Note:')} ${report.instructions.note}`);
  }
  printWarnings(report.warnings);
}

function printTemplateInspect(report) {
  console.log(`\n${bold('GitHub template inspect')}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'}`);
  console.log(`${highlight('Source:')} ${report.templates?.source || 'unknown'}`);
  console.log(`${highlight('Total templates:')} ${report.templates?.totalCount ?? 0}`);

  const pullRequestTemplates = Array.isArray(report.templates?.pullRequestTemplates) ? report.templates.pullRequestTemplates : [];
  const issueTemplates = Array.isArray(report.templates?.issueTemplates) ? report.templates.issueTemplates : [];

  if (pullRequestTemplates.length > 0) {
    console.log(`${highlight('Pull request templates:')}`);
    pullRequestTemplates.forEach((template) => console.log(`  - ${template.path || template.fileName}: ${template.title || 'untitled'}`));
  }
  if (issueTemplates.length > 0) {
    console.log(`${highlight('Issue templates:')}`);
    issueTemplates.forEach((template) => console.log(`  - ${template.path || template.fileName}: ${template.title || 'untitled'}`));
  }
  if (!pullRequestTemplates.length && !issueTemplates.length) {
    console.log(dim('No issue or pull request templates were found.'));
  }

  printWarnings(report.warnings);
}

function printWebhookList(report) {
  printInventoryList('GitHub webhook list', report, 'webhooks', (hook) => {
    const url = hook.config?.url || hook.url || '-';
    return `#${hook.id ?? '?'} ${hook.active ? 'active' : 'inactive'} ${hook.name || 'web'} — events=${hook.eventCount ?? 0} url=${truncate(url, 72)}`;
  }, 'No webhooks were reported for the requested repository.');
}

function printWebhookInspect(report) {
  printInventoryInspect('GitHub webhook inspect', report, 'webhook', 'GitHub webhook', (hook) => {
    console.log(`${highlight('Webhook:')} #${hook.id ?? '?'} ${hook.name || 'web'}`);
    console.log(`${highlight('Active/events:')} ${hook.active ? 'yes' : 'no'} / ${Array.isArray(hook.events) ? hook.events.join(', ') : 'none'}`);
    if (hook.config) {
      console.log(`${highlight('Config:')} ${JSON.stringify(hook.config)}`);
    }
    if (hook.lastResponse) {
      console.log(`${highlight('Last response:')} ${hook.lastResponse.status || 'unknown'}${hook.lastResponse.code ? ` (${hook.lastResponse.code})` : ''}${hook.lastResponse.message ? ` ${hook.lastResponse.message}` : ''}`);
    }
    console.log(`${highlight('Updated:')} ${relativeIsoTimestamp(hook.updatedAt)}`);
  });
}

function printEventList(report) {
  printInventoryList('GitHub event list', report, 'events', (event) => {
    const action = event.action ? `/${event.action}` : '';
    const slug = event.slug || report.target?.slug || 'unknown';
    const delivery = event.deliveryId || event.eventId || '-';
    const timestamp = event.receivedAt || event.recordedAt || null;
    return `${event.eventName || 'unknown'}${action} — ${slug} — delivery=${truncate(delivery, 28)} recorded=${relativeIsoTimestamp(timestamp)}`;
  }, 'No locally recorded GitHub events matched the requested filters.');
}

function printEventInspect(report) {
  printInventoryInspect('GitHub event inspect', report, 'event', 'GitHub event', (event) => {
    console.log(`${highlight('Event:')} ${event.eventName || 'unknown'}${event.action ? ` / ${event.action}` : ''}`);
    console.log(`${highlight('Delivery:')} ${event.deliveryId || 'n/a'}${event.hookId ? ` hook=${event.hookId}` : ''}${event.installationId ? ` installation=${event.installationId}` : ''}`);
    console.log(`${highlight('Target/source:')} ${event.slug || 'unknown'} / ${event.source || 'unknown'}`);
    if (event.senderLogin) {
      console.log(`${highlight('Sender:')} ${event.senderLogin}`);
    }
    console.log(`${highlight('Recorded/received:')} ${relativeIsoTimestamp(event.recordedAt)} / ${relativeIsoTimestamp(event.receivedAt)}`);
    if (event.review) {
      console.log(`${highlight('Review:')} sensitivity=${event.review.sensitivity || 'unknown'} redactions=${event.review.redactionCount ?? 0} reviewRecommended=${event.review.reviewRecommended ? 'yes' : 'no'}`);
    }
    if (Array.isArray(event.payloadKeys) && event.payloadKeys.length > 0) {
      console.log(`${highlight('Payload keys:')} ${event.payloadKeys.join(', ')}`);
    }
    if (event.payloadPreview && typeof event.payloadPreview === 'object') {
      console.log(`${highlight('Payload preview:')} ${JSON.stringify(event.payloadPreview)}`);
    }
    if (report.artifact?.filePath) {
      console.log(`${highlight('Artifact:')} ${report.artifact.filePath}`);
    }
  });
}

function printWebhookDraft(report) {
  const capabilityKey = String(report.capability?.key || '').trim().toLowerCase();
  const actionLabel = capabilityKey === 'webhook.update.draft'
    ? 'update'
    : (capabilityKey === 'webhook.ping.draft' ? 'ping' : 'create');
  console.log(`\n${bold(`GitHub webhook ${actionLabel} draft`)}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'}${report.webhookId ? ` #${report.webhookId}` : ''}`);
  console.log(`${highlight('Preview:')} ${report.previewId || 'unknown'}`);
  console.log(`${highlight('Artifacts:')} preview=${report.previewArtifact?.filePath || 'n/a'} approval=${report.approvalArtifact?.filePath || 'n/a'}`);
  console.log(`${highlight('Review:')} sensitivity=${report.review?.sensitivity || 'unknown'} redactions=${report.review?.redactionCount ?? 0} reviewRequired=${report.review?.reviewRequired ? 'yes' : 'no'}`);
  if (report.draft?.webhookName) {
    console.log(`${highlight('Webhook:')} ${report.draft.webhookName}`);
  }
  if (Array.isArray(report.draft?.updates) && report.draft.updates.length > 0) {
    console.log(`${highlight('Updates:')} ${report.draft.updates.join(', ')}`);
  }
  if (report.draft?.targetUrl) {
    console.log(`${highlight('Target URL:')} ${report.draft.targetUrl}`);
  }
  if (Array.isArray(report.draft?.events) && report.draft.events.length > 0) {
    console.log(`${highlight('Events:')} ${report.draft.events.join(', ')}`);
  }
  if (report.draft?.contentType) {
    console.log(`${highlight('Content type:')} ${report.draft.contentType}`);
  }
  if (report.draft?.secretRef) {
    console.log(`${highlight('Secret ref:')} ${report.draft.secretRef}${report.draft.secretEnvName ? ` (env ${report.draft.secretEnvName})` : ''}`);
  }
  if (report.draft?.active === true || report.draft?.active === false) {
    console.log(`${highlight('Active:')} ${report.draft.active ? 'yes' : 'no'}`);
  }
  if (report.instructions?.cliApply) {
    console.log(`${highlight('CLI apply:')} ${report.instructions.cliApply}`);
  }
  if (report.instructions?.note) {
    console.log(`${highlight('Note:')} ${report.instructions.note}`);
  }
  printWarnings(report.warnings);
}

function printAppStatus(report) {
  console.log(`\n${bold('GitHub app status')}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'}`);
  console.log(`${highlight('GitHub auth:')} token=${report.summary?.tokenPresent ? 'present' : 'missing'} authenticated=${report.summary?.authenticated ? 'yes' : 'no'} governanceScope=${report.summary?.governanceScopeObserved ? 'observed' : 'not observed'}`);

  if (report.installation) {
    console.log(`${highlight('Installation:')} ${report.installation.appSlug || 'unknown'} (${report.installation.repositorySelection || 'unknown'})`);
    console.log(`${highlight('Permissions/events:')} ${Object.keys(report.installation.permissions || {}).length} / ${(report.installation.events || []).length}`);
  } else if (report.githubApi?.attempted) {
    console.log(`${highlight('Installation:')} unavailable ${dim(report.githubApi.error || 'unknown error')}`);
  } else {
    console.log(`${highlight('Installation:')} ${dim('lookup skipped')}`);
  }

  printWarnings(report.warnings);
}

function printAppInstallationInspect(report) {
  printInventoryInspect('GitHub app installation inspect', report, 'installation', 'GitHub App installation', (installation) => {
    console.log(`${highlight('App/account:')} ${installation.appSlug || 'unknown'} / ${installation.account?.login || 'unknown'}`);
    console.log(`${highlight('Repository selection:')} ${installation.repositorySelection || 'unknown'}`);
    console.log(`${highlight('Permissions/events:')} ${Object.keys(installation.permissions || {}).length} / ${(installation.events || []).length}`);
    console.log(`${highlight('Updated:')} ${relativeIsoTimestamp(installation.updatedAt)}`);
  });
}

function printAppPermissionsInspect(report) {
  console.log(`\n${bold('GitHub app permissions inspect')}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'}`);

  if (!report.installation) {
    if (report.githubApi?.attempted) {
      console.log(`${highlight('GitHub App permissions:')} unavailable ${dim(report.githubApi.error || 'unknown error')}`);
    } else {
      console.log(`${highlight('GitHub App permissions:')} ${dim('inspection skipped')}`);
    }
    printWarnings(report.warnings);
    return;
  }

  console.log(`${highlight('Installation:')} ${report.installation.appSlug || 'unknown'} (${report.installation.repositorySelection || 'unknown'})`);
  console.log(`${highlight('Permissions:')} ${report.permissionCount ?? 0}`);
  Object.entries(report.permissions || {}).forEach(([name, access]) => {
    console.log(`  - ${name}: ${access}`);
  });
  if (Array.isArray(report.events) && report.events.length > 0) {
    console.log(`${highlight('Events:')} ${report.events.join(', ')}`);
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

function printIssueCommentDraft(report) {
  console.log(`\n${bold('GitHub issue comment draft')}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'} #${report.issueNumber || '?'}`);
  console.log(`${highlight('Preview:')} ${report.previewId || 'unknown'}`);
  console.log(`${highlight('Artifacts:')} preview=${report.previewArtifact?.filePath || 'n/a'} approval=${report.approvalArtifact?.filePath || 'n/a'}`);
  console.log(`${highlight('Review:')} sensitivity=${report.review?.sensitivity || 'unknown'} redactions=${report.review?.redactionCount ?? 0} reviewRequired=${report.review?.reviewRequired ? 'yes' : 'no'}`);
  console.log(`${highlight('Body source:')} ${report.draft?.bodySource || 'unknown'}`);
  if (report.draft?.bodyPreview) {
    console.log(`${highlight('Preview text:')} ${report.draft.bodyPreview}`);
  }
  console.log(`${highlight('Approval:')} ${report.approval?.status || 'unknown'} mode=${report.approval?.approvalMode || 'unknown'} token=${report.approval?.applyTokenHint || 'n/a'}`);
  if (report.instructions?.cliApply) {
    console.log(`${highlight('CLI apply:')} ${report.instructions.cliApply}`);
  }
  if (report.instructions?.note) {
    console.log(`${highlight('Note:')} ${report.instructions.note}`);
  }
  printWarnings(report.warnings);
}

function printPullRequestCommentDraft(report) {
  console.log(`\n${bold('GitHub pull request comment draft')}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'} PR #${report.pullRequestNumber || '?'}`);
  console.log(`${highlight('Preview:')} ${report.previewId || 'unknown'}`);
  console.log(`${highlight('Artifacts:')} preview=${report.previewArtifact?.filePath || 'n/a'} approval=${report.approvalArtifact?.filePath || 'n/a'}`);
  console.log(`${highlight('Review:')} sensitivity=${report.review?.sensitivity || 'unknown'} redactions=${report.review?.redactionCount ?? 0} reviewRequired=${report.review?.reviewRequired ? 'yes' : 'no'}`);
  console.log(`${highlight('Body source:')} ${report.draft?.bodySource || 'unknown'}`);
  if (report.draft?.bodyPreview) {
    console.log(`${highlight('Preview text:')} ${report.draft.bodyPreview}`);
  }
  console.log(`${highlight('Approval:')} ${report.approval?.status || 'unknown'} mode=${report.approval?.approvalMode || 'unknown'} token=${report.approval?.applyTokenHint || 'n/a'}`);
  if (report.instructions?.cliApply) {
    console.log(`${highlight('CLI apply:')} ${report.instructions.cliApply}`);
  }
  if (report.instructions?.note) {
    console.log(`${highlight('Note:')} ${report.instructions.note}`);
  }
  printWarnings(report.warnings);
}

function printPullRequestReviewDraft(report) {
  console.log(`\n${bold('GitHub pull request review draft')}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'} PR #${report.pullRequestNumber || '?'}`);
  console.log(`${highlight('Preview:')} ${report.previewId || 'unknown'}`);
  console.log(`${highlight('Artifacts:')} preview=${report.previewArtifact?.filePath || 'n/a'} approval=${report.approvalArtifact?.filePath || 'n/a'}`);
  console.log(`${highlight('Review:')} sensitivity=${report.review?.sensitivity || 'unknown'} redactions=${report.review?.redactionCount ?? 0} reviewRequired=${report.review?.reviewRequired ? 'yes' : 'no'}`);
  console.log(`${highlight('Review event:')} ${report.draft?.reviewEvent || 'unknown'}${report.draft?.reviewEventApi ? ` ${dim(`(${report.draft.reviewEventApi})`)}` : ''}`);
  console.log(`${highlight('Body source:')} ${report.draft?.bodySource || 'unknown'}`);
  if (report.draft?.bodyPreview) {
    console.log(`${highlight('Preview text:')} ${report.draft.bodyPreview}`);
  }
  console.log(`${highlight('Approval:')} ${report.approval?.status || 'unknown'} mode=${report.approval?.approvalMode || 'unknown'} token=${report.approval?.applyTokenHint || 'n/a'}`);
  if (report.instructions?.cliApply) {
    console.log(`${highlight('CLI apply:')} ${report.instructions.cliApply}`);
  }
  if (report.instructions?.note) {
    console.log(`${highlight('Note:')} ${report.instructions.note}`);
  }
  printWarnings(report.warnings);
}

function printPullRequestStateDraft(report) {
  const actionLabel = report.draft?.stateAction || (report.capability?.key === 'pr.reopen.draft' ? 'reopen' : 'close');
  console.log(`\n${bold(`GitHub pull request ${actionLabel} draft`)}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'} PR #${report.pullRequestNumber || '?'}`);
  console.log(`${highlight('Preview:')} ${report.previewId || 'unknown'}`);
  console.log(`${highlight('Artifacts:')} preview=${report.previewArtifact?.filePath || 'n/a'} approval=${report.approvalArtifact?.filePath || 'n/a'}`);
  console.log(`${highlight('Review:')} sensitivity=${report.review?.sensitivity || 'unknown'} redactions=${report.review?.redactionCount ?? 0} reviewRequired=${report.review?.reviewRequired ? 'yes' : 'no'}`);
  console.log(`${highlight('State change:')} ${actionLabel}${report.draft?.desiredState ? ` ${dim(`(${report.draft.desiredState})`)}` : ''}`);
  console.log(`${highlight('Approval:')} ${report.approval?.status || 'unknown'} mode=${report.approval?.approvalMode || 'unknown'} token=${report.approval?.applyTokenHint || 'n/a'}`);
  if (report.instructions?.cliApply) {
    console.log(`${highlight('CLI apply:')} ${report.instructions.cliApply}`);
  }
  if (report.instructions?.note) {
    console.log(`${highlight('Note:')} ${report.instructions.note}`);
  }
  printWarnings(report.warnings);
}

function printPullRequestCreateDraft(report) {
  console.log(`\n${bold('GitHub pull request create draft')}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'}`);
  console.log(`${highlight('Preview:')} ${report.previewId || 'unknown'}`);
  console.log(`${highlight('Artifacts:')} preview=${report.previewArtifact?.filePath || 'n/a'} approval=${report.approvalArtifact?.filePath || 'n/a'}`);
  console.log(`${highlight('Review:')} sensitivity=${report.review?.sensitivity || 'unknown'} redactions=${report.review?.redactionCount ?? 0} reviewRequired=${report.review?.reviewRequired ? 'yes' : 'no'}`);
  console.log(`${highlight('Title:')} ${report.draft?.titlePreview || dim('unknown')}`);
  console.log(`${highlight('Branches:')} ${report.draft?.head || '?'} -> ${report.draft?.baseBranch || '?'}`);
  console.log(`${highlight('Draft PR:')} ${report.draft?.draft ? 'yes' : 'no'}`);
  console.log(`${highlight('Body source:')} ${report.draft?.bodySource || 'unknown'}`);
  if (report.draft?.bodyPreview) {
    console.log(`${highlight('Preview text:')} ${report.draft.bodyPreview}`);
  }
  console.log(`${highlight('Approval:')} ${report.approval?.status || 'unknown'} mode=${report.approval?.approvalMode || 'unknown'} token=${report.approval?.applyTokenHint || 'n/a'}`);
  if (report.instructions?.cliApply) {
    console.log(`${highlight('CLI apply:')} ${report.instructions.cliApply}`);
  }
  if (report.instructions?.note) {
    console.log(`${highlight('Note:')} ${report.instructions.note}`);
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

function printPullRequestStatus(report) {
  console.log(`\n${bold('GitHub pull request status')}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity.repoName}`);

  const branchSummary = report.branchContext?.currentBranch || dim('unknown');
  const branchBits = [branchSummary];
  if (report.branchContext?.source) {
    branchBits.push(dim(`(${report.branchContext.source})`));
  }
  if (report.branchContext?.detached) {
    branchBits.push(dim('(detached HEAD)'));
  }
  console.log(`${highlight('Branch:')} ${branchBits.join(' ')}`);

  const lookupBits = [report.lookup?.status || 'unknown'];
  if (report.lookup?.headQuery) {
    lookupBits.push(dim(`(${report.lookup.headQuery})`));
  }
  console.log(`${highlight('Lookup:')} ${lookupBits.join(' ')}`);

  if (report.pullRequest) {
    const pr = report.pullRequest;
    console.log(`${highlight('PR:')} #${pr.number} ${pr.title}`);
    console.log(`${highlight('State:')} ${pr.state}${pr.draft ? ' draft' : ''}${pr.merged ? ' merged' : ''}`);
    console.log(`${highlight('Author:')} ${pr.author?.login || 'unknown'}`);
    console.log(`${highlight('Branches:')} ${pr.head?.ref || '?'} -> ${pr.base?.ref || '?'}`);
    console.log(`${highlight('Comments:')} issue=${pr.comments ?? 0} review=${pr.reviewComments ?? 0}`);
    console.log(`${highlight('Updated:')} ${relativeIsoTimestamp(pr.updatedAt)}`);
    if (pr.htmlUrl) {
      console.log(`${highlight('URL:')} ${pr.htmlUrl}`);
    }
  } else if (report.lookup?.status === 'multiple' && Array.isArray(report.pullRequests) && report.pullRequests.length > 0) {
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
  } else if (report.lookup?.status === 'not-found') {
    console.log(dim(`No pull request currently matches ${report.lookup?.headQuery || 'the requested branch'}.`));
  } else if (report.githubApi.attempted) {
    console.log(`${highlight('GitHub PR status:')} unavailable ${dim(report.githubApi.error || 'unknown error')}`);
  } else {
    console.log(`${highlight('GitHub PR status:')} ${dim('API inspection skipped')}`);
  }

  printWarnings(report.warnings);
}

function formatFeedbackEntryLine(entry) {
  if (!entry || typeof entry !== 'object') {
    return '- unknown feedback entry';
  }

  const author = entry.author?.login || 'unknown';
  const timestamp = relativeIsoTimestamp(entry.activityAt || entry.updatedAt || entry.submittedAt || entry.createdAt);
  const detailBits = [];
  if (entry.state) {
    detailBits.push(entry.state);
  }
  if (entry.path) {
    detailBits.push(entry.line ? `${entry.path}:${entry.line}` : entry.path);
  }
  const detailSuffix = detailBits.length > 0 ? ` ${dim(`(${detailBits.join(', ')})`)}` : '';
  const preview = truncate(entry.bodyPreview || '(no body)', 96);
  return `- ${author}${detailSuffix} — ${timestamp} — ${preview}`;
}

function printFeedbackEntries(label, entries, apiReport) {
  console.log(`\n${highlight(label + ':')}`);

  if (Array.isArray(entries) && entries.length > 0) {
    entries.forEach((entry) => console.log(formatFeedbackEntryLine(entry)));
    return;
  }

  if (apiReport?.attempted && apiReport?.error) {
    console.log(dim(`Unavailable (${apiReport.error})`));
    return;
  }

  if (apiReport?.attempted) {
    console.log(dim('None reported within the requested limit.'));
    return;
  }

  console.log(dim('API inspection skipped'));
}

function printPullRequestFeedback(report) {
  console.log(`\n${bold('GitHub pull request feedback')}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity.repoName}`);

  const branchSummary = report.branchContext?.currentBranch || dim('n/a');
  const branchBits = [branchSummary];
  if (report.branchContext?.source) {
    branchBits.push(dim(`(${report.branchContext.source})`));
  }
  if (report.branchContext?.detached) {
    branchBits.push(dim('(detached HEAD)'));
  }
  console.log(`${highlight('Branch:')} ${branchBits.join(' ')}`);

  const lookupBits = [report.lookup?.status || 'unknown'];
  if (report.lookup?.headQuery) {
    lookupBits.push(dim(`(${report.lookup.headQuery})`));
  }
  console.log(`${highlight('Lookup:')} ${lookupBits.join(' ')}`);
  console.log(`${highlight('Requested limit:')} ${report.filters?.limit ?? '?'}`);

  if (report.pullRequest) {
    const pr = report.pullRequest;
    console.log(`${highlight('PR:')} #${pr.number} ${pr.title}`);
    console.log(`${highlight('State:')} ${pr.state}${pr.draft ? ' draft' : ''}${pr.merged ? ' merged' : ''}`);
    console.log(`${highlight('Author:')} ${pr.author?.login || 'unknown'}`);
    console.log(`${highlight('Branches:')} ${pr.head?.ref || '?'} -> ${pr.base?.ref || '?'}`);
    console.log(`${highlight('Feedback counts:')} conversation=${report.feedbackSummary?.conversationCommentCount ?? 0} reviews=${report.feedbackSummary?.reviewCount ?? 0} review-comments=${report.feedbackSummary?.reviewCommentCount ?? 0}`);
    console.log(`${highlight('Participants/latest:')} ${report.feedbackSummary?.participantCount ?? 0} / ${relativeIsoTimestamp(report.feedbackSummary?.latestActivityAt)}`);
    if (pr.htmlUrl) {
      console.log(`${highlight('URL:')} ${pr.htmlUrl}`);
    }
  } else if (report.pullRequestNumber) {
    console.log(`${highlight('PR:')} #${report.pullRequestNumber}`);
  } else if (report.lookup?.status === 'multiple' && Array.isArray(report.pullRequests) && report.pullRequests.length > 0) {
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
  } else if (report.lookup?.status === 'not-found') {
    console.log(dim(`No pull request currently matches ${report.lookup?.headQuery || 'the requested branch'}.`));
  } else if (report.githubApi.pullRequestLookup?.attempted) {
    console.log(`${highlight('GitHub PR feedback:')} unavailable ${dim(report.githubApi.pullRequestLookup?.error || 'unknown error')}`);
  } else {
    console.log(`${highlight('GitHub PR feedback:')} ${dim('API inspection skipped')}`);
  }

  if ((report.feedbackSummary?.totalCount ?? 0) > 0 || report.lookup?.status === 'matched') {
    printFeedbackEntries('Conversation comments', report.conversationComments, report.githubApi?.conversationComments);
    printFeedbackEntries('Reviews', report.reviews, report.githubApi?.reviews);
    printFeedbackEntries('Review comments', report.reviewComments, report.githubApi?.reviewComments);
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

function printWorkflowValidate(report) {
  console.log(`\n${bold('GitHub workflow validate')}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'}`);
  console.log(`${highlight('Workflow path:')} ${report.workflowPath || dim('unknown')}`);
  console.log(`${highlight('Body source:')} ${report.input?.bodySource || 'unknown'}`);
  console.log(`${highlight('Workflow name:')} ${report.summary?.name || dim('missing')}`);
  console.log(`${highlight('Triggers/jobs:')} ${(report.summary?.triggers || []).join(', ') || dim('none')} / ${report.summary?.jobCount ?? 0}`);
  console.log(`${highlight('Validation:')} ${report.validation?.valid ? 'valid' : 'needs-attention'}`);
  console.log(`${highlight('Policy violations:')} ${report.policyCheck?.violationCount ?? 0}`);
  if (Array.isArray(report.validation?.errors) && report.validation.errors.length > 0) {
    console.log(`${highlight('Validation errors:')}`);
    report.validation.errors.forEach((entry) => console.log(`- ${entry}`));
  }
  if (Array.isArray(report.policyCheck?.violations) && report.policyCheck.violations.length > 0) {
    console.log(`${highlight('Policy findings:')}`);
    report.policyCheck.violations.slice(0, 8).forEach((entry) => console.log(`- ${entry}`));
  }
  printWarnings(report.warnings);
}

function printWorkflowPermissionsInspect(report) {
  console.log(`\n${bold('GitHub workflow permissions inspect')}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'}`);
  console.log(`${highlight('Workflow path:')} ${report.workflowPath || dim('unknown')}`);
  console.log(`${highlight('Top-level permissions:')} ${report.permissions?.hasTopLevelPermissions ? JSON.stringify(report.permissions.topLevelPermissions || {}) : dim('missing')}`);
  console.log(`${highlight('Write scopes:')} ${(report.permissions?.writeScopes || []).join(', ') || dim('none')}`);
  if (Array.isArray(report.permissions?.jobs) && report.permissions.jobs.length > 0) {
    console.log(`${highlight('Job permissions:')}`);
    report.permissions.jobs.forEach((job) => {
      console.log(`- ${job.id}${job.name ? ` (${job.name})` : ''}: ${job.permissions ? JSON.stringify(job.permissions) : 'inherits workflow default'}${job.environment ? ` ${dim(`[env ${job.environment}]`)}` : ''}`);
    });
  }
  printWarnings(report.warnings);
}

function printWorkflowRequirementsInspect(report) {
  console.log(`\n${bold('GitHub workflow requirements inspect')}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'}`);
  console.log(`${highlight('Workflow path:')} ${report.workflowPath || dim('unknown')}`);
  console.log(`${highlight('Secrets:')} ${(report.requirements?.secrets || []).join(', ') || dim('none')}`);
  console.log(`${highlight('Vars:')} ${(report.requirements?.vars || []).join(', ') || dim('none')}`);
  console.log(`${highlight('Inputs:')} ${(report.requirements?.inputs || []).join(', ') || dim('none')}`);
  console.log(`${highlight('Environments:')} ${(report.requirements?.environments || []).join(', ') || dim('none')}`);
  console.log(`${highlight('Actions:')} ${(report.requirements?.actionReferences || []).length}`);
  if (Array.isArray(report.requirements?.actionReferences) && report.requirements.actionReferences.length > 0) {
    report.requirements.actionReferences.slice(0, 8).forEach((entry) => console.log(`- ${entry}`));
  }
  printWarnings(report.warnings);
}

function printWorkflowContentDraft(report) {
  const actionLabel = report.draft?.changeOperation || (report.capability?.key === 'workflow.update.draft' ? 'update' : 'create');
  console.log(`\n${bold(`GitHub workflow ${actionLabel} draft`)}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'} ${report.workflowPath || ''}`.trim());
  console.log(`${highlight('Preview:')} ${report.previewId || 'unknown'}`);
  console.log(`${highlight('Artifacts:')} preview=${report.previewArtifact?.filePath || 'n/a'} approval=${report.approvalArtifact?.filePath || 'n/a'}`);
  console.log(`${highlight('Review:')} sensitivity=${report.review?.sensitivity || 'unknown'} redactions=${report.review?.redactionCount ?? 0} reviewRequired=${report.review?.reviewRequired ? 'yes' : 'no'}`);
  console.log(`${highlight('Branches:')} ${report.draft?.headBranch || '?'} -> ${report.draft?.baseBranch || '?'}`);
  console.log(`${highlight('Commit:')} ${report.draft?.commitMessagePreview || dim('unknown')}`);
  console.log(`${highlight('Pull request:')} ${report.draft?.pullRequestTitle || dim('unknown')}`);
  console.log(`${highlight('Validation:')} ${report.validation?.valid ? 'valid' : 'needs-attention'} policyViolations=${report.draft?.policyViolationCount ?? 0}`);
  if (report.instructions?.cliApply) {
    console.log(`${highlight('CLI apply:')} ${report.instructions.cliApply}`);
  }
  if (report.instructions?.note) {
    console.log(`${highlight('Note:')} ${report.instructions.note}`);
  }
  printWarnings(report.warnings);
}

function printWorkflowOperationDraft(report) {
  const kind = report.draft?.type || 'workflow-operation';
  const actionLabel = kind.replace(/^workflow-/, '');
  console.log(`\n${bold(`GitHub workflow ${actionLabel} draft`)}\n`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'}`);
  console.log(`${highlight('Preview:')} ${report.previewId || 'unknown'}`);
  console.log(`${highlight('Artifacts:')} preview=${report.previewArtifact?.filePath || 'n/a'} approval=${report.approvalArtifact?.filePath || 'n/a'}`);
  console.log(`${highlight('Review:')} sensitivity=${report.review?.sensitivity || 'unknown'} redactions=${report.review?.redactionCount ?? 0} reviewRequired=${report.review?.reviewRequired ? 'yes' : 'no'}`);
  if (report.draft?.workflow) {
    console.log(`${highlight('Workflow/ref:')} ${report.draft.workflow} @ ${report.draft.ref || '?'}`);
    console.log(`${highlight('Inputs:')} ${report.draft.inputsCount ?? 0} (${report.draft.inputsSource || 'none'})`);
  }
  if (report.draft?.runId) {
    console.log(`${highlight('Run:')} ${report.draft.runId}${report.draft.failedOnly ? ' failed-only' : ''}`);
  }
  if (report.instructions?.cliApply) {
    console.log(`${highlight('CLI apply:')} ${report.instructions.cliApply}`);
  }
  if (report.instructions?.note) {
    console.log(`${highlight('Note:')} ${report.instructions.note}`);
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

function printGitHubWriteApply(report) {
  const targetSuffix = report.target?.pullRequestNumber
    ? ` PR #${report.target.pullRequestNumber}`
    : (report.target?.issueNumber ? ` #${report.target.issueNumber}` : '');
  console.log(`\n${bold('GitHub write apply')}\n`);
  console.log(`${highlight('Preview:')} ${report.previewId || 'unknown'}`);
  console.log(`${highlight('Target:')} ${report.target?.slug || report.repoIdentity?.repoName || 'unknown'}${targetSuffix}`);
  console.log(`${highlight('Approval:')} ${report.approval?.status || 'unknown'} token=${report.approval?.applyTokenHint || 'n/a'}`);
  console.log(`${highlight('Artifacts:')} preview=${report.previewArtifact?.filePath || 'n/a'} approval=${report.approvalArtifact?.filePath || 'n/a'} result=${report.resultArtifact?.filePath || 'n/a'}`);
  if (report.execution) {
    console.log(`${highlight('Execution:')} ${report.execution.status || 'unknown'}${report.execution.alreadyApplied ? ' (already applied)' : ''}`);
  }
  if (report.result?.comment?.htmlUrl) {
    console.log(`${highlight('Comment URL:')} ${report.result.comment.htmlUrl}`);
  }
  if (report.result?.review?.htmlUrl) {
    console.log(`${highlight('Review URL:')} ${report.result.review.htmlUrl}`);
  }
  if (report.result?.desiredState) {
    console.log(`${highlight('Requested state:')} ${report.result.desiredState}`);
  }
  if (report.result?.path) {
    console.log(`${highlight('Path:')} ${report.result.path}`);
  }
  if (report.result?.headBranch || report.result?.baseBranch) {
    console.log(`${highlight('Branches:')} ${report.result.headBranch || '?'} -> ${report.result.baseBranch || '?'}`);
  }
  if (report.result?.workflow) {
    console.log(`${highlight('Workflow:')} ${report.result.workflow}${report.result.ref ? ` @ ${report.result.ref}` : ''}`);
  }
  if (report.result?.runId) {
    console.log(`${highlight('Run id:')} ${report.result.runId}${report.result.failedOnly ? ' failed-only' : ''}`);
  }
  if (report.result?.pullRequest?.htmlUrl) {
    console.log(`${highlight('Pull request URL:')} ${report.result.pullRequest.htmlUrl}`);
  }
  if (report.message) {
    console.log(`${highlight('Message:')} ${report.message}`);
  }
  printWarnings(report.warnings);
}

const commandExecutor = createGitHubCommandExecutor();

const printHandlers = {
  'github.apply': printGitHubWriteApply,
  'auth.status': printAuthStatus,
  'app.status': printAppStatus,
  'app.installation.inspect': printAppInstallationInspect,
  'app.permissions.inspect': printAppPermissionsInspect,
  'capabilities.list': printCapabilitiesList,
  'capabilities.inspect': printCapabilityInspect,
  'codeowners.inspect': printCodeownersInspect,
  'codeowners.create.draft': printCodeownersDraft,
  'codeowners.update.draft': printCodeownersDraft,
  'context.bundle': printContextBundle,
  'event.list': printEventList,
  'event.inspect': printEventInspect,
  'environment.list': printEnvironmentList,
  'environment.inspect': printEnvironmentInspect,
  'issues.comment.draft': printIssueCommentDraft,
  'ruleset.list': printRulesetList,
  'ruleset.inspect': printRulesetInspect,
  'secret.list': printSecretList,
  'secret.inspect': printSecretInspect,
  'template.inspect': printTemplateInspect,
  'variable.list': printVariableList,
  'variable.inspect': printVariableInspect,
  'webhook.list': printWebhookList,
  'webhook.inspect': printWebhookInspect,
  'webhook.create.draft': printWebhookDraft,
  'webhook.update.draft': printWebhookDraft,
  'webhook.ping.draft': printWebhookDraft,
  'pr.create.draft': printPullRequestCreateDraft,
  'pr.comment.draft': printPullRequestCommentDraft,
  'pr.review.draft': printPullRequestReviewDraft,
  'pr.close.draft': printPullRequestStateDraft,
  'pr.reopen.draft': printPullRequestStateDraft,
  'plan.runs': printPlanRuns,
  'plan.inspect': printPlanInspect,
  'plan.build': printPlanBuild,
  'plan.execute': printPlanExecute,
  'plan.resume': printPlanExecute,
  'repo.inspect': printRepoInspect,
  'issues.list': printIssuesList,
  'issues.inspect': printIssueInspect,
  'pr.list': printPullRequestList,
  'pr.status': printPullRequestStatus,
  'pr.feedback': printPullRequestFeedback,
  'pr.inspect': printPullRequestInspect,
  'pr.diff': printPullRequestDiffSummary,
  'workflow.runs': printWorkflowRuns,
  'workflow.inspect': printWorkflowInspect,
  'workflow.validate': printWorkflowValidate,
  'workflow.permissions.inspect': printWorkflowPermissionsInspect,
  'workflow.requirements.inspect': printWorkflowRequirementsInspect,
  'workflow.create.draft': printWorkflowContentDraft,
  'workflow.update.draft': printWorkflowContentDraft,
  'workflow.dispatch.draft': printWorkflowOperationDraft,
  'workflow.rerun.draft': printWorkflowOperationDraft,
  'workflow.cancel.draft': printWorkflowOperationDraft,
  'releases.list': printReleasesList,
  'releases.inspect': printReleaseInspect,
};

async function run(args, options) {
  const area = normalizeArea(args[0]);
  const action = String(args[1] || '').trim().toLowerCase();
  const featureFlagEnabled = isGitHubFeatureFlagEnabled(options);
  const writeFeatureFlagEnabled = isGitHubWriteFeatureFlagEnabled(options);

  if (area === 'help' || action === 'help') {
    if (!options.quiet) {
      showHelp();
    }
    return {
      success: true,
      schemaVersion: 'github.help.v1',
    };
  }

  if (!area || (!action && area !== 'apply')) {
    if (!options.json && !options.quiet) {
      showHelp();
    }
    return {
      success: false,
      error: 'USAGE',
      message: 'Usage: liku github <auth|capabilities|context|plan|apply|repo|ruleset|environment|secret|variable|codeowners|template|webhook|app|issues|pr|workflow|releases> <status|inspect|list|bundle|build|execute|resume|runs>',
    };
  }

  if (area === 'apply' && !action) {
    return {
      success: false,
      error: 'USAGE',
      message: 'Usage: liku github apply <preview-id> --approve [--apply-token <token> | --approval-file <path>]',
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
    writeFeatureFlagEnabled,
  });

  if (!options.json && !options.quiet) {
    const handler = report?.capability?.key ? printHandlers[report.capability.key] : null;
    if (report?.success === false) {
      if (report.error === 'USAGE') {
        printUsageFailure(report);
        showHelp();
      } else if (typeof handler === 'function') {
        handler(report);
      } else {
        printUsageFailure(report);
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



