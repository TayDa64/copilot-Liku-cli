const PINE_EDITOR_RESULT_CLICK_CANDIDATES = Object.freeze([
  { text: 'Open Pine Editor', exact: true },
  { text: 'Pine Editor', exact: false }
]);

const PINE_EDITOR_SURFACE_PROBE_CANDIDATES = Object.freeze([
  { text: 'Add to chart', exact: true },
  { text: 'Publish script', exact: false },
  { text: 'Pine Logs', exact: false },
  { text: 'Strategy Tester', exact: false }
]);

const TRADINGVIEW_QUICK_SEARCH_SURFACE_PROBE_CANDIDATES = Object.freeze([
  { text: 'Search tool or function', exact: true, controlType: 'Text' },
  { text: 'Nothing matches your criteria', exact: false, controlType: 'Text' },
  { text: 'Search', exact: true, controlType: 'Edit' }
]);

const TRADINGVIEW_QUICK_SEARCH_INPUT_FOCUS_CANDIDATES = Object.freeze([
  { text: 'Search', exact: true, controlType: 'Edit' },
  { text: 'Search tool or function', exact: true, controlType: 'Edit' }
]);

const TRADINGVIEW_QUICK_SEARCH_EMPTY_TEXT_PATTERNS = Object.freeze([
  /^$/,
  /^search$/i,
  /^search\s+tool\s+or\s+function$/i
]);

function createTradingViewRuntimeRecovery(deps = {}) {
  const {
    systemAutomation,
    sleepMs,
    verifyKeyObservationCheckpoint
  } = deps;

  if (!systemAutomation || typeof sleepMs !== 'function' || typeof verifyKeyObservationCheckpoint !== 'function') {
    throw new Error('createTradingViewRuntimeRecovery requires systemAutomation, sleepMs, and verifyKeyObservationCheckpoint');
  }

  function normalizeQuickSearchWindowProcessName(value = '') {
    return String(value || '').trim().toLowerCase();
  }

  async function getQuickSearchTrustedWindowInfo(windowHandle, fallbackForeground = null) {
    const numericHandle = Number(windowHandle || 0) || 0;
    if (!numericHandle) return null;
    if (Number(fallbackForeground?.hwnd || 0) === numericHandle) {
      return fallbackForeground && typeof fallbackForeground === 'object'
        ? fallbackForeground
        : null;
    }
    if (typeof systemAutomation.getWindowInfoByHandle !== 'function') {
      return null;
    }
    try {
      const info = await systemAutomation.getWindowInfoByHandle(numericHandle);
      return info?.success ? info : null;
    } catch {
      return null;
    }
  }

  async function isTrustedTradingViewQuickSearchMatch(matched, options = {}) {
    if (!matched?.element) {
      return { trusted: false, reason: 'missing-element', trustedWindow: null };
    }

    const elementWindowHandle = Number(matched?.element?.WindowHandle || 0) || 0;
    const expectedWindowHandle = Number(options.expectedWindowHandle || 0) || 0;
    const foreground = options.foreground && typeof options.foreground === 'object'
      ? options.foreground
      : await systemAutomation.getForegroundWindowInfo();
    const foregroundHandle = Number(foreground?.hwnd || 0) || 0;

    if (elementWindowHandle && expectedWindowHandle && elementWindowHandle === expectedWindowHandle) {
      return { trusted: true, reason: 'expected-window', trustedWindow: foreground };
    }

    if (elementWindowHandle && foregroundHandle && elementWindowHandle === foregroundHandle) {
      return { trusted: true, reason: 'foreground-window', trustedWindow: foreground };
    }

    const trustedWindow = await getQuickSearchTrustedWindowInfo(elementWindowHandle, foreground);
    const expectedProcessName = normalizeQuickSearchWindowProcessName(options.expectedProcessName || foreground?.processName || '');
    const trustedProcessName = normalizeQuickSearchWindowProcessName(trustedWindow?.processName || '');
    const trustedWindowKind = String(trustedWindow?.windowKind || '').trim().toLowerCase();

    if (trustedWindow && expectedProcessName && trustedProcessName === expectedProcessName
      && (!trustedWindowKind || ['main', 'owned', 'palette'].includes(trustedWindowKind))) {
      return {
        trusted: true,
        reason: matched?.matchedBy === 'global-fallback' ? 'same-process-global-fallback' : 'same-process-window-family',
        trustedWindow
      };
    }

    return {
      trusted: false,
      reason: matched?.matchedBy === 'global-fallback' ? 'cross-window-global-fallback' : 'window-family-mismatch',
      trustedWindow
    };
  }

  async function findForegroundElementByText(searchText, options = {}) {
    if (typeof systemAutomation.findElementByText !== 'function') {
      return null;
    }

    const exact = typeof options === 'boolean'
      ? options
      : !!options?.exact;
    const controlType = typeof options === 'object' && options !== null
      ? String(options.controlType || '').trim()
      : '';
    const allowGlobalFallback = typeof options === 'object' && options !== null
      ? options.allowGlobalFallback === true
      : false;
    const explicitWindowHandle = typeof options === 'object' && options !== null
      ? (Number(options.windowHandle || 0) || 0)
      : 0;

    const foreground = await systemAutomation.getForegroundWindowInfo();
    const foregroundHwnd = Number(foreground?.hwnd || 0) || 0;
    const attempts = [];
    if (explicitWindowHandle > 0) {
      attempts.push({ windowHandle: explicitWindowHandle, foregroundOnly: true, enforceWindowHandle: true, matchedBy: 'explicit-window' });
    } else if (foregroundHwnd > 0) {
      attempts.push({ windowHandle: foregroundHwnd, foregroundOnly: true, enforceWindowHandle: true, matchedBy: 'foreground-window' });
    }
    if (allowGlobalFallback) {
      attempts.push({ windowHandle: 0, foregroundOnly: false, enforceWindowHandle: false, matchedBy: 'global-fallback' });
    }
    if (attempts.length === 0) {
      attempts.push({ windowHandle: 0, foregroundOnly: false, enforceWindowHandle: false, matchedBy: 'global-search' });
    }

    for (const attempt of attempts) {
      try {
        const found = await systemAutomation.findElementByText(searchText, {
          exact,
          controlType,
          windowHandle: attempt.windowHandle,
          foregroundOnly: attempt.foregroundOnly
        });
        const element = found?.element || null;
        if (!element) {
          continue;
        }

        const elementHwnd = Number(element?.WindowHandle || 0) || 0;
        if (attempt.enforceWindowHandle && attempt.windowHandle && elementHwnd && attempt.windowHandle !== elementHwnd) {
          continue;
        }

        return {
          foreground,
          element,
          text: searchText,
          exact,
          controlType,
          matchedBy: attempt.matchedBy
        };
      } catch {
        // Continue to the next probe scope.
      }
    }

    return null;
  }

  async function probeTradingViewPineEditorSurface() {
    for (const candidate of PINE_EDITOR_SURFACE_PROBE_CANDIDATES) {
      const matched = await findForegroundElementByText(candidate.text, {
        exact: candidate.exact
      });
      if (matched) {
        return {
          matched: true,
          text: candidate.text,
          exact: candidate.exact,
          element: matched.element,
          foreground: matched.foreground
        };
      }
    }

    return null;
  }

  async function probeTradingViewQuickSearchSurface() {
    const foreground = await systemAutomation.getForegroundWindowInfo();
    const expectedWindowHandle = Number(foreground?.hwnd || 0) || 0;
    const expectedProcessName = foreground?.processName || '';

    for (const candidate of TRADINGVIEW_QUICK_SEARCH_SURFACE_PROBE_CANDIDATES) {
      const matched = await findForegroundElementByText(candidate.text, {
        exact: candidate.exact,
        controlType: candidate.controlType,
        allowGlobalFallback: true
      });
      if (matched) {
        const trust = await isTrustedTradingViewQuickSearchMatch(matched, {
          expectedWindowHandle,
          expectedProcessName,
          foreground
        });
        return {
          matched: true,
          text: candidate.text,
          exact: candidate.exact,
          controlType: candidate.controlType,
          matchedBy: matched.matchedBy || 'foreground-window',
          element: matched.element,
          foreground: matched.foreground,
          trusted: trust.trusted === true,
          trustReason: trust.reason || null,
          trustedWindow: trust.trustedWindow || null
        };
      }
    }

    return null;
  }

  function normalizeTradingViewQuickSearchInputText(value = '') {
    return String(value || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\r/g, '')
      .trim();
  }

  function isTradingViewQuickSearchInputEmpty(value = '') {
    const normalized = normalizeTradingViewQuickSearchInputText(value);
    return TRADINGVIEW_QUICK_SEARCH_EMPTY_TEXT_PATTERNS.some((pattern) => pattern.test(normalized));
  }

  async function readTradingViewQuickSearchInputValue(inputMatch) {
    const bounds = inputMatch?.element?.Bounds || null;
    if (!bounds) {
      return { success: false, error: 'Quick-search input bounds were not available for readback' };
    }

    try {
      const uia = require('../../ui-automation');
      const host = uia.getSharedUIAHost();
      const response = await host.getText(bounds.CenterX, bounds.CenterY);
      const text = String(response?.text || '');
      return {
        success: true,
        text,
        normalizedText: normalizeTradingViewQuickSearchInputText(text),
        method: response?.method || 'UIAHost.getText',
        empty: isTradingViewQuickSearchInputEmpty(text)
      };
    } catch (error) {
      return {
        success: false,
        error: error?.message || String(error || 'Quick-search input readback failed')
      };
    }
  }

  async function trySetTradingViewQuickSearchInputValue(inputMatch, value = '') {
    const bounds = inputMatch?.element?.Bounds || null;
    if (!bounds) {
      return { success: false, error: 'Quick-search input bounds were not available for setValue' };
    }

    try {
      const uia = require('../../ui-automation');
      const host = uia.getSharedUIAHost();
      const response = await host.setValue(bounds.CenterX, bounds.CenterY, value);
      return {
        success: true,
        method: 'ValuePattern',
        response
      };
    } catch (error) {
      return {
        success: false,
        error: error?.message || String(error || 'Quick-search input setValue failed')
      };
    }
  }

  async function focusTradingViewQuickSearchInput(preferredWindowHandle = 0) {
    if (typeof systemAutomation.click !== 'function') {
      return null;
    }

    const foreground = await systemAutomation.getForegroundWindowInfo();
    const expectedWindowHandle = Number(preferredWindowHandle || 0) || Number(foreground?.hwnd || 0) || 0;
    const expectedProcessName = foreground?.processName || '';

    for (const candidate of TRADINGVIEW_QUICK_SEARCH_INPUT_FOCUS_CANDIDATES) {
      const matched = await findForegroundElementByText(candidate.text, {
        exact: candidate.exact,
        controlType: candidate.controlType,
        windowHandle: preferredWindowHandle,
        allowGlobalFallback: true
      });
      if (!matched?.element?.Bounds) {
        continue;
      }

      const trust = await isTrustedTradingViewQuickSearchMatch(matched, {
        expectedWindowHandle,
        expectedProcessName,
        foreground
      });
      if (!trust.trusted) {
        continue;
      }

      const clickResult = {
        success: true,
        coordinates: {
          x: matched.element.Bounds.CenterX,
          y: matched.element.Bounds.CenterY
        }
      };

      try {
        await systemAutomation.click(
          matched.element.Bounds.CenterX,
          matched.element.Bounds.CenterY,
          'left'
        );
      } catch (error) {
        clickResult.success = false;
        clickResult.error = error?.message || String(error || 'click failed');
      }

      if (!clickResult.success) {
        continue;
      }

      await sleepMs(160);

      return {
        focused: true,
        text: candidate.text,
        exact: candidate.exact,
        controlType: candidate.controlType,
        matchedBy: matched.matchedBy || 'foreground-window',
        element: matched.element,
        foreground: matched.foreground,
        trusted: true,
        trustReason: trust.reason || null,
        trustedWindow: trust.trustedWindow || null,
        clickResult
      };
    }

    return null;
  }

  async function ensureTradingViewQuickSearchInputClearBeforeTyping(action, preferredWindowHandle = 0) {
    if (String(action?.type || '').trim().toLowerCase() !== 'type') {
      return { applicable: false, ready: true };
    }

    if (String(action?.searchSurfaceContract?.route || '').trim().toLowerCase() !== 'quick-search') {
      return { applicable: false, ready: true };
    }

    const inputFocus = await focusTradingViewQuickSearchInput(preferredWindowHandle);
    if (!inputFocus?.focused) {
      return {
        applicable: true,
        ready: false,
        error: 'Could not re-focus the TradingView quick-search input before typing',
        inputFocus: inputFocus || null
      };
    }

    const initialRead = await readTradingViewQuickSearchInputValue(inputFocus);
    if (!initialRead.success) {
      return {
        applicable: true,
        ready: false,
        error: initialRead.error || 'Could not read the TradingView quick-search input before typing',
        inputFocus,
        initialRead
      };
    }

    if (initialRead.empty) {
      return {
        applicable: true,
        ready: true,
        emptyConfirmed: true,
        clearedBy: 'already-empty',
        inputFocus,
        initialRead,
        finalRead: initialRead
      };
    }

    const valueClearAttempt = await trySetTradingViewQuickSearchInputValue(inputFocus, '');
    await sleepMs(80);
    const afterValueClearRead = await readTradingViewQuickSearchInputValue(inputFocus);
    if (valueClearAttempt.success && afterValueClearRead.success && afterValueClearRead.empty) {
      return {
        applicable: true,
        ready: true,
        emptyConfirmed: true,
        clearedBy: 'value-pattern',
        inputFocus,
        initialRead,
        clearAttempt: valueClearAttempt,
        finalRead: afterValueClearRead
      };
    }

    const keyboardFallback = {
      attempted: false,
      success: false,
      error: null
    };
    if (typeof systemAutomation.pressKey === 'function') {
      keyboardFallback.attempted = true;
      try {
        await systemAutomation.pressKey('ctrl+a', action);
        await sleepMs(90);
        await systemAutomation.pressKey('backspace', action);
        await sleepMs(90);
        keyboardFallback.success = true;
      } catch (error) {
        keyboardFallback.error = error?.message || String(error || 'Keyboard fallback failed');
      }
    }

    const afterKeyboardClearRead = await readTradingViewQuickSearchInputValue(inputFocus);
    if (afterKeyboardClearRead.success && afterKeyboardClearRead.empty) {
      return {
        applicable: true,
        ready: true,
        emptyConfirmed: true,
        clearedBy: keyboardFallback.success ? 'keyboard-fallback' : 'already-empty-after-recheck',
        inputFocus,
        initialRead,
        clearAttempt: valueClearAttempt,
        keyboardFallback,
        finalRead: afterKeyboardClearRead
      };
    }

    return {
      applicable: true,
      ready: false,
      error: 'TradingView quick-search input could not be proven empty before typing the query',
      inputFocus,
      initialRead,
      clearAttempt: valueClearAttempt,
      keyboardFallback,
      finalRead: afterKeyboardClearRead.success ? afterKeyboardClearRead : afterValueClearRead
    };
  }

  async function maybeRecoverTradingViewQuickSearchOpen(action, checkpointSpec, checkpointBeforeForeground, observationCheckpoint, options = {}) {
    const verifyTarget = String(action?.verify?.target || '').trim().toLowerCase();
    const key = String(action?.key || '').trim().toLowerCase();
    const shortcutId = String(action?.tradingViewShortcut?.id || '').trim().toLowerCase();
    const searchRoute = String(action?.searchSurfaceContract?.route || '').trim().toLowerCase();

    if (verifyTarget !== 'quick-search' || key !== 'ctrl+k') {
      return null;
    }

    if (shortcutId !== 'symbol-search' && searchRoute !== 'quick-search') {
      return null;
    }

    const probeMatched = await probeTradingViewQuickSearchSurface();
    if (!probeMatched) {
      return null;
    }

    if (probeMatched.trusted !== true) {
      return null;
    }

    const preferredWindowHandle = Number(probeMatched?.trustedWindow?.hwnd || 0)
      || Number(probeMatched?.element?.WindowHandle || 0)
      || Number(probeMatched?.foreground?.hwnd || 0)
      || 0;
    const focusedInput = await focusTradingViewQuickSearchInput(preferredWindowHandle);
    if (!focusedInput?.focused) {
      return null;
    }
    const relaxedCheckpoint = await verifyKeyObservationCheckpoint({
      ...checkpointSpec,
      requiresObservedChange: false
    }, checkpointBeforeForeground, {
      expectedWindowHandle: options.expectedWindowHandle
    });

    const foreground = relaxedCheckpoint?.foreground?.success
      ? relaxedCheckpoint.foreground
      : await systemAutomation.getForegroundWindowInfo();

    return {
      recovered: true,
      checkpoint: {
        ...observationCheckpoint,
        ...(relaxedCheckpoint || {}),
        verified: true,
        error: null,
        foreground,
        matchReason: relaxedCheckpoint?.matchReason || 'quick-search-surface-probe',
        recoveredBy: focusedInput?.focused ? 'semantic-input-focus' : 'surface-probe',
        quickSearchSurfaceProbe: probeMatched,
        quickSearchInputFocus: focusedInput || null
      }
    };
  }

  async function maybeRecoverTradingViewPineEditorOpen(action, checkpointSpec, checkpointBeforeForeground, observationCheckpoint, options = {}) {
    const routeId = String(action?.searchSurfaceContract?.id || '').trim().toLowerCase();
    const verifyTarget = String(action?.verify?.target || '').trim().toLowerCase();
    const key = String(action?.key || '').trim().toLowerCase();
    if (routeId !== 'open-pine-editor' || verifyTarget !== 'pine-editor' || key !== 'enter') {
      return null;
    }

    const probeMatchedBeforeClick = await probeTradingViewPineEditorSurface();
    if (probeMatchedBeforeClick) {
      const foreground = await systemAutomation.getForegroundWindowInfo();
      return {
        recovered: true,
        checkpoint: {
          ...observationCheckpoint,
          verified: true,
          error: null,
          editorActiveMatched: true,
          foreground,
          matchReason: 'pine-editor-surface-probe',
          recoveredBy: 'surface-probe',
          pineEditorSurfaceProbe: probeMatchedBeforeClick
        }
      };
    }

    if (typeof systemAutomation.click !== 'function') {
      return null;
    }

    for (const candidate of PINE_EDITOR_RESULT_CLICK_CANDIDATES) {
      const matchedResult = await findForegroundElementByText(candidate.text, {
        exact: candidate.exact
      });
      if (!matchedResult?.element?.Bounds) {
        continue;
      }

      const clickResult = {
        success: true,
        coordinates: {
          x: matchedResult.element.Bounds.CenterX,
          y: matchedResult.element.Bounds.CenterY
        }
      };

      try {
        await systemAutomation.click(
          matchedResult.element.Bounds.CenterX,
          matchedResult.element.Bounds.CenterY,
          'left'
        );
      } catch (error) {
        clickResult.success = false;
        clickResult.error = error?.message || String(error || 'click failed');
      }

      if (!clickResult.success) continue;

      await sleepMs(240);

      const relaxedCheckpoint = await verifyKeyObservationCheckpoint({
        ...checkpointSpec,
        requiresObservedChange: false
      }, checkpointBeforeForeground, {
        expectedWindowHandle: options.expectedWindowHandle
      });

      const probeMatchedAfterClick = await probeTradingViewPineEditorSurface();
      if (relaxedCheckpoint?.verified || probeMatchedAfterClick) {
        const foreground = relaxedCheckpoint?.foreground?.success
          ? relaxedCheckpoint.foreground
          : await systemAutomation.getForegroundWindowInfo();
        return {
          recovered: true,
          clickResult,
          checkpoint: {
            ...observationCheckpoint,
            ...(relaxedCheckpoint || {}),
            verified: true,
            error: null,
            editorActiveMatched: true,
            foreground,
            matchReason: relaxedCheckpoint?.matchReason || 'pine-editor-semantic-click-recovery',
            recoveredBy: 'semantic-click',
            pineEditorResultClick: {
              text: candidate.text,
              exact: candidate.exact
            },
            pineEditorSurfaceProbe: probeMatchedAfterClick || null
          }
        };
      }
    }

    return null;
  }

  return {
    ensureTradingViewQuickSearchInputClearBeforeTyping,
    maybeRecoverTradingViewQuickSearchOpen,
    maybeRecoverTradingViewPineEditorOpen
  };
}

module.exports = {
  createTradingViewRuntimeRecovery
};
