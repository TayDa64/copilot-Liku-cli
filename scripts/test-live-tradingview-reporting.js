#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  summarizeResult,
  readRuntimeTraceTerminalEvent,
  deriveScenarioOutcome,
  scenarioBlockedByLaunchProfile,
  everyScenarioBlockedByLaunchProfile,
  shouldUseLightweightFailureArtifact
} = require(path.join(__dirname, 'live-tradingview-smoke.js'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
  }
}

function writeTempTrace(lines) {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-live-reporting-'));
  const filePath = path.join(dirPath, 'runtime.jsonl');
  fs.writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  return filePath;
}

test('readRuntimeTraceTerminalEvent returns the final runtime session end entry', () => {
  const tracePath = writeTempTrace([
    { ts: '2026-05-09T18:00:00.000Z', event: 'runtime:session:start', session: 'runtime-test' },
    { ts: '2026-05-09T18:00:01.000Z', event: 'action:completed', session: 'runtime-test', success: false },
    {
      ts: '2026-05-09T18:00:02.000Z',
      event: 'runtime:session:end',
      session: 'runtime-test',
      summary: {
        success: true,
        error: null,
        actionCount: 3
      }
    }
  ]);

  const terminalEvent = readRuntimeTraceTerminalEvent(tracePath);
  assert(terminalEvent, 'expected a parsed runtime terminal event');
  assert.strictEqual(terminalEvent.event, 'runtime:session:end');
  assert.strictEqual(terminalEvent.sessionId, 'runtime-test');
  assert.strictEqual(terminalEvent.success, true);
  assert.strictEqual(terminalEvent.error, null);
});

test('deriveScenarioOutcome prefers runtime terminal success over stale exec failure', () => {
  const outcome = deriveScenarioOutcome({
    execResult: {
      success: false,
      error: 'One or more actions failed'
    },
    runtimeTraceSummary: {
      success: true,
      error: null
    },
    runtimeTraceTerminalEvent: {
      event: 'runtime:session:end',
      success: true,
      error: null
    }
  });

  assert.strictEqual(outcome.success, true);
  assert.strictEqual(outcome.error, null);
  assert.strictEqual(outcome.source, 'runtime-trace-terminal');
  assert.strictEqual(outcome.consistency.mismatch, true);
  assert.strictEqual(outcome.consistency.execResultSuccess, false);
  assert.strictEqual(outcome.consistency.runtimeTraceSummarySuccess, true);
  assert.strictEqual(outcome.consistency.runtimeTraceTerminalSuccess, true);
});

test('deriveScenarioOutcome still fails closed on scenario errors', () => {
  const outcome = deriveScenarioOutcome({
    scenarioError: new Error('scenario exploded'),
    execResult: {
      success: true,
      error: null
    },
    runtimeTraceSummary: {
      success: true,
      error: null
    },
    runtimeTraceTerminalEvent: {
      event: 'runtime:session:end',
      success: true,
      error: null
    }
  });

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.error, 'scenario exploded');
  assert.strictEqual(outcome.source, 'scenario-error');
});

test('summarizeResult preserves Pine authoring telemetry and primary strategy details', () => {
  const summary = summarizeResult({
    success: true,
    action: 'key',
    pineAuthoringCdpWrite: {
      applicable: true,
      success: true,
      method: 'ChromiumCDPMonacoExecuteEdits',
      compactSummary: 'buffer=verified | rendered=partial',
      proof: {
        exactMatch: true,
        lifecycleState: 'prepared-script-verified',
        compactSummary: 'buffer=verified'
      },
      renderedProof: {
        exactMatch: false,
        lifecycleState: 'prepared-script-mismatch',
        compactSummary: 'buffer=mismatch'
      },
      strategyAttempts: [
        {
          strategy: 'monaco-editor-model',
          success: true,
          method: 'editor-executeEdits',
          compactSummary: 'buffer=verified | rendered=partial'
        },
        {
          strategy: 'input-insert-text',
          success: false,
          error: 'not-run'
        }
      ]
    },
    pineAuthoringWriteTelemetry: {
      selectedMethod: 'ChromiumCDPMonacoExecuteEdits',
      primaryMethod: 'ChromiumCDPMonacoExecuteEdits',
      primarySucceeded: true,
      primaryStrategy: 'monaco-editor-model',
      primaryAttemptSummary: 'monaco-editor-model:ok:editor-executeEdits',
      fallbackUsed: false,
      fallbackRetryAttempted: false,
      proofVerified: true,
      compactSummary: 'selected=ChromiumCDPMonacoExecuteEdits | primary=ChromiumCDPMonacoExecuteEdits:ok | strategy=monaco-editor-model | attempt=monaco-editor-model:ok:editor-executeEdits',
      primaryAttempts: [
        {
          strategy: 'monaco-editor-model',
          success: true,
          method: 'editor-executeEdits',
          compactSummary: 'buffer=verified | rendered=partial'
        }
      ]
    }
  });

  assert(summary.pineAuthoringCdpWrite, 'expected pineAuthoringCdpWrite summary');
  assert.strictEqual(summary.pineAuthoringCdpWrite.method, 'ChromiumCDPMonacoExecuteEdits');
  assert.strictEqual(summary.pineAuthoringCdpWrite.proof.exactMatch, true);
  assert.strictEqual(summary.pineAuthoringCdpWrite.strategyAttempts[0].strategy, 'monaco-editor-model');
  assert(summary.pineAuthoringWriteTelemetry, 'expected pineAuthoringWriteTelemetry summary');
  assert.strictEqual(summary.pineAuthoringWriteTelemetry.primaryStrategy, 'monaco-editor-model');
  assert.strictEqual(summary.pineAuthoringWriteTelemetry.primaryAttemptSummary, 'monaco-editor-model:ok:editor-executeEdits');
  assert.strictEqual(summary.pineAuthoringWriteTelemetry.primaryAttempts[0].method, 'editor-executeEdits');
});

test('shouldUseLightweightFailureArtifact returns true for launch-profile precondition failures before any action executes', () => {
  const lightweight = shouldUseLightweightFailureArtifact({
    scenarioError: new Error('pine-editor requires an automation-ready TradingView launch profile. TradingView is running in the normal interactive launch profile.'),
    execResult: null,
    actionTimeline: [],
    launchProfile: {
      inspectionAvailable: true,
      automationReady: false,
      profile: 'interactive-no-cdp'
    }
  });

  assert.strictEqual(lightweight, true);
});

test('shouldUseLightweightFailureArtifact stays disabled once action execution has started', () => {
  const lightweight = shouldUseLightweightFailureArtifact({
    scenarioError: new Error('pine-editor requires an automation-ready TradingView launch profile.'),
    execResult: null,
    actionTimeline: [{
      index: 0,
      action: 'bring_window_to_front'
    }],
    launchProfile: {
      inspectionAvailable: true,
      automationReady: false,
      profile: 'interactive-no-cdp'
    }
  });

  assert.strictEqual(lightweight, false);
});

test('scenarioBlockedByLaunchProfile only blocks Pine/CDP scenarios when inspection is available and automation is not ready', () => {
  const launchProfile = {
    inspectionAvailable: true,
    automationReady: false,
    profile: 'interactive-no-cdp'
  };

  assert.strictEqual(scenarioBlockedByLaunchProfile('pine-editor', launchProfile), true);
  assert.strictEqual(scenarioBlockedByLaunchProfile('pine-create-save', launchProfile), true);
  assert.strictEqual(scenarioBlockedByLaunchProfile('focus', launchProfile), false);
});

test('everyScenarioBlockedByLaunchProfile only returns true when the entire requested plan is launch-profile gated', () => {
  const launchProfile = {
    inspectionAvailable: true,
    automationReady: false,
    profile: 'interactive-no-cdp'
  };

  assert.strictEqual(everyScenarioBlockedByLaunchProfile([{ id: 'pine-editor' }], launchProfile), true);
  assert.strictEqual(everyScenarioBlockedByLaunchProfile([{ id: 'pine-editor' }, { id: 'pine-create-save' }], launchProfile), true);
  assert.strictEqual(everyScenarioBlockedByLaunchProfile([{ id: 'focus' }, { id: 'pine-editor' }], launchProfile), false);
});

console.log(`\nLive TradingView reporting tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
