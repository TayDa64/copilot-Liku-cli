const DEFAULT_APPROVAL_MODE = 'prompt';
const APPROVAL_MODES = new Set(['prompt', 'auto', 'never']);

function parseBooleanEnvFlag(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return !!defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on', 'enabled'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off', 'disabled'].includes(normalized)) {
    return false;
  }
  return !!defaultValue;
}

function normalizeApprovalMode(value, defaultValue = DEFAULT_APPROVAL_MODE) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }

  const aliases = {
    ask: 'prompt',
    manual: 'prompt',
    approve: 'prompt',
    automatic: 'auto',
    always: 'auto',
    block: 'never',
    disabled: 'never',
    off: 'never',
  };

  const resolved = aliases[normalized] || normalized;
  return APPROVAL_MODES.has(resolved) ? resolved : defaultValue;
}

function readCliFeatureFlags(env = process.env) {
  return {
    enableGitHub: parseBooleanEnvFlag(env.LIKU_ENABLE_GITHUB, false),
    enableAgents: parseBooleanEnvFlag(env.LIKU_ENABLE_AGENTS, true),
    enableDynamicTools: parseBooleanEnvFlag(env.LIKU_ENABLE_DYNAMIC_TOOLS, true),
    approvalMode: normalizeApprovalMode(env.LIKU_APPROVAL_MODE, DEFAULT_APPROVAL_MODE),
    dryRunDefault: parseBooleanEnvFlag(env.LIKU_DRY_RUN_DEFAULT, false),
  };
}

module.exports = {
  APPROVAL_MODES,
  DEFAULT_APPROVAL_MODE,
  normalizeApprovalMode,
  parseBooleanEnvFlag,
  readCliFeatureFlags,
};
