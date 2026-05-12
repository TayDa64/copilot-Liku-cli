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
const WATCHER_FOREGROUND_FRESH_MS = 1500;

const TRADINGVIEW_QUICK_SEARCH_EMPTY_TEXT_PATTERNS = Object.freeze([
  /^$/,
  /^search$/i,
  /^search\s+tool\s+or\s+function$/i
]);

const PINE_EDITOR_WATCHER_SURFACE_ANCHORS = Object.freeze([
  'Add to chart',
  'Publish script',
  'Update on chart',
  'Script saved',
  'Untitled script',
  'Save script',
  'Save as',
  'Rename script'
]);

function createTradingViewRuntimeRecovery(deps = {}) {
  const {
    systemAutomation,
    getUIWatcher,
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

  function getFreshWatcherForeground(expectedWindowHandle = 0, maxAgeMs = WATCHER_FOREGROUND_FRESH_MS) {
    const watcher = typeof getUIWatcher === 'function'
      ? getUIWatcher()
      : null;
    if (!watcher?.cache?.activeWindow) {
      return {
        watcher: null,
        available: false,
        fresh: false,
        ageMs: Number.POSITIVE_INFINITY,
        lastUpdate: 0,
        updateCount: 0,
        foreground: null,
        matchesExpectedWindow: expectedWindowHandle <= 0
      };
    }

    const lastUpdate = Number(watcher.cache.lastUpdate || 0) || 0;
    const ageMs = lastUpdate > 0 ? Math.max(0, Date.now() - lastUpdate) : Number.POSITIVE_INFINITY;
    const foreground = normalizeWatcherForeground(watcher.cache.activeWindow, 'watcher-cache');
    const foregroundHwnd = Number(foreground?.hwnd || 0) || 0;

    return {
      watcher,
      available: true,
      fresh: ageMs <= (Math.max(0, Number(maxAgeMs || 0)) || WATCHER_FOREGROUND_FRESH_MS),
      ageMs,
      lastUpdate,
      updateCount: Number(watcher.cache.updateCount || 0) || 0,
      foreground,
      matchesExpectedWindow: expectedWindowHandle <= 0 || !foregroundHwnd || foregroundHwnd === expectedWindowHandle
    };
  }

  function cacheTrustedTradingViewForeground(runtimeOptions = null, foreground = null) {
    if (!runtimeOptions || typeof runtimeOptions !== 'object' || !foreground?.success) {
      return foreground;
    }

    if (normalizeQuickSearchWindowProcessName(foreground?.processName || '') === 'tradingview') {
      runtimeOptions.cachedQuickSearchForeground = foreground;
    }

    return foreground;
  }

  function getCachedTrustedTradingViewForeground(expectedWindowHandle = 0, runtimeOptions = null) {
    const cachedForeground = runtimeOptions?.cachedQuickSearchForeground;
    const cachedForegroundHandle = Number(cachedForeground?.hwnd || 0) || 0;
    if (
      cachedForeground?.success
      && normalizeQuickSearchWindowProcessName(cachedForeground?.processName || '') === 'tradingview'
      && (!expectedWindowHandle || !cachedForegroundHandle || expectedWindowHandle === cachedForegroundHandle)
    ) {
      return cachedForeground;
    }

    return null;
  }

  async function getPreferredForegroundInfo(preferredWindowHandle = 0, runtimeOptions = null, options = {}) {
    const expectedWindowHandle = Number(
      preferredWindowHandle
      || runtimeOptions?.expectedWindowHandle
      || runtimeOptions?.windowHandle
      || 0
    ) || 0;
    const requireTradingView = options.requireTradingView === true;

    if (requireTradingView) {
      const cachedForeground = getCachedTrustedTradingViewForeground(expectedWindowHandle, runtimeOptions);
      if (cachedForeground) {
        return {
          foreground: cachedForeground,
          source: 'cache',
          watcher: null
        };
      }
    }

    const watcherState = getFreshWatcherForeground(
      expectedWindowHandle,
      Math.max(0, Number(options.maxWatcherAgeMs || 0)) || WATCHER_FOREGROUND_FRESH_MS
    );
    if (
      watcherState.fresh
      && watcherState.foreground?.success
      && watcherState.matchesExpectedWindow !== false
      && (
        !requireTradingView
        || normalizeQuickSearchWindowProcessName(watcherState.foreground?.processName || '') === 'tradingview'
      )
    ) {
      cacheTrustedTradingViewForeground(runtimeOptions, watcherState.foreground);
      return {
        foreground: watcherState.foreground,
        source: 'watcher',
        watcher: watcherState
      };
    }

    let foreground = null;
    try {
      foreground = await systemAutomation.getForegroundWindowInfo();
    } catch {
      foreground = null;
    }

    if (
      foreground?.success
      && normalizeQuickSearchWindowProcessName(foreground?.processName || '') === 'tradingview'
    ) {
      cacheTrustedTradingViewForeground(runtimeOptions, foreground);
    }

    if (
      requireTradingView
      && normalizeQuickSearchWindowProcessName(foreground?.processName || '') !== 'tradingview'
    ) {
      return {
        foreground: null,
        source: 'system-automation-non-tradingview',
        watcher: watcherState,
        systemForeground: foreground
      };
    }

    return {
      foreground: foreground?.success ? foreground : null,
      source: 'system-automation',
      watcher: watcherState,
      systemForeground: foreground
    };
  }

  function buildForegroundStateKey(foreground = null) {
    if (!foreground || typeof foreground !== 'object') {
      return '';
    }

    return [
      Number(foreground?.hwnd || 0) || 0,
      normalizeTradingViewQuickSearchDiscoveryText(foreground?.processName || ''),
      normalizeTradingViewQuickSearchDiscoveryText(foreground?.title || ''),
      normalizeTradingViewQuickSearchDiscoveryText(foreground?.windowKind || '')
    ].join('|');
  }

  function normalizeWatcherProbeBounds(bounds = null) {
    const geometry = getNormalizedBoundsGeometry(bounds);
    if (!geometry) {
      return null;
    }

    return {
      X: geometry.x,
      Y: geometry.y,
      Width: geometry.width,
      Height: geometry.height,
      CenterX: Math.round(geometry.x + (geometry.width / 2)),
      CenterY: Math.round(geometry.y + (geometry.height / 2))
    };
  }

  function normalizeWatcherProbeElement(element = null) {
    if (!element || typeof element !== 'object') {
      return null;
    }

    const controlTypeRaw = String(
      element?.ControlType
      || element?.controlType
      || element?.type
      || ''
    ).trim();
    const controlType = controlTypeRaw
      ? (controlTypeRaw.startsWith('ControlType.') ? controlTypeRaw : `ControlType.${controlTypeRaw}`)
      : '';

    return {
      Name: String(element?.Name || element?.name || ''),
      Value: String(element?.Value || element?.value || ''),
      ControlType: controlType,
      AutomationId: String(element?.AutomationId || element?.automationId || ''),
      ClassName: String(element?.ClassName || element?.className || ''),
      WindowHandle: Number(element?.WindowHandle || element?.windowHandle || 0) || 0,
      Bounds: normalizeWatcherProbeBounds(element?.Bounds || element?.bounds)
    };
  }

  function getWatcherTextEvidenceMatch(watcher = null, anchors = [], foreground = null) {
    if (!watcher?.cache || !Array.isArray(watcher.cache.elements)) {
      return { matched: false, anchor: null, element: null };
    }

    const normalizedAnchors = (Array.isArray(anchors) ? anchors : [])
      .map((anchor) => ({
        raw: String(anchor || '').trim(),
        normalized: normalizeTradingViewQuickSearchDiscoveryText(anchor)
      }))
      .filter((entry) => entry.raw && entry.normalized);
    if (!normalizedAnchors.length) {
      return { matched: false, anchor: null, element: null };
    }

    const activeHwnd = Number(foreground?.hwnd || watcher.cache.activeWindow?.hwnd || 0) || 0;
    const scopedElements = activeHwnd > 0
      ? watcher.cache.elements.filter((element) => Number(element?.windowHandle || element?.WindowHandle || 0) === activeHwnd)
      : watcher.cache.elements.slice();

    for (const element of scopedElements) {
      const haystack = normalizeTradingViewQuickSearchDiscoveryText([
        element?.name,
        element?.Name,
        element?.value,
        element?.Value,
        element?.automationId,
        element?.AutomationId,
        element?.className,
        element?.ClassName,
        element?.type,
        element?.ControlType
      ].filter(Boolean).join(' '));
      if (!haystack) {
        continue;
      }

      for (const anchor of normalizedAnchors) {
        if (haystack.includes(anchor.normalized)) {
          return {
            matched: true,
            anchor: anchor.raw,
            element: normalizeWatcherProbeElement(element)
          };
        }
      }
    }

    return { matched: false, anchor: null, element: null };
  }

  function buildPineSurfaceProbeStateKey(expectedWindowHandle = 0, watcherState = null, foreground = null) {
    const effectiveForeground = foreground?.success
      ? foreground
      : watcherState?.foreground;

    return [
      Number(expectedWindowHandle || 0) || 0,
      Number(watcherState?.lastUpdate || 0) || 0,
      Number(watcherState?.updateCount || 0) || 0,
      watcherState?.matchesExpectedWindow === false ? 'window-mismatch' : 'window-match',
      buildForegroundStateKey(effectiveForeground)
    ].join('|');
  }

  function getCachedSurfaceProbeResult(runtimeOptions = null, cacheName = '', stateKey = '') {
    if (!runtimeOptions || typeof runtimeOptions !== 'object' || !cacheName || !stateKey) {
      return undefined;
    }

    const cache = runtimeOptions[cacheName];
    if (!cache || cache.key !== stateKey || !Object.prototype.hasOwnProperty.call(cache, 'result')) {
      return undefined;
    }

    return cache.result;
  }

  function cacheSurfaceProbeResult(runtimeOptions = null, cacheName = '', stateKey = '', result = null) {
    if (!runtimeOptions || typeof runtimeOptions !== 'object' || !cacheName || !stateKey) {
      return result;
    }

    runtimeOptions[cacheName] = {
      key: stateKey,
      result
    };
    return result;
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

  function shouldAllowLegacyPineSurfaceTextProbe(runtimeOptions = null) {
    if (runtimeOptions?.allowLegacyPineSurfaceTextProbe === true) {
      return true;
    }

    return /^(1|true|yes)$/i.test(String(process.env.LIKU_ENABLE_LEGACY_PINE_SURFACE_TEXT_PROBE || '').trim());
  }

  function shouldAllowLegacyQuickSearchTextProbe(runtimeOptions = null) {
    if (runtimeOptions?.allowLegacyQuickSearchTextProbe === true) {
      return true;
    }

    return /^(1|true|yes)$/i.test(String(process.env.LIKU_ENABLE_LEGACY_QUICK_SEARCH_TEXT_PROBE || '').trim());
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

  function hasAuthoritativeTradingViewQuickSearchSurfaceProof(probe = null, expectedWindowHandle = 0) {
    if (!probe || probe.trusted !== true) {
      return false;
    }

    const expectedHwnd = Number(expectedWindowHandle || 0) || 0;
    const elementWindowHandle = Number(probe?.element?.WindowHandle || probe?.element?.windowHandle || 0) || 0;
    const trustReason = String(probe?.trustReason || '').trim().toLowerCase();
    const matchedBy = String(probe?.matchedBy || '').trim().toLowerCase();

    if (expectedHwnd > 0 && elementWindowHandle > 0 && elementWindowHandle === expectedHwnd) {
      return true;
    }

    if (trustReason === 'expected-window' || trustReason === 'foreground-window') {
      return true;
    }

    return /^uia-host-focused-/.test(matchedBy);
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
      pineEditorSurfaceProbe: recovery.pineEditorSurfaceProbe || null,
      pineEditorCommandSurfaceProbe: recovery.pineEditorCommandSurfaceProbe || null
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

  function shouldSkipQuickSearchFallbackAfterSemanticActivation(observationCheckpoint = null, directShortcutRecovery = null, semanticActivationProof = null) {
    if (!directShortcutRecovery || typeof directShortcutRecovery !== 'object' || directShortcutRecovery.recovered === true) {
      return false;
    }

    const proofIndicatesRendererProofUnavailable = semanticActivationProof
      && typeof semanticActivationProof === 'object'
      && String(semanticActivationProof.disposition || '').trim().toLowerCase() === 'renderer-proof-unavailable';
    const proofIndicatesStateChangeWithoutSurface = semanticActivationProof
      && typeof semanticActivationProof === 'object'
      && semanticActivationProof.observedChange === true
      && semanticActivationProof.pineSurfaceObserved !== true
      && String(semanticActivationProof.disposition || '').trim().toLowerCase() === 'window-state-changed-without-pine-surface';
    const checkpointIndicatesStateChangeWithoutSurface = observationCheckpoint
      && typeof observationCheckpoint === 'object'
      && observationCheckpoint.verified !== true
      && observationCheckpoint.observedChange === true
      && observationCheckpoint.hostSurfaceMatched !== true
      && observationCheckpoint.watcherSurfaceMatched !== true;

    if (
      !proofIndicatesRendererProofUnavailable
      && !proofIndicatesStateChangeWithoutSurface
      && !checkpointIndicatesStateChangeWithoutSurface
    ) {
      return false;
    }

    const recoverySurfaceObserved = directShortcutRecovery?.checkpoint?.verified === true
      || directShortcutRecovery?.pineEditorSurfaceProbe?.matched === true
      || directShortcutRecovery?.pineEditorSurfaceProbe?.active === true;
    if (recoverySurfaceObserved) {
      return false;
    }

    const processName = normalizeQuickSearchWindowProcessName(
      observationCheckpoint?.foreground?.processName
      || semanticActivationProof?.foreground?.processName
      || semanticActivationProof?.after?.foreground?.processName
      || semanticActivationProof?.before?.foreground?.processName
      || observationCheckpoint?.beforeForeground?.processName
      || ''
    );
    if (processName && processName !== 'tradingview') {
      return false;
    }

    return true;
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

  async function saveCurrentClipboardState() {
    if (typeof systemAutomation.saveClipboardState === 'function') {
      try {
        const result = await systemAutomation.saveClipboardState();
        if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'success')) {
          return {
            success: result.success === true,
            token: String(result.token || ''),
            text: String(result.text || ''),
            mode: String(result.mode || (result.token ? 'host-token' : 'text') || ''),
            error: result.error || null,
            source: result.source || null,
            containsText: result.containsText === true,
            textLength: Number(result.textLength || 0) || 0
          };
        }
      } catch (error) {
        return {
          success: false,
          token: '',
          text: '',
          mode: '',
          error: error?.message || String(error || 'Clipboard state save failed'),
          source: null,
          containsText: false,
          textLength: 0
        };
      }
    }

    const fallbackRead = await readClipboardText();
    return {
      success: fallbackRead.success === true,
      token: '',
      text: String(fallbackRead.text || ''),
      mode: 'text',
      error: fallbackRead.error || null,
      source: fallbackRead.source || null,
      containsText: fallbackRead.success === true,
      textLength: String(fallbackRead.text || '').length
    };
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

  async function restoreSavedClipboardState(savedState = null) {
    if (typeof systemAutomation.restoreClipboardState === 'function') {
      try {
        const result = await systemAutomation.restoreClipboardState(savedState);
        if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'success')) {
          return {
            success: result.success === true,
            error: result.error || null,
            source: result.source || null,
            token: String(result.token || '')
          };
        }
        return { success: true, error: null, source: null, token: '' };
      } catch (error) {
        return {
          success: false,
          error: error?.message || String(error || 'Clipboard restore failed'),
          source: null,
          token: ''
        };
      }
    }

    if (!savedState || savedState.success !== true) {
      return {
        success: false,
        error: savedState?.error || 'Original clipboard could not be restored because it could not be read',
        source: savedState?.source || null,
        token: String(savedState?.token || '')
      };
    }

    return writeClipboardText(savedState.text || '');
  }

  async function getTrustedTradingViewQuickSearchForeground(preferredWindowHandle = 0, runtimeOptions = null) {
    const expectedWindowHandle = Number(preferredWindowHandle || 0) || 0;
    const preferredForeground = await getPreferredForegroundInfo(
      expectedWindowHandle,
      runtimeOptions,
      {
        requireTradingView: true
      }
    );
    const foreground = preferredForeground?.foreground;
    if (!foreground?.success) {
      return null;
    }

    const foregroundHandle = Number(foreground?.hwnd || 0) || 0;
    if (!expectedWindowHandle || !foregroundHandle || expectedWindowHandle === foregroundHandle) {
      cacheTrustedTradingViewForeground(runtimeOptions, foreground);
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

    cacheTrustedTradingViewForeground(runtimeOptions, foreground);
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

    const foregroundContext = await getPreferredForegroundInfo(0, runtimeOptions, {
      requireTradingView: false
    });
    selectionReset.foreground = foregroundContext?.foreground || null;

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
    const originalClipboard = await saveCurrentClipboardState();
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
        ? await restoreSavedClipboardState(originalClipboard)
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

  function shouldAllowTradingViewPineQuickSearchClipboardContinuation(action = {}) {
    return String(action?.searchSurfaceContract?.route || '').trim().toLowerCase() === 'quick-search'
      && String(action?.searchSurfaceContract?.surface || '').trim().toLowerCase() === 'pine-editor';
  }

  function normalizeTradingViewQuickSearchClipboardProofError(
    error = '',
    fallback = 'TradingView quick-search typing could not be verified before continuing'
  ) {
    const raw = String(error || '').trim();
    if (!raw) {
      return fallback;
    }

    if (/hermetic automation test mode blocked live .*clipboard/i.test(raw)) {
      return fallback;
    }

    return raw;
  }

  async function maybePrepareTradingViewPineQuickSearchClipboardContinuation(
    action,
    preferredWindowHandle = 0,
    runtimeOptions = null,
    context = {}
  ) {
    if (!shouldAllowTradingViewPineQuickSearchClipboardContinuation(action)) {
      return null;
    }

    const clipboardFallbackRuntimeOptions = runtimeOptions && typeof runtimeOptions === 'object'
      ? {
          ...runtimeOptions,
          allowPostClearAssumedReady: true
        }
      : { allowPostClearAssumedReady: true };
    const clipboardFallback = await maybeAssumeTradingViewQuickSearchFocusedFromClipboard(
      action,
      preferredWindowHandle,
      clipboardFallbackRuntimeOptions
    );
    if (!clipboardFallback?.ready) {
      if (!clipboardFallback?.applicable) {
        return null;
      }

      return {
        applicable: true,
        ready: true,
        emptyConfirmed: false,
        queryAlreadyPresent: false,
        fallbackAssumedFocused: true,
        fallbackReason: normalizeTradingViewQuickSearchClipboardProofError(
          clipboardFallback?.error || clipboardFallback?.fallbackReason || '',
          'TradingView quick-search clipboard selection could not prove the field state; continue in bounded Pine mode and require post-type verification before Enter'
        ),
        clearedBy: context.keyboardFallback?.success === true
          ? 'keyboard-fallback-assumed-empty'
          : (clipboardFallback?.clearedBy || 'clipboard-selection-miss-assumed-empty'),
        expectedText: context.expectedText || clipboardFallback?.expectedText || getExpectedTradingViewQuickSearchText(action),
        inputFocus: clipboardFallback.inputFocus || context.inputFocus || null,
        focusRecovery: context.focusRecovery || clipboardFallback.focusRecovery || clipboardFallback.inputFocus || context.inputFocus || null,
        initialRead: context.initialRead || clipboardFallback.initialRead || null,
        clearAttempt: context.clearAttempt || clipboardFallback.clearAttempt || null,
        keyboardFallback: context.keyboardFallback || clipboardFallback.keyboardFallback || null,
        finalRead: clipboardFallback.finalRead || context.finalRead || null,
        error: null
      };
    }

    return {
      ...clipboardFallback,
      initialRead: context.initialRead || clipboardFallback.initialRead || null,
      clearAttempt: context.clearAttempt || clipboardFallback.clearAttempt || null,
      keyboardFallback: context.keyboardFallback || clipboardFallback.keyboardFallback || null,
      inputFocus: clipboardFallback.inputFocus || context.inputFocus || null,
      focusRecovery: context.focusRecovery || clipboardFallback.focusRecovery || null,
      finalRead: clipboardFallback.finalRead || context.finalRead || null
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
    const fallbackMatchesHandle = Number(fallbackForeground?.hwnd || 0) === numericHandle;
    const fallbackWindow = fallbackForeground && typeof fallbackForeground === 'object'
      ? fallbackForeground
      : null;

    let windowInfo = null;
    if (typeof systemAutomation.getWindowInfoByHandle === 'function') {
      try {
        const info = await systemAutomation.getWindowInfoByHandle(numericHandle);
        if (info?.success) {
          windowInfo = info;
        }
      } catch {
        windowInfo = null;
      }
    }

    if (fallbackMatchesHandle && fallbackWindow) {
      if (!windowInfo) {
        return fallbackWindow;
      }

      const mergedWindow = {
        ...windowInfo,
        ...fallbackWindow
      };
      if (!getUsableTradingViewWindowBounds(fallbackWindow) && getUsableTradingViewWindowBounds(windowInfo)) {
        if (windowInfo?.bounds && typeof windowInfo.bounds === 'object') {
          mergedWindow.bounds = windowInfo.bounds;
        }
        if (windowInfo?.Bounds && typeof windowInfo.Bounds === 'object') {
          mergedWindow.Bounds = windowInfo.Bounds;
        }
      }
      return mergedWindow;
    }

    return windowInfo;
  }

  async function isTrustedTradingViewQuickSearchMatch(matched, options = {}) {
    if (!matched?.element) {
      return { trusted: false, reason: 'missing-element', trustedWindow: null };
    }

    const elementWindowHandle = Number(matched?.element?.WindowHandle || 0) || 0;
    const expectedWindowHandle = Number(options.expectedWindowHandle || 0) || 0;
    const foreground = options.foreground && typeof options.foreground === 'object'
      ? options.foreground
      : (await getPreferredForegroundInfo(expectedWindowHandle, options.runtimeOptions || null, {
          requireTradingView: false
        }))?.foreground;
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

    const foreground = (await getPreferredForegroundInfo(explicitWindowHandle, runtimeOptions, {
      requireTradingView: false
    }))?.foreground;
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

  function buildTradingViewQuickSearchHostProbeBoundsCandidates(windowInfo = {}, options = {}) {
    const candidates = [];
    const seen = new Set();

    const appendCandidate = (id, bounds) => {
      const hostBounds = convertTradingViewQuickSearchBoundsToHostRect(bounds);
      if (!hostBounds) {
        return;
      }

      const dedupeKey = JSON.stringify(hostBounds);
      if (seen.has(dedupeKey)) {
        return;
      }
      seen.add(dedupeKey);

      candidates.push({
        id,
        bounds: hostBounds,
        hostBounds
      });
    };

    appendCandidate('quick-search-lane', options.searchBounds || buildTradingViewQuickSearchEditBounds(windowInfo));

    if (options.includeWindowBoundsFallback !== false) {
      appendCandidate('window', getUsableTradingViewWindowBounds(windowInfo));
    }

    return candidates;
  }

  async function resolveTradingViewQuickSearchHostContext(preferredWindowHandle = 0, options = {}) {
    const foreground = (await getPreferredForegroundInfo(
      preferredWindowHandle,
      options.runtimeOptions || null,
      {
        requireTradingView: false
      }
    ))?.foreground;

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
      return {
        valid: false,
        foreground,
        trustedWindowHandle,
        trustedWindow,
        searchBounds: null,
        hostBounds: null,
        boundsCandidates: []
      };
    }

    const searchBounds = options.searchBounds || buildTradingViewQuickSearchEditBounds(trustedWindow);
    const boundsCandidates = buildTradingViewQuickSearchHostProbeBoundsCandidates(trustedWindow, {
      searchBounds,
      includeWindowBoundsFallback: options.includeWindowBoundsFallback
    });
    if (!boundsCandidates.length && trustedWindowHandle > 0) {
      boundsCandidates.push({
        id: 'window-unbounded',
        bounds: null,
        hostBounds: null,
        unbounded: true
      });
    }

    return {
      valid: true,
      foreground,
      trustedWindowHandle,
      trustedWindow,
      searchBounds,
      hostBounds: boundsCandidates[0]?.hostBounds || null,
      boundsCandidates
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

    const hostContext = await resolveTradingViewQuickSearchHostContext(preferredWindowHandle, {
      runtimeOptions,
      searchBounds: options.searchBounds || null,
      includeWindowBoundsFallback: false
    });
    if (!hostContext.valid) {
      return null;
    }

    const {
      foreground,
      trustedWindowHandle,
      trustedWindow,
      searchBounds,
      hostBounds
    } = hostContext;

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

  function doTradingViewQuickSearchBoundsIntersect(left = null, right = null) {
    const normalizedLeft = getNormalizedBoundsGeometry(left);
    const normalizedRight = getNormalizedBoundsGeometry(right);
    if (!normalizedLeft || !normalizedRight) {
      return false;
    }

    return normalizedLeft.x < normalizedRight.x + normalizedRight.width
      && normalizedLeft.x + normalizedLeft.width > normalizedRight.x
      && normalizedLeft.y < normalizedRight.y + normalizedRight.height
      && normalizedLeft.y + normalizedLeft.height > normalizedRight.y;
  }

  async function findTradingViewQuickSearchFocusedHostSurface(preferredWindowHandle = 0, runtimeOptions = null, options = {}) {
    throwIfQuickSearchOperationTimedOut(runtimeOptions);
    if (typeof systemAutomation.getFocusedElementInWindowWithHost !== 'function') {
      return null;
    }

    const hostContext = await resolveTradingViewQuickSearchHostContext(preferredWindowHandle, {
      runtimeOptions,
      searchBounds: options.searchBounds || null,
      includeWindowBoundsFallback: false
    });
    if (!hostContext.valid) {
      return null;
    }

    let focusedProbe = null;
    try {
      focusedProbe = await systemAutomation.getFocusedElementInWindowWithHost(hostContext.trustedWindowHandle);
      throwIfQuickSearchOperationTimedOut(runtimeOptions);
    } catch {
      focusedProbe = null;
    }

    const fallbackResult = {
      matched: false,
      text: null,
      exact: false,
      controlType: null,
      matchedBy: String(options.matchedBy || 'uia-host-focused-element-probe'),
      element: null,
      foreground: hostContext.foreground,
      trusted: false,
      trustReason: 'focused-element-unavailable',
      trustedWindow: hostContext.trustedWindow || null,
      candidateScore: null,
      hostFocusedProbe: {
        reason: focusedProbe?.reason || null,
        searchBounds: hostContext.searchBounds || null,
        stats: focusedProbe?.stats || null
      }
    };

    if (focusedProbe?.success !== true || focusedProbe?.focused !== true || !focusedProbe?.element) {
      return fallbackResult;
    }

    const metadata = getTradingViewQuickSearchCandidateMetadata(focusedProbe.element);
    const candidateScore = scoreTradingViewQuickSearchCandidate(focusedProbe.element, hostContext.trustedWindow || {});
    const likelyQuickSearchInput = Number.isFinite(candidateScore)
      && candidateScore >= TRADINGVIEW_QUICK_SEARCH_EDIT_SCORE_MIN
      && /(edit|combobox|document|text)/.test(metadata.controlType)
      && doTradingViewQuickSearchBoundsIntersect(metadata.bounds, hostContext.searchBounds || null);
    const genericSearchMatched = /\bsearch\b/.test(metadata.haystack);
    const commandMarkerMatched = /search\s+tool\s+or\s+function|nothing\s+matches\s+your\s+criteria/.test(metadata.haystack);
    const matched = commandMarkerMatched || genericSearchMatched || likelyQuickSearchInput;
    const trusted = options.requireCommandSurface === true
      ? commandMarkerMatched
      : matched;
    const trustReason = trusted
      ? String(options.trustReason || options.matchedBy || 'uia-host-focused-element-probe')
      : (
        options.requireCommandSurface === true
          ? (genericSearchMatched || likelyQuickSearchInput ? 'generic-search-only' : 'focused-element-not-command-surface')
          : 'focused-element-not-quick-search'
      );

    return {
      matched,
      text: String(
        focusedProbe.element?.Name
        || focusedProbe.element?.Value
        || focusedProbe.element?.name
        || focusedProbe.element?.value
        || ''
      ).trim(),
      exact: commandMarkerMatched,
      controlType: String(
        focusedProbe.element?.ControlType
        || focusedProbe.element?.controlType
        || ''
      ).replace(/^ControlType\./i, '').trim() || null,
      matchedBy: String(options.matchedBy || 'uia-host-focused-element-probe'),
      element: focusedProbe.element,
      foreground: hostContext.foreground,
      trusted,
      trustReason,
      trustedWindow: hostContext.trustedWindow || null,
      candidateScore: Number.isFinite(candidateScore) ? candidateScore : null,
      hostFocusedProbe: {
        reason: focusedProbe?.reason || null,
        searchBounds: hostContext.searchBounds || null,
        stats: focusedProbe?.stats || null,
        genericSearchMatched,
        commandMarkerMatched,
        likelyQuickSearchInput
      }
    };
  }

  function augmentTradingViewQuickSearchSurfaceProbeWithFocusedElement(probe = null, focusedProbe = null) {
    if (!probe || typeof probe !== 'object' || !focusedProbe || typeof focusedProbe !== 'object') {
      return probe;
    }

    const focusedElementProbe = {
      matched: focusedProbe.matched === true,
      trusted: focusedProbe.trusted === true,
      trustReason: focusedProbe.trustReason || null,
      text: focusedProbe.text || null,
      controlType: focusedProbe.controlType || null,
      candidateScore: Number.isFinite(Number(focusedProbe.candidateScore))
        ? Number(focusedProbe.candidateScore)
        : null,
      hostFocusedProbe: focusedProbe.hostFocusedProbe || null,
      element: focusedProbe.element || null
    };

    return {
      ...probe,
      focusedElementProbe,
      commandSurfaceProbe: probe.commandSurfaceProbe && typeof probe.commandSurfaceProbe === 'object'
        ? {
            ...probe.commandSurfaceProbe,
            focusedElementProbe
          }
        : probe.commandSurfaceProbe
    };
  }

  function formatTradingViewQuickSearchProbeFailureReason(probe = null) {
    if (!probe || typeof probe !== 'object') {
      return null;
    }

    const focusedProbe = probe.focusedElementProbe && typeof probe.focusedElementProbe === 'object'
      ? probe.focusedElementProbe
      : (probe.hostFocusedProbe ? probe : null);
    if (focusedProbe) {
      const controlType = String(focusedProbe.controlType || focusedProbe?.element?.ControlType || '')
        .replace(/^ControlType\./i, '')
        .trim();
      const rawText = String(
        focusedProbe.text
        || focusedProbe?.element?.Name
        || focusedProbe?.element?.Value
        || ''
      ).replace(/\s+/g, ' ').trim();
      const displayText = rawText ? `"${rawText.slice(0, 80)}"` : null;
      const trustReason = String(focusedProbe.trustReason || '').trim();
      const focusReason = String(focusedProbe?.hostFocusedProbe?.reason || '').trim();

      if (controlType || displayText || trustReason || focusReason) {
        return [
          'focused element remained',
          [controlType || 'unknown', displayText].filter(Boolean).join(' '),
          [trustReason, focusReason].filter(Boolean).join(', ')
        ].filter(Boolean).join(' ');
      }
    }

    const trustReason = String(probe.trustReason || '').trim();
    return trustReason || null;
  }

  async function findTradingViewQuickSearchHostTextSurface(preferredWindowHandle = 0, candidates = [], runtimeOptions = null, options = {}) {
    throwIfQuickSearchOperationTimedOut(runtimeOptions);
    if (typeof systemAutomation.findElementsByWindowWithHost !== 'function') {
      return null;
    }

    const hostContext = await resolveTradingViewQuickSearchHostContext(preferredWindowHandle, {
      runtimeOptions,
      searchBounds: options.searchBounds || null,
      includeWindowBoundsFallback: options.includeWindowBoundsFallback
    });
    if (!hostContext.valid || !hostContext.boundsCandidates.length) {
      return null;
    }

    const normalizedCandidates = Array.isArray(candidates)
      ? candidates.filter((candidate) => String(candidate?.text || '').trim())
      : [];
    if (!normalizedCandidates.length) {
      return null;
    }

    const views = Array.isArray(options.views) && options.views.length > 0
      ? options.views
      : ['control', 'content', 'raw'];
    const maxResults = Number.isFinite(Number(options.maxResults)) && Number(options.maxResults) > 0
      ? Math.min(40, Math.round(Number(options.maxResults)))
      : 4;
    const maxDepth = Number.isFinite(Number(options.maxDepth)) && Number(options.maxDepth) >= 0
      ? Math.min(20, Math.round(Number(options.maxDepth)))
      : 12;
    const maxVisited = Number.isFinite(Number(options.maxVisited)) && Number(options.maxVisited) > 0
      ? Math.min(1800, Math.round(Number(options.maxVisited)))
      : 900;
    const discoveryBudgetMs = getQuickSearchOperationTimeRemainingMs(
      runtimeOptions,
      Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
        ? Math.round(Number(options.timeoutMs))
        : Math.min(1500, getTradingViewQuickSearchDiscoveryTimeoutMs())
    );

    if (discoveryBudgetMs < MIN_TRADINGVIEW_QUICK_SEARCH_DISCOVERY_TIMEOUT_MS) {
      throwIfQuickSearchOperationTimedOut(runtimeOptions);
      return null;
    }

    const scanAttempts = [];
    let rejectedProbe = null;
    const discoveryStartedAt = Date.now();
    const totalAttemptCount = Math.max(1, normalizedCandidates.length * hostContext.boundsCandidates.length * views.length);
    const perAttemptTimeoutFloorMs = Math.max(
      MIN_TRADINGVIEW_QUICK_SEARCH_DISCOVERY_TIMEOUT_MS,
      Math.floor(discoveryBudgetMs / totalAttemptCount)
    );

    for (const candidate of normalizedCandidates) {
      for (const boundsCandidate of hostContext.boundsCandidates) {
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
            scanResult = await systemAutomation.findElementsByWindowWithHost(candidate.text, {
              windowHandle: hostContext.trustedWindowHandle,
              controlType: candidate.controlType || '',
              exact: candidate.exact === true,
              textMode: candidate.textMode || '',
              bounds: boundsCandidate.hostBounds,
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
              text: candidate.text,
              controlType: candidate.controlType || null,
              exact: candidate.exact === true,
              view,
              boundsId: boundsCandidate.id,
              bounds: boundsCandidate.bounds,
              success: false,
              count: 0,
              stats: null,
              error: error?.message || String(error || 'TradingView quick-search host text probe failed')
            });
            continue;
          }

          const elements = Array.isArray(scanResult?.elements) ? scanResult.elements : [];
          scanAttempts.push({
            text: candidate.text,
            controlType: candidate.controlType || null,
            exact: candidate.exact === true,
            view,
            boundsId: boundsCandidate.id,
            bounds: boundsCandidate.bounds,
            success: scanResult?.success === true,
            count: elements.length,
            stats: scanResult?.stats || null,
            error: scanResult?.success === false ? (scanResult?.error || 'TradingView quick-search host text probe failed') : null
          });

          if (!elements.length) {
            continue;
          }

          const selection = selectBestTradingViewQuickSearchCandidate(elements, hostContext.trustedWindow || {});
          const bestElement = selection?.bestCandidate?.element || elements[0];
          const rawControlType = String(
            bestElement?.ControlType
            || bestElement?.controlType
            || candidate.controlType
            || ''
          ).trim();
          const normalizedControlType = rawControlType.replace(/^ControlType\./i, '') || 'Text';
          const bestElementWindowHandle = Number(bestElement?.WindowHandle || bestElement?.windowHandle || 0) || 0;
          if (
            options.preferPlaceholderText === true
            && /edit/.test(String(candidate?.controlType || normalizedControlType).trim().toLowerCase())
            && bestElementWindowHandle > 0
            && Number(hostContext?.trustedWindowHandle || 0) > 0
            && bestElementWindowHandle !== Number(hostContext.trustedWindowHandle || 0)
          ) {
            continue;
          }

          const matchedProbe = {
            matched: true,
            text: candidate.text,
            exact: candidate.exact === true,
            controlType: normalizedControlType,
            matchedBy: String(options.matchedBy || 'uia-host-window-text-probe'),
            element: bestElement,
            foreground: hostContext.foreground,
            candidateScore: Number.isFinite(Number(selection?.bestCandidate?.score))
              ? Number(selection.bestCandidate.score)
              : null,
            hostTextProbe: {
              text: candidate.text,
              controlType: candidate.controlType || null,
              view,
              boundsId: boundsCandidate.id,
              searchBounds: boundsCandidate.bounds,
              hostBounds: boundsCandidate.hostBounds,
              scanAttempts
            }
          };
          const trust = await isTrustedTradingViewQuickSearchMatch(matchedProbe, {
            expectedWindowHandle: hostContext.trustedWindowHandle,
            expectedProcessName: hostContext.foreground?.processName || hostContext.trustedWindow?.processName || '',
            foreground: hostContext.foreground,
            runtimeOptions
          });
          if (trust?.trusted !== true) {
            rejectedProbe = {
              ...matchedProbe,
              trusted: false,
              trustReason: trust?.reason || 'window-family-mismatch',
              trustedWindow: trust?.trustedWindow || null
            };
            continue;
          }

          return {
            ...matchedProbe,
            trusted: true,
            trustReason: trust?.reason || String(options.trustReason || options.matchedBy || 'uia-host-window-text-probe'),
            trustedWindow: trust?.trustedWindow || hostContext.trustedWindow || null
          };
        }
      }
    }

    return rejectedProbe || {
      matched: false,
      text: null,
      exact: false,
      controlType: null,
      matchedBy: String(options.matchedBy || 'uia-host-window-text-probe'),
      element: null,
      foreground: hostContext.foreground,
      trusted: false,
      trustReason: 'no-host-text-match',
      trustedWindow: hostContext.trustedWindow || null,
      hostTextProbe: {
        text: null,
        controlType: null,
        view: null,
        boundsId: null,
        searchBounds: hostContext.searchBounds || null,
        hostBounds: hostContext.hostBounds || null,
        scanAttempts
      }
    };
  }

  async function findTrustedTradingViewQuickSearchSurfaceCandidate(preferredWindowHandle = 0, runtimeOptions = null) {
    throwIfQuickSearchOperationTimedOut(runtimeOptions);
    const focusedHostProbe = await findTradingViewQuickSearchFocusedHostSurface(
      preferredWindowHandle,
      runtimeOptions,
      {
        matchedBy: 'uia-host-focused-quick-search-surface-candidate',
        trustReason: 'uia-host-focused-quick-search-surface-candidate'
      }
    );
    if (focusedHostProbe?.trusted === true && (focusedHostProbe?.element?.Bounds || focusedHostProbe?.element?.bounds)) {
      return focusedHostProbe;
    }

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
    const hostContext = await resolveTradingViewQuickSearchHostContext(preferredWindowHandle, {
      runtimeOptions,
      includeWindowBoundsFallback: false
    });
    if (!hostContext.valid) {
      return null;
    }

    const {
      foreground,
      trustedWindowHandle,
      trustedWindow,
      searchBounds
    } = hostContext;
    const usableSearchBounds = searchBounds || buildTradingViewQuickSearchEditBounds(trustedWindow);
    if (!usableSearchBounds) {
      return null;
    }

    const hostScan = await collectTradingViewQuickSearchHostScanElements(trustedWindowHandle, runtimeOptions, {
      searchBounds: usableSearchBounds,
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
      const matchedProbe = {
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
        searchBounds: usableSearchBounds,
        candidateScore: hostSelection.bestCandidate.score,
        hostScanAttempts: hostScan?.scanAttempts || []
      };
      const trust = await isTrustedTradingViewQuickSearchMatch(matchedProbe, {
        expectedWindowHandle: trustedWindowHandle,
        expectedProcessName: foreground?.processName || trustedWindow?.processName || '',
        foreground: hostScan?.foreground || foreground,
        runtimeOptions
      });
      if (trust?.trusted === true) {
        return {
          ...matchedProbe,
          trusted: true,
          trustReason: trust.reason || 'trusted-window-host-scan-candidate',
          trustedWindow: trust.trustedWindow || hostScan?.trustedWindow || trustedWindow
        };
      }
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
          bounds: usableSearchBounds,
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
    const matchedProbe = {
      matched: true,
      text: String(bestCandidate.element?.Name || bestCandidate.element?.name || '').trim(),
      exact: false,
      controlType: normalizedControlType,
      matchedBy: 'trusted-window-bounds-search-candidate',
      element: bestCandidate.element,
      foreground,
      searchBounds: usableSearchBounds,
      candidateScore: bestCandidate.score
    };
    const trust = await isTrustedTradingViewQuickSearchMatch(matchedProbe, {
      expectedWindowHandle: trustedWindowHandle,
      expectedProcessName: foreground?.processName || trustedWindow?.processName || '',
      foreground,
      runtimeOptions
    });
    if (trust?.trusted !== true) {
      return null;
    }
    return {
      ...matchedProbe,
      trusted: true,
      trustReason: trust.reason || 'trusted-window-bounds-search-candidate',
      trustedWindow: trust.trustedWindow || trustedWindow
    };
  }

  async function probeTradingViewPineEditorSurface(runtimeOptions = null) {
    const watcherState = getFreshWatcherForeground(
      Number(runtimeOptions?.expectedWindowHandle || runtimeOptions?.windowHandle || 0) || 0,
      WATCHER_FOREGROUND_FRESH_MS
    );
    const watcherSurface = getWatcherTextEvidenceMatch(
      watcherState.watcher,
      PINE_EDITOR_WATCHER_SURFACE_ANCHORS,
      watcherState.foreground
    );

    if (
      watcherState.fresh
      && watcherState.matchesExpectedWindow !== false
      && normalizeQuickSearchWindowProcessName(watcherState?.foreground?.processName || '') === 'tradingview'
      && watcherSurface.matched
    ) {
      const watcherResult = {
        matched: true,
        text: watcherSurface.anchor || 'Pine Editor',
        exact: false,
        element: watcherSurface.element || null,
        foreground: watcherState.foreground,
        matchedBy: 'watcher-pine-surface-anchor',
        visibleAnchors: watcherSurface.anchor ? [watcherSurface.anchor] : [],
        trustReason: 'watcher-pine-surface-anchor'
      };
      if (watcherState.available === true) {
        cacheSurfaceProbeResult(
          runtimeOptions,
          'cachedPineSurfaceProbe',
          buildPineSurfaceProbeStateKey(
            Number(runtimeOptions?.expectedWindowHandle || runtimeOptions?.windowHandle || watcherState?.foreground?.hwnd || 0) || 0,
            watcherState,
            watcherState.foreground
          ),
          watcherResult
        );
      }
      return watcherResult;
    }

    const foregroundContext = await getPreferredForegroundInfo(
      Number(runtimeOptions?.expectedWindowHandle || runtimeOptions?.windowHandle || 0) || 0,
      runtimeOptions,
      {
        requireTradingView: false
      }
    );
    const foreground = foregroundContext?.foreground || watcherState?.foreground || null;
    const expectedWindowHandle = Number(
      runtimeOptions?.expectedWindowHandle
      || runtimeOptions?.windowHandle
      || foreground?.hwnd
      || watcherState?.foreground?.hwnd
      || 0
    ) || 0;
    const probeStateKey = watcherState.available === true
      ? buildPineSurfaceProbeStateKey(
          expectedWindowHandle,
          watcherState,
          foreground
        )
      : '';
    const cachedProbe = getCachedSurfaceProbeResult(
      runtimeOptions,
      'cachedPineSurfaceProbe',
      probeStateKey
    );
    if (cachedProbe !== undefined) {
      return cachedProbe;
    }

    if (typeof systemAutomation.probeTradingViewPineEditorSurface === 'function') {
      try {
        throwIfQuickSearchOperationTimedOut(runtimeOptions);
        const trustedWindow = expectedWindowHandle > 0
          ? await getQuickSearchTrustedWindowInfo(expectedWindowHandle, foreground)
          : null;
        const hostProbe = await systemAutomation.probeTradingViewPineEditorSurface({
          windowHandle: Number(trustedWindow?.hwnd || expectedWindowHandle || foreground?.hwnd || 0) || 0,
          timeout: getQuickSearchOperationTimeRemainingMs(runtimeOptions, 1500) || 1500,
          foreground,
          windowInfo: trustedWindow || foreground || null,
          resolveWindowState: false
        });
        if (hostProbe?.active) {
          return cacheSurfaceProbeResult(runtimeOptions, 'cachedPineSurfaceProbe', probeStateKey, {
            matched: true,
            text: hostProbe.anchorText || (Array.isArray(hostProbe.visibleAnchors) ? hostProbe.visibleAnchors[0] : 'Pine Editor'),
            exact: false,
            element: hostProbe.element || null,
            foreground: hostProbe.foreground || hostProbe.windowInfo || null,
            matchedBy: hostProbe.matchedBy || 'uia-host-pine-surface-scan',
            visibleAnchors: Array.isArray(hostProbe.visibleAnchors) ? hostProbe.visibleAnchors.slice(0, 8) : []
          });
        }
        cacheSurfaceProbeResult(runtimeOptions, 'cachedPineSurfaceProbe', probeStateKey, null);
        if (!shouldAllowLegacyPineSurfaceTextProbe(runtimeOptions)) {
          return null;
        }
      } catch {
        cacheSurfaceProbeResult(runtimeOptions, 'cachedPineSurfaceProbe', probeStateKey, null);
        if (!shouldAllowLegacyPineSurfaceTextProbe(runtimeOptions)) {
          return null;
        }
      }
    }

    for (const candidate of PINE_EDITOR_SURFACE_PROBE_CANDIDATES) {
      const matched = await findForegroundElementByText(candidate.text, {
        exact: candidate.exact,
        runtimeOptions
      });
      if (matched) {
        return cacheSurfaceProbeResult(runtimeOptions, 'cachedPineSurfaceProbe', probeStateKey, {
          matched: true,
          text: candidate.text,
          exact: candidate.exact,
          element: matched.element,
          foreground: matched.foreground
        });
      }
    }

    return cacheSurfaceProbeResult(runtimeOptions, 'cachedPineSurfaceProbe', probeStateKey, null);
  }

  async function probeTradingViewQuickSearchSurface(preferredWindowHandle = 0, runtimeOptions = null) {
    throwIfQuickSearchOperationTimedOut(runtimeOptions);
    const foreground = (await getPreferredForegroundInfo(preferredWindowHandle, runtimeOptions, {
      requireTradingView: false
    }))?.foreground;
    const expectedWindowHandle = Number(preferredWindowHandle || 0) || Number(foreground?.hwnd || 0) || 0;

    const focusedHostProbe = await findTradingViewQuickSearchFocusedHostSurface(
      expectedWindowHandle,
      runtimeOptions,
      {
        matchedBy: 'uia-host-quick-search-focused-element-probe',
        trustReason: 'uia-host-quick-search-focused-element-probe'
      }
    );
    if (focusedHostProbe?.trusted === true) {
      return focusedHostProbe;
    }

    const hostTextProbe = await findTradingViewQuickSearchHostTextSurface(
      expectedWindowHandle,
      TRADINGVIEW_QUICK_SEARCH_SURFACE_PROBE_CANDIDATES,
      runtimeOptions,
      {
        matchedBy: 'uia-host-quick-search-text-probe',
        trustReason: 'uia-host-quick-search-text-probe'
      }
    );
    if (hostTextProbe?.trusted === true) {
      return hostTextProbe;
    }

    const unnamedEditMatch = await findTrustedTradingViewQuickSearchEdit(expectedWindowHandle, runtimeOptions);
    if (unnamedEditMatch) {
      return unnamedEditMatch;
    }

    if (!shouldAllowLegacyQuickSearchTextProbe(runtimeOptions)) {
      return hostTextProbe || focusedHostProbe || null;
    }

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
          foreground,
          runtimeOptions
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

    return hostTextProbe || focusedHostProbe || null;
  }

  async function probeTradingViewQuickSearchHostSurfaceOnly(preferredWindowHandle = 0, runtimeOptions = null) {
    throwIfQuickSearchOperationTimedOut(runtimeOptions);
    const foreground = (await getPreferredForegroundInfo(preferredWindowHandle, runtimeOptions, {
      requireTradingView: false
    }))?.foreground;
    const expectedWindowHandle = Number(preferredWindowHandle || 0) || Number(foreground?.hwnd || 0) || 0;

    const focusedHostProbe = await findTradingViewQuickSearchFocusedHostSurface(
      expectedWindowHandle,
      runtimeOptions,
      {
        matchedBy: 'uia-host-quick-search-focused-element-probe',
        trustReason: 'uia-host-quick-search-focused-element-probe'
      }
    );
    if (focusedHostProbe?.trusted === true) {
      return focusedHostProbe;
    }

    const hostTextProbe = await findTradingViewQuickSearchHostTextSurface(
      expectedWindowHandle,
      TRADINGVIEW_QUICK_SEARCH_SURFACE_PROBE_CANDIDATES,
      runtimeOptions,
      {
        matchedBy: 'uia-host-quick-search-text-probe',
        trustReason: 'uia-host-quick-search-text-probe'
      }
    );
    if (hostTextProbe?.trusted === true) {
      return hostTextProbe;
    }

    return hostTextProbe || focusedHostProbe || null;
  }

  async function probeTradingViewCommandQuickSearchSurface(preferredWindowHandle = 0, runtimeOptions = null) {
    throwIfQuickSearchOperationTimedOut(runtimeOptions);
    const foreground = (await getPreferredForegroundInfo(preferredWindowHandle, runtimeOptions, {
      requireTradingView: false
    }))?.foreground;
    const expectedWindowHandle = Number(preferredWindowHandle || 0) || Number(foreground?.hwnd || 0) || 0;

    const focusedHostProbe = await findTradingViewQuickSearchFocusedHostSurface(
      expectedWindowHandle,
      runtimeOptions,
      {
        requireCommandSurface: true,
        matchedBy: 'uia-host-command-focused-element-probe',
        trustReason: 'uia-host-command-focused-element-probe'
      }
    );
    if (focusedHostProbe?.trusted === true) {
      return {
        ...focusedHostProbe,
        commandSurfaceProbe: {
          markerElement: focusedHostProbe.element,
          inputElement: focusedHostProbe.element,
          scanAttempts: [],
          hostBounds: focusedHostProbe?.hostFocusedProbe?.searchBounds || null,
          boundsId: 'focused-element'
        }
      };
    }

    const hostTextProbe = await findTradingViewQuickSearchHostTextSurface(
      expectedWindowHandle,
      TRADINGVIEW_COMMAND_QUICK_SEARCH_SURFACE_PROBE_CANDIDATES,
      runtimeOptions,
      {
        matchedBy: 'uia-host-command-quick-search-text-probe',
        trustReason: 'uia-host-command-quick-search-text-probe'
      }
    );
    if (hostTextProbe?.trusted === true) {
      return augmentTradingViewQuickSearchSurfaceProbeWithFocusedElement({
        ...hostTextProbe,
        commandSurfaceProbe: {
          markerElement: hostTextProbe.element,
          inputElement: null,
          scanAttempts: hostTextProbe?.hostTextProbe?.scanAttempts || [],
          hostBounds: hostTextProbe?.hostTextProbe?.hostBounds || null,
          boundsId: hostTextProbe?.hostTextProbe?.boundsId || null
        }
      }, focusedHostProbe);
    }
    const commandHostTextProbe = augmentTradingViewQuickSearchSurfaceProbeWithFocusedElement(hostTextProbe, focusedHostProbe);

    const hostProbe = augmentTradingViewQuickSearchSurfaceProbeWithFocusedElement(selectTradingViewCommandQuickSearchHostSurface(
      await collectTradingViewQuickSearchHostScanElements(expectedWindowHandle, runtimeOptions, {
        maxResults: 120,
        maxDepth: 14,
        maxVisited: 1200
      })
    ), focusedHostProbe);

    if (hostProbe?.trusted === true) {
      return hostProbe;
    }

    if (!shouldAllowLegacyQuickSearchTextProbe(runtimeOptions)) {
      return hostProbe || commandHostTextProbe || focusedHostProbe || null;
    }

    const expectedProcessName = foreground?.processName || '';

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
        foreground,
        runtimeOptions
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

    return hostProbe || commandHostTextProbe || focusedHostProbe || null;
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

    const foreground = (await getPreferredForegroundInfo(preferredWindowHandle, runtimeOptions, {
      requireTradingView: false
    }))?.foreground;

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

    const foreground = (await getPreferredForegroundInfo(preferredWindowHandle, runtimeOptions, {
      requireTradingView: false
    }))?.foreground;
    const expectedWindowHandle = Number(preferredWindowHandle || 0) || Number(foreground?.hwnd || 0) || 0;

    const focusedHostProbe = await findTradingViewQuickSearchFocusedHostSurface(
      expectedWindowHandle,
      runtimeOptions,
      {
        matchedBy: 'uia-host-focused-quick-search-input',
        trustReason: 'uia-host-focused-quick-search-input'
      }
    );
    if (focusedHostProbe?.trusted === true && (focusedHostProbe?.element?.Bounds || focusedHostProbe?.element?.bounds)) {
      return {
        focused: true,
        text: focusedHostProbe.text || '',
        exact: focusedHostProbe.exact,
        controlType: focusedHostProbe.controlType,
        matchedBy: focusedHostProbe.matchedBy || 'uia-host-focused-quick-search-input',
        element: focusedHostProbe.element,
        foreground: focusedHostProbe.foreground || foreground,
        trusted: true,
        trustReason: focusedHostProbe.trustReason || null,
        trustedWindow: focusedHostProbe.trustedWindow || null,
        candidateScore: focusedHostProbe.candidateScore || null,
        searchBounds: focusedHostProbe?.hostFocusedProbe?.searchBounds || null,
        surfaceProbe: focusedHostProbe
      };
    }

    const inputHostProbe = await findTradingViewQuickSearchHostTextSurface(
      expectedWindowHandle,
      TRADINGVIEW_QUICK_SEARCH_INPUT_FOCUS_CANDIDATES,
      runtimeOptions,
      {
        matchedBy: 'uia-host-quick-search-input-probe',
        trustReason: 'uia-host-quick-search-input-probe',
        preferPlaceholderText: true
      }
    );
    const trustedSurface = inputHostProbe?.trusted === true
      ? inputHostProbe
      : await probeTradingViewQuickSearchSurface(expectedWindowHandle, runtimeOptions);
    if (!trustedSurface?.trusted || !trustedSurface?.element?.Bounds) {
      return null;
    }

    const clickResult = await clickTradingViewQuickSearchMatch(trustedSurface, runtimeOptions);
    if (!clickResult.success) {
      return null;
    }

    return {
      focused: true,
      text: trustedSurface.text || '',
      exact: trustedSurface.exact,
      controlType: trustedSurface.controlType,
      matchedBy: trustedSurface.matchedBy || 'trusted-surface-probe',
      element: trustedSurface.element,
      foreground: trustedSurface.foreground || foreground,
      trusted: true,
      trustReason: trustedSurface.trustReason || null,
      trustedWindow: trustedSurface.trustedWindow || null,
      clickResult,
      candidateScore: trustedSurface.candidateScore || null,
      searchBounds: trustedSurface.searchBounds || trustedSurface?.hostTextProbe?.searchBounds || null,
      surfaceProbe: trustedSurface
    };
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
        const commandSurfaceFailureReason = formatTradingViewQuickSearchProbeFailureReason(commandQuickSearchSurface);
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
          error: commandSurfaceFailureReason
            ? `TradingView command quick-search surface was not verified before typing; refusing to type into symbol search because ${commandSurfaceFailureReason}`
            : 'TradingView command quick-search surface was not verified before typing; refusing to type into symbol search',
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

    if (runtimeOptions?.preferWindowGuessFirst !== true) {
      const earlySurfaceProbe = await probeTradingViewQuickSearchHostSurfaceOnly(
        preferredWindowHandle,
        runtimeOptions
      );
      if (
        earlySurfaceProbe?.trusted === true
        && !hasAuthoritativeTradingViewQuickSearchSurfaceProof(earlySurfaceProbe, preferredWindowHandle)
      ) {
        const earlyClipboardContinuation = await maybePrepareTradingViewPineQuickSearchClipboardContinuation(
          action,
          preferredWindowHandle,
          runtimeOptions
        );
        if (earlyClipboardContinuation?.ready) {
          return earlyClipboardContinuation;
        }
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

    const clipboardContinuation = await maybePrepareTradingViewPineQuickSearchClipboardContinuation(
      action,
      preferredWindowHandle,
      runtimeOptions,
      {
        initialRead,
        clearAttempt: valueClearAttempt,
        keyboardFallback,
        inputFocus,
        focusRecovery,
        finalRead: afterKeyboardClearRead.success ? afterKeyboardClearRead : afterValueClearRead
      }
    );
    if (clipboardContinuation?.ready) {
      return clipboardContinuation;
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
        : normalizeTradingViewQuickSearchClipboardProofError(
            clipboardRead.error,
            'TradingView quick-search typing could not be verified before continuing'
          )
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

    const clipboardContinuation = await maybePrepareTradingViewPineQuickSearchClipboardContinuation(
      action,
      preferredWindowHandle,
      runtimeOptions,
      {
        initialRead,
        clearAttempt: valueClearAttempt,
        keyboardFallback,
        inputFocus,
        focusRecovery,
        finalRead: afterKeyboardClearRead
      }
    );
    if (clipboardContinuation?.ready) {
      return clipboardContinuation;
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
    const runtimeOptions = options?.runtimeOptions && typeof options.runtimeOptions === 'object'
      ? options.runtimeOptions
      : {};

    if (verifyTarget !== 'quick-search' || key !== 'ctrl+k') {
      return null;
    }

    if (shortcutId !== 'symbol-search' && searchRoute !== 'quick-search') {
      return null;
    }

    if (!runtimeOptions.expectedWindowHandle && Number(options.expectedWindowHandle || 0) > 0) {
      runtimeOptions.expectedWindowHandle = Number(options.expectedWindowHandle || 0) || 0;
    }
    if (observationCheckpoint?.foreground?.success) {
      cacheTrustedTradingViewForeground(runtimeOptions, observationCheckpoint.foreground);
    }

    const probeMatched = await probeTradingViewQuickSearchSurface(options.expectedWindowHandle || 0, runtimeOptions);
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
    const focusedInput = await focusTradingViewQuickSearchInput(preferredWindowHandle, runtimeOptions);
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
      : (await getPreferredForegroundInfo(preferredWindowHandle, runtimeOptions, {
          requireTradingView: false
        }))?.foreground;

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
    const runtimeOptions = options?.runtimeOptions && typeof options.runtimeOptions === 'object'
      ? options.runtimeOptions
      : {};
    const quickSearchActivation = routeId === 'open-pine-editor' && key === 'enter';
    const directShortcutActivation = shortcutId === 'open-pine-editor' && key === 'ctrl+e';
    const newIndicatorActivation = shortcutId === 'new-pine-indicator' && key === 'ctrl+i';
    const semanticIconActivation = actionType === 'click_element'
      && routeId === 'open-pine-editor'
      && route === 'semantic-icon';
    if (
      verifyTarget !== 'pine-editor'
      || (!quickSearchActivation && !directShortcutActivation && !newIndicatorActivation && !semanticIconActivation)
    ) {
      return null;
    }

    if (!runtimeOptions.expectedWindowHandle && Number(options.expectedWindowHandle || 0) > 0) {
      runtimeOptions.expectedWindowHandle = Number(options.expectedWindowHandle || 0) || 0;
    }
    if (observationCheckpoint?.foreground?.success) {
      cacheTrustedTradingViewForeground(runtimeOptions, observationCheckpoint.foreground);
    } else if (checkpointBeforeForeground?.success) {
      cacheTrustedTradingViewForeground(runtimeOptions, checkpointBeforeForeground);
    }

    const preferredWindowHandle = Number(options.expectedWindowHandle || 0)
      || Number(observationCheckpoint?.foreground?.hwnd || 0)
      || Number(checkpointBeforeForeground?.hwnd || 0)
      || 0;
    const resolveRecoveryForeground = async () => (await getPreferredForegroundInfo(
      options.expectedWindowHandle || preferredWindowHandle || 0,
      runtimeOptions,
      {
        requireTradingView: false
      }
    ))?.foreground;

    const buildNewIndicatorCommandSurfaceConflict = async (pineSurfaceProbe = null) => {
      if (!newIndicatorActivation) {
        return null;
      }

      const commandQuickSearchSurface = await probeTradingViewCommandQuickSearchSurface(
        preferredWindowHandle,
        runtimeOptions
      ).catch(() => null);
      if (commandQuickSearchSurface?.matched !== true) {
        return null;
      }

      const commandSurfaceFailureReason = formatTradingViewQuickSearchProbeFailureReason(commandQuickSearchSurface);
      const error = commandSurfaceFailureReason
        ? `TradingView Ctrl+I left the command quick-search surface open; refusing to trust underlying Pine DOM because ${commandSurfaceFailureReason}`
        : 'TradingView Ctrl+I left the command quick-search surface open; refusing to trust underlying Pine DOM.';
      const foreground = await resolveRecoveryForeground();

      return {
        attempted: true,
        recovered: false,
        recoveredBy: 'command-surface-open',
        error,
        pineEditorSurfaceProbe: pineSurfaceProbe || null,
        pineEditorCommandSurfaceProbe: commandQuickSearchSurface,
        checkpoint: {
          ...observationCheckpoint,
          verified: false,
          error,
          editorActiveMatched: false,
          foreground,
          matchReason: 'command-surface-open',
          recoveredBy: 'command-surface-open',
          pineEditorSurfaceProbe: pineSurfaceProbe || null,
          pineEditorCommandSurfaceProbe: commandQuickSearchSurface
        }
      };
    };

    const summarizePineSurfaceExpectationEvidence = (probe = null) => {
      const rawEntries = Array.isArray(probe?.visibleAnchorEntries) && probe.visibleAnchorEntries.length > 0
        ? probe.visibleAnchorEntries
        : (Array.isArray(probe?.rendererProof?.signals) && probe.rendererProof.signals.length > 0
          ? probe.rendererProof.signals
          : (Array.isArray(probe?.visibleAnchors) ? probe.visibleAnchors.map((text) => ({
              text,
              observedText: text,
              category: null
            })) : []));
      const summary = {
        starterVisible: false,
        saveRequiredVisible: false,
        renameSurfaceVisible: false,
        saveConfirmedVisible: false
      };

      for (const entry of rawEntries) {
        const text = String(entry?.observedText || entry?.text || entry?.ariaLabel || '').trim().toLowerCase();
        const category = String(entry?.category || '').trim().toLowerCase();

        if (
          category === 'starter'
          || /\b(untitled script|my script|my strategy|my library)\b/.test(text)
        ) {
          summary.starterVisible = true;
        }

        if (category === 'rename-surface' || category === 'rename surface') {
          summary.renameSurfaceVisible = true;
          summary.saveRequiredVisible = true;
        }

        if (
          category === 'save-required'
          || category === 'save required'
          || /\b(save script|new script name|script name|save as|rename script|unsaved)\b/.test(text)
        ) {
          summary.saveRequiredVisible = true;
        }

        if (
          category === 'save-confirmed'
          || category === 'save confirmed'
          || /\b(all changes saved|saved successfully|save complete)\b/.test(text)
        ) {
          summary.saveConfirmedVisible = true;
        }
      }

      return {
        ...summary,
        freshScriptVisible: summary.starterVisible || summary.saveRequiredVisible || summary.renameSurfaceVisible
      };
    };

    const pineSurfaceProbeMatchesCheckpointExpectation = (probe = null, checkpoint = null) => {
      const expectation = String(
        checkpoint?.pineSurfaceExpectation
        || checkpointSpec?.pineSurfaceExpectation
        || ''
      ).trim().toLowerCase();
      if (!probe) {
        return false;
      }
      if (!expectation) {
        return true;
      }
      if (expectation === 'fresh-script') {
        return summarizePineSurfaceExpectationEvidence(probe).freshScriptVisible === true;
      }
      return true;
    };

    if (newIndicatorActivation) {
      const probeMatchedAfterNewIndicator = await probeTradingViewPineEditorSurface(runtimeOptions);
      const commandSurfaceConflict = await buildNewIndicatorCommandSurfaceConflict(probeMatchedAfterNewIndicator || null);
      if (commandSurfaceConflict) {
        return commandSurfaceConflict;
      }

      if (pineSurfaceProbeMatchesCheckpointExpectation(probeMatchedAfterNewIndicator, observationCheckpoint)) {
        const foreground = await resolveRecoveryForeground();
        return {
          attempted: true,
          recovered: true,
          recoveredBy: 'new-pine-indicator-proof',
          error: null,
          pineEditorSurfaceProbe: probeMatchedAfterNewIndicator,
          checkpoint: {
            ...observationCheckpoint,
            verified: true,
            error: null,
            editorActiveMatched: true,
            foreground,
            matchReason: 'new-pine-indicator-surface-probe',
            recoveredBy: 'new-pine-indicator-proof',
            pineEditorSurfaceProbe: probeMatchedAfterNewIndicator
          }
        };
      }

      const relaxedCheckpoint = await verifyKeyObservationCheckpoint({
        ...checkpointSpec,
        requiresObservedChange: false
      }, checkpointBeforeForeground, {
        expectedWindowHandle: options.expectedWindowHandle
      });
      const probeMatchedAfterCheckpoint = await probeTradingViewPineEditorSurface(runtimeOptions);
      const postCheckpointCommandSurfaceConflict = await buildNewIndicatorCommandSurfaceConflict(probeMatchedAfterCheckpoint || null);
      if (postCheckpointCommandSurfaceConflict) {
        return postCheckpointCommandSurfaceConflict;
      }
      if (
        (relaxedCheckpoint?.verified && (relaxedCheckpoint?.pineSurfaceExpectationMatched !== false))
        || pineSurfaceProbeMatchesCheckpointExpectation(probeMatchedAfterCheckpoint, relaxedCheckpoint || observationCheckpoint)
      ) {
        const foreground = relaxedCheckpoint?.foreground?.success
          ? relaxedCheckpoint.foreground
          : (await resolveRecoveryForeground());
        return {
          attempted: true,
          recovered: true,
          recoveredBy: 'new-pine-indicator-proof',
          error: null,
          pineEditorSurfaceProbe: probeMatchedAfterCheckpoint || null,
          checkpoint: {
            ...observationCheckpoint,
            ...(relaxedCheckpoint || {}),
            verified: true,
            error: null,
            editorActiveMatched: true,
            foreground,
            matchReason: relaxedCheckpoint?.matchReason || 'new-pine-indicator-proof',
            recoveredBy: 'new-pine-indicator-proof',
            pineEditorSurfaceProbe: probeMatchedAfterCheckpoint || null
          }
        };
      }

      const foreground = relaxedCheckpoint?.foreground?.success
        ? relaxedCheckpoint.foreground
        : (await resolveRecoveryForeground());
      return {
        attempted: true,
        recovered: false,
        recoveredBy: 'new-pine-indicator-proof',
        error: 'TradingView Ctrl+I did not expose a trustworthy Pine Editor surface for safe authoring.',
        pineEditorSurfaceProbe: probeMatchedAfterCheckpoint || null,
        checkpoint: {
          ...observationCheckpoint,
          ...(relaxedCheckpoint || {}),
          verified: false,
          error: 'TradingView Ctrl+I did not expose a trustworthy Pine Editor surface for safe authoring.',
          editorActiveMatched: false,
          foreground,
          matchReason: relaxedCheckpoint?.matchReason || 'new-pine-indicator-proof-failed',
          recoveredBy: 'new-pine-indicator-proof',
          pineEditorSurfaceProbe: probeMatchedAfterCheckpoint || null
        }
      };
    }

    const probeMatchedBeforeClick = await probeTradingViewPineEditorSurface(runtimeOptions);
    if (probeMatchedBeforeClick) {
      const foreground = await resolveRecoveryForeground();
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
        : (await getPreferredForegroundInfo(options.expectedWindowHandle || trustedWindowHandle || 0, runtimeOptions, {
            requireTradingView: false
          }))?.foreground;

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
      const quickSearchRuntimeOptions = options?.runtimeOptions && typeof options.runtimeOptions === 'object'
        ? options.runtimeOptions
        : createQuickSearchRuntimeOptions(
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
        if (!quickSearchRuntimeOptions.expectedWindowHandle && Number(options.expectedWindowHandle || 0) > 0) {
          quickSearchRuntimeOptions.expectedWindowHandle = Number(options.expectedWindowHandle || 0) || 0;
        }
      }
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
          const commandSurfaceFailureReason = formatTradingViewQuickSearchProbeFailureReason(commandQuickSearchSurface);
          try {
            await systemAutomation.pressKey('escape', {
              searchSurfaceContract: routeMetadata,
              tradingViewShortcut: routeMetadata
            });
          } catch {}
          return mergePineRecoveryMetadata(null, {
            ...baseMetadata,
            recoveredBy: 'quick-search-fallback',
            error: commandSurfaceFailureReason
              ? `TradingView Ctrl+K did not expose the command quick-search surface for Pine Editor recovery; refusing to type Pine Editor into symbol search because ${commandSurfaceFailureReason}`
              : 'TradingView Ctrl+K did not expose the command quick-search surface for Pine Editor recovery; refusing to type Pine Editor into symbol search',
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
            : (await getPreferredForegroundInfo(options.expectedWindowHandle || preferredWindowHandle || 0, quickSearchRuntimeOptions, {
                requireTradingView: false
              }))?.foreground;
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
      const activationProofDisposition = String(options?.activationProof?.disposition || '').trim().toLowerCase();
      if (activationProofDisposition === 'renderer-proof-unavailable') {
        const foreground = observationCheckpoint?.foreground?.success
          ? observationCheckpoint.foreground
          : (checkpointBeforeForeground?.success ? checkpointBeforeForeground : null);
        const rendererFailureReason = options?.activationProof?.likelyMeaning
          || 'Semantic Pine activation could not obtain Chromium renderer proof, so repeated Ctrl+E recovery was intentionally skipped.';
        return {
          attempted: true,
          recovered: false,
          recoveredBy: 'renderer-proof-unavailable',
          error: rendererFailureReason,
          checkpoint: {
            ...observationCheckpoint,
            verified: false,
            error: rendererFailureReason,
            foreground,
            matchReason: 'renderer-proof-unavailable',
            recoveredBy: 'renderer-proof-unavailable'
          }
        };
      }

      const directShortcutRecovery = await tryChartFocusDirectShortcutRecovery(false);
      if (directShortcutRecovery?.recovered) {
        return directShortcutRecovery;
      }

      if (shouldSkipQuickSearchFallbackAfterSemanticActivation(
        observationCheckpoint,
        directShortcutRecovery,
        options?.activationProof || null
      )) {
        return directShortcutRecovery || null;
      }

      const quickSearchFallbackRecovery = await tryQuickSearchFallbackRecovery(directShortcutRecovery);
      return quickSearchFallbackRecovery || directShortcutRecovery || null;
    }

    return tryChartFocusDirectShortcutRecovery(true);
  }

  return {
    ensureTradingViewQuickSearchInputClearBeforeTyping,
    executeTradingViewQuickSearchTypeAction,
    verifyTradingViewQuickSearchTypedValue,
    probeTradingViewQuickSearchSurface,
    probeTradingViewCommandQuickSearchSurface,
    probeTradingViewPineEditorSurface,
    maybeRecoverTradingViewQuickSearchOpen,
    maybeRecoverTradingViewPineEditorOpen
  };
}

module.exports = {
  createTradingViewRuntimeRecovery
};
