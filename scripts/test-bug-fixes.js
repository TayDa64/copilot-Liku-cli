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
  const fs = require('fs');

  const aiServiceContent = fs.readFileSync(aiServicePath, 'utf8');
  const observationCheckpointContent = fs.readFileSync(observationCheckpointPath, 'utf8');
  const tradingViewVerificationContent = fs.readFileSync(tradingViewVerificationPath, 'utf8');
  const tradingViewIndicatorContent = fs.readFileSync(tradingViewIndicatorPath, 'utf8');
  const tradingViewAlertContent = fs.readFileSync(tradingViewAlertPath, 'utf8');
  const tradingViewChartContent = fs.readFileSync(tradingViewChartPath, 'utf8');
  const tradingViewDrawingContent = fs.readFileSync(tradingViewDrawingPath, 'utf8');
  const tradingViewPineContent = fs.readFileSync(tradingViewPinePath, 'utf8');

  assert(aiServiceContent.includes("require('./ai-service/observation-checkpoints')"), 'ai-service should consume the extracted observation checkpoint helper module');
  assert(observationCheckpointContent.includes('inferKeyObservationCheckpoint'), 'Observation checkpoint module should infer TradingView post-key checkpoints');
  assert(observationCheckpointContent.includes('verifyKeyObservationCheckpoint'), 'Observation checkpoint module should verify TradingView post-key checkpoints');
  assert(aiServiceContent.includes('observationCheckpoints'), 'Execution results should expose key checkpoint metadata');
  assert(observationCheckpointContent.includes('surface change before continuing'), 'Checkpoint failures should explain missing TradingView surface changes');
  assert(observationCheckpointContent.includes('inferTradingViewObservationSpec'), 'Observation checkpoint module should consume the extracted TradingView observation-spec helper');
  assert(aiServiceContent.includes("require('./tradingview/indicator-workflows')"), 'ai-service should consume the extracted TradingView indicator workflow helper');
  assert(aiServiceContent.includes("require('./tradingview/alert-workflows')"), 'ai-service should consume the extracted TradingView alert workflow helper');
  assert(aiServiceContent.includes("require('./tradingview/chart-verification')"), 'ai-service should consume the extracted TradingView chart verification helper');
  assert(aiServiceContent.includes("require('./tradingview/drawing-workflows')"), 'ai-service should consume the extracted TradingView drawing workflow helper');
  assert(aiServiceContent.includes("require('./tradingview/pine-workflows')"), 'ai-service should consume the extracted TradingView Pine workflow helper');
  assert(tradingViewVerificationContent.includes("classification === 'panel-open'"), 'TradingView checkpoints should recognize panel-open flows such as Pine or DOM');
  assert(tradingViewVerificationContent.includes('pine editor'), 'TradingView checkpoints should ground Pine Editor workflows');
  assert(tradingViewVerificationContent.includes('depth of market'), 'TradingView checkpoints should ground DOM workflows');
  assert(tradingViewIndicatorContent.includes("key: '/'"), 'TradingView indicator workflows should open indicator search with the slash surface');
  assert(tradingViewIndicatorContent.includes('indicator-present'), 'TradingView indicator workflows should encode indicator-present verification metadata');
  assert(tradingViewAlertContent.includes("key: 'alt+a'"), 'TradingView alert workflows should open the Create Alert dialog with alt+a');
  assert(tradingViewAlertContent.includes('create-alert'), 'TradingView alert workflows should encode create-alert verification metadata');
  assert(tradingViewChartContent.includes("kind: 'timeframe-updated'"), 'TradingView chart verification workflows should encode timeframe-updated verification metadata');
  assert(tradingViewChartContent.includes("kind: 'symbol-updated'"), 'TradingView chart verification workflows should encode symbol-updated verification metadata');
  assert(tradingViewChartContent.includes("kind: 'watchlist-updated'"), 'TradingView chart verification workflows should encode watchlist-updated verification metadata');
  assert(tradingViewChartContent.includes("key: 'enter'"), 'TradingView chart verification workflows should confirm timeframe changes with enter');
  assert(tradingViewDrawingContent.includes("target: 'object-tree'"), 'TradingView drawing workflows should encode object-tree verification metadata');
  assert(tradingViewDrawingContent.includes("kind: intent.verifyKind"), 'TradingView drawing workflows should preserve verification-first surface contracts');
  assert(tradingViewPineContent.includes("target: 'pine-editor'"), 'TradingView Pine workflows should encode pine-editor verification metadata');
  assert(tradingViewPineContent.includes('requiresObservedChange'), 'TradingView Pine workflows should gate follow-up typing on observed panel changes');
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
