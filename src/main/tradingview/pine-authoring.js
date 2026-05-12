const {
  containsPineScriptPayloadText,
  sanitizePineScriptText,
  detectRequestedPineVersion,
  normalizePineScriptSource
} = require('../tools/tradingview-tool');
const {
  applyPineScriptTitleContract,
  synthesizePineScriptTitleContract
} = require('./pine-title-synthesis');
const {
  buildTradingViewPineEditorAutomationGuidanceLines
} = require('./shortcut-profile');

function createTradingViewPineAuthoringHelpers(deps = {}) {
  const {
    rewriteActionsForReliability
  } = deps;

  if (typeof rewriteActionsForReliability !== 'function') {
    throw new Error('createTradingViewPineAuthoringHelpers requires rewriteActionsForReliability');
  }

  function isIncompleteTradingViewPineAuthoringPlan(actionBlock, userMessage = '') {
    const normalizedMessage = String(userMessage || '').toLowerCase();
    if (!/\btradingview\b/.test(normalizedMessage)) return false;
    if (
      !/\bpine\b/.test(normalizedMessage)
      && !/\bscript\b/.test(normalizedMessage)
      && !/\b(indicator|strategy|library)\b/.test(normalizedMessage)
    ) return false;
    if (!/\b(create|build|generate|write|draft|make|replace|overwrite|rewrite)\b/.test(normalizedMessage)) return false;

    const collectNestedActions = (items = [], seen = new Set()) => {
      const collected = [];
      for (const action of Array.isArray(items) ? items : []) {
        if (!action || typeof action !== 'object' || seen.has(action)) continue;
        seen.add(action);
        collected.push(action);
        if (Array.isArray(action.continueActions)) {
          collected.push(...collectNestedActions(action.continueActions, seen));
        }
        const stateBranches = action.continueActionsByPineEditorState;
        if (stateBranches && typeof stateBranches === 'object') {
          for (const branchActions of Object.values(stateBranches)) {
            if (Array.isArray(branchActions)) {
              collected.push(...collectNestedActions(branchActions, seen));
            }
          }
        }
        const lifecycleBranches = action.continueActionsByPineLifecycleState;
        if (lifecycleBranches && typeof lifecycleBranches === 'object') {
          for (const branchActions of Object.values(lifecycleBranches)) {
            if (Array.isArray(branchActions)) {
              collected.push(...collectNestedActions(branchActions, seen));
            }
          }
        }
      }
      return collected;
    };

    const actions = collectNestedActions(Array.isArray(actionBlock?.actions) ? actionBlock.actions.filter(Boolean) : []);
    if (actions.length === 0) return false;

    const requestedAddToChart = /\bctrl\s*\+\s*enter\b/.test(normalizedMessage)
      || /\b(add|apply|load|put)\b.{0,20}\bchart\b/.test(normalizedMessage);
    const requestedVisibleResult = /\b(report|read|summari[sz]e|tell me|show me|capture)\b.{0,40}\b(?:compile|apply|result|status|error|warning)\b/.test(normalizedMessage)
      || /\bvisible\s+(?:compile|apply|compiler|result|status|error|warning)\b/.test(normalizedMessage);

    const hasScriptPayload = actions.some((action) => {
      const type = String(action?.type || '').trim().toLowerCase();
      if (type === 'type') {
        const text = String(action?.text || '').trim();
        return containsPineScriptPayloadText(text);
      }
      if (type === 'run_command') {
        if (
          String(action?.pineCanonicalState?.sourcePath || '').trim()
          && action?.pineCanonicalState?.validation?.valid !== false
        ) {
          return true;
        }
        return /\bset-clipboard\b/i.test(String(action?.command || ''))
          && containsPineScriptPayloadText(String(action?.command || ''));
      }
      return false;
    });

    const hasInsertionStep = actions.some((action) => {
      const type = String(action?.type || '').trim().toLowerCase();
      if (type === 'type') {
        return containsPineScriptPayloadText(String(action?.text || ''));
      }
      if (type === 'key') {
        return String(action?.key || '').trim().toLowerCase() === 'ctrl+v';
      }
      return false;
    });

    const hasApplyStep = actions.some((action) => {
      const type = String(action?.type || '').trim().toLowerCase();
      const key = String(action?.key || '').trim().toLowerCase();
      const combined = [action?.reason, action?.text]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .join(' ');
      return (type === 'key' && key === 'ctrl+enter')
        || /\b(add|apply|load|put)\b.{0,20}\bchart\b/i.test(combined);
    });

    const hasVisibleResultReadback = actions.some((action) => {
      if (String(action?.type || '').trim().toLowerCase() !== 'get_text') return false;
      const text = String(action?.text || '').trim();
      const reason = String(action?.reason || '').trim();
      const evidenceMode = String(action?.pineEvidenceMode || '').trim().toLowerCase();
      return evidenceMode === 'compile-result'
        || /\b(?:added|error|warning|pine editor|compile|compiler|result|status)\b/i.test(`${text} ${reason}`);
    });

    if (!hasScriptPayload || !hasInsertionStep) {
      return true;
    }
    if (requestedAddToChart && !hasApplyStep) {
      return true;
    }
    if (requestedVisibleResult && !hasVisibleResultReadback) {
      return true;
    }

    return false;
  }

  function isTradingViewPineAuthoringRequest(userMessage = '') {
    const normalizedMessage = String(userMessage || '').toLowerCase();
    const hasAuthoringVerb = /\b(create|build|generate|write|draft|make|replace|overwrite|rewrite|fix|update|convert|migrate)\b/.test(normalizedMessage);
    const mentionsTradingViewPine = /\btradingview\b/.test(normalizedMessage)
      && (/\bpine\b/.test(normalizedMessage) || /\bscript\b/.test(normalizedMessage));
    const mentionsTradingViewAuthoringTarget = /\btradingview\b/.test(normalizedMessage)
      && /\b(indicator|strategy|library)\b/.test(normalizedMessage);
    const mentionsStandalonePineAuthoring = /\bpine(?:\s+script)?\b/.test(normalizedMessage)
      && /\b(indicator|strategy|library|script)\b/.test(normalizedMessage);
    return hasAuthoringVerb && (mentionsTradingViewPine || mentionsTradingViewAuthoringTarget || mentionsStandalonePineAuthoring);
  }

  function requestRequiresFreshTradingViewPineIndicator(userMessage = '') {
    const normalizedMessage = String(userMessage || '').toLowerCase();
    return /\bnew\s+(?:interactive\s+)?(?:chart\s+)?indicator\b/.test(normalizedMessage)
      || /\binteractive\s+chart\s+indicator\b/.test(normalizedMessage)
      || /\bnew\s+indicator\s+flow\b/.test(normalizedMessage)
      || /\bdoes\s+not\s+reuse\s+the\s+current\s+script\b/.test(normalizedMessage)
      || /\bnew\s+pine\s+(?:indicator|script)\b/.test(normalizedMessage);
  }

  function buildTradingViewPineAuthoringSystemContract(userMessage = '') {
    if (!isTradingViewPineAuthoringRequest(userMessage)) return '';

    const normalized = String(userMessage || '').toLowerCase();
    const requestedAddToChart = /\bctrl\s*\+\s*enter\b/.test(normalized)
      || /\b(add|apply|load|put)\b.{0,20}\bchart\b/.test(normalized);
    const requestedVisibleResult = /\b(report|read|summari[sz]e|tell me|show me|capture)\b.{0,40}\b(?:compile|apply|result|status|error|warning)\b/.test(normalized)
      || /\bvisible\s+(?:compile|apply|compiler|result|status|error|warning)\b/.test(normalized);
    const requiresFreshIndicator = requestRequiresFreshTradingViewPineIndicator(userMessage);
    const pineEditorRouteGuidanceLines = buildTradingViewPineEditorAutomationGuidanceLines();

    const lines = [
      'TRADINGVIEW PINE AUTHORING CONTRACT:',
      '- Return a complete executable TradingView Pine workflow, not just window activation.',
      ...pineEditorRouteGuidanceLines.map((line) => `- ${line}`),
      '- Inspect visible Pine Editor state before editing.',
      requiresFreshIndicator
        ? '- This request requires a fresh TradingView indicator script. Use the new-indicator flow and do not reuse or inspect-copy the existing script buffer as the authoring payload.'
        : '- Do not overwrite an existing visible script implicitly; prefer a safe new-script or bounded starter-script path unless the user explicitly asked to replace the current script.',
      '- Insert the actual Pine code with Set-Clipboard plus Ctrl+V or with direct multiline typing.',
      '- If you use Set-Clipboard, the clipboard payload must contain the Pine code itself.',
      '- The first Pine header line must be exactly `//@version=...` with no leading UI text such as `Pine editor`.',
      '- Do not use clipboard-inspection-only commands, websearch placeholders, or focus-only plans as substitutes for authoring.'
    ];

    if (requestedAddToChart) {
      lines.push('- Use Ctrl+Enter only after the script has been inserted and saved.');
    }
    if (requestedVisibleResult || requestedAddToChart) {
      lines.push('- Read visible compile/apply result text before claiming success.');
    }

    return lines.join('\n');
  }

  function extractPineScriptFromModelResponse(response = '') {
    const raw = String(response || '').trim();
    if (!raw) return '';

    const fencedMatch = raw.match(/```(?:pine|pinescript)?\s*([\s\S]*?)```/i);
    const candidate = fencedMatch?.[1] || raw;
    return sanitizePineScriptText(String(candidate || '').trim());
  }

  function normalizeGeneratedPineScript(pineScript = '') {
    const options = pineScript && typeof pineScript === 'object' && !Array.isArray(pineScript)
      ? pineScript
      : {};
    const rawPineScript = typeof pineScript === 'string' ? pineScript : (options.pineScript || '');
    let normalized = sanitizePineScriptText(String(rawPineScript || '').trim());
    if (!normalized) return '';

    const requestedVersion = detectRequestedPineVersion(options.userMessage || options.intent || '', normalized);
    const normalizedSource = normalizePineScriptSource(normalized, {
      intent: options.userMessage || options.intent || '',
      version: requestedVersion
    }).trim();
    const titleContract = synthesizePineScriptTitleContract({
      userMessage: options.userMessage || options.intent || '',
      source: normalizedSource,
      canonicalTitle: options.canonicalTitle || ''
    });
    return applyPineScriptTitleContract(normalizedSource, titleContract).trim();
  }

  function buildPineClipboardPreparationCommand(pineScript = '', options = {}) {
    const normalized = normalizeGeneratedPineScript({ pineScript, ...options });
    if (!normalized) return '';
    return `Set-Clipboard -Value @'\n${normalized}\n'@`;
  }

  function buildTradingViewPineCodeGenerationPrompt(userMessage = '') {
    if (!isTradingViewPineAuthoringRequest(userMessage)) return '';

    const requiresFreshIndicator = requestRequiresFreshTradingViewPineIndicator(userMessage);
    const pineVersion = detectRequestedPineVersion(userMessage);
    const titleContract = synthesizePineScriptTitleContract({ userMessage });
    return [
      'Return only Pine Script source code for this TradingView request.',
      'No markdown. No prose. No JSON. No tool calls.',
      `The first line must be exactly \`//@version=${pineVersion}\`.`,
      `Use this exact script title in the declaration: "${titleContract.title}".`,
      requiresFreshIndicator
        ? 'Generate a fresh indicator script for a new interactive chart indicator.'
        : 'Generate an indicator unless the user explicitly requested a strategy.',
      'Do not prepend UI text such as `Pine editor` before the version header.',
      `Request: ${String(userMessage || '').trim()}`
    ].join('\n');
  }

  function buildTradingViewPineCodeGenerationRetryPrompt(userMessage = '') {
    if (!isTradingViewPineAuthoringRequest(userMessage)) return '';

    const pineVersion = detectRequestedPineVersion(userMessage);
    const titleContract = synthesizePineScriptTitleContract({ userMessage });

    return `Return only Pine Script code. First line exactly //@version=${pineVersion}. Use this exact declaration title: "${titleContract.title}". No markdown, no prose, no JSON, no tool calls. Fresh indicator script. Request: ${String(userMessage || '').trim()}`;
  }

  function buildTradingViewPineCodeValidationRetryPrompt(userMessage = '', validation = null) {
    if (!isTradingViewPineAuthoringRequest(userMessage)) return '';

    const pineVersion = detectRequestedPineVersion(userMessage);
    const titleContract = synthesizePineScriptTitleContract({ userMessage });

    const issueLines = Array.isArray(validation?.issues)
      ? validation.issues
        .map((issue) => String(issue?.message || '').trim())
        .filter(Boolean)
        .slice(0, 5)
      : [];

    return [
      'Return only Pine Script code.',
      `First line exactly //@version=${pineVersion}.`,
      `Use this exact declaration title: "${titleContract.title}".`,
      'No markdown, no prose, no JSON, no tool calls.',
      'The previous Pine draft failed local validation and must be regenerated cleanly.',
      '- Do not include Pine Editor UI text anywhere inside the code body.',
      '- Do not emit corrupted identifiers or partial editor labels inside conditions or expressions.',
      ...(issueLines.length > 0 ? issueLines.map((line) => `- Fix this issue: ${line}`) : []),
      `Request: ${String(userMessage || '').trim()}`
    ].join('\n');
  }

  function buildIncompleteTradingViewPinePlanBlockMessage() {
    return [
      'Verified result: only a partial TradingView window-activation plan was produced.',
      'Bounded inference: no Pine script insertion payload or `Ctrl+Enter` add-to-chart step was generated, so Liku did not execute Pine edits or apply a script to the chart.',
      'Unverified next step: retry with a full TradingView Pine authoring plan that opens the Pine Editor, inserts the script, and verifies the compile/apply result.'
    ].join('\n');
  }

  function extractTradingViewPineTargetSymbol(text = '') {
    const raw = String(text || '');
    const chartMatch = raw.match(/\b(?:to|for|on)\s+the\s+([A-Z][A-Z0-9._-]{0,9})\s+chart\b/);
    if (chartMatch?.[1]) return chartMatch[1].toUpperCase();

    const symbolMatch = raw.match(/\b([A-Z][A-Z0-9._-]{1,9})\b(?=\s+chart\b)/);
    if (symbolMatch?.[1]) return symbolMatch[1].toUpperCase();

    return null;
  }

  function buildIncompleteTradingViewPineRecoveryPrompt(userMessage = '') {
    const raw = String(userMessage || '').trim();
    if (!raw) return '';

    const targetSymbol = extractTradingViewPineTargetSymbol(raw);
    const normalized = raw.toLowerCase();
    const requestedAddToChart = /\bctrl\s*\+\s*enter\b/.test(normalized)
      || /\b(add|apply|load|put)\b.{0,20}\bchart\b/.test(normalized);
    const pineEditorRouteGuidanceLines = buildTradingViewPineEditorAutomationGuidanceLines();

    return [
      'Retry the blocked TradingView Pine authoring task.',
      `Original request: ${raw}`,
      'You must respond ONLY with a JSON code block (```json ... ```).',
      'Return an object with keys: thought, actions, verification.',
      'Requirements:',
      '- Produce a complete executable TradingView Pine workflow, not just window activation.',
      ...pineEditorRouteGuidanceLines.map((line) => `- ${line}`),
      '- Inspect the visible Pine Editor state before editing.',
      '- Do not overwrite an existing visible script implicitly; prefer a safe new-script or bounded starter-script path unless the user explicitly asked to replace the current script.',
      '- Insert the Pine script content using substantive authoring actions such as Set-Clipboard plus Ctrl+V or direct Pine code typing.',
      '- If you use Set-Clipboard, the clipboard payload must contain the actual Pine code, and the first Pine header line must be exactly `//@version=...` with no `Pine editor` or other leading contamination.',
      '- Do not treat clipboard inspection, websearch placeholders, or focus-only steps as completion of the authoring task.',
      requestedAddToChart
        ? '- Use Ctrl+Enter only after the script is inserted, then read visible compile/apply result text.'
        : '- After insertion, verify visible Pine compile/apply result text before claiming success.',
      targetSymbol
        ? `- Keep the requested chart target in mind: ${targetSymbol}.`
        : '- Keep the requested TradingView chart target unchanged unless the user explicitly asked to switch symbols.'
    ].join('\n');
  }

  function formatAutomationActionBlockMessage(actionBlock = {}) {
    return '```json\n' + JSON.stringify({
      thought: actionBlock.thought || 'Executing requested actions',
      actions: Array.isArray(actionBlock.actions) ? actionBlock.actions : [],
      verification: actionBlock.verification || 'Verify the actions completed successfully'
    }, null, 2) + '\n```';
  }

  function maybeBuildRecoveredTradingViewPineActionResponse(actionBlock, userMessage = '') {
    if (!isIncompleteTradingViewPineAuthoringPlan(actionBlock, userMessage)) {
      return null;
    }

    const originalActions = Array.isArray(actionBlock?.actions) ? actionBlock.actions.filter(Boolean) : [];
    const salvageSeedActions = originalActions.length > 0
      ? originalActions
      : [{ type: 'focus_window', title: 'TradingView', processName: 'tradingview' }];
    const rewrittenActions = rewriteActionsForReliability(salvageSeedActions, { userMessage });

    const recovered = {
      thought: actionBlock?.thought || 'Create and apply the requested TradingView Pine script',
      actions: Array.isArray(rewrittenActions) ? rewrittenActions : [],
      verification: actionBlock?.verification || 'TradingView should show the Pine Editor workflow, bounded script insertion path, and visible compile/apply result.'
    };

    if (isIncompleteTradingViewPineAuthoringPlan(recovered, userMessage)) {
      return null;
    }

    return {
      actionBlock: recovered,
      message: formatAutomationActionBlockMessage(recovered)
    };
  }

  return {
    isIncompleteTradingViewPineAuthoringPlan,
    isTradingViewPineAuthoringRequest,
    buildTradingViewPineAuthoringSystemContract,
    extractPineScriptFromModelResponse,
    normalizeGeneratedPineScript,
    buildPineClipboardPreparationCommand,
    buildTradingViewPineCodeGenerationPrompt,
    buildTradingViewPineCodeGenerationRetryPrompt,
    buildTradingViewPineCodeValidationRetryPrompt,
    buildIncompleteTradingViewPinePlanBlockMessage,
    buildIncompleteTradingViewPineRecoveryPrompt,
    maybeBuildRecoveredTradingViewPineActionResponse
  };
}

module.exports = {
  createTradingViewPineAuthoringHelpers
};
