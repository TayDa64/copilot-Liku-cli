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

  const envelopeMessage = messages.find((entry) => entry.role === 'system' && entry.content.includes('## Execution Context Envelope'));
  assert(envelopeMessage, 'execution context envelope section is injected');
  assert(envelopeMessage.content.includes('authority: host-generated deterministic repo/window signals'), 'execution envelope should describe host-generated authority');
  assert(/- repo: copilot-liku-cli/i.test(envelopeMessage.content));
  assert(envelopeMessage.content.includes('taskFamily: general'));

  const continuityMessage = messages.find((entry) => entry.role === 'system' && entry.content.includes('## Recent Action Continuity'));
  assert(continuityMessage, 'chat continuity section is injected');
  assert(continuityMessage.content.includes('lastExecutedActions: focus_window -> screenshot'));

  assert(messages.indexOf(envelopeMessage) > messages.indexOf(sessionMessage), 'execution envelope should follow session constraints');
  assert(messages.indexOf(envelopeMessage) < messages.indexOf(continuityMessage), 'execution envelope should appear before recent action continuity');

  const bridgedMessages = await builder.buildMessages('continue by searching this error in browser', false, {
    sessionState: {
      currentRepo: { repoName: 'copilot-liku-cli', projectRoot: path.join(__dirname, '..') },
      activeCompartmentKey: 'copilot-liku-cli::code::unknown::repo-editor',
      chatContinuityByCompartment: {
        'copilot-liku-cli::code::unknown::repo-editor': {
          activeGoal: 'Inspect the active VS Code workspace',
          currentSubgoal: 'Inspect the active VS Code workspace',
          continuationReady: true,
          lastTurn: {
            actionSummary: 'focus_window -> screenshot',
            nextRecommendedStep: 'Search the browser for the visible error next.'
          }
        }
      },
      pendingRequestedTaskByCompartment: {}
    },
    sessionIntentContext: '- currentRepo: copilot-liku-cli',
    chatContinuityContext: '- activeGoal: Inspect the active VS Code workspace\n- continuationReady: yes'
  });

  const bridgedEnvelopeMessage = bridgedMessages.find((entry) => entry.role === 'system' && entry.content.includes('bridgeFrom:'));
  const inheritedMessage = bridgedMessages.find((entry) => entry.role === 'system' && entry.content.includes('## Inherited Context from Previous Compartment'));
  assert(bridgedEnvelopeMessage, 'execution context envelope should surface bridge metadata for explicit cross-compartment handoffs');
  assert(inheritedMessage, 'message builder should inject read-only inherited context for explicit cross-compartment handoffs');
  assert(inheritedMessage.content.includes('sourceActiveGoal: Inspect the active VS Code workspace'));
  assert(inheritedMessage.content.includes('sourceContinuationReady: yes'));
  assert(inheritedMessage.content.includes('read-only baton pass'));

  console.log('PASS message builder session intent');
}

main().catch((error) => {
  console.error('FAIL message builder session intent');
  console.error(error.stack || error.message);
  process.exit(1);
});