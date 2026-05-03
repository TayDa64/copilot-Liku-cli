#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const aiService = require(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'));
const { getUIWatcher } = require(path.join(__dirname, '..', 'src', 'main', 'ui-watcher.js'));
const windowManager = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation', 'window', 'manager.js'));
const {
  buildVerifyTargetHintFromAppName,
  buildOpenApplicationActions
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'app-profile.js'));
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
const DEFAULT_PINE_INSERT_MODE = 'clipboard';
const DEFAULT_PINE_SOURCE_PROFILE = 'auto';
const DEFAULT_TRADINGVIEW_BROWSER_URL = 'https://www.tradingview.com/chart/';
const DEFAULT_CONTEXT_WAIT_MS = 15000;
const DEFAULT_CONTEXT_POLL_MS = 750;

function getArgValue(flagName) {
  const index = process.argv.indexOf(flagName);
  if (index >= 0 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return null;
}

function hasFlag(flagName) {
  return process.argv.includes(flagName);
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
  if (foregroundHwnd > 0) {
    const exactForeground = windows.find((win) => Number(win?.hwnd || 0) === foregroundHwnd);
    if (exactForeground) return exactForeground;
  }

  const scored = windows
    .map((win) => {
      const title = normalizeText(win?.title);
      const processName = normalizeText(win?.processName);
      const windowKind = normalizeText(win?.windowKind);
      let score = 0;
      if (Number(win?.hwnd || 0) === foregroundHwnd) score += 50;
      if (!win?.isMinimized) score += 20;
      if (windowKind === 'main') score += 15;
      if (/tradingview/.test(title)) score += 12;
      if (/tradingview/.test(processName)) score += 10;
      if (/pine editor|paper trading|depth of market|trading panel|object tree/.test(title)) score += 6;
      return { win, score };
    })
    .sort((a, b) => b.score - a.score);

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
  const buildContextFromWindows = async (candidateWindows) => {
    const windows = dedupeWindows(candidateWindows).filter(windowLooksLikeTradingView);
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
  };

  for (const processName of knownProcessNames) {
    try {
      const found = await windowManager.findWindows({ processName, includeUntitled: true });
      windowsByHint.push(...(Array.isArray(found) ? found : []));
    } catch {}
  }

  const processContext = await buildContextFromWindows(windowsByHint);
  if (processContext?.selectedWindow) {
    return processContext;
  }

  for (const title of titleSearches) {
    try {
      const found = await windowManager.findWindows({ title });
      windowsByHint.push(...(Array.isArray(found) ? found : []));
    } catch {}
  }

  return buildContextFromWindows(windowsByHint);
}

async function waitForTradingViewContext(timeoutMs = DEFAULT_CONTEXT_WAIT_MS, pollMs = DEFAULT_CONTEXT_POLL_MS) {
  let latest = await findTradingViewContext();
  if (latest?.selectedWindow) {
    return latest;
  }

  const deadline = Date.now() + Math.max(1000, Number(timeoutMs || DEFAULT_CONTEXT_WAIT_MS) || DEFAULT_CONTEXT_WAIT_MS);
  const intervalMs = Math.max(200, Number(pollMs || DEFAULT_CONTEXT_POLL_MS) || DEFAULT_CONTEXT_POLL_MS);
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    latest = await findTradingViewContext();
    if (latest?.selectedWindow) {
      return latest;
    }
  }

  return latest;
}

async function tryLaunchTradingViewDesktop() {
  console.log('No TradingView-like window detected. Attempting TradingView Desktop launch...');
  let execResult = null;
  let error = null;

  try {
    execResult = await aiService.executeActions({
      thought: 'Launch TradingView Desktop before live smoke validation',
      verification: 'TradingView should become discoverable as a live app window',
      actions: buildOpenApplicationActions('TradingView')
    }, (result, index, total) => {
      const label = `${index + 1}/${total}`;
      const summary = result?.success ? (result?.message || 'ok') : (result?.error || 'failed');
      console.log(`[launch desktop ${label}] ${result?.action || 'action'}: ${summary}`);
    }, null, {
      userMessage: 'open tradingview',
      skipSafetyConfirmation: true
    });
  } catch (launchError) {
    error = String(launchError?.message || launchError || 'Desktop launch attempt failed');
  }

  const context = await waitForTradingViewContext();
  return {
    mode: 'desktop',
    attempted: true,
    success: !!context?.selectedWindow,
    execResult,
    error: context?.selectedWindow ? null : (error || execResult?.error || 'TradingView Desktop was not discoverable after launch attempt'),
    context
  };
}

async function tryLaunchTradingViewBrowser(url = DEFAULT_TRADINGVIEW_BROWSER_URL) {
  const targetUrl = String(url || DEFAULT_TRADINGVIEW_BROWSER_URL).trim() || DEFAULT_TRADINGVIEW_BROWSER_URL;
  console.log(`TradingView Desktop did not become discoverable. Attempting browser fallback: ${targetUrl}`);

  let result = null;
  let error = null;
  try {
    result = await aiService.systemAutomation.executeAction({
      type: 'run_command',
      shell: 'powershell',
      command: `$ErrorActionPreference='Stop'; Start-Process ${JSON.stringify(targetUrl)}`,
      reason: 'Open TradingView in the default browser for live smoke validation'
    });
  } catch (launchError) {
    error = String(launchError?.message || launchError || 'Browser fallback launch failed');
  }

  await sleep(2000);
  const context = await waitForTradingViewContext(20000, 1000);
  return {
    mode: 'browser',
    attempted: true,
    success: !!context?.selectedWindow,
    result,
    error: context?.selectedWindow ? null : (error || result?.error || 'TradingView browser window/tab was not discoverable after fallback launch'),
    context,
    url: targetUrl
  };
}

async function ensureTradingViewContext() {
  const initial = await gatherPreflight();
  const launchAttempts = [];
  if (initial?.selectedWindow) {
    return {
      ...initial,
      launchAttempts
    };
  }

  const desktopAttempt = await tryLaunchTradingViewDesktop();
  launchAttempts.push({
    mode: desktopAttempt.mode,
    attempted: true,
    success: desktopAttempt.success,
    error: desktopAttempt.error || null
  });
  if (desktopAttempt?.context?.selectedWindow) {
    return {
      ...desktopAttempt.context,
      launchAttempts
    };
  }

  const browserAttempt = await tryLaunchTradingViewBrowser();
  launchAttempts.push({
    mode: browserAttempt.mode,
    attempted: true,
    success: browserAttempt.success,
    error: browserAttempt.error || null,
    url: browserAttempt.url || null
  });
  if (browserAttempt?.context?.selectedWindow) {
    return {
      ...browserAttempt.context,
      launchAttempts
    };
  }

  return {
    ...(browserAttempt?.context || desktopAttempt?.context || initial || {}),
    launchAttempts
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

function buildPineInsertSourceActions(scriptSource = '', options = {}) {
  const normalizedSource = String(scriptSource || '').replace(/\r/g, '').trim();
  const insertMode = String(options.insertMode || DEFAULT_PINE_INSERT_MODE).trim().toLowerCase();
  const scriptName = String(options.scriptName || DEFAULT_PINE_CREATE_SAVE_NAME).trim() || DEFAULT_PINE_CREATE_SAVE_NAME;

  if (!normalizedSource) return [];

  if (insertMode === 'clipboard') {
    return [
      {
        type: 'run_command',
        shell: 'powershell',
        command: buildClipboardSetCommand(normalizedSource),
        reason: `Copy the prepared Pine script (${scriptName}) to the clipboard for live create/save validation`
      }
    ];
  }

  return [
    {
      type: 'type',
      text: normalizedSource,
      reason: `Type the prepared Pine script (${scriptName}) directly into the active Pine Editor for live create/save validation`
    }
  ];
}

function buildLiveSaveProbeSource(scriptName = DEFAULT_PINE_CREATE_SAVE_NAME) {
  const safeName = String(scriptName || DEFAULT_PINE_CREATE_SAVE_NAME).trim() || DEFAULT_PINE_CREATE_SAVE_NAME;
  return [
    '//@version=6',
    `indicator(${JSON.stringify(safeName)}, overlay=false)`,
    'plot(close, title="Close")'
  ].join('\n');
}

function buildIndustryStandardPineSource(scriptName = 'Industry Standard Trend Momentum Suite') {
  const safeName = String(scriptName || 'Industry Standard Trend Momentum Suite').trim() || 'Industry Standard Trend Momentum Suite';
  return [
    '//@version=6',
    `indicator(${JSON.stringify(safeName)}, overlay=true, max_labels_count=200)`,
    '',
    '// Industry-standard trend + momentum confirmation template',
    'fastEmaLength = input.int(21, "Fast EMA", minval=1)',
    'slowEmaLength = input.int(50, "Slow EMA", minval=1)',
    'rsiLength = input.int(14, "RSI Length", minval=1)',
    'atrLength = input.int(14, "ATR Length", minval=1)',
    'atrMultiplier = input.float(2.0, "ATR Multiplier", minval=0.1, step=0.1)',
    '',
    'fastEma = ta.ema(close, fastEmaLength)',
    'slowEma = ta.ema(close, slowEmaLength)',
    'rsiValue = ta.rsi(close, rsiLength)',
    'atrValue = ta.atr(atrLength)',
    '',
    'bullTrend = fastEma > slowEma and rsiValue >= 55',
    'bearTrend = fastEma < slowEma and rsiValue <= 45',
    'bullCross = ta.crossover(fastEma, slowEma) and rsiValue >= 50',
    'bearCross = ta.crossunder(fastEma, slowEma) and rsiValue <= 50',
    '',
    'longRiskBand = close - atrValue * atrMultiplier',
    'shortRiskBand = close + atrValue * atrMultiplier',
    '',
    'plot(fastEma, "Fast EMA", color=color.new(color.teal, 0), linewidth=2)',
    'plot(slowEma, "Slow EMA", color=color.new(color.orange, 0), linewidth=2)',
    'plot(bullTrend ? longRiskBand : na, "Bull ATR Risk Band", color=color.new(color.green, 35), linewidth=1, style=plot.style_linebr)',
    'plot(bearTrend ? shortRiskBand : na, "Bear ATR Risk Band", color=color.new(color.red, 35), linewidth=1, style=plot.style_linebr)',
    '',
    'plotshape(bullCross, title="Bullish Signal", style=shape.triangleup, location=location.belowbar, color=color.new(color.lime, 0), size=size.tiny, text="BUY")',
    'plotshape(bearCross, title="Bearish Signal", style=shape.triangledown, location=location.abovebar, color=color.new(color.red, 0), size=size.tiny, text="SELL")',
    '',
    'bgcolor(bullTrend ? color.new(color.green, 92) : bearTrend ? color.new(color.red, 92) : na, title="Trend Bias")',
    '',
    'alertcondition(bullCross, title="Bullish EMA/RSI Signal", message="Bullish crossover with RSI confirmation")',
    'alertcondition(bearCross, title="Bearish EMA/RSI Signal", message="Bearish crossunder with RSI confirmation")'
  ].join('\n');
}

function inferPineSourceProfile(prompt = '', requestedProfile = DEFAULT_PINE_SOURCE_PROFILE) {
  const normalizedRequested = String(requestedProfile || DEFAULT_PINE_SOURCE_PROFILE).trim().toLowerCase();
  if (normalizedRequested && normalizedRequested !== 'auto') {
    return normalizedRequested;
  }

  const normalizedPrompt = String(prompt || '').trim().toLowerCase();
  if (/\bindustry\s+standard\b|\bprofessional\b|\bema\b|\brsi\b|\batr\b|\btrend\s+following\b/.test(normalizedPrompt)) {
    return 'industry-standard';
  }

  return 'probe';
}

function buildPineScenarioSource(scriptName, prompt, options = {}) {
  const resolvedProfile = inferPineSourceProfile(prompt, options.sourceProfile);
  if (resolvedProfile === 'industry-standard') {
    return {
      profile: resolvedProfile,
      source: buildIndustryStandardPineSource(scriptName)
    };
  }

  return {
    profile: 'probe',
    source: buildLiveSaveProbeSource(scriptName)
  };
}

function buildPineCreateSaveScenario(prompt, scriptName, options = {}) {
  const effectivePrompt = String(prompt || DEFAULT_PINE_CREATE_SAVE_PROMPT).trim() || DEFAULT_PINE_CREATE_SAVE_PROMPT;
  const effectiveScriptName = String(scriptName || DEFAULT_PINE_CREATE_SAVE_NAME).trim() || DEFAULT_PINE_CREATE_SAVE_NAME;
  const insertMode = String(options.insertMode || DEFAULT_PINE_INSERT_MODE).trim().toLowerCase() || DEFAULT_PINE_INSERT_MODE;
  const scriptPlan = buildPineScenarioSource(effectiveScriptName, effectivePrompt, {
    sourceProfile: options.sourceProfile
  });
  const scriptSource = scriptPlan.source;
  const sourceActions = buildPineInsertSourceActions(scriptSource, {
    insertMode,
    scriptName: effectiveScriptName
  });
  const inferredIntent = inferTradingViewPineIntent(effectivePrompt, sourceActions);
  if (!inferredIntent) {
    throw new Error('Could not infer a TradingView Pine create/save intent from the provided prompt.');
  }

  return {
    id: `pine-create-save-${sanitizeFileSegment(effectiveScriptName, 'pine-save')}`,
    description: `Create a fresh Pine script named ${effectiveScriptName}, save it, and verify visible save-state evidence without adding it to the chart using ${insertMode === 'clipboard' ? 'clipboard paste' : 'direct typing'} and the ${scriptPlan.profile} Pine source profile.`,
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
      scenarios.push(buildPineCreateSaveScenario(options.pinePrompt, options.pineScriptName, {
        insertMode: options.pineInsertMode,
        sourceProfile: options.pineSourceProfile
      }));
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
  - prefers an already-open TradingView session
  - if none is found, attempts to launch TradingView Desktop first
  - if Desktop is unavailable, attempts to open TradingView in the default browser
  - runs non-destructive focus + Pine Editor smoke checks
  - starts a fast UI watcher for watcher-backed surface proof
  - exports runtime traces and a manifest to artifacts/live-validation/

Options:
  --scenarios <csv>            Scenarios to run: focus,pine-editor,pine-create-save,symbol,timeframe
  --symbol <ticker>            Symbol for the symbol scenario
  --timeframe <value>          Timeframe for the timeframe scenario
  --pine-prompt <text>         User prompt for the pine-create-save scenario
  --pine-script-name <name>    Script title for the pine-create-save scenario
  --pine-insert-mode <mode>    Pine insertion mode: clipboard (default) or type
  --pine-source-profile <id>   Pine source profile: auto (default), probe, industry-standard
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
  node scripts/live-tradingview-smoke.js --scenarios pine-create-save --pine-insert-mode clipboard
  node scripts/live-tradingview-smoke.js --scenarios pine-create-save --pine-source-profile industry-standard
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
      userMessage: effectiveScenario.userMessage,
      skipSafetyConfirmation: true
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
    scenarios: getArgValue('--scenarios') || 'focus,pine-editor',
    symbol: getArgValue('--symbol') || '',
    timeframe: getArgValue('--timeframe') || '',
    pinePrompt: getArgValue('--pine-prompt') || DEFAULT_PINE_CREATE_SAVE_PROMPT,
    pineScriptName: getArgValue('--pine-script-name') || DEFAULT_PINE_CREATE_SAVE_NAME,
    pineInsertMode: getArgValue('--pine-insert-mode') || DEFAULT_PINE_INSERT_MODE,
    pineSourceProfile: getArgValue('--pine-source-profile') || DEFAULT_PINE_SOURCE_PROFILE,
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

  const preflight = await ensureTradingViewContext();
  const { processes, foreground, windows, selectedWindow } = preflight;
  if (!selectedWindow) {
    throw new Error(`No TradingView-like window was detected via UIA/window discovery after launch attempts. Launch attempts: ${JSON.stringify(preflight?.launchAttempts || [])}`);
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
      launchAttempts: Array.isArray(preflight?.launchAttempts) ? preflight.launchAttempts : [],
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

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
