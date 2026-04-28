function createTradingViewPineRecoveryHelpers(deps = {}) {
  const {
    providerOrchestrator,
    containsPineScriptPayloadText,
    buildPineScriptState,
    persistPineScriptState,
    extractPineScriptFromModelResponse,
    normalizeGeneratedPineScript,
    buildPineClipboardPreparationCommand,
    isTradingViewPineAuthoringRequest,
    buildTradingViewPineCodeGenerationPrompt,
    buildTradingViewPineCodeGenerationRetryPrompt,
    buildTradingViewPineCodeValidationRetryPrompt,
    maybeBuildRecoveredTradingViewPineActionResponse,
    pineRecoveryDebugLog = () => {},
    getCwd = () => process.cwd()
  } = deps;

  const requiredFns = {
    providerOrchestrator,
    containsPineScriptPayloadText,
    buildPineScriptState,
    persistPineScriptState,
    extractPineScriptFromModelResponse,
    normalizeGeneratedPineScript,
    buildPineClipboardPreparationCommand,
    isTradingViewPineAuthoringRequest,
    buildTradingViewPineCodeGenerationPrompt,
    buildTradingViewPineCodeGenerationRetryPrompt,
    buildTradingViewPineCodeValidationRetryPrompt,
    maybeBuildRecoveredTradingViewPineActionResponse
  };

  for (const [name, value] of Object.entries(requiredFns)) {
    if (typeof value !== 'function' && name !== 'providerOrchestrator') {
      throw new Error(`createTradingViewPineRecoveryHelpers requires ${name}`);
    }
  }

  if (!providerOrchestrator || typeof providerOrchestrator.callProvider !== 'function') {
    throw new Error('createTradingViewPineRecoveryHelpers requires providerOrchestrator.callProvider');
  }

  async function requestTradingViewPineCodeOnly(promptText = '', effectiveModel = '') {
    if (!promptText) return '';

    pineRecoveryDebugLog('[AI][PINE-RECOVERY] Requesting Pine code with prompt:', promptText);
    const codeRaw = await providerOrchestrator.callProvider('copilot', [
      {
        role: 'system',
        content: 'TRADINGVIEW PINE CODE-ONLY MODE: Return only Pine Script source text. Do not emit tool calls, JSON, or prose.'
      },
      {
        role: 'user',
        content: promptText
      }
    ], effectiveModel);

    const codeContent = (codeRaw && typeof codeRaw === 'object' && typeof codeRaw.content === 'string')
      ? codeRaw.content
      : codeRaw;
    pineRecoveryDebugLog('[AI][PINE-RECOVERY] Raw Pine code response:', String(codeContent || ''));

    const extracted = extractPineScriptFromModelResponse(codeContent);
    const normalized = normalizeGeneratedPineScript(extracted);
    pineRecoveryDebugLog('[AI][PINE-RECOVERY] Extracted Pine snippet:', extracted);
    pineRecoveryDebugLog('[AI][PINE-RECOVERY] Normalized Pine snippet:', normalized);
    pineRecoveryDebugLog('[AI][PINE-RECOVERY] Contains Pine payload:', containsPineScriptPayloadText(normalized));
    return normalized;
  }

  async function maybeRecoverTradingViewPinePlanFromGeneratedCode({
    enhancedMessage = '',
    effectiveModel = ''
  } = {}) {
    if (!isTradingViewPineAuthoringRequest(enhancedMessage)) {
      return {
        recoveredPinePlan: null,
        routingNoteOverride: null,
        routingOverride: null,
        pineState: null,
        persistedPineState: null
      };
    }

    const pineCodePrompt = buildTradingViewPineCodeGenerationPrompt(enhancedMessage);
    if (!pineCodePrompt) {
      return {
        recoveredPinePlan: null,
        routingNoteOverride: null,
        routingOverride: null,
        pineState: null,
        persistedPineState: null
      };
    }

    pineRecoveryDebugLog('[AI][PINE-RECOVERY] Starting code-only recovery for TradingView Pine request');
    pineRecoveryDebugLog('[AI][PINE-RECOVERY] Code prompt:', pineCodePrompt);

    let pineScript = '';
    let pineState = null;

    const recoveryPrompts = [
      pineCodePrompt,
      buildTradingViewPineCodeGenerationRetryPrompt(enhancedMessage)
    ].filter(Boolean);

    for (let attempt = 0; attempt < 3; attempt++) {
      const promptText = recoveryPrompts[attempt]
        || buildTradingViewPineCodeValidationRetryPrompt(enhancedMessage, pineState?.validation);
      if (!promptText) break;

      pineScript = await requestTradingViewPineCodeOnly(promptText, effectiveModel);
      pineState = buildPineScriptState({
        source: pineScript,
        intent: enhancedMessage,
        origin: 'generated-recovery',
        targetApp: 'tradingview'
      });

      pineRecoveryDebugLog('[AI][PINE-RECOVERY] Local Pine validation:', JSON.stringify(pineState.validation || null));

      if (!containsPineScriptPayloadText(pineScript)) {
        pineRecoveryDebugLog('[AI][PINE-RECOVERY] Generated draft did not contain substantive Pine payload.');
        continue;
      }

      if (pineState?.validation?.valid) {
        break;
      }

      pineRecoveryDebugLog('[AI][PINE-RECOVERY] Generated Pine failed local validation. Retrying with validation-aware prompt.');
    }

    const persistedPineState = pineState?.validation?.valid
      ? persistPineScriptState(pineState, { cwd: getCwd() })
      : null;
    const clipboardCommand = pineState?.validation?.valid
      ? buildPineClipboardPreparationCommand(pineState.normalizedSource)
      : '';

    pineRecoveryDebugLog('[AI][PINE-RECOVERY] Clipboard command synthesized:', clipboardCommand);

    let recoveredPinePlan = null;
    let routingNoteOverride = null;
    let routingOverride = null;

    if (clipboardCommand && containsPineScriptPayloadText(pineScript) && pineState?.validation?.valid) {
      recoveredPinePlan = maybeBuildRecoveredTradingViewPineActionResponse({
        thought: 'Create and apply the requested TradingView Pine script',
        actions: [
          {
            type: 'run_command',
            shell: 'powershell',
            command: clipboardCommand,
            reason: 'Copy the prepared Pine script to the clipboard',
            pineCanonicalState: {
              id: pineState.id,
              scriptTitle: pineState.scriptTitle,
              sourceHash: pineState.sourceHash,
              origin: pineState.origin,
              validation: pineState.validation,
              sourcePath: persistedPineState?.sourcePath || null,
              metadataPath: persistedPineState?.metadataPath || null
            }
          }
        ],
        verification: 'TradingView should show the Pine Editor workflow, fresh indicator path, and visible compile/apply result.'
      }, enhancedMessage);
      pineRecoveryDebugLog('[AI][PINE-RECOVERY] Local Pine workflow recovery status:', !!recoveredPinePlan?.message);
      if (recoveredPinePlan?.message) {
        routingNoteOverride = 'locally synthesized TradingView Pine workflow from generated Pine code';
        routingOverride = { mode: 'recovered-tradingview-pine-plan' };
      }
    } else {
      const validationSummary = pineState?.validation?.valid === false
        ? ` Validation issues: ${(pineState.validation.issues || []).map((issue) => issue.message).filter(Boolean).join(' | ')}`
        : '';
      pineRecoveryDebugLog('[AI][PINE-RECOVERY] Pine recovery could not synthesize a clipboard workflow from generated code.');
      if (validationSummary) {
        pineRecoveryDebugLog(`[AI][PINE-RECOVERY]${validationSummary}`);
      }
    }

    return {
      recoveredPinePlan,
      routingNoteOverride,
      routingOverride,
      pineState,
      persistedPineState
    };
  }

  return {
    requestTradingViewPineCodeOnly,
    maybeRecoverTradingViewPinePlanFromGeneratedCode
  };
}

module.exports = {
  createTradingViewPineRecoveryHelpers
};
