#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const { createMessageBuilder } = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'message-builder.js'));

async function main() {
  const builder = createMessageBuilder({
    getBrowserSessionState: () => ({ lastUpdated: null }),
    getCurrentProvider: () => 'copilot',
    getForegroundWindowInfo: async () => null,
    getInspectService: () => ({
      isInspectModeActive: () => true,
      generateAIInstructions: () => '## Inspect Mode Active\n- Prefer targetId-based actions when a region id is available',
      generateAIContext: () => ({
        regions: [{
          id: 'region-1',
          label: 'Pine Editor',
          role: 'tab',
          center: { x: 1444, y: 913 },
          confidence: 0.92
        }],
        selectedRegionId: 'region-1',
        selectedRegion: {
          id: 'region-1',
          label: 'Pine Editor',
          role: 'tab',
          center: { x: 1444, y: 913 },
          confidence: 0.92
        },
        windowContext: {
          appName: 'TradingView',
          windowTitle: 'BTCUSD - TradingView',
          scaleFactor: 1
        }
      })
    }),
    getLatestVisualContext: () => null,
    getPreferencesSystemContext: () => '',
    getPreferencesSystemContextForApp: () => '',
    getRecentConversationHistory: () => [],
    getSemanticDOMContextText: () => '',
    getUIWatcher: () => null,
    maxHistory: 0,
    systemPrompt: 'base system prompt'
  });

  const messages = await builder.buildMessages('open the pine editor', false);

  const inspectSystemMessage = messages.find((entry) => entry.role === 'system' && entry.content.includes('## Inspect Mode Active'));
  assert(inspectSystemMessage, 'inspect instructions should be injected as a system message');
  assert(inspectSystemMessage.content.includes('targetId-based actions'));

  const userMessage = messages.find((entry) => entry.role === 'user');
  assert(userMessage, 'user message should be present');
  assert.strictEqual(typeof userMessage.content, 'string', 'expected text-only user message');
  assert(userMessage.content.includes('id=region-1'), 'inspect region ids should be included in the appended inspect context');
  assert(userMessage.content.includes('selectedRegionId=region-1'), 'selected region id should be included in inspect context');

  console.log('PASS message builder inspect');
}

main().catch((error) => {
  console.error('FAIL message builder inspect');
  console.error(error.stack || error.message);
  process.exit(1);
});