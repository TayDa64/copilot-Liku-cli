function createObservationCheckpointRuntime(deps = {}) {
  const {
    systemAutomation,
    getUIWatcher,
    sleepMs,
    evaluateForegroundAgainstTarget,
    inferLaunchVerificationTarget,
    buildVerifyTargetHintFromAppName,
    extractTradingViewObservationKeywords,
    inferTradingViewTradingMode,
    inferTradingViewObservationSpec,
    isTradingViewTargetHint,
    keyCheckpointSettleMs = 240,
    keyCheckpointTimeoutMs = 1400,
    keyCheckpointMaxPolls = 2
  } = deps;

  function normalizeTextForMatch(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function mergeUniqueKeywords(...groups) {
    return Array.from(new Set(groups
      .flat()
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean)));
  }

  function summarizeForegroundSignature(foreground) {
    if (!foreground || !foreground.success) return null;
    return {
      hwnd: Number(foreground.hwnd || 0) || 0,
      title: String(foreground.title || '').trim(),
      processName: String(foreground.processName || '').trim().toLowerCase(),
      windowKind: String(foreground.windowKind || '').trim().toLowerCase(),
      isTopmost: !!foreground.isTopmost,
      isToolWindow: !!foreground.isToolWindow,
      isMinimized: !!foreground.isMinimized,
      isMaximized: !!foreground.isMaximized
    };
  }

  function didForegroundObservationChange(beforeForeground, afterForeground) {
    const before = summarizeForegroundSignature(beforeForeground);
    const after = summarizeForegroundSignature(afterForeground);
    if (!before || !after) return false;

    return before.hwnd !== after.hwnd
      || before.title !== after.title
      || before.processName !== after.processName
      || before.windowKind !== after.windowKind
      || before.isTopmost !== after.isTopmost
      || before.isToolWindow !== after.isToolWindow
      || before.isMinimized !== after.isMinimized
      || before.isMaximized !== after.isMaximized;
  }

  function normalizeActionVerifyMetadata(verify) {
    if (!verify || typeof verify !== 'object') return null;

    const kind = String(verify.kind || '').trim().toLowerCase();
    if (!kind) return null;

    return {
      kind,
      appName: String(verify.appName || verify.application || '').trim() || null,
      target: String(verify.target || verify.surface || '').trim().toLowerCase() || null,
      keywords: Array.isArray(verify.keywords)
        ? verify.keywords.map((value) => String(value || '').trim()).filter(Boolean)
        : [],
      titleHints: Array.isArray(verify.titleHints)
        ? verify.titleHints.map((value) => String(value || '').trim()).filter(Boolean)
        : [],
      windowKinds: Array.isArray(verify.windowKinds)
        ? verify.windowKinds.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
        : [],
      requiresObservedChange: typeof verify.requiresObservedChange === 'boolean'
        ? verify.requiresObservedChange
        : null
    };
  }

  function classifyVerificationSurface(verify, nextAction) {
    const kind = String(verify?.kind || '').trim().toLowerCase();
    const target = String(verify?.target || '').trim().toLowerCase();

    if (kind === 'panel-visible' || kind === 'panel-open') return 'panel-open';
    if (kind === 'input-surface-open' || kind === 'menu-open' || kind === 'text-visible') return 'input-surface-open';
    if (kind === 'dialog-visible') {
      return /indicator|search|input|picker/.test(target) ? 'input-surface-open' : 'dialog-open';
    }
    if (kind === 'indicator-present' || kind === 'timeframe-updated' || kind === 'symbol-updated' || kind === 'watchlist-updated' || kind === 'chart-state-updated') {
      return 'chart-state';
    }
    if (nextAction?.type === 'type') return 'input-surface-open';
    return null;
  }

  function buildKeyObservationCheckpointFromVerifyMetadata(action, actionData, actionIndex, options = {}) {
    if (!action || action.type !== 'key') return null;

    const verify = normalizeActionVerifyMetadata(action.verify);
    if (!verify) return null;

    const actions = Array.isArray(actionData?.actions) ? actionData.actions : [];
    const nextAction = actions[actionIndex + 1] || null;
    const classification = classifyVerificationSurface(verify, nextAction);
    if (!classification) return null;

    const explicitTarget = action.verifyTarget && typeof action.verifyTarget === 'object'
      ? action.verifyTarget
      : null;
    const inferredTarget = inferLaunchVerificationTarget(actionData, options.userMessage || '');
    const appName = verify.appName || explicitTarget?.appName || inferredTarget?.appName || 'TradingView';
    const verifyTarget = explicitTarget || buildVerifyTargetHintFromAppName(appName);

    const expectedKeywords = mergeUniqueKeywords(
      verify.keywords,
      extractTradingViewObservationKeywords([
        action.reason,
        actionData?.thought,
        actionData?.verification,
        options.userMessage,
        nextAction?.reason,
        nextAction?.text,
        verify.target
      ].filter(Boolean).join(' ')),
      classification === 'dialog-open' ? verifyTarget.dialogKeywords : [],
      classification === 'panel-open' ? verifyTarget.pineKeywords : [],
      classification === 'chart-state' ? verifyTarget.chartKeywords : [],
      /indicator/.test(verify.target || '') ? verifyTarget.indicatorKeywords : []
    );

    const expectedWindowKinds = verify.windowKinds.length > 0
      ? verify.windowKinds
      : (classification === 'chart-state' || classification === 'panel-open')
        ? (verifyTarget.preferredWindowKinds || ['main'])
        : (verifyTarget.dialogWindowKinds || ['owned', 'palette', 'main']);

    return {
      applicable: true,
      key: String(action.key || '').trim().toLowerCase(),
      classification,
      appName,
      tradingModeHint: inferTradingViewTradingMode({
        textSignals: [
          action.reason,
          actionData?.thought,
          actionData?.verification,
          options.userMessage,
          verify.target,
          ...verify.keywords
        ].filter(Boolean).join(' '),
        keywords: expectedKeywords
      }),
      requiresObservedChange: verify.requiresObservedChange === null
        ? (classification === 'dialog-open' || classification === 'input-surface-open')
        : verify.requiresObservedChange,
      allowWindowHandleChange: classification === 'dialog-open' || classification === 'input-surface-open',
      timeoutMs: keyCheckpointTimeoutMs,
      verifyTarget: {
        ...verifyTarget,
        popupKeywords: mergeUniqueKeywords(verifyTarget.popupKeywords, expectedKeywords),
        titleHints: Array.from(new Set([
          ...(verifyTarget.titleHints || []),
          ...(verifyTarget.dialogTitleHints || []),
          ...verify.titleHints
        ]))
      },
      expectedKeywords,
      expectedWindowKinds,
      reason: action.reason || actionData?.verification || actionData?.thought || ''
    };
  }

  function inferKeyObservationCheckpoint(action, actionData, actionIndex, options = {}) {
    const explicitSpec = buildKeyObservationCheckpointFromVerifyMetadata(action, actionData, actionIndex, options);
    if (explicitSpec) return explicitSpec;

    if (!action || action.type !== 'key') return null;

    const key = String(action.key || '').trim().toLowerCase();
    if (!key || (!key.includes('alt') && !/(^|\+)enter$|^enter$|^return$/i.test(key))) {
      return null;
    }

    const actions = Array.isArray(actionData?.actions) ? actionData.actions : [];
    const nextAction = actions[actionIndex + 1] || null;
    const verifyTarget = action.verifyTarget && typeof action.verifyTarget === 'object'
      ? action.verifyTarget
      : null;
    const inferredTarget = verifyTarget || inferLaunchVerificationTarget(actionData, options.userMessage || '');
    const likelyTradingView = isTradingViewTargetHint(inferredTarget)
      || /tradingview|trading\s+view/i.test(String(options.focusRecoveryTarget?.title || ''))
      || /tradingview/i.test(String(options.focusRecoveryTarget?.processName || ''))
      || /tradingview|trading\s+view/i.test(String(options.userMessage || ''))
      || /tradingview|trading\s+view/i.test(String(actionData?.thought || ''))
      || /tradingview|trading\s+view/i.test(String(actionData?.verification || ''));

    if (!likelyTradingView) return null;

    const textSignals = [
      action.reason,
      actionData?.thought,
      actionData?.verification,
      options.userMessage,
      nextAction?.reason,
      nextAction?.text
    ].filter(Boolean).join(' ');
    const tradingViewSpec = inferTradingViewObservationSpec({ textSignals, nextAction });
    if (!tradingViewSpec) {
      return null;
    }

    return {
      applicable: true,
      key,
      classification: tradingViewSpec.classification,
      appName: 'TradingView',
      tradingModeHint: tradingViewSpec.tradingModeHint,
      requiresObservedChange: tradingViewSpec.requiresObservedChange,
      allowWindowHandleChange: tradingViewSpec.allowWindowHandleChange,
      timeoutMs: keyCheckpointTimeoutMs,
      verifyTarget: tradingViewSpec.verifyTarget,
      expectedKeywords: tradingViewSpec.expectedKeywords,
      expectedWindowKinds: tradingViewSpec.expectedWindowKinds,
      reason: action.reason || actionData?.verification || actionData?.thought || ''
    };
  }

  async function verifyKeyObservationCheckpoint(spec, beforeForeground, options = {}) {
    if (!spec?.applicable) {
      return { applicable: false, verified: true, classification: null };
    }

    const watcher = getUIWatcher();
    const expectedWindowHandle = Number(options.expectedWindowHandle || 0) || 0;
    const waitTargetHwnd = spec.allowWindowHandleChange ? 0 : expectedWindowHandle;
    let watcherFreshness = null;
    let foreground = null;
    let evalResult = { matched: false, matchReason: 'none', needsFollowUp: false, popupHint: null };
    let observedChange = false;
    let keywordMatched = false;
    let windowKindMatched = false;
    let titleHintMatched = false;
    let tradingMode = spec.tradingModeHint || { mode: 'unknown', confidence: 'low', evidence: [] };

    for (let attempt = 1; attempt <= keyCheckpointMaxPolls; attempt++) {
      const sinceTs = Number(watcher?.cache?.lastUpdate || 0);
      await sleepMs(keyCheckpointSettleMs + ((attempt - 1) * 120));

      if (watcher && watcher.isPolling && typeof watcher.waitForFreshState === 'function') {
        watcherFreshness = await watcher.waitForFreshState({
          targetHwnd: waitTargetHwnd,
          sinceTs,
          timeoutMs: spec.timeoutMs || keyCheckpointTimeoutMs
        });
      }

      foreground = await systemAutomation.getForegroundWindowInfo();
      evalResult = evaluateForegroundAgainstTarget(foreground, spec.verifyTarget || {});
      observedChange = didForegroundObservationChange(beforeForeground, foreground);

      const titleNorm = normalizeTextForMatch(foreground?.title || '');
      keywordMatched = (spec.expectedKeywords || []).some((keyword) => {
        const norm = normalizeTextForMatch(keyword);
        return norm && titleNorm.includes(norm);
      });
      windowKindMatched = !(spec.expectedWindowKinds || []).length
        || (spec.expectedWindowKinds || []).includes(String(foreground?.windowKind || '').trim().toLowerCase());
      titleHintMatched = (spec.verifyTarget?.dialogTitleHints || []).some((hint) => {
        const norm = normalizeTextForMatch(hint);
        return norm && titleNorm.includes(norm);
      });
      tradingMode = inferTradingViewTradingMode({
        title: foreground?.title,
        textSignals: [
          spec.reason,
          spec.classification,
          spec.appName,
          spec.popupHint,
          ...(spec.expectedKeywords || []),
          ...(spec.tradingModeHint?.evidence || [])
        ].filter(Boolean).join(' '),
        keywords: spec.expectedKeywords,
        popupHint: evalResult.popupHint || null
      });

      const freshObservation = !!watcherFreshness?.fresh;
      const surfaceChangeObserved = observedChange || keywordMatched || titleHintMatched;
      const verified = spec.requiresObservedChange
        ? !!(foreground?.success && evalResult.matched && windowKindMatched && surfaceChangeObserved)
        : !!(foreground?.success && evalResult.matched && windowKindMatched && (surfaceChangeObserved || freshObservation || !spec.requiresObservedChange));

      if (verified) {
        return {
          applicable: true,
          verified: true,
          classification: spec.classification,
          attempts: attempt,
          observedChange,
          freshObservation,
          keywordMatched,
          titleHintMatched,
          windowKindMatched,
          tradingMode,
          beforeForeground: beforeForeground || null,
          foreground,
          expectedWindowHandle,
          waitTargetHwnd,
          matchReason: evalResult.matchReason,
          popupHint: evalResult.popupHint || null,
          reason: spec.reason || ''
        };
      }
    }

    return {
      applicable: true,
      verified: false,
      classification: spec.classification,
      attempts: keyCheckpointMaxPolls,
      observedChange,
      freshObservation: !!watcherFreshness?.fresh,
      keywordMatched,
      titleHintMatched,
      windowKindMatched,
      tradingMode,
      beforeForeground: beforeForeground || null,
      foreground,
      expectedWindowHandle,
      waitTargetHwnd,
      matchReason: evalResult.matchReason,
      popupHint: evalResult.popupHint || null,
      reason: spec.reason || '',
      error: spec.requiresObservedChange
        ? 'Post-key observation checkpoint could not confirm a TradingView surface change before continuing'
        : 'Post-key observation checkpoint could not confirm fresh TradingView state'
    };
  }

  return {
    inferKeyObservationCheckpoint,
    verifyKeyObservationCheckpoint
  };
}

module.exports = {
  createObservationCheckpointRuntime
};