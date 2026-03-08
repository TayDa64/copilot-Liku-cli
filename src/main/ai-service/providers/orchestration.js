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

  async function callProvider(provider, messages, effectiveModel) {
    switch (provider) {
      case 'copilot':
        return callCopilot(messages, effectiveModel);
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

  function resolveEffectiveCopilotModel(requestedModel, includeVisualContext) {
    let effectiveModel = resolveCopilotModelKey(requestedModel);
    const availableModels = modelRegistry();
    if (includeVisualContext && availableModels[effectiveModel] && !availableModels[effectiveModel].vision) {
      const visionFallback = aiProviders.copilot.visionModel || 'gpt-4o';
      console.log(`[AI] Model ${effectiveModel} lacks vision, upgrading to ${visionFallback} for visual context`);
      effectiveModel = visionFallback;
    }
    return effectiveModel;
  }

  async function requestWithFallback(messages, requestedModel, includeVisualContext) {
    let effectiveModel = getCurrentCopilotModel();
    const currentProvider = getCurrentProvider();
    const fallbackChain = [currentProvider, ...providerFallbackOrder.filter((provider) => provider !== currentProvider)];
    let lastError = null;
    let usedProvider = currentProvider;
    let response = null;

    for (const provider of fallbackChain) {
      try {
        ensureProviderReady(provider);
        if (provider === 'copilot') {
          effectiveModel = resolveEffectiveCopilotModel(requestedModel, includeVisualContext);
        }
        response = await callProvider(provider, messages, effectiveModel);
        usedProvider = provider;
        if (usedProvider !== currentProvider) {
          console.log(`[AI] Fallback: ${currentProvider} failed, succeeded with ${usedProvider}`);
        }
        break;
      } catch (error) {
        lastError = error;
        console.warn(`[AI] Provider ${provider} failed: ${error.message}`);
      }
    }

    if (!response) {
      throw lastError || new Error('All AI providers failed.');
    }

    return {
      effectiveModel,
      response,
      usedProvider
    };
  }

  return {
    callCurrentProvider: (messages, effectiveModel) => callProvider(getCurrentProvider(), messages, effectiveModel),
    callProvider,
    requestWithFallback,
    resolveEffectiveCopilotModel
  };
}

module.exports = {
  createProviderOrchestrator
};