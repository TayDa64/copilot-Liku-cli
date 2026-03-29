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
    pendingRequestedTask: null,
    chatContinuity: defaultChatContinuity()
  };
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
    editorVisibleState: normalizeText(summary.editorVisibleState, 60),
    visibleScriptKind: normalizeText(summary.visibleScriptKind, 40),
    visibleLineCountEstimate: Number.isFinite(Number(summary.visibleLineCountEstimate)) ? Number(summary.visibleLineCountEstimate) : null,
    visibleSignals: normalizeEvidenceList(summary.visibleSignals, 40),
    latestVisibleRevisionLabel: normalizeText(summary.latestVisibleRevisionLabel, 80),
    latestVisibleRevisionNumber: Number.isFinite(Number(summary.latestVisibleRevisionNumber)) ? Number(summary.latestVisibleRevisionNumber) : null,
    latestVisibleRelativeTime: normalizeText(summary.latestVisibleRelativeTime, 80),
    visibleRevisionCount: Number.isFinite(Number(summary.visibleRevisionCount)) ? Number(summary.visibleRevisionCount) : null,
    visibleRecencySignal: normalizeText(summary.visibleRecencySignal, 60),
    topVisibleRevisions
  };

  if (!normalized.evidenceMode
    && !normalized.compactSummary
    && !normalized.editorVisibleState
    && !normalized.visibleScriptKind
    && normalized.visibleLineCountEstimate === null
    && normalized.visibleSignals.length === 0
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
  return results.slice(0, 12).map((result, index) => ({
    index: Number.isFinite(Number(result?.index)) ? Number(result.index) : index,
    type: normalizeText(result?.type, 60),
    success: !!result?.success,
    error: normalizeText(result?.error, 180),
    message: normalizeText(result?.message, 160),
    userConfirmed: !!result?.userConfirmed,
    blockedByPolicy: !!result?.blockedByPolicy,
    pineStructuredSummary: normalizePineStructuredSummary(result?.pineStructuredSummary),
    observationCheckpoint: result?.observationCheckpoint
      ? {
          classification: normalizeText(result.observationCheckpoint.classification, 80),
          verified: !!result.observationCheckpoint.verified,
          reason: normalizeText(result.observationCheckpoint.reason, 160),
          tradingMode: normalizeTradingMode(result.observationCheckpoint.tradingMode)
        }
      : null
  }));
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

  actionResults.forEach((result) => addCandidate(result?.observationCheckpoint));

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

  return {
    activeGoal,
    currentSubgoal,
    lastTurn: normalizedTurn,
    continuationReady: normalizedTurn.executionStatus === 'succeeded' && !degradedReason,
    degradedReason
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
  if (continuity.lastTurn?.executionResult?.failureCount > 0) lines.push(`Failed actions: ${continuity.lastTurn.executionResult.failureCount}`);
  if (continuity.lastTurn?.verificationStatus) lines.push(`Verification: ${continuity.lastTurn.verificationStatus}`);
  if (continuity.lastTurn?.tradingMode?.mode) lines.push(`Trading mode: ${continuity.lastTurn.tradingMode.mode}`);
  if (continuity.lastTurn?.targetWindowHandle) lines.push(`Target window: ${continuity.lastTurn.targetWindowHandle}`);
  if (continuity.lastTurn?.captureMode) lines.push(`Capture mode: ${continuity.lastTurn.captureMode}`);
  if (typeof continuity.lastTurn?.captureTrusted === 'boolean') lines.push(`Capture trusted: ${continuity.lastTurn.captureTrusted ? 'yes' : 'no'}`);
  if (typeof continuity.continuationReady === 'boolean') lines.push(`Continuation ready: ${continuity.continuationReady ? 'yes' : 'no'}`);
  if (continuity.degradedReason) lines.push(`Continuity caution: ${continuity.degradedReason}`);
  return lines.join('\n').trim() || 'No chat continuity recorded.';
}

function isBroadAdvisoryPivotInput(message) {
  const text = String(message || '').trim().toLowerCase();
  if (!text) return false;

  const hasAdvisorySignal = /\b(what would help|what should i|how can i|confidence|invest|investing|visualizations|indicators|data|catalyst|fundamental|fundamentals|what matters|what should i watch|what should i use)\b/i.test(text);
  const hasExplicitExecutionSignal = /\b(continue|apply|add|open|show|set|switch|change|draw|place|capture|screenshot|pine logs|pine editor|volume profile|rsi|macd|bollinger|alert|timeframe|watchlist)\b/i.test(text);
  return hasAdvisorySignal && !hasExplicitExecutionSignal;
}

function formatScopedAdvisoryContinuityContext(continuity) {
  const lastTurn = continuity?.lastTurn || null;
  const lines = [
    '- continuityScope: advisory-pivot'
  ];

  if (lastTurn?.targetWindowHandle || lastTurn?.windowTitle) {
    lines.push(`- priorTargetWindow: ${lastTurn.windowTitle || 'unknown'}${lastTurn.targetWindowHandle ? ` [${lastTurn.targetWindowHandle}]` : ''}`);
  }
  if (lastTurn?.captureMode) lines.push(`- priorCaptureMode: ${lastTurn.captureMode}`);
  if (typeof lastTurn?.captureTrusted === 'boolean') lines.push(`- priorCaptureTrusted: ${lastTurn.captureTrusted ? 'yes' : 'no'}`);
  if (typeof continuity?.continuationReady === 'boolean') lines.push(`- priorContinuationReady: ${continuity.continuationReady ? 'yes' : 'no'}`);
  if (continuity?.degradedReason) lines.push(`- priorDegradedReason: ${continuity.degradedReason}`);
  lines.push('- Rule: The current user turn is broad advisory planning, not an explicit continuation of the prior chart-analysis step.');
  lines.push('- Rule: Do not restate prior chart-specific observations, indicator readings, or price-level claims as current facts unless fresh trusted evidence is gathered or the user explicitly resumes that analysis branch.');
  lines.push('- Rule: You may reuse only high-level domain context and safe next-step options from the prior TradingView workflow.');
  return lines.join('\n').trim();
}

function formatChatContinuityContext(state, options = {}) {
  const continuity = state?.chatContinuity || state || defaultChatContinuity();
  const lastTurn = continuity.lastTurn || null;
  if (!continuity.activeGoal && !lastTurn) return '';

  if (isBroadAdvisoryPivotInput(options?.userMessage)) {
    return formatScopedAdvisoryContinuityContext(continuity);
  }

  const lines = [];
  if (continuity.activeGoal) lines.push(`- activeGoal: ${continuity.activeGoal}`);
  if (continuity.currentSubgoal) lines.push(`- currentSubgoal: ${continuity.currentSubgoal}`);
  if (lastTurn?.userMessage) lines.push(`- lastUserMessage: ${lastTurn.userMessage}`);
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
  if (lastTurn?.executionResult?.popupFollowUp?.attempted) {
    const popup = lastTurn.executionResult.popupFollowUp;
    lines.push(`- popupFollowUp: ${popup.recipeId || 'recipe'} attempted=${popup.attempted ? 'yes' : 'no'} completed=${popup.completed ? 'yes' : 'no'}`);
  }
  lines.push(`- continuationReady: ${continuity.continuationReady ? 'yes' : 'no'}`);
  if (continuity.degradedReason) lines.push(`- degradedReason: ${continuity.degradedReason}`);
  if (lastTurn?.nextRecommendedStep) lines.push(`- nextRecommendedStep: ${lastTurn.nextRecommendedStep}`);
  lines.push('- Rule: If the user asks to continue, continue from the current subgoal and these execution facts instead of inventing a new branch.');
  if (lastTurn?.tradingMode?.mode === 'paper') {
    lines.push('- Rule: Paper Trading was observed; continue with assist-only verification and guidance, not order execution.');
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
    taskSummary,
    targetApp: normalizeText(task.targetApp, 80),
    targetWindowTitle: normalizeText(task.targetWindowTitle, 160)
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

  function setPendingRequestedTask(task, options = {}) {
    const state = cloneState(loadState());
    syncCurrentRepo(state, options.cwd || process.cwd());
    state.pendingRequestedTask = normalizePendingRequestedTask(task);
    return saveState(state);
  }

  function clearPendingRequestedTask(options = {}) {
    const state = cloneState(loadState());
    syncCurrentRepo(state, options.cwd || process.cwd());
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
    state.chatContinuity = normalizeTurnRecord(turnRecord, state.chatContinuity);
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
