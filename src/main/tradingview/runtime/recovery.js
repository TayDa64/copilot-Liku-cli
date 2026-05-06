const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

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

  const TRADINGVIEW_QUICK_SEARCH_EDIT_SCORE_MIN = 260;
  const TRADINGVIEW_QUICK_SEARCH_EDIT_SCORE_GAP_MIN = 40;

  function normalizeQuickSearchWindowProcessName(value = '') {
    return String(value || '').trim().toLowerCase();
  }

  async function runClipboardPowerShell(script = '') {
    const normalizedScript = String(script || '').trim();
    if (!normalizedScript) {
      throw new Error('Clipboard PowerShell script was not provided');
    }

    if (typeof systemAutomation.executeCommand === 'function') {
      const result = await systemAutomation.executeCommand(normalizedScript, {
        shell: 'powershell',
        timeout: 15000
      });
      if (result?.success === false) {
        throw new Error(result?.error || 'Clipboard PowerShell command failed');
      }
      return {
        stdout: String(result?.stdout || ''),
        stderr: String(result?.stderr || '')
      };
    }

    if (process.platform !== 'win32') {
      throw new Error('TradingView clipboard fallback requires Windows PowerShell');
    }

    return execFileAsync('powershell', ['-NoProfile', '-Command', normalizedScript], {
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
  }

  async function readClipboardText() {
    if (typeof systemAutomation.getClipboardText === 'function') {
      try {
        const result = await systemAutomation.getClipboardText();
        if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'success')) {
          return {
            success: result.success === true,
            text: String(result.text || ''),
            error: result.error || null
          };
        }
        return {
          success: true,
          text: String(result || ''),
          error: null
        };
      } catch (error) {
        return {
          success: false,
          text: '',
          error: error?.message || String(error || 'Clipboard read failed')
        };
      }
    }

    try {
      const { stdout } = await runClipboardPowerShell(`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  $value = Get-Clipboard -Raw
  if ($null -eq $value) { $value = '' }
  [Console]::Out.Write((@{ success = $true; text = [string]$value; error = $null } | ConvertTo-Json -Compress -Depth 4))
} catch {
  [Console]::Out.Write((@{ success = $false; text = ''; error = $_.Exception.Message } | ConvertTo-Json -Compress -Depth 4))
}
      `);
      const parsed = JSON.parse(String(stdout || '').trim() || '{}');
      return {
        success: parsed?.success === true,
        text: String(parsed?.text || ''),
        error: parsed?.error || null
      };
    } catch (error) {
      return {
        success: false,
        text: '',
        error: error?.message || String(error || 'Clipboard read failed')
      };
    }
  }

  async function writeClipboardText(text = '') {
    const normalizedText = String(text ?? '');

    if (typeof systemAutomation.setClipboardText === 'function') {
      try {
        const result = await systemAutomation.setClipboardText(normalizedText);
        if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'success')) {
          return {
            success: result.success === true,
            error: result.error || null
          };
        }
        return { success: true, error: null };
      } catch (error) {
        return {
          success: false,
          error: error?.message || String(error || 'Clipboard write failed')
        };
      }
    }

    try {
      const encoded = Buffer.from(normalizedText, 'utf8').toString('base64');
      await runClipboardPowerShell(`
$ErrorActionPreference = 'Stop'
$value = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encoded}'))
Set-Clipboard -Value $value
      `);
      return { success: true, error: null };
    } catch (error) {
      return {
        success: false,
        error: error?.message || String(error || 'Clipboard write failed')
      };
    }
  }

  async function getTrustedTradingViewQuickSearchForeground(preferredWindowHandle = 0) {
    let foreground = null;
    try {
      foreground = await systemAutomation.getForegroundWindowInfo();
    } catch {
      foreground = null;
    }

    if (!foreground?.success) {
      return null;
    }

    if (normalizeQuickSearchWindowProcessName(foreground?.processName || '') !== 'tradingview') {
      return null;
    }

    const expectedWindowHandle = Number(preferredWindowHandle || 0) || 0;
    const foregroundHandle = Number(foreground?.hwnd || 0) || 0;
    if (!expectedWindowHandle || !foregroundHandle || expectedWindowHandle === foregroundHandle) {
      return foreground;
    }

    const trustedWindow = await getQuickSearchTrustedWindowInfo(expectedWindowHandle, foreground);
    if (!trustedWindow) {
      return null;
    }

    if (normalizeQuickSearchWindowProcessName(trustedWindow?.processName || '') !== 'tradingview') {
      return null;
    }

    if ((Number(trustedWindow?.hwnd || 0) || 0) !== expectedWindowHandle) {
      return null;
    }

    return foreground;
  }

  async function collapseTradingViewQuickSearchSelection(action = {}, collapseKey = 'right') {
    const selectionReset = {
      attempted: false,
      success: false,
      collapseKey,
      foreground: null
    };

    if (typeof systemAutomation.pressKey !== 'function') {
      return selectionReset;
    }

    selectionReset.attempted = true;
    try {
      await systemAutomation.pressKey(collapseKey, action);
      await sleepMs(60);
      selectionReset.success = true;
    } catch (error) {
      selectionReset.error = error?.message || String(error || 'Selection collapse failed');
    }

    try {
      selectionReset.foreground = await systemAutomation.getForegroundWindowInfo();
    } catch {
      selectionReset.foreground = null;
    }

    return selectionReset;
  }

  async function readTradingViewQuickSearchClipboardSelection(action = {}, preferredWindowHandle = 0) {
    const foreground = await getTrustedTradingViewQuickSearchForeground(preferredWindowHandle);
    if (!foreground) {
      return {
        success: false,
        text: '',
        normalizedText: '',
        empty: false,
        plausible: false,
        sentinelMatched: false,
        method: 'clipboard-selection',
        foreground: null,
        originalClipboard: { success: false, text: '', error: 'TradingView foreground was not trusted for clipboard selection' },
        capturedClipboard: { success: false, text: '', error: 'TradingView foreground was not trusted for clipboard selection' },
        selectionReset: { attempted: false, success: false, collapseKey: 'right', foreground: null },
        error: 'TradingView foreground was not trusted for clipboard selection'
      };
    }

    if (typeof systemAutomation.pressKey !== 'function') {
      return {
        success: false,
        text: '',
        normalizedText: '',
        empty: false,
        plausible: false,
        sentinelMatched: false,
        method: 'clipboard-selection',
        foreground,
        originalClipboard: { success: false, text: '', error: 'Keyboard automation is unavailable for clipboard selection' },
        capturedClipboard: { success: false, text: '', error: 'Keyboard automation is unavailable for clipboard selection' },
        selectionReset: { attempted: false, success: false, collapseKey: 'right', foreground },
        error: 'Keyboard automation is unavailable for clipboard selection'
      };
    }

    const originalClipboard = await readClipboardText();
    const sentinel = `__LIKU_QS_${Date.now()}_${Math.random().toString(36).slice(2, 8)}__`;
    const sentinelWrite = await writeClipboardText(sentinel);
    if (!sentinelWrite.success) {
      return {
        success: false,
        text: '',
        normalizedText: '',
        empty: false,
        plausible: false,
        sentinelMatched: false,
        method: 'clipboard-selection',
        foreground,
        originalClipboard,
        capturedClipboard: { success: false, text: '', error: sentinelWrite.error || 'Could not seed clipboard selection sentinel' },
        selectionReset: { attempted: false, success: false, collapseKey: 'right', foreground },
        error: sentinelWrite.error || 'Could not seed clipboard selection sentinel'
      };
    }

    let capturedClipboard = { success: false, text: '', error: 'Clipboard selection copy did not complete' };
    let selectionReset = { attempted: false, success: false, collapseKey: 'right', foreground };
    let restoreClipboard = null;
    try {
      await systemAutomation.pressKey('ctrl+a', action);
      await sleepMs(80);
      await systemAutomation.pressKey('ctrl+c', action);
      await sleepMs(100);
      capturedClipboard = await readClipboardText();
    } catch (error) {
      capturedClipboard = {
        success: false,
        text: '',
        error: error?.message || String(error || 'Clipboard selection copy failed')
      };
    } finally {
      selectionReset = await collapseTradingViewQuickSearchSelection(action, 'right');
      restoreClipboard = originalClipboard.success
        ? await writeClipboardText(originalClipboard.text)
        : { success: false, error: originalClipboard.error || 'Original clipboard could not be restored because it could not be read' };
    }

    const capturedText = String(capturedClipboard?.text || '');
    const sentinelMatched = capturedText === sentinel;
    const normalizedText = sentinelMatched
      ? ''
      : normalizeTradingViewQuickSearchInputText(capturedText);
    const empty = sentinelMatched
      ? true
      : isTradingViewQuickSearchInputEmpty(capturedText);
    const plausible = capturedClipboard.success === true && !sentinelMatched;

    const result = {
      success: plausible,
      text: capturedText,
      normalizedText,
      empty,
      plausible,
      sentinelMatched,
      method: 'clipboard-selection',
      foreground,
      originalClipboard,
      capturedClipboard,
      selectionReset,
      restoreClipboard,
      error: null
    };

    if (!capturedClipboard.success) {
      result.error = capturedClipboard.error || 'Clipboard selection copy failed';
      return result;
    }

    if (sentinelMatched) {
      result.error = 'Clipboard selection copy did not capture a TradingView quick-search value';
      result.inferredEmpty = true;
      return result;
    }

    return result;
  }

  async function maybeAssumeTradingViewQuickSearchFocusedFromClipboard(action, preferredWindowHandle = 0) {
    const foreground = await getTrustedTradingViewQuickSearchForeground(preferredWindowHandle);
    if (!foreground) {
      return null;
    }

    const clipboardFocus = {
      focused: true,
      recoveredBy: 'clipboard-selection-miss',
      foreground,
      trusted: true,
      trustReason: 'foreground-window',
      trustedWindow: foreground
    };
    const initialRead = await readTradingViewQuickSearchClipboardSelection(action, preferredWindowHandle);

    if (initialRead.inferredEmpty) {
      return {
        applicable: true,
        ready: true,
        emptyConfirmed: false,
        queryAlreadyPresent: false,
        fallbackAssumedFocused: true,
        fallbackReason: 'TradingView quick-search selection copy captured no stale text after ctrl+k; treat as empty-field continuation and require post-type verification before Enter',
        clearedBy: 'clipboard-selection-miss-assumed-empty',
        expectedText: null,
        inputFocus: clipboardFocus,
        focusRecovery: clipboardFocus,
        initialRead,
        finalRead: initialRead,
        error: null
      };
    }

    if (!initialRead.success) {
      return {
        applicable: true,
        ready: false,
        error: initialRead.error || 'Clipboard selection could not confirm the TradingView quick-search field before typing',
        inputFocus: clipboardFocus,
        focusRecovery: clipboardFocus,
        fallbackAssumedFocused: true,
        fallbackReason: initialRead.error || 'clipboard-selection-failed',
        initialRead,
        finalRead: initialRead
      };
    }

    if (initialRead.empty) {
      return {
        applicable: true,
        ready: true,
        emptyConfirmed: true,
        clearedBy: 'already-empty-clipboard-selection',
        inputFocus: clipboardFocus,
        focusRecovery: clipboardFocus,
        fallbackAssumedFocused: false,
        fallbackReason: 'clipboard-selection',
        initialRead,
        finalRead: initialRead,
        error: null
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
      await sleepMs(90);
      keyboardFallback.success = true;
    } catch (error) {
      keyboardFallback.error = error?.message || String(error || 'Keyboard fallback failed');
    }

    const finalRead = await readTradingViewQuickSearchClipboardSelection(action, preferredWindowHandle);
    if (finalRead.success && finalRead.empty) {
      return {
        applicable: true,
        ready: true,
        emptyConfirmed: true,
        clearedBy: 'keyboard-fallback-clipboard-selection',
        inputFocus: clipboardFocus,
        focusRecovery: clipboardFocus,
        fallbackAssumedFocused: false,
        fallbackReason: 'clipboard-selection',
        initialRead,
        keyboardFallback,
        finalRead,
        error: null
      };
    }

    if (finalRead.inferredEmpty) {
      return {
        applicable: true,
        ready: true,
        emptyConfirmed: false,
        queryAlreadyPresent: false,
        fallbackAssumedFocused: true,
        fallbackReason: 'TradingView quick-search selection copy captured no stale text after ctrl+k; treat as empty-field continuation and require post-type verification before Enter',
        clearedBy: 'clipboard-selection-miss-assumed-empty',
        expectedText: null,
        inputFocus: clipboardFocus,
        focusRecovery: clipboardFocus,
        initialRead,
        keyboardFallback,
        finalRead,
        error: null
      };
    }

    return {
      applicable: true,
      ready: false,
      error: finalRead.error || 'TradingView quick-search input could not be proven empty before typing the query',
      inputFocus: clipboardFocus,
      focusRecovery: clipboardFocus,
      fallbackAssumedFocused: true,
      fallbackReason: finalRead.error || 'clipboard-selection-failed',
      initialRead,
      keyboardFallback,
      finalRead
    };
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

  function getNormalizedBoundsGeometry(bounds = null) {
    if (!bounds || typeof bounds !== 'object') {
      return null;
    }

    const rawX = bounds.x ?? bounds.X ?? bounds.left ?? bounds.Left;
    const rawY = bounds.y ?? bounds.Y ?? bounds.top ?? bounds.Top;
    const rawWidth = bounds.width ?? bounds.Width;
    const rawHeight = bounds.height ?? bounds.Height;
    const rawRight = bounds.right ?? bounds.Right;
    const rawBottom = bounds.bottom ?? bounds.Bottom;

    const x = Number(rawX);
    const y = Number(rawY);
    let width = Number(rawWidth);
    let height = Number(rawHeight);

    if (!Number.isFinite(width) && Number.isFinite(Number(rawRight)) && Number.isFinite(x)) {
      width = Number(rawRight) - x;
    }
    if (!Number.isFinite(height) && Number.isFinite(Number(rawBottom)) && Number.isFinite(y)) {
      height = Number(rawBottom) - y;
    }

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
      return null;
    }

    if (width <= 0 || height <= 0) {
      return null;
    }

    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
      centerX: Math.round(x + width / 2),
      centerY: Math.round(y + height / 2)
    };
  }

  function buildTradingViewQuickSearchEditBounds(windowInfo = {}) {
    const bounds = getNormalizedBoundsGeometry(windowInfo?.bounds || windowInfo?.Bounds);
    if (!bounds || bounds.width < 320 || bounds.height < 220) {
      return null;
    }

    const horizontalInset = Math.max(72, Math.round(bounds.width * 0.18));
    return {
      minX: bounds.x + horizontalInset,
      maxX: bounds.x + bounds.width - horizontalInset,
      minY: bounds.y + 16,
      maxY: bounds.y + Math.max(180, Math.round(bounds.height * 0.5))
    };
  }

  function getUsableTradingViewWindowBounds(windowInfo = {}) {
    const bounds = getNormalizedBoundsGeometry(windowInfo?.bounds || windowInfo?.Bounds);
    if (!bounds) {
      return null;
    }

    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height
    };
  }

  function computeTradingViewChartFocusPoint(windowInfo = {}) {
    const usable = getUsableTradingViewWindowBounds(windowInfo);
    if (!usable) {
      return null;
    }

    return {
      x: Math.round(usable.x + usable.width * 0.5),
      y: Math.round(usable.y + usable.height * 0.38)
    };
  }

  function scoreTradingViewQuickSearchEditCandidate(candidate, trustedWindow = {}) {
    const candidateBounds = getNormalizedBoundsGeometry(candidate?.Bounds || candidate?.bounds);
    const windowBounds = getNormalizedBoundsGeometry(trustedWindow?.bounds || trustedWindow?.Bounds);
    if (!candidateBounds || !windowBounds) {
      return Number.NEGATIVE_INFINITY;
    }

    if (candidateBounds.width < Math.max(180, Math.round(windowBounds.width * 0.14))) {
      return Number.NEGATIVE_INFINITY;
    }

    if (candidateBounds.height < 18 || candidateBounds.height > 80) {
      return Number.NEGATIVE_INFINITY;
    }

    const name = String(candidate?.Name || candidate?.name || '').trim().toLowerCase();
    const automationId = String(candidate?.AutomationId || candidate?.automationId || '').trim().toLowerCase();
    const className = String(candidate?.ClassName || candidate?.className || '').trim().toLowerCase();
    const controlType = String(candidate?.ControlType || candidate?.controlType || '').trim().toLowerCase();
    const patterns = Array.isArray(candidate?.Patterns || candidate?.patterns)
      ? (candidate?.Patterns || candidate?.patterns).map((value) => String(value || '').trim().toLowerCase())
      : [];

    const haystack = [name, automationId, className].filter(Boolean).join(' ');
    const idealCenterX = windowBounds.x + windowBounds.width / 2;
    const idealCenterY = windowBounds.y + Math.min(180, Math.max(120, windowBounds.height * 0.18));

    let score = 0;
    score += Math.max(0, 340 - Math.abs(candidateBounds.centerX - idealCenterX));
    score += Math.max(0, 220 - Math.abs(candidateBounds.centerY - idealCenterY));
    score += Math.min(240, candidateBounds.width);
    score += Math.max(0, 90 - Math.abs(candidateBounds.height - 34));

    if (/edit/.test(controlType)) score += 60;
    if (/search|filter|query|command/.test(haystack)) score += 180;
    if (!name) score += 40;
    if (patterns.some((value) => /valuepattern|textpattern|legacyiaccessiblepattern/.test(value))) {
      score += 60;
    }

    return score;
  }

  async function findTrustedTradingViewQuickSearchEdit(preferredWindowHandle = 0) {
    let foreground = null;
    try {
      foreground = await systemAutomation.getForegroundWindowInfo();
    } catch {
      foreground = null;
    }

    const trustedWindowHandle = Number(preferredWindowHandle || 0)
      || Number(foreground?.hwnd || 0)
      || 0;

    let trustedWindow = null;
    if (trustedWindowHandle > 0) {
      trustedWindow = await getQuickSearchTrustedWindowInfo(trustedWindowHandle, foreground);
    }
    if (!trustedWindow && foreground?.success) {
      trustedWindow = foreground;
    }

    if (normalizeQuickSearchWindowProcessName(trustedWindow?.processName || '') !== 'tradingview') {
      return null;
    }

    const searchBounds = buildTradingViewQuickSearchEditBounds(trustedWindow);
    if (!searchBounds) {
      return null;
    }

    let uia = null;
    try {
      uia = require('../../ui-automation');
    } catch {
      uia = null;
    }

    if (!uia || typeof uia.findElements !== 'function') {
      return null;
    }

    let matchedEdits = null;
    try {
      matchedEdits = await uia.findElements({
        controlType: 'Edit',
        isEnabled: true,
        bounds: searchBounds
      });
    } catch {
      matchedEdits = null;
    }

    const elements = Array.isArray(matchedEdits?.elements) ? matchedEdits.elements : [];
    const scoredCandidates = elements
      .map((element) => ({
        element,
        score: scoreTradingViewQuickSearchEditCandidate(element, trustedWindow)
      }))
      .filter((entry) => Number.isFinite(entry.score) && entry.score >= TRADINGVIEW_QUICK_SEARCH_EDIT_SCORE_MIN)
      .sort((left, right) => right.score - left.score);

    if (!scoredCandidates.length) {
      return null;
    }

    if (
      scoredCandidates.length > 1
      && (scoredCandidates[0].score - scoredCandidates[1].score) < TRADINGVIEW_QUICK_SEARCH_EDIT_SCORE_GAP_MIN
    ) {
      return null;
    }

    const bestCandidate = scoredCandidates[0];
    return {
      matched: true,
      text: String(bestCandidate.element?.Name || bestCandidate.element?.name || '').trim(),
      exact: false,
      controlType: 'Edit',
      matchedBy: 'trusted-window-bounds-edit',
      element: bestCandidate.element,
      foreground,
      trusted: true,
      trustReason: 'trusted-window-bounds-edit',
      trustedWindow,
      searchBounds,
      candidateScore: bestCandidate.score
    };
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

    for (const candidate of TRADINGVIEW_QUICK_SEARCH_SURFACE_PROBE_CANDIDATES) {
      const matched = await findForegroundElementByText(candidate.text, {
        exact: candidate.exact,
        controlType: candidate.controlType,
        windowHandle: preferredWindowHandle,
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

    const unnamedEditMatch = await findTrustedTradingViewQuickSearchEdit(expectedWindowHandle);
    if (unnamedEditMatch) {
      return unnamedEditMatch;
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

  async function clickTradingViewQuickSearchMatch(inputMatch) {
    if (typeof systemAutomation.click !== 'function') {
      return {
        success: false,
        error: 'TradingView quick-search click automation is unavailable'
      };
    }

    const bounds = inputMatch?.element?.Bounds || null;
    if (!bounds) {
      return {
        success: false,
        error: 'TradingView quick-search bounds were not available for clicking'
      };
    }

    const clickResult = {
      success: true,
      coordinates: {
        x: bounds.CenterX,
        y: bounds.CenterY
      }
    };

    try {
      await systemAutomation.click(bounds.CenterX, bounds.CenterY, 'left');
      await sleepMs(160);
    } catch (error) {
      clickResult.success = false;
      clickResult.error = error?.message || String(error || 'click failed');
    }

    return clickResult;
  }

  async function focusTradingViewQuickSearchInput(preferredWindowHandle = 0) {
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

      const clickResult = await clickTradingViewQuickSearchMatch(matched);
      if (!clickResult.success) {
        continue;
      }

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

    const unnamedEditMatch = await findTrustedTradingViewQuickSearchEdit(expectedWindowHandle);
    if (unnamedEditMatch?.element?.Bounds) {
      const clickResult = await clickTradingViewQuickSearchMatch(unnamedEditMatch);
      if (clickResult.success) {
        return {
          focused: true,
          text: unnamedEditMatch.text || '',
          exact: unnamedEditMatch.exact,
          controlType: unnamedEditMatch.controlType,
          matchedBy: unnamedEditMatch.matchedBy || 'trusted-window-bounds-edit',
          element: unnamedEditMatch.element,
          foreground: unnamedEditMatch.foreground,
          trusted: true,
          trustReason: unnamedEditMatch.trustReason || null,
          trustedWindow: unnamedEditMatch.trustedWindow || null,
          clickResult,
          candidateScore: unnamedEditMatch.candidateScore || null,
          searchBounds: unnamedEditMatch.searchBounds || null
        };
      }
    }

    return null;
  }

  async function recoverTradingViewQuickSearchInputFocus(preferredWindowHandle = 0) {
    const surfaceProbe = await probeTradingViewQuickSearchSurface(preferredWindowHandle);
    if (!surfaceProbe?.element?.Bounds) {
      return null;
    }

    if (!surfaceProbe?.trusted) {
      return {
        focused: false,
        recoveredBy: null,
        surfaceProbe,
        error: surfaceProbe?.trustReason
          ? `TradingView quick-search recovery rejected an untrusted surface (${surfaceProbe.trustReason})`
          : 'TradingView quick-search recovery rejected an untrusted surface'
      };
    }

    const surfaceClick = await clickTradingViewQuickSearchMatch(surfaceProbe);
    if (!surfaceClick.success) {
      return {
        focused: false,
        recoveredBy: null,
        surfaceProbe,
        surfaceClick,
        error: surfaceClick.error || 'Could not click the trusted TradingView quick-search surface'
      };
    }

    const trustedWindowHandle = Number(preferredWindowHandle || 0)
      || Number(surfaceProbe?.trustedWindow?.hwnd || 0)
      || Number(surfaceProbe?.element?.WindowHandle || 0)
      || Number(surfaceProbe?.foreground?.hwnd || 0)
      || 0;

    const retriedFocus = await focusTradingViewQuickSearchInput(trustedWindowHandle);
    if (retriedFocus?.focused) {
      return {
        ...retriedFocus,
        recoveredBy: 'trusted-surface-refocus',
        surfaceProbe,
        surfaceClick
      };
    }

    if (String(surfaceProbe?.controlType || '').trim().toLowerCase() === 'edit') {
      return {
        focused: true,
        text: surfaceProbe.text,
        exact: surfaceProbe.exact,
        controlType: surfaceProbe.controlType,
        matchedBy: surfaceProbe.matchedBy || 'trusted-surface-probe',
        element: surfaceProbe.element,
        foreground: surfaceProbe.foreground,
        trusted: true,
        trustReason: surfaceProbe.trustReason || null,
        trustedWindow: surfaceProbe.trustedWindow || null,
        clickResult: surfaceClick,
        recoveredBy: 'trusted-surface-edit',
        surfaceProbe,
        retryFocus: retriedFocus || null
      };
    }

    return {
      focused: false,
      recoveredBy: null,
      surfaceProbe,
      surfaceClick,
      retryFocus: retriedFocus || null,
      error: 'Trusted TradingView quick-search surface was present, but the semantic input could not be re-focused after clicking it'
    };
  }

  async function ensureTradingViewQuickSearchInputClearBeforeTyping(action, preferredWindowHandle = 0) {
    if (String(action?.type || '').trim().toLowerCase() !== 'type') {
      return { applicable: false, ready: true };
    }

    if (String(action?.searchSurfaceContract?.route || '').trim().toLowerCase() !== 'quick-search') {
      return { applicable: false, ready: true };
    }

    let inputFocus = await focusTradingViewQuickSearchInput(preferredWindowHandle);
    let focusRecovery = null;
    if (!inputFocus?.focused) {
      focusRecovery = await recoverTradingViewQuickSearchInputFocus(preferredWindowHandle);
      if (focusRecovery?.focused) {
        inputFocus = focusRecovery;
      }
    }

    if (!inputFocus?.focused) {
      const rejectedSurface = focusRecovery?.surfaceProbe && focusRecovery?.surfaceProbe?.trusted === false;
      if (!rejectedSurface) {
        const clipboardFallback = await maybeAssumeTradingViewQuickSearchFocusedFromClipboard(action, preferredWindowHandle);
        if (clipboardFallback) {
          return clipboardFallback;
        }
      }

      return {
        applicable: true,
        ready: false,
        error: 'Could not re-focus the TradingView quick-search input before typing',
        inputFocus: inputFocus || null,
        focusRecovery: focusRecovery || null,
        fallbackAssumedFocused: false,
        fallbackReason: focusRecovery?.recoveredBy || focusRecovery?.error || null
      };
    }

    const initialRead = await readTradingViewQuickSearchInputValue(inputFocus);
    if (!initialRead.success) {
      return {
        applicable: true,
        ready: false,
        error: initialRead.error || 'Could not read the TradingView quick-search input before typing',
        inputFocus,
        focusRecovery,
        fallbackAssumedFocused: false,
        fallbackReason: focusRecovery?.recoveredBy || null,
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
        focusRecovery,
        fallbackAssumedFocused: false,
        fallbackReason: focusRecovery?.recoveredBy || null,
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
        focusRecovery,
        fallbackAssumedFocused: false,
        fallbackReason: focusRecovery?.recoveredBy || null,
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
        focusRecovery,
        fallbackAssumedFocused: false,
        fallbackReason: focusRecovery?.recoveredBy || null,
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
      focusRecovery,
      fallbackAssumedFocused: false,
      fallbackReason: focusRecovery?.recoveredBy || null,
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

    const probeMatched = await probeTradingViewQuickSearchSurface(options.expectedWindowHandle || 0);
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

    const trustedWindowHandle = Number(options.expectedWindowHandle || 0)
      || Number(observationCheckpoint?.foreground?.hwnd || 0)
      || Number(checkpointBeforeForeground?.hwnd || 0)
      || 0;

    const trustedWindow = await getQuickSearchTrustedWindowInfo(trustedWindowHandle, checkpointBeforeForeground);
    const chartFocusPoint = computeTradingViewChartFocusPoint(trustedWindow || checkpointBeforeForeground || observationCheckpoint?.foreground || null);
    if (chartFocusPoint && typeof systemAutomation.click === 'function' && typeof systemAutomation.pressKey === 'function') {
      let dismissQuickSearch = {
        success: true,
        key: 'escape'
      };
      try {
        await systemAutomation.pressKey('escape', {
          searchSurfaceContract: {
            appName: 'TradingView'
          }
        });
        await sleepMs(140);
      } catch (error) {
        dismissQuickSearch = {
          success: false,
          key: 'escape',
          error: error?.message || String(error || 'TradingView quick-search dismissal failed')
        };
      }

      if (!dismissQuickSearch.success) {
        return null;
      }

      const chartFocusClick = {
        success: true,
        coordinates: chartFocusPoint
      };

      try {
        await systemAutomation.click(chartFocusPoint.x, chartFocusPoint.y, 'left');
        await sleepMs(240);
      } catch (error) {
        chartFocusClick.success = false;
        chartFocusClick.error = error?.message || String(error || 'TradingView chart-focus click failed');
      }

      if (chartFocusClick.success) {
        let directShortcut = {
          success: true,
          key: 'ctrl+e'
        };
        try {
          await systemAutomation.pressKey('ctrl+e', {
            tradingViewShortcut: {
              id: 'open-pine-editor',
              surface: 'pine-editor'
            },
            searchSurfaceContract: {
              appName: 'TradingView'
            }
          });
          await sleepMs(320);
        } catch (error) {
          directShortcut = {
            success: false,
            key: 'ctrl+e',
            error: error?.message || String(error || 'TradingView direct Pine shortcut failed')
          };
        }

        if (directShortcut.success) {
          const relaxedCheckpoint = await verifyKeyObservationCheckpoint({
            ...checkpointSpec,
            requiresObservedChange: false
          }, checkpointBeforeForeground, {
            expectedWindowHandle: options.expectedWindowHandle
          });

          const probeMatchedAfterShortcut = await probeTradingViewPineEditorSurface();
          if (relaxedCheckpoint?.verified || probeMatchedAfterShortcut) {
            const foreground = relaxedCheckpoint?.foreground?.success
              ? relaxedCheckpoint.foreground
              : await systemAutomation.getForegroundWindowInfo();
            return {
              recovered: true,
              dismissQuickSearch,
              chartFocusClick,
              directShortcut,
              checkpoint: {
                ...observationCheckpoint,
                ...(relaxedCheckpoint || {}),
                verified: true,
                error: null,
                editorActiveMatched: true,
                foreground,
                matchReason: relaxedCheckpoint?.matchReason || 'chart-focus-ctrl-e-recovery',
                recoveredBy: 'chart-focus-ctrl-e',
                pineEditorSurfaceProbe: probeMatchedAfterShortcut || null,
                pineEditorQuickSearchDismissal: dismissQuickSearch,
                pineEditorDirectShortcut: directShortcut,
                pineEditorChartFocusClick: chartFocusClick
              }
            };
          }
        }
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
