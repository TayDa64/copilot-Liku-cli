const CORE_AI_PROVIDERS = {
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

const OPTIONAL_AI_PROVIDERS = {
  cerebras: {
    baseUrl: 'api.cerebras.ai',
    path: '/v1/chat/completions',
    model: 'gpt-oss-120b',
    visionModel: 'gpt-oss-120b',
    chatModel: 'gpt-oss-120b',
    reasoningModel: 'gpt-oss-120b',
    automationModel: 'gpt-oss-120b'
  },
  xai: {
    baseUrl: 'api.x.ai',
    path: '/v1/chat/completions',
    model: 'grok-4.6',
    visionModel: 'grok-4.6',
    chatModel: 'grok-4.6',
    reasoningModel: 'grok-4.6',
    automationModel: 'grok-4.6'
  }
};

const PROVIDER_MODEL_CATALOG = {
  cerebras: [
    { id: 'gpt-oss-120b', name: 'GPT-OSS 120B', categoryLabel: 'OpenAI-compatible Chat', capabilities: { chat: true, reasoning: true } }
  ],
  xai: [
    { id: 'grok-4.6', name: 'Grok 4.6', categoryLabel: 'xAI Reasoning / Supervisor', capabilities: { chat: true, reasoning: true, planning: true } },
    { id: 'grok-4.5', name: 'Grok 4.5', categoryLabel: 'xAI Reasoning / Supervisor', capabilities: { chat: true, reasoning: true, planning: true } },
    { id: 'grok-4.3', name: 'Grok 4.3', categoryLabel: 'xAI Reasoning', capabilities: { chat: true, reasoning: true } },
    { id: 'grok-4.20-0309-reasoning', name: 'Grok 4.20 Reasoning', categoryLabel: 'xAI Reasoning', capabilities: { chat: true, reasoning: true } },
    { id: 'grok-4.20-0309-non-reasoning', name: 'Grok 4.20 Non-Reasoning', categoryLabel: 'xAI Non-Reasoning', capabilities: { chat: true, reasoning: false } },
    { id: 'grok-build-0.1', name: 'Grok Build 0.1', categoryLabel: 'xAI Coding', capabilities: { chat: true, reasoning: true, planning: true } }
  ]
};

const OPTIONAL_PROVIDER_ENV = {
  cerebras: {
    key: 'CEREBRAS_API_KEY',
    flag: 'LIKU_ENABLE_CEREBRAS'
  },
  xai: {
    key: 'XAI_API_KEY',
    flag: 'LIKU_ENABLE_XAI'
  }
};

// Providers whose keys a user may set via /setkey. Excludes the managed
// copilotSession token so /setkey cannot overwrite the exchanged session key.
const USER_SETTABLE_PROVIDERS = new Set([
  'copilot',
  'openai',
  'anthropic',
  ...Object.keys(OPTIONAL_AI_PROVIDERS)
]);

const AI_PROVIDERS = {
  ...CORE_AI_PROVIDERS,
  ...OPTIONAL_AI_PROVIDERS
};

function isEnabledFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function cloneProviderConfig(config) {
  return { ...config };
}

function createEnabledProviders(env, apiKeys) {
  const providers = Object.fromEntries(
    Object.entries(CORE_AI_PROVIDERS).map(([provider, config]) => [provider, cloneProviderConfig(config)])
  );
  for (const [provider, config] of Object.entries(OPTIONAL_AI_PROVIDERS)) {
    const envConfig = OPTIONAL_PROVIDER_ENV[provider];
    if (apiKeys[provider] || isEnabledFlag(env[envConfig.flag])) {
      providers[provider] = cloneProviderConfig(config);
    }
  }
  return providers;
}

function createProviderRegistry(env = process.env) {
  let currentProvider = 'copilot';
  let providerExplicit = false;
  const apiKeys = {
    copilot: env.GH_TOKEN || env.GITHUB_TOKEN || '',
    copilotSession: '',
    openai: env.OPENAI_API_KEY || '',
    anthropic: env.ANTHROPIC_API_KEY || '',
    cerebras: env.CEREBRAS_API_KEY || '',
    xai: env.XAI_API_KEY || ''
  };
  const enabledProviders = createEnabledProviders(env, apiKeys);

  function getCurrentProvider() {
    return currentProvider;
  }

  function isProviderExplicit() {
    return providerExplicit;
  }

  function setProvider(provider) {
    if (!enabledProviders[provider]) {
      return false;
    }
    currentProvider = provider;
    providerExplicit = true;
    return true;
  }

  function setApiKey(provider, key) {
    if (!USER_SETTABLE_PROVIDERS.has(provider)) {
      return false;
    }
    if (!Object.prototype.hasOwnProperty.call(apiKeys, provider)) {
      return false;
    }
    apiKeys[provider] = key;
    if (OPTIONAL_AI_PROVIDERS[provider] && key) {
      enabledProviders[provider] = cloneProviderConfig(OPTIONAL_AI_PROVIDERS[provider]);
    }
    return true;
  }

  return {
    AI_PROVIDERS: enabledProviders,
    PROVIDER_MODEL_CATALOG,
    apiKeys,
    getCurrentProvider,
    isProviderExplicit,
    setApiKey,
    setProvider
  };
}

module.exports = {
  AI_PROVIDERS,
  CORE_AI_PROVIDERS,
  OPTIONAL_AI_PROVIDERS,
  OPTIONAL_PROVIDER_ENV,
  PROVIDER_MODEL_CATALOG,
  USER_SETTABLE_PROVIDERS,
  createProviderRegistry
};
