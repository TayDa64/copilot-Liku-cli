function normalizeText(value, maxLength = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength) || null;
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildVisualReference(latestVisual) {
  const ts = safeNumber(latestVisual?.timestamp || latestVisual?.addedAt);
  const mode = normalizeText(latestVisual?.captureMode || latestVisual?.scope, 80) || 'visual';
  return ts ? `${mode}@${ts}` : null;
}

function normalizeActionPlan(actions) {
  if (!Array.isArray(actions)) return [];
  return actions.slice(0, 12).map((action, index) => ({
    index,
    type: normalizeText(action?.type, 60),
    reason: normalizeText(action?.reason, 160),
    key: normalizeText(action?.key, 60),
    text: normalizeText(action?.text, 120),
    scope: normalizeText(action?.scope, 60),
    title: normalizeText(action?.title || action?.windowTitle, 120),
    processName: normalizeText(action?.processName, 80),
    windowHandle: safeNumber(action?.windowHandle || action?.targetWindowHandle),
    verifyKind: normalizeText(action?.verify?.kind, 80),
    verifyTarget: normalizeText(action?.verify?.target, 120)
  }));
}

function normalizeActionResults(results) {
  if (!Array.isArray(results)) return [];
  return results.slice(0, 12).map((result, index) => ({
    index,
    type: normalizeText(result?.action || result?.type, 60),
    success: !!result?.success,
    error: normalizeText(result?.error || result?.stderr, 180),
    message: normalizeText(result?.message, 160),
    userConfirmed: !!result?.userConfirmed,
    blockedByPolicy: !!result?.blockedByPolicy,
    observationCheckpoint: result?.observationCheckpoint
      ? {
          classification: normalizeText(result.observationCheckpoint.classification, 80),
          verified: !!result.observationCheckpoint.verified,
          reason: normalizeText(result.observationCheckpoint.reason || result.observationCheckpoint.error, 160)
        }
      : null
  }));
}

function buildVerificationChecks(execResult = {}) {
  const checks = [];

  if (execResult?.focusVerification?.applicable) {
    checks.push({
      name: 'target-window-focused',
      status: execResult.focusVerification.verified ? 'verified' : 'unverified',
      detail: normalizeText(execResult.focusVerification.reason || '', 160)
    });
  }

  if (Array.isArray(execResult?.observationCheckpoints)) {
    execResult.observationCheckpoints.slice(0, 6).forEach((checkpoint, index) => {
      if (!checkpoint?.applicable && checkpoint?.applicable !== undefined) return;
      checks.push({
        name: normalizeText(checkpoint.classification || `checkpoint-${index + 1}`, 80),
        status: checkpoint.verified ? 'verified' : 'unverified',
        detail: normalizeText(checkpoint.reason || checkpoint.error || checkpoint.popupHint || '', 160)
      });
    });
  }

  if (execResult?.postVerification?.applicable) {
    checks.push({
      name: 'post-action-target',
      status: execResult.postVerification.verified ? 'verified' : 'unverified',
      detail: normalizeText(execResult.postVerification.matchReason || execResult.postVerification.popupHint || '', 160)
    });
  }

  return checks.slice(0, 8);
}

function inferVerificationStatus(execResult = {}, checks = []) {
  if (execResult?.cancelled) return 'cancelled';
  if (execResult?.success === false) return 'failed';
  if (checks.some((check) => check.status === 'unverified')) return 'unverified';
  if (checks.some((check) => check.status === 'verified')) return 'verified';
  return execResult?.success ? 'not-applicable' : 'unknown';
}

function buildExecutionResult(execResult = {}, actionResults = []) {
  const failureCount = actionResults.filter((result) => result && result.success === false).length;
  const successCount = actionResults.filter((result) => result && result.success === true).length;
  return {
    cancelled: !!execResult?.cancelled,
    pendingConfirmation: !!execResult?.pendingConfirmation,
    userConfirmed: actionResults.some((result) => result?.userConfirmed),
    executedCount: actionResults.length,
    successCount,
    failureCount,
    failedActions: actionResults.filter((result) => result?.success === false).slice(0, 4).map((result) => ({
      type: result.type,
      error: result.error || result.message || null
    })),
    reflectionApplied: execResult?.reflectionApplied
      ? {
          action: normalizeText(execResult.reflectionApplied.action, 80),
          applied: !!execResult.reflectionApplied.applied,
          detail: normalizeText(execResult.reflectionApplied.detail, 160)
        }
      : null,
    popupFollowUp: execResult?.postVerification?.popupRecipe
      ? {
          attempted: !!execResult.postVerification.popupRecipe.attempted,
          completed: !!execResult.postVerification.popupRecipe.completed,
          steps: safeNumber(execResult.postVerification.popupRecipe.steps),
          recipeId: normalizeText(execResult.postVerification.popupRecipe.recipeId, 80)
        }
      : null
  };
}

function buildObservationEvidence(latestVisual, execResult = {}, watcherSnapshot = null, details = {}) {
  const captureMode = normalizeText(latestVisual?.captureMode || latestVisual?.scope, 80)
    || normalizeText(details.captureMode, 80)
    || (execResult?.screenshotCaptured ? 'screen' : null);
  const captureTrusted = typeof latestVisual?.captureTrusted === 'boolean'
    ? latestVisual.captureTrusted
    : (typeof details.captureTrusted === 'boolean' ? details.captureTrusted : null);

  return {
    captureMode,
    captureTrusted,
    visualContextRef: buildVisualReference(latestVisual),
    visualTimestamp: safeNumber(latestVisual?.timestamp || latestVisual?.addedAt),
    windowHandle: safeNumber(latestVisual?.windowHandle || details.targetWindowHandle || execResult?.focusVerification?.expectedWindowHandle),
    windowTitle: normalizeText(latestVisual?.windowTitle || details.windowTitle, 160),
    uiWatcherFresh: watcherSnapshot ? watcherSnapshot.ageMs <= 1600 : null,
    uiWatcherAgeMs: watcherSnapshot ? safeNumber(watcherSnapshot.ageMs) : null,
    watcherWindowHandle: watcherSnapshot ? safeNumber(watcherSnapshot.activeWindow?.hwnd) : null,
    watcherWindowTitle: watcherSnapshot ? normalizeText(watcherSnapshot.activeWindow?.title, 160) : null
  };
}

function buildChatContinuityTurnRecord({ actionData, execResult, details = {}, latestVisual = null, watcherSnapshot = null }) {
  const actionPlan = normalizeActionPlan(actionData?.actions);
  const actionResults = normalizeActionResults(execResult?.results);
  const verificationChecks = buildVerificationChecks(execResult);
  const verificationStatus = inferVerificationStatus(execResult, verificationChecks);

  return {
    recordedAt: details.recordedAt || new Date().toISOString(),
    userMessage: details.userMessage || '',
    executionIntent: details.executionIntent || details.userMessage || '',
    activeGoal: details.executionIntent || details.userMessage || '',
    currentSubgoal: actionData?.thought || details.executionIntent || details.userMessage || '',
    committedSubgoal: actionData?.thought || details.executionIntent || details.userMessage || '',
    thought: actionData?.thought || '',
    actionPlan,
    results: actionResults,
    executionResult: buildExecutionResult(execResult, actionResults),
    observationEvidence: buildObservationEvidence(latestVisual, execResult, watcherSnapshot, details),
    verification: {
      status: verificationStatus,
      checks: verificationChecks
    },
    targetWindowHandle: safeNumber(details.targetWindowHandle || latestVisual?.windowHandle || execResult?.focusVerification?.expectedWindowHandle),
    windowTitle: normalizeText(latestVisual?.windowTitle || details.windowTitle, 160),
    nextRecommendedStep: details.nextRecommendedStep || null
  };
}

module.exports = {
  buildChatContinuityTurnRecord
};
