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

  const PINE_EDITOR_WATCHER_SURFACE_ANCHORS = Object.freeze([
    'add to chart',
    'publish script',
    'update on chart',
    'script saved'
  ]);
  const PINE_EDITOR_TEXT_PROBE_STRONG_TERMS = Object.freeze([
    'pine editor',
    'add to chart',
    'publish script',
    'update on chart',
    'strategy tester',
    'pine logs',
    'save script',
    'script name',
    'save as',
    'rename script',
    'all changes saved',
    'saved successfully',
    'save complete',
    'unsaved'
  ]);
  const PINE_EDITOR_TEXT_PROBE_WEAK_TERMS = Object.freeze([
    'untitled script',
    'my script',
    'my strategy',
    'my library'
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

    const routeId = String(
      action?.searchSurfaceContract?.id
      || action?.tradingViewShortcut?.id
      || ''
    ).trim().toLowerCase();
    const route = String(action?.searchSurfaceContract?.route || '').trim().toLowerCase();
    const preferRecoveryOverTextProbe = classification === 'editor-active'
      && verify.target === 'pine-editor'
      && routeId === 'open-pine-editor'
      && (String(action?.key || '').trim().toLowerCase() === 'enter' || route === 'official-direct');

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
      requiresObservedChange: verify.requiresObservedChange === null
        ? (classification === 'dialog-open' || classification === 'input-surface-open' || classification === 'editor-active')
        : verify.requiresObservedChange,
      allowWindowHandleChange: classification === 'dialog-open' || classification === 'input-surface-open',
      timeoutMs: keyCheckpointTimeoutMs,
      routeId: routeId || null,
      route: route || null,
      preferRecoveryOverTextProbe,
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

  function getWatcherTextEvidenceMatch(watcher, spec, foreground) {
    if (!watcher || !watcher.cache || !Array.isArray(watcher.cache.elements)) {
      return { matched: false, anchor: null, element: null };
    }

    const expectedKeywords = Array.isArray(spec?.expectedKeywords)
      ? spec.expectedKeywords.map((value) => normalizeTextForMatch(value)).filter(Boolean)
      : [];
    const pineEditorLike = spec?.classification === 'editor-active'
      && expectedKeywords.some((value) => value.includes('pine'));
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

  function summarizeElementForObservationProbe(element) {
    if (!element || typeof element !== 'object') return null;
    return {
      name: element.name || null,
      automationId: element.automationId || null,
      className: element.className || null,
      type: element.type || null,
      controlType: element.controlType || null,
      windowHandle: Number(
        element.windowHandle
        || element.WindowHandle
        || 0
      ) || null
    };
  }

  function summarizePineEditorTextProbeResult(probeResult) {
    if (!probeResult?.success) {
      return {
        matched: false,
        strongTerms: [],
        weakTerms: [],
        explicitPineMention: false,
        method: probeResult?.method || null,
        textExcerpt: null,
        element: summarizeElementForObservationProbe(probeResult?.element),
        structuredSummary: probeResult?.pineStructuredSummary || null,
        error: probeResult?.error || null
      };
    }

    const rawText = String(probeResult.text || '').trim();
    const haystack = normalizeTextForMatch(rawText);
    const strongTerms = PINE_EDITOR_TEXT_PROBE_STRONG_TERMS.filter((term) => {
      const normalized = normalizeTextForMatch(term);
      return normalized && haystack.includes(normalized);
    });
    const weakTerms = PINE_EDITOR_TEXT_PROBE_WEAK_TERMS.filter((term) => {
      const normalized = normalizeTextForMatch(term);
      return normalized && haystack.includes(normalized);
    });
    const explicitPineMention = strongTerms.includes('pine editor');
    const matched = explicitPineMention || strongTerms.length > 0 || weakTerms.length >= 2;

    return {
      matched,
      strongTerms,
      weakTerms,
      explicitPineMention,
      method: probeResult?.method || null,
      textExcerpt: rawText ? rawText.slice(0, 240) : null,
      element: summarizeElementForObservationProbe(probeResult?.element),
      structuredSummary: probeResult?.pineStructuredSummary || null,
      error: null
    };
  }

  async function probePineEditorTextEvidence(spec, foreground) {
    if (spec?.classification !== 'editor-active') {
      return { matched: false, skipped: true, reason: 'non-editor-classification' };
    }
    const foregroundProcess = normalizeTextForMatch(foreground?.processName || '');
    if (!foregroundProcess.includes('tradingview')) {
      return { matched: false, skipped: true, reason: 'non-tradingview-foreground' };
    }
    if (typeof systemAutomation?.executeAction !== 'function') {
      return { matched: false, skipped: true, reason: 'missing-system-automation-executor' };
    }

    try {
      const probeResult = await systemAutomation.executeAction({
        type: 'get_text',
        text: 'Pine Editor',
        pineEvidenceMode: 'safe-authoring-inspect',
        allowSparseOpenStateFallback: true,
        reason: 'Read bounded Pine Editor surface text for observation checkpoint verification'
      });
      return summarizePineEditorTextProbeResult(probeResult);
    } catch (error) {
      return {
        matched: false,
        strongTerms: [],
        weakTerms: [],
        explicitPineMention: false,
        method: null,
        textExcerpt: null,
        element: null,
        structuredSummary: null,
        error: error?.message || String(error || 'Pine text probe failed')
      };
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
    let pineEditorTextProbe = null;
    let pineEditorTextProbeMatched = false;
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
      const shouldDeferPineEditorTextProbe = spec.classification === 'editor-active'
        && spec.preferRecoveryOverTextProbe === true;
      pineEditorTextProbe = spec.classification === 'editor-active' && !watcherSurfaceMatched
        ? (shouldDeferPineEditorTextProbe
          ? {
              matched: false,
              skipped: true,
              reason: 'defer-to-pine-editor-recovery',
              method: null,
              strongTerms: [],
              weakTerms: [],
              explicitPineMention: false,
              textExcerpt: null,
              element: null,
              structuredSummary: null,
              error: null
            }
          : await probePineEditorTextEvidence(spec, foreground))
        : null;
      pineEditorTextProbeMatched = pineEditorTextProbe?.matched === true;
      tradingMode = inferTradingViewTradingMode({
        title: foreground?.title,
        textSignals: [
          spec.reason,
          spec.classification,
          spec.appName,
          spec.popupHint,
          pineEditorTextProbe?.textExcerpt,
          ...(spec.expectedKeywords || []),
          ...(spec.tradingModeHint?.evidence || [])
        ].filter(Boolean).join(' '),
        keywords: spec.expectedKeywords,
        popupHint: evalResult.popupHint || null
      });

      const freshObservation = !!watcherFreshness?.fresh;
      const surfaceChangeObserved = observedChange || keywordMatched || titleHintMatched || watcherSurfaceMatched || pineEditorTextProbeMatched;
      const indicatorPresentMatched = spec.classification === 'chart-state'
        && String(spec.verifyKind || '').trim().toLowerCase() === 'indicator-present'
        ? !!(
          foreground?.success
          && evalResult.matched
          && windowKindMatched
          && (observedChange || watcherSurfaceMatched || freshObservation)
        )
        : false;
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
      const editorActiveMatched = spec.classification === 'editor-active'
        ? !!(
          foreground?.success
          && windowKindMatched
          && (
            watcherSurfaceMatched
            || pineEditorTextProbeMatched
            || (
              evalResult.matched
              && surfaceChangeObserved
              && (keywordMatched || titleHintMatched || freshObservation)
            )
          )
        )
        : false;
      const verified = spec.requiresObservedChange
        ? (spec.classification === 'editor-active'
          ? editorActiveMatched
          : (indicatorPresentMatched
            || strictChartStateMatched
            || !!(foreground?.success && evalResult.matched && windowKindMatched && surfaceChangeObserved)))
        : !!(foreground?.success && evalResult.matched && windowKindMatched && (surfaceChangeObserved || freshObservation || !spec.requiresObservedChange));

      if (verified) {
        return {
          applicable: true,
          verified: true,
          classification: spec.classification,
          appName: spec.appName || null,
          verifyKind: spec.verifyKind || null,
          verifyTarget: spec.verifyTarget || null,
          domainProofEligible: spec.domainProofEligible === true,
          attempts: attempt,
          observedChange,
          freshObservation,
          keywordMatched,
          titleHintMatched,
          windowKindMatched,
          editorActiveMatched,
          watcherSurfaceMatched,
          watcherSurfaceAnchor,
          watcherSurfaceElement,
          pineEditorTextProbeMatched,
          pineEditorTextProbe,
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
      appName: spec.appName || null,
      verifyKind: spec.verifyKind || null,
      verifyTarget: spec.verifyTarget || null,
      domainProofEligible: spec.domainProofEligible === true,
      attempts: keyCheckpointMaxPolls,
      observedChange,
      freshObservation: !!watcherFreshness?.fresh,
      keywordMatched,
      titleHintMatched,
      windowKindMatched,
      editorActiveMatched: false,
      watcherSurfaceMatched,
      watcherSurfaceAnchor,
      watcherSurfaceElement,
      pineEditorTextProbeMatched,
      pineEditorTextProbe,
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
          ? 'Post-key observation checkpoint could not confirm an active Pine Editor surface before continuing'
          : 'Post-key observation checkpoint could not confirm a TradingView surface change before continuing')
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
