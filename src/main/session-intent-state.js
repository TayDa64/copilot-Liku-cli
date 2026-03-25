const fs = require('fs');
const path = require('path');

const { LIKU_HOME } = require('../shared/liku-home');
const { normalizeName, resolveProjectIdentity } = require('../shared/project-identity');

const SESSION_INTENT_SCHEMA_VERSION = 'session-intent.v1';
const SESSION_INTENT_FILE = path.join(LIKU_HOME, 'session-intent-state.json');

function defaultChatContinuity() {
  return {
    activeGoal: null,
    currentSubgoal: null,
    lastTurn: null,
    continuationReady: false,
    degradedReason: null
  };
}

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
    explicitCorrections: [],
    chatContinuity: defaultChatContinuity()
  };
}

function normalizeText(value, maxLength = 240) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength) || null;
}

function normalizeActionTypes(actions) {
  if (!Array.isArray(actions)) return [];
  return actions
    .map((action) => normalizeText(action?.type, 60))
    .filter(Boolean)
    .slice(0, 12);
}

function summarizeActionTypes(actionTypes) {
  return Array.isArray(actionTypes) && actionTypes.length > 0
    ? actionTypes.join(' -> ')
    : 'none';
}

function deriveVerificationStatus(turnRecord = {}) {
  if (turnRecord?.verification?.status) return normalizeText(turnRecord.verification.status, 60);
  if (turnRecord?.cancelled) return 'cancelled';
  if (turnRecord?.success === false) return 'failed';
  if (turnRecord?.postVerificationFailed) return 'unverified';
  if (turnRecord?.postVerification?.verified) return 'verified';
  if (turnRecord?.focusVerification?.verified) return 'verified';
  if (turnRecord?.focusVerification?.applicable && !turnRecord?.focusVerification?.verified) return 'unverified';
  return turnRecord?.success ? 'not-applicable' : 'unknown';
}

function deriveCaptureMode(turnRecord = {}) {
  return normalizeText(
    turnRecord?.observationEvidence?.captureMode
      || turnRecord?.captureMode
      || (turnRecord?.screenshotCaptured ? 'screen' : ''),
    60
  );
}

function deriveCaptureTrusted(turnRecord = {}) {
  if (typeof turnRecord?.observationEvidence?.captureTrusted === 'boolean') {
    return turnRecord.observationEvidence.captureTrusted;
  }
  const captureMode = deriveCaptureMode(turnRecord);
  if (!captureMode) return null;
  return captureMode === 'window' || captureMode === 'region';
}

function deriveExecutionStatus(turnRecord = {}) {
  if (turnRecord?.cancelled) return 'cancelled';
  if (turnRecord?.success === false) return 'failed';
  if (turnRecord?.success) return 'succeeded';
  return 'unknown';
}

function deriveNextRecommendedStep(turnRecord = {}) {
  if (turnRecord?.nextRecommendedStep) return normalizeText(turnRecord.nextRecommendedStep, 240);
  if (turnRecord?.cancelled) return 'Ask whether to retry the interrupted step or choose a different path.';
  if (turnRecord?.success === false) return 'Review the failed step and gather fresh evidence before continuing.';
  if (turnRecord?.postVerification?.needsFollowUp) return 'Continue with the detected follow-up flow for the current app state.';
  if (turnRecord?.screenshotCaptured) return 'Continue from the latest visual evidence and current app state.';
  if (deriveVerificationStatus(turnRecord) === 'unverified') return 'Gather fresh evidence before claiming the requested state change is complete.';
  return 'Continue from the current subgoal using the latest execution results.';
}

function deriveDegradedReason(normalizedTurn = {}) {
  if (normalizedTurn.executionStatus === 'cancelled') return 'The last action batch was cancelled before completion.';
  if (normalizedTurn.executionStatus === 'failed') return 'The last action batch did not complete successfully.';
  if (normalizedTurn.verificationStatus === 'unverified') return 'The latest result is not fully verified yet.';
  if (normalizedTurn.captureMode === 'screen' && normalizedTurn.captureTrusted === false) {
    return 'Visual evidence fell back to full-screen capture instead of a trusted target-window capture.';
  }
  return null;
}

function normalizeTurnRecord(turnRecord = {}, previousContinuity = defaultChatContinuity()) {
  const actionTypes = normalizeActionTypes(turnRecord.actionPlan || turnRecord.actions);
  const executionStatus = deriveExecutionStatus(turnRecord);
  const verificationStatus = deriveVerificationStatus(turnRecord);
  const captureMode = deriveCaptureMode(turnRecord);
  const captureTrusted = deriveCaptureTrusted(turnRecord);
  const activeGoal = normalizeText(
    turnRecord.activeGoal
      || turnRecord.executionIntent
      || turnRecord.userMessage
      || previousContinuity?.activeGoal,
    280
  );
  const currentSubgoal = normalizeText(
    turnRecord.currentSubgoal
      || turnRecord.committedSubgoal
      || turnRecord.thought
      || turnRecord.reasoning
      || previousContinuity?.currentSubgoal
      || activeGoal,
    240
  );

  const normalizedTurn = {
    turnId: normalizeText(turnRecord.turnId, 120) || `turn-${Date.now()}`,
    recordedAt: normalizeText(turnRecord.recordedAt, 60) || nowIso(),
    userMessage: normalizeText(turnRecord.userMessage, 280),
    executionIntent: normalizeText(turnRecord.executionIntent, 280),
    committedSubgoal: currentSubgoal,
    thought: normalizeText(turnRecord.thought, 240),
    actionTypes,
    actionSummary: summarizeActionTypes(actionTypes),
    executionStatus,
    executedCount: Number.isFinite(Number(turnRecord.executedCount)) ? Number(turnRecord.executedCount) : actionTypes.length,
    verificationStatus,
    captureMode,
    captureTrusted,
    targetWindowHandle: Number.isFinite(Number(turnRecord.targetWindowHandle)) ? Number(turnRecord.targetWindowHandle) : null,
    windowTitle: normalizeText(turnRecord.windowTitle, 240),
    nextRecommendedStep: deriveNextRecommendedStep(turnRecord)
  };

  return {
    activeGoal,
    currentSubgoal,
    lastTurn: normalizedTurn,
    continuationReady: normalizedTurn.executionStatus === 'succeeded',
    degradedReason: deriveDegradedReason(normalizedTurn)
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

function formatChatContinuitySummary(state) {
  const continuity = state?.chatContinuity || state || defaultChatContinuity();
  const lines = [];
  if (continuity.activeGoal) lines.push(`Active goal: ${continuity.activeGoal}`);
  if (continuity.currentSubgoal) lines.push(`Current subgoal: ${continuity.currentSubgoal}`);
  if (continuity.lastTurn?.actionSummary) lines.push(`Last actions: ${continuity.lastTurn.actionSummary}`);
  if (continuity.lastTurn?.executionStatus) lines.push(`Last execution: ${continuity.lastTurn.executionStatus}`);
  if (continuity.lastTurn?.verificationStatus) lines.push(`Verification: ${continuity.lastTurn.verificationStatus}`);
  if (typeof continuity.continuationReady === 'boolean') lines.push(`Continuation ready: ${continuity.continuationReady ? 'yes' : 'no'}`);
  if (continuity.degradedReason) lines.push(`Continuity caution: ${continuity.degradedReason}`);
  return lines.join('\n').trim() || 'No chat continuity recorded.';
}

function formatChatContinuityContext(state) {
  const continuity = state?.chatContinuity || state || defaultChatContinuity();
  const lastTurn = continuity.lastTurn || null;
  if (!continuity.activeGoal && !lastTurn) return '';

  const lines = [];
  if (continuity.activeGoal) lines.push(`- activeGoal: ${continuity.activeGoal}`);
  if (continuity.currentSubgoal) lines.push(`- currentSubgoal: ${continuity.currentSubgoal}`);
  if (lastTurn?.userMessage) lines.push(`- lastUserMessage: ${lastTurn.userMessage}`);
  if (lastTurn?.actionSummary) lines.push(`- lastExecutedActions: ${lastTurn.actionSummary}`);
  if (lastTurn?.executionStatus) lines.push(`- lastExecutionStatus: ${lastTurn.executionStatus}`);
  if (lastTurn?.verificationStatus) lines.push(`- lastVerificationStatus: ${lastTurn.verificationStatus}`);
  if (lastTurn?.captureMode) lines.push(`- lastCaptureMode: ${lastTurn.captureMode}`);
  if (typeof lastTurn?.captureTrusted === 'boolean') lines.push(`- lastCaptureTrusted: ${lastTurn.captureTrusted ? 'yes' : 'no'}`);
  lines.push(`- continuationReady: ${continuity.continuationReady ? 'yes' : 'no'}`);
  if (continuity.degradedReason) lines.push(`- degradedReason: ${continuity.degradedReason}`);
  if (lastTurn?.nextRecommendedStep) lines.push(`- nextRecommendedStep: ${lastTurn.nextRecommendedStep}`);
  lines.push('- Rule: If the user asks to continue, continue from the current subgoal and these execution facts instead of inventing a new branch.');
  if (lastTurn?.verificationStatus && lastTurn.verificationStatus !== 'verified') {
    lines.push('- Rule: Do not claim the requested UI change is complete unless the latest evidence verifies it.');
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
    if (!cachedState.chatContinuity || typeof cachedState.chatContinuity !== 'object') {
      cachedState.chatContinuity = defaultChatContinuity();
    } else {
      cachedState.chatContinuity = {
        ...defaultChatContinuity(),
        ...cachedState.chatContinuity
      };
    }
    return cachedState;
  }

  function saveState(nextState) {
    const state = {
      ...defaultState(),
      ...nextState,
      updatedAt: nowIso(),
      forgoneFeatures: limitList(nextState.forgoneFeatures || [], 12),
      explicitCorrections: limitList(nextState.explicitCorrections || [], 12),
      chatContinuity: {
        ...defaultChatContinuity(),
        ...(nextState.chatContinuity && typeof nextState.chatContinuity === 'object' ? nextState.chatContinuity : {})
      }
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

  function clearChatContinuity(options = {}) {
    const state = cloneState(loadState());
    syncCurrentRepo(state, options.cwd || process.cwd());
    state.chatContinuity = defaultChatContinuity();
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

  function recordExecutedTurn(turnRecord, options = {}) {
    const state = cloneState(loadState());
    syncCurrentRepo(state, options.cwd || process.cwd());
    state.chatContinuity = normalizeTurnRecord(turnRecord, state.chatContinuity);
    return saveState(state);
  }

  function getChatContinuity(options = {}) {
    return cloneState(getState(options).chatContinuity || defaultChatContinuity());
  }

  return {
    clearChatContinuity,
    clearState,
    getChatContinuity,
    getState,
    ingestUserMessage,
    recordExecutedTurn,
    saveState,
    stateFile
  };
}

const defaultStore = createSessionIntentStateStore();

module.exports = {
  SESSION_INTENT_FILE,
  SESSION_INTENT_SCHEMA_VERSION,
  createSessionIntentStateStore,
  formatChatContinuityContext,
  formatChatContinuitySummary,
  formatSessionIntentContext,
  formatSessionIntentSummary,
  getChatContinuityState: (options) => defaultStore.getChatContinuity(options),
  getSessionIntentState: (options) => defaultStore.getState(options),
  clearChatContinuityState: (options) => defaultStore.clearChatContinuity(options),
  clearSessionIntentState: (options) => defaultStore.clearState(options),
  ingestUserIntentState: (message, options) => defaultStore.ingestUserMessage(message, options),
  recordChatContinuityTurn: (turnRecord, options) => defaultStore.recordExecutedTurn(turnRecord, options)
};