#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const { createMessageBuilder } = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'message-builder.js'));

function createBuilder({ foreground } = {}) {
  return createMessageBuilder({
    getBrowserSessionState: () => ({ lastUpdated: null }),
    getCurrentProvider: () => 'copilot',
    getForegroundWindowInfo: async () => foreground || null,
    getInspectService: () => ({ isInspectModeActive: () => false }),
    getLatestVisualContext: () => null,
    getPreferencesSystemContext: () => '',
    getPreferencesSystemContextForApp: () => '',
    getRecentConversationHistory: () => [],
    getSemanticDOMContextText: () => '',
    getUIWatcher: () => ({ isPolling: false, getCapabilitySnapshot: () => null, getContextForAI: () => '' }),
    maxHistory: 0,
    systemPrompt: 'base system prompt'
  });
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

async function buildPineEvidenceMessage(userMessage) {
  const builder = createBuilder({
    foreground: {
      success: true,
      processName: 'tradingview',
      title: 'TradingView - Pine Editor'
    }
  });
  const messages = await builder.buildMessages(userMessage, false);
  return messages.find((entry) => entry.role === 'system' && entry.content.includes('## Pine Evidence Bounds'));
}

async function main() {
  await test('pine compile-result prompt bounds compile success claims', async () => {
    const evidenceMessage = await buildPineEvidenceMessage('open pine editor in tradingview and summarize the compile result');

    assert(evidenceMessage, 'pine evidence block should be injected');
    assert(evidenceMessage.content.includes('requestKind: compile-result'));
    assert(evidenceMessage.content.includes('Rule: Prefer visible Pine Editor compiler/diagnostic text over screenshot interpretation for Pine compile and diagnostics requests.'));
    assert(evidenceMessage.content.includes('compiler/editor evidence only, not proof of runtime correctness, strategy validity, profitability, or market insight'));
  });

  await test('pine diagnostics prompt bounds warning and runtime inferences', async () => {
    const evidenceMessage = await buildPineEvidenceMessage('open pine editor in tradingview and check diagnostics');

    assert(evidenceMessage, 'pine evidence block should be injected');
    assert(evidenceMessage.content.includes('requestKind: diagnostics'));
    assert(evidenceMessage.content.includes('Rule: Surface visible compiler errors and warnings as bounded diagnostics evidence; do not infer hidden causes or chart-state effects unless the visible text states them.'));
    assert(evidenceMessage.content.includes('mention Pine execution-model caveats such as realtime rollback, confirmed vs unconfirmed bars, and indicator vs strategy recalculation differences'));
  });

  await test('pine provenance prompt bounds visible revision metadata inferences', async () => {
    const evidenceMessage = await buildPineEvidenceMessage('open pine version history in tradingview and summarize the top visible revision metadata');

    assert(evidenceMessage, 'pine evidence block should be injected');
    assert(evidenceMessage.content.includes('requestKind: provenance-summary'));
    assert(evidenceMessage.content.includes('Treat Pine Version History as bounded provenance evidence only'));
    assert(evidenceMessage.content.includes('Do not infer hidden diffs, full script history, authorship, or runtime/chart behavior from the visible revision list alone.'));
  });
}

main().catch((error) => {
  console.error('FAIL pine diagnostics bounds');
  console.error(error.stack || error.message);
  process.exit(1);
});