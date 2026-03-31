const { buildVerifyTargetHintFromAppName } = require('./app-profile');
const { extractTradingViewObservationKeywords } = require('./verification');
const { buildPineClipboardPreparationCommandFromCanonicalState } = require('./pine-script-state');
const {
  buildTradingViewShortcutAction,
  buildTradingViewShortcutRoute,
  getTradingViewShortcutMatchTerms,
  messageMentionsTradingViewShortcut,
  matchesTradingViewShortcutAction
} = require('./shortcut-profile');
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
    || key === 'ctrl+s'
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

function allowsSyntheticPineAuthoringOpen(actions = []) {
  if (!Array.isArray(actions) || actions.length === 0) return true;

  const lowSignalTypes = new Set([
    'focus_window',
    'bring_window_to_front',
    'restore_window',
    'wait',
    'screenshot',
    'get_text',
    'find_element'
  ]);

  return actions.every((action) => lowSignalTypes.has(getNormalizedActionType(action)));
}

function cloneAction(action) {
  try {
    return JSON.parse(JSON.stringify(action));
  } catch {
    return { ...action };
  }
}

function getNormalizedActionType(action) {
  return String(action?.type || '').trim().toLowerCase();
}

function sanitizePineScriptText(value = '') {
  let raw = String(value || '');
  if (!raw) return raw;

  raw = raw.replace(/^\uFEFF/, '');
  raw = raw.replace(/(^|[\r\n])\s*(?:pine\s*editor|ine\s*editor)\s*(?=\/\/\s*@version\b)/ig, '$1');

  const versionMatch = raw.match(/\/\/\s*@version\s*=\s*\d+\b/i);
  if (versionMatch && versionMatch.index > 0) {
    const prefix = raw.slice(0, versionMatch.index);
    if (/\b(?:pine\s*editor|ine\s*editor)\b/i.test(prefix)) {
      raw = raw.slice(versionMatch.index);
    }
  }

  return raw;
}

function containsPineScriptPayloadText(value = '') {
  const text = sanitizePineScriptText(value);
  return /\/\/\s*@version\s*=\s*\d+|\b(?:indicator|strategy|library)\s*\(|\bplot(?:shape|char)?\s*\(|\binput(?:\.[a-z]+)?\s*\(|\balertcondition\s*\(/i.test(text);
}

function sanitizePineAuthoringAction(action) {
  if (!action || typeof action !== 'object') return action;

  const cloned = cloneAction(action);
  const type = getNormalizedActionType(cloned);

  if (type === 'type' && typeof cloned.text === 'string') {
    cloned.text = sanitizePineScriptText(cloned.text);
  }

  if (type === 'run_command' && typeof cloned.command === 'string' && /\bset-clipboard\b/i.test(cloned.command)) {
    cloned.command = sanitizePineScriptText(cloned.command);
  }

  return cloned;
}

function isPineClipboardPreparationAction(action) {
  return getNormalizedActionType(action) === 'run_command'
    && /\bset-clipboard\b/i.test(String(action?.command || ''))
    && containsPineScriptPayloadText(String(action?.command || ''));
}

function isPineScriptTypeAction(action) {
  if (getNormalizedActionType(action) !== 'type') return false;
  return containsPineScriptPayloadText(String(action?.text || ''));
}

function isPinePasteStep(action) {
  return getNormalizedActionType(action) === 'key'
    && String(action?.key || '').trim().toLowerCase() === 'ctrl+v';
}

function isPineAddToChartStep(action) {
  if (!action || typeof action !== 'object') return false;
  const type = getNormalizedActionType(action);
  const key = String(action?.key || '').trim().toLowerCase();
  const combined = [action.reason, action.text]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
  return (type === 'key' && key === 'ctrl+enter')
    || /\b(add|apply|run|load|put)\b.{0,20}\bchart\b/i.test(combined);
}

function isPineSaveStep(action) {
  if (!action || typeof action !== 'object') return false;
  const type = getNormalizedActionType(action);
  const key = String(action?.key || '').trim().toLowerCase();
  const combined = [action.reason, action.text]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
  return (type === 'key' && key === 'ctrl+s')
    || /\bsave\b.{0,20}\bscript\b/i.test(combined);
}

function extractPineDeclarationTitle(text = '') {
  const match = String(text || '').match(/\b(?:indicator|strategy|library)\s*\(\s*["'`](.*?)["'`]/i);
  return String(match?.[1] || '').trim();
}

function sanitizePineScriptName(value = '') {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .trim()
    .slice(0, 120);
}

function inferSafePineScriptName(actions = [], raw = '') {
  const source = Array.isArray(actions) ? actions : [];
  for (const action of source) {
    const canonicalTitle = sanitizePineScriptName(action?.pineCanonicalState?.scriptTitle || '');
    if (canonicalTitle) return canonicalTitle;
    const type = getNormalizedActionType(action);
    if (type === 'type') {
      const title = sanitizePineScriptName(extractPineDeclarationTitle(sanitizePineScriptText(action.text)));
      if (title) return title;
    }
    if (type === 'run_command') {
      const title = sanitizePineScriptName(extractPineDeclarationTitle(sanitizePineScriptText(action.command)));
      if (title) return title;
    }
  }

  const messageTitle = sanitizePineScriptName(String(raw || '').match(/\b(?:called|named)\s+["'`](.*?)["'`]/i)?.[1] || '');
  if (messageTitle) return messageTitle;

  return 'Liku Pine Script';
}

function extractPineCanonicalState(actions = []) {
  for (const action of Array.isArray(actions) ? actions : []) {
    const canonicalState = action?.pineCanonicalState;
    if (canonicalState && typeof canonicalState === 'object') {
      return {
        ...canonicalState,
        scriptTitle: sanitizePineScriptName(canonicalState.scriptTitle || '')
      };
    }
  }
  return null;
}

function hasValidatedCanonicalPineState(actions = []) {
  const canonicalState = extractPineCanonicalState(actions);
  return !!(
    canonicalState
    && String(canonicalState.sourcePath || '').trim()
    && canonicalState?.validation?.valid === true
  );
}

function buildCanonicalPineReplacementPayloadSteps(actions = []) {
  const canonicalState = extractPineCanonicalState(actions);
  if (!canonicalState?.sourcePath || canonicalState?.validation?.valid === false) return null;

  const clipboardCommand = buildPineClipboardPreparationCommandFromCanonicalState(canonicalState);
  if (!clipboardCommand) return null;
  const canonicalLabel = [canonicalState.id, canonicalState.sourceHash ? canonicalState.sourceHash.slice(0, 12) : '']
    .filter(Boolean)
    .join(' / ');

  return [
    {
      type: 'key',
      key: 'ctrl+a',
      reason: 'Select the fresh Pine starter script before replacing it with the canonical local Pine artifact'
    },
    { type: 'wait', ms: 120 },
    {
      type: 'key',
      key: 'backspace',
      reason: 'Clear the fresh Pine starter script before pasting the canonical local Pine artifact'
    },
    { type: 'wait', ms: 120 },
    {
      type: 'run_command',
      shell: 'powershell',
      command: clipboardCommand,
      reason: canonicalLabel
        ? `Load the validated canonical Pine script (${canonicalLabel}) from the persisted local state file into the clipboard`
        : 'Load the validated canonical Pine script from the persisted local state file into the clipboard',
      pineCanonicalState: canonicalState
    },
    { type: 'wait', ms: 120 },
    {
      type: 'key',
      key: 'ctrl+v',
      reason: canonicalLabel
        ? `Paste the validated canonical Pine script (${canonicalLabel}) from the persisted local state file into the Pine Editor`
        : 'Paste the validated canonical Pine script from the persisted local state file into the Pine Editor',
      pineCanonicalState: canonicalState
    }
  ];
}

function shouldAutoAddPineScriptToChart(raw = '', actions = []) {
  if (Array.isArray(actions) && actions.some((action) => isPineAddToChartStep(action))) {
    return true;
  }

  const normalized = normalizeTextForMatch(raw);
  if (!normalized) return false;

  return /\btradingview\b/.test(normalized)
    && /\b(write|create|generate|build|draft|make)\b/.test(normalized)
    && /\bpine\b/.test(normalized);
}

function buildSafePineAuthoringContinuationSteps(actions = [], intent = {}, raw = '') {
  const sourceActions = intent.syntheticOpener
    ? actions.slice()
    : actions.slice(Math.max(0, Number(intent.openerIndex || 0)) + 1);

  const filtered = sourceActions.filter((action) => {
    const type = getNormalizedActionType(action);
    return action && typeof action === 'object' && type && type !== 'wait' && type !== 'screenshot';
  });

  const clipboardPrepSteps = filtered.filter((action) => isPineClipboardPreparationAction(action)).map(sanitizePineAuthoringAction);
  const typingSteps = filtered.filter((action) => isPineScriptTypeAction(action)).map(sanitizePineAuthoringAction);
  const pasteSteps = filtered.filter((action) => isPinePasteStep(action)).map(cloneAction);
  const saveSteps = filtered.filter((action) => isPineSaveStep(action)).map(cloneAction);
  const addToChartSteps = filtered.filter((action) => isPineAddToChartStep(action)).map(cloneAction);

  const canonicalReplacementPayloadSteps = buildCanonicalPineReplacementPayloadSteps(filtered);
  const payloadSteps = canonicalReplacementPayloadSteps ? canonicalReplacementPayloadSteps.slice() : [];
  if (!canonicalReplacementPayloadSteps) {
    if (clipboardPrepSteps.length > 0) {
      payloadSteps.push(...clipboardPrepSteps);
      if (pasteSteps.length > 0) {
        payloadSteps.push(...pasteSteps);
      } else {
        payloadSteps.push({
          type: 'key',
          key: 'ctrl+v',
          reason: 'Paste the prepared Pine script into the Pine Editor'
        });
      }
    } else if (typingSteps.length > 0) {
      payloadSteps.push(...typingSteps);
    } else if (pasteSteps.length > 0) {
      payloadSteps.push(...pasteSteps);
    }
  }

  if (payloadSteps.length === 0) {
    return [];
  }

  const derivedScriptName = inferSafePineScriptName(payloadSteps, raw);

  const applyContinuationSteps = [];
  if (addToChartSteps.length > 0) {
    applyContinuationSteps.push(...addToChartSteps);
  } else if (shouldAutoAddPineScriptToChart(raw, filtered)) {
    applyContinuationSteps.push(...(buildTradingViewShortcutRoute('add-pine-to-chart', {
      reason: 'Add the saved Pine script to the chart'
    }) || [
      {
        type: 'key',
        key: 'ctrl+enter',
        reason: 'Add the saved Pine script to the chart'
      },
      { type: 'wait', ms: 220 }
    ]));
  }

  if (applyContinuationSteps.some((action) => isPineAddToChartStep(action))) {
    applyContinuationSteps.push(
      { type: 'wait', ms: 300 },
      {
        type: 'get_text',
        text: 'Pine Editor',
        reason: 'Read visible Pine Editor compile/apply result text after adding the script to the chart',
        pineEvidenceMode: 'compile-result',
        failOnPineLifecycleStates: ['editor-target-corrupt']
      }
    );
  }

  const saveFollowUpActions = [
    ...payloadSteps,
    { type: 'wait', ms: 220 },
    ...(saveSteps.length > 0
      ? saveSteps
      : ((buildTradingViewShortcutRoute('save-pine-script', {
        reason: 'Save the freshly created Pine script before adding it to the chart',
        finalWaitMs: 0
      })) || [
        {
          type: 'key',
          key: 'ctrl+s',
          reason: 'Save the freshly created Pine script before adding it to the chart'
        }
      ])),
    { type: 'wait', ms: 280 },
    {
      type: 'get_text',
      text: 'Pine Editor',
      reason: 'Verify visible Pine save-state evidence before adding the script to the chart',
      pineEvidenceMode: 'save-status',
      continueOnPineLifecycleState: 'saved-state-verified',
      continueActions: applyContinuationSteps,
      continueActionsByPineLifecycleState: {
        'save-required-before-apply': [
          { type: 'wait', ms: 180 },
          {
            type: 'type',
            text: derivedScriptName,
            reason: `Provide a Pine script name in the TradingView first-save flow: ${derivedScriptName}`
          },
          { type: 'wait', ms: 120 },
          {
            type: 'key',
            key: 'enter',
            reason: 'Confirm the TradingView Pine first-save flow after entering the script name'
          },
          { type: 'wait', ms: 450 },
          {
            type: 'get_text',
            text: 'Pine Editor',
            reason: 'Re-verify visible Pine save-state evidence after naming the script',
            pineEvidenceMode: 'save-status',
            continueOnPineLifecycleState: 'saved-state-verified',
            continueActions: applyContinuationSteps,
            haltOnPineLifecycleStateMismatch: true,
            pineLifecycleMismatchReasons: {
              'save-required-before-apply': 'TradingView still shows save-required state after naming the script; stop before applying it to the chart.',
              'editor-target-corrupt': 'Visible Pine output suggests editor-target corruption during save; stop before applying the script.',
              '': 'The Pine save state could not be verified after naming the script; do not add it to the chart yet.'
            }
          }
        ]
      },
      haltOnPineLifecycleStateMismatch: true,
      pineLifecycleMismatchReasons: {
        'save-required-before-apply': 'Visible save confirmation was not observed after saving the Pine script; do not add it to the chart yet.',
        'editor-target-corrupt': 'Visible Pine output suggests editor-target corruption; stop before applying the script.',
        '': 'The Pine save state could not be verified; do not add the script to the chart yet.'
      }
    }
  ];

  return [
    ...(buildTradingViewShortcutRoute('new-pine-indicator', {
      reason: 'Create a fresh Pine indicator before inserting the prepared script'
    }) || []),
    { type: 'wait', ms: 220 },
    {
      type: 'get_text',
      text: 'Pine Editor',
      reason: 'Verify that a fresh Pine script surface is active before inserting the prepared script',
      pineEvidenceMode: 'safe-authoring-inspect',
      continueOnPineEditorState: 'empty-or-starter',
      continueActions: saveFollowUpActions,
      haltOnPineEditorStateMismatch: true,
      pineStateMismatchReasons: {
        'existing-script-visible': 'Creating a fresh Pine indicator did not yield a clean starter script; stop rather than overwrite visible script content.',
        'unknown-visible-state': 'The fresh Pine indicator state is ambiguous; inspect further before inserting the script.',
        '': 'The fresh Pine indicator state is ambiguous; inspect further before inserting the script.'
      }
    }
  ];
}

function actionLooksLikePineEditorOpenIntent(action) {
  if (!action || typeof action !== 'object') return false;
  if (matchesTradingViewShortcutAction(action, 'open-pine-editor')) return true;
  if (String(action?.tradingViewShortcut?.id || '').trim().toLowerCase() === 'open-pine-editor') return true;

  const type = String(action.type || '').trim().toLowerCase();
  if (!['key', 'type', 'click', 'double_click', 'right_click', 'click_element', 'find_element'].includes(type)) {
    return false;
  }

  if (type === 'key' && String(action.key || '').trim().toLowerCase() === 'ctrl+e') {
    return true;
  }

  const combined = [action.reason, action.text, action.title, action.key]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');

  return /pine editor|pine script editor|open pine editor/i.test(combined);
}

function actionLooksLikeUnverifiedPineAuthoringEdit(action) {
  if (!action || typeof action !== 'object') return false;

  const type = String(action.type || '').trim().toLowerCase();
  const key = String(action.key || '').trim().toLowerCase();
  const command = String(action.command || '').trim();
  const combined = [
    action.reason,
    action.text,
    action.title,
    command
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');

  if (type === 'run_command' && /\bset-clipboard\b/i.test(command) && /\b(?:indicator|strategy|library)\s*\(/i.test(command)) {
    return true;
  }
  if (type === 'run_command' && /\bget-clipboard\b/i.test(command)) {
    return true;
  }
  if (type === 'click_element' && /pine editor/i.test(combined)) {
    return true;
  }
  if (type === 'key' && ['ctrl+a', 'ctrl+c', 'ctrl+v', 'ctrl+enter'].includes(key)) {
    return true;
  }
  if (type === 'type' && /\b(?:indicator|strategy|library)\s*\(/i.test(String(action.text || ''))) {
    return true;
  }

  return false;
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

function requestRequiresFreshPineIndicator(raw = '') {
  const normalized = normalizeTextForMatch(raw);
  if (!normalized) return false;

  return /\bnew\s+(?:interactive\s+)?(?:chart\s+)?indicator\b/.test(normalized)
    || /\binteractive\s+chart\s+indicator\b/.test(normalized)
    || /\bnew\s+indicator\s+flow\b/.test(normalized)
    || /\bdoes\s+not\s+reuse\s+the\s+current\s+script\b/.test(normalized)
    || /\bnew\s+pine\s+(?:indicator|script)\b/.test(normalized);
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
      : mode === 'save-status'
        ? 'Read visible Pine Editor save-state text for bounded save verification'
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
      reason: 'Read visible Pine Logs output for a bounded structured summary',
      pineEvidenceMode: 'logs-summary'
    };
  }

  if (surfaceTarget === 'pine-profiler') {
    return {
      type: 'get_text',
      text: 'Pine Profiler',
      reason: 'Read visible Pine Profiler output for a bounded structured summary',
      pineEvidenceMode: 'profiler-summary'
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

  const openerTypes = new Set(['key', 'click', 'double_click', 'right_click']);
  const openerIndex = Array.isArray(actions)
    ? actions.findIndex((action) => openerTypes.has(action?.type))
    : -1;
  const surface = inferPineSurfaceTarget(raw);
  const syntheticAuthoringPayload = !!pineAuthoringMode
    && surface?.target === 'pine-editor'
    && buildSafePineAuthoringContinuationSteps(actions, { openerIndex: -1, syntheticOpener: true }, raw).length > 0;
  const syntheticAuthoringOpen = !!pineAuthoringMode
    && surface?.target === 'pine-editor'
    && openerIndex < 0
    && allowsSyntheticPineAuthoringOpen(actions);

  if (!mentionsPineSurface || mentionsUnsafeAuthoringOnly) {
    if (!surface || surface.target !== 'pine-editor') return null;
    if (
      !Array.isArray(actions)
      || (
        !actions.some((action) => actionLooksLikePineEditorOpenIntent(action))
        && !syntheticAuthoringPayload
        && !syntheticAuthoringOpen
      )
    ) {
      return null;
    }
  }
  if (!surface) return null;

  const syntheticOpener = surface.target === 'pine-editor'
    && !!pineAuthoringMode
    && openerIndex < 0;
  if (openerIndex < 0 && !syntheticOpener) return null;

  const nextAction = openerIndex >= 0 ? getNextMeaningfulAction(actions, openerIndex + 1) : getNextMeaningfulAction(actions, 0);

  const wantsEvidenceReadback = inferPineEvidenceReadIntent(raw, surface.target);
  const pineEvidenceMode = surface.target === 'pine-editor' && wantsEvidenceReadback
    ? inferPineEditorEvidenceMode(raw)
    : surface.target === 'pine-version-history' && wantsEvidenceReadback
      ? inferPineVersionHistoryEvidenceMode(raw)
    : null;
  const safeAuthoringDefault = surface.target === 'pine-editor' && pineAuthoringMode === 'safe-new-script';
  const explicitOverwriteAuthoring = surface.target === 'pine-editor' && pineAuthoringMode === 'explicit-overwrite';
  const requiresFreshIndicator = surface.target === 'pine-editor'
    && (requestRequiresFreshPineIndicator(raw) || hasValidatedCanonicalPineState(actions));
  const safeAuthoringContinuationSteps = safeAuthoringDefault
    ? buildSafePineAuthoringContinuationSteps(actions, { openerIndex, syntheticOpener }, raw)
    : [];
  const requiresEditorActivation = surface.target === 'pine-editor'
    && (isPineAuthoringStep(nextAction) || safeAuthoringDefault || safeAuthoringContinuationSteps.length > 0);

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
    syntheticOpener,
    safeAuthoringDefault,
    requiresFreshIndicator,
    safeAuthoringContinuationSteps,
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
  if (!Array.isArray(actions)) return null;
  if (!intent.syntheticOpener && (intent.openerIndex < 0 || intent.openerIndex >= actions.length)) return null;

  const opener = intent.syntheticOpener ? null : actions[intent.openerIndex];
  const verifyTarget = buildVerifyTargetHintFromAppName(intent.appName || 'TradingView');
  const surfaceTerms = getPineSurfaceMatchTerms(intent.surfaceTarget);
  const expectedKeywords = intent.surfaceTarget === 'pine-editor'
    ? mergeUnique([
      'pine',
      'pine editor',
      'script',
      'add to chart',
      'publish script',
      'pine logs',
      'profiler',
      'version history',
      'strategy tester',
      intent.surfaceTarget,
      surfaceTerms,
      extractTradingViewObservationKeywords(`open ${intent.surfaceTarget} in tradingview`),
      verifyTarget.pineKeywords
    ])
    : mergeUnique([
      intent.surfaceTarget,
      surfaceTerms,
      extractTradingViewObservationKeywords(`open ${intent.surfaceTarget} in tradingview`),
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
    { type: 'wait', ms: 650 }
  ];

  if (intent.surfaceTarget === 'pine-editor') {
    const routeActions = buildTradingViewShortcutRoute('open-pine-editor', {
      enterReason: opener?.reason || intent.reason,
      enterActionOverrides: {
        verify: opener?.verify || {
          kind: intent.requiresEditorActivation ? 'editor-active' : intent.verifyKind,
          appName: 'TradingView',
          target: intent.surfaceTarget,
          keywords: expectedKeywords,
          requiresObservedChange: !!intent.requiresObservedChange
        },
        verifyTarget
      }
    });

    if (Array.isArray(routeActions) && routeActions.length > 0) {
      rewritten.push(...routeActions);
    } else {
      rewritten.push({
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
      });
    }
  } else {
    rewritten.push({
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
    });
  }

  const verifiedOpenStep = rewritten.find((action) => action?.verify?.target === intent.surfaceTarget);
  if (verifiedOpenStep && !verifiedOpenStep.verifyTarget) {
    verifiedOpenStep.verifyTarget = verifyTarget;
  }

  if (intent.safeAuthoringDefault) {
    if (intent.requiresFreshIndicator && Array.isArray(intent.safeAuthoringContinuationSteps) && intent.safeAuthoringContinuationSteps.length > 0) {
      if (rewritten.length > 0 && rewritten[rewritten.length - 1]?.type !== 'wait') {
        rewritten.push({ type: 'wait', ms: 220 });
      }
      return rewritten.concat(intent.safeAuthoringContinuationSteps.map(cloneAction));
    }

    const inspectStep = {
      type: 'get_text',
      text: 'Pine Editor',
      reason: 'Inspect the current visible Pine Editor state before choosing a safe new-script or bounded-edit path',
      pineEvidenceMode: 'safe-authoring-inspect'
    };

    if (Array.isArray(intent.safeAuthoringContinuationSteps) && intent.safeAuthoringContinuationSteps.length > 0) {
      inspectStep.continueOnPineEditorState = 'empty-or-starter';
      inspectStep.continueActions = intent.safeAuthoringContinuationSteps.map(cloneAction);
      inspectStep.haltOnPineEditorStateMismatch = true;
      inspectStep.pineStateMismatchReasons = {
        'existing-script-visible': 'Existing visible Pine script content is already present; not overwriting it without an explicit replacement request.',
        'unknown-visible-state': 'The visible Pine Editor state is ambiguous; inspect further or ask before editing.',
        '': 'The visible Pine Editor state is ambiguous; inspect further or ask before editing.'
      };
    }

    return rewritten.concat([
      { type: 'wait', ms: 220 },
      inspectStep
    ]);
  }

  const trailing = actions.slice(intent.syntheticOpener ? 0 : intent.openerIndex + 1)
    .filter((action) => action && typeof action === 'object' && action.type !== 'screenshot');

  if (!intent.explicitOverwriteAuthoring) {
    for (let index = trailing.length - 1; index >= 0; index--) {
      if (isPineDestructiveAuthoringStep(trailing[index])) {
        trailing.splice(index, 1);
      }
    }
  }

  if (intent.wantsEvidenceReadback) {
    const inferredReadbackStep = buildPineReadbackStep(intent.surfaceTarget, intent.pineEvidenceMode);
    trailing.forEach((action) => {
      if (action?.type !== 'get_text' || !inferredReadbackStep) return;
      if (!action.pineEvidenceMode && inferredReadbackStep.pineEvidenceMode) {
        action.pineEvidenceMode = inferredReadbackStep.pineEvidenceMode;
      }
      if (!action.reason && inferredReadbackStep.reason) {
        action.reason = inferredReadbackStep.reason;
      }
      if (!Array.isArray(action.pineSummaryFields) && Array.isArray(inferredReadbackStep.pineSummaryFields)) {
        action.pineSummaryFields = [...inferredReadbackStep.pineSummaryFields];
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
  if (!intent || (!intent.syntheticOpener && intent.openerIndex < 0)) return null;

  if (intent.syntheticOpener) {
    return buildTradingViewPineWorkflowActions(intent, actions);
  }

  const opener = actions[intent.openerIndex] || null;
  const explicitLegacyPineEditorOpen = intent.surfaceTarget === 'pine-editor'
    && intent.existingWorkflowSignal
    && actionLooksLikePineEditorOpenIntent(opener);

  if (explicitLegacyPineEditorOpen) {
    return buildTradingViewPineWorkflowActions(intent, actions);
  }

  const unsafeUnverifiedAuthoringPlan = intent.safeAuthoringDefault
    && !intent.existingWorkflowSignal
    && actions.some((action) => actionLooksLikeUnverifiedPineAuthoringEdit(action));
  if (unsafeUnverifiedAuthoringPlan) {
    return buildTradingViewPineWorkflowActions(intent, actions);
  }

  if (intent.existingWorkflowSignal) return null;

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
    actionLooksLikePineEditorOpenIntent(action)
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
    ...((buildTradingViewShortcutRoute('open-pine-editor', {
      enterReason: 'Re-open or re-activate TradingView Pine Editor after confirmation before continuing authoring',
      enterActionOverrides: {
        verify: {
          kind: 'editor-active',
          appName: 'TradingView',
          target: 'pine-editor',
          keywords: expectedKeywords,
          requiresObservedChange: true
        },
        verifyTarget
      }
    })) || [])
  ];

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
  inferPineVersionHistoryEvidenceMode,
  containsPineScriptPayloadText,
  sanitizePineScriptText
};
