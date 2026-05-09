const fs = require('fs');
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
const {
  buildExecutionContextEnvelope,
  isTradingViewPineContextEligible
} = require('../ai-service/execution-context');
const {
  sanitizePineScriptName,
  synthesizePineScriptTitleContract
} = require('./pine-title-synthesis');
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

  const normalizedActions = actions.filter((action) => action && typeof action === 'object');
  if (normalizedActions.every((action) => lowSignalTypes.has(getNormalizedActionType(action)))) {
    return true;
  }

  const hasAuthoringPayloadSignal = normalizedActions.some((action) =>
    isPineClipboardPreparationAction(action)
    || isPineScriptTypeAction(action)
    || hasValidatedCanonicalPineState([action])
  );
  if (!hasAuthoringPayloadSignal) {
    return false;
  }

  return normalizedActions.every((action) => {
    const type = getNormalizedActionType(action);
    return lowSignalTypes.has(type)
      || isPineClipboardPreparationAction(action)
      || isPineScriptTypeAction(action)
      || isPinePasteStep(action)
      || isPineSaveStep(action)
      || isPineAddToChartStep(action)
      || hasValidatedCanonicalPineState([action]);
  });
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

function inferSafePineScriptName(actions = [], raw = '') {
  const source = Array.isArray(actions) ? actions : [];
  for (const action of source) {
    const explicitPreparedName = sanitizePineScriptName(
      action?.pinePreparedScriptName || action?.pineExpectedScriptName || action?.scriptName || ''
    );
    if (explicitPreparedName) {
      return explicitPreparedName;
    }
  }

  const canonicalState = extractPineCanonicalState(actions);
  const preparedScriptText = extractPreparedPineScriptText(actions);
  const titleContract = synthesizePineScriptTitleContract({
    userMessage: raw,
    source: preparedScriptText,
    canonicalTitle: canonicalState?.scriptTitle || ''
  });
  if (titleContract?.title) {
    return titleContract.title;
  }

  for (const action of source) {
    const canonicalTitle = sanitizePineScriptName(action?.pineCanonicalState?.scriptTitle || '');
    if (canonicalTitle) return canonicalTitle;
  }

  return titleContract?.title || 'Liku Pine Script';
}

function normalizePreparedPineScriptText(value = '') {
  return sanitizePineScriptText(String(value || ''))
    .replace(/\r/g, '')
    .trim();
}

function extractPowerShellClipboardPayload(command = '') {
  const source = String(command || '');
  if (!source) return '';

  const hereStringMatch = source.match(/Set-Clipboard\s+-Value\s+@(['"])\r?\n?([\s\S]*?)\r?\n?\1@/i);
  if (hereStringMatch) {
    return hereStringMatch[2];
  }

  const singleQuotedMatch = source.match(/Set-Clipboard\s+-Value\s+'([\s\S]*?)'/i);
  if (singleQuotedMatch) {
    return singleQuotedMatch[1];
  }

  const doubleQuotedMatch = source.match(/Set-Clipboard\s+-Value\s+"([\s\S]*?)"/i);
  if (doubleQuotedMatch) {
    return doubleQuotedMatch[1];
  }

  return '';
}

function extractPreparedPineScriptText(actions = []) {
  const canonicalState = extractPineCanonicalState(actions);
  if (canonicalState?.sourcePath && canonicalState?.validation?.valid !== false) {
    try {
      const persistedSource = normalizePreparedPineScriptText(fs.readFileSync(canonicalState.sourcePath, 'utf8'));
      if (containsPineScriptPayloadText(persistedSource)) {
        return persistedSource;
      }
    } catch {}
  }

  for (const action of Array.isArray(actions) ? actions : []) {
    const type = getNormalizedActionType(action);
    if (type === 'type') {
      const typedPayload = normalizePreparedPineScriptText(action?.text || '');
      if (containsPineScriptPayloadText(typedPayload)) {
        return typedPayload;
      }
      continue;
    }

    if (type === 'run_command' && /\bset-clipboard\b/i.test(String(action?.command || ''))) {
      const clipboardPayload = normalizePreparedPineScriptText(extractPowerShellClipboardPayload(action.command));
      if (containsPineScriptPayloadText(clipboardPayload)) {
        return clipboardPayload;
      }
    }
  }

  return '';
}

function attachPreparedPineScriptMetadata(actions = [], preparedScriptText = '', preparedScriptName = '') {
  const normalizedPreparedScript = normalizePreparedPineScriptText(preparedScriptText);
  const normalizedPreparedName = sanitizePineScriptName(preparedScriptName);

  return Array.isArray(actions)
    ? actions.map((action) => {
        const cloned = cloneAction(action);
        if (isPinePasteStep(cloned) || isPineSaveStep(cloned) || isPineAddToChartStep(cloned)) {
          if (normalizedPreparedScript) {
            cloned.pinePreparedScriptText = normalizedPreparedScript;
          }
          if (normalizedPreparedName) {
            cloned.pinePreparedScriptName = normalizedPreparedName;
          }
        }
        return cloned;
      })
    : [];
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

const TRADINGVIEW_PINE_EDITOR_AUTHORING_SURFACE_CONTRACT = Object.freeze({
  appName: 'TradingView',
  route: 'pine-editor-authoring',
  surface: 'pine-editor',
  requiresPineEditorSurface: true,
  requiresCommandSurfaceClosed: true
});

const TRADINGVIEW_PINE_SAVE_NAME_SURFACE_CONTRACT = Object.freeze({
  appName: 'TradingView',
  route: 'pine-save-name',
  surface: 'pine-save-dialog',
  requiresPineEditorSurface: true,
  requiresCommandSurfaceClosed: true,
  requiresSaveDialogSurface: true
});

function clonePineEditorAuthoringSurfaceContract(overrides = null) {
  return {
    ...TRADINGVIEW_PINE_EDITOR_AUTHORING_SURFACE_CONTRACT,
    ...(overrides && typeof overrides === 'object' ? overrides : {})
  };
}

function cloneTradingViewPineSaveNameSurfaceContract(overrides = null) {
  return {
    ...TRADINGVIEW_PINE_SAVE_NAME_SURFACE_CONTRACT,
    ...(overrides && typeof overrides === 'object' ? overrides : {})
  };
}

function attachPineEditorAuthoringSurfaceContract(action) {
  if (!action || typeof action !== 'object') return action;

  const type = getNormalizedActionType(action);
  const key = String(action?.key || '').trim().toLowerCase();
  const requiresGuard = (type === 'key' && ['ctrl+v', 'ctrl+s', 'ctrl+enter'].includes(key))
    || (type === 'type' && containsPineScriptPayloadText(String(action?.text || '')));

  if (!requiresGuard) {
    return action;
  }

  const cloned = cloneAction(action);
  cloned.inputSurfaceContract = clonePineEditorAuthoringSurfaceContract(cloned.inputSurfaceContract);
  return cloned;
}

function attachPineEditorAuthoringSurfaceContracts(actions = []) {
  return Array.isArray(actions)
    ? actions.map((action) => attachPineEditorAuthoringSurfaceContract(action))
    : [];
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
      reason: 'Clear the fresh Pine starter script before pasting the canonical local Pine artifact',
      safePineStarterReset: true
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
    attachPineEditorAuthoringSurfaceContract({
      type: 'key',
      key: 'ctrl+v',
      reason: canonicalLabel
        ? `Paste the validated canonical Pine script (${canonicalLabel}) from the persisted local state file into the Pine Editor`
        : 'Paste the validated canonical Pine script from the persisted local state file into the Pine Editor',
      pineCanonicalState: canonicalState
    })
  ];
}

function shouldAutoAddPineScriptToChart(raw = '', actions = []) {
  if (Array.isArray(actions) && actions.some((action) => isPineAddToChartStep(action))) {
    return true;
  }

  const normalized = normalizeTextForMatch(raw);
  if (!normalized) return false;

   const explicitlySaveOnly = /\b(save(?:\s+the)?\s+script|save\s+only|only\s+save|do\s+not\s+(?:add|apply|put|load|run)\b|dont\s+(?:add|apply|put|load|run)\b|without\s+(?:adding|applying|loading|running)\b)/.test(normalized);
   if (explicitlySaveOnly) {
    return false;
  }

  return /\btradingview\b/.test(normalized)
    && /\b(write|create|generate|build|draft|make)\b/.test(normalized)
    && /\bpine\b/.test(normalized);
}

function buildSafePineAuthoringSourceActions(actions = [], intent = {}) {
  const openerIndex = Number(intent.openerIndex);
  const sourceActions = intent.syntheticOpener || openerIndex < 0
    ? actions.slice()
    : actions.slice(Math.max(0, openerIndex) + 1);

  return sourceActions.filter((action) => {
    const type = getNormalizedActionType(action);
    return action && typeof action === 'object' && type && type !== 'wait' && type !== 'screenshot';
  });
}

function cloneActionList(actions = []) {
  return Array.isArray(actions) ? actions.map((action) => cloneAction(action)) : [];
}

function cloneContinuationActionMap(continuations = {}) {
  const cloned = {};
  for (const [state, steps] of Object.entries(continuations && typeof continuations === 'object' ? continuations : {})) {
    cloned[state] = cloneActionList(Array.isArray(steps) ? steps : []);
  }
  return cloned;
}

function buildTradingViewConfirmationModalYesAction(reason = 'Confirm the exact TradingView unsaved-changes modal by choosing Yes') {
  return {
    type: 'click_element',
    text: 'Yes',
    controlType: 'Button',
    exact: true,
    foregroundOnly: true,
    allowCoordinateFallback: false,
    tradingViewRendererInvoke: {
      kind: 'unsaved-changes-confirmation',
      buttonText: 'Yes',
      requiredTexts: [
        'You have unsaved changes',
        'Would you like to save them'
      ]
    },
    reason
  };
}

function buildTradingViewConfirmationModalNoAction(reason = 'Dismiss the exact TradingView unsaved-changes modal by choosing No') {
  return {
    type: 'click_element',
    text: 'No',
    controlType: 'Button',
    exact: true,
    foregroundOnly: true,
    allowCoordinateFallback: false,
    tradingViewRendererInvoke: {
      kind: 'unsaved-changes-confirmation',
      buttonText: 'No',
      requiredTexts: [
        'You have unsaved changes',
        'Would you like to save them'
      ]
    },
    reason
  };
}

function buildTradingViewReplaceExistingScriptYesAction(scriptName = '', reason = 'Confirm the exact TradingView replace-script modal by choosing Yes') {
  const normalizedScriptName = String(scriptName || '').trim();
  return {
    type: 'click_element',
    text: 'Yes',
    pineExpectedScriptName: normalizedScriptName || '',
    controlType: 'Button',
    exact: true,
    foregroundOnly: true,
    allowCoordinateFallback: false,
    tradingViewRendererInvoke: {
      kind: 'replace-existing-script-confirmation',
      buttonText: 'Yes',
      pineExpectedScriptName: normalizedScriptName || '',
      requiredTexts: normalizedScriptName
        ? [
            `Script '${normalizedScriptName}' already exists`,
            'replace it'
          ]
        : [
            'already exists',
            'replace it'
          ]
    },
    reason
  };
}

function buildTradingViewReplaceExistingScriptNoAction(scriptName = '', reason = 'Dismiss the exact TradingView replace-script modal by choosing No') {
  const normalizedScriptName = String(scriptName || '').trim();
  return {
    type: 'click_element',
    text: 'No',
    controlType: 'Button',
    exact: true,
    foregroundOnly: true,
    allowCoordinateFallback: false,
    tradingViewRendererInvoke: {
      kind: 'replace-existing-script-confirmation',
      buttonText: 'No',
      requiredTexts: normalizedScriptName
        ? [
            `Script '${normalizedScriptName}' already exists`,
            'replace it'
          ]
        : [
            'already exists',
            'replace it'
          ]
    },
    reason
  };
}

function buildTradingViewFirstSaveDialogSaveAction(scriptName = '', reason = 'Confirm the exact TradingView Pine save dialog by choosing Save') {
  const normalizedScriptName = String(scriptName || '').trim();
  return {
    type: 'click_element',
    text: 'Save',
    pineExpectedScriptName: normalizedScriptName || '',
    controlType: 'Button',
    exact: true,
    foregroundOnly: true,
    allowCoordinateFallback: false,
    tradingViewRendererInvoke: {
      kind: 'pine-first-save-confirmation',
      buttonText: 'Save',
      pineExpectedScriptName: normalizedScriptName || '',
      requiredTexts: [
        'Save script',
        'New script name'
      ]
    },
    reason
  };
}

function buildTradingViewFirstSaveDialogCancelAction(reason = 'Dismiss the exact TradingView Pine save dialog by choosing Cancel') {
  return {
    type: 'click_element',
    text: 'Cancel',
    controlType: 'Button',
    exact: true,
    foregroundOnly: true,
    allowCoordinateFallback: false,
    tradingViewRendererInvoke: {
      kind: 'pine-first-save-confirmation',
      buttonText: 'Cancel',
      requiredTexts: [
        'Save script',
        'New script name'
      ]
    },
    reason
  };
}

function buildTradingViewPineCreateNewAction(reason = 'Open the current Pine script menu and choose Create new > Indicator before inserting the prepared script') {
  return {
    type: 'click_element',
    text: 'Create new',
    controlType: 'MenuItem',
    exact: true,
    foregroundOnly: true,
    allowCoordinateFallback: false,
    tradingViewRendererInvoke: {
      kind: 'pine-current-script-menu-item',
      buttonText: 'Create new',
      menuItemText: 'Create new',
      submenuItemText: 'Indicator',
      requiredTexts: [
        'Add to chart',
        'Publish script'
      ]
    },
    reason
  };
}

function buildSafePineAuthoringInspectAction({
  reason = 'Verify that a fresh Pine script surface is active before inserting the prepared script',
  continueOnPineEditorState = '',
  continueActions = [],
  continueActionsByPineEditorState = null,
  acceptGenericSavedSurfaceAsStarter = false,
  pineStateMismatchReasons = null,
  includeConfirmationRecovery = false,
  disabledPineEditorRecoveryStates = [],
  confirmationDismissReason = 'Dismiss the exact TradingView unsaved-changes modal before Pine authoring continues',
  confirmationReinspectReason = 'Re-verify the visible Pine Editor state after dismissing the unsaved-changes modal',
  replaceConfirmationDismissReason = 'Dismiss the exact TradingView replace-script modal before Pine authoring continues',
  replaceConfirmationReinspectReason = 'Re-verify the visible Pine Editor state after dismissing the replace-script modal',
  saveDialogDismissReason = 'Dismiss the exact TradingView Pine save-name dialog before Pine authoring continues',
  saveDialogReinspectReason = 'Re-verify the visible Pine Editor state after dismissing the Pine save-name dialog'
} = {}) {
  const inspectAction = {
    type: 'get_text',
    text: 'Pine Editor',
    reason,
    pineEvidenceMode: 'safe-authoring-inspect',
    haltOnPineEditorStateMismatch: true
  };
  if (acceptGenericSavedSurfaceAsStarter === true) {
    inspectAction.acceptGenericSavedSurfaceAsStarter = true;
  }

  if (continueOnPineEditorState) {
    inspectAction.continueOnPineEditorState = continueOnPineEditorState;
  }
  if (Array.isArray(continueActions) && continueActions.length > 0) {
    inspectAction.continueActions = cloneActionList(continueActions);
  }
  if (continueActionsByPineEditorState && typeof continueActionsByPineEditorState === 'object') {
    const clonedContinuations = cloneContinuationActionMap(continueActionsByPineEditorState);
    if (Object.keys(clonedContinuations).length > 0) {
      inspectAction.continueActionsByPineEditorState = clonedContinuations;
    }
  }
  if (pineStateMismatchReasons && typeof pineStateMismatchReasons === 'object') {
    inspectAction.pineStateMismatchReasons = {
      ...pineStateMismatchReasons
    };
  }

  if (includeConfirmationRecovery) {
    const disabledRecoveryStates = new Set(
      (Array.isArray(disabledPineEditorRecoveryStates) ? disabledPineEditorRecoveryStates : [disabledPineEditorRecoveryStates])
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean)
    );
    const stateContinuations = inspectAction.continueActionsByPineEditorState && typeof inspectAction.continueActionsByPineEditorState === 'object'
      ? cloneContinuationActionMap(inspectAction.continueActionsByPineEditorState)
      : {};
    const buildReinspectAction = (reinspectReason, blockedState) => buildSafePineAuthoringInspectAction({
      reason: reinspectReason,
      continueOnPineEditorState,
      continueActions,
      continueActionsByPineEditorState,
      pineStateMismatchReasons,
      includeConfirmationRecovery: true,
      disabledPineEditorRecoveryStates: [...disabledRecoveryStates, blockedState]
    });

    if (!disabledRecoveryStates.has('confirmation-blocking')) {
      stateContinuations['confirmation-blocking'] = [
        buildTradingViewConfirmationModalNoAction(confirmationDismissReason),
        { type: 'wait', ms: 320 },
        buildReinspectAction(confirmationReinspectReason, 'confirmation-blocking')
      ];
    }
    if (!disabledRecoveryStates.has('replace-confirmation-blocking')) {
      stateContinuations['replace-confirmation-blocking'] = [
        buildTradingViewReplaceExistingScriptNoAction('', replaceConfirmationDismissReason),
        { type: 'wait', ms: 320 },
        buildReinspectAction(replaceConfirmationReinspectReason, 'replace-confirmation-blocking')
      ];
    }
    if (!disabledRecoveryStates.has('save-required-blocking')) {
      stateContinuations['save-required-blocking'] = [
        buildTradingViewFirstSaveDialogCancelAction(saveDialogDismissReason),
        { type: 'wait', ms: 320 },
        buildReinspectAction(saveDialogReinspectReason, 'save-required-blocking')
      ];
    }
    inspectAction.continueActionsByPineEditorState = stateContinuations;
  }

  return inspectAction;
}

function buildPineSaveStatusVerificationAction({
  derivedScriptName = '',
  guardedApplyContinuationSteps = [],
  reason = 'Verify visible Pine save-state evidence before adding the script to the chart',
  includeSaveRequiredRecovery = false,
  includeConfirmationRecovery = false,
  includeReplaceConfirmationRecovery = false,
  pineLifecycleMismatchReasons = null,
  confirmationClickReason = 'Confirm the exact TradingView unsaved-changes modal before re-checking the Pine save state',
  confirmationReinspectReason = 'Re-verify visible Pine save-state evidence after confirming the unsaved-changes modal',
  replaceConfirmationClickReason = 'Confirm the exact TradingView replace-script modal before re-checking the Pine save state',
  replaceConfirmationReinspectReason = 'Re-verify visible Pine save-state evidence after confirming the replace-script modal'
} = {}) {
  const mismatchReasons = pineLifecycleMismatchReasons && typeof pineLifecycleMismatchReasons === 'object'
    ? {
        ...pineLifecycleMismatchReasons
      }
    : {
        'save-replace-confirmation-blocking': 'TradingView is asking whether to replace an existing Pine script with the same name; do not add it to the chart yet.',
        'save-confirmation-blocking': 'TradingView is showing an unsaved-changes confirmation modal after saving; do not add it to the chart yet.',
        'save-title-unverified': 'TradingView did not expose the expected saved Pine script title after saving; do not add it to the chart yet.',
        'unknown-save-state': 'TradingView did not expose enough saved-state evidence after saving; do not add it to the chart yet.',
        'save-required-before-apply': 'Visible save confirmation was not observed after saving the Pine script; do not add it to the chart yet.',
        'editor-target-corrupt': 'Visible Pine output suggests editor-target corruption; stop before applying the script.',
        '': 'The Pine save state could not be verified; do not add the script to the chart yet.'
      };

  const saveStatusAction = {
    type: 'get_text',
    text: 'Pine Editor',
    reason,
    pineEvidenceMode: 'save-status',
    pineExpectedScriptName: derivedScriptName,
    continueOnPineLifecycleState: 'saved-state-verified',
    continueActions: cloneActionList(guardedApplyContinuationSteps),
    haltOnPineLifecycleStateMismatch: true,
    pineLifecycleMismatchReasons: mismatchReasons
  };

  const lifecycleContinuations = {};

  if (includeSaveRequiredRecovery) {
    lifecycleContinuations['save-required-before-apply'] = [
      { type: 'wait', ms: 160 },
      buildTradingViewFirstSaveDialogSaveAction(
        derivedScriptName,
        `Provide the Pine script name and confirm the exact TradingView first-save dialog: ${derivedScriptName}`
      ),
      { type: 'wait', ms: 320 },
      buildPineSaveStatusVerificationAction({
        derivedScriptName,
        guardedApplyContinuationSteps,
        reason: 'Re-verify visible Pine save-state evidence after naming and saving the script',
        includeSaveRequiredRecovery: false,
        includeConfirmationRecovery: false,
        includeReplaceConfirmationRecovery: true,
        pineLifecycleMismatchReasons: {
          'save-replace-confirmation-blocking': 'TradingView is still asking whether to replace an existing Pine script after naming it; stop before applying it to the chart.',
          'save-confirmation-blocking': 'TradingView is showing an unsaved-changes confirmation modal after the save attempt; resolve the modal before applying the script.',
          'save-required-before-apply': 'TradingView still shows save-required state after naming the script; stop before applying it to the chart.',
          'save-title-unverified': 'TradingView did not expose the expected saved Pine script title after naming the script; stop before applying it to the chart.',
          'unknown-save-state': 'TradingView did not expose enough saved-state evidence after naming the script; stop before applying it to the chart.',
          'editor-target-corrupt': 'Visible Pine output suggests editor-target corruption during save; stop before applying the script.',
          '': 'The Pine save state could not be verified after naming the script; do not add it to the chart yet.'
        }
      })
    ];
  }

  if (includeConfirmationRecovery) {
    lifecycleContinuations['save-confirmation-blocking'] = [
      buildTradingViewConfirmationModalYesAction(confirmationClickReason),
      { type: 'wait', ms: 320 },
      buildPineSaveStatusVerificationAction({
        derivedScriptName,
        guardedApplyContinuationSteps,
        reason: confirmationReinspectReason,
        includeSaveRequiredRecovery: true,
        includeConfirmationRecovery: false,
        includeReplaceConfirmationRecovery: false,
        pineLifecycleMismatchReasons: {
          'save-replace-confirmation-blocking': 'TradingView is asking whether to replace an existing Pine script after the save modal was cleared; confirm the replacement before applying it to the chart.',
          'save-confirmation-blocking': 'TradingView is still showing an unsaved-changes confirmation modal after choosing Yes; do not add it to the chart yet.',
          'save-title-unverified': 'TradingView did not expose the expected saved Pine script title after confirming the save modal; do not add it to the chart yet.',
          'unknown-save-state': 'TradingView did not expose enough saved-state evidence after confirming the save modal; do not add it to the chart yet.',
          'save-required-before-apply': 'Visible save confirmation was not observed after confirming the save modal; do not add the script to the chart yet.',
          'editor-target-corrupt': 'Visible Pine output suggests editor-target corruption after confirming the save modal; stop before applying the script.',
          '': 'The Pine save state could not be verified after confirming the save modal; do not add the script to the chart yet.'
        }
      })
    ];
  }

  if (includeReplaceConfirmationRecovery) {
    lifecycleContinuations['save-replace-confirmation-blocking'] = [
      buildTradingViewReplaceExistingScriptYesAction(derivedScriptName, replaceConfirmationClickReason),
      { type: 'wait', ms: 320 },
      buildPineSaveStatusVerificationAction({
        derivedScriptName,
        guardedApplyContinuationSteps,
        reason: replaceConfirmationReinspectReason,
        includeSaveRequiredRecovery: false,
        includeConfirmationRecovery: false,
        includeReplaceConfirmationRecovery: false,
        pineLifecycleMismatchReasons: {
          'save-replace-confirmation-blocking': 'TradingView is still asking whether to replace the existing Pine script after choosing Yes; do not add it to the chart yet.',
          'save-confirmation-blocking': 'TradingView is showing an unsaved-changes confirmation modal after confirming the replacement; do not add it to the chart yet.',
          'save-title-unverified': 'TradingView did not expose the expected saved Pine script title after confirming the replacement; do not add it to the chart yet.',
          'unknown-save-state': 'TradingView did not expose enough saved-state evidence after confirming the replacement; do not add it to the chart yet.',
          'save-required-before-apply': 'TradingView still shows save-required state after confirming the replacement; stop before applying it to the chart.',
          'editor-target-corrupt': 'Visible Pine output suggests editor-target corruption after confirming the replacement; stop before applying the script.',
          '': 'The Pine save state could not be verified after confirming the replacement; do not add the script to the chart yet.'
        }
      })
    ];
  }

  if (Object.keys(lifecycleContinuations).length > 0) {
    saveStatusAction.continueActionsByPineLifecycleState = lifecycleContinuations;
  }

  return saveStatusAction;
}

function buildVerifiedStarterScriptReplacementSteps(payloadSteps = []) {
  const clonedPayloadSteps = cloneActionList(payloadSteps);
  if (clonedPayloadSteps.length === 0) {
    return [];
  }

  const alreadySelectsStarter = clonedPayloadSteps.some((action) => isPineSelectionStep(action));
  const alreadyClearsStarter = clonedPayloadSteps.some((action) => {
    const type = getNormalizedActionType(action);
    const key = String(action?.key || '').trim().toLowerCase();
    return type === 'key' && (key === 'backspace' || key === 'delete');
  });
  if (alreadySelectsStarter || alreadyClearsStarter) {
    return clonedPayloadSteps;
  }

  return [
    {
      type: 'key',
      key: 'ctrl+a',
      reason: 'Select the verified Pine starter script before replacing it with the prepared script'
    },
    { type: 'wait', ms: 120 },
    {
      type: 'key',
      key: 'backspace',
      reason: 'Clear the verified Pine starter script before inserting the prepared script',
      safePineStarterReset: true
    },
    { type: 'wait', ms: 120 },
    ...clonedPayloadSteps
  ];
}

function buildSafePineAuthoringSaveFollowUpActions(filtered = [], raw = '') {
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
  const preparedScriptText = extractPreparedPineScriptText(payloadSteps);
  const starterSafePayloadSteps = attachPreparedPineScriptMetadata(
    canonicalReplacementPayloadSteps ? payloadSteps : buildVerifiedStarterScriptReplacementSteps(payloadSteps),
    preparedScriptText,
    derivedScriptName
  );
  const guardedPayloadSteps = attachPineEditorAuthoringSurfaceContracts(
    starterSafePayloadSteps
  );

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
  const guardedApplyContinuationSteps = attachPineEditorAuthoringSurfaceContracts(
    attachPreparedPineScriptMetadata(applyContinuationSteps, preparedScriptText, derivedScriptName)
  );

  const rawSaveSteps = saveSteps.length > 0
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
      ]);
  const guardedSaveSteps = attachPineEditorAuthoringSurfaceContracts(
    attachPreparedPineScriptMetadata(rawSaveSteps, preparedScriptText, derivedScriptName)
  );

  const saveFollowUpActions = [
    ...guardedPayloadSteps,
    { type: 'wait', ms: 220 },
    ...guardedSaveSteps,
    { type: 'wait', ms: 280 },
    buildPineSaveStatusVerificationAction({
      derivedScriptName,
      guardedApplyContinuationSteps,
      includeSaveRequiredRecovery: true,
      includeConfirmationRecovery: true,
      includeReplaceConfirmationRecovery: true
    })
  ];

  return saveFollowUpActions;
}

function buildSafePineAuthoringDirectContinuationSteps(actions = [], intent = {}, raw = '') {
  const filtered = buildSafePineAuthoringSourceActions(actions, intent);
  return buildSafePineAuthoringSaveFollowUpActions(filtered, raw);
}

function buildSafePineAuthoringContinuationSteps(actions = [], intent = {}, raw = '') {
  const filtered = buildSafePineAuthoringSourceActions(actions, intent);
  const saveFollowUpActions = buildSafePineAuthoringSaveFollowUpActions(filtered, raw);

  if (saveFollowUpActions.length === 0) {
    return [];
  }

  return [
    buildTradingViewPineCreateNewAction(),
    { type: 'wait', ms: 220 },
    buildSafePineAuthoringInspectAction({
      reason: 'Verify that the Pine Create new route exposed a fresh starter surface before inserting the prepared script',
      continueOnPineEditorState: 'empty-or-starter',
      acceptGenericSavedSurfaceAsStarter: true,
      continueActions: saveFollowUpActions,
      includeConfirmationRecovery: true,
      pineStateMismatchReasons: {
        'confirmation-blocking': 'TradingView is showing an unsaved-changes confirmation modal; resolve the modal before inserting the prepared script.',
        'replace-confirmation-blocking': 'TradingView is showing a replace-script confirmation modal from an earlier save flow; resolve it before inserting the prepared script.',
        'save-required-blocking': 'TradingView is already showing a Pine save-name dialog from an earlier save flow; resolve it before inserting the prepared script.',
        'existing-script-visible': 'The Pine Create new route did not yield a clean starter script; stop rather than overwrite visible script content.',
        'unknown-visible-state': 'The fresh Pine indicator state is ambiguous; inspect further before inserting the script.',
        '': 'The fresh Pine indicator state is ambiguous; inspect further before inserting the script.'
      }
    })
  ];
}

function actionLooksLikePineEditorOpenIntent(action) {
  if (!action || typeof action !== 'object') return false;
  if (action.tradingViewChartFocusClick === true) return false;
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

function getExplicitPineOpenerVerification(action) {
  if (!action || typeof action !== 'object') return null;

  const verifyTarget = String(action?.verify?.target || '').trim().toLowerCase();
  if (verifyTarget !== 'pine-editor') return null;

  const verifyKind = String(action?.verify?.kind || '').trim().toLowerCase();
  return {
    target: verifyTarget,
    kind: verifyKind || null,
    requiresObservedChange: action?.verify?.requiresObservedChange === true,
    requiresEditorActivation: verifyKind === 'editor-active' || verifyKind === 'editor-ready'
  };
}

function findVerifiedPineEditorOpenIndex(actions = []) {
  const source = Array.isArray(actions) ? actions : [];
  for (let index = 0; index < source.length; index++) {
    const action = source[index];
    const explicitVerification = getExplicitPineOpenerVerification(action);
    if (!explicitVerification) continue;

    const key = String(action?.key || '').trim().toLowerCase();
    if (matchesTradingViewShortcutAction(action, 'open-pine-editor')) return index;
    if (key === 'ctrl+e' || key === 'enter') return index;
    if (actionLooksLikePineEditorOpenIntent(action)) return index;
  }
  return -1;
}

function actionLooksLikeTradingViewFocusPrelude(action) {
  if (!action || typeof action !== 'object') return false;

  const type = getNormalizedActionType(action);
  if (!['focus_window', 'bring_window_to_front', 'restore_window'].includes(type)) {
    return false;
  }

  const processName = normalizeTextForMatch(action?.processName || '');
  const title = normalizeTextForMatch(action?.title || action?.windowTitle || '');
  return processName.includes('tradingview') || title.includes('tradingview');
}

function trimLeadingTradingViewFocusPreludeActions(actions = []) {
  const trailing = Array.isArray(actions) ? actions.slice() : [];
  let index = 0;
  let removedFocusAction = false;

  while (index < trailing.length) {
    const action = trailing[index];
    const nextAction = trailing[index + 1] || null;
    const type = getNormalizedActionType(action);
    const isFocusAction = actionLooksLikeTradingViewFocusPrelude(action);
    const isFocusWait = type === 'wait' && (
      removedFocusAction
      || actionLooksLikeTradingViewFocusPrelude(nextAction)
    );

    if (isFocusAction || isFocusWait) {
      removedFocusAction = true;
      index += 1;
      continue;
    }

    break;
  }

  return removedFocusAction ? trailing.slice(index) : trailing;
}

function workflowHasCanonicalVerifiedPineOpener(actions = [], intent = {}) {
  if (!Array.isArray(actions) || intent?.surfaceTarget !== 'pine-editor') return false;

  const verifiedOpenerIndex = findVerifiedPineEditorOpenIndex(actions);
  if (verifiedOpenerIndex < 0) return false;

  const opener = actions[verifiedOpenerIndex];
  const explicitVerification = getExplicitPineOpenerVerification(opener);
  if (!explicitVerification || (!explicitVerification.requiresObservedChange && !explicitVerification.requiresEditorActivation)) {
    return false;
  }

  const leadingActions = actions.slice(0, verifiedOpenerIndex);
  const hasTradingViewFocusPrelude = leadingActions.some((action) => actionLooksLikeTradingViewFocusPrelude(action));
  if (!hasTradingViewFocusPrelude) return false;

  const openerType = getNormalizedActionType(opener);
  const openerRoute = String(
    opener?.searchSurfaceContract?.route
    || opener?.tradingViewShortcut?.route
    || ''
  ).trim().toLowerCase();
  const openerKey = String(opener?.key || '').trim().toLowerCase();
  if (openerType === 'click_element' && openerRoute === 'semantic-icon') {
    return true;
  }
  return openerKey === 'ctrl+e'
    && leadingActions.some((action) => action?.tradingViewChartFocusClick === true);
}

function trimLeadingPineEditorOpenRouteActions(actions = []) {
  const trailing = Array.isArray(actions) ? actions.slice() : [];
  let index = 0;
  let removedRouteAction = false;

  while (index < trailing.length) {
    const action = trailing[index];
    const nextAction = trailing[index + 1] || null;
    const type = getNormalizedActionType(action);
    const combined = [action?.reason, action?.text, action?.title, action?.key]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join(' ');

    const isOpenerAction = actionLooksLikePineEditorOpenIntent(action)
      || matchesTradingViewShortcutAction(action, 'symbol-search')
      || (type === 'key'
        && String(action?.key || '').trim().toLowerCase() === 'enter'
        && /quick search|command palette|pine editor/i.test(combined));

    const isRouteWait = type === 'wait' && (
      removedRouteAction
      || actionLooksLikePineEditorOpenIntent(nextAction)
      || matchesTradingViewShortcutAction(nextAction, 'symbol-search')
    );

    if (isOpenerAction || isRouteWait) {
      removedRouteAction = true;
      index += 1;
      continue;
    }

    break;
  }

  return removedRouteAction ? trailing.slice(index) : trailing;
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

  const negatesOverwriteIntent = /\b(?:do\s+not|dont|don't|never|avoid|without)\s+(?:overwriting?|replacing|rewriting|clearing|erasing|wiping|deleting)\b/.test(normalized)
    || /\b(?:do\s+not|dont|don't|never|avoid|without)\s+(?:the\s+)?(?:current|existing|last|cloud)?\s*(?:script|buffer|file)?\s*(?:overwrite|replacement|rewrite|clear|erase|wipe|delete)\b/.test(normalized)
    || /\b(?:no|non)\s*-?\s*(?:overwrite|destructive|replacement)\b/.test(normalized);
  const explicitOverwriteIntent = !negatesOverwriteIntent
    && (/\b(overwrite|replace|rewrite current|rewrite existing|clear current|clear existing|erase current|erase existing|wipe current|wipe existing|delete current|delete existing)\b/.test(normalized)
      || (/\bfrom scratch\b/.test(normalized) && /\b(current|existing)\b/.test(normalized)));

  const mentionsPineArtifact = /\bpine\b/.test(normalized)
    && /\b(script|indicator|strategy|study)\b/.test(normalized);
  const mentionsTradingViewAuthoringArtifact = /\btradingview\b/.test(normalized)
    && /\b(indicator|strategy|library)\b/.test(normalized);
  const mentionsAuthoringIntent = /\b(write|create|generate|build|draft|make)\b/.test(normalized)
    && (mentionsPineArtifact || mentionsTradingViewAuthoringArtifact);
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

function inferPineEditorAlreadyActive(raw = '', context = {}, executionContextEnvelope = null) {
  const normalized = normalizeTextForMatch(raw);
  if (!normalized) return false;

  const explicitMessageSignal = /\b(?:already\s+in|in|inside|within|from)\s+(?:the\s+)?pine editor\b/.test(normalized)
    || /\b(?:while|when)\s+(?:in|inside|within)\s+(?:the\s+)?pine editor\b/.test(normalized)
    || /\bpine editor\s+(?:is|already)\s+(?:open|active|visible)\b/.test(normalized)
    || /\bwith\s+(?:the\s+)?pine editor\s+(?:open|active|visible)\b/.test(normalized);
  if (explicitMessageSignal) {
    return true;
  }

  const foregroundTitle = normalizeTextForMatch(
    context?.foreground?.title
      || context?.foreground?.windowTitle
      || executionContextEnvelope?.foreground?.windowTitle
      || ''
  );
  const foregroundProcessName = normalizeTextForMatch(
    context?.foreground?.processName
      || executionContextEnvelope?.foreground?.processName
      || ''
  );
  const foregroundTradingView = executionContextEnvelope?.signals?.foregroundTradingView === true
    || foregroundProcessName.includes('tradingview');

  return foregroundTradingView && /\bpine editor\b/.test(foregroundTitle);
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
  if (
    /\btradingview\b/.test(normalized)
    && /\b(write|create|generate|build|draft|make)\b/.test(normalized)
    && /\b(indicator|strategy|library)\b/.test(normalized)
  ) {
    return { target: 'pine-editor', kind: 'panel-visible' };
  }

  return null;
}

function inferTradingViewPineIntent(userMessage = '', actions = [], context = {}) {
  const raw = String(userMessage || '').trim();
  if (!raw) return null;

  const executionContextEnvelope = context.executionContextEnvelope || buildExecutionContextEnvelope({
    capabilitySnapshot: context.capabilitySnapshot,
    chatContinuityContext: context.chatContinuityContext,
    cwd: context.cwd,
    foreground: context.foreground,
    sessionIntentContext: context.sessionIntentContext,
    sessionState: context.sessionState,
    userMessage: raw
  });
  if (!isTradingViewPineContextEligible(executionContextEnvelope)) return null;

  const mentionsTradingView = /\btradingview|trading view\b/i.test(raw)
    || executionContextEnvelope?.signals?.foregroundTradingView === true
    || executionContextEnvelope?.signals?.explicitTradingViewPineRequest === true
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
    ? actions.findIndex((action) => action?.tradingViewChartFocusClick !== true && openerTypes.has(action?.type))
    : -1;
  const surface = inferPineSurfaceTarget(raw);
  const pineEditorAlreadyActive = surface?.target === 'pine-editor'
    && inferPineEditorAlreadyActive(raw, context, executionContextEnvelope);
  const syntheticAuthoringPayload = !!pineAuthoringMode
    && surface?.target === 'pine-editor'
    && buildSafePineAuthoringContinuationSteps(actions, { openerIndex: -1, syntheticOpener: true }, raw).length > 0;
  const syntheticAuthoringOpen = !!pineAuthoringMode
    && surface?.target === 'pine-editor'
    && !pineEditorAlreadyActive
    && openerIndex < 0
    && allowsSyntheticPineAuthoringOpen(actions);
  const syntheticSurfaceOpen = !pineAuthoringMode
    && mentionsSafeOpenIntent
    && surface?.target === 'pine-editor'
    && !pineEditorAlreadyActive
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
        && !syntheticSurfaceOpen
        && !pineEditorAlreadyActive
      )
    ) {
      return null;
    }
  }
  if (!surface) return null;

  const syntheticOpener = surface.target === 'pine-editor'
    && !pineEditorAlreadyActive
    && (mentionsSafeOpenIntent || !!pineAuthoringMode)
    && openerIndex < 0
    && allowsSyntheticPineAuthoringOpen(actions);
  if (openerIndex < 0 && !syntheticOpener && !pineEditorAlreadyActive) return null;

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
  const safeAuthoringDirectContinuationSteps = safeAuthoringDefault
    ? buildSafePineAuthoringDirectContinuationSteps(actions, { openerIndex, syntheticOpener }, raw)
    : [];
  const safeAuthoringContinuationSteps = safeAuthoringDefault
    ? buildSafePineAuthoringContinuationSteps(actions, { openerIndex, syntheticOpener }, raw)
    : [];
  const explicitPineOpenerIndex = findVerifiedPineEditorOpenIndex(actions);
  const explicitPineOpenerVerification = getExplicitPineOpenerVerification(
    explicitPineOpenerIndex >= 0 ? actions[explicitPineOpenerIndex] : null
  );
  const requiresEditorActivation = surface.target === 'pine-editor'
    && (
      explicitPineOpenerVerification?.requiresEditorActivation === true
      || isPineAuthoringStep(nextAction)
      || safeAuthoringDefault
      || safeAuthoringContinuationSteps.length > 0
    );

  const existingWorkflowSignal = Array.isArray(actions) && actions.some((action) => /pine/.test(String(action?.verify?.target || '')));

  return {
    appName: 'TradingView',
    surfaceTarget: surface.target,
    verifyKind: explicitPineOpenerVerification?.kind || surface.kind,
    openerIndex,
    existingWorkflowSignal,
    requiresObservedChange: explicitPineOpenerVerification?.requiresObservedChange === true
      || requiresEditorActivation
      || nextAction?.type === 'type',
    requiresEditorActivation,
    wantsEvidenceReadback,
    pineEvidenceMode,
    syntheticOpener,
    surfaceAlreadyActive: pineEditorAlreadyActive,
    safeAuthoringDefault,
    requiresFreshIndicator,
    safeAuthoringDirectContinuationSteps,
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
  const skipSurfaceOpen = intent.surfaceTarget === 'pine-editor' && intent.surfaceAlreadyActive === true;
  if (!skipSurfaceOpen && !intent.syntheticOpener && (intent.openerIndex < 0 || intent.openerIndex >= actions.length)) return null;

  const opener = (intent.syntheticOpener || skipSurfaceOpen) ? null : actions[intent.openerIndex];
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
    if (!skipSurfaceOpen) {
      const pineEditorOpenVerify = {
        kind: intent.requiresEditorActivation ? 'editor-active' : intent.verifyKind,
        appName: 'TradingView',
        target: intent.surfaceTarget,
        keywords: expectedKeywords,
        requiresObservedChange: !!intent.requiresObservedChange
      };
      const openerShortcutId = String(opener?.tradingViewShortcut?.id || '').trim().toLowerCase();
      const openerKey = String(opener?.key || '').trim().toLowerCase();
      const openerRoute = String(
        opener?.searchSurfaceContract?.route
        || opener?.tradingViewShortcut?.route
        || ''
      ).trim().toLowerCase();
      const useQuickSearchOpener = intent.preferQuickSearchOpener === true;
      const useDirectChartPineShortcut = intent.forceDirectChartPineShortcut === true;
      const preferSemanticPineIcon = !useQuickSearchOpener && !useDirectChartPineShortcut && (
        intent.preferSemanticPineIcon !== false
        || openerRoute === 'semantic-icon'
        || openerKey === 'ctrl+e'
        || openerShortcutId === 'open-pine-editor'
        || matchesTradingViewShortcutAction(opener, 'open-pine-editor')
      );
      const routeActions = buildTradingViewShortcutRoute('open-pine-editor', {
        routeStrategy: preferSemanticPineIcon
          ? 'semantic-icon'
          : (useDirectChartPineShortcut ? 'official-direct' : 'quick-search'),
        enterReason: opener?.reason || intent.reason,
        iconReason: opener?.reason || intent.reason || 'Invoke the TradingView Pine Editor toolbar icon without coordinate fallback',
        iconActionOverrides: {
          verify: pineEditorOpenVerify,
          verifyTarget
        },
        enterActionOverrides: {
          verify: pineEditorOpenVerify,
          verifyTarget
        }
      });

      if (Array.isArray(routeActions) && routeActions.length > 0) {
        if (useDirectChartPineShortcut) {
          rewritten.push(
            {
              type: 'click',
              x: 0,
              y: 0,
              reason: 'Focus the TradingView chart surface before using Ctrl+E to open Pine Editor',
              tradingViewChartFocusClick: true,
              allowCoordinateFallback: true
            },
            { type: 'wait', ms: 160 }
          );
        }
        rewritten.push(...routeActions);
      } else {
        rewritten.push({
          ...opener,
          reason: opener?.reason || intent.reason,
          verify: pineEditorOpenVerify,
          verifyTarget
        });
      }
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
    const directContinuationSteps = Array.isArray(intent.safeAuthoringDirectContinuationSteps)
      ? intent.safeAuthoringDirectContinuationSteps
      : [];
    const freshIndicatorContinuationSteps = Array.isArray(intent.safeAuthoringContinuationSteps)
      ? intent.safeAuthoringContinuationSteps
      : [];
    let inspectStep = null;

    if (directContinuationSteps.length > 0 && intent.requiresFreshIndicator && freshIndicatorContinuationSteps.length > 0) {
      inspectStep = buildSafePineAuthoringInspectAction({
        reason: 'Inspect the current visible Pine Editor state before choosing a safe new-script or bounded-edit path',
        continueActionsByPineEditorState: {
          'empty-or-starter': directContinuationSteps.map(cloneAction),
          'existing-script-visible': freshIndicatorContinuationSteps.map(cloneAction)
        },
        includeConfirmationRecovery: true,
        pineStateMismatchReasons: {
          'confirmation-blocking': 'TradingView is showing an unsaved-changes confirmation modal; resolve the modal before starting a fresh indicator flow.',
          'replace-confirmation-blocking': 'TradingView is showing a replace-script confirmation modal from an earlier save flow; resolve it before starting a fresh indicator flow.',
          'save-required-blocking': 'TradingView is already showing a Pine save-name dialog from an earlier save flow; resolve it before starting a fresh indicator flow.',
          'unknown-visible-state': 'The visible Pine Editor state is ambiguous; inspect further before starting a fresh indicator flow.',
          '': 'The visible Pine Editor state is ambiguous; inspect further before starting a fresh indicator flow.'
        }
      });
    } else if (directContinuationSteps.length > 0) {
      inspectStep = buildSafePineAuthoringInspectAction({
        reason: 'Inspect the current visible Pine Editor state before choosing a safe new-script or bounded-edit path',
        continueOnPineEditorState: 'empty-or-starter',
        continueActions: directContinuationSteps.map(cloneAction),
        includeConfirmationRecovery: true,
        pineStateMismatchReasons: {
          'confirmation-blocking': 'TradingView is showing an unsaved-changes confirmation modal; resolve the modal before Pine authoring continues.',
          'replace-confirmation-blocking': 'TradingView is showing a replace-script confirmation modal from an earlier save flow; resolve it before Pine authoring continues.',
          'save-required-blocking': 'TradingView is already showing a Pine save-name dialog from an earlier save flow; resolve it before Pine authoring continues.',
          'existing-script-visible': 'Existing visible Pine script content is already present; not overwriting it without an explicit replacement request.',
          'unknown-visible-state': 'The visible Pine Editor state is ambiguous; inspect further or ask before editing.',
          '': 'The visible Pine Editor state is ambiguous; inspect further or ask before editing.'
        }
      });
    } else if (freshIndicatorContinuationSteps.length > 0) {
      inspectStep = buildSafePineAuthoringInspectAction({
        reason: 'Inspect the current visible Pine Editor state before choosing a safe new-script or bounded-edit path',
        continueOnPineEditorState: 'empty-or-starter',
        continueActions: freshIndicatorContinuationSteps.map(cloneAction),
        includeConfirmationRecovery: true,
        pineStateMismatchReasons: {
          'confirmation-blocking': 'TradingView is showing an unsaved-changes confirmation modal; resolve the modal before Pine authoring continues.',
          'replace-confirmation-blocking': 'TradingView is showing a replace-script confirmation modal from an earlier save flow; resolve it before Pine authoring continues.',
          'save-required-blocking': 'TradingView is already showing a Pine save-name dialog from an earlier save flow; resolve it before Pine authoring continues.',
          'existing-script-visible': 'Existing visible Pine script content is already present; not overwriting it without an explicit replacement request.',
          'unknown-visible-state': 'The visible Pine Editor state is ambiguous; inspect further or ask before editing.',
          '': 'The visible Pine Editor state is ambiguous; inspect further or ask before editing.'
        }
      });
    } else {
      inspectStep = {
        type: 'get_text',
        text: 'Pine Editor',
        reason: 'Inspect the current visible Pine Editor state before choosing a safe new-script or bounded-edit path',
        pineEvidenceMode: 'safe-authoring-inspect'
      };
    }

    return rewritten.concat([
      { type: 'wait', ms: 220 },
      inspectStep
    ]);
  }

  let trailing = actions.slice((intent.syntheticOpener || skipSurfaceOpen) ? 0 : intent.openerIndex + 1)
    .filter((action) => action && typeof action === 'object' && action.type !== 'screenshot');

  if (intent.syntheticOpener || skipSurfaceOpen) {
    trailing = trimLeadingTradingViewFocusPreludeActions(trailing);
  }

  if (intent.surfaceTarget === 'pine-editor') {
    trailing = trimLeadingPineEditorOpenRouteActions(trailing);
  }

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

  const intent = inferTradingViewPineIntent(context.userMessage || '', actions, context);
  if (!intent || (!intent.syntheticOpener && intent.surfaceAlreadyActive !== true && intent.openerIndex < 0)) return null;
  const buildPreferredPineWorkflow = (overrides = {}) => buildTradingViewPineWorkflowActions({
    ...intent,
    preferSemanticPineIcon: intent.surfaceTarget === 'pine-editor',
    forceDirectChartPineShortcut: intent.forceDirectChartPineShortcut === true,
    ...overrides
  }, actions);

  if (intent.syntheticOpener || intent.surfaceAlreadyActive === true) {
    return buildPreferredPineWorkflow();
  }

  const opener = actions[intent.openerIndex] || null;
  const explicitLegacyPineEditorOpen = intent.surfaceTarget === 'pine-editor'
    && intent.existingWorkflowSignal
    && actionLooksLikePineEditorOpenIntent(opener);

  if (workflowHasCanonicalVerifiedPineOpener(actions, intent)) {
    return null;
  }

  if (explicitLegacyPineEditorOpen) {
    return buildPreferredPineWorkflow();
  }

  const unsafeUnverifiedAuthoringPlan = intent.safeAuthoringDefault
    && !intent.existingWorkflowSignal
    && actions.some((action) => actionLooksLikeUnverifiedPineAuthoringEdit(action));
  if (unsafeUnverifiedAuthoringPlan) {
    return buildPreferredPineWorkflow();
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

  return buildPreferredPineWorkflow();
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
      routeStrategy: 'semantic-icon',
      iconReason: 'Re-open or re-activate TradingView Pine Editor after confirmation before continuing authoring',
      iconActionOverrides: {
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
