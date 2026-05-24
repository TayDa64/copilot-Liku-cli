const { requestGitHubJson } = require('./client');
const { resolveGitHubRepoContext } = require('./context');

const GITHUB_WORKFLOW_RUNS_SCHEMA_VERSION = 'github.workflow-runs.v1';

function normalizeLimit(value, fallback = 10, max = 100) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(max, parsed));
}

function summarizeWorkflowRun(run) {
  if (!run || typeof run !== 'object') {
    return null;
  }
  return {
    id: Number.isFinite(Number(run.id)) ? Number(run.id) : null,
    name: run.name || null,
    displayTitle: run.display_title || null,
    event: run.event || null,
    status: run.status || null,
    conclusion: run.conclusion || null,
    workflowId: Number.isFinite(Number(run.workflow_id)) ? Number(run.workflow_id) : null,
    runNumber: Number.isFinite(Number(run.run_number)) ? Number(run.run_number) : null,
    attempt: Number.isFinite(Number(run.run_attempt)) ? Number(run.run_attempt) : null,
    branch: run.head_branch || null,
    sha: run.head_sha || null,
    htmlUrl: run.html_url || null,
    createdAt: run.created_at || null,
    updatedAt: run.updated_at || null,
    actor: run.actor
      ? {
          login: run.actor.login || null,
          type: run.actor.type || null,
          htmlUrl: run.actor.html_url || null,
        }
      : null,
  };
}

async function listGitHubWorkflowRuns(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const allowApi = options.api !== false;
  const limit = normalizeLimit(options.limit, 10, 100);
  const branch = String(options.branch || '').trim() || null;
  const status = String(options.status || '').trim() || null;
  const event = String(options.event || '').trim() || null;
  const workflow = String(options.workflow || '').trim() || null;
  const context = resolveGitHubRepoContext(options);

  const report = {
    schemaVersion: GITHUB_WORKFLOW_RUNS_SCHEMA_VERSION,
    success: true,
    featureFlagEnabled,
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: context.target,
    targetSource: context.targetSource,
    filters: {
      limit,
      branch,
      status,
      event,
      workflow,
    },
    githubApi: {
      ...context.githubApi,
      totalCount: null,
    },
    workflowRuns: [],
    warnings: context.warnings.slice(),
  };

  if (!context.target.raw) {
    report.warnings.push('No git remote detected; workflow run listing needs a GitHub repository target.');
    return report;
  }

  if (!context.target.isGitHub || !context.target.slug) {
    report.warnings.push('Detected target is not a GitHub repository; workflow run listing was skipped.');
    return report;
  }

  if (!allowApi) {
    report.warnings.push('GitHub workflow run listing skipped by request.');
    return report;
  }

  const params = new URLSearchParams({
    per_page: String(limit),
  });
  if (branch) params.set('branch', branch);
  if (status) params.set('status', status);
  if (event) params.set('event', event);

  const basePath = workflow
    ? `/repos/${encodeURIComponent(context.target.owner)}/${encodeURIComponent(context.target.repo)}/actions/workflows/${encodeURIComponent(workflow)}/runs`
    : `/repos/${encodeURIComponent(context.target.owner)}/${encodeURIComponent(context.target.repo)}/actions/runs`;

  const response = await requestGitHubJson({
    apiPath: `${basePath}?${params.toString()}`,
    apiBaseUrl: context.target.apiBaseUrl || 'https://api.github.com',
    token: context.tokenInfo.token,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  report.githubApi.attempted = true;
  report.githubApi.status = response.status;
  report.githubApi.rateLimit = response.rateLimit || null;

  if (response.ok && response.data) {
    report.githubApi.totalCount = Number.isFinite(Number(response.data.total_count))
      ? Number(response.data.total_count)
      : null;
    report.workflowRuns = Array.isArray(response.data.workflow_runs)
      ? response.data.workflow_runs.slice(0, limit).map(summarizeWorkflowRun).filter(Boolean)
      : [];
    return report;
  }

  report.githubApi.error = response.error || response.data?.message || `GitHub workflow run listing failed (${response.status})`;
  if (!context.tokenInfo.token) {
    report.warnings.push('Public workflow run listing failed without GH_TOKEN/GITHUB_TOKEN; authenticated access may be required for private repositories or higher rate limits.');
  }
  return report;
}

module.exports = {
  GITHUB_WORKFLOW_RUNS_SCHEMA_VERSION,
  listGitHubWorkflowRuns,
  summarizeWorkflowRun,
};
