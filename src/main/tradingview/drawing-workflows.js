const { buildVerifyTargetHintFromAppName } = require('./app-profile');
const { extractTradingViewObservationKeywords } = require('./verification');
const {
  getTradingViewShortcut,
  matchesTradingViewShortcutAction,
  resolveTradingViewShortcutId
} = require('./shortcut-profile');

const DRAWING_NAMES = [
  'trend line',
  'ray',
  'extended line',
  'pitchfork',
  'fibonacci',
  'fib',
  'brush',
  'rectangle',
  'ellipse',
  'path',
  'polyline',
  'measure',
  'anchored text',
  'note',
  'anchored vwap',
  'anchored volume profile',
  'fixed range volume profile'
];

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

function getTradingViewShortcutMatchTerms(id) {
  const shortcut = getTradingViewShortcut(id);
  return mergeUnique([
    shortcut?.id,
    shortcut?.surface,
    shortcut?.aliases
  ]);
}

function messageMentionsTradingViewShortcut(value = '', id) {
  const normalizedMessage = normalizeTextForMatch(value);
  const resolvedId = resolveTradingViewShortcutId(id);
  if (!normalizedMessage || !resolvedId) return false;

  return getTradingViewShortcutMatchTerms(resolvedId)
    .map((term) => normalizeTextForMatch(term))
    .some((term) => term && normalizedMessage.includes(term));
}

function normalizeDrawingName(value = '') {
  const normalized = normalizeTextForMatch(value);
  if (!normalized) return null;
  const exact = DRAWING_NAMES.find((candidate) => normalized === candidate);
  if (exact) return exact;
  const partial = DRAWING_NAMES.find((candidate) => normalized.includes(candidate));
  return partial || null;
}

function extractRequestedDrawingName(userMessage = '') {
  const raw = String(userMessage || '');
  const quoted = raw.match(/["“”'`]{1}([^"“”'`]{2,80})["“”'`]{1}/);
  const quotedName = normalizeDrawingName(quoted?.[1] || '');
  if (quotedName) return quotedName;

  const explicitPatterns = [
    /\b(?:search\s+for|find|select|choose|pick|use|open|show|focus)\s+([a-z0-9][a-z0-9 +\-./()]{2,80}?)(?=\s+(?:in|on)\s+tradingview\b|\s+(?:drawing|drawings|tool|tools|object tree)\b|\s*$)/i,
    /\b(?:drawing|drawings|tool|tools)\s+(?:named\s+)?([a-z0-9][a-z0-9 +\-./()]{2,80}?)(?=\s+(?:in|on)\s+tradingview\b|\s*$)/i
  ];

  for (const pattern of explicitPatterns) {
    const match = raw.match(pattern);
    const normalized = normalizeDrawingName(match?.[1] || '');
    if (normalized) return normalized;
  }

  return normalizeDrawingName(raw);
}

function resolveDrawingSurfaceTarget(raw = '', openerAction = null, drawingName = null) {
  const normalized = normalizeTextForMatch(raw);
  const opensObjectTree = /\bobject tree\b/i.test(raw) || messageMentionsTradingViewShortcut(raw, 'open-object-tree');
  const mentionsDrawingTools = /\bdrawing tools|drawings panel|drawing panel|drawings toolbar|drawing toolbar\b/i.test(raw);
  const openerUsesObjectTreeShortcut = matchesTradingViewShortcutAction(openerAction?.action, 'open-object-tree');
  const hasTypedFollowUp = openerAction?.nextAction?.type === 'type';

  if ((opensObjectTree || openerUsesObjectTreeShortcut) && hasTypedFollowUp) {
    return { target: 'object-tree-search', kind: 'input-surface-open' };
  }
  if (opensObjectTree || openerUsesObjectTreeShortcut) {
    return { target: 'object-tree', kind: 'panel-visible' };
  }
  if ((mentionsDrawingTools || drawingName) && hasTypedFollowUp) {
    return { target: 'drawing-search', kind: 'input-surface-open' };
  }
  if (mentionsDrawingTools || drawingName || /\bdrawing|drawings\b/.test(normalized)) {
    return { target: 'drawing-tools', kind: 'panel-visible' };
  }

  return null;
}

function inferTradingViewDrawingIntent(userMessage = '', actions = []) {
  const raw = String(userMessage || '').trim();
  if (!raw) return null;

  const mentionsTradingView = /\btradingview|trading view\b/i.test(raw)
    || (Array.isArray(actions) && actions.some((action) => /tradingview/i.test(String(action?.title || '')) || /tradingview/i.test(String(action?.processName || ''))));
  if (!mentionsTradingView) return null;

  const drawingName = extractRequestedDrawingName(raw);
  const mentionsObjectTree = /\bobject tree\b/i.test(raw) || messageMentionsTradingViewShortcut(raw, 'open-object-tree');
  const mentionsDrawingSurface = /\bdrawing|drawings|trend\s*line|ray|pitchfork|fibonacci|fib|brush|rectangle|ellipse|path|polyline|measure|anchored text|note\b/i.test(raw);
  const mentionsSafeOpenIntent = /\b(open|show|focus|switch|select|choose|pick|search|find|use|activate)\b/i.test(raw);
  const mentionsUnsafePlacement = /\bdraw\b/i.test(raw) && !mentionsObjectTree && !mentionsSafeOpenIntent;

  if (!mentionsObjectTree && (!mentionsDrawingSurface || mentionsUnsafePlacement)) {
    return null;
  }

  const openerTypes = new Set(['key', 'click', 'double_click', 'right_click']);
  const openerIndex = Array.isArray(actions)
    ? actions.findIndex((action) => openerTypes.has(action?.type))
    : -1;
  const openerAction = openerIndex >= 0 ? actions[openerIndex] || null : null;
  const nextAction = openerIndex >= 0 ? actions[openerIndex + 1] || null : null;
  const surface = resolveDrawingSurfaceTarget(raw, { action: openerAction, nextAction }, drawingName);
  if (!surface) return null;

  const existingWorkflowSignal = Array.isArray(actions) && actions.some((action) => /drawing|object-tree/.test(String(action?.verify?.target || '')));

  return {
    appName: 'TradingView',
    drawingName,
    surfaceTarget: surface.target,
    verifyKind: surface.kind,
    openerIndex,
    existingWorkflowSignal,
    reason: surface.target === 'object-tree'
      ? 'Open TradingView Object Tree with verification'
      : surface.target === 'object-tree-search'
        ? 'Open TradingView Object Tree search with verification'
        : surface.target === 'drawing-search'
          ? `Open TradingView drawing search${drawingName ? ` for ${drawingName}` : ''} with verification`
          : 'Open TradingView drawing tools with verification'
  };
}

function buildTradingViewDrawingWorkflowActions(intent = {}, actions = []) {
  if (!Array.isArray(actions) || intent.openerIndex < 0 || intent.openerIndex >= actions.length) return null;

  const opener = actions[intent.openerIndex];
  const verifyTarget = buildVerifyTargetHintFromAppName(intent.appName || 'TradingView');
  const expectedKeywords = mergeUnique([
    'drawing',
    'drawings',
    'drawing tools',
    'object tree',
    intent.surfaceTarget,
    intent.drawingName,
    extractTradingViewObservationKeywords(`open ${intent.surfaceTarget} ${intent.drawingName || ''} in tradingview`),
    verifyTarget.chartKeywords,
    verifyTarget.drawingKeywords,
    verifyTarget.dialogKeywords
  ]);

  const rewritten = [
    {
      type: 'bring_window_to_front',
      title: 'TradingView',
      processName: 'tradingview',
      reason: 'Focus TradingView before the drawing workflow',
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

function maybeRewriteTradingViewDrawingWorkflow(actions, context = {}) {
  if (!Array.isArray(actions) || actions.length === 0) return null;

  const intent = inferTradingViewDrawingIntent(context.userMessage || '', actions);
  if (!intent || intent.existingWorkflowSignal || intent.openerIndex < 0) return null;

  const lowSignalTypes = new Set(['bring_window_to_front', 'focus_window', 'key', 'click', 'double_click', 'right_click', 'type', 'wait', 'screenshot']);
  const lowSignal = actions.every((action) => lowSignalTypes.has(action?.type));
  const tinyOrFragmented = actions.length <= 4;
  const screenshotFirst = actions[0]?.type === 'screenshot';
  const lacksDrawingVerification = !actions.some((action) => /drawing|object-tree/.test(String(action?.verify?.target || '')));

  if (!lowSignal || (!tinyOrFragmented && !screenshotFirst && !lacksDrawingVerification)) {
    return null;
  }

  return buildTradingViewDrawingWorkflowActions(intent, actions);
}

module.exports = {
  extractRequestedDrawingName,
  inferTradingViewDrawingIntent,
  buildTradingViewDrawingWorkflowActions,
  maybeRewriteTradingViewDrawingWorkflow
};
