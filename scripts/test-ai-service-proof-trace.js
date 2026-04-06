#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const aiService = require(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'));

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
  await test('executeActions upgrades proof with observation checkpoint and emits runtime proof trace', async () => {
    const traceEvents = [];
    const runtimeTraceLog = {
      sessionId: 'runtime-test-session',
      filePath: 'C:/tmp/runtime-test-session.jsonl',
      append(event, data) {
        traceEvents.push({ event, ...data });
      },
      close(summary) {
        traceEvents.push({ event: 'runtime:session:end', summary });
      }
    };

    aiService.setUIWatcher(null);

    await withPatchedSystemAutomation({
      focusWindow: async () => ({ success: true }),
      executeAction: async (action) => ({ success: true, action: action?.type || 'unknown', message: 'ok' }),
      getRunningProcessesByNames: async () => [],
      getForegroundWindowInfo: async () => ({
        success: true,
        hwnd: 330552,
        title: 'Pine Editor - TradingView',
        processName: 'tradingview',
        windowKind: 'main'
      })
    }, async () => {
      const execResult = await aiService.executeActions({
        thought: 'Open the Pine Editor surface',
        verification: 'The Pine Editor should be visible',
        actions: [{
          type: 'click',
          targetId: 'region-1',
          reason: 'Open Pine Editor',
          verify: {
            kind: 'panel-open',
            target: 'pine-editor',
            appName: 'TradingView',
            titleHints: ['Pine Editor'],
            keywords: ['Pine Editor']
          }
        }]
      }, null, null, {
        userMessage: 'open the pine editor',
        runtimeTraceLog,
        actionExecutor: async (action) => ({
          success: true,
          action: action.type,
          message: 'clicked',
          resolvedTarget: {
            targetId: action.targetId,
            resolutionMethod: 'clickPoint',
            resolvedPoint: { x: 42, y: 84 },
            stale: false,
            coordinateFallback: false,
            window: {
              appName: 'TradingView',
              windowTitle: 'Pine Editor - TradingView',
              pid: 321
            }
          },
          proof: {
            proofId: 'proof-base',
            actionType: action.type,
            level: 1,
            levelName: 'target-grounded',
            status: 'verified',
            checks: [{
              kind: 'target-resolution',
              status: 'pass',
              targetId: action.targetId,
              method: 'clickPoint'
            }],
            limitations: []
          }
        })
      });

      assert.strictEqual(execResult.success, true);
      assert(execResult.runtimeTrace, 'executeActions should surface runtime trace metadata');
      assert.strictEqual(execResult.runtimeTrace.sessionId, 'runtime-test-session');
      assert.strictEqual(execResult.results.length, 1);
      assert.strictEqual(execResult.results[0].proof.level, 2, 'verified observation should upgrade proof to effect-verified');
      assert.strictEqual(execResult.results[0].proof.status, 'verified');
      assert.strictEqual(execResult.results[0].proof.observation.classification, 'panel-open');
      assert(execResult.results[0].proof.checks.some((check) => check.kind === 'observation-checkpoint' && check.status === 'pass'));

      const proofEvent = traceEvents.find((entry) => entry.event === 'action:proof');
      assert(proofEvent, 'runtime trace should record proof events');
      assert.strictEqual(proofEvent.proof.level, 2);
      assert.strictEqual(proofEvent.proof.status, 'verified');
      assert.strictEqual(proofEvent.observationCheckpoint.classification, 'panel-open');
    });
  });

  await test('executeActions promotes explicit TradingView chart verification to domain proof', async () => {
    const traceEvents = [];
    const runtimeTraceLog = {
      sessionId: 'runtime-domain-proof-session',
      filePath: 'C:/tmp/runtime-domain-proof-session.jsonl',
      append(event, data) {
        traceEvents.push({ event, ...data });
      },
      close(summary) {
        traceEvents.push({ event: 'runtime:session:end', summary });
      }
    };

    aiService.setUIWatcher(null);

    await withPatchedSystemAutomation({
      focusWindow: async () => ({ success: true }),
      executeAction: async (action) => ({ success: true, action: action?.type || 'unknown', message: 'ok' }),
      getRunningProcessesByNames: async () => [],
      getForegroundWindowInfo: async () => ({
        success: true,
        hwnd: 330552,
        title: 'BTCUSD 5m - TradingView',
        processName: 'tradingview',
        windowKind: 'main'
      })
    }, async () => {
      const execResult = await aiService.executeActions({
        thought: 'Apply the 5m timeframe in TradingView',
        verification: 'TradingView should show the 5m timeframe',
        actions: [{
          type: 'key',
          key: 'enter',
          reason: 'Confirm the 5m timeframe in TradingView',
          verify: {
            kind: 'timeframe-updated',
            target: 'timeframe-updated',
            appName: 'TradingView',
            keywords: ['5m', 'timeframe', 'TradingView']
          }
        }]
      }, null, null, {
        userMessage: 'set the TradingView chart to 5m',
        runtimeTraceLog,
        actionExecutor: async (action) => ({
          success: true,
          action: action.type,
          message: 'confirmed',
          proof: {
            proofId: 'proof-domain-base',
            actionType: action.type,
            level: 0,
            levelName: 'executed',
            status: 'bounded',
            checks: [],
            limitations: []
          }
        })
      });

      assert.strictEqual(execResult.success, true);
      assert.strictEqual(execResult.results.length, 1);
      assert.strictEqual(execResult.results[0].proof.level, 3, 'explicit TradingView verification should upgrade proof to domain-verified');
      assert.strictEqual(execResult.results[0].proof.levelName, 'domain-verified');
      assert.strictEqual(execResult.results[0].proof.status, 'verified');
      assert.strictEqual(execResult.results[0].proof.observation.classification, 'chart-state');
      assert.strictEqual(execResult.results[0].proof.observation.verifyKind, 'timeframe-updated');
      assert(execResult.results[0].proof.checks.some((check) => check.kind === 'domain-verification' && check.status === 'pass'));

      const proofEvent = traceEvents.find((entry) => entry.event === 'action:proof');
      assert(proofEvent, 'runtime trace should record domain proof events');
      assert.strictEqual(proofEvent.proof.level, 3);
      assert.strictEqual(proofEvent.proof.levelName, 'domain-verified');
      assert(proofEvent.proof.checks.some((check) => check.kind === 'domain-verification' && check.status === 'pass'));
    });
  });
}

main().catch((error) => {
  console.error('FAIL ai-service proof trace');
  console.error(error.stack || error.message);
  process.exit(1);
});