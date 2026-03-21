function createCommandHandler(dependencies) {
  const {
    aiProviders,
    captureVisualContext,
    clearVisualContext,
    exchangeForCopilotSession,
    getCopilotModels,
    getCurrentCopilotModel,
    getCurrentProvider,
    getStatus,
    getVisualContextCount,
    historyStore,
    isOAuthInProgress,
    loadCopilotTokenIfNeeded,
    logoutCopilot,
    modelRegistry,
    resetBrowserSessionState,
    clearSessionIntentState,
    getSessionIntentState,
    setApiKey,
    setCopilotModel,
    setProvider,
    slashCommandHelpers,
    startCopilotOAuth
  } = dependencies;

  function getDisplayModels() {
    if (typeof getCopilotModels === 'function') {
      return getCopilotModels().filter((model) => model.selectable !== false);
    }
    return Object.entries(modelRegistry()).map(([key, value]) => ({
      id: key,
      name: value.name,
      vision: !!value.vision,
      capabilities: value.capabilities || null,
      category: value.capabilities?.tools && value.capabilities?.vision
        ? 'agentic-vision'
        : value.capabilities?.reasoning
          ? 'reasoning-planning'
          : 'standard-chat',
      categoryLabel: value.capabilities?.tools && value.capabilities?.vision
        ? 'Agentic Vision'
        : value.capabilities?.reasoning
          ? 'Reasoning / Planning'
          : 'Standard Chat',
      current: key === getCurrentCopilotModel(),
      selectable: true
    }));
  }

  function formatCapabilitySuffix(model) {
    const caps = model.capabilities || {};
    const labels = [];
    if (caps.tools) labels.push('tools');
    if (caps.vision) labels.push('vision');
    if (caps.reasoning) labels.push('reasoning');
    const sections = [];
    if (labels.length) sections.push(`[${labels.join(', ')}]`);
    if (model.premiumMultiplier) sections.push(`[${model.premiumMultiplier}x]`);
    if (Array.isArray(model.recommendationTags) && model.recommendationTags.length) {
      sections.push(`[${model.recommendationTags.join(', ')}]`);
    }
    return sections.length ? ` ${sections.join(' ')}` : '';
  }

  function scoreGptModel(model) {
    const id = String(model?.id || '').toLowerCase();
    const match = id.match(/^gpt-(\d+)(?:\.(\d+))?/);
    if (!match) return Number.NEGATIVE_INFINITY;
    const major = Number(match[1] || 0);
    const minor = Number(match[2] || 0);
    const miniPenalty = id.includes('mini') ? -0.1 : 0;
    return major * 100 + minor + miniPenalty;
  }

  function resolveModelShortcut(requested, models) {
    const normalized = String(requested || '').trim().toLowerCase();
    const selectable = models.filter((model) => model.selectable !== false);
    if (!normalized) return null;

    if (['cheap', 'budget', 'free', 'older', 'vision-cheap', 'cheap-vision'].includes(normalized)) {
      return selectable.find((model) => Array.isArray(model.recommendationTags) && model.recommendationTags.includes('budget')) || null;
    }

    if (['latest-gpt', 'newest-gpt', 'gpt-latest'].includes(normalized)) {
      return selectable
        .filter((model) => /^gpt-/i.test(model.id || ''))
        .sort((left, right) => scoreGptModel(right) - scoreGptModel(left))[0] || null;
    }

    return null;
  }

  function formatGroupedModelList(models) {
    const sections = [];
    const grouped = new Map();
    for (const model of models) {
      const key = model.categoryLabel || 'Other';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(model);
    }
    for (const [label, entries] of grouped.entries()) {
      sections.push(`${label}:`);
      for (const model of entries) {
        sections.push(`${model.current ? '→' : ' '} ${model.id} - ${model.name}${formatCapabilitySuffix(model)}`);
      }
      sections.push('');
    }
    return sections.join('\n').trim();
  }

  function handleCommand(command) {
    const parts = slashCommandHelpers.tokenize(String(command || '').trim());
    const cmd = (parts[0] || '').toLowerCase();

    switch (cmd) {
      case '/provider':
        if (parts[1]) {
          if (setProvider(parts[1])) {
            return { type: 'system', message: `Switched to ${parts[1]} provider.` };
          }
          return { type: 'error', message: `Unknown provider. Available: ${Object.keys(aiProviders).join(', ')}` };
        }
        return { type: 'info', message: `Current provider: ${getCurrentProvider()}\nAvailable: ${Object.keys(aiProviders).join(', ')}` };

      case '/setkey':
        if (parts[1] && parts[2]) {
          if (setApiKey(parts[1], parts[2])) {
            return { type: 'system', message: `API key set for ${parts[1]}.` };
          }
        }
        return { type: 'error', message: 'Usage: /setkey <provider> <key>' };

      case '/clear':
        historyStore.clearConversationHistory();
        clearVisualContext();
        resetBrowserSessionState();
        if (typeof clearSessionIntentState === 'function') {
          clearSessionIntentState();
        }
        historyStore.saveConversationHistory();
        return { type: 'system', message: 'Conversation, visual context, browser session state, and session intent state cleared.' };

      case '/state': {
        if (parts[1] === 'clear') {
          if (typeof clearSessionIntentState === 'function') {
            clearSessionIntentState();
          }
          return { type: 'system', message: 'Session intent state cleared.' };
        }
        if (typeof getSessionIntentState === 'function') {
          const state = getSessionIntentState();
          const lines = [];
          if (state.currentRepo?.repoName) lines.push(`Current repo: ${state.currentRepo.repoName}`);
          if (state.downstreamRepoIntent?.repoName) lines.push(`Downstream repo intent: ${state.downstreamRepoIntent.repoName}`);
          if (Array.isArray(state.forgoneFeatures) && state.forgoneFeatures.length > 0) {
            lines.push(`Forgone features: ${state.forgoneFeatures.map((entry) => entry.feature).join(', ')}`);
          }
          if (Array.isArray(state.explicitCorrections) && state.explicitCorrections.length > 0) {
            lines.push(`Recent corrections: ${state.explicitCorrections.slice(-3).map((entry) => entry.text).join(' | ')}`);
          }
          return { type: 'info', message: lines.join('\n') || 'No session intent state recorded.' };
        }
        return { type: 'info', message: 'Session intent state is unavailable.' };
      }

      case '/vision':
        if (parts[1] === 'on') {
          return { type: 'info', message: 'Visual context will be included in next message. Use the capture button first.' };
        }
        if (parts[1] === 'off') {
          clearVisualContext();
          return { type: 'system', message: 'Visual context cleared.' };
        }
        return { type: 'info', message: `Visual context buffer: ${getVisualContextCount()} image(s)` };

      case '/capture':
        return captureVisualContext();

      case '/login':
        if (isOAuthInProgress()) {
          return {
            type: 'info',
            message: 'Login is already in progress. Complete the browser step and return here.'
          };
        }

        if (loadCopilotTokenIfNeeded()) {
          return exchangeForCopilotSession()
            .then(() => ({
              type: 'system',
              message: 'Already authenticated with GitHub Copilot. Session refreshed successfully.'
            }))
            .catch(() => startCopilotOAuth()
              .then((result) => ({
                type: 'login',
                message: `GitHub Copilot authentication started!\n\nYour code: ${result.user_code}\n\nA browser window has opened. Enter the code to authorize.\nWaiting for authentication...`
              }))
              .catch((err) => ({
                type: 'error',
                message: `Login failed: ${err.message}`
              }))
            );
        }

        return startCopilotOAuth()
          .then((result) => ({
            type: 'login',
            message: `GitHub Copilot authentication started!\n\nYour code: ${result.user_code}\n\nA browser window has opened. Enter the code to authorize.\nWaiting for authentication...`
          }))
          .catch((err) => ({
            type: 'error',
            message: `Login failed: ${err.message}`
          }));

      case '/logout':
        logoutCopilot();
        return { type: 'system', message: 'Logged out from GitHub Copilot.' };

      case '/model':
        if (parts.length > 1) {
          const models = getDisplayModels();
          let requested = null;
          if (parts[1] === '--set') {
            requested = parts.slice(2).join(' ');
          } else if (parts[1] === '--current' || parts[1] === 'current') {
            const currentModel = getCurrentCopilotModel();
            const current = modelRegistry()[currentModel];
            return {
              type: 'info',
              message: `Current model: ${current?.name || currentModel} (${currentModel})`
            };
          } else {
            requested = parts.slice(1).join(' ');
          }

          const shortcutModel = resolveModelShortcut(requested, models);
          const model = shortcutModel?.id || slashCommandHelpers.normalizeModelKey(requested);
          if (setCopilotModel(model)) {
            const modelInfo = modelRegistry()[model];
            return {
              type: 'system',
              message: `Switched to ${modelInfo.name}${modelInfo.vision ? ' (supports vision)' : ''}${shortcutModel ? ` via ${String(requested).trim().toLowerCase()} alias` : ''}`
            };
          }

          const available = formatGroupedModelList(models);
          return {
            type: 'error',
            message: `Unknown model. Available models:\n${available}\n\nShortcuts: /model cheap, /model latest-gpt`
          };
        }

        const models = getDisplayModels();
        const list = formatGroupedModelList(models);
        const currentModel = getCurrentCopilotModel();
        const active = modelRegistry()[currentModel];
        return {
          type: 'info',
          message: `Current model: ${active?.name || currentModel}\n\nAvailable models:\n${list}\n\nUse /model <id> to switch (you can also paste "id - display name"). Shortcuts: /model cheap, /model latest-gpt`
        };

      case '/status': {
        loadCopilotTokenIfNeeded();
        const status = getStatus();
        const runtimeModelLabel = status.runtimeModelName || 'not yet validated';
        const runtimeHostLabel = status.runtimeEndpointHost || 'not yet validated';
        return {
          type: 'info',
          message: `Provider: ${status.provider}\nConfigured model: ${status.configuredModelName || modelRegistry()[getCurrentCopilotModel()]?.name || getCurrentCopilotModel()} (${status.configuredModel || getCurrentCopilotModel()})\nRequested model: ${status.requestedModel || status.configuredModel || getCurrentCopilotModel()}\nRuntime model: ${runtimeModelLabel}${status.runtimeModel ? ` (${status.runtimeModel})` : ''}\nRuntime endpoint: ${runtimeHostLabel}\nCopilot: ${status.hasCopilotKey ? 'Authenticated' : 'Not authenticated'}\nOpenAI: ${status.hasOpenAIKey ? 'Key set' : 'No key'}\nAnthropic: ${status.hasAnthropicKey ? 'Key set' : 'No key'}\nHistory: ${status.historyLength} messages\nVisual: ${status.visualContextCount} captures`
        };
      }

      case '/help':
        return {
          type: 'info',
          message: `Available commands:
/login - Authenticate with GitHub Copilot (recommended)
/logout - Remove GitHub Copilot authentication
/model [name] - List or set Copilot model
/sequence [on|off] - (CLI chat) step-by-step execution prompts
/provider [name] - Get/set AI provider (copilot, openai, anthropic, ollama)
/setkey <provider> <key> - Set API key
/status - Show authentication status
/state [clear] - Show or clear session intent constraints
/clear - Clear conversation history
/vision [on|off] - Manage visual context
/capture - Capture screen for AI analysis
/help - Show this help`
        };

      default:
        return null;
    }
  }

  return {
    handleCommand
  };
}

module.exports = {
  createCommandHandler
};