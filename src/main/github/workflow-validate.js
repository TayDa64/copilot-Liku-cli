const { resolveGitHubRepoContext } = require('./context');
const { analyzeWorkflowDefinition, resolveWorkflowTextInput } = require('./workflow-analyzer');

const GITHUB_WORKFLOW_VALIDATE_SCHEMA_VERSION = 'github.workflow-validate.v1';

function buildUsageMessage() {
  return 'Usage: liku github workflow validate <path> [--body <text> | --body-file <path>] [--slug owner/repo]';
}

function validateGitHubWorkflow(options = {}) {
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const context = resolveGitHubRepoContext(options);
  const input = resolveWorkflowTextInput({
    ...options,
    usageMessage: buildUsageMessage(),
    requirePath: false,
    emptyBodyMessage: 'GitHub workflow validate requires non-empty workflow content.',
  });

  const report = {
    schemaVersion: GITHUB_WORKFLOW_VALIDATE_SCHEMA_VERSION,
    success: true,
    featureFlagEnabled,
    repoIdentity: context.projectIdentity,
    remote: context.remote,
    target: context.target,
    targetSource: context.targetSource,
    workflowPath: null,
    input: null,
    summary: null,
    validation: null,
    permissions: null,
    requirements: null,
    policyCheck: null,
    warnings: context.warnings.slice(),
  };

  if (!input.ok) {
    report.success = false;
    report.error = input.error;
    report.message = input.message;
    return report;
  }

  const analysis = analyzeWorkflowDefinition({
    text: input.body,
    workflowPath: input.workflowPath,
  });

  report.workflowPath = analysis.workflowPath || input.workflowPath || null;
  report.input = {
    bodySource: input.bodySource,
    bodyFilePath: input.bodyFilePath,
    localPath: input.localPath,
    textLength: String(input.body || '').length,
  };
  report.summary = analysis.summary;
  report.validation = analysis.validation;
  report.permissions = analysis.permissions;
  report.requirements = analysis.requirements;
  report.policyCheck = analysis.policy;
  report.warnings.push(...analysis.warnings);
  return report;
}

module.exports = {
  GITHUB_WORKFLOW_VALIDATE_SCHEMA_VERSION,
  buildUsageMessage,
  validateGitHubWorkflow,
};
