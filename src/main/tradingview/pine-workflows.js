const { buildVerifyTargetHintFromAppName } = require('./app-profile');
const { extractTradingViewObservationKeywords } = require('./verification');
const {
  buildTradingViewShortcutAction,
  getTradingViewShortcutKey,
  getTradingViewShortcutMatchTerms,
  messageMentionsTradingViewShortcut,
  matchesTradingViewShortcutAction
} = require('./shortcut-profile');

const PINE_EDITOR_SHORTCUT = getTradingViewShortcutKey('open-pine-editor') || 'ctrl+e';
const PINE_SURFACE_ALIASES = Object.freeze({
  'pine-logs': ['pine logs', 'compiler logs'],
  'pine-profiler': ['pine profiler', 'performance profiler'],
  'pine-version-history': ['pine version history', 'revision history', 'script history']
});

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

function getPineSurfaceMatchTerms(surfaceTarget) {
  if (surfaceTarget === 'pine-editor') {
    return mergeUnique(getTradingViewShortcutMatchTerms('open-pine-editor'));
  }
  return mergeUnique(PINE_SURFACE_ALIASES[surfaceTarget] || []);
}

function messageMentionsPineSurface(raw = '', surfaceTarget = '') {
  if (surfaceTarget === 'pine-editor') {
    return messageMentionsTradingViewShortcut(raw, 'open-pine-editor');
  }

  const normalized = normalizeTextForMatch(raw);
  if (!normalized) return false;

  return getPineSurfaceMatchTerms(surfaceTarget)
    .map((term) => normalizeTextForMatch(term))
    .some((term) => term && normalized.includes(term));
}

function getNextMeaningfulAction(actions = [], startIndex = 0) {
  if (!Array.isArray(actions)) return null;
  for (let index = Math.max(0, startIndex); index < actions.length; index++) {
    const action = actions[index];
    if (!action || typeof action !== 'object') continue;
    if (String(action.type || '').trim().toLowerCase() === 'wait') continue;
    return action;
  }
  return null;
}

function isPineAuthoringStep(action) {
  if (!action || typeof action !== 'object') return false;
  const type = String(action.type || '').trim().toLowerCase();
  const key = String(action.key || '').trim().toLowerCase();
  if (type === 'type') return true;
  if (type !== 'key') return false;
  return key === 'ctrl+a'
    || key === 'backspace'
    || key === 'delete'
    || key === 'ctrl+v'
    || key === 'ctrl+enter'
    || key === 'enter';
}

function isPineDestructiveAuthoringStep(action) {
  if (!action || typeof action !== 'object') return false;
  const type = String(action.type || '').trim().toLowerCase();
  const key = String(action.key || '').trim().toLowerCase();
  if (type !== 'key') return false;
  return key === 'ctrl+a' || key === 'backspace' || key === 'delete';
}

function isPineSelectionStep(action) {
  if (!action || typeof action !== 'object') return false;
  return String(action.type || '').trim().toLowerCase() === 'key'
    && String(action.key || '').trim().toLowerCase() === 'ctrl+a';
}

function inferPineAuthoringMode(raw = '') {
  const normalized = normalizeTextForMatch(raw);
  if (!normalized) return null;

  const explicitOverwriteIntent = /\b(overwrite|replace|rewrite current|rewrite existing|clear current|clear existing|erase current|erase existing|wipe current|wipe existing|delete current|delete existing)\b/.test(normalized)
    || (/\bfrom scratch\b/.test(normalized) && /\b(current|existing)\b/.test(normalized));

  const mentionsPineArtifact = /\bpine\b/.test(normalized)
    && /\b(script|indicator|strategy|study)\b/.test(normalized);
  const mentionsAuthoringIntent = /\b(write|create|generate|build|draft|make)\b/.test(normalized) && mentionsPineArtifact;
  if (!mentionsAuthoringIntent && !explicitOverwriteIntent) return null;

  return explicitOverwriteIntent ? 'explicit-overwrite' : 'safe-new-script';
}

const PINE_VERSION_HISTORY_SUMMARY_FIELDS = Object.freeze([
  'latest-revision-label',
  'latest-relative-time',
  'visible-revision-count',
  'visible-recency-signal',
  'top-visible-revisions'
]);

function inferPineEvidenceReadIntent(raw = '', surfaceTarget = '') {
  const normalized = normalizeTextForMatch(raw);
  if (!normalized) return false;

  const mentionsReadVerb = /\b(read|review|inspect|check|show|summarize|tell me|tell us|extract|gather)\b/.test(normalized);
  const mentionsOutputTarget = /\b(output|log|logs|errors|error|messages|status|compiler|compile|results|result|text|diagnostic|diagnostics|warning|warnings|profiler|performance|timings|timing|stats|statistics|metrics|history|version|versions|revision|revisions|changes|provenance)\b/.test(normalized);
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

function inferPineEditorEvidenceMode(raw = '') {
  const normalized = normalizeTextForMatch(raw);
  if (!normalized) return 'generic-status';

  const mentionsLineBudget = normalized.includes('500 line')
    || normalized.includes('500 lines')
    || normalized.includes('line count')
    || normalized.includes('line budget')
    || normalized.includes('script length')
    || (/\blines?\b/.test(normalized) && /\b(limit|max|maximum|cap|capped|budget)\b/.test(normalized));
  if (mentionsLineBudget) return 'line-budget';

  const mentionsDiagnostics = /\b(diagnostic|diagnostics|warning|warnings|error list|compiler errors|compile errors|errors|warnings only)\b/.test(normalized);
  if (mentionsDiagnostics) return 'diagnostics';

  const mentionsCompileResult = /\b(compile result|compile status|compiler status|compilation result|build result|no errors|compiled successfully|compile summary|summarize compile|summarize compiler)\b/.test(normalized);
  if (mentionsCompileResult) return 'compile-result';

  return 'generic-status';
}

function inferPineVersionHistoryEvidenceMode(raw = '') {
  const normalized = normalizeTextForMatch(raw);
  if (!normalized) return 'generic-provenance';

  const mentionsMetadataSummary = /\b(latest|top|visible|recent|newest|metadata|summary|summarize|revision metadata|provenance details|revision details)\b/.test(normalized);
  const mentionsRevisionList = /\b(revision|revisions|version history|history|versions|changes|provenance)\b/.test(normalized);
  if (mentionsRevisionList && mentionsMetadataSummary) return 'provenance-summary';

  return 'generic-provenance';
}

function buildPineReadbackStep(surfaceTarget, evidenceMode = null) {
  if (surfaceTarget === 'pine-editor') {
    const mode = evidenceMode || 'generic-status';
    const reason = mode === 'compile-result'
      ? 'Read visible Pine Editor compile-result text for a bounded diagnostics summary'
      : mode === 'diagnostics'
        ? 'Read visible Pine Editor diagnostics and warnings text for bounded evidence gathering'
        : mode === 'line-budget'
          ? 'Read visible Pine Editor status/output or line-budget hints for bounded evidence gathering'
          : 'Read visible Pine Editor status/output text for bounded evidence gathering';
    return {
      type: 'get_text',
      text: 'Pine Editor',
      reason,
      pineEvidenceMode: mode
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
    const mode = evidenceMode || 'generic-provenance';
    const step = {
      type: 'get_text',
      text: 'Pine Version History',
      reason: mode === 'provenance-summary'
        ? 'Read top visible Pine Version History revision metadata for a bounded structured provenance summary'
        : 'Read visible Pine Version History entries for bounded provenance gathering',
      pineEvidenceMode: mode
    };
    if (mode === 'provenance-summary') {
      step.pineSummaryFields = [...PINE_VERSION_HISTORY_SUMMARY_FIELDS];
    }
    return step;
  }

  return null;
}

function inferPineSurfaceTarget(raw = '') {
  const normalized = normalizeTextForMatch(raw);
  if (!normalized) return null;

  if (messageMentionsPineSurface(normalized, 'pine-logs')) {
    return { target: 'pine-logs', kind: 'panel-visible' };
  }
  if (messageMentionsPineSurface(normalized, 'pine-profiler') || /\bprofiler\b/.test(normalized)) {
    return { target: 'pine-profiler', kind: 'panel-visible' };
  }
  if (messageMentionsPineSurface(normalized, 'pine-version-history') || /\bversion history\b/.test(normalized)) {
    return { target: 'pine-version-history', kind: 'panel-visible' };
  }
  if (messageMentionsPineSurface(normalized, 'pine-editor') || /\bpine editor\b|\bpine\b|\bscript\b|\bscripts\b/.test(normalized)) {
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

  const mentionsPineSurface = messageMentionsPineSurface(raw, 'pine-editor')
    || messageMentionsPineSurface(raw, 'pine-logs')
    || messageMentionsPineSurface(raw, 'pine-profiler')
    || messageMentionsPineSurface(raw, 'pine-version-history')
    || /\bpine editor\b|\bpine logs\b|\bprofiler\b|\bversion history\b|\bpine\s+script\b|\bpine\b/i.test(raw);
  const mentionsSafeOpenIntent = /\b(open|show|focus|switch|activate|bring up|display|launch)\b/i.test(raw);
  const pineAuthoringMode = inferPineAuthoringMode(raw);
  const mentionsUnsafeAuthoringOnly = !!pineAuthoringMode && !mentionsSafeOpenIntent;

  if (!mentionsPineSurface || mentionsUnsafeAuthoringOnly) {
    const surface = inferPineSurfaceTarget(raw);
    if (!surface || surface.target !== 'pine-editor') return null;
    if (!Array.isArray(actions) || !actions.some((action) => matchesTradingViewShortcutAction(action, 'open-pine-editor'))) {
      return null;
    }
  }

  const openerTypes = new Set(['key', 'click', 'double_click', 'right_click']);
  const openerIndex = Array.isArray(actions)
    ? actions.findIndex((action) => openerTypes.has(action?.type))
    : -1;
  if (openerIndex < 0) return null;

  const nextAction = openerIndex >= 0 ? getNextMeaningfulAction(actions, openerIndex + 1) : null;
  const surface = inferPineSurfaceTarget(raw);
  if (!surface) return null;

  const wantsEvidenceReadback = inferPineEvidenceReadIntent(raw, surface.target);
  const pineEvidenceMode = surface.target === 'pine-editor' && wantsEvidenceReadback
    ? inferPineEditorEvidenceMode(raw)
    : surface.target === 'pine-version-history' && wantsEvidenceReadback
      ? inferPineVersionHistoryEvidenceMode(raw)
    : null;
  const requiresEditorActivation = surface.target === 'pine-editor' && isPineAuthoringStep(nextAction);
  const safeAuthoringDefault = surface.target === 'pine-editor' && pineAuthoringMode === 'safe-new-script';
  const explicitOverwriteAuthoring = surface.target === 'pine-editor' && pineAuthoringMode === 'explicit-overwrite';

  const existingWorkflowSignal = Array.isArray(actions) && actions.some((action) => /pine/.test(String(action?.verify?.target || '')));

  return {
    appName: 'TradingView',
    surfaceTarget: surface.target,
    verifyKind: surface.kind,
    openerIndex,
    existingWorkflowSignal,
    requiresObservedChange: requiresEditorActivation || nextAction?.type === 'type',
    requiresEditorActivation,
    wantsEvidenceReadback,
    pineEvidenceMode,
    safeAuthoringDefault,
    explicitOverwriteAuthoring,
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
  const surfaceTerms = getPineSurfaceMatchTerms(intent.surfaceTarget);
  const expectedKeywords = mergeUnique([
    'pine',
    'pine editor',
    intent.surfaceTarget,
    surfaceTerms,
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
        kind: intent.requiresEditorActivation ? 'editor-active' : intent.verifyKind,
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

  if (intent.safeAuthoringDefault) {
    return rewritten.concat([
      { type: 'wait', ms: 220 },
      {
        type: 'get_text',
        text: 'Pine Editor',
        reason: 'Inspect the current visible Pine Editor state before choosing a safe new-script or bounded-edit path',
        pineEvidenceMode: 'safe-authoring-inspect'
      }
    ]);
  }

  const trailing = actions.slice(intent.openerIndex + 1)
    .filter((action) => action && typeof action === 'object' && action.type !== 'screenshot');

  if (!intent.explicitOverwriteAuthoring) {
    for (let index = trailing.length - 1; index >= 0; index--) {
      if (isPineDestructiveAuthoringStep(trailing[index])) {
        trailing.splice(index, 1);
      }
    }
  }

  if (intent.surfaceTarget === 'pine-version-history' && intent.pineEvidenceMode === 'provenance-summary') {
    trailing.forEach((action) => {
      if (action?.type === 'get_text' && !Array.isArray(action.pineSummaryFields)) {
        action.pineSummaryFields = [...PINE_VERSION_HISTORY_SUMMARY_FIELDS];
      }
    });
  }

  const hasExplicitReadbackStep = trailing.some((action) => action?.type === 'get_text' || action?.type === 'find_element');

  if (intent.wantsEvidenceReadback && !hasExplicitReadbackStep) {
    const readbackStep = buildPineReadbackStep(intent.surfaceTarget, intent.pineEvidenceMode);
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

function buildTradingViewPineResumePrerequisites(actions = [], pauseIndex = -1, context = {}) {
  if (!Array.isArray(actions) || pauseIndex < 0 || pauseIndex >= actions.length) return [];

  const pausedAction = actions[pauseIndex];
  const priorActions = actions.slice(0, pauseIndex);
  const hasPriorPineEditorActivation = priorActions.some((action) =>
    matchesTradingViewShortcutAction(action, 'open-pine-editor')
    || /pine-editor/.test(String(action?.verify?.target || ''))
  );

  if (!hasPriorPineEditorActivation) {
    return [];
  }

  const resumeNeedsEditor = isPineAuthoringStep(pausedAction)
    || String(pausedAction?.type || '').trim().toLowerCase() === 'type';
  if (!resumeNeedsEditor) {
    return [];
  }

  const verifyTarget = buildVerifyTargetHintFromAppName('TradingView');
  const expectedKeywords = mergeUnique([
    'pine',
    'pine editor',
    'script',
    verifyTarget.pineKeywords,
    verifyTarget.dialogKeywords,
    verifyTarget.titleHints
  ]);

  const titleHint = String(context.lastTargetWindowProfile?.title || '').trim() || 'TradingView';
  const processName = String(context.lastTargetWindowProfile?.processName || '').trim() || 'tradingview';
  const prerequisites = [
    {
      type: 'bring_window_to_front',
      title: titleHint,
      processName,
      reason: 'Re-focus TradingView before resuming Pine authoring after confirmation',
      verifyTarget
    },
    { type: 'wait', ms: 650 },
    buildTradingViewShortcutAction('open-pine-editor', {
      reason: 'Re-open or re-activate TradingView Pine Editor after confirmation before continuing authoring',
      verify: {
        kind: 'editor-active',
        appName: 'TradingView',
        target: 'pine-editor',
        keywords: expectedKeywords,
        requiresObservedChange: true
      },
      verifyTarget
    })
  ].filter(Boolean);

  if (prerequisites.length > 0) {
    prerequisites.push({ type: 'wait', ms: 220 });
  }

  const hadSelectionBeforePause = priorActions.some((action) => isPineSelectionStep(action));
  if (isPineDestructiveAuthoringStep(pausedAction) && hadSelectionBeforePause) {
    prerequisites.push({
      type: 'key',
      key: 'ctrl+a',
      reason: 'Re-select current Pine Editor contents after confirmation before destructive edit'
    });
    prerequisites.push({ type: 'wait', ms: 120 });
  }

  return prerequisites;
}

module.exports = {
  buildTradingViewPineResumePrerequisites,
  inferTradingViewPineIntent,
  buildTradingViewPineWorkflowActions,
  maybeRewriteTradingViewPineWorkflow,
  inferPineVersionHistoryEvidenceMode
};
