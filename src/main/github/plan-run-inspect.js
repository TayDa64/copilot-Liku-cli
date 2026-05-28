const { resolveGitHubRepoContext } = require('./context');
const { createGovernanceReadReport } = require('./governance-redaction');
const { inspectGitHubPlanRunLedger } = require('./plan-run-ledger');

const GITHUB_PLAN_INSPECT_SCHEMA_VERSION = 'github.plan-inspect.v1';

async function inspectGitHubPlanRun(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const runId = String(options.runId || options.id || options.selector || '').trim();
  const context = resolveGitHubRepoContext(options);
  const requestedSlug = String(options.slug || context.target?.slug || '').trim() || null;
  const planFile = String(options.planFile || options['plan-file'] || '').trim() || null;
  const eventLogFile = String(options.eventLogFile || options['event-log-file'] || '').trim() || null;

  const report = createGovernanceReadReport({
    schemaVersion: GITHUB_PLAN_INSPECT_SCHEMA_VERSION,
    featureFlagEnabled,
    context,
    extra: {
      localOnly: true,
      artifactDir: null,
      runId,
      planArtifact: null,
      resultArtifact: null,
      guidanceArtifact: null,
      eventLog: null,
      plan: null,
      execution: null,
      stepResults: [],
      guidance: null,
      run: null,
    },
  });

  if (!runId) {
    report.success = false;
    report.error = 'USAGE';
    report.message = 'Usage: liku github plan inspect <run-id> [--slug owner/repo] [--plan-file <path>] [--event-log-file <path>]';
    return report;
  }

  let ledger;
  try {
    ledger = inspectGitHubPlanRunLedger({
      artifactDir: options.artifactDir,
      runId,
      planFile,
      eventLogFile,
    });
  } catch (error) {
    report.success = false;
    report.error = 'NOT_FOUND';
    report.message = error.message;
    return report;
  }

  if (Array.isArray(ledger.warnings) && ledger.warnings.length > 0) {
    report.warnings.push(...ledger.warnings);
  }

  if (!ledger.run) {
    report.success = false;
    report.error = 'NOT_FOUND';
    report.message = `GitHub plan run ${runId} was not found in the local plan ledger.`;
    return report;
  }

  const runSlug = String(ledger.run.slug || '').trim() || null;
  if (requestedSlug && runSlug && requestedSlug.toLowerCase() !== runSlug.toLowerCase()) {
    report.success = false;
    report.error = 'NOT_FOUND';
    report.message = `GitHub plan run ${runId} does not belong to ${requestedSlug}.`;
    return report;
  }
  if (requestedSlug && !runSlug) {
    report.warnings.push(`GitHub plan run ${runId} does not record a repository slug; continuing local inspection without repo-match confirmation.`);
  }

  report.target = requestedSlug
    ? {
        ...(report.target && typeof report.target === 'object' ? report.target : {}),
        slug: requestedSlug,
      }
    : (runSlug
        ? {
            ...(report.target && typeof report.target === 'object' ? report.target : {}),
            slug: runSlug,
          }
        : report.target);
  report.artifactDir = ledger.artifactDir;
  report.run = ledger.run;
  report.planArtifact = ledger.planArtifact;
  report.resultArtifact = ledger.resultArtifact;
  report.guidanceArtifact = ledger.guidanceArtifact;
  report.eventLog = ledger.eventLog;
  report.plan = ledger.plan;
  report.execution = ledger.execution;
  report.stepResults = Array.isArray(ledger.stepResults) ? ledger.stepResults : [];
  report.guidance = ledger.guidance;

  return report;
}

module.exports = {
  GITHUB_PLAN_INSPECT_SCHEMA_VERSION,
  inspectGitHubPlanRun,
};
