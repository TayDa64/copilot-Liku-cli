function createObservationCheckpointRuntime(deps = {}) {
  const {
    systemAutomation,
    getUIWatcher,
    sleepMs,
    evaluateForegroundAgainstTarget,
    inferLaunchVerificationTarget,
    observationProviders = [],
    keyCheckpointSettleMs = 240,
    keyCheckpointTimeoutMs = 1400,
    keyCheckpointMaxPolls = 2
  } = deps;

  const providers = Array.isArray(observationProviders)
    ? observationProviders
      .map((entry) => entry?.provider || entry)
      .filter((provider) => provider && typeof provider === 'object')
    : [];

  const tradingViewProvider = providers.find((provider) => String(provider.toolName || '').trim().toLowerCase() === 'tradingview') || null;

  function requireTradingViewProvider(methodName) {
    const method = tradingViewProvider?.[methodName];
    if (typeof method !== 'function') {
      throw new Error(`createObservationCheckpointRuntime requires TradingView observation provider method ${methodName}`);
    }
    return method;
  }

  const buildVerifyTargetHintFromAppName = requireTradingViewProvider('buildVerifyTargetHint');
  const extractTradingViewObservationKeywords = requireTradingViewProvider('extractObservationKeywords');
  const inferTradingViewTradingMode = requireTradingViewProvider('inferTradingMode');
  const inferTradingViewObservationSpec = requireTradingViewProvider('inferObservationSpec');
  const isTradingViewTargetHint = requireTradingViewProvider('isTargetHint');

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

  const PINE_EDITOR_WATCHER_SURFACE_ANCHORS = Object.freeze([
    'untitled script',
    'my script',
    'my strategy',
    'my library',
    'add to chart',
    'publish script',
    'update on chart',
    'script saved',
    'all changes saved',
    'save script',
    'script name',
    'save as',
    'rename script'
  ]);
  const QUICK_SEARCH_WATCHER_SURFACE_ANCHORS = Object.freeze([
    'search tool or function',
    'quick search',
    'symbol search',
    'search symbols',
    'nothing matches your criteria'
  ]);
  const TRADINGVIEW_DOMAIN_VERIFICATION_KINDS = new Set([
    'indicator-present',
    'timeframe-updated',
    'symbol-updated',
    'watchlist-updated',
    'chart-state-updated'
  ]);

  function isTradingViewDomainVerificationKind(kind = '') {
    const normalized = String(kind || '').trim().toLowerCase();
    return TRADINGVIEW_DOMAIN_VERIFICATION_KINDS.has(normalized);
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

  function normalizeWatcherForeground(activeWindow = null, source = 'watcher-cache') {
    if (!activeWindow || typeof activeWindow !== 'object') {
      return null;
    }

    return {
      success: true,
      hwnd: Number(activeWindow.hwnd || 0) || 0,
      pid: Number(activeWindow.pid || activeWindow.processId || 0) || 0,
      processName: String(activeWindow.processName || ''),
      title: String(activeWindow.title || ''),
      ownerHwnd: Number(activeWindow.ownerHwnd || 0) || 0,
      isTopmost: activeWindow.isTopmost === true,
      isToolWindow: activeWindow.isToolWindow === true,
      isMinimized: activeWindow.isMinimized === true,
      isMaximized: activeWindow.isMaximized === true,
      windowKind: String(activeWindow.windowKind || 'main'),
      bounds: activeWindow.bounds || null,
      source
    };
  }

  function getWatcherForegroundState(watcher, expectedWindowHandle = 0) {
    if (!watcher?.cache?.activeWindow) {
      return {
        available: false,
        fresh: false,
        ageMs: Number.POSITIVE_INFINITY,
        lastUpdate: 0,
        foreground: null,
        matchesExpectedWindow: expectedWindowHandle <= 0
      };
    }

    const lastUpdate = Number(watcher.cache.lastUpdate || 0) || 0;
    const ageMs = lastUpdate > 0 ? Math.max(0, Date.now() - lastUpdate) : Number.POSITIVE_INFINITY;
    const maxAgeMs = Math.max(600, Math.min(2200, Math.round((keyCheckpointTimeoutMs || 1400) * 0.75)));
    const foreground = normalizeWatcherForeground(watcher.cache.activeWindow, 'watcher-cache');
    const foregroundHwnd = Number(foreground?.hwnd || 0) || 0;

    return {
      available: true,
      fresh: ageMs <= maxAgeMs,
      ageMs,
      lastUpdate,
      foreground,
      matchesExpectedWindow: expectedWindowHandle <= 0 || !foregroundHwnd || foregroundHwnd === expectedWindowHandle
    };
  }

  async function waitForWatcherForegroundState(watcher, expectedWindowHandle = 0, sinceTs = 0, timeoutMs = 0) {
    if (!watcher || typeof watcher.waitForFreshState !== 'function') {
      return null;
    }

    const freshState = await watcher.waitForFreshState({
      targetHwnd: expectedWindowHandle > 0 ? expectedWindowHandle : 0,
      sinceTs: Number(sinceTs || 0) || 0,
      timeoutMs: Math.max(120, Number(timeoutMs || keyCheckpointTimeoutMs || 1400) || 1400)
    });

    return {
      fresh: freshState?.fresh === true,
      timedOut: freshState?.timedOut === true,
      immediate: freshState?.immediate === true,
      lastUpdate: Number(freshState?.lastUpdate || 0) || 0,
      foreground: normalizeWatcherForeground(
        freshState?.activeWindow || watcher.cache?.activeWindow || null,
        freshState?.fresh === true ? 'watcher-event' : 'watcher-timeout'
      )
    };
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
      pineSurfaceExpectation: String(verify.pineSurfaceExpectation || '').trim().toLowerCase() || null,
      requiresObservedChange: typeof verify.requiresObservedChange === 'boolean'
        ? verify.requiresObservedChange
        : null
    };
  }

  function classifyVerificationSurface(verify, nextAction) {
    const kind = String(verify?.kind || '').trim().toLowerCase();
    const target = String(verify?.target || '').trim().toLowerCase();
    const keywordText = Array.isArray(verify?.keywords)
      ? verify.keywords.map((value) => String(value || '').trim().toLowerCase()).join(' ')
      : '';

    if (kind === 'panel-visible' || kind === 'panel-open') return 'panel-open';
    if (kind === 'editor-active' || kind === 'editor-ready') return 'editor-active';
    if (kind === 'status-visible' || kind === 'status-ready') {
      return /save|rename|name|input|picker|search|dialog/.test(`${target} ${keywordText}`.trim())
        ? 'input-surface-open'
        : 'panel-open';
    }
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
    const actionType = String(action?.type || '').trim().toLowerCase();
    if (!['key', 'click_element', 'click', 'double_click', 'right_click'].includes(actionType)) return null;

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
    const verifyTargetHint = explicitTarget || buildVerifyTargetHintFromAppName(appName);

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
      classification === 'dialog-open' ? verifyTargetHint.dialogKeywords : [],
      (classification === 'panel-open' || classification === 'editor-active') ? verifyTargetHint.pineKeywords : [],
      classification === 'chart-state' ? verifyTargetHint.chartKeywords : [],
      /indicator/.test(verify.target || '') ? verifyTargetHint.indicatorKeywords : []
    );

    const expectedWindowKinds = verify.windowKinds.length > 0
      ? verify.windowKinds
      : (classification === 'chart-state' || classification === 'panel-open' || classification === 'editor-active')
        ? (verifyTargetHint.preferredWindowKinds || ['main'])
        : (verifyTargetHint.dialogWindowKinds || ['owned', 'palette', 'main']);

    return {
      applicable: true,
      key: String(action.key || '').trim().toLowerCase(),
      actionType,
      classification,
      appName,
      verifyKind: verify.kind,
      verifyTarget: verify.target,
      domainProofEligible: isTradingViewDomainVerificationKind(verify.kind),
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
      pineSurfaceExpectation: verify.pineSurfaceExpectation || null,
      requiresObservedChange: verify.requiresObservedChange === null
        ? (classification === 'dialog-open' || classification === 'input-surface-open' || classification === 'editor-active')
        : verify.requiresObservedChange,
      allowWindowHandleChange: classification === 'dialog-open' || classification === 'input-surface-open',
      timeoutMs: keyCheckpointTimeoutMs,
      verifyTargetHint: {
        ...verifyTargetHint,
        popupKeywords: mergeUniqueKeywords(verifyTargetHint.popupKeywords, expectedKeywords),
        titleHints: Array.from(new Set([
          ...(verifyTargetHint.titleHints || []),
          ...(verifyTargetHint.dialogTitleHints || []),
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
      verifyKind: null,
      verifyTarget: null,
      verifyTargetHint: tradingViewSpec.verifyTarget,
      domainProofEligible: false,
      tradingModeHint: tradingViewSpec.tradingModeHint,
      requiresObservedChange: tradingViewSpec.requiresObservedChange,
      allowWindowHandleChange: tradingViewSpec.allowWindowHandleChange,
      timeoutMs: keyCheckpointTimeoutMs,
      expectedKeywords: tradingViewSpec.expectedKeywords,
      expectedWindowKinds: tradingViewSpec.expectedWindowKinds,
      reason: action.reason || actionData?.verification || actionData?.thought || ''
    };
  }

  function hasExplicitPineCheckpointSignal(spec = {}) {
    const signalText = normalizeTextForMatch([
      spec?.verifyTarget,
      spec?.verifyKind,
      spec?.reason,
      spec?.pineSurfaceExpectation
    ].filter(Boolean).join(' '));
    if (/\bpine\b/.test(signalText)) {
      return true;
    }

    return /\b(add to chart|publish script|pine logs|profiler|version history|untitled script|my script|my strategy|my library)\b/.test(signalText);
  }

  function isPineEditorSurfaceCheckpoint(spec = {}) {
    const verifyTarget = String(spec?.verifyTarget || '').trim().toLowerCase();
    const verifyKind = String(spec?.verifyKind || '').trim().toLowerCase();
    const classification = String(spec?.classification || '').trim().toLowerCase();
    const targetsPineEditor = verifyTarget === 'pine-editor'
      || hasExplicitPineCheckpointSignal(spec);
    if (!targetsPineEditor) return false;
    if (classification === 'editor-active') return true;
    return verifyKind === 'status-visible' || verifyKind === 'status-ready';
  }

  function getWatcherTextEvidenceMatch(watcher, spec, foreground) {
    if (!watcher || !watcher.cache || !Array.isArray(watcher.cache.elements)) {
      return { matched: false, anchor: null, element: null };
    }

    const expectedKeywords = Array.isArray(spec?.expectedKeywords)
      ? spec.expectedKeywords.map((value) => normalizeTextForMatch(value)).filter(Boolean)
      : [];
    const pineEditorLike = isPineEditorSurfaceCheckpoint(spec);
    const quickSearchLike = spec?.classification === 'input-surface-open'
      && (
        /quick-search|symbol-search/.test(String(spec?.verifyTarget || '').trim().toLowerCase())
        || expectedKeywords.some((value) => value.includes('quick search') || value.includes('symbol search'))
      );

    const anchors = Array.from(new Set([
      ...(pineEditorLike ? PINE_EDITOR_WATCHER_SURFACE_ANCHORS : []),
      ...(quickSearchLike ? QUICK_SEARCH_WATCHER_SURFACE_ANCHORS : [])
    ]));
    if (!anchors.length) {
      return { matched: false, anchor: null, element: null };
    }

    const activeHwnd = Number(foreground?.hwnd || watcher.cache.activeWindow?.hwnd || 0) || 0;
    const scopedElements = activeHwnd > 0
      ? watcher.cache.elements.filter((element) => Number(element?.windowHandle || 0) === activeHwnd)
      : watcher.cache.elements.slice();

    for (const element of scopedElements) {
      const haystack = normalizeTextForMatch([
        element?.name,
        element?.automationId,
        element?.className,
        element?.type
      ].filter(Boolean).join(' '));
      if (!haystack) continue;

      for (const anchor of anchors) {
        const normalizedAnchor = normalizeTextForMatch(anchor);
        if (normalizedAnchor && haystack.includes(normalizedAnchor)) {
          return {
            matched: true,
            anchor,
            element
          };
        }
      }
    }

    return { matched: false, anchor: null, element: null };
  }

  function isPineEditorLikeCheckpoint(spec = {}) {
    if (isPineEditorSurfaceCheckpoint(spec)) {
      return true;
    }
    return String(spec?.classification || '').trim().toLowerCase() === 'panel-open'
      && hasExplicitPineCheckpointSignal(spec);
  }

  function summarizePineSurfaceExpectationEvidence({ probe = null, anchor = null, element = null } = {}) {
    const rawEntries = Array.isArray(probe?.visibleAnchorEntries) && probe.visibleAnchorEntries.length > 0
      ? probe.visibleAnchorEntries
      : (Array.isArray(probe?.rendererProof?.signals) && probe.rendererProof.signals.length > 0
        ? probe.rendererProof.signals
        : anchor
          ? [{
              text: anchor,
              observedText: [
                anchor,
                element?.name,
                element?.automationId,
                element?.className,
                element?.type
              ].filter(Boolean).join(' '),
              category: null
            }]
          : []);

    const summary = {
      starterVisible: false,
      saveRequiredVisible: false,
      renameSurfaceVisible: false,
      saveConfirmedVisible: false,
      actionableSurfaceVisible: false
    };

    for (const entry of rawEntries) {
      const observedText = normalizeTextForMatch([
        entry?.text || '',
        entry?.observedText || '',
        entry?.ariaLabel || ''
      ].filter(Boolean).join(' '));
      const category = normalizeTextForMatch(entry?.category || '');

      if (
        category === 'starter'
        || /^(untitled script|untitled|my script|my strategy|my library)$/.test(observedText)
        || /\b(untitled script|my script|my strategy|my library)\b/.test(observedText)
      ) {
        summary.starterVisible = true;
      }

      if (category === 'rename surface' || category === 'rename-surface') {
        summary.renameSurfaceVisible = true;
        summary.saveRequiredVisible = true;
      }

      if (
        category === 'save required'
        || category === 'save-required'
        || /\b(save script|new script name|script name|save as|rename script|unsaved)\b/.test(observedText)
      ) {
        summary.saveRequiredVisible = true;
      }

      if (
        category === 'save confirmed'
        || category === 'save-confirmed'
        || /\b(all changes saved|saved successfully|save complete)\b/.test(observedText)
      ) {
        summary.saveConfirmedVisible = true;
      }

      if (
        category === 'surface'
        && /\b(add to chart|update on chart|publish script|pine logs|strategy tester)\b/.test(observedText)
      ) {
        summary.actionableSurfaceVisible = true;
      }
    }

    return {
      ...summary,
      freshScriptVisible: summary.starterVisible || summary.saveRequiredVisible || summary.renameSurfaceVisible,
      genericSavedSurfaceOnly: summary.saveConfirmedVisible
        && !summary.starterVisible
        && !summary.saveRequiredVisible
        && !summary.renameSurfaceVisible
    };
  }

  function matchesPineSurfaceExpectation(spec = {}, evidence = {}) {
    const expectation = String(spec?.pineSurfaceExpectation || '').trim().toLowerCase();
    if (!expectation) return true;
    if (expectation === 'fresh-script') {
      return evidence.freshScriptVisible === true;
    }
    return true;
  }

  function shouldAttemptPineEditorHostSurfaceProbe(spec, foreground, watcherState, watcherFreshness, watcherSurfaceMatched, observedChange) {
    if (!isPineEditorLikeCheckpoint(spec)) {
      return { attempt: false, reason: 'not-pine-editor-checkpoint' };
    }

    const freshScriptExpectation = String(spec?.pineSurfaceExpectation || '').trim().toLowerCase() === 'fresh-script';

    if (watcherSurfaceMatched && !freshScriptExpectation) {
      return { attempt: false, reason: 'watcher-surface-matched' };
    }

    if (!foreground?.success) {
      return { attempt: true, reason: 'foreground-unavailable' };
    }

    const processName = normalizeTextForMatch(foreground?.processName || '');
    if (!processName.includes('tradingview')) {
      return { attempt: false, reason: 'foreground-not-tradingview' };
    }

    if (!watcherState?.available) {
      return { attempt: true, reason: 'watcher-unavailable' };
    }

    if (watcherFreshness?.timedOut === true) {
      return { attempt: true, reason: 'watcher-timeout' };
    }

    if (watcherState?.matchesExpectedWindow === false) {
      return { attempt: true, reason: 'watcher-window-mismatch' };
    }

    if (watcherFreshness?.fresh === true) {
      return { attempt: true, reason: 'watcher-delta' };
    }

    if (observedChange) {
      return { attempt: true, reason: 'foreground-change' };
    }

    if (watcherState?.fresh !== true) {
      return { attempt: true, reason: 'watcher-stale' };
    }

    if (freshScriptExpectation) {
      return { attempt: true, reason: 'fresh-script-required' };
    }

    return { attempt: false, reason: 'watcher-stable-no-delta' };
  }

  async function getPineEditorHostSurfaceEvidence(spec, foreground, expectedWindowHandle, options = {}) {
    if (!isPineEditorLikeCheckpoint(spec)) {
      return { matched: false, anchor: null, probe: null };
    }
    if (!foreground?.success) {
      return { matched: false, anchor: null, probe: null };
    }
    if (typeof systemAutomation?.probeTradingViewPineEditorSurface !== 'function') {
      return { matched: false, anchor: null, probe: null };
    }

    const processName = normalizeTextForMatch(foreground?.processName || '');
    if (!processName.includes('tradingview')) {
      return { matched: false, anchor: null, probe: null };
    }

    try {
      const timeoutMs = Math.max(
        250,
        Math.min(900, Math.round((Number(spec?.timeoutMs || keyCheckpointTimeoutMs) || keyCheckpointTimeoutMs) * 0.45))
      );
      const preferredWindowHandle = spec?.allowWindowHandleChange
        ? Number(foreground?.hwnd || expectedWindowHandle || 0) || 0
        : Number(expectedWindowHandle || foreground?.hwnd || 0) || 0;
      const probe = await systemAutomation.probeTradingViewPineEditorSurface({
        windowHandle: preferredWindowHandle,
        timeout: timeoutMs,
        foreground,
        windowInfo: options?.windowInfo || foreground,
        resolveWindowState: false
      });
      const anchorSource = probe?.anchorText
        || (Array.isArray(probe?.visibleAnchors) ? probe.visibleAnchors[0] : null);
      const anchor = anchorSource ? String(anchorSource).trim() || null : null;
      return {
        matched: probe?.active === true,
        anchor,
        probe: probe || null
      };
    } catch {
      return { matched: false, anchor: null, probe: null };
    }
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
    let watcherSurfaceMatched = false;
    let watcherSurfaceAnchor = null;
    let watcherSurfaceElement = null;
    let hostSurfaceMatched = false;
    let hostSurfaceAnchor = null;
    let pineEditorSurfaceProbe = null;
    let pineSurfaceExpectationEvidence = summarizePineSurfaceExpectationEvidence();
    let pineSurfaceExpectationMatched = false;
    let hostSurfaceProbeDecision = { attempt: false, reason: 'not-evaluated' };
    let tradingMode = spec.tradingModeHint || { mode: 'unknown', confidence: 'low', evidence: [] };
    let cachedHostSurfaceProbeKey = null;
    let cachedHostSurfaceEvidence = { matched: false, anchor: null, probe: null };

    for (let attempt = 1; attempt <= keyCheckpointMaxPolls; attempt++) {
      const sinceTs = Number(watcher?.cache?.lastUpdate || 0);
      await sleepMs(keyCheckpointSettleMs + ((attempt - 1) * 120));

      if (watcher && watcher.isPolling) {
        watcherFreshness = await waitForWatcherForegroundState(
          watcher,
          waitTargetHwnd,
          sinceTs,
          spec.timeoutMs || keyCheckpointTimeoutMs
        );
      }

      const watcherState = getWatcherForegroundState(watcher, waitTargetHwnd);
      const watcherForeground = watcherFreshness?.foreground?.success
        ? watcherFreshness.foreground
        : watcherState?.foreground;
      const shouldUseWatcherForeground = !!(
        watcherForeground?.success
        && watcherState?.matchesExpectedWindow !== false
        && (
          watcherFreshness?.fresh === true
          || watcherState?.fresh === true
        )
      );

      if (shouldUseWatcherForeground) {
        foreground = watcherForeground;
      } else {
        foreground = await systemAutomation.getForegroundWindowInfo();
      }
      evalResult = evaluateForegroundAgainstTarget(foreground, spec.verifyTargetHint || {});
      observedChange = didForegroundObservationChange(beforeForeground, foreground);

      const titleNorm = normalizeTextForMatch(foreground?.title || '');
      keywordMatched = (spec.expectedKeywords || []).some((keyword) => {
        const norm = normalizeTextForMatch(keyword);
        return norm && titleNorm.includes(norm);
      });
      windowKindMatched = !(spec.expectedWindowKinds || []).length
        || (spec.expectedWindowKinds || []).includes(String(foreground?.windowKind || '').trim().toLowerCase());
      titleHintMatched = (spec.verifyTargetHint?.dialogTitleHints || []).some((hint) => {
        const norm = normalizeTextForMatch(hint);
        return norm && titleNorm.includes(norm);
      });
      const watcherEvidence = getWatcherTextEvidenceMatch(watcher, spec, foreground);
      watcherSurfaceMatched = !!watcherEvidence.matched;
      watcherSurfaceAnchor = watcherEvidence.anchor || null;
      watcherSurfaceElement = watcherEvidence.element || null;
      hostSurfaceProbeDecision = shouldAttemptPineEditorHostSurfaceProbe(
        spec,
        foreground,
        watcherState,
        watcherFreshness,
        watcherSurfaceMatched,
        observedChange
      );
      if (hostSurfaceProbeDecision.attempt) {
        const hostSurfaceProbeKey = [
          Number(expectedWindowHandle || foreground?.hwnd || 0) || 0,
          Number(watcherFreshness?.lastUpdate || watcherState?.lastUpdate || 0) || 0,
          Number(foreground?.hwnd || 0) || 0,
          normalizeTextForMatch(foreground?.title || ''),
          hostSurfaceProbeDecision.reason
        ].join('|');
        if (hostSurfaceProbeKey !== cachedHostSurfaceProbeKey) {
          cachedHostSurfaceEvidence = await getPineEditorHostSurfaceEvidence(spec, foreground, expectedWindowHandle, {
            windowInfo: foreground,
            reason: hostSurfaceProbeDecision.reason
          });
          cachedHostSurfaceProbeKey = hostSurfaceProbeKey;
        }
      } else {
        cachedHostSurfaceEvidence = { matched: false, anchor: null, probe: null };
      }
      hostSurfaceMatched = !!cachedHostSurfaceEvidence.matched;
      hostSurfaceAnchor = cachedHostSurfaceEvidence.anchor || null;
      pineEditorSurfaceProbe = cachedHostSurfaceEvidence.probe || null;
      pineSurfaceExpectationEvidence = summarizePineSurfaceExpectationEvidence({
        probe: pineEditorSurfaceProbe,
        anchor: watcherSurfaceAnchor,
        element: watcherSurfaceElement
      });
      pineSurfaceExpectationMatched = matchesPineSurfaceExpectation(spec, pineSurfaceExpectationEvidence);
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
      const surfaceEvidenceMatched = keywordMatched || titleHintMatched || watcherSurfaceMatched || hostSurfaceMatched;
      const surfaceChangeObserved = observedChange || surfaceEvidenceMatched;
      const strongForegroundMatch = ['hwnd-exact', 'title', 'title-regex'].includes(
        String(evalResult.matchReason || '').trim().toLowerCase()
      );
      const strictChartStateMatched = spec.classification === 'chart-state'
        && ['symbol-updated', 'timeframe-updated', 'watchlist-updated'].includes(String(spec.verifyKind || '').trim().toLowerCase())
        ? !!(
          foreground?.success
          && evalResult.matched
          && windowKindMatched
          && keywordMatched
          && (observedChange || watcherSurfaceMatched)
        )
        : false;
      const strictFreshPineSurfaceMatched = spec.classification === 'editor-active'
        && String(spec.pineSurfaceExpectation || '').trim().toLowerCase() === 'fresh-script'
        ? !!(
          foreground?.success
          && windowKindMatched
          && pineSurfaceExpectationMatched
        )
        : false;
      const editorActiveMatched = spec.classification === 'editor-active'
        ? (String(spec.pineSurfaceExpectation || '').trim().toLowerCase() === 'fresh-script'
          ? strictFreshPineSurfaceMatched
          : !!(
            foreground?.success
            && windowKindMatched
            && (
              hostSurfaceMatched
              || watcherSurfaceMatched
              || (
                evalResult.matched
                && surfaceChangeObserved
                && (keywordMatched || titleHintMatched || (freshObservation && strongForegroundMatch))
              )
            )
          ))
        : false;
      const verified = spec.requiresObservedChange
        ? (spec.classification === 'editor-active'
          ? editorActiveMatched
          : (strictChartStateMatched
            || !!(foreground?.success && evalResult.matched && windowKindMatched && surfaceChangeObserved)))
        : (spec.classification === 'chart-state'
          ? !!(foreground?.success && evalResult.matched && windowKindMatched)
          : !!(foreground?.success && evalResult.matched && windowKindMatched && surfaceEvidenceMatched));

      if (verified) {
        return {
          applicable: true,
          verified: true,
          classification: spec.classification,
          appName: spec.appName || null,
          verifyKind: spec.verifyKind || null,
          verifyTarget: spec.verifyTarget || null,
          pineSurfaceExpectation: spec.pineSurfaceExpectation || null,
          domainProofEligible: spec.domainProofEligible === true,
          attempts: attempt,
          observedChange,
          freshObservation,
          keywordMatched,
          titleHintMatched,
          windowKindMatched,
          editorActiveMatched,
          hostSurfaceMatched,
          hostSurfaceAnchor,
          watcherSurfaceMatched,
          watcherSurfaceAnchor,
          watcherSurfaceElement,
          pineSurfaceExpectationMatched,
          pineSurfaceExpectationEvidence,
          pineEditorSurfaceProbe,
          hostSurfaceProbeDecision,
          tradingMode,
          beforeForeground: beforeForeground || null,
          foreground,
          expectedWindowHandle,
          waitTargetHwnd,
          matchReason: hostSurfaceMatched ? 'pine-editor-surface-probe' : evalResult.matchReason,
          popupHint: evalResult.popupHint || null,
          reason: spec.reason || ''
        };
      }
    }

    return {
      applicable: true,
      verified: false,
      classification: spec.classification,
      appName: spec.appName || null,
      verifyKind: spec.verifyKind || null,
      verifyTarget: spec.verifyTarget || null,
      pineSurfaceExpectation: spec.pineSurfaceExpectation || null,
      domainProofEligible: spec.domainProofEligible === true,
      attempts: keyCheckpointMaxPolls,
      observedChange,
      freshObservation: !!watcherFreshness?.fresh,
      keywordMatched,
      titleHintMatched,
      windowKindMatched,
      editorActiveMatched: false,
      hostSurfaceMatched,
      hostSurfaceAnchor,
      watcherSurfaceMatched,
      watcherSurfaceAnchor,
      watcherSurfaceElement,
      pineSurfaceExpectationMatched,
      pineSurfaceExpectationEvidence,
      pineEditorSurfaceProbe,
      hostSurfaceProbeDecision,
      tradingMode,
      beforeForeground: beforeForeground || null,
      foreground,
      expectedWindowHandle,
      waitTargetHwnd,
      matchReason: evalResult.matchReason,
      popupHint: evalResult.popupHint || null,
      reason: spec.reason || '',
      error: spec.requiresObservedChange
        ? (spec.classification === 'editor-active'
          ? (String(spec.pineSurfaceExpectation || '').trim().toLowerCase() === 'fresh-script'
            ? 'Post-key observation checkpoint could not confirm a fresh Pine starter surface before continuing'
            : 'Post-key observation checkpoint could not confirm an active Pine Editor surface before continuing')
          : 'Post-key observation checkpoint could not confirm a TradingView surface change before continuing')
        : 'Post-key observation checkpoint could not confirm the expected TradingView surface before continuing'
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
