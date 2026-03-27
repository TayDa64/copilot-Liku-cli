const { buildVerifyTargetHintFromAppName } = require('./app-profile');
const { extractTradingViewObservationKeywords } = require('./verification');

function normalizeTextForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function mergeUnique(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : [values])
    .flat()
    .map((value) => String(value || '').trim())
    .filter(Boolean)));
}

function inferTradingViewDomIntent(userMessage = '', actions = []) {
  const raw = String(userMessage || '').trim();
  if (!raw) return null;

  const normalized = normalizeTextForMatch(raw);
  const mentionsTradingView = /\btradingview|trading view\b/i.test(raw)
    || (Array.isArray(actions) && actions.some((action) => /tradingview/i.test(String(action?.title || '')) || /tradingview/i.test(String(action?.processName || ''))));
  const mentionsDomSurface = /\bdom\b|\bdepth of market\b|\border book\b|\btrading panel\b|\btier 2\b|\blevel 2\b/i.test(raw);
  const mentionsSafeOpenIntent = /\b(open|show|focus|switch|activate|bring up|display|launch)\b/i.test(raw);
  const mentionsRiskyTradeAction = /\b(buy|sell|flatten|reverse|place order|market order|limit order|stop order|qty|quantity|cancel all|cxl all)\b/i.test(normalized);

  if (!mentionsTradingView || !mentionsDomSurface || !mentionsSafeOpenIntent || mentionsRiskyTradeAction) return null;

  const openerTypes = new Set(['key', 'click', 'double_click', 'right_click']);
  const openerIndex = Array.isArray(actions)
    ? actions.findIndex((action) => openerTypes.has(action?.type))
    : -1;
  if (openerIndex < 0) return null;

  const existingWorkflowSignal = Array.isArray(actions) && actions.some((action) => /dom/.test(String(action?.verify?.target || '')));

  return {
    appName: 'TradingView',
    surfaceTarget: 'dom-panel',
    verifyKind: 'panel-visible',
    openerIndex,
    existingWorkflowSignal,
    reason: 'Open TradingView Depth of Market with verification'
  };
}

function buildTradingViewDomWorkflowActions(intent = {}, actions = []) {
  if (!Array.isArray(actions) || intent.openerIndex < 0 || intent.openerIndex >= actions.length) return null;

  const opener = actions[intent.openerIndex];
  const verifyTarget = buildVerifyTargetHintFromAppName(intent.appName || 'TradingView');
  const expectedKeywords = mergeUnique([
    'dom',
    'depth of market',
    'order book',
    'trading panel',
    intent.surfaceTarget,
    extractTradingViewObservationKeywords('open tradingview depth of market order book panel'),
    verifyTarget.domKeywords,
    verifyTarget.titleHints
  ]);

  const rewritten = [
    {
      type: 'bring_window_to_front',
      title: 'TradingView',
      processName: 'tradingview',
      reason: 'Focus TradingView before the DOM workflow',
      verifyTarget
    },
    { type: 'wait', ms: 650 },
    {
      ...opener,
      reason: opener?.reason || intent.reason,
      verify: opener?.verify || {
        kind: intent.verifyKind,
        appName: 'TradingView',
        target: intent.surfaceTarget,
        keywords: expectedKeywords
      },
      verifyTarget
    }
  ];

  if (!rewritten[2].verifyTarget) {
    rewritten[2].verifyTarget = verifyTarget;
  }

  const trailing = actions.slice(intent.openerIndex + 1)
    .filter((action) => action && typeof action === 'object' && action.type !== 'screenshot');

  if (trailing.length > 0 && trailing[0]?.type !== 'wait') {
    rewritten.push({ type: 'wait', ms: 220 });
  }

  return rewritten.concat(trailing);
}

function maybeRewriteTradingViewDomWorkflow(actions, context = {}) {
  if (!Array.isArray(actions) || actions.length === 0) return null;

  const intent = inferTradingViewDomIntent(context.userMessage || '', actions);
  if (!intent || intent.existingWorkflowSignal || intent.openerIndex < 0) return null;

  const lowSignalTypes = new Set(['bring_window_to_front', 'focus_window', 'key', 'click', 'double_click', 'right_click', 'type', 'wait', 'screenshot']);
  const lowSignal = actions.every((action) => lowSignalTypes.has(action?.type));
  const tinyOrFragmented = actions.length <= 4;
  const screenshotFirst = actions[0]?.type === 'screenshot';
  const lacksDomVerification = !actions.some((action) => /dom/.test(String(action?.verify?.target || '')));

  if (!lowSignal || (!tinyOrFragmented && !screenshotFirst && !lacksDomVerification)) {
    return null;
  }

  return buildTradingViewDomWorkflowActions(intent, actions);
}

module.exports = {
  inferTradingViewDomIntent,
  buildTradingViewDomWorkflowActions,
  maybeRewriteTradingViewDomWorkflow
};