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

function inferPaperSurfaceTarget(raw = '') {
  const normalized = normalizeTextForMatch(raw);
  if (!normalized) return null;

  if (/\bdom\b|\bdepth of market\b|\border book\b|\btier 2\b|\blevel 2\b/.test(normalized)) {
    return { target: 'paper-trading-dom', kind: 'panel-visible' };
  }
  if (/\baccount manager\b|\bpaper account\b|\baccount\b/.test(normalized)) {
    return { target: 'paper-trading-account', kind: 'panel-visible' };
  }
  return { target: 'paper-trading-panel', kind: 'panel-visible' };
}

function inferTradingViewPaperIntent(userMessage = '', actions = []) {
  const raw = String(userMessage || '').trim();
  if (!raw) return null;

  const mentionsTradingView = /\btradingview|trading view\b/i.test(raw)
    || (Array.isArray(actions) && actions.some((action) => /tradingview/i.test(String(action?.title || '')) || /tradingview/i.test(String(action?.processName || ''))));
  const mentionsPaperSurface = /\bpaper trading\b|\bpaper account\b|\bdemo trading\b|\bsimulated\b|\bpractice\b/i.test(raw);
  const mentionsSafeOpenIntent = /\b(open|show|focus|switch|activate|bring up|display|launch|connect|attach)\b/i.test(raw);
  const mentionsRiskyTradeAction = /\b(buy|sell|flatten|reverse|place order|market order|limit order|stop order|qty|quantity|cancel all|cxl all)\b/i.test(normalizeTextForMatch(raw));

  if (!mentionsTradingView || !mentionsPaperSurface || !mentionsSafeOpenIntent || mentionsRiskyTradeAction) {
    return null;
  }

  const openerTypes = new Set(['key', 'click', 'double_click', 'right_click']);
  const openerIndex = Array.isArray(actions)
    ? actions.findIndex((action) => openerTypes.has(action?.type))
    : -1;
  if (openerIndex < 0) return null;

  const nextAction = openerIndex >= 0 ? actions[openerIndex + 1] || null : null;
  const surface = inferPaperSurfaceTarget(raw);
  if (!surface) return null;

  const existingWorkflowSignal = Array.isArray(actions) && actions.some((action) => /paper-trading/.test(String(action?.verify?.target || '')));

  return {
    appName: 'TradingView',
    surfaceTarget: surface.target,
    verifyKind: surface.kind,
    openerIndex,
    existingWorkflowSignal,
    requiresObservedChange: nextAction?.type === 'type',
    reason: surface.target === 'paper-trading-dom'
      ? 'Open TradingView Paper Trading Depth of Market with verification'
      : surface.target === 'paper-trading-account'
        ? 'Open TradingView Paper Trading account surface with verification'
        : 'Open TradingView Paper Trading panel with verification'
  };
}

function buildTradingViewPaperWorkflowActions(intent = {}, actions = []) {
  if (!Array.isArray(actions) || intent.openerIndex < 0 || intent.openerIndex >= actions.length) return null;

  const opener = actions[intent.openerIndex];
  const verifyTarget = buildVerifyTargetHintFromAppName(intent.appName || 'TradingView');
  const expectedKeywords = mergeUnique([
    'paper trading',
    'paper account',
    'demo trading',
    'simulated',
    'trading panel',
    intent.surfaceTarget,
    extractTradingViewObservationKeywords(`open ${intent.surfaceTarget} in tradingview paper trading`),
    verifyTarget.paperKeywords,
    intent.surfaceTarget === 'paper-trading-dom' ? verifyTarget.domKeywords : [],
    verifyTarget.titleHints
  ]);

  const rewritten = [
    {
      type: 'bring_window_to_front',
      title: 'TradingView',
      processName: 'tradingview',
      reason: 'Focus TradingView before the Paper Trading workflow',
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
        keywords: expectedKeywords,
        requiresObservedChange: !!intent.requiresObservedChange
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

function maybeRewriteTradingViewPaperWorkflow(actions, context = {}) {
  if (!Array.isArray(actions) || actions.length === 0) return null;

  const intent = inferTradingViewPaperIntent(context.userMessage || '', actions);
  if (!intent || intent.existingWorkflowSignal || intent.openerIndex < 0) return null;

  const lowSignalTypes = new Set(['bring_window_to_front', 'focus_window', 'key', 'click', 'double_click', 'right_click', 'type', 'wait', 'screenshot']);
  const lowSignal = actions.every((action) => lowSignalTypes.has(action?.type));
  const tinyOrFragmented = actions.length <= 4;
  const screenshotFirst = actions[0]?.type === 'screenshot';
  const lacksPaperVerification = !actions.some((action) => /paper-trading/.test(String(action?.verify?.target || '')));

  if (!lowSignal || (!tinyOrFragmented && !screenshotFirst && !lacksPaperVerification)) {
    return null;
  }

  return buildTradingViewPaperWorkflowActions(intent, actions);
}

module.exports = {
  inferTradingViewPaperIntent,
  buildTradingViewPaperWorkflowActions,
  maybeRewriteTradingViewPaperWorkflow
};