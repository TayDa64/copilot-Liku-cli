#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const { createMessageBuilder } = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'message-builder.js'));

function createBuilder({ latestVisual, foreground, watcherSnapshot } = {}) {
  return createMessageBuilder({
    getBrowserSessionState: () => ({ lastUpdated: null }),
    getCurrentProvider: () => 'copilot',
    getForegroundWindowInfo: async () => foreground || null,
    getInspectService: () => ({ isInspectModeActive: () => false }),
    getLatestVisualContext: () => latestVisual || null,
    getPreferencesSystemContext: () => '',
    getPreferencesSystemContextForApp: () => '',
    getRecentConversationHistory: () => [],
    getSemanticDOMContextText: () => '',
    getUIWatcher: () => ({
      isPolling: false,
      getCapabilitySnapshot: () => watcherSnapshot || null,
      getContextForAI: () => ''
    }),
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

async function buildVisualEvidenceMessage({ latestVisual, foreground, watcherSnapshot, userMessage }) {
  const builder = createBuilder({ latestVisual, foreground, watcherSnapshot });
  const messages = await builder.buildMessages(userMessage, true);
  return messages.find((entry) => entry.role === 'system' && entry.content.includes('## Current Visual Evidence Bounds'));
}

async function main() {
  await test('degraded TradingView analysis prompt forbids precise unseen indicator claims', async () => {
    const visualMessage = await buildVisualEvidenceMessage({
      latestVisual: {
        dataURL: 'data:image/png;base64,AAAA',
        captureMode: 'screen-copyfromscreen',
        captureTrusted: false,
        scope: 'screen'
      },
      foreground: {
        success: true,
        processName: 'tradingview',
        title: 'TradingView - LUNR'
      },
      watcherSnapshot: {
        activeWindowElementCount: 4,
        interactiveElementCount: 2,
        namedInteractiveElementCount: 1,
        activeWindow: {
          processName: 'tradingview',
          title: 'TradingView - LUNR'
        }
      },
      userMessage: 'give me your synthesis of LUNR in tradingview'
    });

    assert(visualMessage, 'visual evidence block should be injected');
    assert(visualMessage.content.includes('captureMode: screen-copyfromscreen'));
    assert(visualMessage.content.includes('captureTrusted: no'));
    assert(visualMessage.content.includes('evidenceQuality: degraded-mixed-desktop'));
    assert(visualMessage.content.includes('Rule: Treat the current screenshot as degraded mixed-desktop evidence, not a trusted target-window capture.'));
    assert(visualMessage.content.includes('Rule: For TradingView or other low-UIA chart apps, do not claim precise indicator values, exact trendline coordinates, or exact support/resistance numbers unless they are directly legible in the screenshot or supplied by a stronger evidence path.'));
    assert(visualMessage.content.includes('Rule: If a detail is not directly legible, state uncertainty explicitly and offer bounded next steps.'));
  });

  await test('trusted target-window capture allows stronger direct observation wording', async () => {
    const visualMessage = await buildVisualEvidenceMessage({
      latestVisual: {
        dataURL: 'data:image/png;base64,AAAA',
        captureMode: 'window-copyfromscreen',
        captureTrusted: true,
        scope: 'window'
      },
      foreground: {
        success: true,
        processName: 'tradingview',
        title: 'TradingView - LUNR'
      },
      watcherSnapshot: {
        activeWindowElementCount: 4,
        interactiveElementCount: 2,
        namedInteractiveElementCount: 1,
        activeWindow: {
          processName: 'tradingview',
          title: 'TradingView - LUNR'
        }
      },
      userMessage: 'analyze the tradingview chart'
    });

    assert(visualMessage, 'visual evidence block should be injected');
    assert(visualMessage.content.includes('captureMode: window-copyfromscreen'));
    assert(visualMessage.content.includes('captureTrusted: yes'));
    assert(visualMessage.content.includes('evidenceQuality: trusted-target-window'));
    assert(visualMessage.content.includes('Rule: Describe directly visible facts from the current screenshot first, then clearly separate any interpretation or trading hypothesis.'));
    assert(visualMessage.content.includes('Rule: Even with trusted capture, only state precise chart indicator values when they are directly legible in the screenshot or supported by a stronger evidence path.'));
  });
}

main().catch((error) => {
  console.error('FAIL visual analysis bounds');
  console.error(error.stack || error.message);
  process.exit(1);
});