const { buildVerifyTargetHintFromAppName } = require('./app-profile');
const {
  buildTradingViewShortcutAction,
  getTradingViewShortcutKey,
  matchesTradingViewShortcutAction
} = require('./shortcut-profile');

const CREATE_ALERT_SHORTCUT = getTradingViewShortcutKey('create-alert') || 'alt+a';

function normalizeTextForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9.$]+/g, ' ')
    .trim();
}

function extractAlertPrice(userMessage = '') {
  const text = String(userMessage || '');
  const patterns = [
    /\b(?:price\s+target|target\s+price|alert\s+price|price)\s+(?:of\s+)?\$?([0-9]+(?:\.[0-9]{1,4})?)\b/i,
    /\btype\s+\$?([0-9]+(?:\.[0-9]{1,4})?)\b/i,
    /\benter\s+\$?([0-9]+(?:\.[0-9]{1,4})?)\b/i,
    /\$([0-9]+(?:\.[0-9]{1,4})?)\b/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
}

function inferTradingViewAlertIntent(userMessage = '', actions = []) {
  const raw = String(userMessage || '').trim();
  if (!raw) return null;

  const normalized = normalizeTextForMatch(raw);
  const mentionsTradingView = /\btradingview|trading view\b/i.test(raw)
    || (Array.isArray(actions) && actions.some((action) => /tradingview/i.test(String(action?.title || '')) || /tradingview/i.test(String(action?.processName || ''))));
  const mentionsAlertWorkflow = /\balert|alerts|create alert|price alert\b/i.test(raw);
  if (!mentionsTradingView || !mentionsAlertWorkflow) return null;

  const existingWorkflowSignal = Array.isArray(actions) && actions.some((action) => {
    const verifyTarget = String(action?.verify?.target || '').trim().toLowerCase();
    return matchesTradingViewShortcutAction(action, 'create-alert') || /create-alert|alert/.test(verifyTarget);
  });

  return {
    appName: 'TradingView',
    price: extractAlertPrice(raw),
    existingWorkflowSignal,
    normalizedUserMessage: normalized,
    reason: 'Open TradingView create alert workflow'
  };
}

function buildTradingViewAlertWorkflowActions(intent = {}) {
  const verifyTarget = buildVerifyTargetHintFromAppName(intent.appName || 'TradingView');
  const actions = [
    {
      type: 'bring_window_to_front',
      title: 'TradingView',
      processName: 'tradingview',
      reason: 'Focus TradingView before the alert workflow',
      verifyTarget
    },
    { type: 'wait', ms: 650 },
    buildTradingViewShortcutAction('create-alert', {
      reason: 'Open the TradingView Create Alert dialog',
      verify: {
        kind: 'dialog-visible',
        appName: 'TradingView',
        target: 'create-alert',
        keywords: ['create alert', 'alert']
      },
      verifyTarget
    }),
    { type: 'wait', ms: 220 }
  ];

  if (intent.price) {
    actions.push({
      type: 'type',
      text: intent.price,
      reason: `Enter TradingView alert price ${intent.price}`
    });
  }

  return actions;
}

function maybeRewriteTradingViewAlertWorkflow(actions, context = {}) {
  if (!Array.isArray(actions) || actions.length === 0) return null;

  const intent = inferTradingViewAlertIntent(context.userMessage || '', actions);
  if (!intent || intent.existingWorkflowSignal) return null;

  const lowSignalTypes = new Set(['bring_window_to_front', 'focus_window', 'key', 'type', 'wait', 'screenshot']);
  const lowSignal = actions.every((action) => lowSignalTypes.has(action?.type));
  const tinyOrFragmented = actions.length <= 4;
  const screenshotFirst = actions[0]?.type === 'screenshot';
  const lacksAlertSurface = !actions.some((action) => matchesTradingViewShortcutAction(action, 'create-alert') || /alert/i.test(String(action?.verify?.target || '')));

  if (!lowSignal || (!tinyOrFragmented && !screenshotFirst && !lacksAlertSurface)) {
    return null;
  }

  return buildTradingViewAlertWorkflowActions(intent);
}

module.exports = {
  extractAlertPrice,
  inferTradingViewAlertIntent,
  buildTradingViewAlertWorkflowActions,
  maybeRewriteTradingViewAlertWorkflow
};
