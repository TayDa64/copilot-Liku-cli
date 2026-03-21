const fs = require('fs');
const path = require('path');

const { LIKU_HOME } = require('../shared/liku-home');
const { normalizeName, resolveProjectIdentity } = require('../shared/project-identity');

const SESSION_INTENT_SCHEMA_VERSION = 'session-intent.v1';
const SESSION_INTENT_FILE = path.join(LIKU_HOME, 'session-intent-state.json');

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  const timestamp = nowIso();
  return {
    schemaVersion: SESSION_INTENT_SCHEMA_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
    currentRepo: null,
    downstreamRepoIntent: null,
    forgoneFeatures: [],
    explicitCorrections: []
  };
}

function sanitizeFeatureLabel(value) {
  return String(value || '')
    .replace(/^[:\-\s]+/, '')
    .replace(/[.?!\s]+$/, '')
    .replace(/^['"]+|['"]+$/g, '')
    .trim();
}

function sanitizeRepoLabel(value) {
  return String(value || '')
    .replace(/^['"]+|['"]+$/g, '')
    .trim();
}

function normalizeFeatureName(value) {
  return normalizeName(sanitizeFeatureLabel(value));
}

function limitList(list, limit = 12) {
  return Array.isArray(list) ? list.slice(-limit) : [];
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function buildRepoSnapshot(cwd) {
  const identity = resolveProjectIdentity({ cwd });
  return {
    repoName: identity.repoName,
    normalizedRepoName: identity.normalizedRepoName,
    packageName: identity.packageName,
    projectRoot: identity.projectRoot,
    gitRemote: identity.gitRemote,
    aliases: identity.aliases
  };
}

function detectRepoCorrection(message) {
  const text = String(message || '').trim();
  if (!text) return null;

  let match = text.match(/(.+?)\s+is\s+a\s+different\s+repo\s*,\s*this\s+is\s+(.+)/i);
  if (match) {
    return {
      downstreamRepo: sanitizeRepoLabel(match[1]),
      currentRepoClaim: sanitizeRepoLabel(match[2]),
      kind: 'repo-correction'
    };
  }

  match = text.match(/this\s+is\s+(.+?)\s*,\s*not\s+(.+)/i);
  if (match) {
    return {
      currentRepoClaim: sanitizeRepoLabel(match[1]),
      downstreamRepo: sanitizeRepoLabel(match[2]),
      kind: 'repo-correction'
    };
  }

  return null;
}

function detectForgoneFeature(message) {
  const text = String(message || '').trim();
  if (!text) return null;

  const patterns = [
    /forgone\s+the\s+implementation\s+of\s*:?(.*)$/i,
    /forgo(?:ing|ne)?\s+(?:the\s+implementation\s+of\s+)?(.+)$/i,
    /(?:do\s+not|don't|dont|will\s+not|won't)\s+(?:implement|build|continue|pursue)\s+(.+)$/i,
    /(?:not\s+implementing|dropped|declined|skipping)\s+(.+)$/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const feature = sanitizeFeatureLabel(match[1]);
    if (feature) return feature;
  }

  return null;
}

function detectReenabledFeatures(message, state) {
  const text = String(message || '').trim();
  if (!text) return [];
  if (!/\b(re-?enable|resume|revisit|continue with|let'?s implement|lets implement|go ahead with)\b/i.test(text)) {
    return [];
  }

  const normalizedText = normalizeName(text);
  return (state.forgoneFeatures || [])
    .filter((entry) => entry?.normalizedFeature && normalizedText.includes(entry.normalizedFeature))
    .map((entry) => entry.normalizedFeature);
}

function formatSessionIntentSummary(state) {
  const lines = [];
  if (state?.currentRepo?.repoName) {
    lines.push(`Current repo: ${state.currentRepo.repoName}`);
  }
  if (state?.downstreamRepoIntent?.repoName) {
    lines.push(`Downstream repo intent: ${state.downstreamRepoIntent.repoName}`);
  }
  if (Array.isArray(state?.forgoneFeatures) && state.forgoneFeatures.length > 0) {
    lines.push(`Forgone features: ${state.forgoneFeatures.map((entry) => entry.feature).join(', ')}`);
  }
  if (Array.isArray(state?.explicitCorrections) && state.explicitCorrections.length > 0) {
    const recent = state.explicitCorrections.slice(-3).map((entry) => `- ${entry.text}`);
    lines.push('Recent explicit corrections:');
    lines.push(...recent);
  }
  return lines.join('\n').trim() || 'No session intent state recorded.';
}

function formatSessionIntentContext(state) {
  const lines = [];
  if (state?.currentRepo?.repoName) {
    lines.push(`- currentRepo: ${state.currentRepo.repoName}`);
    if (state.currentRepo.projectRoot) {
      lines.push(`- currentProjectRoot: ${state.currentRepo.projectRoot}`);
    }
  }
  if (state?.downstreamRepoIntent?.repoName) {
    lines.push(`- downstreamRepoIntent: ${state.downstreamRepoIntent.repoName}`);
    lines.push('- Rule: If the user references the downstream repo while working in the current repo, ask for explicit repo or window switching before proposing repo-specific actions.');
  }
  if (Array.isArray(state?.forgoneFeatures) && state.forgoneFeatures.length > 0) {
    lines.push(`- forgoneFeatures: ${state.forgoneFeatures.map((entry) => entry.feature).join(', ')}`);
    lines.push('- Rule: Do not propose or act on forgone features unless the user explicitly re-enables them.');
  }
  if (Array.isArray(state?.explicitCorrections) && state.explicitCorrections.length > 0) {
    const recent = state.explicitCorrections.slice(-3).map((entry) => entry.text);
    lines.push(`- recentExplicitCorrections: ${recent.join(' | ')}`);
  }
  return lines.join('\n').trim();
}

function createSessionIntentStateStore(options = {}) {
  const stateFile = options.stateFile || SESSION_INTENT_FILE;
  let cachedState = null;

  function loadState() {
    if (cachedState) return cachedState;
    const loaded = safeReadJson(stateFile);
    cachedState = {
      ...defaultState(),
      ...(loaded && typeof loaded === 'object' ? loaded : {})
    };
    if (!Array.isArray(cachedState.forgoneFeatures)) cachedState.forgoneFeatures = [];
    if (!Array.isArray(cachedState.explicitCorrections)) cachedState.explicitCorrections = [];
    return cachedState;
  }

  function saveState(nextState) {
    const state = {
      ...defaultState(),
      ...nextState,
      updatedAt: nowIso(),
      forgoneFeatures: limitList(nextState.forgoneFeatures || [], 12),
      explicitCorrections: limitList(nextState.explicitCorrections || [], 12)
    };
    cachedState = state;
    ensureParentDir(stateFile);
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    return cloneState(state);
  }

  function syncCurrentRepo(state, cwd) {
    const currentRepo = buildRepoSnapshot(cwd || process.cwd());
    const existing = state.currentRepo || {};
    if (
      existing.projectRoot !== currentRepo.projectRoot ||
      existing.normalizedRepoName !== currentRepo.normalizedRepoName
    ) {
      state.currentRepo = currentRepo;
      return true;
    }
    return false;
  }

  function getState(options = {}) {
    const state = cloneState(loadState());
    if (syncCurrentRepo(state, options.cwd)) {
      return saveState(state);
    }
    return state;
  }

  function clearState(options = {}) {
    const state = defaultState();
    syncCurrentRepo(state, options.cwd || process.cwd());
    return saveState(state);
  }

  function ingestUserMessage(message, options = {}) {
    const text = String(message || '').trim();
    const state = cloneState(loadState());
    let changed = syncCurrentRepo(state, options.cwd || process.cwd());
    const timestamp = nowIso();

    const repoCorrection = detectRepoCorrection(text);
    if (repoCorrection?.downstreamRepo) {
      const normalizedRepo = normalizeName(repoCorrection.downstreamRepo);
      if (normalizedRepo && normalizedRepo !== state.currentRepo?.normalizedRepoName) {
        state.downstreamRepoIntent = {
          repoName: repoCorrection.downstreamRepo,
          normalizedRepoName: normalizedRepo,
          sourceText: text,
          recordedAt: timestamp
        };
        state.explicitCorrections.push({
          kind: repoCorrection.kind,
          text,
          recordedAt: timestamp,
          currentRepoClaim: repoCorrection.currentRepoClaim || null,
          downstreamRepo: repoCorrection.downstreamRepo
        });
        changed = true;
      }
    }

    for (const normalizedFeature of detectReenabledFeatures(text, state)) {
      const before = state.forgoneFeatures.length;
      state.forgoneFeatures = state.forgoneFeatures.filter((entry) => entry.normalizedFeature !== normalizedFeature);
      if (state.forgoneFeatures.length !== before) {
        state.explicitCorrections.push({
          kind: 'feature-reenabled',
          text,
          recordedAt: timestamp,
          feature: normalizedFeature
        });
        changed = true;
      }
    }

    const forgoneFeature = detectForgoneFeature(text);
    if (forgoneFeature) {
      const normalizedFeature = normalizeFeatureName(forgoneFeature);
      const exists = state.forgoneFeatures.some((entry) => entry.normalizedFeature === normalizedFeature);
      if (normalizedFeature && !exists) {
        state.forgoneFeatures.push({
          feature: forgoneFeature,
          normalizedFeature,
          sourceText: text,
          recordedAt: timestamp
        });
        state.explicitCorrections.push({
          kind: 'forgone-feature',
          text,
          recordedAt: timestamp,
          feature: forgoneFeature
        });
        changed = true;
      }
    }

    if (!changed) {
      return getState(options);
    }

    return saveState(state);
  }

  return {
    clearState,
    getState,
    ingestUserMessage,
    saveState,
    stateFile
  };
}

const defaultStore = createSessionIntentStateStore();

module.exports = {
  SESSION_INTENT_FILE,
  SESSION_INTENT_SCHEMA_VERSION,
  createSessionIntentStateStore,
  formatSessionIntentContext,
  formatSessionIntentSummary,
  getSessionIntentState: (options) => defaultStore.getState(options),
  clearSessionIntentState: (options) => defaultStore.clearState(options),
  ingestUserIntentState: (message, options) => defaultStore.ingestUserMessage(message, options)
};