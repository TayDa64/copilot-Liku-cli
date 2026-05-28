const { getGitHubCapability, listGitHubCapabilities } = require('./capability-registry');
const { evaluateGitHubCapabilityPolicy } = require('./capability-policy');

const GITHUB_CAPABILITIES_LIST_SCHEMA_VERSION = 'github.capabilities-list.v1';
const GITHUB_CAPABILITY_INSPECT_SCHEMA_VERSION = 'github.capability-inspect.v1';

function normalizeSourceList(value, fallback = ['cli', 'slash']) {
  if (!Array.isArray(value) || value.length === 0) {
    return fallback.slice();
  }

  return value
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter(Boolean);
}

function buildPolicyBySource(capability, options = {}) {
  const sources = normalizeSourceList(options.sources, capability?.allowedSources || ['cli', 'slash']);
  const executionPreferences = options.executionPreferences && typeof options.executionPreferences === 'object'
    ? options.executionPreferences
    : {};
  const runtimeOptions = options.runtimeOptions && typeof options.runtimeOptions === 'object'
    ? options.runtimeOptions
    : {};
  const featureFlagEnabled = options.featureFlagEnabled === true;
  const writeFeatureFlagEnabled = options.writeFeatureFlagEnabled === true;
  const evaluatePolicy = typeof options.evaluateGitHubCapabilityPolicy === 'function'
    ? options.evaluateGitHubCapabilityPolicy
    : evaluateGitHubCapabilityPolicy;

  const preview = {};
  sources.forEach((source) => {
    preview[source] = evaluatePolicy({
      capability,
      source,
      executionPreferences,
      runtimeOptions,
      featureFlagEnabled,
      writeFeatureFlagEnabled,
    });
  });
  return preview;
}

function summarizeCapabilityEntry(capability, options = {}) {
  return {
    ...capability,
    policyBySource: buildPolicyBySource(capability, options),
  };
}

function listGitHubCapabilityCatalog(options = {}) {
  const capabilities = (typeof options.listGitHubCapabilities === 'function'
    ? options.listGitHubCapabilities
    : listGitHubCapabilities)()
    .map((capability) => summarizeCapabilityEntry(capability, options));

  return {
    schemaVersion: GITHUB_CAPABILITIES_LIST_SCHEMA_VERSION,
    success: true,
    total: capabilities.length,
    capabilities,
  };
}

function inspectGitHubCapabilityCatalogEntry(options = {}) {
  const key = String(options.key || '').trim().toLowerCase();
  if (!key) {
    return {
      schemaVersion: GITHUB_CAPABILITY_INSPECT_SCHEMA_VERSION,
      success: false,
      error: 'USAGE',
      message: 'Usage: liku github capabilities inspect <capability-key>',
    };
  }

  const getCapability = typeof options.getGitHubCapability === 'function'
    ? options.getGitHubCapability
    : getGitHubCapability;
  const capability = getCapability(key);

  if (!capability) {
    return {
      schemaVersion: GITHUB_CAPABILITY_INSPECT_SCHEMA_VERSION,
      success: false,
      error: 'NOT_FOUND',
      message: `Unknown GitHub capability: ${key}`,
      key,
      availableKeys: (typeof options.listGitHubCapabilities === 'function'
        ? options.listGitHubCapabilities
        : listGitHubCapabilities)().map((entry) => entry.key),
    };
  }

  return {
    schemaVersion: GITHUB_CAPABILITY_INSPECT_SCHEMA_VERSION,
    success: true,
    key,
    entry: summarizeCapabilityEntry(capability, options),
  };
}

module.exports = {
  GITHUB_CAPABILITIES_LIST_SCHEMA_VERSION,
  GITHUB_CAPABILITY_INSPECT_SCHEMA_VERSION,
  buildPolicyBySource,
  inspectGitHubCapabilityCatalogEntry,
  listGitHubCapabilityCatalog,
  summarizeCapabilityEntry,
};
