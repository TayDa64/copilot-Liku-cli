const PINE_EDITOR_RESULT_CLICK_CANDIDATES = Object.freeze([
  { text: 'Open Pine Editor', exact: true },
  { text: 'Pine Editor', exact: false }
]);

const PINE_EDITOR_QUICK_SEARCH_RESULT_CANDIDATES = Object.freeze([
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
  { text: 'Search tools or functions', exact: true, controlType: 'Text' },
  { text: 'Search tools, functions', exact: false, controlType: 'Text' },
  { text: 'Nothing matches your criteria', exact: false, controlType: 'Text' },
  { text: 'Search', exact: true, controlType: 'Edit' }
]);

const TRADINGVIEW_QUICK_SEARCH_INPUT_FOCUS_CANDIDATES = Object.freeze([
  { text: 'Search', exact: true, controlType: 'Edit' },
  { text: 'Search tool or function', exact: true, controlType: 'Edit' },
  { text: 'Search tools or functions', exact: true, controlType: 'Edit' },
  { text: 'Search', exact: true, controlType: 'Text' },
  { text: 'Search tool or function', exact: true, controlType: 'Text' },
  { text: 'Search tools or functions', exact: true, controlType: 'Text' },
  { text: 'Search tools, functions', exact: false, controlType: 'Text' },
  { text: 'Nothing matches your criteria', exact: false, controlType: 'Text' }
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
    const allowWindowFamily = typeof options === 'object' && options !== null
      ? options.allowWindowFamily === true
      : false;

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
        if (attempt.enforceWindowHandle && !allowWindowFamily && attempt.windowHandle && elementHwnd && attempt.windowHandle !== elementHwnd) {
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

  async function probeTradingViewQuickSearchSurface(preferredWindowHandle = 0) {
    const foreground = await systemAutomation.getForegroundWindowInfo();
    const expectedWindowHandle = Number(preferredWindowHandle || 0) || Number(foreground?.hwnd || 0) || 0;
    const expectedProcessName = foreground?.processName || '';
    const allowGlobalFallback = expectedWindowHandle <= 0;

    for (const candidate of TRADINGVIEW_QUICK_SEARCH_SURFACE_PROBE_CANDIDATES) {
      const matched = await findForegroundElementByText(candidate.text, {
        exact: candidate.exact,
        controlType: candidate.controlType,
        windowHandle: expectedWindowHandle,
        allowWindowFamily: true,
        allowGlobalFallback
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

  async function detectTradingViewPineEditorQuickSearchResult(preferredWindowHandle = 0) {
    const foreground = await systemAutomation.getForegroundWindowInfo();
    const expectedWindowHandle = Number(preferredWindowHandle || 0) || Number(foreground?.hwnd || 0) || 0;
    const expectedProcessName = foreground?.processName || '';
    const allowGlobalFallback = expectedWindowHandle <= 0;

    for (const candidate of PINE_EDITOR_QUICK_SEARCH_RESULT_CANDIDATES) {
      const matched = await findForegroundElementByText(candidate.text, {
        exact: candidate.exact,
        windowHandle: expectedWindowHandle,
        allowWindowFamily: true,
        allowGlobalFallback
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

      return {
        matched: true,
        text: candidate.text,
        exact: candidate.exact,
        matchedBy: matched.matchedBy || 'foreground-window',
        element: matched.element,
        foreground: matched.foreground || foreground,
        trusted: true,
        trustReason: trust.reason || null,
        trustedWindow: trust.trustedWindow || null
      };
    }

    return null;
  }

  async function retryOpenTradingViewQuickSearchShortcut(action, options = {}) {
    const expectedWindowHandle = Number(options.expectedWindowHandle || 0) || 0;
    const retry = {
      attempted: false,
      success: false,
      focused: false,
      expectedWindowHandle,
      error: null
    };

    if (options.allowShortcutRetry !== true || typeof systemAutomation.pressKey !== 'function') {
      retry.error = 'Quick-search shortcut retry was not enabled';
      return retry;
    }

    try {
      if (expectedWindowHandle > 0 && typeof systemAutomation.focusWindow === 'function') {
        const focusResult = await systemAutomation.focusWindow(expectedWindowHandle);
        retry.focused = focusResult?.success === true
          || Number(focusResult?.actualForegroundHandle || 0) === expectedWindowHandle;
        retry.focusResult = focusResult || null;
        await sleepMs(180);
      }

      const foregroundBeforeRetry = await systemAutomation.getForegroundWindowInfo();
      retry.foregroundBeforeRetry = foregroundBeforeRetry || null;
      const foregroundHandle = Number(foregroundBeforeRetry?.hwnd || 0) || 0;
      const foregroundProcess = normalizeQuickSearchWindowProcessName(foregroundBeforeRetry?.processName || '');
      if (expectedWindowHandle > 0 && foregroundHandle !== expectedWindowHandle) {
        retry.error = `Refusing quick-search retry because foreground moved away from TradingView target (${foregroundHandle || 'unknown'} != ${expectedWindowHandle})`;
        return retry;
      }
      if (foregroundProcess && foregroundProcess !== 'tradingview') {
        retry.error = `Refusing quick-search retry because foreground process is ${foregroundProcess}`;
        return retry;
      }

      retry.attempted = true;
      await systemAutomation.pressKey('ctrl+k', {
        ...action,
        reason: 'Retry opening TradingView quick search after the first shortcut press did not produce observable UIA evidence'
      });
      await sleepMs(Number(options.retryWaitMs || 520) || 520);

      const probeMatched = await probeTradingViewQuickSearchSurface(expectedWindowHandle);
      retry.probe = probeMatched || null;
      retry.success = probeMatched?.trusted === true;
      if (!retry.success) {
        retry.error = probeMatched
          ? `Quick-search retry found an untrusted surface (${probeMatched.trustReason || 'unknown trust reason'})`
          : 'Quick-search retry did not expose a probeable search surface';
      }
      return retry;
    } catch (error) {
      retry.error = error?.message || String(error || 'Quick-search shortcut retry failed');
      return retry;
    }
  }

  function normalizeTradingViewQuickSearchInputText(value = '') {
    return String(value || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\r/g, '')
      .trim();
  }

  function isPlausibleTradingViewQuickSearchClipboardText(value = '') {
    const raw = String(value || '');
    const normalized = normalizeTradingViewQuickSearchInputText(raw);
    if (!normalized) return true;
    if (raw.length > 160) return false;
    if (/[\r\n\t]/.test(raw)) return false;
    return true;
  }

  function looksLikePineEditorSourceClipboardText(value = '') {
    const raw = String(value || '');
    if (!raw || raw.length < 40) return false;
    return /\/\/\s*@version\s*=\s*\d+/i.test(raw)
      || /\b(indicator|strategy|library)\s*\(/i.test(raw)
      || /\bplot(shape|char|arrow)?\s*\(/i.test(raw);
  }

  function isTradingViewQuickSearchInputEmpty(value = '') {
    const normalized = normalizeTradingViewQuickSearchInputText(value);
    return TRADINGVIEW_QUICK_SEARCH_EMPTY_TEXT_PATTERNS.some((pattern) => pattern.test(normalized));
  }

  function isRepeatedTradingViewQuickSearchQuery(actualText = '', expectedText = '') {
    const actual = normalizeTradingViewQuickSearchInputText(actualText);
    const expected = normalizeTradingViewQuickSearchInputText(expectedText);
    if (!actual || !expected) return false;
    if (actual === expected) return false;
    if (!actual.startsWith(expected)) return false;
    return actual.split(expected).join('') === '';
  }

  async function readSystemClipboardText() {
    if (typeof systemAutomation.executeCommand !== 'function') {
      return { success: false, error: 'Clipboard read command support is unavailable' };
    }

    try {
      const result = await systemAutomation.executeCommand("$ErrorActionPreference='Stop'; try { $text = Get-Clipboard -Raw } catch { $text = '' }; if ($null -eq $text) { $text = '' }; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output $text", {
        shell: 'powershell',
        timeout: 5000
      });
      return {
        success: !!result?.success,
        text: String(result?.stdout || ''),
        error: result?.success ? null : (result?.stderr || result?.error || 'Clipboard read failed')
      };
    } catch (error) {
      return {
        success: false,
        error: error?.message || String(error || 'Clipboard read failed')
      };
    }
  }

  async function writeSystemClipboardText(value = '') {
    if (typeof systemAutomation.executeCommand !== 'function') {
      return { success: false, error: 'Clipboard write command support is unavailable' };
    }

    try {
      const encoded = Buffer.from(String(value || ''), 'utf8').toString('base64');
      const command = encoded
        ? `$ErrorActionPreference='Stop'; $bytes = [Convert]::FromBase64String('${encoded}'); $text = [System.Text.Encoding]::UTF8.GetString($bytes); Set-Clipboard -Value $text`
        : "$ErrorActionPreference='Stop'; Set-Clipboard -Value ' '";
      const result = await systemAutomation.executeCommand(command, {
        shell: 'powershell',
        timeout: 5000
      });
      return {
        success: !!result?.success,
        error: result?.success ? null : (result?.stderr || result?.error || 'Clipboard write failed')
      };
    } catch (error) {
      return {
        success: false,
        error: error?.message || String(error || 'Clipboard write failed')
      };
    }
  }

  async function getTrustedTradingViewForegroundForClipboardProbe(options = {}) {
    const foreground = await systemAutomation.getForegroundWindowInfo();
    const foregroundProcess = String(foreground?.processName || '').trim().toLowerCase();
    if (foregroundProcess !== 'tradingview') {
      return {
        trusted: false,
        foreground: foreground || null,
        error: 'Clipboard selection fallback requires TradingView to remain focused'
      };
    }

    const expectedWindowHandle = Number(options.expectedWindowHandle || options.preferredWindowHandle || 0) || 0;
    const foregroundHandle = Number(foreground?.hwnd || 0) || 0;
    if (!expectedWindowHandle || !foregroundHandle || foregroundHandle === expectedWindowHandle) {
      return {
        trusted: true,
        foreground: foreground || null,
        reason: foregroundHandle === expectedWindowHandle ? 'expected-window' : 'tradingview-foreground'
      };
    }

    const foregroundInfo = await getQuickSearchTrustedWindowInfo(foregroundHandle, foreground);
    const ownerHwnd = Number(foregroundInfo?.ownerHwnd || 0) || 0;
    const windowKind = String(foregroundInfo?.windowKind || foreground?.windowKind || '').trim().toLowerCase();
    const processName = String(foregroundInfo?.processName || foreground?.processName || '').trim().toLowerCase();
    if (processName === 'tradingview' && ownerHwnd === expectedWindowHandle && ['owned', 'palette', 'main', ''].includes(windowKind)) {
      return {
        trusted: true,
        foreground: foregroundInfo || foreground || null,
        reason: 'owned-window-family'
      };
    }

    return {
      trusted: false,
      foreground: foreground || null,
      foregroundInfo: foregroundInfo || null,
      error: `Clipboard selection fallback requires the focused TradingView window to match the expected target (${foregroundHandle || 'unknown'} != ${expectedWindowHandle})`
    };
  }

  async function restoreTradingViewQuickSearchCaretAfterSelectionProbe(action, options = {}) {
    if (typeof systemAutomation.pressKey !== 'function') {
      return { attempted: false, success: false, error: 'Keyboard support is unavailable' };
    }

    const trust = await getTrustedTradingViewForegroundForClipboardProbe(options);
    if (!trust.trusted) {
      return {
        attempted: false,
        success: false,
        skipped: true,
        reason: trust.error || 'TradingView is no longer the trusted foreground after selection probe',
        foreground: trust.foreground || null
      };
    }

    const collapseKey = String(options.collapseKey || 'right').trim().toLowerCase() || 'right';
    try {
      await systemAutomation.pressKey(collapseKey, action);
      await sleepMs(Number(options.collapseWaitMs || 60) || 60);
      return {
        attempted: true,
        success: true,
        collapseKey,
        foreground: trust.foreground || null
      };
    } catch (error) {
      return {
        attempted: true,
        success: false,
        collapseKey,
        foreground: trust.foreground || null,
        error: error?.message || String(error || 'Failed to restore quick-search caret after selection probe')
      };
    }
  }

  async function readTradingViewQuickSearchSelectionViaClipboard(action, options = {}) {
    if (typeof systemAutomation.pressKey !== 'function') {
      return { success: false, error: 'Keyboard selection fallback is unavailable' };
    }

    const trust = await getTrustedTradingViewForegroundForClipboardProbe({
      expectedWindowHandle: options.expectedWindowHandle || options.preferredWindowHandle || action?.windowHandle || action?.hwnd || 0
    });
    if (!trust.trusted) {
      return {
        success: false,
        error: trust.error || 'Clipboard selection fallback requires TradingView to remain focused',
        foreground: trust.foreground || null,
        focusTrust: trust
      };
    }
    const foreground = trust.foreground || null;

    const originalClipboard = await readSystemClipboardText();
    if (!originalClipboard.success) {
      return {
        success: false,
        error: originalClipboard.error || 'Could not snapshot clipboard before TradingView quick-search probe',
        foreground: foreground || null
      };
    }

    const sentinel = `__LIKU_QS_${Date.now()}_${Math.random().toString(36).slice(2, 8)}__`;
    const sentinelWrite = await writeSystemClipboardText(sentinel);
    if (!sentinelWrite.success) {
      return {
        success: false,
        error: sentinelWrite.error || 'Could not prime clipboard sentinel before TradingView quick-search probe',
        foreground: foreground || null,
        originalClipboard
      };
    }

    try {
      await systemAutomation.pressKey('ctrl+a', action);
      await sleepMs(Number(options.selectAllWaitMs || 90) || 90);
      await systemAutomation.pressKey('ctrl+c', action);
      await sleepMs(Number(options.copyWaitMs || 140) || 140);

      const capturedClipboard = await readSystemClipboardText();
      if (!capturedClipboard.success) {
        return {
          success: false,
          error: capturedClipboard.error || 'Could not read clipboard after TradingView quick-search selection copy',
          foreground: foreground || null,
          originalClipboard,
          sentinel
        };
      }

      const capturedText = String(capturedClipboard.text || '');
      const sentinelMatched = capturedText === sentinel;
      const normalizedText = normalizeTradingViewQuickSearchInputText(capturedText);
      const plausible = !sentinelMatched && isPlausibleTradingViewQuickSearchClipboardText(capturedText);
      const selectionReset = await restoreTradingViewQuickSearchCaretAfterSelectionProbe(action, options);

      return {
        success: plausible,
        text: capturedText,
        normalizedText,
        empty: isTradingViewQuickSearchInputEmpty(capturedText),
        plausible,
        sentinelMatched,
        method: 'clipboard-selection',
        foreground: foreground || null,
        focusTrust: trust,
        originalClipboard,
        capturedClipboard,
        selectionReset,
        error: plausible ? null : (sentinelMatched
          ? 'Clipboard selection copy did not capture a TradingView quick-search value'
          : 'Clipboard selection copy did not produce a plausible TradingView quick-search value')
      };
    } finally {
      await writeSystemClipboardText(originalClipboard.text || '');
    }
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
    const allowGlobalFallback = expectedWindowHandle <= 0;

    for (const candidate of TRADINGVIEW_QUICK_SEARCH_INPUT_FOCUS_CANDIDATES) {
      const matched = await findForegroundElementByText(candidate.text, {
        exact: candidate.exact,
        controlType: candidate.controlType,
        windowHandle: preferredWindowHandle,
        allowWindowFamily: true,
        allowGlobalFallback
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

    const surfaceProbe = await probeTradingViewQuickSearchSurface(expectedWindowHandle);
    if (surfaceProbe?.element?.Bounds) {
      const fallbackClickResult = {
        success: true,
        coordinates: {
          x: surfaceProbe.element.Bounds.CenterX,
          y: surfaceProbe.element.Bounds.CenterY
        }
      };

      try {
        await systemAutomation.click(
          surfaceProbe.element.Bounds.CenterX,
          surfaceProbe.element.Bounds.CenterY,
          'left'
        );
      } catch (error) {
        fallbackClickResult.success = false;
        fallbackClickResult.error = error?.message || String(error || 'click failed');
      }

      if (fallbackClickResult.success) {
        await sleepMs(160);
        return {
          focused: true,
          text: surfaceProbe.text,
          exact: surfaceProbe.exact,
          controlType: surfaceProbe.controlType,
          matchedBy: surfaceProbe.matchedBy || 'surface-probe',
          element: surfaceProbe.element,
          foreground: surfaceProbe.foreground,
          trusted: true,
          trustReason: surfaceProbe.trustReason || 'surface-probe-fallback',
          trustedWindow: surfaceProbe.trustedWindow || null,
          clickResult: fallbackClickResult,
          recoveredBy: 'surface-probe-fallback'
        };
      }
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

    const expectedText = normalizeTradingViewQuickSearchInputText(action?.text || '');

    if (/^pine\s+editor$/i.test(expectedText)) {
      const visibleResult = await detectTradingViewPineEditorQuickSearchResult(preferredWindowHandle);
      if (visibleResult?.trusted) {
        return {
          applicable: true,
          ready: true,
          emptyConfirmed: false,
          queryAlreadyPresent: true,
          quickSearchResultVisible: true,
          expectedText,
          clearedBy: 'already-visible-pine-editor-result',
          inputFocus: {
            focused: true,
            recoveredBy: 'visible-pine-editor-result',
            text: visibleResult.text,
            element: visibleResult.element,
            foreground: visibleResult.foreground || null
          },
          initialRead: {
            success: true,
            text: visibleResult.text,
            normalizedText: expectedText,
            method: 'quick-search-result-probe',
            empty: false
          },
          finalRead: {
            success: true,
            text: visibleResult.text,
            normalizedText: expectedText,
            method: 'quick-search-result-probe',
            empty: false
          }
        };
      }
    }

    async function tryResolveClipboardPreflight() {
      const clipboardRead = await readTradingViewQuickSearchSelectionViaClipboard(action, {
        expectedWindowHandle: preferredWindowHandle
      });
      if (clipboardRead.success) {
        if (clipboardRead.empty) {
          return {
            resolved: true,
            result: {
              applicable: true,
              ready: true,
              emptyConfirmed: true,
              clearedBy: 'clipboard-already-empty',
              inputFocus: {
                focused: true,
                recoveredBy: 'clipboard-selection',
                foreground: clipboardRead.foreground || null
              },
              initialRead: clipboardRead,
              finalRead: clipboardRead
            }
          };
        }

        if (expectedText && clipboardRead.normalizedText === expectedText) {
          return {
            resolved: true,
            result: {
              applicable: true,
              ready: true,
              emptyConfirmed: false,
              queryAlreadyPresent: true,
              expectedText,
              clearedBy: 'clipboard-already-populated-with-expected-query',
              inputFocus: {
                focused: true,
                recoveredBy: 'clipboard-selection',
                foreground: clipboardRead.foreground || null
              },
              initialRead: clipboardRead,
              finalRead: clipboardRead
            }
          };
        }

        const keyboardFallback = {
          attempted: false,
          success: false,
          error: null
        };
        try {
          keyboardFallback.attempted = true;
          await systemAutomation.pressKey('ctrl+a', action);
          await sleepMs(90);
          await systemAutomation.pressKey('backspace', action);
          await sleepMs(100);
          keyboardFallback.success = true;
        } catch (error) {
          keyboardFallback.error = error?.message || String(error || 'Keyboard fallback failed');
        }

        const afterKeyboardClipboardRead = await readTradingViewQuickSearchSelectionViaClipboard(action, {
          expectedWindowHandle: preferredWindowHandle
        });
        if (afterKeyboardClipboardRead.success && afterKeyboardClipboardRead.empty) {
          return {
            resolved: true,
            result: {
              applicable: true,
              ready: true,
              emptyConfirmed: true,
              clearedBy: keyboardFallback.success ? 'clipboard-keyboard-fallback' : 'clipboard-already-empty-after-recheck',
              inputFocus: {
                focused: true,
                recoveredBy: 'clipboard-selection',
                foreground: afterKeyboardClipboardRead.foreground || clipboardRead.foreground || null
              },
              initialRead: clipboardRead,
              keyboardFallback,
              finalRead: afterKeyboardClipboardRead
            }
          };
        }

        if (expectedText && afterKeyboardClipboardRead.success && afterKeyboardClipboardRead.normalizedText === expectedText) {
          return {
            resolved: true,
            result: {
              applicable: true,
              ready: true,
              emptyConfirmed: false,
              queryAlreadyPresent: true,
              expectedText,
              clearedBy: keyboardFallback.success ? 'clipboard-keyboard-fallback-preserved-expected-query' : 'clipboard-expected-query-still-present-after-recheck',
              inputFocus: {
                focused: true,
                recoveredBy: 'clipboard-selection',
                foreground: afterKeyboardClipboardRead.foreground || clipboardRead.foreground || null
              },
              initialRead: clipboardRead,
              keyboardFallback,
              finalRead: afterKeyboardClipboardRead
            }
          };
        }
      }

      if (expectedText && /^pine\s+editor$/i.test(expectedText)
        && !clipboardRead?.success
        && looksLikePineEditorSourceClipboardText(clipboardRead?.text || clipboardRead?.capturedClipboard?.text || '')) {
        return {
          resolved: true,
          result: {
            applicable: true,
            ready: true,
            emptyConfirmed: false,
            targetSurfaceAlreadyOpen: true,
            expectedText,
            clearedBy: 'pine-editor-source-selection-proof',
            inputFocus: {
              focused: true,
              recoveredBy: 'pine-editor-source-selection-proof',
              foreground: clipboardRead.foreground || null
            },
            initialRead: clipboardRead,
            finalRead: clipboardRead,
            fallbackReason: 'TradingView selection copy produced Pine source rather than a quick-search value; treat Pine Editor as already active and skip the redundant open route.'
          }
        };
      }

      return {
        resolved: false,
        clipboardRead: clipboardRead || null
      };
    }

    const inputFocus = await focusTradingViewQuickSearchInput(preferredWindowHandle);
    if (!inputFocus?.focused) {
      const clipboardPreflight = await tryResolveClipboardPreflight();
      if (clipboardPreflight?.resolved) {
        return {
          ...clipboardPreflight.result,
          preflightRoute: 'clipboard-fallback-after-focus-miss'
        };
      }

      return {
        applicable: true,
        ready: false,
        error: 'Could not re-focus the TradingView quick-search input before typing',
        inputFocus: inputFocus || null,
        clipboardRead: clipboardPreflight?.clipboardRead || null
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

    if (expectedText && initialRead.normalizedText === expectedText) {
      return {
        applicable: true,
        ready: true,
        emptyConfirmed: false,
        queryAlreadyPresent: true,
        expectedText,
        clearedBy: 'already-populated-with-expected-query',
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

    if (expectedText && afterValueClearRead.success && afterValueClearRead.normalizedText === expectedText) {
      return {
        applicable: true,
        ready: true,
        emptyConfirmed: false,
        queryAlreadyPresent: true,
        expectedText,
        clearedBy: 'value-pattern-preserved-expected-query',
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

    if (expectedText && afterKeyboardClearRead.success && afterKeyboardClearRead.normalizedText === expectedText) {
      return {
        applicable: true,
        ready: true,
        emptyConfirmed: false,
        queryAlreadyPresent: true,
        expectedText,
        clearedBy: keyboardFallback.success ? 'keyboard-fallback-preserved-expected-query' : 'expected-query-still-present-after-recheck',
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

  async function verifyTradingViewQuickSearchTypedValue(action, quickSearchPreflight = null, preferredWindowHandle = 0) {
    if (String(action?.type || '').trim().toLowerCase() !== 'type') {
      return { applicable: false, verified: true };
    }

    if (String(action?.searchSurfaceContract?.route || '').trim().toLowerCase() !== 'quick-search') {
      return { applicable: false, verified: true };
    }

    const expectedText = normalizeTradingViewQuickSearchInputText(action?.text || '');
    if (!expectedText) {
      return { applicable: true, verified: false, error: 'No expected quick-search text was available for verification' };
    }

    const autoFocusTyping = action?.searchSurfaceContract?.autoFocusTyping;
    const expectedAutoFocusText = normalizeTradingViewQuickSearchInputText(
      autoFocusTyping?.expectedText || action?.text || ''
    );
    const autoFocusTypingContractVerified = !!(
      quickSearchPreflight?.fallbackAssumedFocused === true
      && autoFocusTyping
      && typeof autoFocusTyping === 'object'
      && autoFocusTyping.enabled === true
      && expectedAutoFocusText
      && expectedAutoFocusText === expectedText
    );
    if (autoFocusTypingContractVerified) {
      return {
        applicable: true,
        verified: true,
        expectedText,
        actualText: expectedText,
        inputFocus: {
          focused: true,
          recoveredBy: 'contracted-auto-focus-type',
          foreground: quickSearchPreflight?.foreground || null
        },
        readback: null,
        satisfiedBy: 'contracted-auto-focus-type',
        error: null
      };
    }

    let inputFocus = quickSearchPreflight?.inputFocus || null;
    const canReuseClipboardFallback = !!(
      quickSearchPreflight?.fallbackAssumedFocused
      || quickSearchPreflight?.emptyInferred
      || inputFocus?.focused
    );
    if (!inputFocus?.element?.Bounds && !canReuseClipboardFallback) {
      inputFocus = await focusTradingViewQuickSearchInput(preferredWindowHandle);
    }

    async function tryCanonicalizeTradingViewQuickSearchTypedValue(actualText = '') {
      if (!isRepeatedTradingViewQuickSearchQuery(actualText, expectedText)) {
        return null;
      }

      const canonicalization = {
        attempted: true,
        reason: 'duplicate-query-detected',
        expectedText,
        observedText: normalizeTradingViewQuickSearchInputText(actualText),
        steps: []
      };

      try {
        await systemAutomation.pressKey('ctrl+a', action);
        canonicalization.steps.push({ key: 'ctrl+a', success: true });
        await sleepMs(90);
        await systemAutomation.typeText(expectedText);
        canonicalization.steps.push({ type: 'typeText', text: expectedText, success: true });
        await sleepMs(180);
      } catch (error) {
        canonicalization.error = error?.message || String(error || 'Quick-search canonicalization failed');
        return {
          verified: false,
          actualText: canonicalization.observedText,
          canonicalization,
          error: canonicalization.error
        };
      }

      const repairedReadback = await readTradingViewQuickSearchSelectionViaClipboard(action, {
        expectedWindowHandle: preferredWindowHandle
      });
      const repairedActual = normalizeTradingViewQuickSearchInputText(repairedReadback?.normalizedText || repairedReadback?.text || '');
      const repairedVerified = repairedReadback?.success === true && repairedActual === expectedText;
      canonicalization.readback = repairedReadback;

      return {
        verified: repairedVerified,
        actualText: repairedActual,
        canonicalization,
        readback: repairedReadback,
        error: repairedVerified ? null : 'TradingView quick-search canonicalization did not produce the expected exact query'
      };
    }

    async function trySemanticSetTradingViewQuickSearchTypedValue(inputMatch, actualText = '') {
      if (!inputMatch?.element?.Bounds) {
        return null;
      }
      if (quickSearchPreflight?.emptyConfirmed !== true && quickSearchPreflight?.queryAlreadyPresent !== true) {
        return null;
      }

      const semanticRepair = {
        attempted: true,
        reason: 'post-type-readback-mismatch',
        expectedText,
        observedText: normalizeTradingViewQuickSearchInputText(actualText)
      };
      const setAttempt = await trySetTradingViewQuickSearchInputValue(inputMatch, expectedText);
      semanticRepair.setAttempt = setAttempt;
      if (!setAttempt.success) {
        return {
          verified: false,
          actualText: semanticRepair.observedText,
          semanticRepair,
          error: setAttempt.error || 'TradingView quick-search semantic repair failed'
        };
      }

      await sleepMs(120);
      const repairedReadback = await readTradingViewQuickSearchInputValue(inputMatch);
      const repairedActual = normalizeTradingViewQuickSearchInputText(repairedReadback?.normalizedText || repairedReadback?.text || '');
      const repairedVerified = repairedReadback?.success === true && repairedActual === expectedText;
      semanticRepair.readback = repairedReadback;

      return {
        verified: repairedVerified,
        actualText: repairedActual,
        semanticRepair,
        readback: repairedReadback,
        error: repairedVerified ? null : 'TradingView quick-search semantic repair did not produce the expected exact query'
      };
    }

    if (!inputFocus?.element?.Bounds) {
      const clipboardRead = await readTradingViewQuickSearchSelectionViaClipboard(action, {
        expectedWindowHandle: preferredWindowHandle
      });
      if (clipboardRead.success) {
        const normalizedActual = normalizeTradingViewQuickSearchInputText(clipboardRead.normalizedText || clipboardRead.text || '');
        const verifiedByClipboard = normalizedActual === expectedText;
        const canonicalized = !verifiedByClipboard
          ? await tryCanonicalizeTradingViewQuickSearchTypedValue(normalizedActual)
          : null;
        return {
          applicable: true,
          verified: canonicalized ? canonicalized.verified === true : verifiedByClipboard,
          expectedText,
          actualText: canonicalized ? canonicalized.actualText : normalizedActual,
          inputFocus: {
            focused: true,
            recoveredBy: canReuseClipboardFallback ? 'clipboard-selection-preflight-fallback' : 'clipboard-selection',
            foreground: clipboardRead.foreground || null
          },
          readback: canonicalized?.readback || clipboardRead,
          canonicalization: canonicalized?.canonicalization || null,
          error: canonicalized
            ? canonicalized.error
            : (verifiedByClipboard ? null : 'TradingView quick-search clipboard readback did not match the typed query exactly')
        };
      }

      const semanticInputFocus = await focusTradingViewQuickSearchInput(preferredWindowHandle);
      if (semanticInputFocus?.element?.Bounds) {
        const semanticReadback = await readTradingViewQuickSearchInputValue(semanticInputFocus);
        if (semanticReadback.success) {
          const normalizedSemanticActual = normalizeTradingViewQuickSearchInputText(semanticReadback.normalizedText || semanticReadback.text || '');
          const verifiedBySemanticReadback = normalizedSemanticActual === expectedText;
          const semanticRepaired = !verifiedBySemanticReadback
            ? await trySemanticSetTradingViewQuickSearchTypedValue(semanticInputFocus, normalizedSemanticActual)
            : null;
          const canonicalized = !verifiedBySemanticReadback && !semanticRepaired
            ? await tryCanonicalizeTradingViewQuickSearchTypedValue(normalizedSemanticActual)
            : null;
          const repair = semanticRepaired || canonicalized;

          return {
            applicable: true,
            verified: repair ? repair.verified === true : verifiedBySemanticReadback,
            expectedText,
            actualText: repair ? repair.actualText : normalizedSemanticActual,
            inputFocus: semanticInputFocus,
            readback: repair?.readback || semanticReadback,
            canonicalization: canonicalized?.canonicalization || null,
            semanticRepair: semanticRepaired?.semanticRepair || null,
            clipboardRead: clipboardRead || null,
            error: repair
              ? repair.error
              : (verifiedBySemanticReadback ? null : 'TradingView quick-search semantic readback did not match the typed query exactly')
          };
        }
      }

      return {
        applicable: true,
        verified: false,
        expectedText,
        error: 'Could not focus or resolve the TradingView quick-search input after typing',
        inputFocus: inputFocus || null,
        clipboardRead: clipboardRead || null
      };
    }

    const readback = await readTradingViewQuickSearchInputValue(inputFocus);
    if (!readback.success) {
      return {
        applicable: true,
        verified: false,
        expectedText,
        error: readback.error || 'Could not read the TradingView quick-search input after typing',
        inputFocus,
        readback
      };
    }

    const normalizedActual = normalizeTradingViewQuickSearchInputText(readback.normalizedText || readback.text || '');
    const verified = normalizedActual === expectedText;
    const semanticRepaired = !verified
      ? await trySemanticSetTradingViewQuickSearchTypedValue(inputFocus, normalizedActual)
      : null;
    const canonicalized = !verified && !semanticRepaired
      ? await tryCanonicalizeTradingViewQuickSearchTypedValue(normalizedActual)
      : null;
    const repair = semanticRepaired || canonicalized;

    return {
      applicable: true,
      verified: repair ? repair.verified === true : verified,
      expectedText,
      actualText: repair ? repair.actualText : normalizedActual,
      inputFocus,
      readback: repair?.readback || readback,
      canonicalization: canonicalized?.canonicalization || null,
      semanticRepair: semanticRepaired?.semanticRepair || null,
      error: repair
        ? repair.error
        : (verified ? null : 'TradingView quick-search input readback did not match the typed query exactly')
    };
  }

  async function waitForTradingViewPineEditorEvidence(checkpointSpec, checkpointBeforeForeground, observationCheckpoint, options = {}, recoveryMeta = {}) {
    const probeWaitSteps = Array.isArray(options?.probeWaitSteps)
      ? options.probeWaitSteps
      : [0, 220, 480];
    let lastCheckpoint = null;
    let lastProbe = null;

    function hasStrictPineEditorEvidence(checkpoint, surfaceProbe) {
      if (surfaceProbe) return true;
      const foregroundTitle = String(checkpoint?.foreground?.title || '').trim();
      return !!(
        checkpoint?.watcherSurfaceMatched === true
        || checkpoint?.pineEditorTextProbeMatched === true
        || /\bpine\s+editor\b/i.test(foregroundTitle)
      );
    }

    for (const waitMs of probeWaitSteps) {
      const numericWaitMs = Number(waitMs || 0) || 0;
      if (numericWaitMs > 0) {
        await sleepMs(numericWaitMs);
      }

      lastCheckpoint = await verifyKeyObservationCheckpoint({
        ...checkpointSpec,
        requiresObservedChange: false
      }, checkpointBeforeForeground, {
        expectedWindowHandle: options.expectedWindowHandle
      });

      lastProbe = await probeTradingViewPineEditorSurface();
      if (hasStrictPineEditorEvidence(lastCheckpoint, lastProbe)) {
        const foreground = lastCheckpoint?.foreground?.success
          ? lastCheckpoint.foreground
          : await systemAutomation.getForegroundWindowInfo();
        return {
          recovered: true,
          checkpoint: {
            ...observationCheckpoint,
            ...(lastCheckpoint || {}),
            verified: true,
            error: null,
            editorActiveMatched: true,
            foreground,
            matchReason: recoveryMeta.matchReason || lastCheckpoint?.matchReason || 'pine-editor-surface-probe',
            recoveredBy: recoveryMeta.recoveredBy || 'surface-probe',
            pineEditorSurfaceProbe: lastProbe || null,
            recoveryEvidenceWait: {
              attempted: true,
              probeWaitSteps,
              matchedAfterWaitMs: numericWaitMs
            },
            ...(recoveryMeta.extraCheckpointFields || {})
          }
        };
      }
    }

    return {
      recovered: false,
      lastCheckpoint,
      lastProbe,
      recoveryEvidenceWait: {
        attempted: true,
        probeWaitSteps
      }
    };
  }

  async function tryRecoverTradingViewPineEditorOpenByKeyboardSelection(action, checkpointSpec, checkpointBeforeForeground, observationCheckpoint, options = {}) {
    if (typeof systemAutomation.pressKey !== 'function') {
      return null;
    }

    const expectedQuery = normalizeTradingViewQuickSearchInputText(
      options.expectedQuery
      || action?.text
      || action?.searchSurfaceContract?.searchText
      || 'Pine Editor'
    );

    const selectionReadback = await readTradingViewQuickSearchSelectionViaClipboard(action, {
      expectedWindowHandle: options.expectedWindowHandle || action?.windowHandle || action?.hwnd || 0
    });
    const currentQuery = normalizeTradingViewQuickSearchInputText(selectionReadback?.normalizedText || selectionReadback?.text || '');
    const queryStillPresent = !!expectedQuery
      && !!currentQuery
      && (currentQuery === expectedQuery || currentQuery.includes(expectedQuery));

    if (!selectionReadback?.success || !queryStillPresent) {
      return null;
    }

    const keyboardSelectionRecovery = {
      attempted: true,
      queryStillPresent,
      expectedQuery,
      selectionReadback,
      steps: []
    };

    try {
      await systemAutomation.pressKey('down', action);
      keyboardSelectionRecovery.steps.push({ key: 'down', success: true });
      await sleepMs(110);
      await systemAutomation.pressKey('enter', action);
      keyboardSelectionRecovery.steps.push({ key: 'enter', success: true });
    } catch (error) {
      keyboardSelectionRecovery.error = error?.message || String(error || 'Keyboard selection recovery failed');
      return {
        recovered: false,
        keyboardSelectionRecovery
      };
    }

    const evidence = await waitForTradingViewPineEditorEvidence(
      checkpointSpec,
      checkpointBeforeForeground,
      observationCheckpoint,
      options,
      {
        recoveredBy: 'keyboard-selection',
        matchReason: 'pine-editor-keyboard-selection-recovery',
        extraCheckpointFields: {
          keyboardSelectionRecovery
        }
      }
    );

    if (!evidence?.recovered) {
      return {
        recovered: false,
        keyboardSelectionRecovery,
        recoveryEvidenceWait: evidence?.recoveryEvidenceWait || null,
        lastCheckpoint: evidence?.lastCheckpoint || null,
        lastProbe: evidence?.lastProbe || null
      };
    }

    return {
      recovered: true,
      keyboardSelectionRecovery,
      checkpoint: evidence.checkpoint
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

    let shortcutRetry = null;
    let probeMatched = await probeTradingViewQuickSearchSurface(options.expectedWindowHandle);
    if (!probeMatched && options.allowShortcutRetry === true) {
      shortcutRetry = {
        attempted: false,
        success: false,
        skipped: true,
        expectedWindowHandle: Number(options.expectedWindowHandle || 0) || 0,
        error: 'Skipped quick-search shortcut retry because Ctrl+K toggles the TradingView desktop search surface'
      };
    }
    if (!probeMatched) {
      if (shortcutRetry) {
        return {
          recovered: false,
          checkpoint: {
            ...observationCheckpoint,
            verified: false,
            error: observationCheckpoint?.error || shortcutRetry.error || 'TradingView quick search surface was not observable after shortcut retry',
            quickSearchShortcutRetry: shortcutRetry
          }
        };
      }
      return null;
    }

    if (probeMatched.trusted !== true) {
      return {
        recovered: false,
        checkpoint: {
          ...observationCheckpoint,
          verified: false,
          error: observationCheckpoint?.error || `TradingView quick search probe matched an untrusted surface (${probeMatched.trustReason || 'unknown trust reason'})`,
          quickSearchSurfaceProbe: probeMatched,
          quickSearchShortcutRetry: shortcutRetry || null
        }
      };
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
        recoveredBy: shortcutRetry?.success
          ? 'shortcut-retry-semantic-input-focus'
          : (focusedInput?.focused ? 'semantic-input-focus' : 'surface-probe'),
        quickSearchSurfaceProbe: probeMatched,
        quickSearchInputFocus: focusedInput || null,
        quickSearchShortcutRetry: shortcutRetry || null
      }
    };
  }

  async function tryRecoverOfficialDirectPineEditorOpenViaQuickSearch(action, checkpointSpec, checkpointBeforeForeground, observationCheckpoint, options = {}) {
    const route = String(action?.searchSurfaceContract?.route || '').trim().toLowerCase();
    const directShortcutId = String(
      action?.searchSurfaceContract?.entryShortcutId
      || action?.tradingViewShortcut?.id
      || ''
    ).trim().toLowerCase();
    const key = String(action?.key || '').trim().toLowerCase();
    if (route !== 'official-direct' || !['new-pine-indicator', 'new-pine-strategy'].includes(directShortcutId) || !['ctrl+i', 'ctrl+s'].includes(key)) {
      return null;
    }
    if (typeof systemAutomation.pressKey !== 'function') {
      return null;
    }

    const fallback = {
      attempted: true,
      route,
      directShortcutId,
      steps: []
    };

    const quickSearchRetry = await retryOpenTradingViewQuickSearchShortcut(action, {
      ...options,
      allowShortcutRetry: true,
      retryWaitMs: 560
    });
    fallback.quickSearchRetry = quickSearchRetry;
    if (!quickSearchRetry?.success) {
      return {
        recovered: false,
        officialDirectFallback: fallback,
        error: quickSearchRetry?.error || 'Could not open TradingView quick search after official Pine shortcut failed'
      };
    }

    const preferredWindowHandle = Number(
      quickSearchRetry?.probe?.trustedWindow?.hwnd
      || quickSearchRetry?.probe?.element?.WindowHandle
      || options.expectedWindowHandle
      || 0
    ) || 0;
    const inputFocus = await focusTradingViewQuickSearchInput(preferredWindowHandle);
    fallback.inputFocus = inputFocus || null;
    if (!inputFocus?.focused) {
      return {
        recovered: false,
        officialDirectFallback: fallback,
        error: 'Could not focus TradingView quick-search input for Pine Editor fallback'
      };
    }

    const expectedQuery = 'Pine Editor';
    let setQuery = await trySetTradingViewQuickSearchInputValue(inputFocus, expectedQuery);
    fallback.setQuery = setQuery;
    if (!setQuery?.success && typeof systemAutomation.typeText === 'function') {
      try {
        await systemAutomation.pressKey('ctrl+a', action);
        await sleepMs(80);
        await systemAutomation.typeText(expectedQuery);
        setQuery = { success: true, method: 'keyboard-typeText' };
        fallback.setQuery = setQuery;
      } catch (error) {
        fallback.setQuery = {
          success: false,
          error: error?.message || String(error || 'Quick-search fallback typing failed')
        };
      }
    }
    if (!fallback.setQuery?.success) {
      return {
        recovered: false,
        officialDirectFallback: fallback,
        error: fallback.setQuery?.error || 'Could not write Pine Editor query into TradingView quick search'
      };
    }

    await sleepMs(220);
    const readback = await readTradingViewQuickSearchInputValue(inputFocus);
    fallback.readback = readback;
    const actualQuery = normalizeTradingViewQuickSearchInputText(readback?.normalizedText || readback?.text || '');
    if (readback?.success && actualQuery && actualQuery !== expectedQuery) {
      return {
        recovered: false,
        officialDirectFallback: fallback,
        error: `TradingView quick-search fallback query readback mismatch (${actualQuery})`
      };
    }

    try {
      await systemAutomation.pressKey('enter', {
        ...action,
        reason: 'Confirm TradingView Pine Editor quick-search fallback after official Pine shortcut produced no editor evidence'
      });
      fallback.steps.push({ key: 'enter', success: true });
    } catch (error) {
      fallback.steps.push({ key: 'enter', success: false, error: error?.message || String(error || 'enter failed') });
      return {
        recovered: false,
        officialDirectFallback: fallback,
        error: error?.message || String(error || 'Could not confirm Pine Editor quick-search fallback')
      };
    }

    const evidence = await waitForTradingViewPineEditorEvidence(
      checkpointSpec,
      checkpointBeforeForeground,
      observationCheckpoint,
      {
        ...options,
        probeWaitSteps: [260, 640, 1100]
      },
      {
        recoveredBy: 'official-direct-quick-search-fallback',
        matchReason: 'pine-editor-official-direct-fallback',
        extraCheckpointFields: {
          officialDirectFallback: fallback
        }
      }
    );
    if (!evidence?.recovered) {
      return {
        recovered: false,
        officialDirectFallback: fallback,
        recoveryEvidenceWait: evidence?.recoveryEvidenceWait || null,
        lastCheckpoint: evidence?.lastCheckpoint || null,
        lastProbe: evidence?.lastProbe || null
      };
    }

    return {
      recovered: true,
      officialDirectFallback: fallback,
      checkpoint: evidence.checkpoint
    };
  }

  async function maybeRecoverTradingViewPineEditorOpen(action, checkpointSpec, checkpointBeforeForeground, observationCheckpoint, options = {}) {
    const routeId = String(action?.searchSurfaceContract?.id || '').trim().toLowerCase();
    const verifyTarget = String(action?.verify?.target || '').trim().toLowerCase();
    const key = String(action?.key || '').trim().toLowerCase();
    const route = String(action?.searchSurfaceContract?.route || '').trim().toLowerCase();
    const directShortcutId = String(
      action?.searchSurfaceContract?.entryShortcutId
      || action?.tradingViewShortcut?.id
      || ''
    ).trim().toLowerCase();
    const isQuickSearchCommit = key === 'enter';
    const isOfficialDirectCommit = route === 'official-direct'
      && ['new-pine-indicator', 'new-pine-strategy'].includes(directShortcutId)
      && ['ctrl+i', 'ctrl+s'].includes(key);
    if (routeId !== 'open-pine-editor' || verifyTarget !== 'pine-editor' || (!isQuickSearchCommit && !isOfficialDirectCommit)) {
      return null;
    }

    const passiveEvidence = await waitForTradingViewPineEditorEvidence(
      checkpointSpec,
      checkpointBeforeForeground,
      observationCheckpoint,
      options,
      {
        recoveredBy: 'surface-probe',
        matchReason: 'pine-editor-surface-probe'
      }
    );
    if (passiveEvidence?.recovered) {
      return passiveEvidence;
    }

    if (isOfficialDirectCommit) {
      const officialDirectFallback = await tryRecoverOfficialDirectPineEditorOpenViaQuickSearch(
        action,
        checkpointSpec,
        checkpointBeforeForeground,
        observationCheckpoint,
        options
      );
      if (officialDirectFallback?.checkpoint) {
        return officialDirectFallback;
      }
    }

    if (typeof systemAutomation.click !== 'function') {
      return await tryRecoverTradingViewPineEditorOpenByKeyboardSelection(
        action,
        checkpointSpec,
        checkpointBeforeForeground,
        observationCheckpoint,
        options
      );
    }

    const foreground = await systemAutomation.getForegroundWindowInfo();
    const expectedWindowHandle = Number(options.expectedWindowHandle || 0)
      || Number(foreground?.hwnd || 0)
      || 0;
    const expectedProcessName = foreground?.processName || '';
    const allowGlobalFallback = expectedWindowHandle <= 0;

    for (const candidate of PINE_EDITOR_RESULT_CLICK_CANDIDATES) {
      const matchedResult = await findForegroundElementByText(candidate.text, {
        exact: candidate.exact,
        windowHandle: expectedWindowHandle,
        allowWindowFamily: true,
        allowGlobalFallback
      });
      if (!matchedResult?.element?.Bounds) {
        continue;
      }

      const trust = await isTrustedTradingViewQuickSearchMatch(matchedResult, {
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

      const evidence = await waitForTradingViewPineEditorEvidence(
        checkpointSpec,
        checkpointBeforeForeground,
        observationCheckpoint,
        options,
        {
          recoveredBy: 'semantic-click',
          matchReason: 'pine-editor-semantic-click-recovery',
          extraCheckpointFields: {
            pineEditorResultClick: {
              text: candidate.text,
              exact: candidate.exact
            }
          }
        }
      );
      if (evidence?.recovered) {
        return {
          recovered: true,
          clickResult,
          checkpoint: evidence.checkpoint
        };
      }
    }

    const keyboardSelectionRecovery = await tryRecoverTradingViewPineEditorOpenByKeyboardSelection(
      action,
      checkpointSpec,
      checkpointBeforeForeground,
      observationCheckpoint,
      options
    );
    if (keyboardSelectionRecovery?.checkpoint) {
      return keyboardSelectionRecovery;
    }

    return null;
  }

  return {
    detectTradingViewPineEditorQuickSearchResult,
    ensureTradingViewQuickSearchInputClearBeforeTyping,
    verifyTradingViewQuickSearchTypedValue,
    maybeRecoverTradingViewQuickSearchOpen,
    maybeRecoverTradingViewPineEditorOpen
  };
}

module.exports = {
  createTradingViewRuntimeRecovery
};
