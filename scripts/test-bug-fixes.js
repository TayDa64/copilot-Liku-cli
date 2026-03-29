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
  const fs = require('fs');

  const messageBuilderContent = fs.readFileSync(messageBuilderPath, 'utf8');

  assert(messageBuilderContent.includes('classifyActiveAppCapability'), 'Message builder should classify active app capability');
  assert(messageBuilderContent.includes('## Active App Capability'), 'Message builder should inject active app capability context');
  assert(messageBuilderContent.includes('visual-first-low-uia'), 'Capability context should recognize low-UIA visual-first apps');
  assert(messageBuilderContent.includes('uia-rich'), 'Capability context should recognize UIA-rich apps');
  assert(messageBuilderContent.includes('namedInteractiveElementCount'), 'Capability context should include UIA inventory counts');
  assert(messageBuilderContent.includes('answer-shape:'), 'Capability context should shape control-surface answers');
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
  assert(shortcutProfileContent.includes('No stable native default should be assumed for opening Pine Editor'), 'TradingView shortcut profile should stop treating Pine Editor as a stable native shortcut');
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
  assert(systemPromptContent.includes('do not assume') && systemPromptContent.includes('stable native TradingView shortcut for Pine Editor'), 'System prompt should explicitly reject ctrl+e as a stable native Pine Editor shortcut');
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
  const appProfilePath = path.join(__dirname, '..', 'src', 'main', 'tradingview', 'app-profile.js');
  const fs = require('fs');

  const aiServiceContent = fs.readFileSync(aiServicePath, 'utf8');
  const appProfileContent = fs.readFileSync(appProfilePath, 'utf8');

  assert(aiServiceContent.includes("require('./tradingview/app-profile')"), 'ai-service should consume the extracted app profile module');
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
  assert(observationCheckpointContent.includes('inferKeyObservationCheckpoint'), 'Observation checkpoint module should infer TradingView post-key checkpoints');
  assert(observationCheckpointContent.includes('verifyKeyObservationCheckpoint'), 'Observation checkpoint module should verify TradingView post-key checkpoints');
  assert(aiServiceContent.includes('observationCheckpoints'), 'Execution results should expose key checkpoint metadata');
  assert(observationCheckpointContent.includes('surface change before continuing'), 'Checkpoint failures should explain missing TradingView surface changes');
  assert(observationCheckpointContent.includes('inferTradingViewObservationSpec'), 'Observation checkpoint module should consume the extracted TradingView observation-spec helper');
  assert(observationCheckpointContent.includes('inferTradingViewTradingMode'), 'Observation checkpoint module should consume the TradingView trading-mode inference helper');
  assert(aiServiceContent.includes("require('./tradingview/indicator-workflows')"), 'ai-service should consume the extracted TradingView indicator workflow helper');
  assert(aiServiceContent.includes("require('./tradingview/alert-workflows')"), 'ai-service should consume the extracted TradingView alert workflow helper');
  assert(aiServiceContent.includes("require('./tradingview/chart-verification')"), 'ai-service should consume the extracted TradingView chart verification helper');
  assert(aiServiceContent.includes("require('./tradingview/drawing-workflows')"), 'ai-service should consume the extracted TradingView drawing workflow helper');
  assert(aiServiceContent.includes("require('./tradingview/pine-workflows')"), 'ai-service should consume the extracted TradingView Pine workflow helper');
  assert(aiServiceContent.includes("require('./tradingview/paper-workflows')"), 'ai-service should consume the extracted TradingView Paper Trading workflow helper');
  assert(aiServiceContent.includes("require('./tradingview/dom-workflows')"), 'ai-service should consume the extracted TradingView DOM workflow helper');
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
  assert(systemAutomationContent.includes("action?.pineEvidenceMode === 'compile-result'"), 'system-automation should structure compile-result Pine Editor reads');
  assert(systemAutomationContent.includes("action?.pineEvidenceMode === 'diagnostics'"), 'system-automation should structure diagnostics Pine Editor reads');
  assert(systemAutomationContent.includes("action?.pineEvidenceMode === 'line-budget'"), 'system-automation should structure line-budget Pine Editor reads');
  assert(systemAutomationContent.includes("action?.pineEvidenceMode === 'generic-status'"), 'system-automation should structure generic-status Pine Editor reads');
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
  assert(entryRisk.blockExecution, 'TradingView DOM order-entry actions should be blocked in advisory-only mode');
  assert(/advisory-only/i.test(entryRisk.blockReason || ''), 'TradingView DOM order-entry block reason should explain the advisory-only safety rail');
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

test('system-automation uses SendInput for TradingView Alt/Enter key flows', () => {
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
    systemAutomation.shouldUseSendInputForKeyCombo('ctrl+l', { verifyTarget: { appName: 'TradingView', processNames: ['tradingview'] } }),
    false,
    'Non-Alt/Enter shortcuts should stay on the existing path'
  );
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
  const fs = require('fs');

  const shortcutProfileContent = fs.readFileSync(shortcutProfilePath, 'utf8');
  const indicatorWorkflowContent = fs.readFileSync(indicatorWorkflowPath, 'utf8');
  const alertWorkflowContent = fs.readFileSync(alertWorkflowPath, 'utf8');
  const pineWorkflowContent = fs.readFileSync(pineWorkflowPath, 'utf8');
  const messageBuilderContent = fs.readFileSync(messageBuilderPath, 'utf8');
  const systemPromptContent = fs.readFileSync(systemPromptPath, 'utf8');

  assert(shortcutProfileContent.includes('stable-default'), 'TradingView shortcut profile should expose stable shortcut metadata');
  assert(shortcutProfileContent.includes('context-dependent'), 'TradingView shortcut profile should expose context-dependent shortcut metadata');
  assert(shortcutProfileContent.includes('customizable'), 'TradingView shortcut profile should expose customizable shortcut classes');
  assert(shortcutProfileContent.includes('paper-test-only'), 'TradingView shortcut profile should expose unsafe trading shortcut classes');
  assert(indicatorWorkflowContent.includes("require('./shortcut-profile')"), 'Indicator workflow should consume TradingView shortcut profile');
  assert(alertWorkflowContent.includes("require('./shortcut-profile')"), 'Alert workflow should consume TradingView shortcut profile');
  assert(pineWorkflowContent.includes("require('./shortcut-profile')"), 'Pine workflow should consume TradingView shortcut profile');
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
