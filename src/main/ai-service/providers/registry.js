const AI_PROVIDERS = {
  copilot: {
    baseUrl: 'api.githubcopilot.com',
    path: '/chat/completions',
    model: 'gpt-4o',
    visionModel: 'gpt-4o',
    chatModel: 'gpt-4o',
    reasoningModel: 'o1',
    automationModel: 'gpt-4o'
  },
  openai: {
    baseUrl: 'api.openai.com',
    path: '/v1/chat/completions',
    model: 'gpt-4o',
    visionModel: 'gpt-4o',
    chatModel: 'gpt-4o',
    reasoningModel: 'gpt-4o',
    automationModel: 'gpt-4o'
  },
  anthropic: {
    baseUrl: 'api.anthropic.com',
    path: '/v1/messages',
    model: 'claude-sonnet-4-20250514',
    visionModel: 'claude-sonnet-4-20250514',
    chatModel: 'claude-sonnet-4-20250514',
    reasoningModel: 'claude-sonnet-4-20250514',
    automationModel: 'claude-sonnet-4-20250514'
  },
  ollama: {
    baseUrl: 'localhost',
    port: 11434,
    path: '/api/chat',
    model: 'llama3.2-vision',
    visionModel: 'llama3.2-vision',
    chatModel: 'llama3.2-vision',
    reasoningModel: 'llama3.2-vision',
    automationModel: 'llama3.2-vision'
  }
};

function createProviderRegistry(env = process.env) {
  let currentProvider = 'copilot';
  const apiKeys = {
    copilot: env.GH_TOKEN || env.GITHUB_TOKEN || '',
    copilotSession: '',
    openai: env.OPENAI_API_KEY || '',
    anthropic: env.ANTHROPIC_API_KEY || ''
  };

  function getCurrentProvider() {
    return currentProvider;
  }

  function setProvider(provider) {
    if (!AI_PROVIDERS[provider]) {
      return false;
    }
    currentProvider = provider;
    return true;
  }

  function setApiKey(provider, key) {
    if (!Object.prototype.hasOwnProperty.call(apiKeys, provider)) {
      return false;
    }
    apiKeys[provider] = key;
    return true;
  }

  return {
    AI_PROVIDERS,
    apiKeys,
    getCurrentProvider,
    setApiKey,
    setProvider
  };
}

module.exports = {
  AI_PROVIDERS,
  createProviderRegistry
};
