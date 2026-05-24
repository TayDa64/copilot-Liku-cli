const { requestGitHubJson } = require('./client');
const { resolveGitHubRepoContext } = require('./context');
const { summarizeWorkflowRun } = require('./workflow-runs');

const GITHUB_WORKFLOW_INSPECT_SCHEMA_VERSION = 'github.workflow-inspect.v1';

function normalizeWorkflowRunId(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function summarizeWorkflowRunDetail(run) {
  const base = summarizeWorkflowRun(run);
  if (!base) {
    return null;
  }

  return {
    ...base,
    runStartedAt: run.run_started_at || null,
    path: run.path || null,
    jobsUrl: run.jobs_url || null,
    logsUrl: run.logs_url || null,
    artifactsUrl: run.artifacts_url || null,
    cancelUrl: run.cancel_url || null,
    rerunUrl: run.rerun_url || null,
    previousAttemptUrl: run.previous_attempt_url || null,
    checkSuiteId: Number.isFinite(Number(run.check_suite_id)) ? Number(run.check_suite_id) : null,
    triggeringActor: run.triggering_actor
      ? {
          login: run.triggering_actor.login || null,
          type: run.triggering_actor.type || null,
          htmlUrl: run.triggering_actor.html_url || null,
        }
      : null,
    referencedWorkflows: Array.isArray(run.referenced_workflows)
      ? run.referenced_workflows.slice(0, 8).map((workflow) => ({
          path: workflow?.path || null,
          sha: workflow?.sha || null,
          ref: workflow?.ref || null,
        }))
      : [],
    headCommit: run.head_commit
      ? {
          id: run.head_commit.id || null,
          treeId: run.head_commit.tree_id || null,
          message: run.head_commit.message || null,
          timestamp: run.head_commit.timestamp || null,
          authorName: run.head_commit.author?.name || null,
          authorEmail: run.head_commit.author?.email || null,
        }
      : null,
  };
}

async function inspectGitHubWorkflowRun(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const allowApi = options.api !== false;
  const runId = normalizeWorkflowRunId(options.runId || options.id || options.number || options.run);
  const context = resolveGitHubRepoContext(options);

  const report = {
    schemaVersion: GITHUB_WORKFLOW_INSPECT_SCHEMA_VERSION,
    success: true,
    featureFlagEnabled,
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: context.target,
    targetSource: context.targetSource,
    runId,
    githubApi: {
      ...context.githubApi,
    },
    workflowRun: null,
    warnings: context.warnings.slice(),
  };

  if (!runId) {
    report.success = false;
    report.error = 'USAGE';
    report.message = 'Usage: liku github workflow inspect <run-id> [--slug owner/repo]';
    return report;
  }

  if (!context.target.raw) {
    report.warnings.push('No git remote detected; workflow inspection needs a GitHub repository target.');
    return report;
  }

  if (!context.target.isGitHub || !context.target.slug) {
    report.warnings.push('Detected target is not a GitHub repository; workflow inspection was skipped.');
    return report;
  }

  if (!allowApi) {
    report.warnings.push('GitHub workflow inspection skipped by request.');
    return report;
  }

  const response = await requestGitHubJson({
    apiPath: `/repos/${encodeURIComponent(context.target.owner)}/${encodeURIComponent(context.target.repo)}/actions/runs/${runId}`,
    apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
    token: context.tokenInfo.token,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  report.githubApi.attempted = true;
  report.githubApi.status = response.status;
  report.githubApi.rateLimit = response.rateLimit || null;

  if (response.ok && response.data) {
    report.workflowRun = summarizeWorkflowRunDetail(response.data);
    return report;
  }

  report.githubApi.error = response.error || response.data?.message || `GitHub workflow inspection failed (${response.status})`;
  if (!context.tokenInfo.token) {
    report.warnings.push('Public workflow inspection failed without GH_TOKEN/GITHUB_TOKEN; authenticated access may be required for private repositories or higher rate limits.');
  }
  return report;
}

module.exports = {
  GITHUB_WORKFLOW_INSPECT_SCHEMA_VERSION,
  inspectGitHubWorkflowRun,
  normalizeWorkflowRunId,
  summarizeWorkflowRunDetail,
};
