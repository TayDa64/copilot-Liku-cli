#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const aiService = require(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'));

function readRuntimeProofFixture(name) {
  const fixturesPath = path.join(__dirname, 'fixtures', 'transcripts', 'runtime-proof-regressions.json');
  const bundle = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));
  return bundle[name] || null;
}

function assertTextIncludesAll(text, fragments, messagePrefix) {
  for (const fragment of fragments || []) {
    assert(
      String(text || '').includes(fragment),
      `${messagePrefix}: expected to include ${JSON.stringify(fragment)}, got ${JSON.stringify(text)}`
    );
  }
}

function assertTextExcludesAll(text, fragments, messagePrefix) {
  for (const fragment of fragments || []) {
    assert(
      !String(text || '').includes(fragment),
      `${messagePrefix}: expected to exclude ${JSON.stringify(fragment)}, got ${JSON.stringify(text)}`
    );
  }
}

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
  await test('fixture-backed confirmation safety proof names the object and distinguishes benign clear prose from destructive commands', async () => {
    const fixture = readRuntimeProofFixture('runtime-proof-confirmation-command-safety');
    assert(fixture, 'expected runtime-proof-confirmation-command-safety fixture');
    assert(Array.isArray(fixture.confirmationCases), 'confirmation fixture should define confirmationCases');
    assert.strictEqual(fixture.confirmationCases.length, 2, 'expected benign and destructive confirmation cases');

    for (const testCase of fixture.confirmationCases) {
      const result = aiService.analyzeActionSafety(testCase.action, testCase.targetInfo || {});
      const expected = testCase.expected || {};
      const warningsText = Array.isArray(result.warnings) ? result.warnings.join('\n') : '';
      const objectLabel = String(result.confirmationContext?.objectLabel || '');
      const expectedProof = String(result.confirmationContext?.expectedProof || '');
      const prompt = String(result.confirmationPrompt || '');

      assert.strictEqual(
        String(result.riskLevel || '').toLowerCase(),
        String(expected.riskLevel || '').toLowerCase(),
        `${testCase.name}: riskLevel mismatch`
      );
      assert.strictEqual(result.requiresConfirmation, expected.requiresConfirmation, `${testCase.name}: requiresConfirmation mismatch`);
      assert.strictEqual(result.confirmationContext?.objectType, expected.objectType, `${testCase.name}: objectType mismatch`);
      assert.strictEqual(result.confirmationContext?.repoPath, expected.repoPath, `${testCase.name}: repoPath mismatch`);
      assertTextIncludesAll(objectLabel, expected.objectLabelIncludes, `${testCase.name}: objectLabel`);

      if (expected.promptAbsent) {
        assert.strictEqual(prompt, '', `${testCase.name}: expected no confirmation prompt`);
      }

      assertTextIncludesAll(expectedProof, expected.expectedProofIncludes, `${testCase.name}: expectedProof`);
      assertTextIncludesAll(warningsText, expected.warningsInclude, `${testCase.name}: warnings`);
      assertTextExcludesAll(warningsText, expected.warningsExclude, `${testCase.name}: warnings`);
      assertTextIncludesAll(prompt, expected.promptIncludes, `${testCase.name}: confirmationPrompt`);
      assertTextExcludesAll(prompt, expected.promptExcludes, `${testCase.name}: confirmationPrompt`);
    }
  });

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

  await test('executeActions emits rewrite provenance when reliability preflight rewrites a low-signal browser plan', async () => {
    const traceEvents = [];
    const runtimeTraceLog = {
      sessionId: 'runtime-rewrite-session',
      filePath: 'C:/tmp/runtime-rewrite-session.jsonl',
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
        hwnd: 440001,
        title: 'Example Domain - Microsoft Edge',
        processName: 'msedge',
        windowKind: 'main'
      })
    }, async () => {
      const execResult = await aiService.executeActions({
        thought: 'Open the requested URL in Edge',
        verification: 'The page should load in Edge',
        actions: [
          { type: 'wait', ms: 10 }
        ]
      }, null, null, {
        userMessage: 'open https://example.com in edge',
        runtimeTraceLog,
        actionExecutor: async (action) => ({
          success: true,
          action: action.type,
          message: 'ok'
        })
      });

      assert(execResult.runtimeTrace, 'executeActions should still surface runtime trace metadata for rewritten plans');
      assert(Array.isArray(execResult.rewriteSources), 'executeActions should return rewriteSources');
      assert(execResult.rewriteSources.length >= 1, 'rewriteSources should record the applied rewrite');
      assert.strictEqual(execResult.rewriteSources[0].rewriter, 'buildBrowserOpenUrlActions');

      const rewriteEvent = traceEvents.find((entry) => entry.event === 'plan:rewrite');
      assert(rewriteEvent, 'runtime trace should record rewrite provenance events');
      assert.strictEqual(rewriteEvent.rewriter, 'buildBrowserOpenUrlActions');
      assert.strictEqual(rewriteEvent.category, 'deterministic-browser-open-url');
      assert(rewriteEvent.contextAuthority, 'rewrite event should include context authority');
      assert(rewriteEvent.contextAuthority.hash, 'rewrite event should include a stable context hash');

      const planEvent = traceEvents.find((entry) => entry.event === 'action:plan');
      assert(planEvent, 'runtime trace should still record action:plan');
      assert(Array.isArray(planEvent.rewrites), 'action:plan should summarize rewrite provenance');
      assert.strictEqual(planEvent.rewrites[0].rewriter, 'buildBrowserOpenUrlActions');
    });
  });
}

main().catch((error) => {
  console.error('FAIL ai-service proof trace');
  console.error(error.stack || error.message);
  process.exit(1);
});