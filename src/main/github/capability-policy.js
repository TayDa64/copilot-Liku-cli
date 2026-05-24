function normalizeApprovalMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'default';
  if (['default', 'auto', 'always', 'never', 'on-request', 'on_request'].includes(normalized)) {
    return normalized === 'on_request' ? 'on-request' : normalized;
  }
  return 'default';
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
    return {
      allowed: false,
      reason: 'unknown-capability',
      source,
      capabilityKey: null,
      sideEffectClass: null,
      riskLevel: null,
      approvalRequirement: null,
      approvalMode: normalizeApprovalMode(executionPreferences.approvalMode || runtimeOptions.approvalMode),
      requiresApproval: false,
      dryRunRequested: false,
      effectiveDryRun: false,
    };
  }

  const allowedSources = Array.isArray(capability.allowedSources) ? capability.allowedSources : [];
  const approvalMode = normalizeApprovalMode(executionPreferences.approvalMode || runtimeOptions.approvalMode);
  const sideEffectClass = String(capability.sideEffectClass || 'read').trim().toLowerCase() || 'read';
  const approvalRequirement = String(capability.approvalRequirement || 'none').trim().toLowerCase() || 'none';
  const dryRunRequested = runtimeOptions.dryRun === true || executionPreferences.dryRunDefault === true;

  if (allowedSources.length > 0 && !allowedSources.includes(source)) {
    return {
      allowed: false,
      reason: 'source-not-allowed',
      source,
      capabilityKey: capability.key,
      sideEffectClass,
      riskLevel: capability.riskLevel || 'unknown',
      approvalRequirement,
      approvalMode,
      requiresApproval: approvalRequirement !== 'none',
      dryRunRequested,
      effectiveDryRun: capability.supportsDryRun === true && dryRunRequested,
    };
  }

  if (sideEffectClass !== 'read') {
    return {
      allowed: false,
      reason: 'mutation-capability-disabled',
      source,
      capabilityKey: capability.key,
      sideEffectClass,
      riskLevel: capability.riskLevel || 'unknown',
      approvalRequirement,
      approvalMode,
      requiresApproval: approvalRequirement !== 'none',
      dryRunRequested,
      effectiveDryRun: capability.supportsDryRun === true && dryRunRequested,
    };
  }

  return {
    allowed: true,
    reason: 'read-only-capability-allowed',
    source,
    capabilityKey: capability.key,
    sideEffectClass,
    riskLevel: capability.riskLevel || 'unknown',
    approvalRequirement,
    approvalMode,
    requiresApproval: false,
    dryRunRequested,
    effectiveDryRun: capability.supportsDryRun === true && dryRunRequested,
  };
}

module.exports = {
  evaluateGitHubCapabilityPolicy,
  normalizeApprovalMode,
};
