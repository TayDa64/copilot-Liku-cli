const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const PINE_EDITOR_SURFACE_PROBE_CANDIDATES = Object.freeze([
  { text: 'Add to chart', exact: true },
  { text: 'Publish script', exact: false },
  { text: 'Pine Logs', exact: false },
  { text: 'Strategy Tester', exact: false }
]);

const TRADINGVIEW_QUICK_SEARCH_SURFACE_PROBE_CANDIDATES = Object.freeze([
  { text: 'Search tool or function', exact: true, controlType: 'Text' },
  { text: 'Nothing matches your criteria', exact: false, controlType: 'Text' },
  { text: 'Search', exact: true, controlType: 'Text' },
  { text: 'Search', exact: true, controlType: 'Edit' }
]);

const TRADINGVIEW_COMMAND_QUICK_SEARCH_SURFACE_PROBE_CANDIDATES = Object.freeze([
  { text: 'Search tool or function', exact: true, controlType: 'Text' },
  { text: 'Search tool or function', exact: true, controlType: 'Edit' },
  { text: 'Nothing matches your criteria', exact: false, controlType: 'Text' }
]);

const TRADINGVIEW_QUICK_SEARCH_INPUT_FOCUS_CANDIDATES = Object.freeze([
  { text: 'Search', exact: true, controlType: 'Edit' },
  { text: 'Search tool or function', exact: true, controlType: 'Edit' },
  { text: 'Search', exact: true, controlType: 'Text' },
  { text: 'Search tool or function', exact: true, controlType: 'Text' }
]);

const TRADINGVIEW_QUICK_SEARCH_DISCOVERY_CONTROL_TYPES = Object.freeze([
  'Edit',
  'ComboBox',
  'Document',
  'Text',
  'Pane'
]);

const DEFAULT_TRADINGVIEW_QUICK_SEARCH_DISCOVERY_TIMEOUT_MS = 4000;
const MIN_TRADINGVIEW_QUICK_SEARCH_DISCOVERY_TIMEOUT_MS = 250;
const DEFAULT_TRADINGVIEW_PINE_QUICK_SEARCH_RECOVERY_TIMEOUT_MS = 7000;
const MIN_TRADINGVIEW_PINE_QUICK_SEARCH_RECOVERY_TIMEOUT_MS = 500;
const TRADINGVIEW_PINE_EDITOR_QUICK_SEARCH_QUERY = 'Pine Editor';

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

  function getTradingViewQuickSearchDiscoveryTimeoutMs() {
    const configuredTimeout = Number(process.env.LIKU_TRADINGVIEW_QUICK_SEARCH_DISCOVERY_TIMEOUT_MS || 0);
    if (Number.isFinite(configuredTimeout) && configuredTimeout >= MIN_TRADINGVIEW_QUICK_SEARCH_DISCOVERY_TIMEOUT_MS) {
      return Math.round(configuredTimeout);
    }

    return DEFAULT_TRADINGVIEW_QUICK_SEARCH_DISCOVERY_TIMEOUT_MS;
  }

  function getTradingViewPineQuickSearchRecoveryTimeoutMs() {
    const configuredTimeout = Number(process.env.LIKU_TRADINGVIEW_PINE_QUICK_SEARCH_RECOVERY_TIMEOUT_MS || 0);
    if (Number.isFinite(configuredTimeout) && configuredTimeout >= MIN_TRADINGVIEW_PINE_QUICK_SEARCH_RECOVERY_TIMEOUT_MS) {
      return Math.round(configuredTimeout);
    }

    return DEFAULT_TRADINGVIEW_PINE_QUICK_SEARCH_RECOVERY_TIMEOUT_MS;
  }

  function getQuickSearchOperationTimeRemainingMs(runtimeOptions = null, fallbackMs = 0) {
    const deadlineAt = Number(runtimeOptions?.deadlineAt || 0);
    const fallbackTimeout = Number(fallbackMs || 0);

    if (Number.isFinite(deadlineAt) && deadlineAt > 0) {
      const remainingMs = Math.max(0, Math.round(deadlineAt - Date.now()));
      if (Number.isFinite(fallbackTimeout) && fallbackTimeout > 0) {
        return Math.min(remainingMs, Math.round(fallbackTimeout));
      }
      return remainingMs;
    }

    if (Number.isFinite(fallbackTimeout) && fallbackTimeout > 0) {
      return Math.round(fallbackTimeout);
    }

    return 0;
  }

  function createQuickSearchOperationTimeoutError(runtimeOptions = null, label = 'TradingView quick-search preflight') {
    const timeoutMessage = String(runtimeOptions?.timeoutMessage || '').trim();
    const timeoutMs = Number(runtimeOptions?.timeoutMs || 0);
    const error = new Error(
      timeoutMessage
      || (Number.isFinite(timeoutMs) && timeoutMs > 0
        ? `${label} timed out after ${Math.round(timeoutMs)}ms`
        : `${label} timed out`)
    );
    error.timedOut = true;
    return error;
  }

  function throwIfQuickSearchOperationTimedOut(runtimeOptions = null, label = 'TradingView quick-search preflight') {
    if (!runtimeOptions || typeof runtimeOptions !== 'object') {
      return;
    }

    if (runtimeOptions.cancelled === true) {
      throw createQuickSearchOperationTimeoutError(runtimeOptions, label);
    }

    const deadlineAt = Number(runtimeOptions?.deadlineAt || 0);
    if (Number.isFinite(deadlineAt) && deadlineAt > 0 && Date.now() >= deadlineAt) {
      runtimeOptions.cancelled = true;
      throw createQuickSearchOperationTimeoutError(runtimeOptions, label);
    }
  }

  function createQuickSearchRuntimeOptions(timeoutMs = 0, label = 'TradingView quick-search recovery') {
    const boundedTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Math.max(MIN_TRADINGVIEW_PINE_QUICK_SEARCH_RECOVERY_TIMEOUT_MS, Math.round(Number(timeoutMs)))
      : DEFAULT_TRADINGVIEW_PINE_QUICK_SEARCH_RECOVERY_TIMEOUT_MS;

    return {
      label,
      timeoutMs: boundedTimeoutMs,
      startedAt: Date.now(),
      deadlineAt: Date.now() + boundedTimeoutMs,
      cancelled: false,
      timeoutMessage: `${label} timed out after ${boundedTimeoutMs}ms`
    };
  }

  function getExpectedTradingViewQuickSearchText(action = {}) {
    const normalized = normalizeTradingViewQuickSearchInputText(action?.text || action?.quickSearchPreflight?.expectedText || '');
    return normalized || null;
  }

  function buildTradingViewPineQuickSearchRouteMetadata() {
    return {
      id: 'open-pine-editor',
      route: 'quick-search',
      surface: 'pine-editor',
      appName: 'TradingView',
      requiresCommandSurface: true
    };
  }

  function requiresTradingViewCommandQuickSearchSurface(action = {}) {
    const contract = action?.searchSurfaceContract || action?.tradingViewShortcut || {};
    const route = String(contract?.route || '').trim().toLowerCase();
    if (route !== 'quick-search') return false;
    return contract?.requiresCommandSurface === true;
  }

  function buildTradingViewPineQuickSearchTypeAction(expectedText = TRADINGVIEW_PINE_EDITOR_QUICK_SEARCH_QUERY) {
    const routeMetadata = buildTradingViewPineQuickSearchRouteMetadata();
    return {
      type: 'type',
      text: expectedText,
      reason: 'Recover TradingView Pine Editor through a bounded quick-search fallback',
      searchSurfaceContract: routeMetadata,
      tradingViewShortcut: {
        id: 'open-pine-editor',
        surface: 'pine-editor',
        appName: 'TradingView'
      }
    };
  }

  function buildTradingViewPineQuickSearchEnterAction() {
    const routeMetadata = buildTradingViewPineQuickSearchRouteMetadata();
    return {
      type: 'key',
      key: 'enter',
      reason: 'Select the highlighted Pine Editor result in TradingView quick search during recovery',
      verify: {
        target: 'pine-editor'
      },
      searchSurfaceContract: routeMetadata,
      tradingViewShortcut: {
        id: 'open-pine-editor',
        surface: 'pine-editor',
        appName: 'TradingView'
      }
    };
  }

  function summarizeQuickSearchFocusForRecovery(focus = null) {
    if (!focus || typeof focus !== 'object') return null;
    return {
      recoveredBy: focus.recoveredBy || null,
      controlType: focus.controlType || null,
      matchedBy: focus.matchedBy || null,
      trustReason: focus.trustReason || null,
      candidateScore: Number.isFinite(Number(focus.candidateScore))
        ? Number(focus.candidateScore)
        : null
    };
  }

  function summarizeQuickSearchPreflightForRecovery(preflight = null) {
    if (!preflight || typeof preflight !== 'object') return null;
    return {
      applicable: preflight.applicable === true,
      ready: preflight.ready === true,
      timedOut: preflight.timedOut === true,
      emptyConfirmed: preflight.emptyConfirmed === true,
      queryAlreadyPresent: preflight.queryAlreadyPresent === true,
      fallbackAssumedFocused: preflight.fallbackAssumedFocused === true,
      fallbackReason: preflight.fallbackReason || null,
      clearedBy: preflight.clearedBy || null,
      expectedText: preflight.expectedText || null,
      error: preflight.error || null,
      inputFocus: summarizeQuickSearchFocusForRecovery(preflight.inputFocus),
      focusRecovery: summarizeQuickSearchFocusForRecovery(preflight.focusRecovery)
    };
  }

  function summarizeQuickSearchTypeResultForRecovery(typeResult = null) {
    if (!typeResult || typeof typeResult !== 'object') return null;
    const semanticWrite = typeResult.quickSearchSemanticWrite && typeof typeResult.quickSearchSemanticWrite === 'object'
      ? typeResult.quickSearchSemanticWrite
      : null;
    return {
      success: typeResult.success === true,
      method: typeResult.method || null,
      fallback: typeResult.fallback === true,
      error: typeResult.error || null,
      quickSearchSemanticWrite: semanticWrite
        ? {
            applicable: semanticWrite.applicable === true,
            success: semanticWrite.success === true,
            fallbackRecommended: semanticWrite.fallbackRecommended === true,
            method: semanticWrite.method || null,
            error: semanticWrite.error || null,
            readback: semanticWrite.readback || null
          }
        : null
    };
  }

  function summarizeQuickSearchTypedVerificationForRecovery(typedVerification = null) {
    if (!typedVerification || typeof typedVerification !== 'object') return null;
    return {
      applicable: typedVerification.applicable === true,
      verified: typedVerification.verified === true,
      deferred: typedVerification.deferred === true,
      expectedText: typedVerification.expectedText || null,
      actualText: typedVerification.actualText || null,
      satisfiedBy: typedVerification.satisfiedBy || null,
      deferredReason: typedVerification.deferredReason || null,
      error: typedVerification.error || null,
      readback: typedVerification.readback || null
    };
  }

  function summarizeRecoveryStep(step = null) {
    if (!step || typeof step !== 'object') return null;
    return {
      attempted: step.attempted === true,
      success: step.success === true,
      key: step.key || null,
      coordinates: step.coordinates || null,
      error: step.error || null
    };
  }

  function summarizePineRecoveryAttempt(recovery = null) {
    if (!recovery || typeof recovery !== 'object') return null;
    return {
      attempted: recovery.attempted === true,
      recovered: recovery.recovered === true,
      recoveredBy: recovery.recoveredBy || null,
      error: recovery.error || null,
      pineEditorQuickSearchDismissal: summarizeRecoveryStep(recovery.pineEditorQuickSearchDismissal),
      pineEditorDirectShortcut: summarizeRecoveryStep(recovery.pineEditorDirectShortcut),
      pineEditorChartFocusClick: summarizeRecoveryStep(recovery.pineEditorChartFocusClick),
      pineEditorResultClick: recovery.pineEditorResultClick || null,
      pineEditorSurfaceProbe: recovery.pineEditorSurfaceProbe || null
    };
  }

  function mergePineRecoveryMetadata(recovery = null, metadata = {}) {
    if (!recovery || typeof recovery !== 'object') {
      return {
        attempted: true,
        recovered: false,
        ...metadata
      };
    }

    return {
      ...metadata,
      ...recovery,
      attempted: true,
      recovered: recovery.recovered === true,
      error: recovery.error || metadata.error || null
    };
  }

  function buildTradingViewQuickSearchSyntheticFocus(foreground = null, inputSurface = null) {
    const controlType = String(inputSurface?.controlType || '').trim();
    const surfaceElement = inputSurface?.element || null;
    const hasSurfaceBounds = !!(surfaceElement?.Bounds || surfaceElement?.bounds);

    return {
      focused: true,
      recoveredBy: hasSurfaceBounds
        ? 'clipboard-selection-miss-surface-probe'
        : 'clipboard-selection-miss',
      foreground,
      trusted: true,
      trustReason: inputSurface?.trustReason || 'foreground-window',
      trustedWindow: inputSurface?.trustedWindow || foreground,
      element: /^edit$/i.test(controlType) ? surfaceElement : null,
      controlType: controlType || null,
      surfaceProbe: hasSurfaceBounds ? inputSurface : null,
      candidateScore: Number.isFinite(Number(inputSurface?.candidateScore))
        ? Number(inputSurface.candidateScore)
        : null
    };
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

  async function getTrustedTradingViewQuickSearchForeground(preferredWindowHandle = 0, runtimeOptions = null) {
    const expectedWindowHandle = Number(preferredWindowHandle || 0) || 0;
    const cachedForeground = runtimeOptions?.cachedQuickSearchForeground;
    const cachedForegroundHandle = Number(cachedForeground?.hwnd || 0) || 0;
    if (
      cachedForeground?.success
      && normalizeQuickSearchWindowProcessName(cachedForeground?.processName || '') === 'tradingview'
      && (!expectedWindowHandle || !cachedForegroundHandle || expectedWindowHandle === cachedForegroundHandle)
    ) {
      return cachedForeground;
    }

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

    const foregroundHandle = Number(foreground?.hwnd || 0) || 0;
    if (!expectedWindowHandle || !foregroundHandle || expectedWindowHandle === foregroundHandle) {
      if (runtimeOptions && typeof runtimeOptions === 'object') {
        runtimeOptions.cachedQuickSearchForeground = foreground;
      }
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

    if (runtimeOptions && typeof runtimeOptions === 'object') {
      runtimeOptions.cachedQuickSearchForeground = foreground;
    }
    return foreground;
  }

  async function collapseTradingViewQuickSearchSelection(action = {}, collapseKey = 'right', runtimeOptions = null) {
    const selectionReset = {
      attempted: false,
      success: false,
      collapseKey,
      foreground: null
    };

    if (runtimeOptions?.keepSelectionForTyping === true) {
      selectionReset.success = true;
      selectionReset.skippedForTyping = true;
      selectionReset.foreground = runtimeOptions?.cachedQuickSearchForeground || null;
      return selectionReset;
    }

    try {
      throwIfQuickSearchOperationTimedOut(runtimeOptions);
    } catch (error) {
      selectionReset.error = error?.message || String(error || 'Selection collapse skipped because quick-search preflight timed out');
      selectionReset.skippedDueToTimeout = true;
      return selectionReset;
    }

    if (typeof systemAutomation.pressKey !== 'function') {
      return selectionReset;
    }

    selectionReset.attempted = true;
    try {
      throwIfQuickSearchOperationTimedOut(runtimeOptions);
      await systemAutomation.pressKey(collapseKey, action);
      await sleepMs(60);
      throwIfQuickSearchOperationTimedOut(runtimeOptions);
      selectionReset.success = true;
    } catch (error) {
      selectionReset.error = error?.message || String(error || 'Selection collapse failed');
    }

    if (runtimeOptions?.skipSelectionForegroundRefresh === true) {
      selectionReset.foreground = runtimeOptions?.cachedQuickSearchForeground || null;
      return selectionReset;
    }

    try {
      selectionReset.foreground = await systemAutomation.getForegroundWindowInfo();
    } catch {
      selectionReset.foreground = null;
    }

    return selectionReset;
  }

  async function readTradingViewQuickSearchClipboardSelection(action = {}, preferredWindowHandle = 0, runtimeOptions = null) {
    throwIfQuickSearchOperationTimedOut(runtimeOptions);
    const foreground = await getTrustedTradingViewQuickSearchForeground(preferredWindowHandle, runtimeOptions);
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

    throwIfQuickSearchOperationTimedOut(runtimeOptions);
    const originalClipboard = await readClipboardText();
    const sentinel = `__LIKU_QS_${Date.now()}_${Math.random().toString(36).slice(2, 8)}__`;
    throwIfQuickSearchOperationTimedOut(runtimeOptions);
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
      throwIfQuickSearchOperationTimedOut(runtimeOptions);
      await systemAutomation.pressKey('ctrl+a', action);
      await sleepMs(80);
      throwIfQuickSearchOperationTimedOut(runtimeOptions);
      await systemAutomation.pressKey('ctrl+c', action);
      await sleepMs(100);
      throwIfQuickSearchOperationTimedOut(runtimeOptions);
      capturedClipboard = await readClipboardText();
    } catch (error) {
      capturedClipboard = {
        success: false,
        text: '',
        error: error?.message || String(error || 'Clipboard selection copy failed')
      };
    } finally {
      selectionReset = await collapseTradingViewQuickSearchSelection(action, 'right', runtimeOptions);
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

  async function maybeAssumeTradingViewQuickSearchFocusedFromClipboard(action, preferredWindowHandle = 0, runtimeOptions = null) {
    throwIfQuickSearchOperationTimedOut(runtimeOptions);
    const foreground = await getTrustedTradingViewQuickSearchForeground(preferredWindowHandle, runtimeOptions);
    if (!foreground) {
      return null;
    }

    const inputSurface = runtimeOptions?.skipClipboardSurfaceDiscovery === true
      ? null
      : await findTrustedTradingViewQuickSearchSurfaceCandidate(preferredWindowHandle, runtimeOptions);
    const clipboardFocus = buildTradingViewQuickSearchSyntheticFocus(foreground, inputSurface);
    const expectedText = getExpectedTradingViewQuickSearchText(action);
    const initialRead = await readTradingViewQuickSearchClipboardSelection(action, preferredWindowHandle, runtimeOptions);

    if (initialRead.inferredEmpty) {
      return {
        applicable: true,
        ready: true,
        emptyConfirmed: false,
        queryAlreadyPresent: false,
        fallbackAssumedFocused: true,
        fallbackReason: 'TradingView quick-search selection copy captured no stale text after ctrl+k; treat as empty-field continuation and require post-type verification before Enter',
        clearedBy: 'clipboard-selection-miss-assumed-empty',
        expectedText,
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
        expectedText,
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
        expectedText,
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
      throwIfQuickSearchOperationTimedOut(runtimeOptions);
      await systemAutomation.pressKey('ctrl+a', action);
      await sleepMs(runtimeOptions?.allowPostClearAssumedReady === true ? 60 : 90);
      throwIfQuickSearchOperationTimedOut(runtimeOptions);
      await systemAutomation.pressKey('backspace', action);
      if (runtimeOptions?.allowPostClearAssumedReady === true) {
        keyboardFallback.success = true;
      } else {
        await sleepMs(90);
        throwIfQuickSearchOperationTimedOut(runtimeOptions);
        keyboardFallback.success = true;
      }
    } catch (error) {
      keyboardFallback.error = error?.message || String(error || 'Keyboard fallback failed');
    }

    if (runtimeOptions?.allowPostClearAssumedReady === true && keyboardFallback.success) {
      return {
        applicable: true,
        ready: true,
        emptyConfirmed: false,
        queryAlreadyPresent: false,
        fallbackAssumedFocused: true,
        fallbackReason: 'TradingView quick-search stale text was cleared through bounded keyboard input; continue and require post-type verification before Enter',
        clearedBy: 'keyboard-fallback-assumed-empty',
        expectedText,
        inputFocus: clipboardFocus,
        focusRecovery: clipboardFocus,
        initialRead,
        keyboardFallback,
        finalRead: null,
        error: null
      };
    }

    const finalRead = await readTradingViewQuickSearchClipboardSelection(action, preferredWindowHandle, runtimeOptions);
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
        expectedText,
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
      expectedText,
      initialRead,
      keyboardFallback,
      finalRead
    };
  }

  function getTradingViewQuickSearchReadbackTargetCandidates(action = {}) {
    return [
      action?.quickSearchPreflight?.inputFocus,
      action?.quickSearchPreflight?.focusRecovery,
      action?.quickSearchPreflight?.focusRecovery?.surfaceProbe,
      action?.quickSearchPreflight?.inputFocus?.surfaceProbe
    ];
  }

  function hasTradingViewQuickSearchReadbackTarget(action = {}) {
    return getTradingViewQuickSearchReadbackTargetCandidates(action).some(
      (candidate) => !!(candidate?.element?.Bounds || candidate?.element?.bounds)
    );
  }

  function shouldSkipTradingViewQuickSearchSemanticDiscovery(action = {}) {
    return action?.quickSearchPreflight?.fallbackAssumedFocused === true
      && !hasTradingViewQuickSearchReadbackTarget(action);
  }

  function shouldAllowDeferredTradingViewQuickSearchTypedVerification(action = {}, actionResult = {}, runtimeOptions = null) {
    if (runtimeOptions?.allowDeferredPineQuickSearchTypedVerification !== true) {
      return false;
    }

    if (String(action?.searchSurfaceContract?.surface || '').trim().toLowerCase() !== 'pine-editor') {
      return false;
    }

    if (action?.quickSearchPreflight?.fallbackAssumedFocused !== true) {
      return false;
    }

    if (hasTradingViewQuickSearchReadbackTarget(action)) {
      return false;
    }

    if (actionResult?.success !== true) {
      return false;
    }

    return String(actionResult?.method || '').trim().toLowerCase() === 'sendkeys';
  }

  async function resolveTradingViewQuickSearchReadbackTarget(action = {}, preferredWindowHandle = 0, runtimeOptions = null) {
    for (const candidate of getTradingViewQuickSearchReadbackTargetCandidates(action)) {
      if (candidate?.element?.Bounds || candidate?.element?.bounds) {
        return candidate;
      }
    }

    if (shouldSkipTradingViewQuickSearchSemanticDiscovery(action)) {
      return null;
    }

    return findTrustedTradingViewQuickSearchSurfaceCandidate(preferredWindowHandle, runtimeOptions);
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

    const runtimeOptions = typeof options === 'object' && options !== null
      ? options.runtimeOptions || null
      : null;

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
        throwIfQuickSearchOperationTimedOut(runtimeOptions);
        const found = await systemAutomation.findElementByText(searchText, {
          exact,
          controlType,
          windowHandle: attempt.windowHandle,
          foregroundOnly: attempt.foregroundOnly,
          timeout: getQuickSearchOperationTimeRemainingMs(runtimeOptions, 15000) || 15000
        });
        throwIfQuickSearchOperationTimedOut(runtimeOptions);
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

  function computeTradingViewQuickSearchInputGuessPoint(windowInfo = {}) {
    const usable = getUsableTradingViewWindowBounds(windowInfo);
    if (!usable) {
      return null;
    }

    return {
      x: Math.round(usable.x + usable.width * 0.5),
      y: Math.round(usable.y + Math.min(160, Math.max(120, usable.height * 0.14)))
    };
  }

  function normalizeTradingViewQuickSearchDiscoveryText(value = '') {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function getTradingViewQuickSearchCandidateMetadata(candidate = null) {
    const patterns = Array.isArray(candidate?.Patterns || candidate?.patterns)
      ? (candidate?.Patterns || candidate?.patterns).map((value) => normalizeTradingViewQuickSearchDiscoveryText(value))
      : [];
    const controlType = normalizeTradingViewQuickSearchDiscoveryText(
      String(candidate?.ControlType || candidate?.controlType || candidate?.role || '').replace(/^ControlType\./i, '')
    );
    const name = normalizeTradingViewQuickSearchDiscoveryText(candidate?.Name || candidate?.name || '');
    const value = normalizeTradingViewQuickSearchDiscoveryText(candidate?.Value || candidate?.value || '');
    const automationId = normalizeTradingViewQuickSearchDiscoveryText(candidate?.AutomationId || candidate?.automationId || '');
    const className = normalizeTradingViewQuickSearchDiscoveryText(candidate?.ClassName || candidate?.className || '');
    const bounds = getNormalizedBoundsGeometry(candidate?.Bounds || candidate?.bounds);

    return {
      bounds,
      patterns,
      controlType,
      name,
      value,
      automationId,
      className,
      haystack: [name, value, automationId, className, controlType].filter(Boolean).join(' ')
    };
  }

  function convertTradingViewQuickSearchBoundsToHostRect(bounds = null) {
    if (!bounds || typeof bounds !== 'object') {
      return null;
    }

    const normalized = getNormalizedBoundsGeometry(bounds);
    if (normalized) {
      return {
        x: normalized.x,
        y: normalized.y,
        width: normalized.width,
        height: normalized.height
      };
    }

    const minX = Number(bounds?.minX);
    const maxX = Number(bounds?.maxX);
    const minY = Number(bounds?.minY);
    const maxY = Number(bounds?.maxY);
    if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
      return null;
    }

    const width = Math.round(maxX - minX);
    const height = Math.round(maxY - minY);
    if (width <= 0 || height <= 0) {
      return null;
    }

    return {
      x: Math.round(minX),
      y: Math.round(minY),
      width,
      height
    };
  }

  function buildTradingViewQuickSearchHostScanElementKey(element = null) {
    const metadata = getTradingViewQuickSearchCandidateMetadata(element);
    const bounds = metadata.bounds || {};
    return JSON.stringify({
      name: metadata.name,
      value: metadata.value,
      controlType: metadata.controlType,
      automationId: metadata.automationId,
      className: metadata.className,
      x: Number(bounds?.x || 0),
      y: Number(bounds?.y || 0),
      width: Number(bounds?.width || 0),
      height: Number(bounds?.height || 0)
    });
  }

  async function collectTradingViewQuickSearchHostScanElements(preferredWindowHandle = 0, runtimeOptions = null, options = {}) {
    throwIfQuickSearchOperationTimedOut(runtimeOptions);
    if (typeof systemAutomation.findElementsByWindowWithHost !== 'function') {
      return null;
    }

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

    const searchBounds = options.searchBounds || buildTradingViewQuickSearchEditBounds(trustedWindow);
    const hostBounds = convertTradingViewQuickSearchBoundsToHostRect(searchBounds);
    if (!hostBounds) {
      return {
        foreground,
        trustedWindow,
        searchBounds,
        hostBounds: null,
        elements: [],
        scanAttempts: []
      };
    }

    const views = Array.isArray(options.views) && options.views.length > 0
      ? options.views
      : ['control', 'raw'];
    const maxResults = Number.isFinite(Number(options.maxResults)) && Number(options.maxResults) > 0
      ? Math.min(200, Math.round(Number(options.maxResults)))
      : 120;
    const maxDepth = Number.isFinite(Number(options.maxDepth)) && Number(options.maxDepth) >= 0
      ? Math.min(24, Math.round(Number(options.maxDepth)))
      : 14;
    const maxVisited = Number.isFinite(Number(options.maxVisited)) && Number(options.maxVisited) > 0
      ? Math.min(2500, Math.round(Number(options.maxVisited)))
      : 1200;
    const discoveryBudgetMs = getQuickSearchOperationTimeRemainingMs(
      runtimeOptions,
      Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
        ? Math.round(Number(options.timeoutMs))
        : Math.min(1800, getTradingViewQuickSearchDiscoveryTimeoutMs())
    );

    if (discoveryBudgetMs < MIN_TRADINGVIEW_QUICK_SEARCH_DISCOVERY_TIMEOUT_MS) {
      throwIfQuickSearchOperationTimedOut(runtimeOptions);
      return null;
    }

    const discoveredElements = [];
    const seenKeys = new Set();
    const scanAttempts = [];
    const discoveryStartedAt = Date.now();
    const perAttemptTimeoutFloorMs = Math.max(
      MIN_TRADINGVIEW_QUICK_SEARCH_DISCOVERY_TIMEOUT_MS,
      Math.floor(discoveryBudgetMs / Math.max(1, views.length))
    );

    for (const view of views) {
      throwIfQuickSearchOperationTimedOut(runtimeOptions);
      const elapsedMs = Date.now() - discoveryStartedAt;
      const remainingBudgetMs = getQuickSearchOperationTimeRemainingMs(runtimeOptions, discoveryBudgetMs - elapsedMs);
      if (remainingBudgetMs < MIN_TRADINGVIEW_QUICK_SEARCH_DISCOVERY_TIMEOUT_MS) {
        break;
      }

      const perAttemptTimeoutMs = Math.max(
        MIN_TRADINGVIEW_QUICK_SEARCH_DISCOVERY_TIMEOUT_MS,
        Math.min(remainingBudgetMs, perAttemptTimeoutFloorMs)
      );

      let scanResult = null;
      try {
        scanResult = await systemAutomation.findElementsByWindowWithHost('', {
          windowHandle: trustedWindowHandle,
          bounds: hostBounds,
          view,
          maxResults,
          maxDepth,
          maxVisited,
          includeOffscreen: false,
          includeDisabled: true,
          timeout: perAttemptTimeoutMs
        });
        throwIfQuickSearchOperationTimedOut(runtimeOptions);
      } catch (error) {
        scanAttempts.push({
          view,
          success: false,
          count: 0,
          stats: null,
          error: error?.message || String(error || 'TradingView host window scan failed')
        });
        continue;
      }

      const elements = Array.isArray(scanResult?.elements) ? scanResult.elements : [];
      scanAttempts.push({
        view,
        success: scanResult?.success === true,
        count: elements.length,
        stats: scanResult?.stats || null,
        error: scanResult?.success === false ? (scanResult?.error || 'TradingView host window scan failed') : null
      });

      for (const element of elements) {
        const key = buildTradingViewQuickSearchHostScanElementKey(element);
        if (!key || seenKeys.has(key)) {
          continue;
        }
        seenKeys.add(key);
        discoveredElements.push(element);
      }
    }

    return {
      foreground,
      trustedWindow,
      searchBounds,
      hostBounds,
      elements: discoveredElements,
      scanAttempts
    };
  }

  function scoreTradingViewQuickSearchCandidate(candidate, trustedWindow = {}) {
    const metadata = getTradingViewQuickSearchCandidateMetadata(candidate);
    const candidateBounds = metadata.bounds;
    const windowBounds = getNormalizedBoundsGeometry(trustedWindow?.bounds || trustedWindow?.Bounds);
    if (!candidateBounds || !windowBounds) {
      return Number.NEGATIVE_INFINITY;
    }

    if (candidateBounds.width < Math.max(140, Math.round(windowBounds.width * 0.12))) {
      return Number.NEGATIVE_INFINITY;
    }

    if (candidateBounds.height < 14 || candidateBounds.height > 96) {
      return Number.NEGATIVE_INFINITY;
    }

    const name = metadata.name;
    const value = metadata.value;
    const automationId = metadata.automationId;
    const className = metadata.className;
    const controlType = metadata.controlType;
    const isEnabled = candidate?.IsEnabled !== false && candidate?.isEnabled !== false;
    const isFocusable = candidate?.IsFocusable === true || candidate?.isFocusable === true;
    const isClickable = candidate?.IsClickable === true || candidate?.isClickable === true;
    const patterns = metadata.patterns;

    const haystack = [name, value, automationId, className, controlType].filter(Boolean).join(' ');
    const idealCenterX = windowBounds.x + windowBounds.width / 2;
    const idealCenterY = windowBounds.y + Math.min(180, Math.max(120, windowBounds.height * 0.18));

    let score = 0;
    score += Math.max(0, 340 - Math.abs(candidateBounds.centerX - idealCenterX));
    score += Math.max(0, 220 - Math.abs(candidateBounds.centerY - idealCenterY));
    score += Math.min(240, candidateBounds.width);
    score += Math.max(0, 90 - Math.abs(candidateBounds.height - 34));

    if (!isEnabled && !/text/.test(controlType)) {
      score -= 120;
    }

    if (/edit/.test(controlType)) score += 80;
    else if (/combobox|document/.test(controlType)) score += 55;
    else if (/pane|text/.test(controlType)) score += 25;
    if (/search|filter|query|command/.test(haystack)) score += 180;
    if (/search\s+tool\s+or\s+function/.test(haystack)) score += 140;
    if (/search/.test(value) && !name) score += 30;
    if (!name) score += 40;
    if (patterns.some((value) => /(value|text|legacyiaccessible)(pattern)?/.test(value))) {
      score += 60;
    }
    if (patterns.some((value) => /selection(item)?(pattern)?/.test(value))) {
      score += 25;
    }
    if (isFocusable) score += 30;
    if (isClickable) score += 10;
    if (candidateBounds.width >= Math.round(windowBounds.width * 0.35)) {
      score += 30;
    }

    return score;
  }

  function selectBestTradingViewQuickSearchCandidate(candidates = [], trustedWindow = {}) {
    const scoredCandidates = candidates
      .map((element) => ({
        element,
        score: scoreTradingViewQuickSearchCandidate(element, trustedWindow)
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
      return {
        ambiguous: true,
        scoredCandidates
      };
    }

    return {
      ambiguous: false,
      scoredCandidates,
      bestCandidate: scoredCandidates[0]
    };
  }

  function selectTradingViewCommandQuickSearchHostSurface(hostScan = null) {
    const elements = Array.isArray(hostScan?.elements) ? hostScan.elements : [];
    if (!elements.length) {
      return null;
    }

    const markerMatches = elements
      .map((element) => ({
        element,
        metadata: getTradingViewQuickSearchCandidateMetadata(element)
      }))
      .filter(({ metadata }) => /search\s+tool\s+or\s+function/.test(metadata.haystack)
        || /nothing\s+matches\s+your\s+criteria/.test(metadata.haystack))
      .sort((left, right) => {
        const leftPriority = /search\s+tool\s+or\s+function/.test(left.metadata.haystack) ? 2 : 1;
        const rightPriority = /search\s+tool\s+or\s+function/.test(right.metadata.haystack) ? 2 : 1;
        if (rightPriority !== leftPriority) {
          return rightPriority - leftPriority;
        }
        return String(left.metadata.name || left.metadata.value || '').localeCompare(String(right.metadata.name || right.metadata.value || ''));
      });

    const preferredInputCandidates = elements.filter((element) => {
      const metadata = getTradingViewQuickSearchCandidateMetadata(element);
      return /(edit|combobox|document)/.test(metadata.controlType);
    });
    const inputSelection = selectBestTradingViewQuickSearchCandidate(
      preferredInputCandidates.length > 0 ? preferredInputCandidates : elements,
      hostScan?.trustedWindow || {}
    );
    if (markerMatches.length > 0) {
      const marker = markerMatches[0];
      const bestInputElement = inputSelection?.bestCandidate?.element || null;
      const matchedElement = bestInputElement || marker.element;
      const matchedMetadata = getTradingViewQuickSearchCandidateMetadata(matchedElement);
      return {
        matched: true,
        text: marker.metadata.name || marker.metadata.value || 'Search tool or function',
        exact: /search\s+tool\s+or\s+function/.test(marker.metadata.haystack),
        controlType: matchedMetadata.controlType || 'Edit',
        matchedBy: 'uia-host-command-surface-scan',
        element: matchedElement,
        foreground: hostScan.foreground,
        trusted: true,
        trustReason: 'uia-host-command-surface-marker',
        trustedWindow: hostScan.trustedWindow || null,
        commandSurfaceProbe: {
          markerElement: marker.element,
          inputElement: bestInputElement,
          scanAttempts: hostScan.scanAttempts || [],
          hostBounds: hostScan.hostBounds || null
        }
      };
    }

    if (inputSelection?.bestCandidate?.element) {
      return {
        matched: true,
        text: inputSelection.bestCandidate.element?.Name || inputSelection.bestCandidate.element?.Value || '',
        exact: false,
        controlType: String(inputSelection.bestCandidate.element?.ControlType || inputSelection.bestCandidate.element?.controlType || '').replace(/^ControlType\./i, '') || 'Edit',
        matchedBy: 'uia-host-command-surface-scan',
        element: inputSelection.bestCandidate.element,
        foreground: hostScan.foreground,
        trusted: false,
        trustReason: 'generic-search-only',
        trustedWindow: hostScan.trustedWindow || null,
        commandSurfaceProbe: {
          markerElement: null,
          inputElement: inputSelection.bestCandidate.element,
          scanAttempts: hostScan.scanAttempts || [],
          hostBounds: hostScan.hostBounds || null
        }
      };
    }

    return null;
  }

  async function findTrustedTradingViewQuickSearchSurfaceCandidate(preferredWindowHandle = 0, runtimeOptions = null) {
    throwIfQuickSearchOperationTimedOut(runtimeOptions);
    const probedSurface = await probeTradingViewQuickSearchSurface(preferredWindowHandle, runtimeOptions);
    if (probedSurface?.trusted === true && (probedSurface?.element?.Bounds || probedSurface?.element?.bounds)) {
      return probedSurface;
    }

    const boundsCandidate = await findTrustedTradingViewQuickSearchEdit(preferredWindowHandle, runtimeOptions);
    if (boundsCandidate?.trusted === true && (boundsCandidate?.element?.Bounds || boundsCandidate?.element?.bounds)) {
      return boundsCandidate;
    }

    return null;
  }

  async function findTrustedTradingViewQuickSearchEdit(preferredWindowHandle = 0, runtimeOptions = null) {
    throwIfQuickSearchOperationTimedOut(runtimeOptions);
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

    const hostScan = await collectTradingViewQuickSearchHostScanElements(trustedWindowHandle, runtimeOptions, {
      searchBounds,
      maxResults: 120,
      maxDepth: 14,
      maxVisited: 1200
    });
    const preferredHostInputCandidates = Array.isArray(hostScan?.elements)
      ? hostScan.elements.filter((element) => /(edit|combobox|document)/.test(getTradingViewQuickSearchCandidateMetadata(element).controlType))
      : [];
    const hostSelection = selectBestTradingViewQuickSearchCandidate(
      preferredHostInputCandidates.length > 0
        ? preferredHostInputCandidates
        : (Array.isArray(hostScan?.elements) ? hostScan.elements : []),
      trustedWindow
    );
    if (hostSelection?.bestCandidate?.element) {
      const rawControlType = String(
        hostSelection.bestCandidate.element?.ControlType
        || hostSelection.bestCandidate.element?.controlType
        || ''
      ).trim();
      const normalizedControlType = rawControlType.replace(/^ControlType\./i, '') || 'Edit';
      return {
        matched: true,
        text: String(
          hostSelection.bestCandidate.element?.Name
          || hostSelection.bestCandidate.element?.Value
          || hostSelection.bestCandidate.element?.name
          || hostSelection.bestCandidate.element?.value
          || ''
        ).trim(),
        exact: false,
        controlType: normalizedControlType,
        matchedBy: 'trusted-window-host-scan-candidate',
        element: hostSelection.bestCandidate.element,
        foreground: hostScan?.foreground || foreground,
        trusted: true,
        trustReason: 'trusted-window-host-scan-candidate',
        trustedWindow: hostScan?.trustedWindow || trustedWindow,
        searchBounds,
        candidateScore: hostSelection.bestCandidate.score,
        hostScanAttempts: hostScan?.scanAttempts || []
      };
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

    const discoveryBudgetMs = getQuickSearchOperationTimeRemainingMs(
      runtimeOptions,
      getTradingViewQuickSearchDiscoveryTimeoutMs()
    );
    if (discoveryBudgetMs < MIN_TRADINGVIEW_QUICK_SEARCH_DISCOVERY_TIMEOUT_MS) {
      throwIfQuickSearchOperationTimedOut(runtimeOptions);
      return null;
    }
    const perAttemptTimeoutFloorMs = Math.max(
      MIN_TRADINGVIEW_QUICK_SEARCH_DISCOVERY_TIMEOUT_MS,
      Math.floor(discoveryBudgetMs / Math.max(1, TRADINGVIEW_QUICK_SEARCH_DISCOVERY_CONTROL_TYPES.length))
    );
    const discoveryStartedAt = Date.now();
    const discoveredElements = [];
    const seenKeys = new Set();

    for (const controlType of TRADINGVIEW_QUICK_SEARCH_DISCOVERY_CONTROL_TYPES) {
      throwIfQuickSearchOperationTimedOut(runtimeOptions);
      const elapsedMs = Date.now() - discoveryStartedAt;
      const remainingBudgetMs = getQuickSearchOperationTimeRemainingMs(runtimeOptions, discoveryBudgetMs - elapsedMs);
      if (remainingBudgetMs < MIN_TRADINGVIEW_QUICK_SEARCH_DISCOVERY_TIMEOUT_MS) {
        break;
      }

      const perAttemptTimeoutMs = Math.max(
        MIN_TRADINGVIEW_QUICK_SEARCH_DISCOVERY_TIMEOUT_MS,
        Math.min(remainingBudgetMs, perAttemptTimeoutFloorMs)
      );
      let matches = null;
      try {
        matches = await uia.findElements({
          controlType,
          isEnabled: controlType === 'Text' ? undefined : true,
          bounds: searchBounds,
          timeoutMs: perAttemptTimeoutMs
        });
        throwIfQuickSearchOperationTimedOut(runtimeOptions);
      } catch {
        matches = null;
      }

      const elements = Array.isArray(matches?.elements) ? matches.elements : [];
      for (const element of elements) {
        const bounds = element?.Bounds || element?.bounds || {};
        const dedupeKey = JSON.stringify({
          name: String(element?.Name || element?.name || ''),
          controlType: String(element?.ControlType || element?.controlType || ''),
          automationId: String(element?.AutomationId || element?.automationId || ''),
          className: String(element?.ClassName || element?.className || ''),
          x: Number(bounds?.X ?? bounds?.x ?? 0),
          y: Number(bounds?.Y ?? bounds?.y ?? 0),
          width: Number(bounds?.Width ?? bounds?.width ?? 0),
          height: Number(bounds?.Height ?? bounds?.height ?? 0)
        });
        if (seenKeys.has(dedupeKey)) {
          continue;
        }
        seenKeys.add(dedupeKey);
        discoveredElements.push(element);
      }
    }

    const scoredCandidates = discoveredElements
      .map((element) => ({
        element,
        score: scoreTradingViewQuickSearchCandidate(element, trustedWindow)
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
    const rawControlType = String(bestCandidate.element?.ControlType || bestCandidate.element?.controlType || '').trim();
    const normalizedControlType = rawControlType.replace(/^ControlType\./i, '') || 'Edit';
    return {
      matched: true,
      text: String(bestCandidate.element?.Name || bestCandidate.element?.name || '').trim(),
      exact: false,
      controlType: normalizedControlType,
      matchedBy: 'trusted-window-bounds-search-candidate',
      element: bestCandidate.element,
      foreground,
      trusted: true,
      trustReason: 'trusted-window-bounds-search-candidate',
      trustedWindow,
      searchBounds,
      candidateScore: bestCandidate.score
    };
  }

  async function probeTradingViewPineEditorSurface(runtimeOptions = null) {
    if (typeof systemAutomation.probeTradingViewPineEditorSurface === 'function') {
      try {
        throwIfQuickSearchOperationTimedOut(runtimeOptions);
        const hostProbe = await systemAutomation.probeTradingViewPineEditorSurface({
          timeout: getQuickSearchOperationTimeRemainingMs(runtimeOptions, 1500) || 1500
        });
        if (hostProbe?.active) {
          return {
            matched: true,
            text: hostProbe.anchorText || (Array.isArray(hostProbe.visibleAnchors) ? hostProbe.visibleAnchors[0] : 'Pine Editor'),
            exact: false,
            element: hostProbe.element || null,
            foreground: hostProbe.foreground || hostProbe.windowInfo || null,
            matchedBy: hostProbe.matchedBy || 'uia-host-lower-panel-scan',
            visibleAnchors: Array.isArray(hostProbe.visibleAnchors) ? hostProbe.visibleAnchors.slice(0, 8) : []
          };
        }
      } catch {
        // Fall through to the lighter foreground text probe path.
      }
    }

    for (const candidate of PINE_EDITOR_SURFACE_PROBE_CANDIDATES) {
      const matched = await findForegroundElementByText(candidate.text, {
        exact: candidate.exact,
        runtimeOptions
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

  async function probeTradingViewQuickSearchSurface(preferredWindowHandle = 0, runtimeOptions = null) {
    throwIfQuickSearchOperationTimedOut(runtimeOptions);
    const foreground = await systemAutomation.getForegroundWindowInfo();
    const expectedWindowHandle = Number(preferredWindowHandle || 0) || Number(foreground?.hwnd || 0) || 0;
    const expectedProcessName = foreground?.processName || '';

    for (const candidate of TRADINGVIEW_QUICK_SEARCH_SURFACE_PROBE_CANDIDATES) {
      const matched = await findForegroundElementByText(candidate.text, {
        exact: candidate.exact,
        controlType: candidate.controlType,
        windowHandle: preferredWindowHandle,
        allowGlobalFallback: true,
        runtimeOptions
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

    const unnamedEditMatch = await findTrustedTradingViewQuickSearchEdit(expectedWindowHandle, runtimeOptions);
    if (unnamedEditMatch) {
      return unnamedEditMatch;
    }

    return null;
  }

  async function probeTradingViewCommandQuickSearchSurface(preferredWindowHandle = 0, runtimeOptions = null) {
    throwIfQuickSearchOperationTimedOut(runtimeOptions);
    const foreground = await systemAutomation.getForegroundWindowInfo();
    const expectedWindowHandle = Number(preferredWindowHandle || 0) || Number(foreground?.hwnd || 0) || 0;
    const expectedProcessName = foreground?.processName || '';
    const hostProbe = selectTradingViewCommandQuickSearchHostSurface(
      await collectTradingViewQuickSearchHostScanElements(expectedWindowHandle, runtimeOptions, {
        maxResults: 120,
        maxDepth: 14,
        maxVisited: 1200
      })
    );

    if (hostProbe?.trusted === true) {
      return hostProbe;
    }

    for (const candidate of TRADINGVIEW_COMMAND_QUICK_SEARCH_SURFACE_PROBE_CANDIDATES) {
      const matched = await findForegroundElementByText(candidate.text, {
        exact: candidate.exact,
        controlType: candidate.controlType,
        windowHandle: preferredWindowHandle,
        allowGlobalFallback: true,
        runtimeOptions
      });
      if (!matched) {
        continue;
      }

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

    return hostProbe || null;
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

  async function clickTradingViewQuickSearchMatch(inputMatch, runtimeOptions = null) {
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
      throwIfQuickSearchOperationTimedOut(runtimeOptions);
      await systemAutomation.click(bounds.CenterX, bounds.CenterY, 'left');
      await sleepMs(160);
      throwIfQuickSearchOperationTimedOut(runtimeOptions);
    } catch (error) {
      clickResult.success = false;
      clickResult.error = error?.message || String(error || 'click failed');
    }

    return clickResult;
  }

  async function focusTradingViewQuickSearchInputByWindowGuess(preferredWindowHandle = 0, runtimeOptions = null) {
    throwIfQuickSearchOperationTimedOut(runtimeOptions);
    if (typeof systemAutomation.click !== 'function') {
      return null;
    }

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

    const guessPoint = computeTradingViewQuickSearchInputGuessPoint(trustedWindow);
    if (!guessPoint) {
      return null;
    }

    const guessClick = {
      attempted: true,
      success: true,
      coordinates: guessPoint
    };

    try {
      throwIfQuickSearchOperationTimedOut(runtimeOptions);
      await systemAutomation.click(guessPoint.x, guessPoint.y, 'left');
      await sleepMs(140);
    } catch (error) {
      guessClick.success = false;
      guessClick.error = error?.message || String(error || 'TradingView quick-search guess click failed');
      return {
        focused: false,
        recoveredBy: 'trusted-window-guess-click',
        trustedWindow,
        guessClick,
        error: guessClick.error
      };
    }

    if (runtimeOptions?.skipFocusConfirmation === true) {
      return {
        focused: false,
        recoveredBy: 'trusted-window-guess-click',
        trustedWindow,
        guessClick,
        error: null
      };
    }

    const retriedFocus = await focusTradingViewQuickSearchInput(
      Number(trustedWindow?.hwnd || 0) || preferredWindowHandle,
      runtimeOptions
        ? {
            ...runtimeOptions,
            skipWindowGuess: true
          }
        : { skipWindowGuess: true }
    );
    if (retriedFocus?.focused) {
      return {
        ...retriedFocus,
        recoveredBy: 'trusted-window-guess-click',
        trustedWindow,
        guessClick
      };
    }

    return {
      focused: false,
      recoveredBy: 'trusted-window-guess-click',
      trustedWindow,
      guessClick,
      error: null
    };
  }

  async function focusTradingViewQuickSearchInput(preferredWindowHandle = 0, runtimeOptions = null) {
    throwIfQuickSearchOperationTimedOut(runtimeOptions);
    if (runtimeOptions?.preferWindowGuessFirst === true && runtimeOptions?.skipWindowGuess !== true) {
      const guessedFocus = await focusTradingViewQuickSearchInputByWindowGuess(preferredWindowHandle, runtimeOptions);
      if (guessedFocus?.focused) {
        return guessedFocus;
      }
    }

    const foreground = await systemAutomation.getForegroundWindowInfo();
    const expectedWindowHandle = Number(preferredWindowHandle || 0) || Number(foreground?.hwnd || 0) || 0;
    const expectedProcessName = foreground?.processName || '';

    for (const candidate of TRADINGVIEW_QUICK_SEARCH_INPUT_FOCUS_CANDIDATES) {
      const matched = await findForegroundElementByText(candidate.text, {
        exact: candidate.exact,
        controlType: candidate.controlType,
        windowHandle: preferredWindowHandle,
        allowGlobalFallback: true,
        runtimeOptions
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

      const clickResult = await clickTradingViewQuickSearchMatch(matched, runtimeOptions);
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

    const unnamedEditMatch = await findTrustedTradingViewQuickSearchEdit(expectedWindowHandle, runtimeOptions);
    if (unnamedEditMatch?.element?.Bounds) {
      const clickResult = await clickTradingViewQuickSearchMatch(unnamedEditMatch, runtimeOptions);
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

  async function recoverTradingViewQuickSearchInputFocus(preferredWindowHandle = 0, runtimeOptions = null) {
    throwIfQuickSearchOperationTimedOut(runtimeOptions);
    const surfaceProbe = await probeTradingViewQuickSearchSurface(preferredWindowHandle, runtimeOptions);
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

    const surfaceClick = await clickTradingViewQuickSearchMatch(surfaceProbe, runtimeOptions);
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

    const retriedFocus = await focusTradingViewQuickSearchInput(trustedWindowHandle, runtimeOptions);
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

  async function ensureTradingViewQuickSearchInputClearBeforeTyping(action, preferredWindowHandle = 0, runtimeOptions = null) {
    throwIfQuickSearchOperationTimedOut(runtimeOptions);
    if (String(action?.type || '').trim().toLowerCase() !== 'type') {
      return { applicable: false, ready: true };
    }

    if (String(action?.searchSurfaceContract?.route || '').trim().toLowerCase() !== 'quick-search') {
      return { applicable: false, ready: true };
    }

    const expectedText = getExpectedTradingViewQuickSearchText(action);
    if (requiresTradingViewCommandQuickSearchSurface(action)) {
      const commandQuickSearchSurface = await probeTradingViewCommandQuickSearchSurface(
        preferredWindowHandle,
        runtimeOptions
      );
      if (commandQuickSearchSurface?.trusted !== true) {
        const dismissal = {
          attempted: false,
          success: false,
          key: 'escape',
          error: null
        };
        if (typeof systemAutomation.pressKey === 'function') {
          dismissal.attempted = true;
          try {
            await systemAutomation.pressKey('escape', action);
            await sleepMs(80);
            dismissal.success = true;
          } catch (error) {
            dismissal.error = error?.message || String(error || 'TradingView quick-search dismissal failed');
          }
        }
        return {
          applicable: true,
          ready: false,
          error: 'TradingView command quick-search surface was not verified before typing; refusing to type into symbol search',
          inputFocus: null,
          focusRecovery: null,
          fallbackAssumedFocused: false,
          fallbackReason: 'command-surface-not-verified',
          expectedText,
          commandSurfaceProbe: commandQuickSearchSurface || null,
          dismissal
        };
      }
    }

    let inputFocus = null;
    let focusRecovery = null;
    let guessedFocusRecovery = null;
    if (runtimeOptions?.preferWindowGuessFirst === true && runtimeOptions?.skipWindowGuess !== true) {
      guessedFocusRecovery = await focusTradingViewQuickSearchInputByWindowGuess(
        preferredWindowHandle,
        runtimeOptions
          ? {
              ...runtimeOptions,
              skipWindowGuess: true,
              skipFocusConfirmation: true
            }
          : {
              skipWindowGuess: true,
              skipFocusConfirmation: true
            }
      );
      if (guessedFocusRecovery?.focused) {
        inputFocus = guessedFocusRecovery;
        focusRecovery = guessedFocusRecovery;
      } else if (guessedFocusRecovery?.guessClick?.success) {
        const clipboardFallback = await maybeAssumeTradingViewQuickSearchFocusedFromClipboard(
          action,
          preferredWindowHandle,
          runtimeOptions
        );
        if (clipboardFallback?.ready) {
          return {
            ...clipboardFallback,
            focusRecovery: guessedFocusRecovery,
            fallbackReason: guessedFocusRecovery.recoveredBy || clipboardFallback.fallbackReason || null
          };
        }
      }
    }

    if (!inputFocus?.focused) {
      inputFocus = await focusTradingViewQuickSearchInput(preferredWindowHandle, runtimeOptions);
    }
    if (!inputFocus?.focused) {
      focusRecovery = await recoverTradingViewQuickSearchInputFocus(preferredWindowHandle, runtimeOptions);
      if (focusRecovery?.focused) {
        inputFocus = focusRecovery;
      }
    }

    if (!inputFocus?.focused) {
      guessedFocusRecovery = await focusTradingViewQuickSearchInputByWindowGuess(preferredWindowHandle, runtimeOptions);
      if (guessedFocusRecovery?.focused) {
        inputFocus = guessedFocusRecovery;
        focusRecovery = guessedFocusRecovery;
      } else if (guessedFocusRecovery) {
        focusRecovery = guessedFocusRecovery;
      }
    }

    if (!inputFocus?.focused) {
      const rejectedSurface = focusRecovery?.surfaceProbe && focusRecovery?.surfaceProbe?.trusted === false;
      if (!rejectedSurface) {
        const clipboardFallback = await maybeAssumeTradingViewQuickSearchFocusedFromClipboard(action, preferredWindowHandle, runtimeOptions);
        if (clipboardFallback) {
          return guessedFocusRecovery
            ? {
                ...clipboardFallback,
                focusRecovery: guessedFocusRecovery,
                fallbackReason: guessedFocusRecovery.recoveredBy || clipboardFallback.fallbackReason || null
              }
            : clipboardFallback;
        }
      }

      return {
        applicable: true,
        ready: false,
        error: 'Could not re-focus the TradingView quick-search input before typing',
        inputFocus: inputFocus || null,
        focusRecovery: focusRecovery || null,
        fallbackAssumedFocused: false,
        fallbackReason: focusRecovery?.recoveredBy || focusRecovery?.error || null,
        expectedText
      };
    }

    throwIfQuickSearchOperationTimedOut(runtimeOptions);
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
        expectedText,
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
        expectedText,
        initialRead,
        finalRead: initialRead
      };
    }

    throwIfQuickSearchOperationTimedOut(runtimeOptions);
    const valueClearAttempt = await trySetTradingViewQuickSearchInputValue(inputFocus, '');
    await sleepMs(80);
    throwIfQuickSearchOperationTimedOut(runtimeOptions);
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
        expectedText,
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
        throwIfQuickSearchOperationTimedOut(runtimeOptions);
        await systemAutomation.pressKey('ctrl+a', action);
        await sleepMs(90);
        throwIfQuickSearchOperationTimedOut(runtimeOptions);
        await systemAutomation.pressKey('backspace', action);
        await sleepMs(90);
        throwIfQuickSearchOperationTimedOut(runtimeOptions);
        keyboardFallback.success = true;
      } catch (error) {
        keyboardFallback.error = error?.message || String(error || 'Keyboard fallback failed');
      }
    }

    throwIfQuickSearchOperationTimedOut(runtimeOptions);
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
        expectedText,
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
      expectedText,
      initialRead,
      clearAttempt: valueClearAttempt,
      keyboardFallback,
      finalRead: afterKeyboardClearRead.success ? afterKeyboardClearRead : afterValueClearRead
    };
  }

  async function verifyTradingViewQuickSearchTypedValue(action = {}, actionResult = {}, preferredWindowHandle = 0, runtimeOptions = null) {
    if (String(action?.type || '').trim().toLowerCase() !== 'type') {
      return { applicable: false, verified: false };
    }

    if (String(action?.searchSurfaceContract?.route || '').trim().toLowerCase() !== 'quick-search') {
      return { applicable: false, verified: false };
    }

    const expectedText = getExpectedTradingViewQuickSearchText(action);
    if (!expectedText) {
      return {
        applicable: true,
        verified: false,
        expectedText: null,
        actualText: '',
        satisfiedBy: null,
        readback: null,
        error: 'TradingView quick-search typing did not include an expected query to verify'
      };
    }

    const semanticWrite = actionResult?.quickSearchSemanticWrite;
    if (semanticWrite?.applicable && semanticWrite?.success) {
      const actualText = normalizeTradingViewQuickSearchInputText(
        semanticWrite?.readback?.text || semanticWrite?.readback?.normalizedText || ''
      );
      return {
        applicable: true,
        verified: actualText === expectedText,
        expectedText,
        actualText,
        satisfiedBy: 'value-pattern-readback',
        readback: semanticWrite?.readback || null,
        error: actualText === expectedText
          ? null
          : `TradingView quick-search semantic readback captured "${actualText}" instead of "${expectedText}"`
      };
    }

    const readbackTarget = await resolveTradingViewQuickSearchReadbackTarget(action, preferredWindowHandle, runtimeOptions);
    if (readbackTarget?.element?.Bounds || readbackTarget?.element?.bounds) {
      throwIfQuickSearchOperationTimedOut(runtimeOptions, 'TradingView quick-search typed verification');
      const directReadback = await readTradingViewQuickSearchInputValue(readbackTarget);
      const actualText = normalizeTradingViewQuickSearchInputText(
        directReadback?.text || directReadback?.normalizedText || ''
      );

      if (directReadback.success && actualText === expectedText) {
        return {
          applicable: true,
          verified: true,
          expectedText,
          actualText,
          satisfiedBy: 'uia-host-readback',
          readback: directReadback,
          error: null
        };
      }
    }

    if (shouldAllowDeferredTradingViewQuickSearchTypedVerification(action, actionResult, runtimeOptions)) {
      const foreground = await getTrustedTradingViewQuickSearchForeground(preferredWindowHandle, runtimeOptions);
      if (foreground) {
        return {
          applicable: true,
          verified: false,
          deferred: true,
          expectedText,
          actualText: null,
          satisfiedBy: 'post-enter-pine-checkpoint',
          deferredReason: 'Assumed-focus Pine quick-search typing had no semantic readback target; continue to Enter and require the post-Enter Pine surface checkpoint.',
          readback: null,
          error: null,
          foreground
        };
      }
    }

    throwIfQuickSearchOperationTimedOut(runtimeOptions, 'TradingView quick-search typed verification');
    const clipboardRead = await readTradingViewQuickSearchClipboardSelection(action, preferredWindowHandle, runtimeOptions);
    const clipboardActualText = normalizeTradingViewQuickSearchInputText(
      clipboardRead?.text || clipboardRead?.normalizedText || ''
    );
    if (clipboardRead.success && clipboardActualText === expectedText) {
      return {
        applicable: true,
        verified: true,
        expectedText,
        actualText: clipboardActualText,
        satisfiedBy: 'clipboard-selection',
        readback: clipboardRead,
        error: null
      };
    }

    return {
      applicable: true,
      verified: false,
      expectedText,
      actualText: clipboardActualText,
      satisfiedBy: clipboardRead.success ? 'clipboard-selection' : null,
      readback: clipboardRead,
      error: clipboardRead.success
        ? `TradingView quick-search typed readback captured "${clipboardActualText}" instead of "${expectedText}"`
        : (clipboardRead.error || 'TradingView quick-search typing could not be verified before continuing')
    };
  }

  async function attemptTradingViewQuickSearchSemanticWrite(action = {}, preferredWindowHandle = 0, runtimeOptions = null) {
    const inputMatch = await resolveTradingViewQuickSearchReadbackTarget(action, preferredWindowHandle, runtimeOptions);
    if (!inputMatch?.element?.Bounds) {
      return {
        applicable: true,
        success: false,
        fallbackRecommended: true,
        method: null,
        error: 'Trusted TradingView quick-search input bounds were not available for semantic write'
      };
    }

    throwIfQuickSearchOperationTimedOut(runtimeOptions, 'TradingView Pine quick-search semantic write');
    const intendedText = String(action?.text || '');
    const setValueResponse = await trySetTradingViewQuickSearchInputValue(inputMatch, intendedText);
    if (!setValueResponse.success) {
      return {
        applicable: true,
        success: false,
        fallbackRecommended: true,
        method: null,
        error: setValueResponse.error || 'TradingView quick-search semantic write failed'
      };
    }

    throwIfQuickSearchOperationTimedOut(runtimeOptions, 'TradingView Pine quick-search semantic write');
    const readbackResponse = await readTradingViewQuickSearchInputValue(inputMatch);
    const readbackText = String(readbackResponse?.text || '');
    const normalizedReadback = normalizeTradingViewQuickSearchInputText(
      readbackText || readbackResponse?.normalizedText || ''
    );
    const normalizedIntended = normalizeTradingViewQuickSearchInputText(intendedText);

    if (!readbackResponse.success || normalizedReadback !== normalizedIntended) {
      try {
        await trySetTradingViewQuickSearchInputValue(inputMatch, '');
      } catch {}
      return {
        applicable: true,
        success: false,
        fallbackRecommended: readbackResponse.success !== true,
        method: 'ValuePattern',
        setValueResponse,
        readback: readbackResponse.success
          ? {
              text: readbackText,
              normalizedText: normalizedReadback,
              method: readbackResponse.method || 'UIAHost.getText'
            }
          : null,
        error: readbackResponse.success
          ? `TradingView quick-search semantic write read back "${normalizedReadback}" instead of "${normalizedIntended}"`
          : (readbackResponse.error || 'TradingView quick-search semantic write could not be verified')
      };
    }

    return {
      applicable: true,
      success: true,
      fallbackRecommended: false,
      method: 'ValuePattern',
      setValueResponse,
      readback: {
        text: readbackText,
        normalizedText: normalizedReadback,
        method: readbackResponse.method || 'UIAHost.getText'
      },
      error: null
    };
  }

  async function executeTradingViewQuickSearchTypeAction(action = {}, preferredWindowHandle = 0, runtimeOptions = null) {
    const semanticWrite = await attemptTradingViewQuickSearchSemanticWrite(action, preferredWindowHandle, runtimeOptions);
    if (semanticWrite.applicable && semanticWrite.success) {
      return {
        success: true,
        method: semanticWrite.method,
        fallback: false,
        quickSearchSemanticWrite: semanticWrite
      };
    }

    if (semanticWrite.applicable && !semanticWrite.fallbackRecommended) {
      return {
        success: false,
        method: semanticWrite.method || null,
        fallback: false,
        error: semanticWrite.error || 'TradingView quick-search semantic write failed verification',
        quickSearchSemanticWrite: semanticWrite
      };
    }

    if (typeof systemAutomation.typeText !== 'function') {
      return {
        success: false,
        method: null,
        fallback: semanticWrite.applicable,
        error: 'TradingView typing automation is unavailable for quick-search fallback',
        quickSearchSemanticWrite: semanticWrite
      };
    }

    try {
      throwIfQuickSearchOperationTimedOut(runtimeOptions, 'TradingView Pine quick-search keyboard typing');
      await systemAutomation.typeText(String(action?.text || ''));
      await sleepMs(80);
    } catch (error) {
      return {
        success: false,
        method: null,
        fallback: semanticWrite.applicable,
        error: error?.message || String(error || 'TradingView quick-search keyboard typing failed'),
        quickSearchSemanticWrite: semanticWrite
      };
    }

    return {
      success: true,
      method: 'SendKeys',
      fallback: semanticWrite.applicable,
      quickSearchSemanticWrite: semanticWrite
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
    const actionType = String(action?.type || '').trim().toLowerCase();
    const routeId = String(action?.searchSurfaceContract?.id || '').trim().toLowerCase();
    const route = String(action?.searchSurfaceContract?.route || '').trim().toLowerCase();
    const shortcutId = String(action?.tradingViewShortcut?.id || '').trim().toLowerCase();
    const verifyTarget = String(action?.verify?.target || '').trim().toLowerCase();
    const key = String(action?.key || '').trim().toLowerCase();
    const runtimeOptions = options?.runtimeOptions || null;
    const quickSearchActivation = routeId === 'open-pine-editor' && key === 'enter';
    const directShortcutActivation = shortcutId === 'open-pine-editor' && key === 'ctrl+e';
    const semanticIconActivation = actionType === 'click_element'
      && routeId === 'open-pine-editor'
      && route === 'semantic-icon';
    if (verifyTarget !== 'pine-editor' || (!quickSearchActivation && !directShortcutActivation && !semanticIconActivation)) {
      return null;
    }

    const probeMatchedBeforeClick = await probeTradingViewPineEditorSurface(runtimeOptions);
    if (probeMatchedBeforeClick) {
      const foreground = await systemAutomation.getForegroundWindowInfo();
      return {
        attempted: true,
        recovered: true,
        recoveredBy: 'surface-probe',
        error: null,
        pineEditorSurfaceProbe: probeMatchedBeforeClick,
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

    const tryChartFocusDirectShortcutRecovery = async (dismissQuickSearch = false) => {
      const recoveredBy = dismissQuickSearch ? 'chart-focus-ctrl-e' : 'chart-focus-ctrl-e-retry';
      const trustedWindowHandle = Number(options.expectedWindowHandle || 0)
        || Number(observationCheckpoint?.foreground?.hwnd || 0)
        || Number(checkpointBeforeForeground?.hwnd || 0)
        || 0;

      const trustedWindow = await getQuickSearchTrustedWindowInfo(trustedWindowHandle, checkpointBeforeForeground);
      const explicitChartFocusPoint = (() => {
        const x = Number(options?.chartFocusPoint?.x);
        const y = Number(options?.chartFocusPoint?.y);
        const pointWindowHandle = Number(options?.chartFocusPoint?.windowHandle || 0) || 0;
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return null;
        }
        if (pointWindowHandle > 0 && trustedWindowHandle > 0 && pointWindowHandle !== trustedWindowHandle) {
          return null;
        }
        return {
          x: Math.round(x),
          y: Math.round(y)
        };
      })();
      const chartFocusPoint = explicitChartFocusPoint
        || computeTradingViewChartFocusPoint(trustedWindow || checkpointBeforeForeground || observationCheckpoint?.foreground || null);
      if (!chartFocusPoint || typeof systemAutomation.click !== 'function' || typeof systemAutomation.pressKey !== 'function') {
        return null;
      }

      let dismissQuickSearchResult = null;
      if (dismissQuickSearch) {
        dismissQuickSearchResult = {
          attempted: true,
          success: true,
          key: 'escape'
        };
        try {
          throwIfQuickSearchOperationTimedOut(runtimeOptions, 'TradingView Pine Editor recovery');
          await systemAutomation.pressKey('escape', {
            searchSurfaceContract: {
              appName: 'TradingView'
            }
          });
          await sleepMs(140);
        } catch (error) {
          dismissQuickSearchResult = {
            attempted: true,
            success: false,
            key: 'escape',
            error: error?.message || String(error || 'TradingView quick-search dismissal failed')
          };
        }

        if (!dismissQuickSearchResult.success) {
          return {
            attempted: true,
            recovered: false,
            recoveredBy,
            error: dismissQuickSearchResult.error || 'TradingView quick-search dismissal failed',
            pineEditorQuickSearchDismissal: dismissQuickSearchResult
          };
        }
      }

      const chartFocusClick = {
        attempted: true,
        success: true,
        coordinates: chartFocusPoint
      };

      try {
        throwIfQuickSearchOperationTimedOut(runtimeOptions, 'TradingView Pine Editor recovery');
        await systemAutomation.click(chartFocusPoint.x, chartFocusPoint.y, 'left');
        await sleepMs(240);
      } catch (error) {
        chartFocusClick.success = false;
        chartFocusClick.error = error?.message || String(error || 'TradingView chart-focus click failed');
      }

      if (!chartFocusClick.success) {
        return {
          attempted: true,
          recovered: false,
          recoveredBy,
          error: chartFocusClick.error || 'TradingView chart-focus click failed',
          ...(dismissQuickSearchResult ? { pineEditorQuickSearchDismissal: dismissQuickSearchResult } : {}),
          pineEditorChartFocusClick: chartFocusClick
        };
      }

      let directShortcut = {
        attempted: true,
        success: true,
        key: 'ctrl+e'
      };
      try {
        throwIfQuickSearchOperationTimedOut(runtimeOptions, 'TradingView Pine Editor recovery');
        await systemAutomation.pressKey('ctrl+e', {
          tradingViewShortcut: {
            id: 'open-pine-editor',
            surface: 'pine-editor'
          },
          ...(dismissQuickSearch ? {
            searchSurfaceContract: {
              appName: 'TradingView'
            }
          } : {})
        });
        await sleepMs(320);
      } catch (error) {
        directShortcut = {
          attempted: true,
          success: false,
          key: 'ctrl+e',
          error: error?.message || String(error || 'TradingView direct Pine shortcut failed')
        };
      }

      if (!directShortcut.success) {
        return {
          attempted: true,
          recovered: false,
          recoveredBy,
          error: directShortcut.error || 'TradingView direct Pine shortcut failed',
          ...(dismissQuickSearchResult ? { pineEditorQuickSearchDismissal: dismissQuickSearchResult } : {}),
          pineEditorDirectShortcut: directShortcut,
          pineEditorChartFocusClick: chartFocusClick
        };
      }

      throwIfQuickSearchOperationTimedOut(runtimeOptions, 'TradingView Pine Editor recovery');
      const relaxedCheckpoint = await verifyKeyObservationCheckpoint({
        ...checkpointSpec,
        requiresObservedChange: false
      }, checkpointBeforeForeground, {
        expectedWindowHandle: options.expectedWindowHandle
      });

      const probeMatchedAfterShortcut = await probeTradingViewPineEditorSurface(runtimeOptions);
      if (!(relaxedCheckpoint?.verified || probeMatchedAfterShortcut)) {
        return {
          attempted: true,
          recovered: false,
          recoveredBy,
          error: 'TradingView Pine Editor was not observed after bounded chart-focus Ctrl+E recovery',
          ...(dismissQuickSearchResult ? { pineEditorQuickSearchDismissal: dismissQuickSearchResult } : {}),
          pineEditorDirectShortcut: directShortcut,
          pineEditorChartFocusClick: chartFocusClick,
          pineEditorSurfaceProbe: probeMatchedAfterShortcut || null
        };
      }

      const foreground = relaxedCheckpoint?.foreground?.success
        ? relaxedCheckpoint.foreground
        : await systemAutomation.getForegroundWindowInfo();

      return {
        attempted: true,
        recovered: true,
        recoveredBy,
        error: null,
        ...(dismissQuickSearchResult ? { pineEditorQuickSearchDismissal: dismissQuickSearchResult } : {}),
        pineEditorChartFocusClick: chartFocusClick,
        pineEditorDirectShortcut: directShortcut,
        pineEditorSurfaceProbe: probeMatchedAfterShortcut || null,
        checkpoint: {
          ...observationCheckpoint,
          ...(relaxedCheckpoint || {}),
          verified: true,
          error: null,
          editorActiveMatched: true,
          foreground,
          matchReason: relaxedCheckpoint?.matchReason || (dismissQuickSearch ? 'chart-focus-ctrl-e-recovery' : 'chart-focus-ctrl-e-retry'),
          recoveredBy,
          pineEditorSurfaceProbe: probeMatchedAfterShortcut || null,
          ...(dismissQuickSearchResult ? { pineEditorQuickSearchDismissal: dismissQuickSearchResult } : {}),
          pineEditorDirectShortcut: directShortcut,
          pineEditorChartFocusClick: chartFocusClick
        }
      };
    };

    const tryQuickSearchFallbackRecovery = async (initialDirectShortcutRecovery = null) => {
      const quickSearchRuntimeOptions = runtimeOptions || createQuickSearchRuntimeOptions(
        getTradingViewPineQuickSearchRecoveryTimeoutMs(),
        'TradingView Pine quick-search fallback'
      );
      if (quickSearchRuntimeOptions && typeof quickSearchRuntimeOptions === 'object') {
        quickSearchRuntimeOptions.preferWindowGuessFirst = true;
        quickSearchRuntimeOptions.skipClipboardSurfaceDiscovery = true;
        quickSearchRuntimeOptions.keepSelectionForTyping = true;
        quickSearchRuntimeOptions.skipSelectionForegroundRefresh = true;
        quickSearchRuntimeOptions.allowPostClearAssumedReady = true;
        quickSearchRuntimeOptions.allowDeferredPineQuickSearchTypedVerification = true;
        const cachedQuickSearchForeground = observationCheckpoint?.foreground?.success
          ? observationCheckpoint.foreground
          : (checkpointBeforeForeground?.success ? checkpointBeforeForeground : null);
        if (cachedQuickSearchForeground?.success) {
          quickSearchRuntimeOptions.cachedQuickSearchForeground = cachedQuickSearchForeground;
        }
      }
      const preferredWindowHandle = Number(options.expectedWindowHandle || 0)
        || Number(observationCheckpoint?.foreground?.hwnd || 0)
        || Number(checkpointBeforeForeground?.hwnd || 0)
        || 0;
      const routeMetadata = buildTradingViewPineQuickSearchRouteMetadata();
      const typeAction = buildTradingViewPineQuickSearchTypeAction();
      const enterAction = buildTradingViewPineQuickSearchEnterAction();
      const baseMetadata = initialDirectShortcutRecovery
        ? {
            initialDirectShortcutRecovery: summarizePineRecoveryAttempt(initialDirectShortcutRecovery)
          }
        : {};
      const quickSearchOpen = {
        attempted: true,
        success: false,
        key: 'ctrl+k'
      };
      let quickSearchPreflightSummary = null;
      let quickSearchTypeSummary = null;
      let quickSearchTypedVerificationSummary = null;
      let quickSearchEnterSummary = null;

      try {
        if (typeof systemAutomation.pressKey !== 'function') {
          return mergePineRecoveryMetadata(null, {
            ...baseMetadata,
            recoveredBy: 'quick-search-fallback',
            error: 'TradingView keyboard automation is unavailable for Pine Editor quick-search recovery',
            pineEditorQuickSearchOpen: summarizeRecoveryStep({
              ...quickSearchOpen,
              success: false,
              error: 'TradingView keyboard automation is unavailable for Pine Editor quick-search recovery'
            })
          });
        }

        throwIfQuickSearchOperationTimedOut(quickSearchRuntimeOptions, 'TradingView Pine quick-search fallback');
        await systemAutomation.pressKey('ctrl+k', {
          verify: {
            target: 'quick-search'
          },
          searchSurfaceContract: routeMetadata,
          tradingViewShortcut: {
            id: 'symbol-search',
            surface: 'quick-search',
            appName: 'TradingView'
          }
        });
        await sleepMs(220);
        quickSearchOpen.success = true;

        const commandQuickSearchSurface = await probeTradingViewCommandQuickSearchSurface(
          preferredWindowHandle,
          quickSearchRuntimeOptions
        );
        if (commandQuickSearchSurface?.trusted !== true) {
          try {
            await systemAutomation.pressKey('escape', {
              searchSurfaceContract: routeMetadata,
              tradingViewShortcut: routeMetadata
            });
          } catch {}
          return mergePineRecoveryMetadata(null, {
            ...baseMetadata,
            recoveredBy: 'quick-search-fallback',
            error: 'TradingView Ctrl+K did not expose the command quick-search surface for Pine Editor recovery; refusing to type Pine Editor into symbol search',
            pineEditorQuickSearchOpen: summarizeRecoveryStep({
              ...quickSearchOpen,
              success: false,
              error: 'Command quick-search surface was not verified after Ctrl+K'
            })
          });
        }

        const quickSearchPreflight = await ensureTradingViewQuickSearchInputClearBeforeTyping(
          typeAction,
          preferredWindowHandle,
          quickSearchRuntimeOptions
        );
        quickSearchPreflightSummary = summarizeQuickSearchPreflightForRecovery(quickSearchPreflight);
        if (!quickSearchPreflight?.applicable || !quickSearchPreflight?.ready) {
          return mergePineRecoveryMetadata(null, {
            ...baseMetadata,
            recoveredBy: 'quick-search-fallback',
            error: quickSearchPreflight?.error || 'TradingView quick-search input could not be prepared for Pine Editor recovery',
            pineEditorQuickSearchOpen: summarizeRecoveryStep(quickSearchOpen),
            pineEditorQuickSearchPreflight: quickSearchPreflightSummary
          });
        }

        const typeActionWithPreflight = {
          ...typeAction,
          quickSearchPreflight
        };
        const typeResult = await executeTradingViewQuickSearchTypeAction(
          typeActionWithPreflight,
          preferredWindowHandle,
          quickSearchRuntimeOptions
        );
        quickSearchTypeSummary = summarizeQuickSearchTypeResultForRecovery(typeResult);
        if (typeResult?.success !== true) {
          return mergePineRecoveryMetadata(null, {
            ...baseMetadata,
            recoveredBy: 'quick-search-fallback',
            error: typeResult?.error || 'TradingView quick-search typing failed during Pine Editor recovery',
            pineEditorQuickSearchOpen: summarizeRecoveryStep(quickSearchOpen),
            pineEditorQuickSearchPreflight: quickSearchPreflightSummary,
            pineEditorQuickSearchType: quickSearchTypeSummary
          });
        }

        const typedVerification = await verifyTradingViewQuickSearchTypedValue(
          typeActionWithPreflight,
          typeResult,
          preferredWindowHandle,
          quickSearchRuntimeOptions
        );
        quickSearchTypedVerificationSummary = summarizeQuickSearchTypedVerificationForRecovery(typedVerification);
        if (typedVerification?.verified !== true && typedVerification?.deferred !== true) {
          return mergePineRecoveryMetadata(null, {
            ...baseMetadata,
            recoveredBy: 'quick-search-fallback',
            error: typedVerification?.error || 'TradingView quick-search query could not be verified during Pine Editor recovery',
            pineEditorQuickSearchOpen: summarizeRecoveryStep(quickSearchOpen),
            pineEditorQuickSearchPreflight: quickSearchPreflightSummary,
            pineEditorQuickSearchType: quickSearchTypeSummary,
            pineEditorQuickSearchTypedVerification: quickSearchTypedVerificationSummary
          });
        }

        throwIfQuickSearchOperationTimedOut(quickSearchRuntimeOptions, 'TradingView Pine quick-search fallback');
        await sleepMs(260);

        const quickSearchEnter = {
          attempted: true,
          success: true,
          key: 'enter'
        };
        try {
          throwIfQuickSearchOperationTimedOut(quickSearchRuntimeOptions, 'TradingView Pine quick-search fallback');
          await systemAutomation.pressKey('enter', enterAction);
          await sleepMs(220);
        } catch (error) {
          quickSearchEnter.success = false;
          quickSearchEnter.error = error?.message || String(error || 'TradingView quick-search Enter failed');
        }
        quickSearchEnterSummary = summarizeRecoveryStep(quickSearchEnter);
        if (!quickSearchEnter.success) {
          return mergePineRecoveryMetadata(null, {
            ...baseMetadata,
            recoveredBy: 'quick-search-fallback',
            error: quickSearchEnter.error || 'TradingView quick-search Enter failed during Pine Editor recovery',
            pineEditorQuickSearchOpen: summarizeRecoveryStep(quickSearchOpen),
            pineEditorQuickSearchPreflight: quickSearchPreflightSummary,
            pineEditorQuickSearchType: quickSearchTypeSummary,
            pineEditorQuickSearchTypedVerification: quickSearchTypedVerificationSummary,
            pineEditorQuickSearchEnter: quickSearchEnterSummary
          });
        }

        throwIfQuickSearchOperationTimedOut(quickSearchRuntimeOptions, 'TradingView Pine quick-search fallback');
        const relaxedCheckpoint = await verifyKeyObservationCheckpoint({
          ...checkpointSpec,
          requiresObservedChange: false
        }, checkpointBeforeForeground, {
          expectedWindowHandle: options.expectedWindowHandle
        });

        const probeMatchedAfterEnter = await probeTradingViewPineEditorSurface(quickSearchRuntimeOptions);
        if (relaxedCheckpoint?.verified || probeMatchedAfterEnter) {
          const foreground = relaxedCheckpoint?.foreground?.success
            ? relaxedCheckpoint.foreground
            : await systemAutomation.getForegroundWindowInfo();
          return mergePineRecoveryMetadata({
            attempted: true,
            recovered: true,
            recoveredBy: 'quick-search-enter',
            error: null,
            pineEditorSurfaceProbe: probeMatchedAfterEnter || null,
            checkpoint: {
              ...observationCheckpoint,
              ...(relaxedCheckpoint || {}),
              verified: true,
              error: null,
              editorActiveMatched: true,
              foreground,
              matchReason: relaxedCheckpoint?.matchReason || 'quick-search-enter-recovery',
              recoveredBy: 'quick-search-enter',
              pineEditorSurfaceProbe: probeMatchedAfterEnter || null
            }
          }, {
            ...baseMetadata,
            pineEditorQuickSearchOpen: summarizeRecoveryStep(quickSearchOpen),
            pineEditorQuickSearchPreflight: quickSearchPreflightSummary,
            pineEditorQuickSearchType: quickSearchTypeSummary,
            pineEditorQuickSearchTypedVerification: quickSearchTypedVerificationSummary,
            pineEditorQuickSearchEnter: quickSearchEnterSummary
          });
        }

        return mergePineRecoveryMetadata(null, {
          ...baseMetadata,
          recoveredBy: 'quick-search-fallback',
          error: 'TradingView Pine quick-search fallback did not expose the Pine Editor surface after Enter; refusing to change Pine routes again',
          pineEditorSurfaceProbe: probeMatchedAfterEnter || null,
          pineEditorQuickSearchOpen: summarizeRecoveryStep(quickSearchOpen),
          pineEditorQuickSearchPreflight: quickSearchPreflightSummary,
          pineEditorQuickSearchType: quickSearchTypeSummary,
          pineEditorQuickSearchTypedVerification: quickSearchTypedVerificationSummary,
          pineEditorQuickSearchEnter: quickSearchEnterSummary
        });
      } catch (error) {
        quickSearchOpen.error = quickSearchOpen.success === true
          ? null
          : (error?.message || String(error || 'TradingView Pine quick-search fallback failed'));
        return mergePineRecoveryMetadata(null, {
          ...baseMetadata,
          recoveredBy: 'quick-search-fallback',
          error: error?.message || String(error || 'TradingView Pine quick-search fallback failed'),
          pineEditorQuickSearchOpen: summarizeRecoveryStep(quickSearchOpen),
          pineEditorQuickSearchPreflight: quickSearchPreflightSummary,
          pineEditorQuickSearchType: quickSearchTypeSummary,
          pineEditorQuickSearchTypedVerification: quickSearchTypedVerificationSummary,
          pineEditorQuickSearchEnter: quickSearchEnterSummary
        });
      }
    };

    if (directShortcutActivation) {
      const directShortcutRecovery = await tryChartFocusDirectShortcutRecovery(false);
      if (directShortcutRecovery?.recovered) {
        return directShortcutRecovery;
      }

      const quickSearchFallbackRecovery = await tryQuickSearchFallbackRecovery(directShortcutRecovery);
      return quickSearchFallbackRecovery || directShortcutRecovery || null;
    }

    if (semanticIconActivation) {
      return tryChartFocusDirectShortcutRecovery(false);
    }

    return tryChartFocusDirectShortcutRecovery(true);
  }

  return {
    ensureTradingViewQuickSearchInputClearBeforeTyping,
    executeTradingViewQuickSearchTypeAction,
    verifyTradingViewQuickSearchTypedValue,
    maybeRecoverTradingViewQuickSearchOpen,
    maybeRecoverTradingViewPineEditorOpen
  };
}

module.exports = {
  createTradingViewRuntimeRecovery
};
