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
    sessionIntentContext: '- currentRepo: copilot-liku-cli\n- forgoneFeatures: terminal-liku ui'
  });

  const sessionMessage = messages.find((entry) => entry.role === 'system' && entry.content.includes('## Session Constraints'));
  assert(sessionMessage, 'session constraints section is injected');
  assert(sessionMessage.content.includes('terminal-liku ui'));

  console.log('PASS message builder session intent');
}

main().catch((error) => {
  console.error('FAIL message builder session intent');
  console.error(error.stack || error.message);
  process.exit(1);
});