const fs = require('fs');
const path = require('path');

const { LIKU_HOME } = require('../shared/liku-home');
const { normalizeName, resolveProjectIdentity } = require('../shared/project-identity');
const { buildExecutionContextEnvelope } = require('./ai-service/execution-context');

const SESSION_INTENT_SCHEMA_VERSION = 'session-intent.v1';
const SESSION_INTENT_FILE = path.join(LIKU_HOME, 'session-intent-state.json');
const CONTINUITY_FRESH_MS = 90 * 1000;
const CONTINUITY_UI_WATCHER_FRESH_MS = 3 * 60 * 1000;
const CONTINUITY_RECOVERABLE_MS = 15 * 60 * 1000;

function defaultChatContinuity() {
  return {
    activeGoal: null,
    currentSubgoal: null,
    compartmentKey: null,
    lastTurn: null,
    continuationReady: false,
    degradedReason: null,
    freshnessState: null,
    freshnessAgeMs: null,
    freshnessBudgetMs: null,
    freshnessRecoverableBudgetMs: null,
    freshnessReason: null,
    requiresReobserve: false
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
    activeCompartmentKey: null,
    pendingRequestedTask: null,
    pendingRequestedTaskByCompartment: {},
    chatContinuity: defaultChatContinuity(),
    chatContinuityByCompartment: {}
  };
}

function normalizeCompartmentKey(value) {
  return String(value || '').trim() || null;
}

function hasMeaningfulChatContinuity(continuity = null) {
  if (!continuity || typeof continuity !== 'object') return false;
  return !!(
    continuity.activeGoal
    || continuity.currentSubgoal
    || continuity.lastTurn
  );
}

function normalizeExecutionContextIdentity(executionContext = null) {
  if (!executionContext || typeof executionContext !== 'object') return null;

  const normalized = {
    compartmentKey: normalizeCompartmentKey(executionContext.compartmentKey),
    repoName: normalizeText(executionContext.repoName || executionContext.repo?.name, 120),
    projectRoot: normalizeText(executionContext.projectRoot || executionContext.repo?.projectRoot, 260),
    appId: normalizeText(executionContext.appId || executionContext.foreground?.appId || executionContext.processName, 80),
    processName: normalizeText(executionContext.processName || executionContext.foreground?.processName, 80),
    windowTitle: normalizeText(executionContext.windowTitle || executionContext.foreground?.windowTitle, 160),
    surfaceClass: normalizeText(executionContext.surfaceClass || executionContext.foreground?.surfaceClass, 80),
    interactionMode: normalizeText(executionContext.interactionMode || executionContext.foreground?.interactionMode, 80),
    taskFamily: normalizeText(executionContext.taskFamily, 80),
    confidence: normalizeText(executionContext.confidence, 40)
  };

  if (!normalized.compartmentKey
    && !normalized.repoName
    && !normalized.projectRoot
    && !normalized.appId
    && !normalized.processName
    && !normalized.windowTitle
    && !normalized.surfaceClass
    && !normalized.interactionMode
    && !normalized.taskFamily
    && !normalized.confidence) {
    return null;
  }

  return normalized;
}

function extractForegroundHint(source = {}) {
  if (!source || typeof source !== 'object') return null;

  const executionContext = normalizeExecutionContextIdentity(source.executionContext || source.executionContextEnvelope || null);
  const processName = normalizeText(
    executionContext?.processName
      || executionContext?.appId
      || source.targetApp
      || source.processName
      || source.appId
      || source.lastTurn?.executionContext?.processName,
    80
  );
  const title = normalizeText(
    executionContext?.windowTitle
      || source.targetWindowTitle
      || source.windowTitle
      || source.title
      || source.lastTurn?.windowTitle,
    160
  );

  const foreground = {};
  if (processName) foreground.processName = processName;
  if (title) foreground.title = title;
  return Object.keys(foreground).length > 0 ? foreground : null;
}

function extractUserMessageHint(source = {}) {
  return normalizeText(
    source.executionIntent
      || source.userMessage
      || source.taskSummary
      || source.activeGoal
      || source.currentSubgoal,
    280
  ) || '';
}

function hasExplicitCompartmentSelectionHints(options = {}, source = {}) {
  if (normalizeCompartmentKey(options.compartmentKey)) return true;
  if (options.executionContextEnvelope && typeof options.executionContextEnvelope === 'object') return true;
  if (options.foreground && typeof options.foreground === 'object') return true;
  if (source.executionContextEnvelope && typeof source.executionContextEnvelope === 'object') return true;
  if (source.executionContext && typeof source.executionContext === 'object') return true;
  if (source.targetApp || source.processName || source.appId || source.targetWindowTitle || source.windowTitle || source.title) return true;
  if (source.userMessage || source.executionIntent || source.taskSummary || source.activeGoal || source.currentSubgoal) return true;
  return false;
}

function buildCompartmentEnvelopeHint(state, source = {}, options = {}) {
  const explicitEnvelope = options.executionContextEnvelope || source.executionContextEnvelope || null;
  if (explicitEnvelope?.compartmentKey) {
    return explicitEnvelope;
  }

  const normalizedExecutionContext = normalizeExecutionContextIdentity(source.executionContext || null);
  if (normalizedExecutionContext?.compartmentKey) {
    return normalizedExecutionContext;
  }

  const foreground = options.foreground || extractForegroundHint(source);
  const userMessage = options.userMessage || extractUserMessageHint(source);

  try {
    return buildExecutionContextEnvelope({
      cwd: options.cwd || state?.currentRepo?.projectRoot || process.cwd(),
      foreground,
      sessionState: state,
      userMessage
    });
  } catch {
    return null;
  }
}

function findLatestCompartmentKeyForRepo(map = {}, normalizedRepoName = '') {
  const prefix = normalizeText(normalizedRepoName, 120);
  if (!prefix) return null;

  let latestKey = null;
  let latestTimestamp = 0;
  for (const [key, value] of Object.entries(map || {})) {
    if (!String(key).startsWith(`${prefix}::`)) continue;
    const recordedAt = Date.parse(value?.lastTurn?.recordedAt || value?.recordedAt || 0) || 0;
    if (!latestKey || recordedAt >= latestTimestamp) {
      latestKey = key;
      latestTimestamp = recordedAt;
    }
  }
  return latestKey;
}

function pickActiveCompartmentKey(state) {
  const explicit = normalizeCompartmentKey(state?.activeCompartmentKey);
  if (explicit) return explicit;

  const repoName = state?.currentRepo?.normalizedRepoName || '';
  return findLatestCompartmentKeyForRepo(state?.chatContinuityByCompartment, repoName)
    || findLatestCompartmentKeyForRepo(state?.pendingRequestedTaskByCompartment, repoName)
    || null;
}

function resolveSelectedCompartmentKey(state, options = {}, source = null) {
  const explicitKey = normalizeCompartmentKey(options.compartmentKey);
  if (explicitKey) return { compartmentKey: explicitKey, strict: true };

  if (!hasExplicitCompartmentSelectionHints(options, source || {})) {
    return { compartmentKey: pickActiveCompartmentKey(state), strict: false };
  }

  const envelope = buildCompartmentEnvelopeHint(state, source || {}, options);
  const envelopeKey = normalizeCompartmentKey(envelope?.compartmentKey);
  if (envelopeKey) return { compartmentKey: envelopeKey, strict: true };

  return { compartmentKey: pickActiveCompartmentKey(state), strict: false };
}

function getChatContinuityForCompartment(state, compartmentKey, options = {}) {
  const key = normalizeCompartmentKey(compartmentKey);
  if (key && state?.chatContinuityByCompartment && state.chatContinuityByCompartment[key]) {
    return hydrateChatContinuity(state.chatContinuityByCompartment[key]);
  }
  if (options.strict) return defaultChatContinuity();
  if (hasMeaningfulChatContinuity(state?.chatContinuity)) return hydrateChatContinuity(state.chatContinuity);
  return defaultChatContinuity();
}

function getPendingRequestedTaskForCompartment(state, compartmentKey, options = {}) {
  const key = normalizeCompartmentKey(compartmentKey);
  if (key && state?.pendingRequestedTaskByCompartment && state.pendingRequestedTaskByCompartment[key]) {
    return normalizePendingRequestedTask(state.pendingRequestedTaskByCompartment[key]);
  }
  if (options.strict) return null;
  return normalizePendingRequestedTask(state?.pendingRequestedTask || null);
}

function mirrorStateToCompartment(state, compartmentKey, options = {}) {
  const activeCompartmentKey = normalizeCompartmentKey(compartmentKey) || pickActiveCompartmentKey(state);
  return {
    ...state,
    activeCompartmentKey,
    chatContinuity: getChatContinuityForCompartment(state, activeCompartmentKey, options),
    pendingRequestedTask: getPendingRequestedTaskForCompartment(state, activeCompartmentKey, options)
  };
}

function migrateLegacyCompartmentState(state) {
  const nextState = {
    ...state,
    pendingRequestedTaskByCompartment: state?.pendingRequestedTaskByCompartment && typeof state.pendingRequestedTaskByCompartment === 'object'
      ? { ...state.pendingRequestedTaskByCompartment }
      : {},
    chatContinuityByCompartment: state?.chatContinuityByCompartment && typeof state.chatContinuityByCompartment === 'object'
      ? { ...state.chatContinuityByCompartment }
      : {}
  };

  if (hasMeaningfulChatContinuity(nextState.chatContinuity) && Object.keys(nextState.chatContinuityByCompartment).length === 0) {
    const derived = resolveSelectedCompartmentKey(nextState, {
      cwd: nextState.currentRepo?.projectRoot || process.cwd(),
      userMessage: nextState.chatContinuity?.activeGoal || nextState.chatContinuity?.lastTurn?.userMessage || ''
    }, nextState.chatContinuity);
    if (derived.compartmentKey) {
      nextState.chatContinuityByCompartment[derived.compartmentKey] = hydrateChatContinuity(nextState.chatContinuity);
      nextState.activeCompartmentKey = nextState.activeCompartmentKey || derived.compartmentKey;
    }
  }

  if (nextState.pendingRequestedTask && Object.keys(nextState.pendingRequestedTaskByCompartment).length === 0) {
    const derived = resolveSelectedCompartmentKey(nextState, {
      cwd: nextState.currentRepo?.projectRoot || process.cwd(),
      userMessage: nextState.pendingRequestedTask.executionIntent || nextState.pendingRequestedTask.userMessage || ''
    }, nextState.pendingRequestedTask);
    if (derived.compartmentKey) {
      nextState.pendingRequestedTaskByCompartment[derived.compartmentKey] = normalizePendingRequestedTask(nextState.pendingRequestedTask);
      nextState.activeCompartmentKey = nextState.activeCompartmentKey || derived.compartmentKey;
    }
  }

  return mirrorStateToCompartment(nextState, nextState.activeCompartmentKey);
}

function normalizeText(value, maxLength = 240) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength) || null;
}

function normalizeEvidenceList(values, maxLength = 80) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => normalizeText(value, maxLength))
    .filter(Boolean)
    .slice(0, 6);
}

function normalizeIdList(values, maxItems = 8, maxLength = 120) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => normalizeText(value, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeRetrievalSummary(summary = null) {
  if (!summary || typeof summary !== 'object') return null;

  const normalized = {
    selectedCount: Number.isFinite(Number(summary.selectedCount)) ? Number(summary.selectedCount) : null,
    scopedMatchCount: Number.isFinite(Number(summary.scopedMatchCount)) ? Number(summary.scopedMatchCount) : null,
    fallbackCount: Number.isFinite(Number(summary.fallbackCount)) ? Number(summary.fallbackCount) : null,
    mismatchCount: Number.isFinite(Number(summary.mismatchCount)) ? Number(summary.mismatchCount) : null,
    scopeContext: normalizeExecutionContextIdentity({
      compartmentKey: summary.scopeContext?.compartmentKey,
      repoName: summary.scopeContext?.repoName,
      projectRoot: summary.scopeContext?.projectRoot,
      appId: summary.scopeContext?.appId,
      processName: summary.scopeContext?.processName,
      taskFamily: summary.scopeContext?.taskFamily
    })
  };

  if (normalized.selectedCount === null
    && normalized.scopedMatchCount === null
    && normalized.fallbackCount === null
    && normalized.mismatchCount === null
    && !normalized.scopeContext) {
    return null;
  }

  return normalized;
}

function normalizeTradingMode(tradingMode) {
  if (!tradingMode) return null;
  if (typeof tradingMode === 'string') {
    const mode = normalizeText(tradingMode, 40);
    return mode ? { mode, confidence: null, evidence: [] } : null;
  }

  const mode = normalizeText(tradingMode.mode, 40);
  if (!mode) return null;

  return {
    mode,
    confidence: normalizeText(tradingMode.confidence, 40),
    evidence: normalizeEvidenceList(tradingMode.evidence, 80)
  };
}

function extractObservationCheckpointCandidate(result) {
  if (result?.proof?.observation && typeof result.proof.observation === 'object') {
    return {
      ...result.proof.observation,
      tradingMode: result.proof.tradingMode || result.proof.observation.tradingMode || null,
      reason: result.proof.observation.reason || result.proof.error || null,
      verified: result.proof.observation.verified === true || result.proof.status === 'verified'
    };
  }

  return result?.observationCheckpoint || null;
}

function normalizePineStructuredSummary(summary) {
  if (!summary || typeof summary !== 'object') return null;

  const topVisibleRevisions = Array.isArray(summary.topVisibleRevisions)
    ? summary.topVisibleRevisions.slice(0, 3).map((entry) => ({
        label: normalizeText(entry?.label, 80),
        relativeTime: normalizeText(entry?.relativeTime, 80),
        revisionNumber: Number.isFinite(Number(entry?.revisionNumber)) ? Number(entry.revisionNumber) : null
      })).filter((entry) => entry.label || entry.relativeTime || entry.revisionNumber !== null)
    : [];

  const normalized = {
    evidenceMode: normalizeText(summary.evidenceMode, 60),
    compactSummary: normalizeText(summary.compactSummary, 160),
    outputSurface: normalizeText(summary.outputSurface, 60),
    outputSignal: normalizeText(summary.outputSignal, 60),
    visibleOutputEntryCount: Number.isFinite(Number(summary.visibleOutputEntryCount)) ? Number(summary.visibleOutputEntryCount) : null,
    functionCallCountEstimate: Number.isFinite(Number(summary.functionCallCountEstimate)) ? Number(summary.functionCallCountEstimate) : null,
    avgTimeMs: Number.isFinite(Number(summary.avgTimeMs)) ? Number(summary.avgTimeMs) : null,
    maxTimeMs: Number.isFinite(Number(summary.maxTimeMs)) ? Number(summary.maxTimeMs) : null,
    editorVisibleState: normalizeText(summary.editorVisibleState, 60),
    visibleScriptKind: normalizeText(summary.visibleScriptKind, 40),
    visibleLineCountEstimate: Number.isFinite(Number(summary.visibleLineCountEstimate)) ? Number(summary.visibleLineCountEstimate) : null,
    compileStatus: normalizeText(summary.compileStatus, 40),
    errorCountEstimate: Number.isFinite(Number(summary.errorCountEstimate)) ? Number(summary.errorCountEstimate) : null,
    warningCountEstimate: Number.isFinite(Number(summary.warningCountEstimate)) ? Number(summary.warningCountEstimate) : null,
    lineBudgetSignal: normalizeText(summary.lineBudgetSignal, 60),
    visibleSignals: normalizeEvidenceList(summary.visibleSignals, 40),
    statusSignals: normalizeEvidenceList(summary.statusSignals, 40),
    topVisibleDiagnostics: normalizeEvidenceList(summary.topVisibleDiagnostics, 140),
    topVisibleOutputs: normalizeEvidenceList(summary.topVisibleOutputs, 140),
    latestVisibleRevisionLabel: normalizeText(summary.latestVisibleRevisionLabel, 80),
    latestVisibleRevisionNumber: Number.isFinite(Number(summary.latestVisibleRevisionNumber)) ? Number(summary.latestVisibleRevisionNumber) : null,
    latestVisibleRelativeTime: normalizeText(summary.latestVisibleRelativeTime, 80),
    visibleRevisionCount: Number.isFinite(Number(summary.visibleRevisionCount)) ? Number(summary.visibleRevisionCount) : null,
    visibleRecencySignal: normalizeText(summary.visibleRecencySignal, 60),
    topVisibleRevisions
  };

  if (!normalized.evidenceMode
    && !normalized.compactSummary
    && !normalized.outputSurface
    && !normalized.outputSignal
    && normalized.visibleOutputEntryCount === null
    && normalized.functionCallCountEstimate === null
    && normalized.avgTimeMs === null
    && normalized.maxTimeMs === null
    && !normalized.editorVisibleState
    && !normalized.visibleScriptKind
    && normalized.visibleLineCountEstimate === null
    && !normalized.compileStatus
    && normalized.errorCountEstimate === null
    && normalized.warningCountEstimate === null
    && !normalized.lineBudgetSignal
    && normalized.visibleSignals.length === 0
    && normalized.statusSignals.length === 0
    && normalized.topVisibleDiagnostics.length === 0
    && normalized.topVisibleOutputs.length === 0
    && !normalized.latestVisibleRevisionLabel
    && normalized.latestVisibleRevisionNumber === null
    && !normalized.latestVisibleRelativeTime
    && normalized.visibleRevisionCount === null
    && !normalized.visibleRecencySignal
    && topVisibleRevisions.length === 0) {
    return null;
  }

  return normalized;
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

function normalizeActionPlanEntries(actions) {
  if (!Array.isArray(actions)) return [];
  return actions.slice(0, 12).map((action, index) => ({
    index: Number.isFinite(Number(action?.index)) ? Number(action.index) : index,
    type: normalizeText(action?.type, 60),
    reason: normalizeText(action?.reason, 160),
    key: normalizeText(action?.key, 60),
    text: normalizeText(action?.text, 120),
    scope: normalizeText(action?.scope, 60),
    title: normalizeText(action?.title, 120),
    processName: normalizeText(action?.processName, 80),
    windowHandle: Number.isFinite(Number(action?.windowHandle)) ? Number(action.windowHandle) : null,
    verifyKind: normalizeText(action?.verifyKind, 80),
    verifyTarget: normalizeText(action?.verifyTarget, 120)
  }));
}

function normalizeActionResultEntries(results) {
  if (!Array.isArray(results)) return [];
  return results.slice(0, 12).map((result, index) => {
    const observationCheckpoint = extractObservationCheckpointCandidate(result);
    return {
      index: Number.isFinite(Number(result?.index)) ? Number(result.index) : index,
      type: normalizeText(result?.type, 60),
      success: !!result?.success,
      error: normalizeText(result?.error, 180),
      message: normalizeText(result?.message, 160),
      userConfirmed: !!result?.userConfirmed,
      blockedByPolicy: !!result?.blockedByPolicy,
      pineStructuredSummary: normalizePineStructuredSummary(result?.pineStructuredSummary),
      observationCheckpoint: observationCheckpoint
        ? {
            classification: normalizeText(observationCheckpoint.classification, 80),
            verified: !!observationCheckpoint.verified,
            reason: normalizeText(observationCheckpoint.reason, 160),
            tradingMode: normalizeTradingMode(observationCheckpoint.tradingMode)
          }
        : null
    };
  });
}

function normalizeVerificationChecks(verificationChecks) {
  if (!Array.isArray(verificationChecks)) return [];
  return verificationChecks.slice(0, 8).map((check, index) => ({
    index,
    name: normalizeText(check?.name, 80),
    status: normalizeText(check?.status, 40),
    detail: normalizeText(check?.detail, 160)
  }));
}

function normalizeExecutionResultDetails(turnRecord = {}, actionResults = []) {
  const executionResult = turnRecord?.executionResult && typeof turnRecord.executionResult === 'object'
    ? turnRecord.executionResult
    : {};
  return {
    cancelled: !!executionResult.cancelled || !!turnRecord.cancelled,
    pendingConfirmation: !!executionResult.pendingConfirmation,
    userConfirmed: !!executionResult.userConfirmed,
    executedCount: Number.isFinite(Number(executionResult.executedCount))
      ? Number(executionResult.executedCount)
      : actionResults.length,
    successCount: Number.isFinite(Number(executionResult.successCount))
      ? Number(executionResult.successCount)
      : actionResults.filter((result) => result?.success).length,
    failureCount: Number.isFinite(Number(executionResult.failureCount))
      ? Number(executionResult.failureCount)
      : actionResults.filter((result) => result?.success === false).length,
    failedActions: Array.isArray(executionResult.failedActions)
      ? executionResult.failedActions.slice(0, 4).map((entry, index) => ({
          index,
          type: normalizeText(entry?.type, 60),
          error: normalizeText(entry?.error, 160)
        }))
      : [],
    reflectionApplied: executionResult.reflectionApplied && typeof executionResult.reflectionApplied === 'object'
      ? {
          action: normalizeText(executionResult.reflectionApplied.action, 80),
          applied: !!executionResult.reflectionApplied.applied,
          detail: normalizeText(executionResult.reflectionApplied.detail, 160)
        }
      : null,
    popupFollowUp: executionResult.popupFollowUp && typeof executionResult.popupFollowUp === 'object'
      ? {
          attempted: !!executionResult.popupFollowUp.attempted,
          completed: !!executionResult.popupFollowUp.completed,
          steps: Number.isFinite(Number(executionResult.popupFollowUp.steps)) ? Number(executionResult.popupFollowUp.steps) : null,
          recipeId: normalizeText(executionResult.popupFollowUp.recipeId, 80)
        }
      : null
  };
}

function normalizeObservationEvidence(turnRecord = {}) {
  const evidence = turnRecord?.observationEvidence && typeof turnRecord.observationEvidence === 'object'
    ? turnRecord.observationEvidence
    : {};
  return {
    captureMode: normalizeText(evidence.captureMode || turnRecord.captureMode, 60),
    captureTrusted: typeof evidence.captureTrusted === 'boolean' ? evidence.captureTrusted : null,
    captureProvider: normalizeText(evidence.captureProvider, 80),
    captureCapability: normalizeText(evidence.captureCapability, 80),
    captureDegradedReason: normalizeText(evidence.captureDegradedReason, 180),
    captureNonDisruptive: typeof evidence.captureNonDisruptive === 'boolean' ? evidence.captureNonDisruptive : null,
    captureBackgroundRequested: typeof evidence.captureBackgroundRequested === 'boolean' ? evidence.captureBackgroundRequested : null,
    visualContextRef: normalizeText(evidence.visualContextRef, 120),
    visualTimestamp: Number.isFinite(Number(evidence.visualTimestamp)) ? Number(evidence.visualTimestamp) : null,
    windowHandle: Number.isFinite(Number(evidence.windowHandle || turnRecord.targetWindowHandle)) ? Number(evidence.windowHandle || turnRecord.targetWindowHandle) : null,
    windowTitle: normalizeText(evidence.windowTitle || turnRecord.windowTitle, 160),
    uiWatcherFresh: typeof evidence.uiWatcherFresh === 'boolean' ? evidence.uiWatcherFresh : null,
    uiWatcherAgeMs: Number.isFinite(Number(evidence.uiWatcherAgeMs)) ? Number(evidence.uiWatcherAgeMs) : null,
    watcherWindowHandle: Number.isFinite(Number(evidence.watcherWindowHandle)) ? Number(evidence.watcherWindowHandle) : null,
    watcherWindowTitle: normalizeText(evidence.watcherWindowTitle, 160)
  };
}

function deriveTurnTradingMode(turnRecord = {}, actionResults = []) {
  const candidates = [];
  const addCandidate = (candidate) => {
    const normalized = normalizeTradingMode(candidate?.tradingMode || candidate);
    if (normalized?.mode) candidates.push(normalized);
  };

  addCandidate(turnRecord.tradingMode);
  addCandidate(turnRecord?.executionResult?.tradingMode);

  if (Array.isArray(turnRecord?.observationCheckpoints)) {
    turnRecord.observationCheckpoints.forEach((checkpoint) => addCandidate(checkpoint));
  }

  actionResults.forEach((result) => addCandidate(result?.observationCheckpoint || extractObservationCheckpointCandidate(result)));

  return candidates.find((candidate) => candidate?.mode) || null;
}

function isTrustedCaptureMode(captureMode) {
  const normalized = String(captureMode || '').trim().toLowerCase();
  if (!normalized) return false;
  return normalized === 'window'
    || normalized === 'region'
    || normalized.startsWith('window-')
    || normalized.startsWith('region-');
}

function isScreenLikeCaptureMode(captureMode) {
  const normalized = String(captureMode || '').trim().toLowerCase();
  if (!normalized) return false;
  return normalized === 'screen'
    || normalized === 'fullscreen-fallback'
    || normalized.startsWith('screen-')
    || normalized.includes('fullscreen');
}

function formatDurationMs(durationMs) {
  if (!Number.isFinite(Number(durationMs)) || Number(durationMs) < 0) return 'unknown age';
  const totalSeconds = Math.max(0, Math.round(Number(durationMs) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.round(totalMinutes / 60);
  return `${totalHours}h`;
}

function parseContinuityRecordedAtMs(continuity = {}) {
  const recordedAt = continuity?.lastTurn?.recordedAt;
  const parsed = Date.parse(String(recordedAt || '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function deriveContinuityFreshness(continuity = {}) {
  const lastTurn = continuity?.lastTurn || null;
  if (!lastTurn) {
    return {
      freshnessState: null,
      freshnessAgeMs: null,
      freshnessBudgetMs: null,
      freshnessRecoverableBudgetMs: null,
      freshnessReason: null,
      requiresReobserve: false
    };
  }

  const recordedAtMs = parseContinuityRecordedAtMs(continuity);
  const freshnessAgeMs = recordedAtMs !== null
    ? Math.max(0, Date.now() - recordedAtMs)
    : null;
  const watcherFresh = lastTurn?.observationEvidence?.uiWatcherFresh === true;
  const watcherAgeMs = Number.isFinite(Number(lastTurn?.observationEvidence?.uiWatcherAgeMs))
    ? Number(lastTurn.observationEvidence.uiWatcherAgeMs)
    : null;
  const trustedCapture = lastTurn.captureTrusted === true || isTrustedCaptureMode(lastTurn.captureMode);
  const freshBudgetMs = trustedCapture && watcherFresh && (watcherAgeMs === null || watcherAgeMs <= 5000)
    ? CONTINUITY_UI_WATCHER_FRESH_MS
    : CONTINUITY_FRESH_MS;
  const recoverableBudgetMs = CONTINUITY_RECOVERABLE_MS;

  if (freshnessAgeMs === null) {
    const baseReady = continuity?.continuationReady === true && !continuity?.degradedReason;
    return {
      freshnessState: baseReady ? 'fresh' : null,
      freshnessAgeMs: null,
      freshnessBudgetMs: freshBudgetMs,
      freshnessRecoverableBudgetMs: recoverableBudgetMs,
      freshnessReason: null,
      requiresReobserve: false
    };
  }

  if (freshnessAgeMs <= freshBudgetMs) {
    return {
      freshnessState: 'fresh',
      freshnessAgeMs,
      freshnessBudgetMs: freshBudgetMs,
      freshnessRecoverableBudgetMs: recoverableBudgetMs,
      freshnessReason: null,
      requiresReobserve: false
    };
  }

  if (trustedCapture && freshnessAgeMs <= recoverableBudgetMs) {
    return {
      freshnessState: 'stale-recoverable',
      freshnessAgeMs,
      freshnessBudgetMs: freshBudgetMs,
      freshnessRecoverableBudgetMs: recoverableBudgetMs,
      freshnessReason: `Stored continuity is stale (${formatDurationMs(freshnessAgeMs)}) and should be re-observed before continuing.`,
      requiresReobserve: true
    };
  }

  return {
    freshnessState: 'expired',
    freshnessAgeMs,
    freshnessBudgetMs: freshBudgetMs,
    freshnessRecoverableBudgetMs: recoverableBudgetMs,
    freshnessReason: `Stored continuity is expired (${formatDurationMs(freshnessAgeMs)}) and must be rebuilt from fresh evidence before continuing.`,
    requiresReobserve: true
  };
}

function hydrateChatContinuity(continuity = defaultChatContinuity()) {
  const base = {
    ...defaultChatContinuity(),
    ...(continuity && typeof continuity === 'object' ? continuity : {})
  };
  const freshness = deriveContinuityFreshness(base);
  const baseDegradedReason = base.degradedReason || null;
  const freshnessBlocksContinuation = !baseDegradedReason && (freshness.freshnessState === 'stale-recoverable' || freshness.freshnessState === 'expired');

  return {
    ...base,
    ...freshness,
    compartmentKey: normalizeCompartmentKey(
      base.compartmentKey
        || base.lastTurn?.compartmentKey
        || base.lastTurn?.executionContext?.compartmentKey
    ),
    continuationReady: base.continuationReady === true && freshness.freshnessState !== 'stale-recoverable' && freshness.freshnessState !== 'expired',
    degradedReason: baseDegradedReason || (freshnessBlocksContinuation ? freshness.freshnessReason : null)
  };
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
  return isTrustedCaptureMode(captureMode);
}

function deriveExecutionStatus(turnRecord = {}) {
  if (turnRecord?.cancelled) return 'cancelled';
  if (turnRecord?.success === false) return 'failed';
  if (turnRecord?.success) return 'succeeded';
  return 'unknown';
}

function findLatestPineStructuredSummary(turnRecord = {}) {
  const actionResults = Array.isArray(turnRecord?.actionResults)
    ? turnRecord.actionResults
    : normalizeActionResultEntries(turnRecord.results || turnRecord.executionResult?.actionResults);

  for (let index = actionResults.length - 1; index >= 0; index--) {
    const summary = actionResults[index]?.pineStructuredSummary;
    if (summary && typeof summary === 'object') return summary;
  }

  return null;
}

function deriveNextRecommendedStep(turnRecord = {}) {
  if (turnRecord?.nextRecommendedStep) return normalizeText(turnRecord.nextRecommendedStep, 240);
  if (turnRecord?.cancelled) return 'Ask whether to retry the interrupted step or choose a different path.';
  if (turnRecord?.success === false) return 'Review the failed step and gather fresh evidence before continuing.';
  const pineStructuredSummary = findLatestPineStructuredSummary(turnRecord);
  if (pineStructuredSummary?.editorVisibleState === 'existing-script-visible') {
    return 'Visible Pine script content is already present; avoid overwriting it implicitly and choose a new-script path or ask before editing.';
  }
  if (pineStructuredSummary?.editorVisibleState === 'empty-or-starter') {
    return 'The Pine Editor looks empty or starter-like; continue with a bounded new-script draft instead of overwriting unseen content.';
  }
  if (pineStructuredSummary?.editorVisibleState === 'unknown-visible-state') {
    return 'The visible Pine Editor state is ambiguous; inspect further or ask before overwriting content.';
  }
  if (pineStructuredSummary?.compileStatus === 'errors-visible') {
    return 'Visible Pine compiler errors are present; fix the visible errors before inferring runtime or chart behavior.';
  }
  if (pineStructuredSummary?.lineBudgetSignal === 'near-limit-visible'
    || pineStructuredSummary?.lineBudgetSignal === 'at-limit-visible'
    || pineStructuredSummary?.lineBudgetSignal === 'over-budget-visible') {
    return 'Visible Pine line-budget pressure is high; prefer targeted edits over a broad rewrite.';
  }
  if (typeof pineStructuredSummary?.warningCountEstimate === 'number' && pineStructuredSummary.warningCountEstimate > 0) {
    return 'Visible Pine warnings are present; review those warnings before trusting the script behavior.';
  }
  if (pineStructuredSummary?.compileStatus === 'success') {
    return 'Visible Pine compile success is only compiler evidence; use logs, profiler, or chart evidence before inferring runtime behavior.';
  }
  if (pineStructuredSummary?.evidenceMode === 'logs-summary') {
    if (pineStructuredSummary.outputSignal === 'errors-visible') {
      return 'Visible Pine Logs errors are present; address the visible log errors before inferring runtime or chart behavior.';
    }
    if (pineStructuredSummary.outputSignal === 'warnings-visible') {
      return 'Visible Pine Logs warnings are present; review the visible warnings before trusting the script behavior.';
    }
    return 'Visible Pine Logs output is bounded evidence only; continue from the visible log lines without inferring hidden runtime state.';
  }
  if (pineStructuredSummary?.evidenceMode === 'profiler-summary') {
    return 'Visible Pine Profiler metrics are performance evidence only; use them to target bottlenecks without inferring chart or strategy behavior.';
  }
  if (turnRecord?.postVerification?.needsFollowUp) return 'Continue with the detected follow-up flow for the current app state.';
  if (turnRecord?.screenshotCaptured) return 'Continue from the latest visual evidence and current app state.';
  if (deriveVerificationStatus(turnRecord) === 'unverified') return 'Gather fresh evidence before claiming the requested state change is complete.';
  return 'Continue from the current subgoal using the latest execution results.';
}

function deriveDegradedReason(normalizedTurn = {}) {
  if (normalizedTurn.executionStatus === 'cancelled') return 'The last action batch was cancelled before completion.';
  if (normalizedTurn.executionStatus === 'failed') return 'The last action batch did not complete successfully.';
  if (normalizedTurn.verificationStatus === 'contradicted') return 'The latest evidence contradicts the claimed result.';
  if (normalizedTurn.verificationStatus === 'unverified') return 'The latest result is not fully verified yet.';
  if (normalizedTurn.observationEvidence?.captureDegradedReason) return normalizedTurn.observationEvidence.captureDegradedReason;
  if (isScreenLikeCaptureMode(normalizedTurn.captureMode) && normalizedTurn.captureTrusted === false) {
    return 'Visual evidence fell back to full-screen capture instead of a trusted target-window capture.';
  }
  return null;
}

function normalizeTurnRecord(turnRecord = {}, previousContinuity = defaultChatContinuity()) {
  const actionTypes = normalizeActionTypes(turnRecord.actionPlan || turnRecord.actions);
  const actionPlan = normalizeActionPlanEntries(turnRecord.actionPlan || turnRecord.actions);
  const actionResults = normalizeActionResultEntries(turnRecord.results || turnRecord.executionResult?.actionResults);
  const executionResult = normalizeExecutionResultDetails(turnRecord, actionResults);
  const observationEvidence = normalizeObservationEvidence(turnRecord);
  const tradingMode = deriveTurnTradingMode(turnRecord, actionResults);
  const verificationChecks = normalizeVerificationChecks(turnRecord?.verification?.checks);
  const executionStatus = deriveExecutionStatus(turnRecord);
  const verificationStatus = deriveVerificationStatus(turnRecord);
  const captureMode = observationEvidence.captureMode || deriveCaptureMode(turnRecord);
  const captureTrusted = observationEvidence.captureTrusted ?? deriveCaptureTrusted(turnRecord);
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
    executionIntentSource: normalizeText(turnRecord.executionIntentSource, 80) || 'literal-user-input',
    executionContext: normalizeExecutionContextIdentity(turnRecord.executionContext || turnRecord.executionContextEnvelope || null),
    compartmentKey: normalizeCompartmentKey(
      turnRecord.compartmentKey
        || turnRecord.executionContext?.compartmentKey
        || turnRecord.executionContextEnvelope?.compartmentKey
    ),
    committedSubgoal: currentSubgoal,
    thought: normalizeText(turnRecord.thought, 240),
    actionTypes,
    actionSummary: summarizeActionTypes(actionTypes),
    actionPlan,
    actionResults,
    executionStatus,
    executedCount: Number.isFinite(Number(turnRecord.executedCount)) ? Number(turnRecord.executedCount) : actionTypes.length,
    executionResult,
    tradingMode,
    selectedSkillIds: normalizeIdList(turnRecord.selectedSkillIds),
    selectedMemoryIds: normalizeIdList(turnRecord.selectedMemoryIds),
    retrievalSummary: {
      skills: normalizeRetrievalSummary(turnRecord?.retrievalSummary?.skills),
      memories: normalizeRetrievalSummary(turnRecord?.retrievalSummary?.memories)
    },
    verificationStatus,
    verificationChecks,
    observationEvidence,
    captureMode,
    captureTrusted,
    targetWindowHandle: Number.isFinite(Number(turnRecord.targetWindowHandle)) ? Number(turnRecord.targetWindowHandle) : null,
    windowTitle: normalizeText(turnRecord.windowTitle, 240),
    nextRecommendedStep: deriveNextRecommendedStep(turnRecord)
  };

  const degradedReason = deriveDegradedReason(normalizedTurn);

  return hydrateChatContinuity({
    activeGoal,
    currentSubgoal,
    compartmentKey: normalizedTurn.compartmentKey || previousContinuity?.compartmentKey || null,
    lastTurn: normalizedTurn,
    continuationReady: normalizedTurn.executionStatus === 'succeeded' && !degradedReason,
    degradedReason
  });
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
  const continuity = hydrateChatContinuity(state?.chatContinuity || state || defaultChatContinuity());
  const lines = [];
  if (continuity.compartmentKey) lines.push(`Compartment: ${continuity.compartmentKey}`);
  if (continuity.activeGoal) lines.push(`Active goal: ${continuity.activeGoal}`);
  if (continuity.currentSubgoal) lines.push(`Current subgoal: ${continuity.currentSubgoal}`);
  if (continuity.lastTurn?.actionSummary) lines.push(`Last actions: ${continuity.lastTurn.actionSummary}`);
  if (continuity.lastTurn?.executionStatus) lines.push(`Last execution: ${continuity.lastTurn.executionStatus}`);
  if (continuity.lastTurn?.executionResult?.failureCount > 0) lines.push(`Failed actions: ${continuity.lastTurn.executionResult.failureCount}`);
  if (continuity.lastTurn?.verificationStatus) lines.push(`Verification: ${continuity.lastTurn.verificationStatus}`);
  if (continuity.lastTurn?.tradingMode?.mode) lines.push(`Trading mode: ${continuity.lastTurn.tradingMode.mode}`);
  if (continuity.lastTurn?.targetWindowHandle) lines.push(`Target window: ${continuity.lastTurn.targetWindowHandle}`);
  if (continuity.lastTurn?.captureMode) lines.push(`Capture mode: ${continuity.lastTurn.captureMode}`);
  if (typeof continuity.lastTurn?.captureTrusted === 'boolean') lines.push(`Capture trusted: ${continuity.lastTurn.captureTrusted ? 'yes' : 'no'}`);
  if (continuity.freshnessState) lines.push(`Continuation freshness: ${continuity.freshnessState}`);
  if (continuity.freshnessAgeMs !== null && continuity.freshnessAgeMs !== undefined) lines.push(`Continuity age: ${continuity.freshnessAgeMs}ms`);
  if (typeof continuity.continuationReady === 'boolean') lines.push(`Continuation ready: ${continuity.continuationReady ? 'yes' : 'no'}`);
  if (continuity.degradedReason) lines.push(`Continuity caution: ${continuity.degradedReason}`);
  return lines.join('\n').trim() || 'No chat continuity recorded.';
}

function isBroadAdvisoryPivotInput(message) {
  const text = String(message || '').trim().toLowerCase();
  if (!text) return false;

  const hasAdvisorySignal = /\b(what would help|what should i|how can i|confidence|invest|investing|visualizations|indicators|data|catalyst|fundamental|fundamentals|what matters|what should i watch|what should i use)\b/i.test(text);
  const hasExplicitExecutionSignal = /\b(continue|apply|add|open|show|set|switch|change|draw|place|capture|screenshot|pine logs|pine editor|pine script editor|pine profiler|performance profiler|pine version history|revision history|script history|volume profile|rsi|macd|bollinger|alert|timeframe|watchlist)\b/i.test(text);
  return hasAdvisorySignal && !hasExplicitExecutionSignal;
}

function formatScopedAdvisoryContinuityContext(continuity) {
  const hydratedContinuity = hydrateChatContinuity(continuity);
  const lastTurn = hydratedContinuity?.lastTurn || null;
  const lines = [
    '- continuityScope: advisory-pivot'
  ];

  if (lastTurn?.targetWindowHandle || lastTurn?.windowTitle) {
    lines.push(`- priorTargetWindow: ${lastTurn.windowTitle || 'unknown'}${lastTurn.targetWindowHandle ? ` [${lastTurn.targetWindowHandle}]` : ''}`);
  }
  if (lastTurn?.captureMode) lines.push(`- priorCaptureMode: ${lastTurn.captureMode}`);
  if (typeof lastTurn?.captureTrusted === 'boolean') lines.push(`- priorCaptureTrusted: ${lastTurn.captureTrusted ? 'yes' : 'no'}`);
  if (hydratedContinuity?.freshnessState) lines.push(`- priorContinuityFreshness: ${hydratedContinuity.freshnessState}`);
  if (typeof hydratedContinuity?.continuationReady === 'boolean') lines.push(`- priorContinuationReady: ${hydratedContinuity.continuationReady ? 'yes' : 'no'}`);
  if (hydratedContinuity?.degradedReason) lines.push(`- priorDegradedReason: ${hydratedContinuity.degradedReason}`);
  lines.push('- Rule: The current user turn is broad advisory planning, not an explicit continuation of the prior chart-analysis step.');
  lines.push('- Rule: Do not restate prior chart-specific observations, indicator readings, or price-level claims as current facts unless fresh trusted evidence is gathered or the user explicitly resumes that analysis branch.');
  lines.push('- Rule: You may reuse only high-level domain context and safe next-step options from the prior TradingView workflow.');
  return lines.join('\n').trim();
}

function formatChatContinuityContext(state, options = {}) {
  const continuity = hydrateChatContinuity(state?.chatContinuity || state || defaultChatContinuity());
  const lastTurn = continuity.lastTurn || null;
  if (!continuity.activeGoal && !lastTurn) return '';

  if (isBroadAdvisoryPivotInput(options?.userMessage)) {
    return formatScopedAdvisoryContinuityContext(continuity);
  }

  const lines = [];
  if (continuity.compartmentKey) lines.push(`- compartmentKey: ${continuity.compartmentKey}`);
  if (continuity.activeGoal) lines.push(`- activeGoal: ${continuity.activeGoal}`);
  if (continuity.currentSubgoal) lines.push(`- currentSubgoal: ${continuity.currentSubgoal}`);
  if (lastTurn?.userMessage) lines.push(`- lastUserMessage: ${lastTurn.userMessage}`);
  if (lastTurn?.executionIntentSource) lines.push(`- executionIntentSource: ${lastTurn.executionIntentSource}`);
  if (lastTurn?.executionContext?.appId || lastTurn?.executionContext?.windowTitle) {
    lines.push(`- continuityExecutionContext: ${(lastTurn.executionContext.appId || 'unknown-app')}${lastTurn.executionContext.windowTitle ? ` | ${lastTurn.executionContext.windowTitle}` : ''}`);
  }
  if (lastTurn?.actionSummary) lines.push(`- lastExecutedActions: ${lastTurn.actionSummary}`);
  if (lastTurn?.executionStatus) lines.push(`- lastExecutionStatus: ${lastTurn.executionStatus}`);
  if (lastTurn?.executionResult?.successCount !== undefined || lastTurn?.executionResult?.failureCount !== undefined) {
    lines.push(`- lastExecutionCounts: success=${Number(lastTurn.executionResult?.successCount || 0)}, failed=${Number(lastTurn.executionResult?.failureCount || 0)}`);
  }
  if (lastTurn?.verificationStatus) lines.push(`- lastVerificationStatus: ${lastTurn.verificationStatus}`);
  if (Array.isArray(lastTurn?.verificationChecks) && lastTurn.verificationChecks.length > 0) {
    const checks = lastTurn.verificationChecks.map((check) => `${check.name}=${check.status}`).join(' | ');
    lines.push(`- verificationChecks: ${checks}`);
  }
  if (lastTurn?.tradingMode?.mode) {
    lines.push(`- tradingMode: ${lastTurn.tradingMode.mode}${lastTurn.tradingMode.confidence ? ` (${lastTurn.tradingMode.confidence})` : ''}`);
  }
  if (Array.isArray(lastTurn?.tradingMode?.evidence) && lastTurn.tradingMode.evidence.length > 0) {
    lines.push(`- tradingModeEvidence: ${lastTurn.tradingMode.evidence.join(' | ')}`);
  }
  if (lastTurn?.targetWindowHandle || lastTurn?.windowTitle) {
    lines.push(`- targetWindow: ${lastTurn.windowTitle || 'unknown'}${lastTurn.targetWindowHandle ? ` [${lastTurn.targetWindowHandle}]` : ''}`);
  }
  if (lastTurn?.captureMode) lines.push(`- lastCaptureMode: ${lastTurn.captureMode}`);
  if (typeof lastTurn?.captureTrusted === 'boolean') lines.push(`- lastCaptureTrusted: ${lastTurn.captureTrusted ? 'yes' : 'no'}`);
  if (lastTurn?.observationEvidence?.captureProvider) lines.push(`- lastCaptureProvider: ${lastTurn.observationEvidence.captureProvider}`);
  if (lastTurn?.observationEvidence?.captureCapability) lines.push(`- lastCaptureCapability: ${lastTurn.observationEvidence.captureCapability}`);
  if (typeof lastTurn?.observationEvidence?.captureNonDisruptive === 'boolean') {
    lines.push(`- lastCaptureNonDisruptive: ${lastTurn.observationEvidence.captureNonDisruptive ? 'yes' : 'no'}`);
  }
  if (lastTurn?.observationEvidence?.visualContextRef) lines.push(`- visualContextRef: ${lastTurn.observationEvidence.visualContextRef}`);
  if (typeof lastTurn?.observationEvidence?.uiWatcherFresh === 'boolean') {
    lines.push(`- uiWatcherFresh: ${lastTurn.observationEvidence.uiWatcherFresh ? 'yes' : 'no'}`);
  }
  if (lastTurn?.observationEvidence?.uiWatcherAgeMs !== null && lastTurn?.observationEvidence?.uiWatcherAgeMs !== undefined) {
    lines.push(`- uiWatcherAgeMs: ${lastTurn.observationEvidence.uiWatcherAgeMs}`);
  }
  if (continuity.freshnessState) lines.push(`- continuityFreshness: ${continuity.freshnessState}`);
  if (continuity.freshnessAgeMs !== null && continuity.freshnessAgeMs !== undefined) {
    lines.push(`- continuityAgeMs: ${continuity.freshnessAgeMs}`);
  }
  if (continuity.freshnessBudgetMs !== null && continuity.freshnessBudgetMs !== undefined) {
    lines.push(`- continuityFreshBudgetMs: ${continuity.freshnessBudgetMs}`);
  }
  if (continuity.freshnessRecoverableBudgetMs !== null && continuity.freshnessRecoverableBudgetMs !== undefined) {
    lines.push(`- continuityRecoverableBudgetMs: ${continuity.freshnessRecoverableBudgetMs}`);
  }
  if (Array.isArray(lastTurn?.actionResults) && lastTurn.actionResults.length > 0) {
    const compactResults = lastTurn.actionResults.slice(0, 4).map((result) => `${result.type}:${result.success ? 'ok' : 'fail'}`).join(' | ');
    lines.push(`- actionOutcomes: ${compactResults}`);
  }
  const pineStructuredSummary = findLatestPineStructuredSummary(lastTurn);
  if (pineStructuredSummary?.editorVisibleState) {
    lines.push(`- pineAuthoringState: ${pineStructuredSummary.editorVisibleState}`);
    if (pineStructuredSummary.visibleScriptKind) lines.push(`- pineVisibleScriptKind: ${pineStructuredSummary.visibleScriptKind}`);
    if (pineStructuredSummary.visibleLineCountEstimate !== null && pineStructuredSummary.visibleLineCountEstimate !== undefined) {
      lines.push(`- pineVisibleLineCountEstimate: ${pineStructuredSummary.visibleLineCountEstimate}`);
    }
    if (Array.isArray(pineStructuredSummary.visibleSignals) && pineStructuredSummary.visibleSignals.length > 0) {
      lines.push(`- pineVisibleSignals: ${pineStructuredSummary.visibleSignals.join(' | ')}`);
    }
  }
  if (pineStructuredSummary?.evidenceMode) lines.push(`- pineEvidenceMode: ${pineStructuredSummary.evidenceMode}`);
  if (pineStructuredSummary?.compactSummary) lines.push(`- pineCompactSummary: ${pineStructuredSummary.compactSummary}`);
  if (pineStructuredSummary?.outputSurface) lines.push(`- pineOutputSurface: ${pineStructuredSummary.outputSurface}`);
  if (pineStructuredSummary?.outputSignal) lines.push(`- pineOutputSignal: ${pineStructuredSummary.outputSignal}`);
  if (pineStructuredSummary?.visibleOutputEntryCount !== null && pineStructuredSummary?.visibleOutputEntryCount !== undefined) {
    lines.push(`- pineVisibleOutputEntryCount: ${pineStructuredSummary.visibleOutputEntryCount}`);
  }
  if (pineStructuredSummary?.functionCallCountEstimate !== null && pineStructuredSummary?.functionCallCountEstimate !== undefined) {
    lines.push(`- pineFunctionCallCountEstimate: ${pineStructuredSummary.functionCallCountEstimate}`);
  }
  if (pineStructuredSummary?.avgTimeMs !== null && pineStructuredSummary?.avgTimeMs !== undefined) {
    lines.push(`- pineAvgTimeMs: ${pineStructuredSummary.avgTimeMs}`);
  }
  if (pineStructuredSummary?.maxTimeMs !== null && pineStructuredSummary?.maxTimeMs !== undefined) {
    lines.push(`- pineMaxTimeMs: ${pineStructuredSummary.maxTimeMs}`);
  }
  if (Array.isArray(pineStructuredSummary?.topVisibleOutputs) && pineStructuredSummary.topVisibleOutputs.length > 0) {
    lines.push(`- pineTopVisibleOutputs: ${pineStructuredSummary.topVisibleOutputs.join(' | ')}`);
  }
  if (pineStructuredSummary?.compileStatus) {
    lines.push(`- pineCompileStatus: ${pineStructuredSummary.compileStatus}`);
    if (pineStructuredSummary.errorCountEstimate !== null && pineStructuredSummary.errorCountEstimate !== undefined) {
      lines.push(`- pineErrorCountEstimate: ${pineStructuredSummary.errorCountEstimate}`);
    }
    if (pineStructuredSummary.warningCountEstimate !== null && pineStructuredSummary.warningCountEstimate !== undefined) {
      lines.push(`- pineWarningCountEstimate: ${pineStructuredSummary.warningCountEstimate}`);
    }
    if (pineStructuredSummary.lineBudgetSignal) lines.push(`- pineLineBudgetSignal: ${pineStructuredSummary.lineBudgetSignal}`);
    if (Array.isArray(pineStructuredSummary.statusSignals) && pineStructuredSummary.statusSignals.length > 0) {
      lines.push(`- pineStatusSignals: ${pineStructuredSummary.statusSignals.join(' | ')}`);
    }
    if (Array.isArray(pineStructuredSummary.topVisibleDiagnostics) && pineStructuredSummary.topVisibleDiagnostics.length > 0) {
      lines.push(`- pineTopVisibleDiagnostics: ${pineStructuredSummary.topVisibleDiagnostics.join(' | ')}`);
    }
  }
  if (pineStructuredSummary?.latestVisibleRevisionLabel) lines.push(`- pineLatestVisibleRevisionLabel: ${pineStructuredSummary.latestVisibleRevisionLabel}`);
  if (pineStructuredSummary?.latestVisibleRevisionNumber !== null && pineStructuredSummary?.latestVisibleRevisionNumber !== undefined) {
    lines.push(`- pineLatestVisibleRevisionNumber: ${pineStructuredSummary.latestVisibleRevisionNumber}`);
  }
  if (pineStructuredSummary?.latestVisibleRelativeTime) lines.push(`- pineLatestVisibleRelativeTime: ${pineStructuredSummary.latestVisibleRelativeTime}`);
  if (pineStructuredSummary?.visibleRevisionCount !== null && pineStructuredSummary?.visibleRevisionCount !== undefined) {
    lines.push(`- pineVisibleRevisionCount: ${pineStructuredSummary.visibleRevisionCount}`);
  }
  if (pineStructuredSummary?.visibleRecencySignal) lines.push(`- pineVisibleRecencySignal: ${pineStructuredSummary.visibleRecencySignal}`);
  if (Array.isArray(pineStructuredSummary?.topVisibleRevisions) && pineStructuredSummary.topVisibleRevisions.length > 0) {
    const revisions = pineStructuredSummary.topVisibleRevisions
      .map((entry) => [entry.label, entry.relativeTime, entry.revisionNumber !== null && entry.revisionNumber !== undefined ? `#${entry.revisionNumber}` : null].filter(Boolean).join(' '))
      .filter(Boolean)
      .join(' | ');
    if (revisions) lines.push(`- pineTopVisibleRevisions: ${revisions}`);
  }
  if (lastTurn?.executionResult?.popupFollowUp?.attempted) {
    const popup = lastTurn.executionResult.popupFollowUp;
    lines.push(`- popupFollowUp: ${popup.recipeId || 'recipe'} attempted=${popup.attempted ? 'yes' : 'no'} completed=${popup.completed ? 'yes' : 'no'}`);
  }
  lines.push(`- continuationReady: ${continuity.continuationReady ? 'yes' : 'no'}`);
  if (continuity.degradedReason) lines.push(`- degradedReason: ${continuity.degradedReason}`);
  if (lastTurn?.nextRecommendedStep) lines.push(`- nextRecommendedStep: ${lastTurn.nextRecommendedStep}`);
  lines.push('- Rule: If the user asks to continue, continue from the current subgoal and these execution facts instead of inventing a new branch.');
  if (continuity.freshnessState === 'stale-recoverable') {
    lines.push('- Rule: Stored continuity is stale-but-recoverable; re-observe the target window before treating prior UI facts as current.');
  }
  if (continuity.freshnessState === 'expired') {
    lines.push('- Rule: Stored continuity is expired; do not continue from prior UI-specific state until fresh evidence is gathered.');
  }
  if (lastTurn?.tradingMode?.mode === 'paper') {
    lines.push('- Rule: Paper Trading was observed; continue with assist-only verification and guidance, not order execution.');
  }
  if (pineStructuredSummary?.evidenceMode === 'safe-authoring-inspect') {
    lines.push('- Rule: Pine authoring continuity is limited to the visible editor state; do not overwrite unseen script content implicitly.');
    if (pineStructuredSummary?.editorVisibleState === 'existing-script-visible') {
      lines.push('- Rule: Existing visible Pine script content is already present; prefer a new-script path or ask before editing in place.');
    }
    if (pineStructuredSummary?.editorVisibleState === 'empty-or-starter') {
      lines.push('- Rule: The visible Pine script looks empty or starter-like; keep any drafting bounded to that visible starter state.');
    }
  }
  if (
    pineStructuredSummary?.evidenceMode === 'diagnostics'
    || pineStructuredSummary?.evidenceMode === 'line-budget'
    || pineStructuredSummary?.evidenceMode === 'compile-result'
  ) {
    lines.push('- Rule: Pine diagnostics continuity is limited to the visible compiler status, warnings, errors, and line-budget hints.');
    lines.push('- Rule: Fix or summarize only the visible Pine diagnostics before inferring runtime behavior or broader chart effects.');
    if (
      pineStructuredSummary?.lineBudgetSignal === 'near-limit-visible'
      || pineStructuredSummary?.lineBudgetSignal === 'at-limit-visible'
      || pineStructuredSummary?.lineBudgetSignal === 'over-budget-visible'
    ) {
      lines.push('- Rule: Visible Pine line-budget pressure favors targeted edits over broad rewrites.');
    }
  }
  if (pineStructuredSummary?.evidenceMode === 'provenance-summary') {
    lines.push('- Rule: Pine Version History continuity is provenance-only; use only the visible revision metadata.');
    lines.push('- Rule: Do not infer hidden revisions, full script content, or runtime/chart behavior from Version History alone.');
  }
  if (pineStructuredSummary?.evidenceMode === 'logs-summary') {
    lines.push('- Rule: Pine Logs continuity is limited to the visible log output and visible error or warning lines only.');
    lines.push('- Rule: Do not infer hidden stack traces, hidden runtime state, or broader chart behavior from Pine Logs alone.');
  }
  if (pineStructuredSummary?.evidenceMode === 'profiler-summary') {
    lines.push('- Rule: Pine Profiler continuity is limited to the visible performance metrics and hotspots only.');
    lines.push('- Rule: Treat profiler output as performance evidence, not proof of runtime correctness or chart behavior.');
  }
  if (lastTurn?.verificationStatus && lastTurn.verificationStatus !== 'verified') {
    lines.push('- Rule: Do not claim the requested UI change is complete unless the latest evidence verifies it.');
  }
  return lines.join('\n').trim();
}

function normalizePendingRequestedTask(task = {}) {
  if (!task || typeof task !== 'object') return null;

  const taskSummary = normalizeText(
    task.taskSummary
      || task.executionIntent
      || task.userMessage,
    240
  );

  if (!taskSummary) return null;

  return {
    recordedAt: normalizeText(task.recordedAt, 60) || nowIso(),
    userMessage: normalizeText(task.userMessage, 280),
    executionIntent: normalizeText(task.executionIntent, 280),
    executionIntentSource: normalizeText(task.executionIntentSource, 80) || 'literal-user-input',
    taskSummary,
    targetApp: normalizeText(task.targetApp, 80),
    targetWindowTitle: normalizeText(task.targetWindowTitle, 160),
    taskKind: normalizeText(task.taskKind, 80),
    targetSurface: normalizeText(task.targetSurface, 80),
    targetSymbol: normalizeText(task.targetSymbol, 32),
    requestedVerification: normalizeText(task.requestedVerification, 120),
    resumeDisposition: normalizeText(task.resumeDisposition, 80),
    blockedReason: normalizeText(task.blockedReason, 120),
    continuationIntent: normalizeText(task.continuationIntent, 1200),
    recoveryNote: normalizeText(task.recoveryNote, 240),
    requestedAddToChart: typeof task.requestedAddToChart === 'boolean' ? task.requestedAddToChart : null,
    executionContext: normalizeExecutionContextIdentity(task.executionContext || task.executionContextEnvelope || null),
    compartmentKey: normalizeCompartmentKey(
      task.compartmentKey
        || task.executionContext?.compartmentKey
        || task.executionContextEnvelope?.compartmentKey
    )
  };
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
    cachedState.chatContinuity = hydrateChatContinuity(cachedState.chatContinuity || defaultChatContinuity());
    cachedState = migrateLegacyCompartmentState(cachedState);
    return cachedState;
  }

  function saveState(nextState) {
    const normalizedChatContinuityByCompartment = {};
    for (const [key, value] of Object.entries(nextState.chatContinuityByCompartment || {})) {
      const normalizedKey = normalizeCompartmentKey(key);
      if (!normalizedKey || !hasMeaningfulChatContinuity(value)) continue;
      normalizedChatContinuityByCompartment[normalizedKey] = hydrateChatContinuity({
        ...(value && typeof value === 'object' ? value : {}),
        compartmentKey: normalizedKey
      });
    }

    const normalizedPendingRequestedTaskByCompartment = {};
    for (const [key, value] of Object.entries(nextState.pendingRequestedTaskByCompartment || {})) {
      const normalizedKey = normalizeCompartmentKey(key);
      const normalizedTask = normalizePendingRequestedTask(value);
      if (!normalizedKey || !normalizedTask) continue;
      normalizedPendingRequestedTaskByCompartment[normalizedKey] = {
        ...normalizedTask,
        compartmentKey: normalizedTask.compartmentKey || normalizedKey
      };
    }

    const activeCompartmentKey = normalizeCompartmentKey(nextState.activeCompartmentKey)
      || pickActiveCompartmentKey({
        ...nextState,
        chatContinuityByCompartment: normalizedChatContinuityByCompartment,
        pendingRequestedTaskByCompartment: normalizedPendingRequestedTaskByCompartment
      });

    const mirroredState = mirrorStateToCompartment({
      ...defaultState(),
      ...nextState,
      updatedAt: nowIso(),
      forgoneFeatures: limitList(nextState.forgoneFeatures || [], 12),
      explicitCorrections: limitList(nextState.explicitCorrections || [], 12),
      activeCompartmentKey,
      chatContinuityByCompartment: normalizedChatContinuityByCompartment,
      pendingRequestedTaskByCompartment: normalizedPendingRequestedTaskByCompartment,
      chatContinuity: hydrateChatContinuity(nextState.chatContinuity),
      pendingRequestedTask: normalizePendingRequestedTask(nextState.pendingRequestedTask)
    }, activeCompartmentKey);

    const state = mirroredState;
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
      if (!String(state.activeCompartmentKey || '').startsWith(`${currentRepo.normalizedRepoName || ''}::`)) {
        state.activeCompartmentKey = findLatestCompartmentKeyForRepo(state.chatContinuityByCompartment, currentRepo.normalizedRepoName)
          || findLatestCompartmentKeyForRepo(state.pendingRequestedTaskByCompartment, currentRepo.normalizedRepoName)
          || null;
      }
      return true;
    }
    return false;
  }

  function getState(options = {}) {
    const state = cloneState(loadState());
    if (syncCurrentRepo(state, options.cwd)) {
      return saveState(state);
    }
    const selection = resolveSelectedCompartmentKey(state, options);
    return mirrorStateToCompartment(state, selection.compartmentKey, { strict: selection.strict });
  }

  function clearState(options = {}) {
    const state = defaultState();
    syncCurrentRepo(state, options.cwd || process.cwd());
    return saveState(state);
  }

  function clearChatContinuity(options = {}) {
    const state = cloneState(loadState());
    syncCurrentRepo(state, options.cwd || process.cwd());
    const selection = resolveSelectedCompartmentKey(state, options);
    const compartmentKey = selection.compartmentKey || state.activeCompartmentKey;
    if (compartmentKey && state.chatContinuityByCompartment[compartmentKey]) {
      delete state.chatContinuityByCompartment[compartmentKey];
      state.chatContinuity = defaultChatContinuity();
      if (state.activeCompartmentKey === compartmentKey) {
        state.activeCompartmentKey = pickActiveCompartmentKey(state);
      }
    } else {
      state.chatContinuity = defaultChatContinuity();
    }
    return saveState(state);
  }

  function setPendingRequestedTask(task, options = {}) {
    const state = cloneState(loadState());
    syncCurrentRepo(state, options.cwd || process.cwd());
    const normalizedTask = normalizePendingRequestedTask(task);
    const selection = resolveSelectedCompartmentKey(state, options, normalizedTask || task);
    const compartmentKey = selection.compartmentKey;
    state.pendingRequestedTask = normalizedTask;
    if (normalizedTask && compartmentKey) {
      state.pendingRequestedTaskByCompartment[compartmentKey] = {
        ...normalizedTask,
        compartmentKey: normalizedTask.compartmentKey || compartmentKey
      };
      state.activeCompartmentKey = compartmentKey;
    }
    return saveState(state);
  }

  function clearPendingRequestedTask(options = {}) {
    const state = cloneState(loadState());
    syncCurrentRepo(state, options.cwd || process.cwd());
    const selection = resolveSelectedCompartmentKey(state, options);
    const compartmentKey = selection.compartmentKey || state.activeCompartmentKey;
    if (compartmentKey && state.pendingRequestedTaskByCompartment[compartmentKey]) {
      delete state.pendingRequestedTaskByCompartment[compartmentKey];
    }
    state.pendingRequestedTask = null;
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
    const selection = resolveSelectedCompartmentKey(state, options, turnRecord);
    const previousContinuity = getChatContinuityForCompartment(state, selection.compartmentKey, { strict: false });
    const normalizedContinuity = normalizeTurnRecord(turnRecord, previousContinuity);
    const compartmentKey = normalizedContinuity.compartmentKey
      || normalizedContinuity.lastTurn?.compartmentKey
      || selection.compartmentKey;
    state.chatContinuity = normalizedContinuity;
    if (compartmentKey) {
      state.chatContinuityByCompartment[compartmentKey] = {
        ...normalizedContinuity,
        compartmentKey
      };
      state.activeCompartmentKey = compartmentKey;
    }
    return saveState(state);
  }

  function getChatContinuity(options = {}) {
    return cloneState(getState(options).chatContinuity || defaultChatContinuity());
  }

  function getPendingRequestedTask(options = {}) {
    return cloneState(getState(options).pendingRequestedTask || null);
  }

  return {
    clearChatContinuity,
    clearPendingRequestedTask,
    clearState,
    getChatContinuity,
    getPendingRequestedTask,
    getState,
    ingestUserMessage,
    recordExecutedTurn,
    saveState,
    setPendingRequestedTask,
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
  getPendingRequestedTask: (options) => defaultStore.getPendingRequestedTask(options),
  getSessionIntentState: (options) => defaultStore.getState(options),
  clearChatContinuityState: (options) => defaultStore.clearChatContinuity(options),
  clearPendingRequestedTask: (options) => defaultStore.clearPendingRequestedTask(options),
  clearSessionIntentState: (options) => defaultStore.clearState(options),
  ingestUserIntentState: (message, options) => defaultStore.ingestUserMessage(message, options),
  recordChatContinuityTurn: (turnRecord, options) => defaultStore.recordExecutedTurn(turnRecord, options),
  setPendingRequestedTask: (task, options) => defaultStore.setPendingRequestedTask(task, options)
};
