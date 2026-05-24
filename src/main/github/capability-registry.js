const registeredGitHubCapabilities = [];

const DEFAULT_GITHUB_CAPABILITIES = [
  {
    key: 'capabilities.list',
    area: 'capabilities',
    action: 'list',
    description: 'List the registered GitHub capabilities and their policy metadata.',
    responseSchemaVersion: 'github.capabilities-list.v1',
    sideEffectClass: 'read',
    approvalRequirement: 'none',
    riskLevel: 'low',
    supportsDryRun: false,
    allowedSources: ['cli', 'slash'],
    positionalArguments: [],
    optionKeys: [],
  },
  {
    key: 'capabilities.inspect',
    area: 'capabilities',
    action: 'inspect',
    description: 'Inspect one registered GitHub capability and its policy metadata.',
    responseSchemaVersion: 'github.capability-inspect.v1',
    sideEffectClass: 'read',
    approvalRequirement: 'none',
    riskLevel: 'low',
    supportsDryRun: false,
    allowedSources: ['cli', 'slash'],
    positionalArguments: ['key'],
    optionKeys: [],
  },
  {
    key: 'plan.build',
    area: 'plan',
    action: 'build',
    description: 'Build a deterministic one-step execution plan for a registered GitHub capability.',
    responseSchemaVersion: 'github.plan-build.v1',
    sideEffectClass: 'read',
    approvalRequirement: 'none',
    riskLevel: 'low',
    supportsDryRun: false,
    allowedSources: ['cli', 'slash'],
    positionalArguments: ['targetArea', 'targetAction'],
    optionKeys: ['probe', 'api', 'slug', 'state', 'limit', 'labels', 'base', 'head', 'workflow', 'branch', 'status', 'event'],
  },
  {
    key: 'plan.execute',
    area: 'plan',
    action: 'execute',
    description: 'Execute a deterministic read-only GitHub execution plan within bounded step and timeout budgets.',
    responseSchemaVersion: 'github.plan-execute.v1',
    sideEffectClass: 'read',
    approvalRequirement: 'none',
    riskLevel: 'low',
    supportsDryRun: false,
    allowedSources: ['cli', 'slash'],
    positionalArguments: ['targetArea', 'targetAction'],
    optionKeys: ['planFile', 'probe', 'api', 'slug', 'state', 'limit', 'labels', 'base', 'head', 'workflow', 'branch', 'status', 'event'],
  },
  {
    key: 'auth.status',
    area: 'auth',
    action: 'status',
    description: 'Inspect Copilot and GitHub authentication state without mutating anything.',
    responseSchemaVersion: 'github.auth-status.v1',
    sideEffectClass: 'read',
    approvalRequirement: 'none',
    riskLevel: 'low',
    supportsDryRun: false,
    allowedSources: ['cli', 'slash'],
    positionalArguments: [],
    optionKeys: ['probe'],
  },
  {
    key: 'repo.inspect',
    area: 'repo',
    action: 'inspect',
    description: 'Inspect the detected or requested GitHub repository and summarize metadata.',
    responseSchemaVersion: 'github.repo-inspect.v1',
    sideEffectClass: 'read',
    approvalRequirement: 'none',
    riskLevel: 'low',
    supportsDryRun: false,
    allowedSources: ['cli', 'slash'],
    positionalArguments: [],
    optionKeys: ['api', 'slug'],
  },
  {
    key: 'issues.list',
    area: 'issues',
    action: 'list',
    description: 'List GitHub issues for the current or requested repository.',
    responseSchemaVersion: 'github.issues-list.v1',
    sideEffectClass: 'read',
    approvalRequirement: 'none',
    riskLevel: 'low',
    supportsDryRun: false,
    allowedSources: ['cli', 'slash'],
    positionalArguments: [],
    optionKeys: ['api', 'slug', 'state', 'limit', 'labels'],
  },
  {
    key: 'issues.inspect',
    area: 'issues',
    action: 'inspect',
    description: 'Inspect one GitHub issue by number.',
    responseSchemaVersion: 'github.issue-inspect.v1',
    sideEffectClass: 'read',
    approvalRequirement: 'none',
    riskLevel: 'low',
    supportsDryRun: false,
    allowedSources: ['cli', 'slash'],
    positionalArguments: ['number'],
    optionKeys: ['api', 'slug'],
  },
  {
    key: 'pr.list',
    area: 'pr',
    action: 'list',
    description: 'List GitHub pull requests for the current or requested repository.',
    responseSchemaVersion: 'github.pr-list.v1',
    sideEffectClass: 'read',
    approvalRequirement: 'none',
    riskLevel: 'low',
    supportsDryRun: false,
    allowedSources: ['cli', 'slash'],
    positionalArguments: [],
    optionKeys: ['api', 'slug', 'state', 'limit', 'base', 'head'],
  },
  {
    key: 'pr.inspect',
    area: 'pr',
    action: 'inspect',
    description: 'Inspect one GitHub pull request by number.',
    responseSchemaVersion: 'github.pr-inspect.v1',
    sideEffectClass: 'read',
    approvalRequirement: 'none',
    riskLevel: 'low',
    supportsDryRun: false,
    allowedSources: ['cli', 'slash'],
    positionalArguments: ['number'],
    optionKeys: ['api', 'slug'],
  },
  {
    key: 'pr.diff',
    area: 'pr',
    action: 'diff',
    description: 'Summarize changed files for one GitHub pull request.',
    responseSchemaVersion: 'github.pr-diff-summary.v1',
    sideEffectClass: 'read',
    approvalRequirement: 'none',
    riskLevel: 'low',
    supportsDryRun: false,
    allowedSources: ['cli', 'slash'],
    positionalArguments: ['number'],
    optionKeys: ['api', 'slug', 'limit'],
  },
  {
    key: 'workflow.runs',
    area: 'workflow',
    action: 'runs',
    description: 'List GitHub Actions workflow runs for the current or requested repository.',
    responseSchemaVersion: 'github.workflow-runs.v1',
    sideEffectClass: 'read',
    approvalRequirement: 'none',
    riskLevel: 'low',
    supportsDryRun: false,
    allowedSources: ['cli', 'slash'],
    positionalArguments: [],
    optionKeys: ['api', 'slug', 'workflow', 'branch', 'status', 'event', 'limit'],
  },
  {
    key: 'workflow.inspect',
    area: 'workflow',
    action: 'inspect',
    description: 'Inspect one GitHub Actions workflow run by id.',
    responseSchemaVersion: 'github.workflow-inspect.v1',
    sideEffectClass: 'read',
    approvalRequirement: 'none',
    riskLevel: 'low',
    supportsDryRun: false,
    allowedSources: ['cli', 'slash'],
    positionalArguments: ['runId'],
    optionKeys: ['api', 'slug'],
  },
  {
    key: 'releases.list',
    area: 'releases',
    action: 'list',
    description: 'List GitHub releases for the current or requested repository.',
    responseSchemaVersion: 'github.releases-list.v1',
    sideEffectClass: 'read',
    approvalRequirement: 'none',
    riskLevel: 'low',
    supportsDryRun: false,
    allowedSources: ['cli', 'slash'],
    positionalArguments: [],
    optionKeys: ['api', 'slug', 'limit'],
  },
  {
    key: 'releases.inspect',
    area: 'releases',
    action: 'inspect',
    description: 'Inspect one GitHub release by latest, tag, or numeric id.',
    responseSchemaVersion: 'github.release-inspect.v1',
    sideEffectClass: 'read',
    approvalRequirement: 'none',
    riskLevel: 'low',
    supportsDryRun: false,
    allowedSources: ['cli', 'slash'],
    positionalArguments: ['selector'],
    optionKeys: ['api', 'slug'],
  },
];

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter(Boolean);
}

function cloneGitHubCapability(capability = {}) {
  return {
    key: capability.key,
    area: capability.area,
    action: capability.action,
    description: capability.description,
    responseSchemaVersion: capability.responseSchemaVersion || null,
    sideEffectClass: capability.sideEffectClass,
    approvalRequirement: capability.approvalRequirement,
    riskLevel: capability.riskLevel,
    supportsDryRun: capability.supportsDryRun === true,
    allowedSources: Array.isArray(capability.allowedSources) ? capability.allowedSources.slice() : [],
    positionalArguments: Array.isArray(capability.positionalArguments) ? capability.positionalArguments.slice() : [],
    optionKeys: Array.isArray(capability.optionKeys) ? capability.optionKeys.slice() : [],
  };
}

function normalizeGitHubCapabilityDefinition(definition = {}) {
  const area = String(definition.area || '').trim().toLowerCase();
  const action = String(definition.action || '').trim().toLowerCase();
  const key = String(definition.key || `${area}.${action}`).trim().toLowerCase();

  if (!area || !action) {
    throw new Error('GitHub capability definitions require area and action');
  }
  if (!key) {
    throw new Error('GitHub capability definitions require a key');
  }

  return {
    key,
    area,
    action,
    description: String(definition.description || '').trim(),
    responseSchemaVersion: String(definition.responseSchemaVersion || '').trim() || null,
    sideEffectClass: String(definition.sideEffectClass || 'read').trim().toLowerCase() || 'read',
    approvalRequirement: String(definition.approvalRequirement || 'none').trim().toLowerCase() || 'none',
    riskLevel: String(definition.riskLevel || 'low').trim().toLowerCase() || 'low',
    supportsDryRun: definition.supportsDryRun === true,
    allowedSources: normalizeStringArray(definition.allowedSources && definition.allowedSources.length ? definition.allowedSources : ['cli', 'slash']),
    positionalArguments: normalizeStringArray(definition.positionalArguments),
    optionKeys: normalizeStringArray(definition.optionKeys),
  };
}

function sortRegisteredGitHubCapabilities() {
  registeredGitHubCapabilities.sort((left, right) => {
    const leftArea = String(left.area || '');
    const rightArea = String(right.area || '');
    if (leftArea !== rightArea) {
      return leftArea.localeCompare(rightArea);
    }
    const leftAction = String(left.action || '');
    const rightAction = String(right.action || '');
    if (leftAction !== rightAction) {
      return leftAction.localeCompare(rightAction);
    }
    return String(left.key || '').localeCompare(String(right.key || ''));
  });
}

function registerGitHubCapability(definition) {
  const capability = normalizeGitHubCapabilityDefinition(definition);
  const existingIndex = registeredGitHubCapabilities.findIndex((entry) => entry.key === capability.key);

  if (existingIndex >= 0) {
    registeredGitHubCapabilities[existingIndex] = capability;
  } else {
    registeredGitHubCapabilities.push(capability);
  }

  sortRegisteredGitHubCapabilities();
  return cloneGitHubCapability(capability);
}

function unregisterGitHubCapability(key) {
  const normalizedKey = String(key || '').trim().toLowerCase();
  const existingIndex = registeredGitHubCapabilities.findIndex((entry) => entry.key === normalizedKey);
  if (existingIndex >= 0) {
    registeredGitHubCapabilities.splice(existingIndex, 1);
    return true;
  }
  return false;
}

function getGitHubCapability(key) {
  const normalizedKey = String(key || '').trim().toLowerCase();
  const capability = registeredGitHubCapabilities.find((entry) => entry.key === normalizedKey);
  return capability ? cloneGitHubCapability(capability) : null;
}

function findGitHubCapability(area, action) {
  const normalizedArea = String(area || '').trim().toLowerCase();
  const normalizedAction = String(action || '').trim().toLowerCase();
  const capability = registeredGitHubCapabilities.find((entry) => entry.area === normalizedArea && entry.action === normalizedAction);
  return capability ? cloneGitHubCapability(capability) : null;
}

function listGitHubCapabilities() {
  return registeredGitHubCapabilities.map((entry) => cloneGitHubCapability(entry));
}

DEFAULT_GITHUB_CAPABILITIES.forEach((definition) => {
  registerGitHubCapability(definition);
});

module.exports = {
  findGitHubCapability,
  getGitHubCapability,
  listGitHubCapabilities,
  registerGitHubCapability,
  unregisterGitHubCapability,
};
