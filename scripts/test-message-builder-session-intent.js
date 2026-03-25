#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const { createMessageBuilder } = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'message-builder.js'));

async function main() {
  const builder = createMessageBuilder({
    getBrowserSessionState: () => ({ lastUpdated: null }),
    getCurrentProvider: () => 'copilot',
    getForegroundWindowInfo: async () => null,
    getInspectService: () => ({ isInspectModeActive: () => false }),
    getLatestVisualContext: () => null,
    getPreferencesSystemContext: () => '',
    getPreferencesSystemContextForApp: () => '',
    getRecentConversationHistory: () => [],
    getSemanticDOMContextText: () => '',
    getUIWatcher: () => null,
    maxHistory: 0,
    systemPrompt: 'base system prompt'
  });

  const messages = await builder.buildMessages('hello', false, {
    sessionIntentContext: '- currentRepo: copilot-liku-cli\n- forgoneFeatures: terminal-liku ui',
    chatContinuityContext: '- activeGoal: Produce a confident synthesis of ticker LUNR in TradingView\n- lastExecutedActions: focus_window -> screenshot\n- continuationReady: yes'
  });

  const sessionMessage = messages.find((entry) => entry.role === 'system' && entry.content.includes('## Session Constraints'));
  assert(sessionMessage, 'session constraints section is injected');
  assert(sessionMessage.content.includes('terminal-liku ui'));

  const continuityMessage = messages.find((entry) => entry.role === 'system' && entry.content.includes('## Recent Action Continuity'));
  assert(continuityMessage, 'chat continuity section is injected');
  assert(continuityMessage.content.includes('lastExecutedActions: focus_window -> screenshot'));

  console.log('PASS message builder session intent');
}

main().catch((error) => {
  console.error('FAIL message builder session intent');
  console.error(error.stack || error.message);
  process.exit(1);
});