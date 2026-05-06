#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const aiService = require(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'));
const { getUIWatcher } = require(path.join(__dirname, '..', 'src', 'main', 'ui-watcher.js'));
const windowManager = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation', 'window', 'manager.js'));
const { buildVerifyTargetHintFromAppName } = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'app-profile.js'));
const {
  buildTradingViewPineWorkflowActions,
  inferTradingViewPineIntent
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'pine-workflows.js'));
const {
  buildTradingViewSymbolWorkflowActions,
  buildTradingViewTimeframeWorkflowActions
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'chart-verification.js'));

const DEFAULT_ARTIFACT_DIR = path.join(__dirname, '..', 'artifacts', 'live-validation');
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_PINE_CREATE_SAVE_NAME = 'Liku Live Save Probe';
const DEFAULT_PINE_CREATE_SAVE_PROMPT = `TradingView is already open. Create a new Pine script called "${DEFAULT_PINE_CREATE_SAVE_NAME}", save the script, and report the visible save status. Do not add it to the chart.`;

function getArgValue(flagName) {
  const index = process.argv.indexOf(flagName);
  if (index >= 0 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return null;
}

function getEnvValue(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value : null;
}

function hasFlag(flagName) {
  if (process.argv.includes(flagName)) return true;
  const envName = `npm_config_${String(flagName || '').replace(/^--/, '').replace(/-/g, '_')}`;
  return /^(1|true|yes)$/i.test(String(process.env[envName] || ''));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function buildTimestampTag() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function sanitizeFileSegment(value, fallback = 'scenario') {
  const sanitized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || fallback;
}

function summarizeAction(action = {}) {
  const type = String(action?.type || 'unknown').trim();
  const detail = [
    action?.key ? `key=${action.key}` : null,
    action?.text ? `text=${String(action.text).slice(0, 24)}` : null,
    action?.title ? `title=${action.title}` : null,
    action?.verify?.kind ? `verify=${action.verify.kind}` : null,
    action?.pineEvidenceMode ? `pine=${action.pineEvidenceMode}` : null
  ].filter(Boolean).join(', ');
  return detail ? `${type} (${detail})` : type;
}

function summarizeResult(result = {}) {
  return {
    success: result?.success === true,
    action: result?.action || null,
    message: result?.message || null,
    skipped: result?.skipped === true,
    skippedReason: result?.skippedReason || null,
    error: result?.error || null,
    proof: result?.proof
      ? {
          level: result.proof.level ?? null,
          levelName: result.proof.levelName || null,
          status: result.proof.status || null
        }
      : null,
    text: typeof result?.text === 'string' ? result.text.slice(0, 4000) : null,
    pineStructuredSummary: result?.pineStructuredSummary || null,
    focusTarget: result?.focusTarget || null,
    observationCheckpoint: result?.observationCheckpoint || null,
    quickSearchPreflight: result?.quickSearchPreflight
      ? {
          applicable: result.quickSearchPreflight.applicable === true,
          ready: result.quickSearchPreflight.ready === true,
          emptyConfirmed: result.quickSearchPreflight.emptyConfirmed === true,
          queryAlreadyPresent: result.quickSearchPreflight.queryAlreadyPresent === true,
          fallbackAssumedFocused: result.quickSearchPreflight.fallbackAssumedFocused === true,
          fallbackReason: result.quickSearchPreflight.fallbackReason || null,
          clearedBy: result.quickSearchPreflight.clearedBy || null,
          expectedText: result.quickSearchPreflight.expectedText || null,
          initialRead: result.quickSearchPreflight.initialRead || null,
          finalRead: result.quickSearchPreflight.finalRead || null,
          error: result.quickSearchPreflight.error || null
        }
      : null,
    quickSearchTypedVerification: result?.quickSearchTypedVerification
      ? {
          applicable: result.quickSearchTypedVerification.applicable === true,
          verified: result.quickSearchTypedVerification.verified === true,
          expectedText: result.quickSearchTypedVerification.expectedText || null,
          actualText: result.quickSearchTypedVerification.actualText || null,
          satisfiedBy: result.quickSearchTypedVerification.satisfiedBy || null,
          error: result.quickSearchTypedVerification.error || null,
          readback: result.quickSearchTypedVerification.readback || null
        }
      : null
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function isBrowserHostedWindowProcess(processName = '') {
  return /^(msedge|chrome|brave|firefox|opera|vivaldi|arc|iexplore|safari)$/i.test(String(processName || '').trim());
}

function titleLooksLikeTradingViewReferencePage(title = '') {
  return /\b(keyboard shortcuts?|shortcut(?: keys?)?|hotkey list|help center|support|docs?|documentation|learn|tutorial|blog|wiki|pricing|about|careers?|jobs?|download)\b/i.test(String(title || ''));
}

function titleLooksLikeTradingViewActiveSurface(title = '') {
  return /\b(supercharts?|chart(?:s|ing)?|watchlist|paper trading|depth of market|pine editor|object tree|trading panel|strategy tester|stock screener|heatmap|alerts?|screener|ideas)\b/i.test(String(title || ''));
}

function classifyTradingViewWindow(windowInfo = {}, foregroundHwnd = 0) {
  const title = normalizeText(windowInfo?.title);
  const processName = normalizeText(windowInfo?.processName);
  const windowKind = normalizeText(windowInfo?.windowKind);
  const isForeground = Number(windowInfo?.hwnd || 0) === Number(foregroundHwnd || 0);
  const isDedicatedTradingViewProcess = processName === 'tradingview';
  const isBrowserHosted = isBrowserHostedWindowProcess(processName);
  const looksLikeReferencePage = isBrowserHosted
    && titleLooksLikeTradingViewReferencePage(title)
    && !titleLooksLikeTradingViewActiveSurface(title);
  const looksLikeActiveSurface = isDedicatedTradingViewProcess
    || titleLooksLikeTradingViewActiveSurface(title);

  let score = 0;
  if (isDedicatedTradingViewProcess) score += 180;
  if (looksLikeActiveSurface) score += isDedicatedTradingViewProcess ? 40 : 70;
  if (/tradingview|trading\s+view/.test(title)) score += 18;
  if (/tradingview/.test(processName)) score += 12;
  if (!windowInfo?.isMinimized) score += 20;
  if (windowKind === 'main') score += 15;
  if (windowKind === 'owned' || windowKind === 'palette') score += 6;
  if (isForeground) score += isDedicatedTradingViewProcess ? 30 : (looksLikeActiveSurface ? 12 : 4);
  if (looksLikeReferencePage) score -= 220;

  return {
    score,
    isForeground,
    isDedicatedTradingViewProcess,
    isBrowserHosted,
    looksLikeReferencePage,
    looksLikeActiveSurface
  };
}

function windowLooksLikeTradingView(windowInfo = {}) {
  const title = normalizeText(windowInfo?.title);
  const processName = normalizeText(windowInfo?.processName);
  const className = normalizeText(windowInfo?.className);
  const haystack = [
    windowInfo?.title,
    windowInfo?.processName,
    windowInfo?.className
  ].map((value) => normalizeText(value)).filter(Boolean).join(' ');

  if (processName === 'tradingview') return true;
  if (processName && /winword|acrord32|acrobat|excel|powerpnt|code|code - insiders/.test(processName)) {
    return false;
  }
  if (/\.pdf\b|\bword\b|\blast saved by\b/.test(title) && processName !== 'tradingview') {
    return false;
  }
  if (isBrowserHostedWindowProcess(processName)
    && titleLooksLikeTradingViewReferencePage(title)
    && !titleLooksLikeTradingViewActiveSurface(title)) {
    return false;
  }
  return /tradingview|trading\s+view|pine editor|paper trading|depth of market|object tree|trading panel/.test(haystack);
}

function dedupeWindows(windows = []) {
  const seen = new Set();
  const unique = [];
  for (const win of windows) {
    const hwnd = Number(win?.hwnd || 0) || 0;
    if (!hwnd || seen.has(hwnd)) continue;
    seen.add(hwnd);
    unique.push(win);
  }
  return unique;
}

function pickPreferredTradingViewWindow(windows = [], foreground = null) {
  const foregroundHwnd = Number(foreground?.hwnd || 0) || 0;

  const scored = windows
    .map((win) => {
      const title = normalizeText(win?.title);
      const classification = classifyTradingViewWindow(win, foregroundHwnd);
      let score = classification.score;
      if (/pine editor|paper trading|depth of market|trading panel|object tree/.test(title)) score += 6;
      return {
        win,
        score,
        classification
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.classification.isDedicatedTradingViewProcess !== b.classification.isDedicatedTradingViewProcess) {
        return a.classification.isDedicatedTradingViewProcess ? -1 : 1;
      }
      if (a.classification.looksLikeReferencePage !== b.classification.looksLikeReferencePage) {
        return a.classification.looksLikeReferencePage ? 1 : -1;
      }
      if (a.classification.isForeground !== b.classification.isForeground) {
        return a.classification.isForeground ? -1 : 1;
      }
      return 0;
    });

  return scored[0]?.win || null;
}

async function findTradingViewContext() {
  const verifyTarget = buildVerifyTargetHintFromAppName('TradingView');
  const foreground = await aiService.systemAutomation.getForegroundWindowInfo();
  const knownProcessNames = Array.from(new Set([
    ...(Array.isArray(verifyTarget?.processNames) ? verifyTarget.processNames : []),
    'tradingview'
  ].map((value) => String(value || '').trim()).filter(Boolean)));

  const titleSearches = Array.from(new Set([
    'TradingView',
    ...(Array.isArray(verifyTarget?.titleHints) ? verifyTarget.titleHints : []),
    ...(Array.isArray(verifyTarget?.dialogTitleHints) ? verifyTarget.dialogTitleHints : [])
  ].map((value) => String(value || '').trim()).filter(Boolean)));

  const windowsByHint = [];
  for (const processName of knownProcessNames) {
    try {
      const found = await windowManager.findWindows({ processName, includeUntitled: true });
      windowsByHint.push(...(Array.isArray(found) ? found : []));
    } catch {}
  }

  for (const title of titleSearches) {
    try {
      const found = await windowManager.findWindows({ title });
      windowsByHint.push(...(Array.isArray(found) ? found : []));
    } catch {}
  }

  const windows = dedupeWindows(windowsByHint).filter(windowLooksLikeTradingView);
  const selectedWindow = pickPreferredTradingViewWindow(windows, foreground);

  const processNames = Array.from(new Set(windows
    .map((win) => String(win?.processName || '').trim().toLowerCase())
    .filter(Boolean)));

  let processes = [];
  if (processNames.length > 0) {
    processes = await aiService.systemAutomation.getRunningProcessesByNames(processNames);
  }

  return {
    foreground,
    windows,
    selectedWindow,
    processes,
    processNames
  };
}

function bindScenarioToDetectedWindow(scenario, detectedWindow = null) {
  if (!scenario || !detectedWindow) return scenario;

  const bound = cloneJson(scenario);
  const targetTitle = String(detectedWindow.title || 'TradingView').trim() || 'TradingView';
  const targetProcessName = String(detectedWindow.processName || '').trim();
  const targetWindowHandle = Number(detectedWindow.hwnd || 0) || 0;

  if (!bound?.actionData?.actions || !Array.isArray(bound.actionData.actions)) {
    return bound;
  }

  bound.actionData.actions = bound.actionData.actions.map((action) => {
    if (!action || typeof action !== 'object') return action;
    const type = String(action.type || '').trim().toLowerCase();
    if (action.tradingViewChartFocusClick === true) {
      const bounds = detectedWindow.bounds && typeof detectedWindow.bounds === 'object'
        ? detectedWindow.bounds
        : null;
      const x = Number(bounds?.x || 0);
      const y = Number(bounds?.y || 0);
      const width = Number(bounds?.width || 0);
      const height = Number(bounds?.height || 0);
      if (Number.isFinite(x) && Number.isFinite(y) && width > 0 && height > 0) {
        return {
          ...action,
          x: Math.round(x + width * 0.5),
          y: Math.round(y + height * 0.45),
          windowHandle: targetWindowHandle || action.windowHandle || action.hwnd || undefined,
          hwnd: targetWindowHandle || action.hwnd || action.windowHandle || undefined
        };
      }
    }
    if (type !== 'bring_window_to_front' && type !== 'focus_window') {
      return action;
    }

    return {
      ...action,
      title: targetTitle,
      processName: targetProcessName || action.processName || undefined,
      windowHandle: targetWindowHandle || action.windowHandle || action.hwnd || undefined,
      hwnd: targetWindowHandle || action.hwnd || action.windowHandle || undefined
    };
  });

  return bound;
}

function buildFocusScenario() {
  const verifyTarget = buildVerifyTargetHintFromAppName('TradingView');
  return {
    id: 'focus',
    description: 'Bring the already-open TradingView session to the foreground and prove focus lock.',
    userMessage: 'Focus the existing TradingView window and confirm it is foregrounded.',
    actionData: {
      thought: 'Focus the existing TradingView session',
      verification: 'TradingView should be the active foreground window',
      actions: [
        {
          type: 'bring_window_to_front',
          title: 'TradingView',
          processName: 'tradingview',
          reason: 'Focus the existing TradingView session before live smoke validation',
          verifyTarget
        }
      ]
    }
  };
}

function buildPineScenario() {
  return {
    id: 'pine-editor',
    description: 'Open Pine Editor through the grounded official Pine shortcut route and read visible bounded status text.',
    userMessage: 'Open TradingView Pine Editor through the verified official Pine shortcut route and inspect the visible Pine Editor state.',
    actionData: {
      thought: 'Open TradingView Pine Editor with watcher-backed verification and bounded readback',
      verification: 'TradingView should show an active Pine Editor surface and visible status/output',
      actions: buildTradingViewPineWorkflowActions({
        syntheticOpener: true,
        surfaceTarget: 'pine-editor',
        appName: 'TradingView',
        reason: 'Open TradingView Pine Editor through the official Pine shortcut route',
        verifyKind: 'editor-active',
        requiresEditorActivation: true,
        requiresObservedChange: true,
        safeAuthoringDefault: true,
        wantsEvidenceReadback: true,
        pineEvidenceMode: 'safe-authoring-inspect'
      }, [])
    }
  };
}

function buildClipboardSetCommand(value = '') {
  const normalized = String(value || '').replace(/\r/g, '');
  return `$ErrorActionPreference='Stop'; Set-Clipboard -Value @'\n${normalized}\n'@`;
}

function buildVwapTpoAtrConfidenceSource(scriptName = DEFAULT_PINE_CREATE_SAVE_NAME) {
  const safeName = String(scriptName || DEFAULT_PINE_CREATE_SAVE_NAME).trim() || DEFAULT_PINE_CREATE_SAVE_NAME;
  return [
    '//@version=6',
    `indicator(${JSON.stringify(safeName)}, overlay=true, max_labels_count=50)`,
    '',
    'src = input.source(hlc3, "VWAP Source")',
    'atrLen = input.int(14, "ATR Length", minval=1)',
    'tpoLen = input.int(48, "TPO Lookback", minval=10)',
    'atrMultiplier = input.float(1.5, "ATR Confirmation Multiplier", minval=0.1, step=0.1)',
    'showZones = input.bool(true, "Show TPO Value Zones")',
    'showSignals = input.bool(true, "Show Confidence Signals")',
    '',
    'sessionVwap = ta.vwap(src)',
    'atr = ta.atr(atrLen)',
    'atrMean = ta.sma(atr, atrLen)',
    'atrExpanded = atr > atrMean',
    'upperAtrBand = sessionVwap + atr * atrMultiplier',
    'lowerAtrBand = sessionVwap - atr * atrMultiplier',
    '',
    'profileHigh = ta.highest(high, tpoLen)',
    'profileLow = ta.lowest(low, tpoLen)',
    'profileMid = (profileHigh + profileLow) / 2.0',
    'profileRange = math.max(profileHigh - profileLow, syminfo.mintick)',
    'valueAreaHigh = profileMid + profileRange * 0.2',
    'valueAreaLow = profileMid - profileRange * 0.2',
    '',
    'vwapSlopeUp = sessionVwap > sessionVwap[1]',
    'vwapSlopeDown = sessionVwap < sessionVwap[1]',
    'aboveVwap = close > sessionVwap',
    'belowVwap = close < sessionVwap',
    'aboveValue = close > valueAreaHigh',
    'belowValue = close < valueAreaLow',
    'insideValue = close <= valueAreaHigh and close >= valueAreaLow',
    '',
    'bullScore = (aboveVwap ? 1 : 0) + (vwapSlopeUp ? 1 : 0) + (aboveValue ? 1 : 0) + (atrExpanded ? 1 : 0)',
    'bearScore = (belowVwap ? 1 : 0) + (vwapSlopeDown ? 1 : 0) + (belowValue ? 1 : 0) + (atrExpanded ? 1 : 0)',
    'bias = bullScore > bearScore ? "Bullish" : bearScore > bullScore ? "Bearish" : "Balanced"',
    'confidence = math.max(bullScore, bearScore)',
    '',
    'vwapPlot = plot(sessionVwap, "Session VWAP", color=color.new(color.blue, 0), linewidth=2)',
    'upperPlot = plot(upperAtrBand, "VWAP + ATR Confirmation", color=color.new(color.green, 25))',
    'lowerPlot = plot(lowerAtrBand, "VWAP - ATR Confirmation", color=color.new(color.red, 25))',
    'vahPlot = plot(showZones ? valueAreaHigh : na, "TPO Value Area High", color=color.new(color.orange, 0), style=plot.style_linebr)',
    'valPlot = plot(showZones ? valueAreaLow : na, "TPO Value Area Low", color=color.new(color.orange, 0), style=plot.style_linebr)',
    'midPlot = plot(showZones ? profileMid : na, "TPO Point of Control Proxy", color=color.new(color.yellow, 0), style=plot.style_linebr)',
    'fill(vahPlot, valPlot, color=color.new(color.orange, 88), title="TPO Value Area")',
    '',
    'longConfirm = showSignals and bullScore >= 3 and close > upperAtrBand',
    'shortConfirm = showSignals and bearScore >= 3 and close < lowerAtrBand',
    'plotshape(longConfirm, title="Bullish Confirmation", style=shape.triangleup, location=location.belowbar, color=color.new(color.green, 0), size=size.small, text="CONF")',
    'plotshape(shortConfirm, title="Bearish Confirmation", style=shape.triangledown, location=location.abovebar, color=color.new(color.red, 0), size=size.small, text="CONF")',
    'bgcolor(insideValue ? color.new(color.gray, 92) : na, title="Inside TPO Value Area")',
    '',
    'var table dashboard = table.new(position.top_right, 2, 5, border_width=1)',
    'if barstate.islast',
    '    table.cell(dashboard, 0, 0, "Bias", bgcolor=color.new(color.black, 0), text_color=color.white)',
    '    table.cell(dashboard, 1, 0, bias, text_color=bullScore > bearScore ? color.lime : bearScore > bullScore ? color.red : color.yellow)',
    '    table.cell(dashboard, 0, 1, "Confidence", text_color=color.white)',
    '    table.cell(dashboard, 1, 1, str.tostring(confidence) + "/4", text_color=confidence >= 3 ? color.lime : color.yellow)',
    '    table.cell(dashboard, 0, 2, "VWAP", text_color=color.white)',
    '    table.cell(dashboard, 1, 2, aboveVwap ? "Above" : "Below", text_color=aboveVwap ? color.lime : color.red)',
    '    table.cell(dashboard, 0, 3, "TPO Zone", text_color=color.white)',
    '    table.cell(dashboard, 1, 3, aboveValue ? "Above VAH" : belowValue ? "Below VAL" : "Inside Value", text_color=insideValue ? color.yellow : color.white)',
    '    table.cell(dashboard, 0, 4, "ATR", text_color=color.white)',
    '    table.cell(dashboard, 1, 4, atrExpanded ? "Expanded" : "Normal", text_color=atrExpanded ? color.lime : color.silver)',
    '',
    'alertcondition(longConfirm, "Bullish VWAP/TPO/ATR Confirmation", "Bullish confirmation: price is above VWAP, above value, and ATR confirms expansion.")',
    'alertcondition(shortConfirm, "Bearish VWAP/TPO/ATR Confirmation", "Bearish confirmation: price is below VWAP, below value, and ATR confirms expansion.")'
  ].join('\n');
}

function buildLiveSaveProbeSource(scriptName = DEFAULT_PINE_CREATE_SAVE_NAME, prompt = '') {
  const normalizedPrompt = String(prompt || '').toLowerCase();
  if (/\bvwap\b/.test(normalizedPrompt) && /\btpo\b/.test(normalizedPrompt) && /\batr\b/.test(normalizedPrompt)) {
    return buildVwapTpoAtrConfidenceSource(scriptName);
  }
  const safeName = String(scriptName || DEFAULT_PINE_CREATE_SAVE_NAME).trim() || DEFAULT_PINE_CREATE_SAVE_NAME;
  return [
    '//@version=6',
    `indicator(${JSON.stringify(safeName)}, overlay=false)`,
    'plot(close, title="Close")'
  ].join('\n');
}

function buildPineCreateSaveScenario(prompt, scriptName) {
  const effectivePrompt = String(prompt || DEFAULT_PINE_CREATE_SAVE_PROMPT).trim() || DEFAULT_PINE_CREATE_SAVE_PROMPT;
  const effectiveScriptName = String(scriptName || DEFAULT_PINE_CREATE_SAVE_NAME).trim() || DEFAULT_PINE_CREATE_SAVE_NAME;
  const scriptSource = buildLiveSaveProbeSource(effectiveScriptName, effectivePrompt);
  const sourceActions = [
    {
      type: 'run_command',
      shell: 'powershell',
      command: buildClipboardSetCommand(scriptSource),
      reason: `Copy the prepared Pine script (${effectiveScriptName}) to the clipboard for live create/save validation`
    }
  ];
  const inferredIntent = inferTradingViewPineIntent(effectivePrompt, sourceActions);
  if (!inferredIntent) {
    throw new Error('Could not infer a TradingView Pine create/save intent from the provided prompt.');
  }

  return {
    id: `pine-create-save-${sanitizeFileSegment(effectiveScriptName, 'pine-save')}`,
    description: `Create a fresh Pine script named ${effectiveScriptName}, save it, and verify visible save-state evidence without adding it to the chart.`,
    userMessage: effectivePrompt,
    actionData: {
      thought: `Create and save a fresh TradingView Pine script named ${effectiveScriptName}`,
      verification: 'TradingView should keep Pine Editor active and show save-state evidence for the freshly named script',
      actions: buildTradingViewPineWorkflowActions(inferredIntent, sourceActions)
    }
  };
}

function buildSymbolScenario(symbol) {
  return {
    id: `symbol-${sanitizeFileSegment(symbol, 'symbol')}`,
    description: `Change the TradingView symbol to ${symbol} and require an explicit chart-state proof.`,
    userMessage: `Set the TradingView symbol to ${symbol} and confirm it changed.`,
    actionData: {
      thought: `Apply TradingView symbol ${symbol}`,
      verification: `TradingView should show symbol ${symbol}`,
      actions: buildTradingViewSymbolWorkflowActions({ symbol, appName: 'TradingView' })
    }
  };
}

function buildTimeframeScenario(timeframe) {
  return {
    id: `timeframe-${sanitizeFileSegment(timeframe, 'timeframe')}`,
    description: `Change the TradingView timeframe to ${timeframe} and require an explicit chart-state proof.`,
    userMessage: `Set the TradingView chart timeframe to ${timeframe} and confirm it changed.`,
    actionData: {
      thought: `Apply TradingView timeframe ${timeframe}`,
      verification: `TradingView should show timeframe ${timeframe}`,
      actions: buildTradingViewTimeframeWorkflowActions({ timeframe, appName: 'TradingView' })
    }
  };
}

function buildScenarioPlan(options = {}) {
  const requested = String(options.scenarios || 'focus,pine-editor')
    .split(',')
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);

  const normalized = requested.length > 0 ? requested : ['focus', 'pine-editor'];
  const scenarios = [];

  for (const id of normalized) {
    if (id === 'focus') {
      scenarios.push(buildFocusScenario());
      continue;
    }
    if (id === 'pine' || id === 'pine-editor') {
      scenarios.push(buildPineScenario());
      continue;
    }
    if (id === 'pine-create-save' || id === 'pine-save') {
      scenarios.push(buildPineCreateSaveScenario(options.pinePrompt, options.pineScriptName));
      continue;
    }
    if (id === 'symbol') {
      if (!options.symbol) {
        throw new Error('Scenario "symbol" requires --symbol <TICKER>.');
      }
      if (!options.allowSymbolChange) {
        throw new Error('Scenario "symbol" mutates chart state. Re-run with --allow-symbol-change to make that explicit.');
      }
      scenarios.push(buildSymbolScenario(options.symbol));
      continue;
    }
    if (id === 'timeframe') {
      if (!options.timeframe) {
        throw new Error('Scenario "timeframe" requires --timeframe <VALUE>.');
      }
      if (!options.allowTimeframeChange) {
        throw new Error('Scenario "timeframe" mutates chart state. Re-run with --allow-timeframe-change to make that explicit.');
      }
      scenarios.push(buildTimeframeScenario(options.timeframe));
      continue;
    }
    throw new Error(`Unknown scenario: ${id}`);
  }

  return scenarios;
}

function printUsage() {
  console.log(`TradingView live smoke harness

Usage:
  node scripts/live-tradingview-smoke.js [options]

Default behavior:
  - requires an already-open TradingView session
  - runs non-destructive focus + Pine Editor smoke checks
  - starts a fast UI watcher for watcher-backed surface proof
  - exports runtime traces and a manifest to artifacts/live-validation/

Options:
  --scenarios <csv>            Scenarios to run: focus,pine-editor,pine-create-save,symbol,timeframe
  --symbol <ticker>            Symbol for the symbol scenario
  --timeframe <value>          Timeframe for the timeframe scenario
  --pine-prompt <text>         User prompt for the pine-create-save scenario
  --pine-script-name <name>    Script title for the pine-create-save scenario
  --allow-symbol-change        Explicitly allow symbol mutation
  --allow-timeframe-change     Explicitly allow timeframe mutation
  --artifact-dir <path>        Output directory (default: artifacts/live-validation)
  --poll-interval <ms>         UI watcher poll interval (default: ${DEFAULT_POLL_INTERVAL_MS})
  --dry-run                    Print the planned scenarios and exit
  --help                       Show this help text

Examples:
  node scripts/live-tradingview-smoke.js
  node scripts/live-tradingview-smoke.js --dry-run
  node scripts/live-tradingview-smoke.js --scenarios focus,pine-editor
  node scripts/live-tradingview-smoke.js --scenarios pine-create-save
  node scripts/live-tradingview-smoke.js --scenarios symbol --symbol BTCUSD --allow-symbol-change
  node scripts/live-tradingview-smoke.js --scenarios timeframe --timeframe 5m --allow-timeframe-change
`);
}

async function startWatcher(pollInterval) {
  const watcher = getUIWatcher({
    pollInterval,
    focusedWindowOnly: false,
    maxElements: 450,
    quiet: true
  });
  const startedHere = !watcher.isPolling;
  if (startedHere) {
    watcher.start();
  }
  aiService.setUIWatcher(watcher);

  try {
    await watcher.waitForFreshState({
      sinceTs: 0,
      timeoutMs: Math.max(1500, pollInterval * 6)
    });
  } catch {}

  return { watcher, startedHere };
}

async function gatherPreflight() {
  return findTradingViewContext();
}

async function runScenario(scenario, context) {
  const { runTag, artifactDir } = context;
  const effectiveScenario = bindScenarioToDetectedWindow(scenario, context.detectedWindow);
  const scenarioTag = `${runTag}-${sanitizeFileSegment(scenario.id)}`;

  console.log(`\n=== Scenario: ${effectiveScenario.id} ===`);
  console.log(effectiveScenario.description);
  console.log(`Actions: ${(effectiveScenario.actionData.actions || []).map(summarizeAction).join(' -> ')}`);

  const execResult = await aiService.executeActions(
    effectiveScenario.actionData,
    (result, index, total) => {
      const label = `${index + 1}/${total}`;
      const summary = result?.success
        ? (result?.message || 'ok')
        : (result?.error || 'failed');
      console.log(`[${label}] ${result?.action || 'action'}: ${summary}`);
    },
    null,
    {
      userMessage: effectiveScenario.userMessage
    }
  );

  let exportedTrace = null;
  try {
    exportedTrace = aiService.exportLastRuntimeTrace(path.join(artifactDir, `${scenarioTag}.jsonl`));
  } catch (error) {
    exportedTrace = { error: String(error?.message || error || 'Failed to export runtime trace') };
  }

  const postForeground = await aiService.systemAutomation.getForegroundWindowInfo();
  const summary = {
    id: effectiveScenario.id,
    description: effectiveScenario.description,
    userMessage: effectiveScenario.userMessage,
    thought: effectiveScenario.actionData.thought,
    verification: effectiveScenario.actionData.verification,
    success: execResult?.success === true,
    error: execResult?.error || null,
    pendingConfirmation: execResult?.pendingConfirmation === true,
    boundWindow: context.detectedWindow || null,
    actionSummary: (effectiveScenario.actionData.actions || []).map(summarizeAction),
    observationCheckpointCount: Array.isArray(execResult?.observationCheckpoints)
      ? execResult.observationCheckpoints.length
      : 0,
    runtimeTrace: execResult?.runtimeTrace || null,
    runtimeTraceSummary: execResult?.runtimeTraceSummary || null,
    exportedTrace,
    postForeground,
    results: Array.isArray(execResult?.results) ? execResult.results.map(summarizeResult) : []
  };

  const summaryPath = path.join(artifactDir, `${scenarioTag}.summary.json`);
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`Summary: ${summaryPath}`);
  if (exportedTrace?.filePath) {
    console.log(`Trace:   ${exportedTrace.filePath}`);
  }

  return summary;
}

async function main() {
  if (hasFlag('--help')) {
    printUsage();
    return;
  }

  const artifactDir = path.resolve(process.cwd(), getArgValue('--artifact-dir') || DEFAULT_ARTIFACT_DIR);
  const pollInterval = Math.max(100, Number(getArgValue('--poll-interval') || DEFAULT_POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS);
  const options = {
    scenarios: getArgValue('--scenarios') || getEnvValue('LIKU_LIVE_TV_SCENARIOS') || 'focus,pine-editor',
    symbol: getArgValue('--symbol') || getEnvValue('LIKU_LIVE_TV_SYMBOL') || '',
    timeframe: getArgValue('--timeframe') || getEnvValue('LIKU_LIVE_TV_TIMEFRAME') || '',
    pinePrompt: getArgValue('--pine-prompt') || getEnvValue('LIKU_LIVE_TV_PINE_PROMPT') || DEFAULT_PINE_CREATE_SAVE_PROMPT,
    pineScriptName: getArgValue('--pine-script-name') || getEnvValue('LIKU_LIVE_TV_PINE_SCRIPT_NAME') || DEFAULT_PINE_CREATE_SAVE_NAME,
    allowSymbolChange: hasFlag('--allow-symbol-change'),
    allowTimeframeChange: hasFlag('--allow-timeframe-change')
  };

  const scenarios = buildScenarioPlan(options);
  const dryRun = hasFlag('--dry-run');

  if (dryRun) {
    console.log(JSON.stringify({
      artifactDir,
      pollInterval,
      scenarios: scenarios.map((scenario) => ({
        id: scenario.id,
        description: scenario.description,
        userMessage: scenario.userMessage,
        actions: (scenario.actionData.actions || []).map(summarizeAction)
      }))
    }, null, 2));
    return;
  }

  ensureDir(artifactDir);
  const runTag = buildTimestampTag();

  console.log('========================================');
  console.log(' TradingView Live Smoke Harness');
  console.log('========================================');
  console.log(`Artifact dir: ${artifactDir}`);
  console.log(`Run tag:      ${runTag}`);
  console.log(`Scenarios:    ${scenarios.map((scenario) => scenario.id).join(', ')}`);
  console.log(`Watcher poll: ${pollInterval}ms`);

  const preflight = await gatherPreflight();
  const { processes, foreground, windows, selectedWindow } = preflight;
  if (!selectedWindow) {
    throw new Error('No TradingView-like window was detected via UIA/window discovery. Make sure an actual TradingView desktop window or browser tab is open and visible, then rerun the live smoke harness.');
  }

  console.log(`TradingView-like windows detected: ${Array.isArray(windows) ? windows.length : 0}`);
  (windows || []).slice(0, 5).forEach((win, index) => {
    console.log(`  [${index}] hwnd=${win.hwnd} process=${win.processName} kind=${win.windowKind} title=${JSON.stringify(win.title || '')}`);
  });
  console.log(`Selected window: ${JSON.stringify({
    hwnd: selectedWindow?.hwnd || null,
    title: selectedWindow?.title || null,
    processName: selectedWindow?.processName || null,
    windowKind: selectedWindow?.windowKind || null,
    isMinimized: !!selectedWindow?.isMinimized
  })}`);
  if (Array.isArray(processes) && processes.length > 0) {
    console.log(`Backing processes detected: ${processes.length}`);
    processes.slice(0, 5).forEach((proc, index) => {
      console.log(`  [${index}] pid=${proc.pid} process=${proc.processName} title=${JSON.stringify(proc.mainWindowTitle || '')}`);
    });
  }
  console.log(`Initial foreground: ${JSON.stringify({
    title: foreground?.title || null,
    processName: foreground?.processName || null,
    hwnd: foreground?.hwnd || null,
    windowKind: foreground?.windowKind || null
  })}`);

  const watcherRuntime = await startWatcher(pollInterval);
  const manifest = {
    runTag,
    startedAt: new Date().toISOString(),
    artifactDir,
    pollInterval,
    scenarios: [],
    preflight: {
      processes,
      processNames: Array.isArray(preflight?.processNames) ? preflight.processNames : [],
      windows,
      selectedWindow,
      foreground
    }
  };

  try {
    await sleep(Math.max(300, pollInterval * 2));

    for (const scenario of scenarios) {
      const summary = await runScenario(scenario, {
        runTag,
        artifactDir,
        detectedWindow: selectedWindow
      });
      manifest.scenarios.push(summary);
    }
  } finally {
    if (watcherRuntime.startedHere && watcherRuntime.watcher?.isPolling) {
      watcherRuntime.watcher.stop();
    }
  }

  manifest.finishedAt = new Date().toISOString();
  manifest.success = manifest.scenarios.every((scenario) => scenario.success === true);
  const manifestPath = path.join(artifactDir, `${runTag}-tradingview-live-smoke.manifest.json`);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log('\n========================================');
  console.log(` Result: ${manifest.success ? 'PASS' : 'FAIL'}`);
  console.log('========================================');
  manifest.scenarios.forEach((scenario) => {
    console.log(`- ${scenario.id}: ${scenario.success ? 'PASS' : 'FAIL'}${scenario.error ? ` (${scenario.error})` : ''}`);
  });
  console.log(`Manifest: ${manifestPath}`);

  if (!manifest.success) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
} else {
  module.exports = {
    windowLooksLikeTradingView,
    pickPreferredTradingViewWindow,
    findTradingViewContext
  };
}
