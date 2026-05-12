#!/usr/bin/env node
/**
 * Test script for v0.0.5 bug fixes and integration
 * Tests: ai-service safety analysis, ui-watcher isRunning getter, chat.js action rendering
 */

const path = require('path');

const results = {
  passed: 0,
  failed: 0,
  tests: []
};

function test(name, fn) {
  try {
    fn();
    results.passed++;
    results.tests.push({ name, status: 'PASS' });
    console.log(`✅ PASS: ${name}`);
  } catch (error) {
    results.failed++;
    results.tests.push({ name, status: 'FAIL', error: error.message });
    console.log(`❌ FAIL: ${name}`);
    console.log(`   Error: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'Assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message || 'Assertion failed'}: expected ${expectedJson}, got ${actualJson}`);
  }
}

function normalizeSafetyResultForComparison(result) {
  if (!result || typeof result !== 'object') return result;
  return {
    ...result,
    actionId: '<normalized>',
    timestamp: 0
  };
}

console.log('\n========================================');
console.log('  Testing v0.0.5 Bug Fixes');
console.log('========================================\n');

// Test UIWatcher isRunning getter
test('UIWatcher has isRunning getter', () => {
  const uiWatcherPath = path.join(__dirname, '..', 'src', 'main', 'ui-watcher.js');
  const { UIWatcher } = require(uiWatcherPath);
  
  // Check that the class exists
  assert(typeof UIWatcher === 'function', 'UIWatcher should be a class/constructor');
  
  // Create instance and check isRunning property
  const watcher = new UIWatcher();
  assert('isRunning' in watcher, 'UIWatcher instance should have isRunning property');
  
  // Initial state should be false (not polling)
  assertEqual(watcher.isRunning, false, 'Initial isRunning should be false');
  assertEqual(watcher.isPolling, false, 'Initial isPolling should be false');
  
  // Verify isRunning reflects isPolling
  watcher.isPolling = true;
  assertEqual(watcher.isRunning, true, 'isRunning should reflect isPolling=true');
  
  watcher.isPolling = false;
  assertEqual(watcher.isRunning, false, 'isRunning should reflect isPolling=false');
});

// Test ai-service has run_command in system prompt
test('System prompt includes run_command documentation', () => {
  const aiServicePath = path.join(__dirname, '..', 'src', 'main', 'ai-service.js');
  const fs = require('fs');
  
  const aiServiceContent = fs.readFileSync(aiServicePath, 'utf8');
  
  assert(aiServiceContent.includes('run_command'), 'ai-service should mention run_command');
  assert(aiServiceContent.includes('PREFERRED FOR SHELL TASKS'), 'Should have run_command marked as preferred');
  assert(aiServiceContent.includes('shell.*powershell|cmd|bash') || 
         aiServiceContent.includes('"shell": "powershell|cmd|bash"') ||
         aiServiceContent.includes('shell.*powershell') ||
         aiServiceContent.includes('powershell|cmd|bash'),
    'Should document shell options');
});

// Test ai-service analyzeActionSafety handles run_command
test('analyzeActionSafety handles run_command case', () => {
  const aiServicePath = path.join(__dirname, '..', 'src', 'main', 'ai-service.js');
  const fs = require('fs');
  
  const aiServiceContent = fs.readFileSync(aiServicePath, 'utf8');
  
  assert(aiServiceContent.includes("case 'run_command':"), 'analyzeActionSafety should have run_command case');
  // Check that dangerous patterns are being analyzed (either via function or inline patterns)
  assert(
    aiServiceContent.includes('dangerousPatterns') || aiServiceContent.includes('isCommandDangerous'),
    'Should analyze command for dangerous patterns'
  );
  assert(aiServiceContent.includes('CRITICAL'), 'Should flag dangerous commands as CRITICAL risk');
});

// Test chat.js handles action.key correctly
test('chat.js uses action.key with fallback to action.keys', () => {
  const chatJsPath = path.join(__dirname, '..', 'src', 'renderer', 'chat', 'chat.js');
  const fs = require('fs');
  
  const chatContent = fs.readFileSync(chatJsPath, 'utf8');
  
  assert(chatContent.includes('action.key || action.keys'), 'Should use action.key with fallback to action.keys');
});

// Test chat.js has run_command UI rendering
test('chat.js renders run_command actions', () => {
  const chatJsPath = path.join(__dirname, '..', 'src', 'renderer', 'chat', 'chat.js');
  const fs = require('fs');
  
  const chatContent = fs.readFileSync(chatJsPath, 'utf8');
  
  assert(chatContent.includes("case 'run_command':"), 'Should have run_command case in action rendering');
  assert(chatContent.includes("'💻'") || chatContent.includes('"💻"'), 'Should have terminal emoji for run_command');
});

test('chat.js auto-captures observation context after focus or launch actions', () => {
  const chatJsPath = path.join(__dirname, '..', 'src', 'cli', 'commands', 'chat.js');
  const fs = require('fs');

  const chatContent = fs.readFileSync(chatJsPath, 'utf8');

  assert(chatContent.includes('function shouldAutoCaptureObservationAfterActions'), 'Should define observation auto-capture helper');
  assert(chatContent.includes('async function waitForFreshObservationContext'), 'Observation flow should wait for fresh watcher context');
  assert(chatContent.includes("const requestedScope = String(options.scope || '').trim().toLowerCase();"), 'Auto-capture should normalize requested screenshot scope');
  assert(chatContent.includes("['active-window', 'window'].includes(requestedScope)"), 'Auto-capture should support active-window and explicit window scope');
  assert(chatContent.includes('targetWindowHandle'), 'Auto-capture should preserve the target window handle when available');
  assert(chatContent.includes("execResult?.success && shouldAutoCaptureObservationAfterActions"), 'Successful observation flows should auto-capture after actions');
  assert(chatContent.includes('watcher.waitForFreshState'), 'Observation flow should wait for a fresh watcher cycle before continuation');
  assert(chatContent.includes("autoCapture(ai, { scope: 'active-window' })"), 'Observation flow should capture the active window');
  assert(chatContent.includes('function isScreenshotOnlyPlan'), 'Observation flow should detect screenshot-only continuation loops');
  assert(chatContent.includes('buildForcedObservationAnswerPrompt'), 'Observation flow should force a direct answer after fresh visual evidence');
  assert(chatContent.includes('forcing a direct answer instead'), 'Observation flow should explicitly stop repeated screenshot-only continuations');
  assert(chatContent.includes('Falling back to full-screen capture'), 'Observation flow should fallback to full-screen capture when active-window capture fails');
  assert(chatContent.includes('function isLikelyApprovalOrContinuationInput'), 'Chat flow should recognize approval-style replies that should execute emitted actions');
  assert(chatContent.includes('function shouldExecuteDetectedActions'), 'Chat flow should gate action execution with a broader actionable-intent helper');
  assert(chatContent.includes('set|change|switch|adjust|update|create|add|remove|alert'), 'Automation intent detection should cover alert-setting and update-style requests');
});

test('screenshot module falls back from PrintWindow to CopyFromScreen', () => {
  const screenshotPath = path.join(__dirname, '..', 'src', 'main', 'ui-automation', 'screenshot.js');
  const fs = require('fs');

  const screenshotContent = fs.readFileSync(screenshotPath, 'utf8');

  assert(screenshotContent.includes('CapturePrintWindow'), 'Screenshot module should attempt PrintWindow capture first');
  assert(screenshotContent.includes('CaptureFromScreen'), 'Screenshot module should define CopyFromScreen window fallback');
  assert(screenshotContent.includes("$captureMode = 'window-copyfromscreen'"), 'Screenshot module should record when window capture falls back to CopyFromScreen');
  assert(screenshotContent.includes('SCREENSHOT_CAPTURE_MODE:'), 'Screenshot module should surface capture mode for diagnostics');
});

test('system-automation preserves pid after process sorting', () => {
  const sysAutoPath = path.join(__dirname, '..', 'src', 'main', 'system-automation.js');
  const fs = require('fs');

  const systemAutomationContent = fs.readFileSync(sysAutoPath, 'utf8');

  assert(systemAutomationContent.includes('Select-Object -First 15 -Property pid, processName, mainWindowTitle, startTime'), 'Process enumeration should keep projected pid fields after sorting');
});

test('focus results preserve requested-vs-actual target metadata', () => {
  const sysAutoPath = path.join(__dirname, '..', 'src', 'main', 'system-automation.js');
  const aiServicePath = path.join(__dirname, '..', 'src', 'main', 'ai-service.js');
  const fs = require('fs');

  const systemAutomationContent = fs.readFileSync(sysAutoPath, 'utf8');
  const aiServiceContent = fs.readFileSync(aiServicePath, 'utf8');

  assert(systemAutomationContent.includes('requestedWindowHandle'), 'System automation focus actions should preserve the requested target handle');
  assert(systemAutomationContent.includes('actualForegroundHandle'), 'System automation focus actions should preserve the actual foreground handle');
  assert(systemAutomationContent.includes('focusTarget'), 'System automation focus actions should expose structured focus target metadata');
  assert(aiServiceContent.includes('classifyActionFocusTargetResult'), 'ai-service should classify focus outcomes before updating target handles');
  assert(aiServiceContent.includes('result.focusTarget = {'), 'ai-service should enrich focus results with accepted/mismatch outcome metadata');
  assert(aiServiceContent.includes("action.type === 'click' ||"), 'ai-service should still snapshot actual foreground handles for click-style actions');
  assert(!aiServiceContent.includes("action.type === 'right_click' ||\n        action.type === 'focus_window' ||\n        action.type === 'bring_window_to_front'"), 'ai-service should no longer treat focus actions as unconditional foreground snapshots');
});

test('ui-watcher exposes active window capability snapshot', () => {
  const uiWatcherPath = path.join(__dirname, '..', 'src', 'main', 'ui-watcher.js');
  const fs = require('fs');

  const uiWatcherContent = fs.readFileSync(uiWatcherPath, 'utf8');

  assert(uiWatcherContent.includes('getCapabilitySnapshot()'), 'UI watcher should expose a capability snapshot helper');
  assert(uiWatcherContent.includes('namedInteractiveElementCount'), 'Capability snapshot should report named interactive UIA density');
  assert(uiWatcherContent.includes('waitForFreshState(options = {})'), 'UI watcher should expose a fresh-state wait helper');
  assert(uiWatcherContent.includes('Freshness**: stale UI snapshot'), 'UI watcher AI context should warn when UI state is stale');
});

test('message-builder injects active app capability context', () => {
  const messageBuilderPath = path.join(__dirname, '..', 'src', 'main', 'ai-service', 'message-builder.js');
  const capabilityPolicyPath = path.join(__dirname, '..', 'src', 'main', 'capability-policy.js');
  const fs = require('fs');

  const messageBuilderContent = fs.readFileSync(messageBuilderPath, 'utf8');
  const capabilityPolicyContent = fs.readFileSync(capabilityPolicyPath, 'utf8');

  assert(messageBuilderContent.includes('classifyActiveAppCapability'), 'Message builder should classify active app capability');
  assert(messageBuilderContent.includes('buildCapabilityPolicySystemMessage'), 'Message builder should inject active app capability context');
  assert(messageBuilderContent.includes('visual-first-low-uia'), 'Capability context should recognize low-UIA visual-first apps');
  assert(capabilityPolicyContent.includes('uia-rich'), 'Capability context should recognize UIA-rich apps');
  assert(messageBuilderContent.includes('watcherSnapshot'), 'Capability context should include watcher/UIA inventory input');
  assert(capabilityPolicyContent.includes('answer-shape:'), 'Capability context should shape control-surface answers');
  assert(messageBuilderContent.includes('## Pine Evidence Bounds'), 'Message builder should inject a bounded Pine diagnostics evidence block when relevant');
  assert(messageBuilderContent.includes('inferPineEvidenceRequestKind'), 'Message builder should classify Pine evidence request kinds');
  assert(messageBuilderContent.includes('runtime correctness, strategy validity, profitability, or market insight'), 'Pine evidence bounds should prevent compile success from being overclaimed');
  assert(messageBuilderContent.includes('## Drawing Capability Bounds'), 'Message builder should inject explicit TradingView drawing capability bounds');
  assert(messageBuilderContent.includes('Distinguish TradingView drawing surface access from precise chart-object placement'), 'Drawing bounds should distinguish surface access from precise placement');
  assert(messageBuilderContent.includes('safe surface workflow or explicitly refuse precise-placement claims'), 'Drawing bounds should require safe workflow fallback or explicit limitation for exact placement requests');
});

test('ai-service verifies focus continuity after action execution', () => {
  const aiServicePath = path.join(__dirname, '..', 'src', 'main', 'ai-service.js');
  const fs = require('fs');

  const aiServiceContent = fs.readFileSync(aiServicePath, 'utf8');

  assert(aiServiceContent.includes('async function verifyForegroundFocus'), 'ai-service should define a bounded focus verification helper');
  assert(aiServiceContent.includes('Focus verification could not keep the target window in the foreground'), 'ai-service should surface focus verification failures clearly');
  assert(aiServiceContent.includes('focusVerification = await verifyForegroundFocus'), 'executeActions should verify focus continuity after successful execution');
  assert(aiServiceContent.includes('focusVerification,'), 'executeActions should return focus verification details');
});

test('rewriteActionsForReliability normalizes typoed app launches', () => {
  const aiServicePath = path.join(__dirname, '..', 'src', 'main', 'ai-service.js');
  const aiService = require(aiServicePath);

  const rewritten = aiService.rewriteActionsForReliability([
    { type: 'run_command', command: 'Start-Process "tradeing view"', shell: 'powershell' }
  ], {
    userMessage: 'open tradeing view'
  });

  assert(Array.isArray(rewritten), 'rewriteActionsForReliability should return an action array');
  const typedAction = rewritten.find((action) => action?.type === 'type');
  const launchAction = rewritten.find((action) => action?.type === 'key' && action?.key === 'enter');

  assert(typedAction, 'Normalized app launch should include a Start menu search action');
  assertEqual(typedAction.text, 'TradingView', 'Typoed app launch should normalize to TradingView');
  assert(launchAction?.verifyTarget, 'Normalized app launch should include verifyTarget metadata');
  assertEqual(launchAction.verifyTarget.appName, 'TradingView', 'verifyTarget should use the canonical app name');
  assert(launchAction.verifyTarget.processNames.includes('tradingview'), 'verifyTarget should include canonical TradingView process hints');
  assert(launchAction.verifyTarget.dialogTitleHints.includes('Create Alert'), 'verifyTarget should include TradingView dialog title hints');
  assert(launchAction.verifyTarget.chartKeywords.includes('timeframe'), 'verifyTarget should include TradingView chart-state keywords');
  assert(launchAction.verifyTarget.pineKeywords.includes('pine editor'), 'verifyTarget should include TradingView Pine Editor keywords');
  assert(launchAction.verifyTarget.domKeywords.includes('depth of market'), 'verifyTarget should include TradingView DOM keywords');
});

test('rewriteActionsForReliability uses registry rewrites by default while preserving legacy parity', () => {
  const aiServicePath = path.join(__dirname, '..', 'src', 'main', 'ai-service.js');
  const aiService = require(aiServicePath);
  const previousFlag = process.env.LIKU_USE_TOOL_REGISTRY_REWRITES;

  const tradingViewActions = [
    { type: 'key', key: 'ctrl+e' },
    { type: 'type', text: 'plot(close)' }
  ];
  const tradingViewContext = {
    userMessage: 'open pine editor in tradingview and type plot(close)'
  };

  const browserActions = [
    { type: 'focus_window', windowHandle: 264274 },
    { type: 'wait', ms: 1000 },
    { type: 'screenshot' }
  ];
  const browserContext = {
    userMessage: 'I have tradingview open in the background, what do you think?'
  };

  try {
    process.env.LIKU_USE_TOOL_REGISTRY_REWRITES = '0';
    const legacyTradingViewRewrite = aiService.rewriteActionsForReliability(tradingViewActions, tradingViewContext);
    const legacyNonTradingViewRewrite = aiService.rewriteActionsForReliability(browserActions, browserContext);

    delete process.env.LIKU_USE_TOOL_REGISTRY_REWRITES;
    const defaultTradingViewRewrite = aiService.rewriteActionsForReliability(tradingViewActions, tradingViewContext);
    const defaultNonTradingViewRewrite = aiService.rewriteActionsForReliability(browserActions, browserContext);

    process.env.LIKU_USE_TOOL_REGISTRY_REWRITES = '1';
    const registryTradingViewRewrite = aiService.rewriteActionsForReliability(tradingViewActions, tradingViewContext);
    const registryNonTradingViewRewrite = aiService.rewriteActionsForReliability(browserActions, browserContext);

    assertDeepEqual(defaultTradingViewRewrite, registryTradingViewRewrite, 'Default rewrite path should use registered tool rewrites');
    assertDeepEqual(defaultNonTradingViewRewrite, registryNonTradingViewRewrite, 'Default rewrite path should preserve non-TradingView registry behavior');
    assertDeepEqual(registryTradingViewRewrite, legacyTradingViewRewrite, 'TradingView rewrite registry path should stay byte-identical to legacy TradingView rewrite behavior');
    assertDeepEqual(registryNonTradingViewRewrite, legacyNonTradingViewRewrite, 'Registry default should not change non-TradingView rewrite behavior');
  } finally {
    if (previousFlag === undefined) {
      delete process.env.LIKU_USE_TOOL_REGISTRY_REWRITES;
    } else {
      process.env.LIKU_USE_TOOL_REGISTRY_REWRITES = previousFlag;
    }
  }
});

test('analyzeActionSafety uses registry risks by default while preserving parity fixtures', () => {
  const aiServicePath = path.join(__dirname, '..', 'src', 'main', 'ai-service.js');
  const aiService = require(aiServicePath);
  const previousFlag = process.env.LIKU_USE_TOOL_REGISTRY_RISKS;

  const tradingViewAction = {
    type: 'key',
    key: 'enter',
    reason: 'Place a buy market order in the TradingView DOM'
  };
  const tradingViewTarget = {
    thought: 'Place a buy market order in the TradingView DOM',
    userMessage: 'place a buy market order in the tradingview dom now'
  };

  const nonTradingViewAction = {
    type: 'run_command',
    command: 'Get-Process | Select-Object -First 1',
    shell: 'powershell'
  };
  const nonTradingViewTarget = {
    thought: 'Inspect the current process list',
    userMessage: 'inspect the current process list'
  };

  try {
    process.env.LIKU_USE_TOOL_REGISTRY_RISKS = '0';
    const legacyTradingViewRisk = aiService.analyzeActionSafety(tradingViewAction, tradingViewTarget);
    const legacyNonTradingViewRisk = aiService.analyzeActionSafety(nonTradingViewAction, nonTradingViewTarget);

    delete process.env.LIKU_USE_TOOL_REGISTRY_RISKS;
    const defaultTradingViewRisk = aiService.analyzeActionSafety(tradingViewAction, tradingViewTarget);
    const defaultNonTradingViewRisk = aiService.analyzeActionSafety(nonTradingViewAction, nonTradingViewTarget);

    process.env.LIKU_USE_TOOL_REGISTRY_RISKS = '1';
    const registryTradingViewRisk = aiService.analyzeActionSafety(tradingViewAction, tradingViewTarget);
    const registryNonTradingViewRisk = aiService.analyzeActionSafety(nonTradingViewAction, nonTradingViewTarget);

    assertDeepEqual(
      normalizeSafetyResultForComparison(defaultTradingViewRisk),
      normalizeSafetyResultForComparison(registryTradingViewRisk),
      'Default risk path should use registered risk assessors'
    );
    assertDeepEqual(
      normalizeSafetyResultForComparison(defaultNonTradingViewRisk),
      normalizeSafetyResultForComparison(registryNonTradingViewRisk),
      'Default risk path should preserve non-TradingView registry behavior'
    );
    assertDeepEqual(
      normalizeSafetyResultForComparison(registryTradingViewRisk),
      normalizeSafetyResultForComparison(legacyTradingViewRisk),
      'TradingView risk registry path should stay behavior-identical to legacy TradingView risk behavior'
    );
    assertDeepEqual(
      normalizeSafetyResultForComparison(registryNonTradingViewRisk),
      normalizeSafetyResultForComparison(legacyNonTradingViewRisk),
      'Risk registry flag should not change non-TradingView safety behavior'
    );
  } finally {
    if (previousFlag === undefined) {
      delete process.env.LIKU_USE_TOOL_REGISTRY_RISKS;
    } else {
      process.env.LIKU_USE_TOOL_REGISTRY_RISKS = previousFlag;
    }
  }
});

test('tool registry risk path scopes bare order danger keywords away from non-TradingView plans', () => {
  const aiServicePath = path.join(__dirname, '..', 'src', 'main', 'ai-service.js');
  const aiService = require(aiServicePath);
  const previousFlag = process.env.LIKU_USE_TOOL_REGISTRY_RISKS;

  const action = {
    type: 'type',
    text: 'Monthly order summary',
    reason: 'Create a budget spreadsheet order summary'
  };
  const targetInfo = {
    thought: 'Create a budget spreadsheet order summary',
    userMessage: 'create a budget spreadsheet order summary in excel'
  };

  try {
    process.env.LIKU_USE_TOOL_REGISTRY_RISKS = '0';
    const legacyRisk = aiService.analyzeActionSafety(action, targetInfo);

    delete process.env.LIKU_USE_TOOL_REGISTRY_RISKS;
    const defaultRisk = aiService.analyzeActionSafety(action, targetInfo);

    process.env.LIKU_USE_TOOL_REGISTRY_RISKS = '1';
    const scopedRisk = aiService.analyzeActionSafety(action, targetInfo);

    assertEqual(legacyRisk.riskLevel, 'HIGH', 'Legacy danger patterns should still treat bare order language as high-risk');
    assertDeepEqual(normalizeSafetyResultForComparison(defaultRisk), normalizeSafetyResultForComparison(scopedRisk), 'Default risk path should use scoped registry danger patterns');
    assert(scopedRisk.riskLevel === 'MEDIUM' || scopedRisk.riskLevel === 'LOW', 'Scoped danger patterns should avoid escalating non-TradingView order-summary language');
    assertEqual(scopedRisk.requiresConfirmation, false, 'Scoped danger patterns should not require confirmation for non-TradingView order-summary language');
    assert(!scopedRisk.warnings.some((warning) => /order/i.test(String(warning || ''))), 'Scoped danger patterns should suppress bare order warnings outside TradingView context');
  } finally {
    if (previousFlag === undefined) {
      delete process.env.LIKU_USE_TOOL_REGISTRY_RISKS;
    } else {
      process.env.LIKU_USE_TOOL_REGISTRY_RISKS = previousFlag;
    }
  }
});

test('pine workflow encodes diagnostics and compile-result evidence modes', () => {
  const pineWorkflowPath = path.join(__dirname, '..', 'src', 'main', 'tradingview', 'pine-workflows.js');
  const shortcutProfilePath = path.join(__dirname, '..', 'src', 'main', 'tradingview', 'shortcut-profile.js');
  const fs = require('fs');

  const pineWorkflowContent = fs.readFileSync(pineWorkflowPath, 'utf8');
  const shortcutProfileContent = fs.readFileSync(shortcutProfilePath, 'utf8');

  assert(pineWorkflowContent.includes('function inferPineEditorEvidenceMode'), 'Pine workflows should classify Pine Editor evidence modes');
  assert(pineWorkflowContent.includes("return 'compile-result'"), 'Pine workflows should support compile-result evidence mode');
  assert(pineWorkflowContent.includes("return 'diagnostics'"), 'Pine workflows should support diagnostics evidence mode');
  assert(pineWorkflowContent.includes('pineEvidenceMode'), 'Pine get_text steps should preserve evidence mode metadata');
  assert(pineWorkflowContent.includes('compile-result text for a bounded diagnostics summary'), 'Pine workflows should use compile-result-specific readback wording');
  assert(pineWorkflowContent.includes('diagnostics and warnings text'), 'Pine workflows should use diagnostics-specific readback wording');
  assert(pineWorkflowContent.includes('provenance-summary'), 'Pine workflows should support version-history provenance-summary evidence mode');
  assert(pineWorkflowContent.includes('top visible Pine Version History revision metadata'), 'Pine workflows should use provenance-summary-specific readback wording');
  assert(pineWorkflowContent.includes('pineSummaryFields'), 'Pine workflows should carry explicit structured summary fields for provenance summaries');
  assert(pineWorkflowContent.includes('buildTradingViewPineResumePrerequisites'), 'Pine workflows should expose resume prerequisite shaping for confirmation-resume flows');
  assert(pineWorkflowContent.includes('Re-open or re-activate TradingView Pine Editor after confirmation'), 'Pine resume prerequisite shaping should re-establish editor activation after confirmation');
  assert(shortcutProfileContent.includes("'indicator-search'"), 'TradingView shortcut profile should define stable indicator search guidance');
  assert(shortcutProfileContent.includes("'create-alert'"), 'TradingView shortcut profile should define stable alert guidance');
  assert(shortcutProfileContent.includes("'drawing-tool-binding'"), 'TradingView shortcut profile should mark drawing bindings as customizable');
  assert(shortcutProfileContent.includes("'open-dom-panel'"), 'TradingView shortcut profile should classify DOM shortcuts explicitly');
  assert(shortcutProfileContent.includes('Ctrl+E opens the Pine Script editor when focus is on a TradingView chart'), 'TradingView shortcut profile should ground Pine Editor opening in chart-scoped Ctrl+E behavior');
  assert(shortcutProfileContent.includes('fall back to quick search when chart focus is not established'), 'TradingView shortcut profile should retain quick-search fallback when chart focus is not established');
  assert(shortcutProfileContent.includes('buildTradingViewShortcutRoute'), 'TradingView shortcut profile should expose TradingView-specific route helpers for non-native shortcuts');
  assert(shortcutProfileContent.includes("'take-snapshot'"), 'TradingView shortcut profile should include grounded reference-only snapshot guidance');
  assert(shortcutProfileContent.includes("'add-symbol-to-watchlist'"), 'TradingView shortcut profile should include grounded watchlist shortcut guidance');
  assert(shortcutProfileContent.includes('TRADINGVIEW_SHORTCUTS_OFFICIAL_URL'), 'TradingView shortcut profile should record the official support reference');
  assert(shortcutProfileContent.includes('TRADINGVIEW_SHORTCUTS_SECONDARY_URL'), 'TradingView shortcut profile should record the secondary Pineify reference');
  assert(shortcutProfileContent.includes('resolveTradingViewShortcutId'), 'TradingView shortcut profile should support alias-to-shortcut resolution');
  assert(shortcutProfileContent.includes('getTradingViewShortcutMatchTerms'), 'TradingView shortcut profile should expose reusable shortcut match terms');
  assert(shortcutProfileContent.includes('messageMentionsTradingViewShortcut'), 'TradingView shortcut profile should expose reusable shortcut phrase matching');
});

test('system prompt includes Pine diagnostics guidance', () => {
  const systemPromptPath = path.join(__dirname, '..', 'src', 'main', 'ai-service', 'system-prompt.js');
  const fs = require('fs');

  const systemPromptContent = fs.readFileSync(systemPromptPath, 'utf8');

  assert(systemPromptContent.includes('TradingView Pine diagnostics rule'), 'System prompt should include Pine diagnostics guidance');
  assert(systemPromptContent.includes('visible revision/provenance details'), 'System prompt should steer Pine provenance requests toward verified Version History text');
  assert(systemPromptContent.includes('treat visible Pine Version History entries as bounded audit/provenance evidence only'), 'Pine provenance guidance should prevent overclaiming from visible revision history');
  assert(systemPromptContent.includes('latest visible revision label'), 'Pine provenance guidance should mention structured visible revision fields');
  assert(systemPromptContent.includes('compile success'), 'System prompt should mention compile success bounds');
  assert(systemPromptContent.includes('realtime rollback'), 'System prompt should mention Pine execution-model caveats');
  assert(systemPromptContent.includes('TradingView drawing capability rule'), 'System prompt should include TradingView drawing honesty guidance');
  assert(systemPromptContent.includes('TradingView shortcut profile rule'), 'System prompt should include TradingView shortcut-profile guidance');
  assert(systemPromptContent.includes('TradingView Pine opener rule'), 'System prompt should include explicit Pine opener policy guidance');
  assert(systemPromptContent.includes('chart-focused official Pine opener first'), 'System prompt should prefer the direct Pine opener when chart focus is established');
  assert(systemPromptContent.includes('verified TradingView command quick-search'), 'System prompt should retain the quick-search fallback when direct Pine focus is not proven');
});

test('reflection trigger builds provider-compatible chat messages', () => {
  const reflectionTriggerPath = path.join(__dirname, '..', 'src', 'main', 'telemetry', 'reflection-trigger.js');
  const reflectionTrigger = require(reflectionTriggerPath);

  assert(typeof reflectionTrigger.buildReflectionMessages === 'function', 'Reflection trigger should expose chat-message builder');
  const messages = reflectionTrigger.buildReflectionMessages([
    {
      task: 'Open TradingView alert dialog',
      phase: 'execution',
      actions: [{ type: 'key', key: 'alt+a' }],
      verifier: { exitCode: 1, stderr: 'dialog not observed' },
      context: { failedCount: 1 }
    }
  ]);

  assert(Array.isArray(messages), 'Reflection trigger should return a message array');
  assertEqual(messages[0].role, 'system', 'Reflection messages should begin with a system instruction');
  assertEqual(messages[1].role, 'user', 'Reflection messages should include a user payload for providers that reject system-only chat requests');
  assert(/Open TradingView alert dialog/i.test(messages[1].content), 'Reflection user payload should contain summarized failure context');
});

test('rewriteActionsForReliability does not reinterpret passive TradingView open-state prompts as app launches', () => {
  const aiServicePath = path.join(__dirname, '..', 'src', 'main', 'ai-service.js');
  const aiService = require(aiServicePath);

  const original = [
    { type: 'focus_window', windowHandle: 264274 },
    { type: 'wait', ms: 1000 },
    { type: 'screenshot' }
  ];

  const rewritten = aiService.rewriteActionsForReliability(original, {
    userMessage: 'I have tradingview open in the background, what do you think?'
  });

  assertDeepEqual(rewritten, original, 'Passive open-state phrasing should preserve a concrete TradingView observation plan');
});

test('ai-service normalizes app identity for learned skill scope', () => {
  const aiServicePath = path.join(__dirname, '..', 'src', 'main', 'ai-service.js');
  const tradingViewToolPath = path.join(__dirname, '..', 'src', 'main', 'tools', 'tradingview-tool.js');
  const appProfilePath = path.join(__dirname, '..', 'src', 'main', 'tradingview', 'app-profile.js');
  const fs = require('fs');

  const aiServiceContent = fs.readFileSync(aiServicePath, 'utf8');
  const tradingViewToolContent = fs.readFileSync(tradingViewToolPath, 'utf8');
  const appProfileContent = fs.readFileSync(appProfilePath, 'utf8');

  assert(aiServiceContent.includes("require('./tools/tradingview-tool')"), 'ai-service should consume the TradingView facade module');
  assert(tradingViewToolContent.includes("require('../tradingview/app-profile')"), 'TradingView facade should consume the extracted app profile module');
  assert(appProfileContent.includes('resolveNormalizedAppIdentity('), 'app profile module should define normalized app identity resolution');
  assert(appProfileContent.includes("'tradeing view'"), 'app profile module should recognize the TradingView typo alias');
  assert(aiServiceContent.includes('normalizedSkillApp?.processNames'), 'Learned skill scope should include normalized process names');
  assert(aiServiceContent.includes('normalizedSkillApp?.titleHints'), 'Learned skill scope should include normalized title hints');
  assert(appProfileContent.includes('dialogTitleHints'), 'TradingView app profile should include dialog title hints');
  assert(appProfileContent.includes('chartKeywords'), 'TradingView app profile should include chart-state keywords');
  assert(appProfileContent.includes('drawingKeywords'), 'TradingView app profile should include drawing-tool keywords');
  assert(appProfileContent.includes('pineKeywords'), 'TradingView app profile should include Pine Editor keywords');
  assert(appProfileContent.includes('domKeywords'), 'TradingView app profile should include DOM keywords');
  assert(appProfileContent.includes('paperKeywords'), 'TradingView app profile should include Paper Trading keywords');
});

test('ai-service gates TradingView follow-up typing on post-key observation checkpoints', () => {
  const aiServicePath = path.join(__dirname, '..', 'src', 'main', 'ai-service.js');
  const observationCheckpointPath = path.join(__dirname, '..', 'src', 'main', 'ai-service', 'observation-checkpoints.js');
  const observationProviderRegistryPath = path.join(__dirname, '..', 'src', 'main', 'ai-service', 'observation-provider-registry.js');
  const lifecycleHooksPath = path.join(__dirname, '..', 'src', 'main', 'ai-service', 'lifecycle-hooks.js');
  const rewriteRegistryPath = path.join(__dirname, '..', 'src', 'main', 'ai-service', 'rewrite-registry.js');
  const riskRegistryPath = path.join(__dirname, '..', 'src', 'main', 'ai-service', 'risk-registry.js');
  const systemContractRegistryPath = path.join(__dirname, '..', 'src', 'main', 'ai-service', 'system-contract-registry.js');
  const tradingViewToolPath = path.join(__dirname, '..', 'src', 'main', 'tools', 'tradingview-tool.js');
  const tradingViewRuntimeRecoveryPath = path.join(__dirname, '..', 'src', 'main', 'tradingview', 'runtime', 'recovery.js');
  const tradingViewRegistryBootstrapPath = path.join(__dirname, '..', 'src', 'main', 'tradingview', 'registry-bootstrap.js');
  const tradingViewRewriteRunnerPath = path.join(__dirname, '..', 'src', 'main', 'tradingview', 'rewrite-runner.js');
  const tradingViewPineAuthoringPath = path.join(__dirname, '..', 'src', 'main', 'tradingview', 'pine-authoring.js');
  const tradingViewPineResumePath = path.join(__dirname, '..', 'src', 'main', 'tradingview', 'pine-resume.js');
  const tradingViewPineRecoveryPath = path.join(__dirname, '..', 'src', 'main', 'tradingview', 'pine-recovery.js');
  const tradingViewVerificationPath = path.join(__dirname, '..', 'src', 'main', 'tradingview', 'verification.js');
  const tradingViewIndicatorPath = path.join(__dirname, '..', 'src', 'main', 'tradingview', 'indicator-workflows.js');
  const tradingViewAlertPath = path.join(__dirname, '..', 'src', 'main', 'tradingview', 'alert-workflows.js');
  const tradingViewChartPath = path.join(__dirname, '..', 'src', 'main', 'tradingview', 'chart-verification.js');
  const tradingViewDrawingPath = path.join(__dirname, '..', 'src', 'main', 'tradingview', 'drawing-workflows.js');
  const tradingViewPinePath = path.join(__dirname, '..', 'src', 'main', 'tradingview', 'pine-workflows.js');
  const tradingViewPaperPath = path.join(__dirname, '..', 'src', 'main', 'tradingview', 'paper-workflows.js');
  const tradingViewDomPath = path.join(__dirname, '..', 'src', 'main', 'tradingview', 'dom-workflows.js');
  const sessionIntentStatePath = path.join(__dirname, '..', 'src', 'main', 'session-intent-state.js');
  const chatContinuityStatePath = path.join(__dirname, '..', 'src', 'main', 'chat-continuity-state.js');
  const systemAutomationPath = path.join(__dirname, '..', 'src', 'main', 'system-automation.js');
  const systemPromptPath = path.join(__dirname, '..', 'src', 'main', 'ai-service', 'system-prompt.js');
  const fs = require('fs');

  const aiServiceContent = fs.readFileSync(aiServicePath, 'utf8');
  const observationCheckpointContent = fs.readFileSync(observationCheckpointPath, 'utf8');
  const observationProviderRegistryContent = fs.readFileSync(observationProviderRegistryPath, 'utf8');
  const lifecycleHooksContent = fs.readFileSync(lifecycleHooksPath, 'utf8');
  const rewriteRegistryContent = fs.readFileSync(rewriteRegistryPath, 'utf8');
  const riskRegistryContent = fs.readFileSync(riskRegistryPath, 'utf8');
  const systemContractRegistryContent = fs.readFileSync(systemContractRegistryPath, 'utf8');
  const tradingViewToolContent = fs.readFileSync(tradingViewToolPath, 'utf8');
  const tradingViewRuntimeRecoveryContent = fs.readFileSync(tradingViewRuntimeRecoveryPath, 'utf8');
  const tradingViewRegistryBootstrapContent = fs.readFileSync(tradingViewRegistryBootstrapPath, 'utf8');
  const tradingViewRewriteRunnerContent = fs.readFileSync(tradingViewRewriteRunnerPath, 'utf8');
  const tradingViewPineAuthoringContent = fs.readFileSync(tradingViewPineAuthoringPath, 'utf8');
  const tradingViewPineResumeContent = fs.readFileSync(tradingViewPineResumePath, 'utf8');
  const tradingViewPineRecoveryContent = fs.readFileSync(tradingViewPineRecoveryPath, 'utf8');
  const tradingViewVerificationContent = fs.readFileSync(tradingViewVerificationPath, 'utf8');
  const tradingViewIndicatorContent = fs.readFileSync(tradingViewIndicatorPath, 'utf8');
  const tradingViewAlertContent = fs.readFileSync(tradingViewAlertPath, 'utf8');
  const tradingViewChartContent = fs.readFileSync(tradingViewChartPath, 'utf8');
  const tradingViewDrawingContent = fs.readFileSync(tradingViewDrawingPath, 'utf8');
  const tradingViewPineContent = fs.readFileSync(tradingViewPinePath, 'utf8');
  const tradingViewPaperContent = fs.readFileSync(tradingViewPaperPath, 'utf8');
  const tradingViewDomContent = fs.readFileSync(tradingViewDomPath, 'utf8');
  const sessionIntentStateContent = fs.readFileSync(sessionIntentStatePath, 'utf8');
  const chatContinuityStateContent = fs.readFileSync(chatContinuityStatePath, 'utf8');
  const systemAutomationContent = fs.readFileSync(systemAutomationPath, 'utf8');
  const systemPromptContent = fs.readFileSync(systemPromptPath, 'utf8');

  assert(aiServiceContent.includes("require('./ai-service/observation-checkpoints')"), 'ai-service should consume the extracted observation checkpoint helper module');
  assert(aiServiceContent.includes("require('./ai-service/observation-provider-registry')"), 'ai-service should consume the observation provider registry module');
  assert(aiServiceContent.includes("require('./ai-service/lifecycle-hooks')"), 'ai-service should consume the lifecycle hook registry module');
  assert(aiServiceContent.includes('registerTradingViewPineLifecycleHooks'), 'ai-service should register TradingView Pine lifecycle hooks through the TradingView facade');
  assert(observationCheckpointContent.includes('inferKeyObservationCheckpoint'), 'Observation checkpoint module should infer TradingView post-key checkpoints');
  assert(observationCheckpointContent.includes('verifyKeyObservationCheckpoint'), 'Observation checkpoint module should verify TradingView post-key checkpoints');
  assert(observationProviderRegistryContent.includes('registerObservationProvider'), 'Observation provider registry should support provider registration');
  assert(observationProviderRegistryContent.includes('getRegisteredObservationProviders'), 'Observation provider registry should expose registered provider metadata');
  assert(lifecycleHooksContent.includes('registerLifecycleHooks'), 'Lifecycle hook registry should support hook registration');
  assert(lifecycleHooksContent.includes('runLifecycleHook'), 'Lifecycle hook registry should support generic hook dispatch');
  assert(aiServiceContent.includes('observationCheckpoints'), 'Execution results should expose key checkpoint metadata');
  assert(observationCheckpointContent.includes('surface change before continuing'), 'Checkpoint failures should explain missing TradingView surface changes');
  assert(observationCheckpointContent.includes('observationProviders'), 'Observation checkpoint module should consume registered observation providers');
  assert(observationCheckpointContent.includes("requireTradingViewProvider('inferObservationSpec')"), 'Observation checkpoint module should consume TradingView observation-spec through a provider');
  assert(observationCheckpointContent.includes("requireTradingViewProvider('inferTradingMode')"), 'Observation checkpoint module should consume TradingView trading-mode inference through a provider');
  assert(aiServiceContent.includes("require('./ai-service/rewrite-registry')"), 'ai-service should consume the internal rewrite registry module');
  assert(aiServiceContent.includes("require('./ai-service/risk-registry')"), 'ai-service should consume the internal risk registry module');
  assert(aiServiceContent.includes("require('./ai-service/system-contract-registry')"), 'ai-service should consume the internal system contract registry module');
  assert(aiServiceContent.includes("require('./tools/tradingview-tool')"), 'ai-service should consume the TradingView facade module');
  assert(aiServiceContent.includes("require('./tradingview/runtime/recovery')"), 'ai-service should consume the extracted TradingView runtime recovery module');
  assert(aiServiceContent.includes("require('./tradingview/registry-bootstrap')"), 'ai-service should consume the extracted TradingView registry bootstrap module');
  assert(aiServiceContent.includes("require('./tradingview/rewrite-runner')"), 'ai-service should consume the extracted TradingView rewrite runner module');
  assert(aiServiceContent.includes("require('./tradingview/pine-authoring')"), 'ai-service should consume the extracted TradingView Pine authoring module');
  assert(aiServiceContent.includes("require('./tradingview/pine-resume')"), 'ai-service should consume the extracted TradingView Pine resume module');
  assert(aiServiceContent.includes("require('./tradingview/pine-recovery')"), 'ai-service should consume the extracted TradingView Pine recovery module');
  assert(aiServiceContent.includes('LIKU_USE_TOOL_REGISTRY_REWRITES'), 'ai-service should retain a rewrite registry escape hatch');
  assert(aiServiceContent.includes('LIKU_USE_TOOL_REGISTRY_RISKS'), 'ai-service should retain a risk registry escape hatch');
  assert(aiServiceContent.includes('isRegistryFeatureDisabled'), 'ai-service should default registry features on unless explicitly disabled');
  assert(rewriteRegistryContent.includes('registerToolRewrites'), 'Rewrite registry module should support tool rewrite registration');
  assert(rewriteRegistryContent.includes('applyRegisteredToolRewrites'), 'Rewrite registry module should support ordered rewrite dispatch');
  assert(riskRegistryContent.includes('registerToolRiskAssessor'), 'Risk registry module should support tool risk registration');
  assert(riskRegistryContent.includes('assessRegisteredToolRisk'), 'Risk registry module should support ordered tool risk dispatch');
  assert(systemContractRegistryContent.includes('registerSystemContractProvider'), 'System contract registry should support tool-scoped contract registration');
  assert(systemContractRegistryContent.includes('buildRegisteredSystemContractMessages'), 'System contract registry should support ordered contract dispatch');
  assert(tradingViewRuntimeRecoveryContent.includes('createTradingViewRuntimeRecovery'), 'TradingView runtime recovery module should expose a factory for executor helpers');
  assert(tradingViewRuntimeRecoveryContent.includes('ensureTradingViewQuickSearchInputClearBeforeTyping'), 'TradingView runtime recovery module should own quick-search preflight proof helpers');
  assert(tradingViewRuntimeRecoveryContent.includes('maybeRecoverTradingViewQuickSearchOpen'), 'TradingView runtime recovery module should own quick-search recovery helpers');
  assert(tradingViewRuntimeRecoveryContent.includes('maybeRecoverTradingViewPineEditorOpen'), 'TradingView runtime recovery module should own Pine Editor recovery helpers');
  assert(tradingViewPineAuthoringContent.includes('createTradingViewPineAuthoringHelpers'), 'TradingView Pine authoring module should expose a helper factory');
  assert(tradingViewPineAuthoringContent.includes('buildTradingViewPineAuthoringSystemContract'), 'TradingView Pine authoring module should own the Pine contract guidance');
  assert(tradingViewPineAuthoringContent.includes('maybeBuildRecoveredTradingViewPineActionResponse'), 'TradingView Pine authoring module should own Pine plan recovery helpers');
  assert(tradingViewPineResumeContent.includes('createTradingViewPineResumeHelpers'), 'TradingView Pine resume module should expose a helper factory');
  assert(tradingViewPineResumeContent.includes('buildPendingTradingViewPineConfirmationState'), 'TradingView Pine resume module should own pending confirmation state shaping');
  assert(tradingViewPineResumeContent.includes('buildTradingViewPineResumeExecutionPlan'), 'TradingView Pine resume module should own resumed action-plan shaping');
  assert(tradingViewPineResumeContent.includes('createTradingViewPineLifecycleHooks'), 'TradingView Pine resume module should expose lifecycle hooks');
  assert(tradingViewPineRecoveryContent.includes('createTradingViewPineRecoveryHelpers'), 'TradingView Pine recovery module should expose a helper factory');
  assert(tradingViewPineRecoveryContent.includes('maybeRecoverTradingViewPinePlanFromGeneratedCode'), 'TradingView Pine recovery module should own canonical-state recovery orchestration');
  assert(tradingViewPineRecoveryContent.includes('requestTradingViewPineCodeOnly'), 'TradingView Pine recovery module should own code-only Pine generation retries');
  assert(tradingViewRegistryBootstrapContent.includes('registerTradingViewRegistryBootstrap'), 'TradingView registry bootstrap module should expose a registration helper');
  assert(tradingViewToolContent.includes('registerTradingViewTool'), 'TradingView facade should expose canonical tool registration');
  assert(tradingViewToolContent.includes('registerToolRewrites(TRADINGVIEW_TOOL_NAME'), 'TradingView facade should register TradingView rewrite handlers');
  assert(tradingViewToolContent.includes('registerToolRiskAssessor(TRADINGVIEW_TOOL_NAME'), 'TradingView facade should register TradingView risk assessors');
  assert(tradingViewToolContent.includes('registerTradingViewSystemContracts'), 'TradingView facade should expose canonical system contract registration');
  assert(tradingViewToolContent.includes('isTradingViewPineContextEligible'), 'TradingView facade should gate Pine system contracts on execution context');
  assert(tradingViewToolContent.includes('registerTradingViewObservationProvider'), 'TradingView facade should expose canonical observation provider registration');
  assert(tradingViewToolContent.includes('registerTradingViewPineLifecycleHooks'), 'TradingView facade should expose canonical Pine lifecycle hook registration');
  assert(!aiServiceContent.includes('const tradingViewPineContract = buildTradingViewPineAuthoringSystemContract(enhancedMessage)'), 'ai-service should not inject Pine contracts directly before execution context is available');
  assert(tradingViewRegistryBootstrapContent.includes('registerTradingViewTool(deps)'), 'TradingView registry bootstrap should delegate to the facade registration helper');
  assert(tradingViewRewriteRunnerContent.includes('applyTradingViewReliabilityRewrites'), 'TradingView rewrite runner module should expose the ordered TradingView rewrite pipeline');
  assert(tradingViewToolContent.includes('maybeRewriteTradingViewPineWorkflow'), 'TradingView facade rewrite pipeline should preserve Pine rewrite participation');
  assert(tradingViewToolContent.includes('maybeRewriteTradingViewAlertWorkflow'), 'TradingView facade rewrite pipeline should preserve alert rewrite participation');
  assert(tradingViewToolContent.includes("require('../tradingview/indicator-workflows')"), 'TradingView facade should consume the extracted TradingView indicator workflow helper');
  assert(tradingViewToolContent.includes("require('../tradingview/alert-workflows')"), 'TradingView facade should consume the extracted TradingView alert workflow helper');
  assert(tradingViewToolContent.includes("require('../tradingview/chart-verification')"), 'TradingView facade should consume the extracted TradingView chart verification helper');
  assert(tradingViewToolContent.includes("require('../tradingview/drawing-workflows')"), 'TradingView facade should consume the extracted TradingView drawing workflow helper');
  assert(tradingViewToolContent.includes("require('../tradingview/pine-workflows')"), 'TradingView facade should consume the extracted TradingView Pine workflow helper');
  assert(tradingViewToolContent.includes("require('../tradingview/paper-workflows')"), 'TradingView facade should consume the extracted TradingView Paper Trading workflow helper');
  assert(tradingViewToolContent.includes("require('../tradingview/dom-workflows')"), 'TradingView facade should consume the extracted TradingView DOM workflow helper');
  assert(tradingViewVerificationContent.includes("classification === 'panel-open'"), 'TradingView checkpoints should recognize panel-open flows such as Pine or DOM');
  assert(observationCheckpointContent.includes("kind === 'editor-active' || kind === 'editor-ready'"), 'Observation checkpoint module should recognize editor-active/editor-ready verification kinds');
  assert(observationCheckpointContent.includes("classification === 'editor-active'"), 'Observation checkpoint module should preserve editor-active classification');
  assert(tradingViewPineContent.includes('safe-new-script'), 'pine workflow should classify safe new-script authoring mode');
  assert(tradingViewPineContent.includes('safe-authoring-inspect'), 'pine workflow should inspect visible Pine Editor state before safe authoring');
  assert(systemPromptContent.includes('safe new-script / bounded-edit paths'), 'system prompt should guide Pine authoring toward safe new-script flows');
  assert(observationCheckpointContent.includes('active Pine Editor surface before continuing'), 'Observation checkpoint failures should explain missing active Pine Editor state');
  assert(tradingViewPineContent.includes('requiresEditorActivation'), 'TradingView Pine workflows should distinguish editor activation from generic panel visibility');
  assert(tradingViewPineContent.includes("messageMentionsTradingViewShortcut(raw, 'open-pine-editor')"), 'TradingView Pine workflows should use shortcut-profile aliases for Pine Editor phrasing');
  assert(tradingViewPineContent.includes('getPineSurfaceMatchTerms'), 'TradingView Pine workflows should expose alias-aware Pine surface match terms');
  assert(tradingViewVerificationContent.includes('pine editor'), 'TradingView checkpoints should ground Pine Editor workflows');
  assert(tradingViewVerificationContent.includes('depth of market'), 'TradingView checkpoints should ground DOM workflows');
  assert(tradingViewVerificationContent.includes('paper trading'), 'TradingView checkpoints should ground Paper Trading workflows');
  assert(tradingViewVerificationContent.includes('function inferTradingViewTradingMode'), 'TradingView verification should expose paper/live/unknown mode inference');
  assert(tradingViewVerificationContent.includes('Paper Trading was detected'), 'TradingView refusal messaging should mention Paper Trading guidance when relevant');
  assert(tradingViewIndicatorContent.includes("getTradingViewShortcutKey('indicator-search')"), 'TradingView indicator workflows should resolve indicator search key via the TradingView shortcut profile');
  assert(tradingViewIndicatorContent.includes("messageMentionsTradingViewShortcut(raw, 'indicator-search')"), 'TradingView indicator workflows should use shortcut-profile aliases for indicator-search phrasing');
  assert(tradingViewIndicatorContent.includes('indicator-present'), 'TradingView indicator workflows should encode indicator-present verification metadata');
  assert(tradingViewAlertContent.includes("getTradingViewShortcutKey('create-alert')"), 'TradingView alert workflows should resolve Create Alert keys via the TradingView shortcut profile');
  assert(tradingViewAlertContent.includes("messageMentionsTradingViewShortcut(raw, 'create-alert')"), 'TradingView alert workflows should use shortcut-profile aliases for create-alert phrasing');
  assert(tradingViewAlertContent.includes('create-alert'), 'TradingView alert workflows should encode create-alert verification metadata');
  assert(tradingViewChartContent.includes("kind: 'timeframe-updated'"), 'TradingView chart verification workflows should encode timeframe-updated verification metadata');
  assert(tradingViewChartContent.includes("kind: 'symbol-updated'"), 'TradingView chart verification workflows should encode symbol-updated verification metadata');
  assert(tradingViewChartContent.includes("kind: 'watchlist-updated'"), 'TradingView chart verification workflows should encode watchlist-updated verification metadata');
  assert(tradingViewChartContent.includes("messageMentionsTradingViewShortcut(raw, 'symbol-search')"), 'TradingView chart verification should use shortcut-profile aliases for symbol-surface phrasing');
  assert(tradingViewChartContent.includes("matchesTradingViewShortcutAction(action, 'symbol-search')"), 'TradingView chart verification should recognize existing symbol-search shortcut plans');
  assert(tradingViewChartContent.includes("key: 'enter'"), 'TradingView chart verification workflows should confirm timeframe changes with enter');
  assert(tradingViewDrawingContent.includes("target: 'object-tree'"), 'TradingView drawing workflows should encode object-tree verification metadata');
  assert(tradingViewDrawingContent.includes("messageMentionsTradingViewShortcut(raw, 'open-object-tree')"), 'TradingView drawing workflows should use shortcut-profile aliases for object-tree surface phrasing');
  assert(tradingViewDrawingContent.includes("matchesTradingViewShortcutAction(openerAction?.action, 'open-object-tree')"), 'TradingView drawing workflows should prioritize known object-tree shortcut openers');
  assert(tradingViewDrawingContent.includes("kind: intent.verifyKind"), 'TradingView drawing workflows should preserve verification-first surface contracts');
  assert(tradingViewPineContent.includes("target: 'pine-editor'"), 'TradingView Pine workflows should encode pine-editor verification metadata');
  assert(tradingViewPineContent.includes("target: 'pine-profiler'"), 'TradingView Pine workflows should encode pine-profiler verification metadata');
  assert(tradingViewPineContent.includes("target: 'pine-version-history'"), 'TradingView Pine workflows should encode pine-version-history verification metadata');
  assert(tradingViewPineContent.includes('requiresObservedChange'), 'TradingView Pine workflows should gate follow-up typing on observed panel changes');
  assert(tradingViewPineContent.includes("type: 'get_text'"), 'TradingView Pine workflows should support bounded Pine Logs readback');
  assert(tradingViewPineContent.includes("text: 'Pine Profiler'"), 'TradingView Pine workflows should support bounded Pine Profiler readback');
  assert(tradingViewPineContent.includes("text: 'Pine Version History'"), 'TradingView Pine workflows should support bounded Pine Version History readback');
  assert(tradingViewPineContent.includes("text: 'Pine Editor'"), 'TradingView Pine workflows should support bounded Pine Editor status/output readback');
  assert(tradingViewPineContent.includes('wantsEvidenceReadback'), 'TradingView Pine workflows should detect Pine evidence-gathering requests');
  assert(systemAutomationContent.includes('buildPineEditorSafeAuthoringSummary'), 'system-automation should structure Pine Editor safe-authoring inspection summaries');
  assert(systemAutomationContent.includes('buildPineEditorDiagnosticsStructuredSummary'), 'system-automation should structure Pine Editor diagnostics summaries');
  assert(systemAutomationContent.includes("pineEvidenceMode === 'safe-authoring-inspect'"), 'system-automation should attach structured Pine summaries for safe-authoring-inspect readbacks');
  assert(systemAutomationContent.includes("getTextAction?.pineEvidenceMode === 'compile-result'"), 'system-automation should structure compile-result Pine Editor reads');
  assert(systemAutomationContent.includes("getTextAction?.pineEvidenceMode === 'diagnostics'"), 'system-automation should structure diagnostics Pine Editor reads');
  assert(systemAutomationContent.includes("getTextAction?.pineEvidenceMode === 'line-budget'"), 'system-automation should structure line-budget Pine Editor reads');
  assert(systemAutomationContent.includes("getTextAction?.pineEvidenceMode === 'generic-status'"), 'system-automation should structure generic-status Pine Editor reads');
  assert(sessionIntentStateContent.includes('pineAuthoringState'), 'session intent continuity context should expose Pine authoring state');
  assert(sessionIntentStateContent.includes('pineCompileStatus'), 'session intent continuity context should expose Pine compile status');
  assert(sessionIntentStateContent.includes('Visible Pine compiler errors are present'), 'session intent continuity should recommend fixing visible compiler errors first');
  assert(sessionIntentStateContent.includes('avoid overwriting it implicitly'), 'session intent continuity should recommend non-destructive Pine next steps when script content is already visible');
  assert(chatContinuityStateContent.includes('normalizePineStructuredSummary'), 'chat continuity mapper should preserve Pine structured summary fields');
  assert(tradingViewPaperContent.includes("target: 'paper-trading-panel'"), 'TradingView Paper workflows should encode paper-trading-panel verification metadata');
  assert(tradingViewPaperContent.includes('paper account'), 'TradingView Paper workflows should ground paper-assist keywords');
  assert(tradingViewDomContent.includes("surfaceTarget: 'dom-panel'"), 'TradingView DOM workflows should encode dom-panel verification metadata');
  assert(tradingViewDomContent.includes('mentionsRiskyTradeAction'), 'TradingView DOM workflows should refuse to rewrite risky trading prompts');
  assert(aiServiceContent.includes('result.tradingMode = tradingDomainRisk.tradingMode'), 'ai-service safety analysis should expose TradingView trading-mode metadata');
});

test('system prompt guides Pine evidence gathering toward get_text over screenshot-only inference', () => {
  const systemPromptPath = path.join(__dirname, '..', 'src', 'main', 'ai-service', 'system-prompt.js');
  const fs = require('fs');
  const content = fs.readFileSync(systemPromptPath, 'utf8');

  assert(content.includes('TradingView Pine evidence rule'), 'System prompt should include explicit TradingView Pine evidence guidance');
  assert(content.includes('Pine Logs / Profiler / Version History text'), 'System prompt should point the model toward Pine text and provenance evidence');
  assert(content.includes('Pine Editor visible status/output'), 'System prompt should mention Pine Editor status/output as bounded evidence');
  assert(content.includes('500 lines'), 'System prompt should mention the Pine 500-line limit');
  assert(content.includes('Do not propose pasting or generating Pine scripts longer than 500 lines'), 'System prompt should teach the Pine line-budget guard explicitly');
  assert(content.includes('get_text'), 'System prompt should mention get_text for Pine evidence gathering');
});

test('TradingView Pine workflows support bounded Pine Editor line-budget readback', () => {
  const tradingViewPinePath = path.join(__dirname, '..', 'src', 'main', 'tradingview', 'pine-workflows.js');
  const fs = require('fs');
  const tradingViewPineContent = fs.readFileSync(tradingViewPinePath, 'utf8');

  assert(tradingViewPineContent.includes("normalized.includes('500 line')"), 'TradingView Pine workflows should recognize 500-line budget hints');
  assert(tradingViewPineContent.includes('line-budget hints'), 'TradingView Pine workflows should support bounded Pine Editor line-budget readback');
});

test('ai-service treats TradingView DOM order-entry actions as high risk', () => {
  const aiServicePath = path.join(__dirname, '..', 'src', 'main', 'ai-service.js');
  const aiService = require(aiServicePath);

  const entryRisk = aiService.analyzeActionSafety(
    { type: 'click', reason: 'Place a limit order in the DOM order book' },
    { text: 'Depth of Market', nearbyText: ['Buy Mkt', 'Sell Mkt', 'Quantity'] }
  );

  assert(entryRisk.requiresConfirmation, 'TradingView DOM order-entry actions should require confirmation');
  assert(entryRisk.riskLevel === aiService.ActionRiskLevel.HIGH || entryRisk.riskLevel === aiService.ActionRiskLevel.CRITICAL, 'TradingView DOM order-entry actions should be high risk or higher');
  assert(entryRisk.warnings.some((warning) => /DOM order-entry/i.test(warning)), 'TradingView DOM order-entry risk should be identified explicitly');
  assert(entryRisk.blockExecution, 'Unknown-mode TradingView DOM order-entry actions should be blocked in advisory-only mode');
  assert(/advisory-only/i.test(entryRisk.blockReason || ''), 'Unknown-mode TradingView DOM order-entry block reason should explain the advisory-only safety rail');
});

test('ai-service treats TradingView DOM flatten or reverse controls as critical', () => {
  const aiServicePath = path.join(__dirname, '..', 'src', 'main', 'ai-service.js');
  const aiService = require(aiServicePath);

  const flattenRisk = aiService.analyzeActionSafety(
    { type: 'click', reason: 'Click Flatten in the DOM trading panel' },
    { text: 'Flatten', nearbyText: ['Depth of Market', 'Reverse', 'CXL ALL'] }
  );

  assertEqual(flattenRisk.riskLevel, aiService.ActionRiskLevel.CRITICAL, 'TradingView DOM flatten/reverse actions should be critical');
  assert(flattenRisk.requiresConfirmation, 'TradingView DOM flatten/reverse actions should require confirmation');
  assert(flattenRisk.warnings.some((warning) => /position\/order-management/i.test(warning)), 'TradingView DOM flatten/reverse risk should be identified explicitly');
  assert(flattenRisk.blockExecution, 'TradingView DOM flatten/reverse actions should be blocked in advisory-only mode');
  assert(/advisory-only/i.test(flattenRisk.blockReason || ''), 'TradingView DOM flatten/reverse block reason should explain the advisory-only safety rail');
});

test('ai-service wires advisory-only DOM blocking into execution paths', () => {
  const aiServicePath = path.join(__dirname, '..', 'src', 'main', 'ai-service.js');
  const fs = require('fs');

  const aiServiceContent = fs.readFileSync(aiServicePath, 'utf8');

  assert(aiServiceContent.includes('if (safety.blockExecution)'), 'Main execution path should block advisory-only DOM actions before execution');
  assert(aiServiceContent.includes('if (resumeSafety.blockExecution)'), 'Resume path should block advisory-only DOM actions before execution');
  assert(aiServiceContent.includes('blockedByPolicy: true'), 'Blocked advisory-only DOM executions should be marked as policy-blocked');
});

test('system-automation uses SendInput for TradingView Alt/Enter and shortcut-route key flows', () => {
  const sysAutoPath = path.join(__dirname, '..', 'src', 'main', 'system-automation.js');
  const systemAutomation = require(sysAutoPath);

  assert(typeof systemAutomation.shouldUseSendInputForKeyCombo === 'function', 'system-automation should expose key-injection selection helper');
  assertEqual(
    systemAutomation.shouldUseSendInputForKeyCombo('alt+a', { verifyTarget: { appName: 'TradingView', processNames: ['tradingview'] } }),
    true,
    'TradingView alert accelerators should use SendInput'
  );
  assertEqual(
    systemAutomation.shouldUseSendInputForKeyCombo('enter', { verifyTarget: { appName: 'TradingView', processNames: ['tradingview'] } }),
    true,
    'TradingView enter confirmations should use SendInput'
  );
  assertEqual(
    systemAutomation.shouldUseSendInputForKeyCombo('ctrl+k', {
      tradingViewShortcut: { id: 'symbol-search', surface: 'quick-search' },
      searchSurfaceContract: { id: 'open-pine-editor', route: 'quick-search' }
    }),
    true,
    'TradingView quick-search route openers should use SendInput'
  );
  assertEqual(
    systemAutomation.shouldUseSendInputForKeyCombo('ctrl+a', {
      tradingViewShortcut: { id: 'open-pine-editor', surface: 'pine-editor' },
      searchSurfaceContract: { id: 'open-pine-editor', route: 'quick-search' }
    }),
    true,
    'TradingView quick-search route clear steps should use SendInput'
  );
  assertEqual(
    systemAutomation.shouldUseSendInputForKeyCombo('ctrl+e', {
      tradingViewShortcut: { id: 'open-pine-editor', surface: 'pine-editor' },
      verifyTarget: { appName: 'TradingView', processNames: ['tradingview'] }
    }),
    false,
    'TradingView Pine Editor direct opener should stay on SendKeys when SendInput is proven inert'
  );
  assertEqual(
    systemAutomation.shouldUseSendInputForKeyCombo('ctrl+l', { verifyTarget: { appName: 'TradingView', processNames: ['tradingview'] } }),
    false,
    'Generic non-shortcut TradingView Ctrl flows should stay on the existing path'
  );
});

test('ai-service treats bounded TradingView quick-search clear steps as benign', () => {
  const aiServicePath = path.join(__dirname, '..', 'src', 'main', 'ai-service.js');
  const aiService = require(aiServicePath);

  assert(typeof aiService.analyzeActionSafety === 'function', 'ai-service should expose analyzeActionSafety');

  const safety = aiService.analyzeActionSafety({
    type: 'key',
    key: 'backspace',
    reason: 'Clear the selected TradingView quick-search text before typing Pine Editor',
    searchSurfaceContract: {
      id: 'open-pine-editor',
      route: 'quick-search',
      surface: 'pine-editor'
    }
  }, {
    userMessage: 'open the pine editor in tradingview'
  });

  assertEqual(safety.riskLevel, aiService.ActionRiskLevel.MEDIUM, 'bounded TradingView quick-search clears should remain medium risk');
  assertEqual(safety.requiresConfirmation, false, 'bounded TradingView quick-search clears should not require confirmation');
  assertEqual(safety.confirmationContext?.appName, 'TradingView', 'bounded TradingView quick-search clears should record the app name');
  assertEqual(safety.confirmationContext?.surface, 'quick-search', 'bounded TradingView quick-search clears should record the concrete surface');
  assert(/quick-search query/i.test(String(safety.confirmationContext?.objectLabel || '')), 'bounded TradingView quick-search clears should record the concrete object label');
  assert(/clear tradingview quick-search query/i.test(String(safety.description || '')), 'bounded TradingView quick-search clears should use object-specific description text');
  assert((safety.warnings || []).some((warning) => /quick-search query/i.test(String(warning || ''))), 'bounded TradingView quick-search clears should preserve an explanatory warning with surface context');
});

test('ai-service keeps run_command risk grounded in the command when Pine prose mentions clear', () => {
  const aiServicePath = path.join(__dirname, '..', 'src', 'main', 'ai-service.js');
  const aiService = require(aiServicePath);

  const pineClearProse = 'Open Pine Editor in TradingView and clear the selected quick-search text before typing Pine Editor';
  const benign = aiService.analyzeActionSafety({
    type: 'run_command',
    command: 'cd c:\\dev\\muse-ai && dir',
    reason: 'Inspect the workspace contents'
  }, {
    userMessage: pineClearProse
  });

  assertEqual(benign.riskLevel, aiService.ActionRiskLevel.LOW, 'benign read-only run_command actions should stay low-risk even when Pine prose mentions clear');
  assertEqual(benign.requiresConfirmation, false, 'benign run_command actions should not require confirmation due to unrelated Pine clear prose');
  assertEqual(benign.confirmationContext?.repoPath, 'c:\\dev\\muse-ai', 'benign run_command actions should still infer repo context for explanation');
  assert(/repo c:\\dev\\muse-ai/i.test(String(benign.description || '')), 'benign run_command descriptions should name the concrete repo context');
  assert(!(benign.warnings || []).some((warning) => /Detected risky keyword: clear/i.test(String(warning || ''))), 'benign run_command actions should not inherit clear warnings from unrelated user prose');
  assert((benign.warnings || []).some((warning) => /read-only inspection command/i.test(String(warning || ''))), 'benign read-only run_command actions should explain why they were downgraded');

  const destructive = aiService.analyzeActionSafety({
    type: 'run_command',
    command: 'Remove-Item -Recurse -Force .\\tmp',
    reason: 'Delete temporary files'
  }, {
    userMessage: pineClearProse,
    cwd: 'c:\\dev\\muse-ai'
  });

  assertEqual(destructive.riskLevel, aiService.ActionRiskLevel.CRITICAL, 'destructive commands should still escalate based on the command itself');
  assertEqual(destructive.requiresConfirmation, true, 'destructive commands should still require confirmation');
  assert((destructive.warnings || []).some((warning) => /Potentially destructive command/i.test(String(warning || ''))), 'destructive commands should preserve the command-grounded warning');
  assert(/run delete command in repo c:\\dev\\muse-ai/i.test(String(destructive.confirmationPrompt || '')), 'destructive command confirmation text should name the concrete repo instead of a bare keyword');
});

test('ai-service classifies common inspection commands as low-risk read-only commands', () => {
  const aiServicePath = path.join(__dirname, '..', 'src', 'main', 'ai-service.js');
  const aiService = require(aiServicePath);

  const readOnly = aiService.analyzeActionSafety({
    type: 'run_command',
    command: 'npm view copilot-liku-cli --json | ConvertFrom-Json | Select-Object -ExpandProperty bin',
    reason: 'Inspect the published npm bin metadata'
  }, {
    userMessage: 'clear out any confusion and inspect the published package metadata only'
  });

  assertEqual(readOnly.riskLevel, aiService.ActionRiskLevel.LOW, 'common inspection commands should downgrade to LOW risk');
  assertEqual(readOnly.requiresConfirmation, false, 'common inspection commands should not require confirmation');
  assert((readOnly.warnings || []).some((warning) => /read-only inspection command/i.test(String(warning || ''))), 'common inspection commands should explain that they are read-only');
  assert(!(readOnly.warnings || []).some((warning) => /detected risky keyword: clear/i.test(String(warning || ''))), 'common inspection commands should ignore unrelated dangerous prose');

  const formatTable = aiService.analyzeActionSafety({
    type: 'run_command',
    command: 'Get-Process | Format-Table Name, CPU',
    reason: 'Inspect running processes in a table'
  }, {
    userMessage: 'format the output for readability only'
  });

  assertEqual(formatTable.riskLevel, aiService.ActionRiskLevel.LOW, 'Format-Table inspection commands should stay low-risk');
  assertEqual(formatTable.requiresConfirmation, false, 'Format-Table inspection commands should not require confirmation');
  assert(!(formatTable.warnings || []).some((warning) => /run delete command|detected risky keyword: format/i.test(String(warning || ''))), 'Format-Table inspection commands should not trip destructive keyword warnings');

  const redirected = aiService.analyzeActionSafety({
    type: 'run_command',
    command: 'git status > status.txt',
    reason: 'Persist git status to a file'
  }, {
    userMessage: 'inspect the repo state'
  });

  assertEqual(redirected.riskLevel, aiService.ActionRiskLevel.MEDIUM, 'redirection should prevent the read-only allowlist from applying');
  assertEqual(redirected.requiresConfirmation, false, 'redirection alone should not escalate to confirmation-required without destructive content');
});

test('pending action storage preserves enriched confirmation context', () => {
  const aiServicePath = path.join(__dirname, '..', 'src', 'main', 'ai-service.js');
  const aiService = require(aiServicePath);

  aiService.clearPendingAction();
  try {
    const safety = aiService.analyzeActionSafety({
      type: 'key',
      key: 'delete',
      reason: 'Clear the Pine Editor buffer before overwriting it'
    }, {
      text: 'Pine Editor',
      userMessage: 'clear the pine editor and replace it with a new script'
    });

    aiService.setPendingAction({
      ...safety,
      actionIndex: 0,
      remainingActions: [{ type: 'key', key: 'delete', reason: 'Clear the Pine Editor buffer before overwriting it' }],
      completedResults: [],
      thought: 'Replace the visible Pine script',
      verification: 'Pine Editor should stay visible after confirmation'
    });

    const pending = aiService.getPendingAction();
    assert(pending, 'pending action should be stored');
    assertDeepEqual(pending.confirmationContext, safety.confirmationContext, 'pending action should preserve the enriched confirmation context');
    assertEqual(pending.description, safety.description, 'pending action should preserve the concrete description');
    assertEqual(pending.confirmationPrompt, safety.confirmationPrompt, 'pending action should preserve the concrete confirmation prompt');
  } finally {
    aiService.clearPendingAction();
  }
});

test('system prompt explains control-surface boundaries honestly', () => {
  const promptPath = path.join(__dirname, '..', 'src', 'main', 'ai-service', 'system-prompt.js');
  const fs = require('fs');

  const promptContent = fs.readFileSync(promptPath, 'utf8');

  assert(promptContent.includes('### Control Surface Honesty Rule (CRITICAL)'), 'System prompt should define a control-surface honesty rule');
  assert(promptContent.includes('direct UIA controls you can target semantically'), 'System prompt should distinguish direct UIA controls');
  assert(promptContent.includes('reliable window or keyboard controls'), 'System prompt should distinguish reliable keyboard/window controls');
  assert(promptContent.includes('visible but screenshot-only controls'), 'System prompt should distinguish screenshot-only visible controls');
  assert(promptContent.includes('prefer \\`find_element\\` or \\`get_text\\` evidence') || promptContent.includes('prefer find_element or get_text evidence'), 'System prompt should prefer semantic reads before denying direct control');
});

test('TradingView shortcut profile and drawing bounds are wired through prompting/workflows', () => {
  const shortcutProfilePath = path.join(__dirname, '..', 'src', 'main', 'tradingview', 'shortcut-profile.js');
  const indicatorWorkflowPath = path.join(__dirname, '..', 'src', 'main', 'tradingview', 'indicator-workflows.js');
  const alertWorkflowPath = path.join(__dirname, '..', 'src', 'main', 'tradingview', 'alert-workflows.js');
  const pineWorkflowPath = path.join(__dirname, '..', 'src', 'main', 'tradingview', 'pine-workflows.js');
  const messageBuilderPath = path.join(__dirname, '..', 'src', 'main', 'ai-service', 'message-builder.js');
  const systemPromptPath = path.join(__dirname, '..', 'src', 'main', 'ai-service', 'system-prompt.js');
  const claimBoundsPath = path.join(__dirname, '..', 'src', 'main', 'claim-bounds.js');
  const searchSurfaceContractsPath = path.join(__dirname, '..', 'src', 'main', 'search-surface-contracts.js');
  const fs = require('fs');

  const shortcutProfileContent = fs.readFileSync(shortcutProfilePath, 'utf8');
  const indicatorWorkflowContent = fs.readFileSync(indicatorWorkflowPath, 'utf8');
  const alertWorkflowContent = fs.readFileSync(alertWorkflowPath, 'utf8');
  const pineWorkflowContent = fs.readFileSync(pineWorkflowPath, 'utf8');
  const messageBuilderContent = fs.readFileSync(messageBuilderPath, 'utf8');
  const systemPromptContent = fs.readFileSync(systemPromptPath, 'utf8');
  const claimBoundsContent = fs.readFileSync(claimBoundsPath, 'utf8');
  const searchSurfaceContractsContent = fs.readFileSync(searchSurfaceContractsPath, 'utf8');

  assert(shortcutProfileContent.includes('stable-default'), 'TradingView shortcut profile should expose stable shortcut metadata');
  assert(shortcutProfileContent.includes('context-dependent'), 'TradingView shortcut profile should expose context-dependent shortcut metadata');
  assert(shortcutProfileContent.includes('customizable'), 'TradingView shortcut profile should expose customizable shortcut classes');
  assert(shortcutProfileContent.includes('paper-test-only'), 'TradingView shortcut profile should expose unsafe trading shortcut classes');
  assert(indicatorWorkflowContent.includes("require('./shortcut-profile')"), 'Indicator workflow should consume TradingView shortcut profile');
  assert(alertWorkflowContent.includes("require('./shortcut-profile')"), 'Alert workflow should consume TradingView shortcut profile');
  assert(pineWorkflowContent.includes("require('./shortcut-profile')"), 'Pine workflow should consume TradingView shortcut profile');
  assert(indicatorWorkflowContent.includes("buildSearchSurfaceSelectionContract"), 'Indicator workflow should consume the shared search-surface selection contract');
  assert(shortcutProfileContent.includes("buildTradingViewShortcutSequenceRoute"), 'Shortcut profile should expose reusable shortcut sequencing for official TradingView routes');
  assert(searchSurfaceContractsContent.includes("type: 'click_element'"), 'Shared search-surface contracts should perform semantic result selection');
  assert(claimBoundsContent.includes('buildProofCarryingAnswerPrompt'), 'Claim-bounds helper should build proof-carrying answer prompts');
  assert(messageBuilderContent.includes('buildClaimBoundConstraint'), 'Message builder should inject the answer claim contract on degraded or low-trust paths');
  assert(messageBuilderContent.includes('## Drawing Capability Bounds'), 'Message builder should inject drawing capability bounds for placement requests');
  assert(messageBuilderContent.includes('inferDrawingRequestKind'), 'Message builder should classify drawing request kinds');
  assert(systemPromptContent.includes('TradingView drawing capability rule'), 'System prompt should include drawing capability honesty guidance');
  assert(systemPromptContent.includes('TradingView shortcut profile rule'), 'System prompt should include TradingView shortcut profile guidance');
});

test('TradingView drawing workflows and safety rails preserve bounded surface-only behavior', () => {
  const drawingWorkflowPath = path.join(__dirname, '..', 'src', 'main', 'tradingview', 'drawing-workflows.js');
  const verificationPath = path.join(__dirname, '..', 'src', 'main', 'tradingview', 'verification.js');
  const aiServicePath = path.join(__dirname, '..', 'src', 'main', 'ai-service.js');
  const fs = require('fs');

  const drawingWorkflowContent = fs.readFileSync(drawingWorkflowPath, 'utf8');
  const verificationContent = fs.readFileSync(verificationPath, 'utf8');
  const aiServiceContent = fs.readFileSync(aiServicePath, 'utf8');

  assert(drawingWorkflowContent.includes('inferTradingViewDrawingRequestKind'), 'Drawing workflows should classify TradingView drawing request kinds explicitly');
  assert(drawingWorkflowContent.includes('surface access only; exact drawing placement remains unverified'), 'Drawing workflows should label bounded surface-only salvage for precise placement requests');
  assert(drawingWorkflowContent.includes("action?.type === 'wait' || action?.type === 'type'"), 'Drawing workflows should drop placement actions while preserving bounded search entry');
  assert(verificationContent.includes('TradingView drawing placement action detected'), 'TradingView verification should recognize precise drawing placement actions');
  assert(verificationContent.includes('exact chart-object placement requires a deterministic verified placement workflow'), 'TradingView verification should explain why precise drawing placement is blocked');
  assert(aiServiceContent.includes('targetInfo.userMessage ||'), 'ai-service safety analysis should include the user message for drawing placement context');
});

test('ai-service app launch detection treats TradingView shortcut surfaces as app surfaces, not app names', () => {
  const aiServicePath = path.join(__dirname, '..', 'src', 'main', 'ai-service.js');
  const fs = require('fs');
  const aiServiceContent = fs.readFileSync(aiServicePath, 'utf8');

  assert(aiServiceContent.includes('quick\\s+search'), 'TradingView quick-search phrasing should be treated as an app surface');
  assert(aiServiceContent.includes('command\\s+palette'), 'TradingView command-palette phrasing should be treated as an app surface');
  assert(aiServiceContent.includes('study\\s+search'), 'TradingView study-search phrasing should be treated as an app surface');
  assert(aiServiceContent.includes('new\\s+alert'), 'TradingView new-alert phrasing should be treated as an app surface');
  assert(aiServiceContent.includes('version\\s+history'), 'TradingView version-history phrasing should be treated as an app surface');
  assert(aiServiceContent.includes('object(?:\\s+|-)tree'), 'TradingView object-tree variants should be treated as an app surface');
});

test('Wave 1 runtime safety rails preserve low-confidence gating, Pine version intent, and nullable UIA bounds', () => {
  const aiServicePath = path.join(__dirname, '..', 'src', 'main', 'ai-service.js');
  const pineStatePath = path.join(__dirname, '..', 'src', 'main', 'tradingview', 'pine-script-state.js');
  const uiaLegacyPath = path.join(__dirname, '..', 'src', 'native', 'windows-uia', 'Program.cs');
  const uiaDotnetPath = path.join(__dirname, '..', 'src', 'native', 'windows-uia-dotnet', 'Program.cs');
  const fs = require('fs');

  const aiService = require(aiServicePath);
  const pineState = require(pineStatePath);
  const aiServiceContent = fs.readFileSync(aiServicePath, 'utf8');
  const uiaLegacyContent = fs.readFileSync(uiaLegacyPath, 'utf8');
  const uiaDotnetContent = fs.readFileSync(uiaDotnetPath, 'utf8');

  const lowConfidenceSafety = aiService.analyzeActionSafety({ type: 'click', x: 10, y: 10 }, {
    userMessage: 'click the dangerous button',
    executionContextEnvelope: { confidence: 'low' }
  });

  assertEqual(lowConfidenceSafety.requiresConfirmation, true, 'Low-confidence mutating actions should require confirmation');
  assertEqual(lowConfidenceSafety.riskLevel, 'HIGH', 'Low-confidence mutating actions should be escalated to high risk');
  assert(lowConfidenceSafety.warnings.some((warning) => warning.includes('Low-confidence execution context')), 'Low-confidence mutating actions should emit a confidence warning');

  const pinePrompt = aiService.buildTradingViewPineCodeGenerationPrompt('write a Pine Script v5 indicator for RSI divergence');
  const normalizedPine = aiService.normalizeGeneratedPineScript({
    pineScript: 'indicator("RSI Divergence")\nplot(close)',
    userMessage: 'write a Pine Script v5 indicator for RSI divergence'
  });
  const pineStateRecord = pineState.buildPineScriptState({
    source: 'indicator("RSI Divergence")\nplot(close)',
    intent: 'write a Pine Script v5 indicator for RSI divergence'
  });

  assert(pinePrompt.includes('//@version=5'), 'Pine generation prompt should preserve requested version intent');
  assert(normalizedPine.startsWith('//@version=5'), 'Generated Pine normalization should preserve requested version intent');
  assertEqual(pineState.detectRequestedPineVersion('write a Pine Script v5 indicator', ''), '5', 'Pine state should detect requested version from intent');
  assertEqual(pineStateRecord.pineVersion, '5', 'Pine state should persist the requested Pine version');
  assertEqual(pineStateRecord.validation.valid, true, 'Pine state validation should accept the requested version header');

  assert(aiServiceContent.includes('plan:policy-check'), 'ai-service should record policy prelude trace events');
  assert(aiServiceContent.includes('Low-confidence execution context'), 'ai-service should expose low-confidence confirmation messaging');
  assert(uiaDotnetContent.includes('Dictionary<string, double?>'), '.NET UIA host should serialize bounds as nullable doubles');
  assert(uiaDotnetContent.includes('public double? x'), '.NET UIA bounds should be nullable');
  assert(uiaLegacyContent.includes('static double? SafeNumber'), 'Legacy UIA host should return nullable safe numbers');
  assert(uiaLegacyContent.includes('public double? x'), 'Legacy UIA bounds should be nullable');
});

// Test DANGEROUS_COMMAND_PATTERNS covers critical cases
test('Dangerous command patterns are comprehensive', () => {
  const sysAutoPath = path.join(__dirname, '..', 'src', 'main', 'system-automation.js');
  const { DANGEROUS_COMMAND_PATTERNS, isCommandDangerous } = require(sysAutoPath);
  
  // Should flag these
  const mustBeDangerous = [
    'rm -rf /home/user',
    'del /q /s C:\\Windows',
    'format C:',            // Format a drive
    'format D:',            // Format another drive
    'Remove-Item -Recurse -Force folder',
    'shutdown /r',
    'reg delete HKLM\\SOFTWARE',
  ];
  
  for (const cmd of mustBeDangerous) {
    assert(isCommandDangerous(cmd), `Should flag "${cmd}" as dangerous`);
  }
  
  // Should NOT flag these (including Format-Table false positive fix)
  const mustBeSafe = [
    'Get-Process',
    'dir /b',
    'echo hello',
    'cat myfile.txt',
    'ls -la',
    'Get-ChildItem',
    'npm install',
    'node script.js',
    'Get-ChildItem | Format-Table',         // PowerShell Format-Table cmdlet (NOT dangerous!)
    'Get-Process | Format-Table Name, CPU', // Another Format-Table use case
  ];
  
  for (const cmd of mustBeSafe) {
    assert(!isCommandDangerous(cmd), `Should NOT flag "${cmd}" as dangerous`);
  }
});

// Print summary
console.log('\n========================================');
console.log('  Bug Fix Test Summary');
console.log('========================================');
console.log(`  Total:  ${results.passed + results.failed}`);
console.log(`  Passed: ${results.passed}`);
console.log(`  Failed: ${results.failed}`);
console.log('========================================\n');

// Return exit code
process.exit(results.failed > 0 ? 1 : 0);
