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

function inferPineEvidenceReadIntent(raw = '', surfaceTarget = '') {
  const normalized = normalizeTextForMatch(raw);
  if (!normalized) return false;

  const mentionsReadVerb = /\b(read|review|inspect|check|show|summarize|tell me|tell us|extract|gather)\b/.test(normalized);
  const mentionsOutputTarget = /\b(output|log|logs|errors|messages|status|compiler|compile|results|result|text|profiler|performance|timings|timing|stats|statistics|metrics|history|version|versions|revision|revisions|changes|provenance)\b/.test(normalized);
  const mentionsLineBudget = normalized.includes('500 line')
    || normalized.includes('500 lines')
    || normalized.includes('line count')
    || normalized.includes('line budget')
    || normalized.includes('script length')
    || (/\blines?\b/.test(normalized) && /\b(limit|max|maximum|cap|capped|budget)\b/.test(normalized));
  if (mentionsReadVerb && mentionsOutputTarget) return true;
  if (surfaceTarget === 'pine-editor' && mentionsReadVerb && mentionsLineBudget) return true;

  if (surfaceTarget === 'pine-profiler' && mentionsReadVerb && /\b(profiler|performance|timings|timing|stats|statistics|metrics)\b/.test(normalized)) {
    return true;
  }

  if (surfaceTarget === 'pine-version-history' && mentionsReadVerb && /\b(history|version|versions|revision|revisions|changes|provenance)\b/.test(normalized)) {
    return true;
  }

  return surfaceTarget === 'pine-logs' && /\bwhat does|what do|what is in|what's in\b/.test(normalized) && /\b(log|logs|errors|messages|status)\b/.test(normalized);
}

function buildPineReadbackStep(surfaceTarget) {
  if (surfaceTarget === 'pine-editor') {
    return {
      type: 'get_text',
      text: 'Pine Editor',
      reason: 'Read visible Pine Editor status/output or line-budget hints for bounded evidence gathering'
    };
  }

  if (surfaceTarget === 'pine-logs') {
    return {
      type: 'get_text',
      text: 'Pine Logs',
      reason: 'Read visible Pine Logs output for bounded evidence gathering'
    };
  }

  if (surfaceTarget === 'pine-profiler') {
    return {
      type: 'get_text',
      text: 'Pine Profiler',
      reason: 'Read visible Pine Profiler output for bounded evidence gathering'
    };
  }

  if (surfaceTarget === 'pine-version-history') {
    return {
      type: 'get_text',
      text: 'Pine Version History',
      reason: 'Read visible Pine Version History entries for bounded provenance gathering'
    };
  }

  return null;
}

function inferPineSurfaceTarget(raw = '') {
  const normalized = normalizeTextForMatch(raw);
  if (!normalized) return null;

  if (/\bpine logs\b/.test(normalized)) {
    return { target: 'pine-logs', kind: 'panel-visible' };
  }
  if (/\bprofiler\b/.test(normalized)) {
    return { target: 'pine-profiler', kind: 'panel-visible' };
  }
  if (/\bversion history\b/.test(normalized)) {
    return { target: 'pine-version-history', kind: 'panel-visible' };
  }
  if (/\bpine editor\b|\bpine\b|\bscript\b|\bscripts\b/.test(normalized)) {
    return { target: 'pine-editor', kind: 'panel-visible' };
  }

  return null;
}

function inferTradingViewPineIntent(userMessage = '', actions = []) {
  const raw = String(userMessage || '').trim();
  if (!raw) return null;

  const mentionsTradingView = /\btradingview|trading view\b/i.test(raw)
    || (Array.isArray(actions) && actions.some((action) => /tradingview/i.test(String(action?.title || '')) || /tradingview/i.test(String(action?.processName || ''))));
  if (!mentionsTradingView) return null;

  const mentionsPineSurface = /\bpine editor\b|\bpine logs\b|\bprofiler\b|\bversion history\b|\bpine\s+script\b|\bpine\b/i.test(raw);
  const mentionsSafeOpenIntent = /\b(open|show|focus|switch|activate|bring up|display|launch)\b/i.test(raw);
  const mentionsUnsafeAuthoringOnly = /\b(write|create|generate|build|draft)\b/i.test(raw) && !mentionsSafeOpenIntent;

  if (!mentionsPineSurface || mentionsUnsafeAuthoringOnly) {
    return null;
  }

  const openerTypes = new Set(['key', 'click', 'double_click', 'right_click']);
  const openerIndex = Array.isArray(actions)
    ? actions.findIndex((action) => openerTypes.has(action?.type))
    : -1;
  if (openerIndex < 0) return null;

  const nextAction = openerIndex >= 0 ? actions[openerIndex + 1] || null : null;
  const surface = inferPineSurfaceTarget(raw);
  if (!surface) return null;

  const wantsEvidenceReadback = inferPineEvidenceReadIntent(raw, surface.target);

  const existingWorkflowSignal = Array.isArray(actions) && actions.some((action) => /pine/.test(String(action?.verify?.target || '')));

  return {
    appName: 'TradingView',
    surfaceTarget: surface.target,
    verifyKind: surface.kind,
    openerIndex,
    existingWorkflowSignal,
    requiresObservedChange: nextAction?.type === 'type',
    wantsEvidenceReadback,
    reason: surface.target === 'pine-logs'
      ? 'Open TradingView Pine Logs with verification'
      : surface.target === 'pine-profiler'
        ? 'Open TradingView Pine Profiler with verification'
        : surface.target === 'pine-version-history'
          ? 'Open TradingView Pine version history with verification'
          : wantsEvidenceReadback
            ? 'Open TradingView Pine Editor with verification and read visible status/output'
            : 'Open TradingView Pine Editor with verification'
  };
}

function buildTradingViewPineWorkflowActions(intent = {}, actions = []) {
  if (!Array.isArray(actions) || intent.openerIndex < 0 || intent.openerIndex >= actions.length) return null;

  const opener = actions[intent.openerIndex];
  const verifyTarget = buildVerifyTargetHintFromAppName(intent.appName || 'TradingView');
  const expectedKeywords = mergeUnique([
    'pine',
    'pine editor',
    intent.surfaceTarget,
    extractTradingViewObservationKeywords(`open ${intent.surfaceTarget} in tradingview`),
    verifyTarget.pineKeywords,
    verifyTarget.dialogKeywords,
    verifyTarget.titleHints
  ]);

  const rewritten = [
    {
      type: 'bring_window_to_front',
      title: 'TradingView',
      processName: 'tradingview',
      reason: 'Focus TradingView before the Pine workflow',
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

  const hasExplicitReadbackStep = trailing.some((action) => action?.type === 'get_text' || action?.type === 'find_element');

  if (intent.wantsEvidenceReadback && !hasExplicitReadbackStep) {
    const readbackStep = buildPineReadbackStep(intent.surfaceTarget);
    if (readbackStep) trailing.push(readbackStep);
  }

  if (trailing.length > 0 && trailing[0]?.type !== 'wait') {
    rewritten.push({ type: 'wait', ms: 220 });
  }

  return rewritten.concat(trailing);
}

function maybeRewriteTradingViewPineWorkflow(actions, context = {}) {
  if (!Array.isArray(actions) || actions.length === 0) return null;

  const intent = inferTradingViewPineIntent(context.userMessage || '', actions);
  if (!intent || intent.existingWorkflowSignal || intent.openerIndex < 0) return null;

  const lowSignalTypes = new Set(['bring_window_to_front', 'focus_window', 'key', 'click', 'double_click', 'right_click', 'type', 'wait', 'screenshot', 'get_text', 'find_element']);
  const lowSignal = actions.every((action) => lowSignalTypes.has(action?.type));
  const tinyOrFragmented = actions.length <= 4;
  const screenshotFirst = actions[0]?.type === 'screenshot';
  const lacksPineVerification = !actions.some((action) => /pine/.test(String(action?.verify?.target || '')));

  if (!lowSignal || (!tinyOrFragmented && !screenshotFirst && !lacksPineVerification)) {
    return null;
  }

  return buildTradingViewPineWorkflowActions(intent, actions);
}

module.exports = {
  inferTradingViewPineIntent,
  buildTradingViewPineWorkflowActions,
  maybeRewriteTradingViewPineWorkflow
};