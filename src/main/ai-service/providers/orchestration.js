function createProviderOrchestrator(dependencies) {
  const {
    aiProviders,
    apiKeys,
    callAnthropic,
    callCopilot,
    callOllama,
    callOpenAI,
    getCurrentCopilotModel,
    getCurrentProvider,
    loadCopilotToken,
    modelRegistry,
    providerFallbackOrder,
    resolveCopilotModelKey
  } = dependencies;

  const { getPhaseParams } = require('./phase-params');

  function getModelCapabilities(modelKey) {
    const entry = modelRegistry()[modelKey] || {};
    if (entry.capabilities) {
      return entry.capabilities;
    }
    return {
      chat: true,
      tools: !entry.vision ? false : true,
      vision: !!entry.vision,
      reasoning: /^o(1|3)/i.test(String(entry.id || modelKey || '')),
      completion: false,
      automation: !!entry.vision,
      planning: !!entry.vision || /^o(1|3)/i.test(String(entry.id || modelKey || ''))
    };
  }

  function normalizeRoutingContext(includeVisualContextOrOptions) {
    if (typeof includeVisualContextOrOptions === 'object' && includeVisualContextOrOptions !== null) {
      return {
        includeVisualContext: !!includeVisualContextOrOptions.includeVisualContext,
        requiresAutomation: !!includeVisualContextOrOptions.requiresAutomation,
        preferPlanning: !!includeVisualContextOrOptions.preferPlanning,
        requiresTools: !!includeVisualContextOrOptions.requiresTools,
        explicitRequestedModel: includeVisualContextOrOptions.explicitRequestedModel !== false,
        tags: Array.isArray(includeVisualContextOrOptions.tags) ? includeVisualContextOrOptions.tags : [],
        phase: includeVisualContextOrOptions.phase || null
      };
    }

    return {
      includeVisualContext: !!includeVisualContextOrOptions,
      requiresAutomation: false,
      preferPlanning: false,
      requiresTools: false,
      explicitRequestedModel: true,
      tags: [],
      phase: null
    };
  }

  function buildRoutingNotice(fromModel, toModel, reason, context = {}) {
    if (!fromModel || !toModel || fromModel === toModel) return null;
    const labels = {
      'legacy-unavailable': 'legacy/unsupported model selection',
      vision: 'visual context',
      automation: 'automation/tool execution',
      planning: 'planning mode',
      tools: 'tool-calling'
    };
    return {
      rerouted: true,
      from: fromModel,
      to: toModel,
      reason,
      message: `Switched from ${fromModel} to ${toModel} for ${labels[reason] || 'capability routing'}.`,
      tags: context.tags || []
    };
  }

  function resolveFallbackModelForReason(reason, providerConfig) {
    switch (reason) {
      case 'planning':
        return providerConfig.reasoningModel || providerConfig.model || 'gpt-4o';
      case 'automation':
      case 'tools':
        return providerConfig.automationModel || providerConfig.visionModel || providerConfig.model || 'gpt-4o';
      case 'vision':
      default:
        return providerConfig.visionModel || providerConfig.chatModel || providerConfig.model || 'gpt-4o';
    }
  }

  async function callProvider(provider, messages, effectiveModel, requestOptions) {
    switch (provider) {
      case 'copilot':
        return callCopilot(messages, effectiveModel, requestOptions);
      case 'openai':
        return callOpenAI(messages);
      case 'anthropic':
        return callAnthropic(messages);
      case 'ollama':
      default:
        return callOllama(messages);
    }
  }

  function ensureProviderReady(provider) {
    switch (provider) {
      case 'copilot':
        if (!apiKeys.copilot && !loadCopilotToken()) {
          throw new Error('Not authenticated with GitHub Copilot.');
        }
        return;
      case 'openai':
        if (!apiKeys.openai) throw new Error('OpenAI API key not set.');
        return;
      case 'anthropic':
        if (!apiKeys.anthropic) throw new Error('Anthropic API key not set.');
        return;
      default:
        return;
    }
  }

  function normalizeProviderResult(provider, rawResult, effectiveModel) {
    if (provider === 'copilot' && rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult)) {
      return {
        response: typeof rawResult.content === 'string' ? rawResult.content : '',
        effectiveModel: rawResult.effectiveModel || effectiveModel,
        requestedModel: rawResult.requestedModel || effectiveModel,
        providerMetadata: {
          endpointHost: rawResult.endpointHost || null,
          actualModelId: rawResult.actualModelId || null
        }
      };
    }

    return {
      response: rawResult,
      effectiveModel,
      requestedModel: effectiveModel,
      providerMetadata: null
    };
  }

  async function invokeProvider(provider, messages, effectiveModel, requestOptions) {
    const rawResult = await callProvider(provider, messages, effectiveModel, requestOptions);
    return normalizeProviderResult(provider, rawResult, effectiveModel);
  }

  function resolveEffectiveCopilotModel(requestedModel, includeVisualContextOrOptions) {
    const routingContext = normalizeRoutingContext(includeVisualContextOrOptions);
    let effectiveModel = resolveCopilotModelKey(requestedModel);
    const availableModels = modelRegistry();
    const providerConfig = aiProviders.copilot || {};
    const originalModel = effectiveModel;
    let routing = null;

    if (!availableModels[effectiveModel]) {
      const fallback = resolveFallbackModelForReason('legacy-unavailable', providerConfig);
      effectiveModel = resolveCopilotModelKey(fallback);
      routing = buildRoutingNotice(originalModel || requestedModel, effectiveModel, 'legacy-unavailable', routingContext);
    }

    const capabilities = getModelCapabilities(effectiveModel);
    if (routingContext.includeVisualContext && !capabilities.vision) {
      const fallback = resolveCopilotModelKey(resolveFallbackModelForReason('vision', providerConfig));
      if (fallback !== effectiveModel) {
        routing = buildRoutingNotice(originalModel || effectiveModel, fallback, 'vision', routingContext);
        effectiveModel = fallback;
      }
    }

    const postVisionCapabilities = getModelCapabilities(effectiveModel);
    if ((routingContext.requiresAutomation || routingContext.requiresTools) && (!postVisionCapabilities.tools || !postVisionCapabilities.automation)) {
      const fallback = resolveCopilotModelKey(resolveFallbackModelForReason(routingContext.requiresAutomation ? 'automation' : 'tools', providerConfig));
      if (fallback !== effectiveModel) {
        routing = buildRoutingNotice(originalModel || effectiveModel, fallback, routingContext.requiresAutomation ? 'automation' : 'tools', routingContext);
        effectiveModel = fallback;
      }
    }

    const postAutomationCapabilities = getModelCapabilities(effectiveModel);
    if (routingContext.preferPlanning && !postAutomationCapabilities.planning) {
      const fallback = resolveCopilotModelKey(resolveFallbackModelForReason('planning', providerConfig));
      if (fallback !== effectiveModel) {
        routing = buildRoutingNotice(originalModel || effectiveModel, fallback, 'planning', routingContext);
        effectiveModel = fallback;
      }
    }

    return {
      effectiveModel,
      requestedModel: requestedModel || originalModel || effectiveModel,
      routing
    };
  }

  async function requestWithFallback(messages, requestedModel, includeVisualContextOrOptions) {
    const routingContext = normalizeRoutingContext(includeVisualContextOrOptions);
    let effectiveModel = getCurrentCopilotModel();
    let requestedCopilotModel = requestedModel || effectiveModel;
    const currentProvider = getCurrentProvider();
    const fallbackChain = [currentProvider, ...providerFallbackOrder.filter((provider) => provider !== currentProvider)];
    let primaryError = null;
    let lastError = null;
    let usedProvider = currentProvider;
    let response = null;
    let providerMetadata = null;
    let routing = null;

    for (const provider of fallbackChain) {
      try {
        ensureProviderReady(provider);
        // Compute phase-aware request options (RLVR Phase 2)
        let requestOptions;
        if (routingContext.phase) {
          const capabilities = getModelCapabilities(effectiveModel);
          requestOptions = getPhaseParams(routingContext.phase, capabilities);
        }
        if (provider === 'copilot') {
          const resolved = resolveEffectiveCopilotModel(requestedModel, routingContext);
          effectiveModel = resolved.effectiveModel;
          requestedCopilotModel = resolved.requestedModel || requestedCopilotModel;
          routing = resolved.routing || routing;
          // Re-compute phase params after model resolution (model may have changed)
          if (routingContext.phase) {
            const capabilities = getModelCapabilities(effectiveModel);
            requestOptions = getPhaseParams(routingContext.phase, capabilities);
          }
        }
        const result = await invokeProvider(provider, messages, effectiveModel, requestOptions);
        response = result.response;
        effectiveModel = result.effectiveModel;
        requestedCopilotModel = result.requestedModel;
        providerMetadata = {
          ...(result.providerMetadata || {}),
          routing
        };
        usedProvider = provider;
        if (usedProvider !== currentProvider) {
          console.log(`[AI] Fallback: ${currentProvider} failed, succeeded with ${usedProvider}`);
        }
        break;
      } catch (error) {
        if (!primaryError) {
          primaryError = error;
        }
        lastError = error;
        console.warn(`[AI] Provider ${provider} failed: ${error.message}`);
      }
    }

    if (!response) {
      throw primaryError || lastError || new Error('All AI providers failed.');
    }

    return {
      effectiveModel,
      requestedModel: requestedCopilotModel,
      providerMetadata,
      response,
      usedProvider
    };
  }

  return {
    callCurrentProvider: async (messages, effectiveModel) => {
      const result = await invokeProvider(getCurrentProvider(), messages, effectiveModel);
      return result.response;
    },
    callProvider,
    requestWithFallback,
    resolveEffectiveCopilotModel
  };
}

module.exports = {
  createProviderOrchestrator
};