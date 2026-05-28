const { resolveGitHubRepoContext } = require('./context');
const { createGovernanceReadReport, normalizeLimit } = require('./governance-redaction');
const { PLAN_RUN_STATE_VALUES, listGitHubPlanRunsLedger, normalizePlanRunStateFilter } = require('./plan-run-ledger');

const GITHUB_PLAN_RUNS_SCHEMA_VERSION = 'github.plan-runs.v1';

async function listGitHubPlanRuns(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const limit = normalizeLimit(options.limit, 20, 200);
  const requestedState = String(options.state || '').trim() || 'all';
  const normalizedState = normalizePlanRunStateFilter(requestedState);
  const context = resolveGitHubRepoContext(options);
  const effectiveSlug = String(options.slug || context.target?.slug || '').trim() || null;

  const report = createGovernanceReadReport({
    schemaVersion: GITHUB_PLAN_RUNS_SCHEMA_VERSION,
    featureFlagEnabled,
    context,
    extra: {
      localOnly: true,
      artifactDir: null,
      filters: {
        limit,
        state: requestedState,
      },
      totalCount: 0,
      runs: [],
    },
  });

  if (!effectiveSlug) {
    report.warnings.push('No GitHub repo target detected; listing all locally recorded GitHub plan runs.');
  }

  if (normalizedState === null) {
    report.success = false;
    report.error = 'USAGE';
    report.message = `Usage: liku github plan runs [--slug owner/repo] [--limit N] [--state ${PLAN_RUN_STATE_VALUES.join('|')}]`;
    return report;
  }

  const ledger = listGitHubPlanRunsLedger({
    artifactDir: options.artifactDir,
    slug: effectiveSlug,
    limit,
    state: normalizedState,
  });

  if (Array.isArray(ledger.warnings) && ledger.warnings.length > 0) {
    report.warnings.push(...ledger.warnings);
  }

  report.target = effectiveSlug
    ? {
        ...(report.target && typeof report.target === 'object' ? report.target : {}),
        slug: effectiveSlug,
      }
    : report.target;
  report.artifactDir = ledger.artifactDir;
  report.filters.state = normalizedState;
  report.totalCount = ledger.totalCount;
  report.runs = ledger.runs;

  return report;
}

module.exports = {
  GITHUB_PLAN_RUNS_SCHEMA_VERSION,
  listGitHubPlanRuns,
};
