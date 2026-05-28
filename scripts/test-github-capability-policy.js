#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  inspectGitHubCapabilityCatalogEntry,
  listGitHubCapabilityCatalog,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'capability-inspect.js'));
const {
  findGitHubCapability,
  listGitHubCapabilities,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'capability-registry.js'));
const {
  evaluateGitHubCapabilityPolicy,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'capability-policy.js'));
const {
  createGitHubCommandExecutor,
} = require(path.join(__dirname, '..', 'src', 'main', 'github', 'command-executor.js'));

let pass = 0;

async function test(name, fn) {
  await fn();
  pass += 1;
  console.log(`PASS ${name}`);
}

(async () => {
  await test('registry exposes read-only and reviewed-write metadata for current GitHub capabilities', async () => {
    const capabilities = listGitHubCapabilities();
    assert.ok(capabilities.length >= 47);

    const keys = capabilities.map((entry) => entry.key);
    assert.ok(keys.includes('auth.status'));
    assert.ok(keys.includes('capabilities.list'));
    assert.ok(keys.includes('capabilities.inspect'));
    assert.ok(keys.includes('context.bundle'));
    assert.ok(keys.includes('issues.comment.draft'));
    assert.ok(keys.includes('pr.status'));
    assert.ok(keys.includes('pr.feedback'));
    assert.ok(keys.includes('pr.review.draft'));
    assert.ok(keys.includes('pr.close.draft'));
    assert.ok(keys.includes('pr.reopen.draft'));
    assert.ok(keys.includes('pr.create.draft'));
    assert.ok(keys.includes('pr.comment.draft'));
    assert.ok(keys.includes('github.apply'));
    assert.ok(keys.includes('plan.build'));
    assert.ok(keys.includes('plan.execute'));
    assert.ok(keys.includes('plan.resume'));
    assert.ok(keys.includes('plan.runs'));
    assert.ok(keys.includes('plan.inspect'));
    assert.ok(keys.includes('ruleset.list'));
    assert.ok(keys.includes('ruleset.inspect'));
    assert.ok(keys.includes('environment.list'));
    assert.ok(keys.includes('environment.inspect'));
    assert.ok(keys.includes('secret.list'));
    assert.ok(keys.includes('secret.inspect'));
    assert.ok(keys.includes('variable.list'));
    assert.ok(keys.includes('variable.inspect'));
    assert.ok(keys.includes('codeowners.inspect'));
    assert.ok(keys.includes('codeowners.create.draft'));
    assert.ok(keys.includes('codeowners.update.draft'));
    assert.ok(keys.includes('template.inspect'));
    assert.ok(keys.includes('webhook.list'));
    assert.ok(keys.includes('webhook.inspect'));
    assert.ok(keys.includes('webhook.create.draft'));
    assert.ok(keys.includes('webhook.update.draft'));
    assert.ok(keys.includes('webhook.ping.draft'));
    assert.ok(keys.includes('event.list'));
    assert.ok(keys.includes('event.inspect'));
    assert.ok(keys.includes('app.status'));
    assert.ok(keys.includes('app.installation.inspect'));
    assert.ok(keys.includes('app.permissions.inspect'));
    assert.ok(keys.includes('issues.list'));
    assert.ok(keys.includes('pr.diff'));
    assert.ok(keys.includes('workflow.validate'));
    assert.ok(keys.includes('workflow.permissions.inspect'));
    assert.ok(keys.includes('workflow.requirements.inspect'));
    assert.ok(keys.includes('workflow.create.draft'));
    assert.ok(keys.includes('workflow.update.draft'));
    assert.ok(keys.includes('workflow.dispatch.draft'));
    assert.ok(keys.includes('workflow.rerun.draft'));
    assert.ok(keys.includes('workflow.cancel.draft'));
    assert.ok(keys.includes('workflow.inspect'));
    assert.ok(keys.includes('releases.inspect'));

    const issueList = findGitHubCapability('issues', 'list');
    assert.ok(issueList);
    assert.strictEqual(issueList.responseSchemaVersion, 'github.issues-list.v1');
    assert.strictEqual(issueList.sideEffectClass, 'read');
    assert.strictEqual(issueList.approvalRequirement, 'none');
    assert.strictEqual(issueList.riskLevel, 'low');
    assert.deepStrictEqual(issueList.allowedSources.slice().sort(), ['cli', 'slash']);

    const contextBundle = findGitHubCapability('context', 'bundle');
    assert.ok(contextBundle);
    assert.strictEqual(contextBundle.responseSchemaVersion, 'github.context-bundle.v1');
    assert.strictEqual(contextBundle.sideEffectClass, 'read');
    assert.deepStrictEqual(contextBundle.allowedSources.slice().sort(), ['cli', 'slash']);

    const prStatus = findGitHubCapability('pr', 'status');
    assert.ok(prStatus);
    assert.strictEqual(prStatus.responseSchemaVersion, 'github.pr-status.v1');
    assert.strictEqual(prStatus.sideEffectClass, 'read');
    assert.strictEqual(prStatus.approvalRequirement, 'none');
    assert.deepStrictEqual(prStatus.allowedSources.slice().sort(), ['cli', 'slash']);

    const prFeedback = findGitHubCapability('pr', 'feedback');
    assert.ok(prFeedback);
    assert.strictEqual(prFeedback.responseSchemaVersion, 'github.pr-feedback.v1');
    assert.strictEqual(prFeedback.sideEffectClass, 'read');
    assert.strictEqual(prFeedback.approvalRequirement, 'none');
    assert.deepStrictEqual(prFeedback.allowedSources.slice().sort(), ['cli', 'slash']);

    const prReviewDraft = findGitHubCapability('pr', 'review-draft');
    assert.ok(prReviewDraft);
    assert.strictEqual(prReviewDraft.responseSchemaVersion, 'github.pr-review-draft.v1');
    assert.strictEqual(prReviewDraft.sideEffectClass, 'preview');
    assert.strictEqual(prReviewDraft.approvalRequirement, 'explicit');
    assert.deepStrictEqual(prReviewDraft.allowedSources.slice().sort(), ['cli', 'slash']);

    const prCloseDraft = findGitHubCapability('pr', 'close-draft');
    assert.ok(prCloseDraft);
    assert.strictEqual(prCloseDraft.responseSchemaVersion, 'github.pr-close-draft.v1');
    assert.strictEqual(prCloseDraft.sideEffectClass, 'preview');
    assert.strictEqual(prCloseDraft.approvalRequirement, 'explicit');
    assert.deepStrictEqual(prCloseDraft.allowedSources.slice().sort(), ['cli', 'slash']);

    const prReopenDraft = findGitHubCapability('pr', 'reopen-draft');
    assert.ok(prReopenDraft);
    assert.strictEqual(prReopenDraft.responseSchemaVersion, 'github.pr-reopen-draft.v1');
    assert.strictEqual(prReopenDraft.sideEffectClass, 'preview');
    assert.strictEqual(prReopenDraft.approvalRequirement, 'explicit');
    assert.deepStrictEqual(prReopenDraft.allowedSources.slice().sort(), ['cli', 'slash']);

    const issueCommentDraft = findGitHubCapability('issues', 'comment-draft');
    assert.ok(issueCommentDraft);
    assert.strictEqual(issueCommentDraft.responseSchemaVersion, 'github.issue-comment-draft.v1');
    assert.strictEqual(issueCommentDraft.sideEffectClass, 'preview');
    assert.strictEqual(issueCommentDraft.approvalRequirement, 'explicit');
    assert.deepStrictEqual(issueCommentDraft.allowedSources.slice().sort(), ['cli', 'slash']);

    const prCommentDraft = findGitHubCapability('pr', 'comment-draft');
    assert.ok(prCommentDraft);
    assert.strictEqual(prCommentDraft.responseSchemaVersion, 'github.pr-comment-draft.v1');
    assert.strictEqual(prCommentDraft.sideEffectClass, 'preview');
    assert.strictEqual(prCommentDraft.approvalRequirement, 'explicit');
    assert.deepStrictEqual(prCommentDraft.allowedSources.slice().sort(), ['cli', 'slash']);

    const prCreateDraft = findGitHubCapability('pr', 'create-draft');
    assert.ok(prCreateDraft);
    assert.strictEqual(prCreateDraft.responseSchemaVersion, 'github.pr-create-draft.v1');
    assert.strictEqual(prCreateDraft.sideEffectClass, 'preview');
    assert.strictEqual(prCreateDraft.approvalRequirement, 'explicit');
    assert.deepStrictEqual(prCreateDraft.allowedSources.slice().sort(), ['cli', 'slash']);

    const githubApply = findGitHubCapability('apply', 'execute');
    assert.ok(githubApply);
    assert.strictEqual(githubApply.key, 'github.apply');
    assert.strictEqual(githubApply.responseSchemaVersion, 'github.write-apply.v1');
    assert.strictEqual(githubApply.sideEffectClass, 'write');
    assert.strictEqual(githubApply.approvalRequirement, 'explicit');
    assert.deepStrictEqual(githubApply.allowedSources.slice().sort(), ['cli']);

    const workflowCreateDraft = findGitHubCapability('workflow', 'create-draft');
    assert.ok(workflowCreateDraft);
    assert.strictEqual(workflowCreateDraft.responseSchemaVersion, 'github.workflow-create-draft.v1');
    assert.strictEqual(workflowCreateDraft.sideEffectClass, 'preview');
    assert.strictEqual(workflowCreateDraft.riskLevel, 'medium');
    assert.strictEqual(workflowCreateDraft.writeTargetClass, 'repo-content-patch');
    assert.deepStrictEqual(workflowCreateDraft.requiredPermissions.slice().sort(), ['contents:write', 'pull_requests:write']);

    const workflowDispatchDraft = findGitHubCapability('workflow', 'dispatch-draft');
    assert.ok(workflowDispatchDraft);
    assert.strictEqual(workflowDispatchDraft.responseSchemaVersion, 'github.workflow-dispatch-draft.v1');
    assert.strictEqual(workflowDispatchDraft.sideEffectClass, 'preview');
    assert.strictEqual(workflowDispatchDraft.riskLevel, 'low');
    assert.strictEqual(workflowDispatchDraft.writeTargetClass, 'direct-api');
    assert.deepStrictEqual(workflowDispatchDraft.requiredPermissions, ['actions:write']);

    const workflowRerunDraft = findGitHubCapability('workflow', 'rerun-draft');
    assert.ok(workflowRerunDraft);
    assert.strictEqual(workflowRerunDraft.responseSchemaVersion, 'github.workflow-rerun-draft.v1');
    assert.strictEqual(workflowRerunDraft.sideEffectClass, 'preview');
    assert.strictEqual(workflowRerunDraft.riskLevel, 'low');
    assert.strictEqual(workflowRerunDraft.writeTargetClass, 'direct-api');
    assert.deepStrictEqual(workflowRerunDraft.requiredPermissions, ['actions:write']);

    const workflowCancelDraft = findGitHubCapability('workflow', 'cancel-draft');
    assert.ok(workflowCancelDraft);
    assert.strictEqual(workflowCancelDraft.responseSchemaVersion, 'github.workflow-cancel-draft.v1');
    assert.strictEqual(workflowCancelDraft.sideEffectClass, 'preview');
    assert.strictEqual(workflowCancelDraft.riskLevel, 'low');
    assert.strictEqual(workflowCancelDraft.writeTargetClass, 'direct-api');
    assert.deepStrictEqual(workflowCancelDraft.requiredPermissions, ['actions:write']);

    const webhookCreateDraft = findGitHubCapability('webhook', 'create-draft');
    assert.ok(webhookCreateDraft);
    assert.strictEqual(webhookCreateDraft.responseSchemaVersion, 'github.webhook-create-draft.v1');
    assert.strictEqual(webhookCreateDraft.sideEffectClass, 'preview');
    assert.strictEqual(webhookCreateDraft.riskLevel, 'medium');
    assert.strictEqual(webhookCreateDraft.writeTargetClass, 'direct-api');
    assert.deepStrictEqual(webhookCreateDraft.requiredPermissions, ['webhooks:write']);

    const webhookUpdateDraft = findGitHubCapability('webhook', 'update-draft');
    assert.ok(webhookUpdateDraft);
    assert.strictEqual(webhookUpdateDraft.responseSchemaVersion, 'github.webhook-update-draft.v1');
    assert.strictEqual(webhookUpdateDraft.sideEffectClass, 'preview');
    assert.strictEqual(webhookUpdateDraft.riskLevel, 'medium');
    assert.strictEqual(webhookUpdateDraft.writeTargetClass, 'direct-api');
    assert.deepStrictEqual(webhookUpdateDraft.requiredPermissions, ['webhooks:write']);

    const webhookPingDraft = findGitHubCapability('webhook', 'ping-draft');
    assert.ok(webhookPingDraft);
    assert.strictEqual(webhookPingDraft.responseSchemaVersion, 'github.webhook-ping-draft.v1');
    assert.strictEqual(webhookPingDraft.sideEffectClass, 'preview');
    assert.strictEqual(webhookPingDraft.riskLevel, 'low');
    assert.strictEqual(webhookPingDraft.writeTargetClass, 'direct-api');
    assert.deepStrictEqual(webhookPingDraft.requiredPermissions, ['webhooks:write']);

    const eventList = findGitHubCapability('event', 'list');
    assert.ok(eventList);
    assert.strictEqual(eventList.responseSchemaVersion, 'github.event-list.v1');
    assert.strictEqual(eventList.sideEffectClass, 'read');
    assert.strictEqual(eventList.approvalRequirement, 'none');
    assert.strictEqual(eventList.riskLevel, 'low');
    assert.deepStrictEqual(eventList.allowedSources.slice().sort(), ['cli', 'slash']);

    const eventInspect = findGitHubCapability('event', 'inspect');
    assert.ok(eventInspect);
    assert.strictEqual(eventInspect.responseSchemaVersion, 'github.event-inspect.v1');
    assert.strictEqual(eventInspect.sideEffectClass, 'read');
    assert.strictEqual(eventInspect.approvalRequirement, 'none');
    assert.strictEqual(eventInspect.riskLevel, 'low');
    assert.deepStrictEqual(eventInspect.allowedSources.slice().sort(), ['cli', 'slash']);

    const planRuns = findGitHubCapability('plan', 'runs');
    assert.ok(planRuns);
    assert.strictEqual(planRuns.responseSchemaVersion, 'github.plan-runs.v1');
    assert.strictEqual(planRuns.sideEffectClass, 'read');
    assert.strictEqual(planRuns.approvalRequirement, 'none');
    assert.strictEqual(planRuns.riskLevel, 'low');
    assert.deepStrictEqual(planRuns.allowedSources.slice().sort(), ['cli', 'slash']);

    const planInspect = findGitHubCapability('plan', 'inspect');
    assert.ok(planInspect);
    assert.strictEqual(planInspect.responseSchemaVersion, 'github.plan-inspect.v1');
    assert.strictEqual(planInspect.sideEffectClass, 'read');
    assert.strictEqual(planInspect.approvalRequirement, 'none');
    assert.strictEqual(planInspect.riskLevel, 'low');
    assert.deepStrictEqual(planInspect.allowedSources.slice().sort(), ['cli', 'slash']);

    const rulesetList = findGitHubCapability('ruleset', 'list');
    assert.ok(rulesetList);
    assert.strictEqual(rulesetList.responseSchemaVersion, 'github.ruleset-list.v1');
    assert.strictEqual(rulesetList.sideEffectClass, 'read');
    assert.deepStrictEqual(rulesetList.allowedSources.slice().sort(), ['cli', 'slash']);

    const codeownersInspect = findGitHubCapability('codeowners', 'inspect');
    assert.ok(codeownersInspect);
    assert.strictEqual(codeownersInspect.responseSchemaVersion, 'github.codeowners-inspect.v1');
    assert.strictEqual(codeownersInspect.sideEffectClass, 'read');

    const codeownersCreateDraft = findGitHubCapability('codeowners', 'create-draft');
    assert.ok(codeownersCreateDraft);
    assert.strictEqual(codeownersCreateDraft.responseSchemaVersion, 'github.codeowners-create-draft.v1');
    assert.strictEqual(codeownersCreateDraft.sideEffectClass, 'preview');
    assert.strictEqual(codeownersCreateDraft.riskLevel, 'medium');
    assert.strictEqual(codeownersCreateDraft.writeTargetClass, 'repo-content-patch');
    assert.deepStrictEqual(codeownersCreateDraft.requiredPermissions.slice().sort(), ['contents:write', 'pull_requests:write']);

    const appPermissionsInspect = findGitHubCapability('app', 'permissions-inspect');
    assert.ok(appPermissionsInspect);
    assert.strictEqual(appPermissionsInspect.responseSchemaVersion, 'github.app-permissions-inspect.v1');
    assert.strictEqual(appPermissionsInspect.sideEffectClass, 'read');
  });

  await test('capability catalog helpers summarize registered GitHub capabilities with policy previews', async () => {
    const listReport = listGitHubCapabilityCatalog();
    assert.strictEqual(listReport.success, true);
    assert.strictEqual(listReport.schemaVersion, 'github.capabilities-list.v1');
    assert.ok(Array.isArray(listReport.capabilities));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'capabilities.list'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'context.bundle'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'issues.comment.draft'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'pr.status'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'pr.feedback'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'pr.review.draft'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'pr.close.draft'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'pr.reopen.draft'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'pr.create.draft'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'pr.comment.draft'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'workflow.validate'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'workflow.create.draft'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'workflow.dispatch.draft'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'github.apply'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'plan.build'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'plan.execute'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'plan.resume'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'plan.runs'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'plan.inspect'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'ruleset.list'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'environment.inspect'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'secret.list'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'variable.inspect'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'codeowners.inspect'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'codeowners.create.draft'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'template.inspect'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'webhook.list'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'webhook.create.draft'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'webhook.update.draft'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'webhook.ping.draft'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'event.list'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'event.inspect'));
    assert.ok(listReport.capabilities.some((entry) => entry.key === 'app.status'));

    const inspectReport = inspectGitHubCapabilityCatalogEntry({ key: 'pr.diff' });
    assert.strictEqual(inspectReport.success, true);
    assert.strictEqual(inspectReport.schemaVersion, 'github.capability-inspect.v1');
    assert.strictEqual(inspectReport.entry.key, 'pr.diff');
    assert.strictEqual(inspectReport.entry.policyBySource.cli.allowed, true);
    assert.strictEqual(inspectReport.entry.policyBySource.slash.allowed, true);

    const writeInspectReport = inspectGitHubCapabilityCatalogEntry({
      key: 'issues.comment.draft',
      featureFlagEnabled: true,
      writeFeatureFlagEnabled: true,
      sources: ['cli', 'slash'],
    });
    assert.strictEqual(writeInspectReport.success, true);
    assert.strictEqual(writeInspectReport.entry.policyBySource.cli.allowed, true);
    assert.strictEqual(writeInspectReport.entry.policyBySource.cli.state, 'preview-allowed');
    assert.strictEqual(writeInspectReport.entry.policyBySource.slash.allowed, true);
  });

  await test('policy allows registered read-only GitHub capabilities from supported sources', async () => {
    const capability = findGitHubCapability('pr', 'feedback');
    const cliPolicy = evaluateGitHubCapabilityPolicy({
      capability,
      source: 'cli',
      executionPreferences: { approvalMode: 'never' },
    });
    const slashPolicy = evaluateGitHubCapabilityPolicy({
      capability,
      source: 'slash',
      executionPreferences: { approvalMode: 'auto' },
    });

    assert.strictEqual(cliPolicy.allowed, true);
    assert.strictEqual(cliPolicy.state, 'read-allowed');
    assert.strictEqual(cliPolicy.reason, 'read-only-capability-allowed');
    assert.strictEqual(cliPolicy.approvalMode, 'never');
    assert.strictEqual(cliPolicy.requiresApproval, false);
    assert.strictEqual(slashPolicy.allowed, true);
    assert.strictEqual(slashPolicy.source, 'slash');
  });

  await test('policy gates reviewed preview/apply writes by source, flags, and approval state', async () => {
    const previewCapability = findGitHubCapability('issues', 'comment-draft');
    const prCreatePreviewCapability = findGitHubCapability('pr', 'create-draft');
    const prPreviewCapability = findGitHubCapability('pr', 'comment-draft');
    const prReviewPreviewCapability = findGitHubCapability('pr', 'review-draft');
    const prClosePreviewCapability = findGitHubCapability('pr', 'close-draft');
    const prReopenPreviewCapability = findGitHubCapability('pr', 'reopen-draft');
    const workflowCreatePreviewCapability = findGitHubCapability('workflow', 'create-draft');
    const codeownersCreatePreviewCapability = findGitHubCapability('codeowners', 'create-draft');
    const workflowDispatchPreviewCapability = findGitHubCapability('workflow', 'dispatch-draft');
    const applyCapability = findGitHubCapability('apply', 'execute');

    const previewDeniedWithoutFlags = evaluateGitHubCapabilityPolicy({
      capability: previewCapability,
      source: 'cli',
    });
    const previewAllowed = evaluateGitHubCapabilityPolicy({
      capability: previewCapability,
      source: 'slash',
      featureFlagEnabled: true,
      writeFeatureFlagEnabled: true,
    });
    const prPreviewAllowed = evaluateGitHubCapabilityPolicy({
      capability: prPreviewCapability,
      source: 'cli',
      featureFlagEnabled: true,
      writeFeatureFlagEnabled: true,
    });
    const prReviewPreviewAllowed = evaluateGitHubCapabilityPolicy({
      capability: prReviewPreviewCapability,
      source: 'cli',
      featureFlagEnabled: true,
      writeFeatureFlagEnabled: true,
    });
    const prClosePreviewAllowed = evaluateGitHubCapabilityPolicy({
      capability: prClosePreviewCapability,
      source: 'cli',
      featureFlagEnabled: true,
      writeFeatureFlagEnabled: true,
    });
    const prReopenPreviewAllowed = evaluateGitHubCapabilityPolicy({
      capability: prReopenPreviewCapability,
      source: 'cli',
      featureFlagEnabled: true,
      writeFeatureFlagEnabled: true,
    });
    const workflowCreatePreviewAllowed = evaluateGitHubCapabilityPolicy({
      capability: workflowCreatePreviewCapability,
      source: 'slash',
      featureFlagEnabled: true,
      writeFeatureFlagEnabled: true,
    });
    const codeownersCreatePreviewAllowed = evaluateGitHubCapabilityPolicy({
      capability: codeownersCreatePreviewCapability,
      source: 'cli',
      featureFlagEnabled: true,
      writeFeatureFlagEnabled: true,
    });
    const workflowDispatchPreviewAllowed = evaluateGitHubCapabilityPolicy({
      capability: workflowDispatchPreviewCapability,
      source: 'cli',
      featureFlagEnabled: true,
      writeFeatureFlagEnabled: true,
    });
    const prCreatePreviewAllowed = evaluateGitHubCapabilityPolicy({
      capability: prCreatePreviewCapability,
      source: 'slash',
      featureFlagEnabled: true,
      writeFeatureFlagEnabled: true,
    });
    const applyRequiresApproval = evaluateGitHubCapabilityPolicy({
      capability: applyCapability,
      source: 'cli',
      featureFlagEnabled: true,
      writeFeatureFlagEnabled: true,
      executionPreferences: { approvalMode: 'prompt' },
    });
    const applyAllowed = evaluateGitHubCapabilityPolicy({
      capability: applyCapability,
      source: 'cli',
      featureFlagEnabled: true,
      writeFeatureFlagEnabled: true,
      executionPreferences: { approvalMode: 'prompt' },
      runtimeOptions: { approve: true },
    });
    const applyDeniedFromSlash = evaluateGitHubCapabilityPolicy({
      capability: applyCapability,
      source: 'slash',
      featureFlagEnabled: true,
      writeFeatureFlagEnabled: true,
      executionPreferences: { approvalMode: 'prompt' },
      runtimeOptions: { approve: true },
    });
    const applyDeniedNever = evaluateGitHubCapabilityPolicy({
      capability: applyCapability,
      source: 'cli',
      featureFlagEnabled: true,
      writeFeatureFlagEnabled: true,
      executionPreferences: { approvalMode: 'never' },
    });

    assert.strictEqual(previewDeniedWithoutFlags.allowed, false);
    assert.strictEqual(previewDeniedWithoutFlags.reason, 'github-capability-disabled');
    assert.strictEqual(previewAllowed.allowed, true);
    assert.strictEqual(previewAllowed.state, 'preview-allowed');
    assert.strictEqual(previewAllowed.previewAllowed, true);
    assert.strictEqual(prPreviewAllowed.allowed, true);
    assert.strictEqual(prPreviewAllowed.state, 'preview-allowed');
    assert.strictEqual(prPreviewAllowed.previewAllowed, true);
    assert.strictEqual(prReviewPreviewAllowed.allowed, true);
    assert.strictEqual(prReviewPreviewAllowed.state, 'preview-allowed');
    assert.strictEqual(prReviewPreviewAllowed.previewAllowed, true);
    assert.strictEqual(prClosePreviewAllowed.allowed, true);
    assert.strictEqual(prClosePreviewAllowed.state, 'preview-allowed');
    assert.strictEqual(prClosePreviewAllowed.previewAllowed, true);
    assert.strictEqual(prReopenPreviewAllowed.allowed, true);
    assert.strictEqual(prReopenPreviewAllowed.state, 'preview-allowed');
    assert.strictEqual(workflowCreatePreviewAllowed.allowed, true);
    assert.strictEqual(workflowCreatePreviewAllowed.state, 'preview-allowed');
    assert.strictEqual(workflowCreatePreviewAllowed.writeTargetClass, 'repo-content-patch');
    assert.deepStrictEqual(workflowCreatePreviewAllowed.requiredPermissions.slice().sort(), ['contents:write', 'pull_requests:write']);
    assert.strictEqual(codeownersCreatePreviewAllowed.allowed, true);
    assert.strictEqual(codeownersCreatePreviewAllowed.state, 'preview-allowed');
    assert.strictEqual(codeownersCreatePreviewAllowed.writeTargetClass, 'repo-content-patch');
    assert.deepStrictEqual(codeownersCreatePreviewAllowed.requiredPermissions.slice().sort(), ['contents:write', 'pull_requests:write']);
    assert.strictEqual(workflowDispatchPreviewAllowed.allowed, true);
    assert.strictEqual(workflowDispatchPreviewAllowed.state, 'preview-allowed');
    assert.deepStrictEqual(workflowDispatchPreviewAllowed.requiredPermissions, ['actions:write']);
    assert.strictEqual(prReopenPreviewAllowed.previewAllowed, true);
    assert.strictEqual(prCreatePreviewAllowed.allowed, true);
    assert.strictEqual(prCreatePreviewAllowed.state, 'preview-allowed');
    assert.strictEqual(prCreatePreviewAllowed.previewAllowed, true);

    assert.strictEqual(applyRequiresApproval.allowed, false);
    assert.strictEqual(applyRequiresApproval.state, 'approval-required');
    assert.strictEqual(applyRequiresApproval.reason, 'explicit-approval-required');

    assert.strictEqual(applyAllowed.allowed, true);
    assert.strictEqual(applyAllowed.state, 'apply-allowed');
    assert.strictEqual(applyAllowed.applyAllowed, true);
    assert.strictEqual(applyAllowed.approvalSatisfied, true);

    assert.strictEqual(applyDeniedFromSlash.allowed, false);
    assert.strictEqual(applyDeniedFromSlash.reason, 'source-not-allowed');

    assert.strictEqual(applyDeniedNever.allowed, false);
    assert.strictEqual(applyDeniedNever.reason, 'approval-mode-never');
    assert.strictEqual(applyDeniedNever.state, 'apply-denied');
  });

  await test('policy denies unsupported sources and higher-risk mutation capabilities', async () => {
    const issueList = findGitHubCapability('issues', 'list');
    const deniedSource = evaluateGitHubCapabilityPolicy({
      capability: issueList,
      source: 'background',
    });
    const deniedMutation = evaluateGitHubCapabilityPolicy({
      capability: {
        key: 'issues.create',
        area: 'issues',
        action: 'create',
        allowedSources: ['cli'],
        sideEffectClass: 'write',
        approvalRequirement: 'explicit',
        riskLevel: 'critical',
        supportsDryRun: true,
      },
      source: 'cli',
      featureFlagEnabled: true,
      writeFeatureFlagEnabled: true,
      executionPreferences: { dryRunDefault: true },
      runtimeOptions: { approve: true },
    });

    assert.strictEqual(deniedSource.allowed, false);
    assert.strictEqual(deniedSource.reason, 'source-not-allowed');
    assert.strictEqual(deniedMutation.allowed, false);
    assert.strictEqual(deniedMutation.reason, 'high-risk-mutation-disabled');
    assert.strictEqual(deniedMutation.effectiveDryRun, true);
  });

  await test('executor attaches capability and policy metadata to successful reports', async () => {
    const telemetry = [];
    let authInput = null;
    const executor = createGitHubCommandExecutor({
      env: {},
      cwd: 'C:/dev/copilot-Liku-cli',
      resolveGitHubAuthStatus(input) {
        authInput = input;
        return Promise.resolve({
          success: true,
          schemaVersion: 'github.auth-status.v1',
          featureFlagEnabled: true,
          warnings: [],
          copilot: {
            authenticated: false,
            provider: 'copilot',
            model: 'gpt-4o',
            modelName: 'GPT-4o',
          },
          githubApi: {
            tokenPresent: false,
            probeAttempted: false,
          },
        });
      },
      writeTelemetry(payload) {
        telemetry.push(payload);
        return payload;
      },
    });

    const report = await executor.execute({
      source: 'slash',
      area: 'auth',
      action: 'status',
      positionals: ['auth', 'status'],
      options: { probe: 'false' },
      featureFlagEnabled: true,
    });

    assert.ok(authInput);
    assert.strictEqual(authInput.probe, false);
    assert.strictEqual(report.capability.key, 'auth.status');
    assert.strictEqual(report.policy.allowed, true);
    assert.strictEqual(report.policy.reason, 'read-only-capability-allowed');
    assert.strictEqual(telemetry.length, 1);
    assert.strictEqual(telemetry[0].outcome, 'success');
    assert.strictEqual(telemetry[0].actions[0].capability, 'auth.status');
    assert.strictEqual(telemetry[0].context.policy.allowed, true);
  });

  await test('executor maps pr view to the shared pr.status capability', async () => {
    let statusInput = null;
    const executor = createGitHubCommandExecutor({
      env: {},
      cwd: 'C:/dev/copilot-Liku-cli',
      inspectGitHubPullRequestStatus(input) {
        statusInput = input;
        return Promise.resolve({
          success: true,
          schemaVersion: 'github.pr-status.v1',
          branchContext: {
            currentBranch: 'feature/demo',
            source: 'explicit-branch',
          },
          filters: {
            state: 'open',
            branch: 'feature/demo',
            head: 'owner:feature/demo',
          },
          lookup: {
            status: 'unavailable',
            headQuery: 'owner:feature/demo',
            matchedCount: 0,
            selectedPullRequestNumber: null,
          },
          githubApi: {
            attempted: false,
          },
          warnings: [],
        });
      },
    });

    const report = await executor.execute({
      source: 'slash',
      area: 'pr',
      action: 'view',
      positionals: ['pr', 'view'],
      options: { branch: 'feature/demo', slug: 'owner/repo', api: 'false' },
      featureFlagEnabled: true,
    });

    assert.ok(statusInput);
    assert.strictEqual(statusInput.branch, 'feature/demo');
    assert.strictEqual(statusInput.api, false);
    assert.strictEqual(report.success, true);
    assert.strictEqual(report.capability.key, 'pr.status');
    assert.strictEqual(report.policy.allowed, true);
    assert.strictEqual(report.branchContext.currentBranch, 'feature/demo');
  });

  await test('executor routes pr feedback to the shared pr.feedback capability', async () => {
    let feedbackInput = null;
    const executor = createGitHubCommandExecutor({
      env: {},
      cwd: 'C:/dev/copilot-Liku-cli',
      inspectGitHubPullRequestFeedback(input) {
        feedbackInput = input;
        return Promise.resolve({
          success: true,
          schemaVersion: 'github.pr-feedback.v1',
          filters: {
            limit: 6,
            state: 'open',
            branch: 'feature/demo',
            head: 'owner:feature/demo',
          },
          branchContext: {
            currentBranch: 'feature/demo',
            source: 'explicit-branch',
          },
          lookup: {
            mode: 'branch-associated',
            status: 'unavailable',
            headQuery: 'owner:feature/demo',
            matchedCount: 0,
            selectedPullRequestNumber: null,
          },
          feedbackSummary: {
            limit: 6,
            surfaceCount: 3,
            conversationCommentCount: 0,
            reviewCount: 0,
            reviewCommentCount: 0,
            totalCount: 0,
            participants: [],
            participantCount: 0,
            latestActivityAt: null,
          },
          conversationComments: [],
          reviews: [],
          reviewComments: [],
          githubApi: {
            attempted: false,
            pullRequestLookup: {
              attempted: false,
            },
            conversationComments: {
              attempted: false,
              resultCount: 0,
            },
            reviews: {
              attempted: false,
              resultCount: 0,
            },
            reviewComments: {
              attempted: false,
              resultCount: 0,
            },
          },
          warnings: [],
        });
      },
    });

    const report = await executor.execute({
      source: 'cli',
      area: 'pr',
      action: 'feedback',
      positionals: ['pr', 'feedback'],
      options: { branch: 'feature/demo', slug: 'owner/repo', limit: '6', api: 'false' },
      featureFlagEnabled: true,
    });

    assert.ok(feedbackInput);
    assert.strictEqual(feedbackInput.branch, 'feature/demo');
    assert.strictEqual(feedbackInput.slug, 'owner/repo');
    assert.strictEqual(feedbackInput.limit, '6');
    assert.strictEqual(feedbackInput.api, false);
    assert.strictEqual(report.success, true);
    assert.strictEqual(report.capability.key, 'pr.feedback');
    assert.strictEqual(report.policy.allowed, true);
    assert.strictEqual(report.branchContext.currentBranch, 'feature/demo');
    assert.strictEqual(report.feedbackSummary.limit, 6);
  });

  await test('executor routes pr review draft to the shared pr.review.draft capability', async () => {
    let reviewInput = null;
    const executor = createGitHubCommandExecutor({
      env: {},
      cwd: 'C:/dev/copilot-Liku-cli',
      draftGitHubPullRequestReview(input) {
        reviewInput = input;
        return Promise.resolve({
          success: true,
          schemaVersion: 'github.pr-review-draft.v1',
          pullRequestNumber: 17,
          previewId: 'preview-17',
          review: {
            reviewRequired: true,
          },
          previewArtifact: {
            filePath: 'preview.json',
          },
          approvalArtifact: {
            filePath: 'approval.json',
          },
          draft: {
            reviewEvent: 'approve',
            reviewEventApi: 'APPROVE',
            bodySource: 'inline',
            bodyPreview: 'Looks good overall.',
          },
          approval: {
            status: 'requested',
            approvalMode: 'prompt',
            applyTokenHint: 'ghwa_te…hint',
          },
          instructions: {
            cliApply: 'liku github apply preview-17 --approve --approval-file "approval.json"',
          },
          warnings: [],
        });
      },
    });

    const report = await executor.execute({
      source: 'slash',
      area: 'pr',
      action: 'review',
      positionals: ['pr', 'review', 'draft', '17'],
      options: { slug: 'owner/repo', event: 'approve', body: 'Looks good overall.' },
      featureFlagEnabled: true,
      writeFeatureFlagEnabled: true,
    });

    assert.ok(reviewInput);
    assert.strictEqual(reviewInput.number, '17');
    assert.strictEqual(reviewInput.slug, 'owner/repo');
    assert.strictEqual(reviewInput.event, 'approve');
    assert.strictEqual(reviewInput.body, 'Looks good overall.');
    assert.strictEqual(report.success, true);
    assert.strictEqual(report.capability.key, 'pr.review.draft');
    assert.strictEqual(report.policy.allowed, true);
    assert.strictEqual(report.draft.reviewEvent, 'approve');
  });

  await test('executor routes pr close draft to the shared pr.close.draft capability', async () => {
    let closeInput = null;
    const executor = createGitHubCommandExecutor({
      env: {},
      cwd: 'C:/dev/copilot-Liku-cli',
      draftGitHubPullRequestClose(input) {
        closeInput = input;
        return Promise.resolve({
          success: true,
          schemaVersion: 'github.pr-close-draft.v1',
          pullRequestNumber: 18,
          previewId: 'preview-close-18',
          review: {
            reviewRequired: true,
          },
          previewArtifact: {
            filePath: 'preview-close.json',
          },
          approvalArtifact: {
            filePath: 'approval-close.json',
          },
          draft: {
            stateAction: 'close',
            desiredState: 'closed',
          },
          approval: {
            status: 'requested',
          },
          instructions: {
            cliApply: 'liku github apply preview-close-18 --approve --approval-file "approval-close.json"',
          },
          warnings: [],
        });
      },
    });

    const report = await executor.execute({
      source: 'cli',
      area: 'pr',
      action: 'close',
      positionals: ['pr', 'close', 'draft', '18'],
      options: { slug: 'owner/repo' },
      featureFlagEnabled: true,
      writeFeatureFlagEnabled: true,
    });

    assert.ok(closeInput);
    assert.strictEqual(closeInput.number, '18');
    assert.strictEqual(closeInput.slug, 'owner/repo');
    assert.strictEqual(report.success, true);
    assert.strictEqual(report.capability.key, 'pr.close.draft');
    assert.strictEqual(report.policy.allowed, true);
    assert.strictEqual(report.draft.desiredState, 'closed');
  });

  await test('executor routes pr reopen draft to the shared pr.reopen.draft capability', async () => {
    let reopenInput = null;
    const executor = createGitHubCommandExecutor({
      env: {},
      cwd: 'C:/dev/copilot-Liku-cli',
      draftGitHubPullRequestReopen(input) {
        reopenInput = input;
        return Promise.resolve({
          success: true,
          schemaVersion: 'github.pr-reopen-draft.v1',
          pullRequestNumber: 21,
          previewId: 'preview-reopen-21',
          review: {
            reviewRequired: true,
          },
          previewArtifact: {
            filePath: 'preview-reopen.json',
          },
          approvalArtifact: {
            filePath: 'approval-reopen.json',
          },
          draft: {
            stateAction: 'reopen',
            desiredState: 'open',
          },
          approval: {
            status: 'requested',
          },
          instructions: {
            cliApply: 'liku github apply preview-reopen-21 --approve --approval-file "approval-reopen.json"',
          },
          warnings: [],
        });
      },
    });

    const report = await executor.execute({
      source: 'slash',
      area: 'pr',
      action: 'reopen',
      positionals: ['pr', 'reopen', 'draft', '21'],
      options: { slug: 'owner/repo' },
      featureFlagEnabled: true,
      writeFeatureFlagEnabled: true,
    });

    assert.ok(reopenInput);
    assert.strictEqual(reopenInput.number, '21');
    assert.strictEqual(reopenInput.slug, 'owner/repo');
    assert.strictEqual(report.success, true);
    assert.strictEqual(report.capability.key, 'pr.reopen.draft');
    assert.strictEqual(report.policy.allowed, true);
    assert.strictEqual(report.draft.desiredState, 'open');
  });

  await test('executor routes workflow validate to the shared workflow.validate capability', async () => {
    let validateInput = null;
    const executor = createGitHubCommandExecutor({
      env: {},
      cwd: 'C:/dev/copilot-Liku-cli',
      validateGitHubWorkflow(input) {
        validateInput = input;
        return Promise.resolve({
          success: true,
          schemaVersion: 'github.workflow-validate.v1',
          workflowPath: '.github/workflows/validate.yml',
          validation: { valid: true },
          summary: { name: 'Validate', jobCount: 1, triggers: ['push'] },
          permissions: { hasTopLevelPermissions: true, topLevelPermissions: {} },
          requirements: { actionReferences: [] },
          policyCheck: { violationCount: 0, violations: [] },
          warnings: [],
        });
      },
    });

    const report = await executor.execute({
      source: 'cli',
      area: 'workflow',
      action: 'validate',
      positionals: ['workflow', 'validate', '.github/workflows/validate.yml'],
      options: { slug: 'owner/repo', body: 'name: Validate', path: '.github/workflows/validate.yml' },
      featureFlagEnabled: true,
    });

    assert.ok(validateInput);
    assert.strictEqual(validateInput.path, '.github/workflows/validate.yml');
    assert.strictEqual(validateInput.slug, 'owner/repo');
    assert.strictEqual(validateInput.body, 'name: Validate');
    assert.strictEqual(report.success, true);
    assert.strictEqual(report.capability.key, 'workflow.validate');
    assert.strictEqual(report.policy.allowed, true);
  });

  await test('executor routes workflow create draft to the repo-content workflow capability', async () => {
    let workflowCreateInput = null;
    const executor = createGitHubCommandExecutor({
      env: {},
      cwd: 'C:/dev/copilot-Liku-cli',
      draftGitHubWorkflowCreate(input) {
        workflowCreateInput = input;
        return Promise.resolve({
          success: true,
          schemaVersion: 'github.workflow-create-draft.v1',
          workflowPath: '.github/workflows/validate.yml',
          previewId: 'workflow-preview-1',
          review: { reviewRequired: true },
          previewArtifact: { filePath: 'workflow-preview.json' },
          approvalArtifact: { filePath: 'workflow-approval.json' },
          validation: { valid: true },
          draft: { changeOperation: 'create', workflowPath: '.github/workflows/validate.yml', headBranch: 'feature/workflow', baseBranch: 'main' },
          approval: { status: 'requested' },
          instructions: { cliApply: 'liku github apply workflow-preview-1 --approve --approval-file "workflow-approval.json"' },
          warnings: [],
        });
      },
    });

    const report = await executor.execute({
      source: 'slash',
      area: 'workflow',
      action: 'create',
      positionals: ['workflow', 'create', 'draft', '.github/workflows/validate.yml'],
      options: { slug: 'owner/repo', body: 'name: Validate', base: 'main', head: 'feature/workflow' },
      featureFlagEnabled: true,
      writeFeatureFlagEnabled: true,
    });

    assert.ok(workflowCreateInput);
    assert.strictEqual(workflowCreateInput.path, '.github/workflows/validate.yml');
    assert.strictEqual(workflowCreateInput.slug, 'owner/repo');
    assert.strictEqual(workflowCreateInput.base, 'main');
    assert.strictEqual(workflowCreateInput.head, 'feature/workflow');
    assert.strictEqual(report.success, true);
    assert.strictEqual(report.capability.key, 'workflow.create.draft');
    assert.strictEqual(report.policy.allowed, true);
    assert.strictEqual(report.draft.changeOperation, 'create');
  });

  await test('executor routes codeowners create draft to the repo-content CODEOWNERS capability', async () => {
    let codeownersCreateInput = null;
    const executor = createGitHubCommandExecutor({
      env: {},
      cwd: 'C:/dev/copilot-Liku-cli',
      draftGitHubCodeownersCreate(input) {
        codeownersCreateInput = input;
        return Promise.resolve({
          success: true,
          schemaVersion: 'github.codeowners-create-draft.v1',
          codeownersPath: '.github/CODEOWNERS',
          previewId: 'codeowners-preview-1',
          review: { reviewRequired: true },
          previewArtifact: { filePath: 'codeowners-preview.json' },
          approvalArtifact: { filePath: 'codeowners-approval.json' },
          codeowners: { entryCount: 1, ownerCount: 1, owners: ['@octocat'], entries: [{ preview: '* @octocat' }] },
          draft: { changeOperation: 'create', codeownersPath: '.github/CODEOWNERS', headBranch: 'feature/codeowners', baseBranch: 'main', entryCount: 1, ownerCount: 1, owners: ['@octocat'] },
          approval: { status: 'requested' },
          instructions: { cliApply: 'liku github apply codeowners-preview-1 --approve --approval-file "codeowners-approval.json"' },
          warnings: [],
        });
      },
    });

    const report = await executor.execute({
      source: 'slash',
      area: 'codeowners',
      action: 'create',
      positionals: ['codeowners', 'create', 'draft'],
      options: { slug: 'owner/repo', body: '* @octocat', base: 'main', head: 'feature/codeowners', path: '.github/CODEOWNERS' },
      featureFlagEnabled: true,
      writeFeatureFlagEnabled: true,
    });

    assert.ok(codeownersCreateInput);
    assert.strictEqual(codeownersCreateInput.slug, 'owner/repo');
    assert.strictEqual(codeownersCreateInput.body, '* @octocat');
    assert.strictEqual(codeownersCreateInput.base, 'main');
    assert.strictEqual(codeownersCreateInput.head, 'feature/codeowners');
    assert.strictEqual(codeownersCreateInput.path, '.github/CODEOWNERS');
    assert.strictEqual(report.success, true);
    assert.strictEqual(report.capability.key, 'codeowners.create.draft');
    assert.strictEqual(report.policy.allowed, true);
    assert.strictEqual(report.draft.changeOperation, 'create');
  });

  await test('executor routes workflow dispatch draft to the shared workflow.dispatch.draft capability', async () => {
    let workflowDispatchInput = null;
    const executor = createGitHubCommandExecutor({
      env: {},
      cwd: 'C:/dev/copilot-Liku-cli',
      draftGitHubWorkflowDispatch(input) {
        workflowDispatchInput = input;
        return Promise.resolve({
          success: true,
          schemaVersion: 'github.workflow-dispatch-draft.v1',
          previewId: 'workflow-dispatch-preview-1',
          review: { reviewRequired: true },
          previewArtifact: { filePath: 'workflow-dispatch-preview.json' },
          approvalArtifact: { filePath: 'workflow-dispatch-approval.json' },
          draft: { type: 'workflow-dispatch', workflow: 'validate.yml', ref: 'main', inputsCount: 1 },
          approval: { status: 'requested' },
          instructions: { cliApply: 'liku github apply workflow-dispatch-preview-1 --approve --approval-file "workflow-dispatch-approval.json"' },
          warnings: [],
        });
      },
    });

    const report = await executor.execute({
      source: 'cli',
      area: 'workflow',
      action: 'dispatch',
      positionals: ['workflow', 'dispatch', 'draft', 'validate.yml'],
      options: { slug: 'owner/repo', ref: 'main', 'inputs-json': '{"target":"staging"}' },
      featureFlagEnabled: true,
      writeFeatureFlagEnabled: true,
    });

    assert.ok(workflowDispatchInput);
    assert.strictEqual(workflowDispatchInput.workflow, 'validate.yml');
    assert.strictEqual(workflowDispatchInput.ref, 'main');
    assert.strictEqual(workflowDispatchInput.inputsJson, '{"target":"staging"}');
    assert.strictEqual(report.success, true);
    assert.strictEqual(report.capability.key, 'workflow.dispatch.draft');
    assert.strictEqual(report.policy.allowed, true);
  });

  await test('executor routes webhook create draft to the shared webhook.create.draft capability', async () => {
    let webhookCreateInput = null;
    const executor = createGitHubCommandExecutor({
      env: {},
      cwd: 'C:/dev/copilot-Liku-cli',
      draftGitHubWebhookCreate(input) {
        webhookCreateInput = input;
        return Promise.resolve({
          success: true,
          schemaVersion: 'github.webhook-create-draft.v1',
          previewId: 'webhook-create-preview-1',
          review: { reviewRequired: true },
          previewArtifact: { filePath: 'webhook-create-preview.json' },
          approvalArtifact: { filePath: 'webhook-create-approval.json' },
          draft: { type: 'webhook-create', targetUrl: 'https://assistant.example.com/github/webhook', events: ['push', 'pull_request'] },
          approval: { status: 'requested' },
          instructions: { cliApply: 'liku github apply webhook-create-preview-1 --approve --approval-file "webhook-create-approval.json"' },
          warnings: [],
        });
      },
    });

    const report = await executor.execute({
      source: 'cli',
      area: 'webhook',
      action: 'create',
      positionals: ['webhook', 'create', 'draft'],
      options: {
        slug: 'owner/repo',
        events: 'push,pull_request',
        'target-url': 'https://assistant.example.com/github/webhook',
        'secret-ref': 'repo:LIKU_WEBHOOK_SECRET',
        'content-type': 'json',
      },
      featureFlagEnabled: true,
      writeFeatureFlagEnabled: true,
    });

    assert.ok(webhookCreateInput);
    assert.strictEqual(webhookCreateInput.slug, 'owner/repo');
    assert.strictEqual(webhookCreateInput.events, 'push,pull_request');
    assert.strictEqual(webhookCreateInput.targetUrl, 'https://assistant.example.com/github/webhook');
    assert.strictEqual(webhookCreateInput.secretRef, 'repo:LIKU_WEBHOOK_SECRET');
    assert.strictEqual(webhookCreateInput.contentType, 'json');
    assert.strictEqual(report.success, true);
    assert.strictEqual(report.capability.key, 'webhook.create.draft');
    assert.strictEqual(report.policy.allowed, true);
  });

  await test('executor routes webhook ping draft to the shared webhook.ping.draft capability', async () => {
    let webhookPingInput = null;
    const executor = createGitHubCommandExecutor({
      env: {},
      cwd: 'C:/dev/copilot-Liku-cli',
      draftGitHubWebhookPing(input) {
        webhookPingInput = input;
        return Promise.resolve({
          success: true,
          schemaVersion: 'github.webhook-ping-draft.v1',
          previewId: 'webhook-ping-preview-1',
          review: { reviewRequired: true },
          previewArtifact: { filePath: 'webhook-ping-preview.json' },
          approvalArtifact: { filePath: 'webhook-ping-approval.json' },
          draft: { type: 'webhook-ping', webhookId: 9001 },
          approval: { status: 'requested' },
          instructions: { cliApply: 'liku github apply webhook-ping-preview-1 --approve --approval-file "webhook-ping-approval.json"' },
          warnings: [],
        });
      },
    });

    const report = await executor.execute({
      source: 'cli',
      area: 'webhook',
      action: 'ping',
      positionals: ['webhook', 'ping', 'draft', '9001'],
      options: { slug: 'owner/repo' },
      featureFlagEnabled: true,
      writeFeatureFlagEnabled: true,
    });

    assert.ok(webhookPingInput);
    assert.strictEqual(webhookPingInput.slug, 'owner/repo');
    assert.strictEqual(webhookPingInput.webhookId, '9001');
    assert.strictEqual(report.success, true);
    assert.strictEqual(report.capability.key, 'webhook.ping.draft');
    assert.strictEqual(report.policy.allowed, true);
  });

  await test('executor routes event list to the shared event.list capability', async () => {
    let eventListInput = null;
    const executor = createGitHubCommandExecutor({
      env: {},
      cwd: 'C:/dev/copilot-Liku-cli',
      listGitHubEvents(input) {
        eventListInput = input;
        return Promise.resolve({
          success: true,
          schemaVersion: 'github.event-list.v1',
          localOnly: true,
          eventLog: { filePath: 'github-events.jsonl' },
          target: { slug: 'owner/repo' },
          totalCount: 1,
          events: [
            {
              eventId: 'github-event-1',
              eventName: 'push',
              slug: 'owner/repo',
            },
          ],
          warnings: [],
        });
      },
    });

    const report = await executor.execute({
      source: 'cli',
      area: 'event',
      action: 'list',
      positionals: ['event', 'list'],
      options: {
        slug: 'owner/repo',
        limit: '5',
        event: 'push',
      },
      featureFlagEnabled: true,
    });

    assert.ok(eventListInput);
    assert.strictEqual(eventListInput.slug, 'owner/repo');
    assert.strictEqual(eventListInput.limit, '5');
    assert.strictEqual(eventListInput.eventName, 'push');
    assert.strictEqual(report.success, true);
    assert.strictEqual(report.capability.key, 'event.list');
    assert.strictEqual(report.policy.allowed, true);
  });

  await test('executor routes event inspect to the shared event.inspect capability', async () => {
    let eventInspectInput = null;
    const executor = createGitHubCommandExecutor({
      env: {},
      cwd: 'C:/dev/copilot-Liku-cli',
      inspectGitHubEvent(input) {
        eventInspectInput = input;
        return Promise.resolve({
          success: true,
          schemaVersion: 'github.event-inspect.v1',
          localOnly: true,
          target: { slug: 'owner/repo' },
          artifact: { eventId: 'github-event-1', filePath: 'github-event-1.event.json' },
          event: {
            eventId: 'github-event-1',
            eventName: 'push',
            slug: 'owner/repo',
          },
          warnings: [],
        });
      },
    });

    const report = await executor.execute({
      source: 'cli',
      area: 'event',
      action: 'inspect',
      positionals: ['event', 'inspect', 'github-event-1'],
      options: { slug: 'owner/repo' },
      featureFlagEnabled: true,
    });

    assert.ok(eventInspectInput);
    assert.strictEqual(eventInspectInput.slug, 'owner/repo');
    assert.strictEqual(eventInspectInput.eventId, 'github-event-1');
    assert.strictEqual(report.success, true);
    assert.strictEqual(report.capability.key, 'event.inspect');
    assert.strictEqual(report.policy.allowed, true);
  });

  await test('executor routes plan runs to the shared plan.runs capability', async () => {
    let planRunsInput = null;
    const executor = createGitHubCommandExecutor({
      env: {},
      cwd: 'C:/dev/copilot-Liku-cli',
      listGitHubPlanRuns(input) {
        planRunsInput = input;
        return Promise.resolve({
          success: true,
          schemaVersion: 'github.plan-runs.v1',
          localOnly: true,
          target: { slug: 'owner/repo' },
          filters: { limit: 5, state: 'blocked' },
          totalCount: 1,
          runs: [
            {
              runId: 'github-run-1',
              state: 'blocked',
              slug: 'owner/repo',
            },
          ],
          warnings: [],
        });
      },
    });

    const report = await executor.execute({
      source: 'cli',
      area: 'plan',
      action: 'runs',
      positionals: ['plan', 'runs'],
      options: {
        slug: 'owner/repo',
        limit: '5',
        state: 'blocked',
      },
      featureFlagEnabled: true,
    });

    assert.ok(planRunsInput);
    assert.strictEqual(planRunsInput.slug, 'owner/repo');
    assert.strictEqual(planRunsInput.limit, '5');
    assert.strictEqual(planRunsInput.state, 'blocked');
    assert.strictEqual(report.success, true);
    assert.strictEqual(report.capability.key, 'plan.runs');
    assert.strictEqual(report.policy.allowed, true);
  });

  await test('executor routes plan inspect to the shared plan.inspect capability', async () => {
    let planInspectInput = null;
    const executor = createGitHubCommandExecutor({
      env: {},
      cwd: 'C:/dev/copilot-Liku-cli',
      inspectGitHubPlanRun(input) {
        planInspectInput = input;
        return Promise.resolve({
          success: true,
          schemaVersion: 'github.plan-inspect.v1',
          localOnly: true,
          target: { slug: 'owner/repo' },
          run: {
            runId: 'github-run-1',
            state: 'completed',
            slug: 'owner/repo',
          },
          planArtifact: { filePath: 'github-plan-1.plan.json' },
          eventLog: { filePath: 'github-plan-1.github-run-1.events.jsonl', eventCount: 3 },
          stepResults: [],
          warnings: [],
        });
      },
    });

    const report = await executor.execute({
      source: 'cli',
      area: 'plan',
      action: 'inspect',
      positionals: ['plan', 'inspect', 'github-run-1'],
      options: {
        slug: 'owner/repo',
        'plan-file': 'C:/tmp/github-plan-1.plan.json',
        'event-log-file': 'C:/tmp/github-plan-1.github-run-1.events.jsonl',
      },
      featureFlagEnabled: true,
    });

    assert.ok(planInspectInput);
    assert.strictEqual(planInspectInput.slug, 'owner/repo');
    assert.strictEqual(planInspectInput.runId, 'github-run-1');
    assert.strictEqual(planInspectInput.planFile, 'C:/tmp/github-plan-1.plan.json');
    assert.strictEqual(planInspectInput.eventLogFile, 'C:/tmp/github-plan-1.github-run-1.events.jsonl');
    assert.strictEqual(report.success, true);
    assert.strictEqual(report.capability.key, 'plan.inspect');
    assert.strictEqual(report.policy.allowed, true);
  });

  await test('executor routes ruleset list to the shared ruleset.list capability', async () => {
    let rulesetInput = null;
    const executor = createGitHubCommandExecutor({
      env: {},
      cwd: 'C:/dev/copilot-Liku-cli',
      listGitHubRulesets(input) {
        rulesetInput = input;
        return Promise.resolve({
          success: true,
          schemaVersion: 'github.ruleset-list.v1',
          filters: { limit: 5 },
          rulesets: [],
          githubApi: { attempted: false },
          warnings: [],
        });
      },
    });

    const report = await executor.execute({
      source: 'cli',
      area: 'rulesets',
      action: 'list',
      positionals: ['rulesets', 'list'],
      options: { slug: 'owner/repo', limit: '5', api: 'false' },
      featureFlagEnabled: true,
    });

    assert.ok(rulesetInput);
    assert.strictEqual(rulesetInput.slug, 'owner/repo');
    assert.strictEqual(rulesetInput.limit, '5');
    assert.strictEqual(rulesetInput.api, false);
    assert.strictEqual(report.capability.key, 'ruleset.list');
    assert.strictEqual(report.policy.allowed, true);
  });

  await test('executor routes app permissions inspect to the shared app.permissions.inspect capability', async () => {
    let permissionsInput = null;
    const executor = createGitHubCommandExecutor({
      env: {},
      cwd: 'C:/dev/copilot-Liku-cli',
      inspectGitHubAppPermissions(input) {
        permissionsInput = input;
        return Promise.resolve({
          success: true,
          schemaVersion: 'github.app-permissions-inspect.v1',
          installation: { appSlug: 'liku-bot' },
          permissions: { contents: 'read' },
          permissionCount: 1,
          events: ['push'],
          eventCount: 1,
          githubApi: { attempted: false },
          warnings: [],
        });
      },
    });

    const report = await executor.execute({
      source: 'slash',
      area: 'app',
      action: 'permissions',
      positionals: ['app', 'permissions', 'inspect'],
      options: { slug: 'owner/repo', api: 'false' },
      featureFlagEnabled: true,
    });

    assert.ok(permissionsInput);
    assert.strictEqual(permissionsInput.slug, 'owner/repo');
    assert.strictEqual(permissionsInput.api, false);
    assert.strictEqual(report.capability.key, 'app.permissions.inspect');
    assert.strictEqual(report.policy.allowed, true);
    assert.strictEqual(report.permissionCount, 1);
  });

  await test('executor records failure telemetry for usage-level adapter failures', async () => {
    const telemetry = [];
    const executor = createGitHubCommandExecutor({
      env: {},
      cwd: 'C:/dev/copilot-Liku-cli',
      inspectGitHubPullRequest() {
        return Promise.resolve({
          success: false,
          error: 'USAGE',
          message: 'Usage: liku github pr inspect <number>',
          warnings: [],
        });
      },
      writeTelemetry(payload) {
        telemetry.push(payload);
        return payload;
      },
    });

    const report = await executor.execute({
      source: 'cli',
      area: 'pr',
      action: 'inspect',
      positionals: ['pr', 'inspect'],
      options: {},
      featureFlagEnabled: true,
      executionPreferences: { approvalMode: 'auto' },
    });

    assert.strictEqual(report.success, false);
    assert.strictEqual(report.error, 'USAGE');
    assert.strictEqual(report.capability.key, 'pr.inspect');
    assert.strictEqual(report.policy.allowed, true);
    assert.strictEqual(telemetry.length, 1);
    assert.strictEqual(telemetry[0].outcome, 'failure');
    assert.strictEqual(telemetry[0].actions[0].capability, 'pr.inspect');
    assert.strictEqual(telemetry[0].context.result.error, 'USAGE');
  });

  await test('executor enforces CLI-only apply policy before adapter execution', async () => {
    let applyCalled = false;
    const executor = createGitHubCommandExecutor({
      env: {},
      cwd: 'C:/dev/copilot-Liku-cli',
      applyGitHubWritePreview() {
        applyCalled = true;
        return Promise.resolve({ success: true });
      },
    });

    const report = await executor.execute({
      source: 'slash',
      area: 'apply',
      action: 'preview-123',
      positionals: ['apply', 'preview-123'],
      options: { approve: true },
      featureFlagEnabled: true,
      writeFeatureFlagEnabled: true,
      executionPreferences: { approvalMode: 'prompt' },
    });

    assert.strictEqual(report.success, false);
    assert.strictEqual(report.error, 'POLICY_DENIED');
    assert.strictEqual(report.capability.key, 'github.apply');
    assert.strictEqual(report.policy.reason, 'source-not-allowed');
    assert.strictEqual(applyCalled, false);
  });

  console.log(`PASS github capability registry/policy (${pass} assertions)`);
})().catch((error) => {
  console.error('FAIL github capability registry/policy');
  console.error(error.stack || error.message);
  process.exit(1);
});
