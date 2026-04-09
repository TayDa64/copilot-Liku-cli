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
        title: 'Settings - ExampleApp',
        processName: 'exampleapp',
        windowKind: 'main'
      })
    }, async () => {
      const execResult = await aiService.executeActions({
        thought: 'Open the Settings panel',
        verification: 'The Settings panel should be visible',
        actions: [{
          type: 'key',
          key: 'f10',
          reason: 'Open Settings panel',
          verify: {
            kind: 'panel-open',
            target: 'settings-panel',
            appName: 'ExampleApp',
            titleHints: ['Settings'],
            keywords: ['Settings']
          }
        }]
      }, null, null, {
        userMessage: 'open the settings panel',
        runtimeTraceLog,
        selectionProvenance: {
          skills: {
            ids: ['skill-example-settings-panel'],
            summary: { selectedCount: 1, scopedMatchCount: 1, fallbackCount: 0, mismatchCount: 0 }
          },
          memories: {
            ids: ['note-settings-panel-context'],
            summary: { selectedCount: 1, scopedMatchCount: 1, fallbackCount: 0, mismatchCount: 0 }
          },
          executionContext: {
            compartmentKey: 'copilot-liku-cli::exampleapp::unknown::general'
          }
        },
        actionExecutor: async (action) => ({
          success: true,
          action: action.type,
          message: 'opened settings',
          proof: {
            proofId: 'proof-base',
            actionType: action.type,
            level: 1,
            levelName: 'target-grounded',
            status: 'verified',
            checks: [{
              kind: 'target-resolution',
              status: 'pass',
              targetId: 'settings-panel',
              method: 'shortcut'
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
      assert.deepStrictEqual(execResult.selectionProvenance.skills.ids, ['skill-example-settings-panel']);
      assert.deepStrictEqual(execResult.selectionProvenance.memories.ids, ['note-settings-panel-context']);
      assert(execResult.results[0].proof.checks.some((check) => check.kind === 'observation-checkpoint' && check.status === 'pass'));

      const planEvent = traceEvents.find((entry) => entry.event === 'action:plan');
      assert(planEvent, 'runtime trace should record plan events');
      assert.deepStrictEqual(planEvent.selection.selectedSkillIds, ['skill-example-settings-panel']);
      assert.deepStrictEqual(planEvent.selection.selectedMemoryIds, ['note-settings-panel-context']);

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