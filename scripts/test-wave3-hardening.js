#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const chatModule = require(path.join(__dirname, '..', 'src', 'cli', 'commands', 'chat.js'));
const aiService = require(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'));

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`PASS ${name}`);
    })
    .catch((error) => {
      console.error(`FAIL ${name}`);
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}

async function withPatchedSystemAutomation(overrides, fn) {
  const systemAutomation = aiService.systemAutomation;
  const originals = {};
  for (const [key, value] of Object.entries(overrides)) {
    originals[key] = systemAutomation[key];
    systemAutomation[key] = value;
  }

  try {
    return await fn(systemAutomation);
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      systemAutomation[key] = value;
    }
  }
}

async function main() {
  await test('implicit minimal continuation can bridge prior saved continuity across a compartment switch', () => {
    const handoff = chatModule.__test.buildImplicitContextSwitchHandoff('continue', {
      compartmentKey: 'copilot-liku-cli::chrome::unknown::browser',
      transition: {
        previousCompartmentKey: 'copilot-liku-cli::code::unknown::repo-editor',
        bridgeEligible: false
      }
    }, {
      currentContinuity: {
        activeGoal: null,
        continuationReady: false,
        degradedReason: null,
        freshnessState: null,
        lastTurn: null
      },
      previousContinuity: {
        activeGoal: 'Inspect the failing repo command seam in VS Code.',
        currentSubgoal: 'Rerun the focused command test.',
        continuationReady: true,
        degradedReason: null,
        freshnessState: 'fresh',
        lastTurn: {
          nextRecommendedStep: 'Continue from the current workspace state.'
        }
      },
      previousPendingRequestedTask: null
    });

    assert(handoff, 'implicit handoff should be generated for a short continuation turn');
    assert.strictEqual(handoff.useContinuityState, true, 'implicit handoff should reuse prior continuity when it is the best saved signal');
    assert.strictEqual(handoff.usePendingRequestedTask, false, 'implicit handoff should not claim a pending task when only continuity is available');
    assert(String(handoff.message || '').includes('Implicit context switch detected'), 'handoff should explain the bounded implicit bridge');
    assert(String(handoff.effectiveIntent || '').toLowerCase().includes('continue'), 'handoff should produce a continuation intent from the prior compartment');
  });

  await test('coordinate clicks fail closed when no target window handle is available for focus verification', async () => {
    aiService.setUIWatcher(null);

    await withPatchedSystemAutomation({
      getForegroundWindowInfo: async () => ({ success: true, hwnd: 551001, title: 'Foreground Window', processName: 'code' }),
      focusWindow: async () => ({ success: true }),
      executeAction: async (action) => ({ success: true, action: action?.type || 'unknown', message: 'ok' }),
      getRunningProcessesByNames: async () => []
    }, async () => {
      const execResult = await aiService.executeActions({
        thought: 'Click the coordinate target',
        verification: 'The target button should activate',
        actions: [{ type: 'click', x: 120, y: 240, reason: 'Activate the visible button' }]
      }, null, null, {
        userMessage: 'click the visible button',
        executionContextEnvelope: {
          compartmentKey: 'copilot-liku-cli::code::unknown::repo-editor',
          confidence: 'high',
          repo: { name: 'copilot-liku-cli', projectRoot: 'C:/dev/copilot-Liku-cli' },
          foreground: { appId: 'code', processName: 'code', surfaceClass: 'unknown', interactionMode: 'unknown' },
          taskFamily: 'repo-editor',
          eligibility: { tradingViewPine: false, tradingViewPineReason: 'not-eligible' }
        },
        actionExecutor: async (action) => ({ success: true, action: action.type, message: 'clicked' })
      });

      assert.strictEqual(execResult.success, false, 'execution should fail closed when a coordinate click cannot verify focus lock');
      assert.strictEqual(execResult.results[0].blockedByFocusLock, true, 'blocked result should surface focus-lock metadata');
      assert(String(execResult.results[0].error || '').includes('Cannot verify foreground lock for coordinate click'), 'blocked result should explain why the click was refused');
      assert.strictEqual(execResult.results[0].focusVerification.reason, 'missing-target-window-handle', 'focus verification metadata should explain the missing target handle');
    });
  });
}

main().catch((error) => {
  console.error('FAIL wave3 hardening');
  console.error(error.stack || error.message);
  process.exit(1);
});
