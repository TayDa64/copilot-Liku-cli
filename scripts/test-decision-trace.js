#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  createDecisionTraceEmitter
} = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'decision-trace.js'));
const {
  getRegisteredDecisionTraceContributors,
  registerDecisionTraceContributor,
  unregisterDecisionTraceContributor
} = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'decision-trace-registry.js'));
const {
  createTradingViewDecisionTraceContributor
} = require(path.join(__dirname, '..', 'src', 'main', 'tools', 'tradingview-tool.js'));

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

function createTraceCapture() {
  const entries = [];
  return {
    entries,
    log: {
      append(event, data = {}) {
        const entry = {
          event,
          ...data
        };
        entries.push(entry);
        return entry;
      }
    }
  };
}

async function main() {
  await test('decision trace registry preserves priority order and replacement', async () => {
    unregisterDecisionTraceContributor('decision-trace-test-low');
    unregisterDecisionTraceContributor('decision-trace-test-high');

    registerDecisionTraceContributor('decision-trace-test-low', { enrich: () => ({ domain: 'low' }) }, 10);
    registerDecisionTraceContributor('decision-trace-test-high', { enrich: () => ({ domain: 'high' }) }, -10);

    const entries = getRegisteredDecisionTraceContributors()
      .filter((entry) => /^decision-trace-test-/.test(String(entry.toolName || '')));
    assert.deepStrictEqual(entries.map((entry) => entry.toolName), [
      'decision-trace-test-high',
      'decision-trace-test-low'
    ]);

    unregisterDecisionTraceContributor('decision-trace-test-low');
    unregisterDecisionTraceContributor('decision-trace-test-high');
  });

  await test('decision trace emitter records normalized generic action events', async () => {
    const capture = createTraceCapture();
    const emitter = createDecisionTraceEmitter({
      runtimeTraceLog: capture.log,
      appendTraceEvent(traceLog, event, data) {
        traceLog.append(event, data);
      },
      summarizeAction(action) {
        return {
          type: action.type || null,
          text: action.text || null,
          key: action.key || null
        };
      }
    });

    emitter.emit('action-start', {
      guardrails: {
        safety: {
          riskLevel: 'medium',
          warnings: ['bounded']
        }
      }
    }, {
      action: {
        type: 'type',
        text: 'validated script',
        reason: 'Insert the validated script into the active editor'
      },
      actionData: {
        thought: 'Author a Pine script safely'
      }
    });

    assert.strictEqual(capture.entries.length, 1);
    assert.strictEqual(capture.entries[0].event, 'decision:action-start');
    assert.strictEqual(capture.entries[0].goal, 'Insert the validated script into the active editor');
    assert.strictEqual(capture.entries[0].expectedSurface, 'active-input');
    assert.strictEqual(capture.entries[0].action.type, 'type');
    assert.strictEqual(capture.entries[0].guardrails.safety.riskLevel, 'medium');
  });

  await test('TradingView decision contributor annotates Pine surface evidence', async () => {
    const capture = createTraceCapture();
    const emitter = createDecisionTraceEmitter({
      runtimeTraceLog: capture.log,
      appendTraceEvent(traceLog, event, data) {
        traceLog.append(event, data);
      },
      contributors: [createTradingViewDecisionTraceContributor()],
      summarizeAction(action) {
        return {
          type: action.type || null,
          key: action.key || null
        };
      }
    });

    emitter.emit('verification', {
      actualOutcome: {
        verified: false,
        error: 'The active Pine Editor surface was not confirmed.'
      }
    }, {
      userMessage: 'Open Pine Editor in TradingView',
      actionIndex: 4,
      actionData: {
        thought: 'Open Pine Editor through the command surface'
      },
      action: {
        type: 'key',
        key: 'ctrl+k',
        reason: 'Open Pine Editor from the TradingView command quick search',
        verify: {
          target: 'pine-editor'
        },
        searchSurfaceContract: {
          id: 'open-pine-editor',
          route: 'quick-search',
          surface: 'quick-search',
          appName: 'TradingView',
          requiresCommandSurface: true
        },
        tradingViewShortcut: {
          id: 'symbol-search',
          surface: 'quick-search',
          appName: 'TradingView'
        }
      },
      checkpointSpec: {
        classification: 'editor-active',
        verifyTarget: 'pine-editor'
      },
      observationCheckpoint: {
        appName: 'TradingView',
        classification: 'editor-active',
        verifyTarget: 'pine-editor',
        verified: false,
        matchReason: 'process',
        hostSurfaceMatched: true,
        hostSurfaceAnchor: 'add to chart'
      },
      pineEditorRecovery: {
        recovered: false,
        recoveredBy: 'chart-focus-ctrl-e',
        error: 'The active Pine Editor surface was not confirmed.'
      }
    });

    assert.strictEqual(capture.entries.length, 1);
    assert.strictEqual(capture.entries[0].event, 'decision:verification');
    assert.strictEqual(capture.entries[0].domain, 'tradingview');
    assert.strictEqual(capture.entries[0].expectedSurface, 'tradingview/pine-editor');
    assert.strictEqual(capture.entries[0].domainData.tradingview.searchSurfaceContract.route, 'quick-search');
    assert.strictEqual(capture.entries[0].domainData.tradingview.shortcut.id, 'symbol-search');
    assert.strictEqual(capture.entries[0].domainData.tradingview.observation.hostSurfaceAnchor, 'add to chart');
    assert.strictEqual(capture.entries[0].domainData.tradingview.pineEditorRecovery.recoveredBy, 'chart-focus-ctrl-e');
  });

  await test('decision trace preserves compact semantic Pine activation proof summaries', async () => {
    const capture = createTraceCapture();
    const emitter = createDecisionTraceEmitter({
      runtimeTraceLog: capture.log,
      appendTraceEvent(traceLog, event, data) {
        traceLog.append(event, data);
      },
      contributors: [createTradingViewDecisionTraceContributor()],
      summarizeAction(action) {
        return {
          type: action.type || null,
          text: action.text || null
        };
      }
    });

    emitter.emit('action-complete', {
      actualOutcome: {
        success: false,
        error: 'Pine surface was not observed',
        tradingViewPineActivationProof: {
          applicable: true,
          route: 'semantic-icon',
          expectedSurface: 'pine-editor',
          windowHandle: 777,
          proofStrategy: 'watcher-first',
          actionSucceeded: true,
          observedChange: true,
          pineSurfaceObserved: false,
          disposition: 'window-state-changed-without-pine-surface',
          likelyMeaning: 'TradingView state changed after the semantic Pine click, but Pine anchors still did not become UIA-visible.',
          hostRevalidation: {
            attempted: true,
            reason: 'watcher-delta'
          },
          signals: [
            { kind: 'focused-element-changed', before: 'Chart', after: 'Source editor' },
            { kind: 'uia-structure-changed', added: ['Source editor'], removed: ['Pine'] }
          ],
          before: {
            captured: true,
            windowHandle: 777,
            foreground: {
              success: true,
              hwnd: 777,
              processName: 'tradingview',
              title: 'MN / Unnamed',
              windowKind: 'main'
            },
            pineSurfaceActive: false,
            focusedElement: 'Chart'
          },
          after: {
            captured: true,
            windowHandle: 777,
            foreground: {
              success: true,
              hwnd: 777,
              processName: 'tradingview',
              title: 'MN / Unnamed',
              windowKind: 'main'
            },
            pineSurfaceActive: false,
            focusedElement: 'Source editor'
          }
        }
      }
    }, {
      userMessage: 'Open Pine Editor in TradingView',
      actionIndex: 2,
      actionData: {
        thought: 'Open Pine Editor through the semantic Pine icon'
      },
      action: {
        type: 'click_element',
        text: 'Pine',
        reason: 'Invoke the TradingView Pine icon',
        verify: {
          target: 'pine-editor'
        },
        searchSurfaceContract: {
          id: 'open-pine-editor',
          route: 'semantic-icon',
          surface: 'pine-editor',
          appName: 'TradingView'
        },
        tradingViewShortcut: {
          id: 'open-pine-editor',
          surface: 'pine-editor',
          appName: 'TradingView'
        }
      }
    });

    assert.strictEqual(capture.entries.length, 1);
    assert.strictEqual(capture.entries[0].event, 'decision:action-complete');
    assert.strictEqual(capture.entries[0].actualOutcome.tradingViewPineActivationProof.route, 'semantic-icon');
    assert.strictEqual(capture.entries[0].actualOutcome.tradingViewPineActivationProof.proofStrategy, 'watcher-first');
    assert.strictEqual(capture.entries[0].actualOutcome.tradingViewPineActivationProof.observedChange, true);
    assert.strictEqual(capture.entries[0].actualOutcome.tradingViewPineActivationProof.disposition, 'window-state-changed-without-pine-surface');
    assert.strictEqual(capture.entries[0].actualOutcome.tradingViewPineActivationProof.hostRevalidation.attempted, true);
    assert.strictEqual(
      capture.entries[0].actualOutcome.tradingViewPineActivationProof.signals.some((signal) => signal?.kind === 'uia-structure-changed'),
      true
    );
  });
}

main().catch((error) => {
  console.error('FAIL decision trace');
  console.error(error.stack || error.message);
  process.exit(1);
});
