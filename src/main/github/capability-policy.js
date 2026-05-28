const { normalizeApprovalMode: normalizeCliApprovalMode } = require('../../cli/feature-flags');

function normalizeApprovalMode(value, fallback = 'prompt') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized === 'default') return fallback;
  if (normalized === 'on-request' || normalized === 'on_request') return 'prompt';
  return normalizeCliApprovalMode(normalized, fallback);
}

function resolveFeatureFlags(options = {}) {
  const runtimeOptions = options.runtimeOptions && typeof options.runtimeOptions === 'object'
    ? options.runtimeOptions
    : {};
  const runtimeFeatureFlags = runtimeOptions.featureFlags && typeof runtimeOptions.featureFlags === 'object'
    ? runtimeOptions.featureFlags
    : {};

  return {
    githubEnabled: options.featureFlagEnabled === true || runtimeFeatureFlags.enableGitHub === true,
    githubWritesEnabled: options.writeFeatureFlagEnabled === true || runtimeFeatureFlags.enableGitHubWrites === true,
  };
}

function buildPolicyResult(fields = {}) {
  return {
    allowed: false,
    state: 'apply-denied',
    reason: 'policy-denied',
    source: 'unknown',
    capabilityKey: null,
    sideEffectClass: null,
    riskLevel: null,
    writeTargetClass: null,
    requiredPermissions: [],
    approvalRequirement: null,
    approvalMode: 'prompt',
    requiresApproval: false,
    approvalSatisfied: false,
    previewAllowed: false,
    applyAllowed: false,
    writeEnabled: false,
    dryRunRequested: false,
    effectiveDryRun: false,
    ...fields,
  };
}

function evaluateGitHubCapabilityPolicy(options = {}) {
  const capability = options.capability && typeof options.capability === 'object'
    ? options.capability
    : null;
  const source = String(options.source || 'unknown').trim().toLowerCase() || 'unknown';
  const executionPreferences = options.executionPreferences && typeof options.executionPreferences === 'object'
    ? options.executionPreferences
    : {};
  const runtimeOptions = options.runtimeOptions && typeof options.runtimeOptions === 'object'
    ? options.runtimeOptions
    : {};

  if (!capability) {
    return buildPolicyResult({
      reason: 'unknown-capability',
      source,
      capabilityKey: null,
      sideEffectClass: null,
      riskLevel: null,
      approvalRequirement: null,
      approvalMode: normalizeApprovalMode(executionPreferences.approvalMode || runtimeOptions.approvalMode),
    });
  }

  const allowedSources = Array.isArray(capability.allowedSources) ? capability.allowedSources : [];
  const approvalMode = normalizeApprovalMode(executionPreferences.approvalMode || runtimeOptions.approvalMode);
  const sideEffectClass = String(capability.sideEffectClass || 'read').trim().toLowerCase() || 'read';
  const approvalRequirement = String(capability.approvalRequirement || 'none').trim().toLowerCase() || 'none';
  const dryRunRequested = runtimeOptions.dryRun === true || executionPreferences.dryRunDefault === true;
  const requiresApproval = approvalRequirement !== 'none';
  const approvalSatisfied = runtimeOptions.approve === true;
  const featureFlags = resolveFeatureFlags(options);
  const basePolicy = {
    source,
    capabilityKey: capability.key,
    sideEffectClass,
    riskLevel: capability.riskLevel || 'unknown',
    writeTargetClass: capability.writeTargetClass || null,
    requiredPermissions: Array.isArray(capability.requiredPermissions) ? capability.requiredPermissions.slice() : [],
    approvalRequirement,
    approvalMode,
    requiresApproval,
    approvalSatisfied,
    writeEnabled: featureFlags.githubEnabled && featureFlags.githubWritesEnabled,
    dryRunRequested,
    effectiveDryRun: capability.supportsDryRun === true && dryRunRequested,
  };

  if (allowedSources.length > 0 && !allowedSources.includes(source)) {
    return buildPolicyResult({
      ...basePolicy,
      reason: 'source-not-allowed',
    });
  }

  if (sideEffectClass === 'read') {
    return buildPolicyResult({
      ...basePolicy,
      allowed: true,
      state: 'read-allowed',
      reason: 'read-only-capability-allowed',
    });
  }

  if (['high', 'critical'].includes(String(capability.riskLevel || '').trim().toLowerCase())) {
    return buildPolicyResult({
      ...basePolicy,
      reason: 'high-risk-mutation-disabled',
    });
  }

  if (!featureFlags.githubEnabled) {
    return buildPolicyResult({
      ...basePolicy,
      reason: 'github-capability-disabled',
    });
  }

  if (!featureFlags.githubWritesEnabled) {
    return buildPolicyResult({
      ...basePolicy,
      reason: 'github-write-capability-disabled',
    });
  }

  if (sideEffectClass === 'preview') {
    return buildPolicyResult({
      ...basePolicy,
      allowed: true,
      state: 'preview-allowed',
      reason: 'preview-capability-allowed',
      previewAllowed: true,
      effectiveDryRun: capability.supportsDryRun === true && (dryRunRequested || true),
    });
  }

  if (sideEffectClass === 'write') {
    if (!requiresApproval) {
      return buildPolicyResult({
        ...basePolicy,
        allowed: true,
        state: 'apply-allowed',
        reason: 'apply-capability-allowed',
        applyAllowed: true,
      });
    }

    if (!approvalSatisfied) {
      return buildPolicyResult({
        ...basePolicy,
        state: approvalMode === 'never' ? 'apply-denied' : 'approval-required',
        reason: approvalMode === 'never' ? 'approval-mode-never' : 'explicit-approval-required',
      });
    }

    return buildPolicyResult({
      ...basePolicy,
      allowed: true,
      state: 'apply-allowed',
      reason: 'apply-capability-allowed',
      applyAllowed: true,
      approvalSatisfied: true,
    });
  }

  return buildPolicyResult({
    ...basePolicy,
    reason: 'unsupported-side-effect-class',
  });
}

module.exports = {
  evaluateGitHubCapabilityPolicy,
  normalizeApprovalMode,
};
