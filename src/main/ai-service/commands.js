function createCommandHandler(dependencies) {
  const {
    aiProviders,
    captureVisualContext,
    clearVisualContext,
    exchangeForCopilotSession,
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
    setApiKey,
    setCopilotModel,
    setProvider,
    slashCommandHelpers,
    startCopilotOAuth
  } = dependencies;

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
        historyStore.saveConversationHistory();
        return { type: 'system', message: 'Conversation, visual context, and browser session state cleared.' };

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

          const model = slashCommandHelpers.normalizeModelKey(requested);
          if (setCopilotModel(model)) {
            const modelInfo = modelRegistry()[model];
            return {
              type: 'system',
              message: `Switched to ${modelInfo.name}${modelInfo.vision ? ' (supports vision)' : ''}`
            };
          }

          const available = Object.entries(modelRegistry())
            .map(([key, value]) => `  ${key} - ${value.name}`)
            .join('\n');
          return {
            type: 'error',
            message: `Unknown model. Available models:\n${available}`
          };
        }

        const models = Object.entries(modelRegistry()).map(([key, value]) => ({
          id: key,
          name: value.name,
          vision: value.vision,
          current: key === getCurrentCopilotModel()
        }));
        const list = models
          .map((model) => `${model.current ? '→' : ' '} ${model.id} - ${model.name}${model.vision ? ' 👁' : ''}`)
          .join('\n');
        const currentModel = getCurrentCopilotModel();
        const active = modelRegistry()[currentModel];
        return {
          type: 'info',
          message: `Current model: ${active?.name || currentModel}\n\nAvailable models:\n${list}\n\nUse /model <id> to switch (you can also paste "id - display name")`
        };

      case '/status': {
        loadCopilotTokenIfNeeded();
        const status = getStatus();
        return {
          type: 'info',
          message: `Provider: ${status.provider}\nModel: ${modelRegistry()[getCurrentCopilotModel()]?.name || getCurrentCopilotModel()}\nCopilot: ${status.hasCopilotKey ? 'Authenticated' : 'Not authenticated'}\nOpenAI: ${status.hasOpenAIKey ? 'Key set' : 'No key'}\nAnthropic: ${status.hasAnthropicKey ? 'Key set' : 'No key'}\nHistory: ${status.historyLength} messages\nVisual: ${status.visualContextCount} captures`
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