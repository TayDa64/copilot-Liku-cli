/**
 * Preferences store for Copilot-Liku.
 *
 * Goal: capture small, high-signal user choices (e.g., "always allow auto-exec in this app")
 * and apply them deterministically in future chat/automation loops.
 */

const fs = require('fs');
const path = require('path');

const { LIKU_HOME } = require('../shared/liku-home');
const PREFS_FILE = path.join(LIKU_HOME, 'preferences.json');

const EXECUTION_MODE = {
  PROMPT: 'prompt',
  AUTO: 'auto'
};

function nowIso() {
  return new Date().toISOString();
}

function ensureDir() {
  if (!fs.existsSync(LIKU_HOME)) {
    fs.mkdirSync(LIKU_HOME, { recursive: true, mode: 0o700 });
  }
}

function defaultPrefs() {
  return {
    version: 1,
    updatedAt: nowIso(),
    appPolicies: {}
  };
}

function normalizeAppKey(processName) {
  const key = String(processName || '').trim().toLowerCase();
  return key || null;
}

function loadPreferences() {
  try {
    ensureDir();
    if (!fs.existsSync(PREFS_FILE)) {
      return defaultPrefs();
    }
    const raw = fs.readFileSync(PREFS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaultPrefs();
    if (!parsed.appPolicies || typeof parsed.appPolicies !== 'object') parsed.appPolicies = {};
    if (typeof parsed.version !== 'number') parsed.version = 1;
    return parsed;
  } catch {
    return defaultPrefs();
  }
}

function savePreferences(prefs) {
  ensureDir();
  const toSave = {
    ...defaultPrefs(),
    ...prefs,
    updatedAt: nowIso()
  };
  fs.writeFileSync(PREFS_FILE, JSON.stringify(toSave, null, 2));
  return toSave;
}

function getAppPolicy(processName) {
  const prefs = loadPreferences();
  const key = normalizeAppKey(processName);
  if (!key) return null;
  const policy = prefs.appPolicies[key];
  if (!policy) return null;
  return { key, ...policy };
}

function setAppExecutionMode(processName, mode, meta = {}) {
  const key = normalizeAppKey(processName);
  if (!key) return { success: false, error: 'Missing processName' };

  const prefs = loadPreferences();
  const existing = prefs.appPolicies[key] || {};

  const next = {
    executionMode: mode,
    stats: existing.stats || { autoConsecutiveFailures: 0, autoSuccesses: 0, autoFailures: 0 },
    // Future: choice learning (how to act) + negative policies (what to avoid).
    // Kept here to avoid schema churn later.
    actionPolicies: Array.isArray(existing.actionPolicies) ? existing.actionPolicies : [],
    negativePolicies: Array.isArray(existing.negativePolicies) ? existing.negativePolicies : [],
    createdAt: existing.createdAt || nowIso(),
    updatedAt: nowIso(),
    lastSeenTitle: meta.title || existing.lastSeenTitle || ''
  };

  prefs.appPolicies[key] = next;
  savePreferences(prefs);
  return { success: true, key, policy: next };
}

function ensureAppPolicyShape(existing = {}, mode = EXECUTION_MODE.PROMPT, meta = {}) {
  return {
    executionMode: existing.executionMode || mode,
    stats: existing.stats || { autoConsecutiveFailures: 0, autoSuccesses: 0, autoFailures: 0 },
    actionPolicies: Array.isArray(existing.actionPolicies) ? existing.actionPolicies : [],
    negativePolicies: Array.isArray(existing.negativePolicies) ? existing.negativePolicies : [],
    createdAt: existing.createdAt || nowIso(),
    updatedAt: nowIso(),
    lastSeenTitle: meta.title || existing.lastSeenTitle || ''
  };
}

function mergeAppPolicy(processName, patch = {}, meta = {}) {
  const key = normalizeAppKey(processName);
  if (!key) return { success: false, error: 'Missing processName' };

  const prefs = loadPreferences();
  const existing = prefs.appPolicies[key] || {};
  const next = ensureAppPolicyShape(existing, EXECUTION_MODE.PROMPT, meta);

  const incomingNegative = Array.isArray(patch.negativePolicies) ? patch.negativePolicies : [];
  const incomingAction = Array.isArray(patch.actionPolicies) ? patch.actionPolicies : [];

  const withMetrics = (rule) => {
    if (!rule || typeof rule !== 'object') return null;
    const nextRule = { ...rule };
    if (!nextRule.metrics || typeof nextRule.metrics !== 'object') {
      nextRule.metrics = { successes: 0, failures: 0 };
    } else {
      if (!Number.isFinite(Number(nextRule.metrics.successes))) nextRule.metrics.successes = 0;
      if (!Number.isFinite(Number(nextRule.metrics.failures))) nextRule.metrics.failures = 0;
    }
    return nextRule;
  };

  if (incomingNegative.length) {
    next.negativePolicies = [...next.negativePolicies, ...incomingNegative.map(withMetrics).filter(Boolean)];
  }
  if (incomingAction.length) {
    next.actionPolicies = [...next.actionPolicies, ...incomingAction.map(withMetrics).filter(Boolean)];
  }

  // Keep execution mode and stats stable; only update metadata/policies.
  next.executionMode = existing.executionMode || next.executionMode;
  next.stats = existing.stats || next.stats;
  next.updatedAt = nowIso();

  prefs.appPolicies[key] = next;
  savePreferences(prefs);
  return { success: true, key, policy: next };
}

function recordAutoRunOutcome(processName, success) {
  const key = normalizeAppKey(processName);
  if (!key) return { success: false, error: 'Missing processName' };

  const prefs = loadPreferences();
  const policy = prefs.appPolicies[key];
  if (!policy || policy.executionMode !== EXECUTION_MODE.AUTO) {
    return { success: true, demoted: false };
  }

  if (!policy.stats || typeof policy.stats !== 'object') {
    policy.stats = { autoConsecutiveFailures: 0, autoSuccesses: 0, autoFailures: 0 };
  }

  if (success) {
    policy.stats.autoConsecutiveFailures = 0;
    policy.stats.autoSuccesses += 1;
    policy.stats.lastAutoSuccessAt = nowIso();
  } else {
    policy.stats.autoConsecutiveFailures += 1;
    policy.stats.autoFailures += 1;
    policy.stats.lastAutoFailureAt = nowIso();
  }

  let demoted = false;
  if (policy.stats.autoConsecutiveFailures >= 2) {
    policy.executionMode = EXECUTION_MODE.PROMPT;
    policy.stats.autoConsecutiveFailures = 0;
    policy.stats.lastAutoDemotedAt = nowIso();
    demoted = true;
  }

  policy.updatedAt = nowIso();
  prefs.appPolicies[key] = policy;
  savePreferences(prefs);

  return { success: true, demoted, key, policy };
}

function resolveTargetProcessNameFromActions(actionData) {
  const actions = actionData?.actions;
  if (!Array.isArray(actions)) return null;

  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    // If the model explicitly names a process, prefer that.
    if (typeof action.processName === 'string' && action.processName.trim()) {
      return action.processName.trim();
    }
  }
  return null;
}

function getPreferencesSystemContext() {
  const prefs = loadPreferences();
  const policies = prefs.appPolicies || {};

  const autoApps = Object.entries(policies)
    .filter(([, p]) => p && p.executionMode === EXECUTION_MODE.AUTO)
    .map(([k]) => k)
    .slice(0, 12);

  if (!autoApps.length) return '';

  return [
    'User execution preferences (learned):',
    `- Auto-run is enabled for apps: ${autoApps.join(', ')}`,
    '- Still require confirmations for HIGH/CRITICAL risk and low-confidence targets.',
    '- Prefer UIA/semantic actions over coordinate clicks when possible.'
  ].join('\n');
}

function getPreferencesSystemContextForApp(processName) {
  const key = normalizeAppKey(processName);
  if (!key) return '';

  const prefs = loadPreferences();
  const policy = prefs.appPolicies?.[key];
  if (!policy) return '';

  const lines = ['User preferences for this app (learned):'];
  lines.push(`- app=${key}`);
  lines.push(`- executionMode=${policy.executionMode || 'prompt'}`);

  if (Array.isArray(policy.actionPolicies) && policy.actionPolicies.length) {
    const items = policy.actionPolicies
      .slice(0, 6)
      .map(p => {
        const intent = p.intent ? ` intent=${p.intent}` : '';
        const method = p.preferredMethod ? ` prefer=${p.preferredMethod}` : '';
        const match = p.matchPreference ? ` match=${p.matchPreference}` : '';
        const types = Array.isArray(p.preferredActionTypes) && p.preferredActionTypes.length
          ? ` types=${p.preferredActionTypes.slice(0, 3).join(',')}`
          : '';
        const reason = p.reason ? ` (${String(p.reason).slice(0, 80)})` : '';
        return `- Prefer:${intent}${method}${match}${types}${reason}`.trim();
      });
    lines.push(...items);
  }

  if (Array.isArray(policy.negativePolicies) && policy.negativePolicies.length) {
    const items = policy.negativePolicies
      .slice(0, 6)
      .map(p => {
        const intent = p.intent ? ` intent=${p.intent}` : '';
        const method = p.forbiddenMethod ? ` forbid=${p.forbiddenMethod}` : '';
        const reason = p.reason ? ` (${String(p.reason).slice(0, 80)})` : '';
        return `- Avoid:${intent}${method}${reason}`.trim();
      });
    lines.push(...items);
  }

  lines.push('- Still require confirmations for HIGH/CRITICAL risk and low-confidence targets.');
  return lines.join('\n');
}

module.exports = {
  EXECUTION_MODE,
  PREFS_FILE,
  loadPreferences,
  savePreferences,
  getAppPolicy,
  setAppExecutionMode,
  mergeAppPolicy,
  recordAutoRunOutcome,
  resolveTargetProcessNameFromActions,
  getPreferencesSystemContext,
  getPreferencesSystemContextForApp
};
