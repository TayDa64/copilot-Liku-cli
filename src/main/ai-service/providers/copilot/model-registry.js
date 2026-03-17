const fs = require('fs');
const https = require('https');
const path = require('path');

const DEFAULT_CAPABILITIES = Object.freeze({
  chat: false,
  tools: false,
  vision: false,
  reasoning: false,
  completion: false,
  automation: false,
  planning: false
});

const LEGACY_MODEL_ALIASES = Object.freeze({
  'gpt-5.4': 'gpt-4o',
  'o1': 'gpt-4o',
  'o1-mini': 'gpt-4o-mini',
  'o3-mini': 'gpt-4o-mini'
});

function withCapabilities(overrides = {}) {
  const capabilities = { ...DEFAULT_CAPABILITIES, ...overrides };
  capabilities.vision = !!capabilities.vision;
  return capabilities;
}

const COPILOT_MODELS = {
  'claude-sonnet-4.5': {
    name: 'Claude Sonnet 4.5',
    id: 'claude-sonnet-4.5',
    vision: true,
    capabilities: withCapabilities({ chat: true, tools: true, vision: true, automation: true, planning: true })
  },
  'claude-sonnet-4': {
    name: 'Claude Sonnet 4',
    id: 'claude-sonnet-4',
    vision: true,
    capabilities: withCapabilities({ chat: true, tools: true, vision: true, automation: true, planning: true })
  },
  'claude-sonnet-4.6': {
    name: 'Claude Sonnet 4.6',
    id: 'claude-sonnet-4.6',
    vision: true,
    capabilities: withCapabilities({ chat: true, tools: true, vision: true, automation: true, planning: true })
  },
  'claude-opus-4.5': {
    name: 'Claude Opus 4.5',
    id: 'claude-opus-4.5',
    vision: true,
    capabilities: withCapabilities({ chat: true, tools: true, vision: true, automation: true, planning: true })
  },
  'claude-opus-4.6': {
    name: 'Claude Opus 4.6',
    id: 'claude-opus-4.6',
    vision: true,
    capabilities: withCapabilities({ chat: true, tools: true, vision: true, automation: true, planning: true })
  },
  'claude-haiku-4.5': {
    name: 'Claude Haiku 4.5',
    id: 'claude-haiku-4.5',
    vision: true,
    capabilities: withCapabilities({ chat: true, tools: true, vision: true, automation: true, planning: true })
  },
  'gpt-4o': {
    name: 'GPT-4o',
    id: 'gpt-4o',
    vision: true,
    capabilities: withCapabilities({ chat: true, tools: true, vision: true, automation: true, planning: true })
  },
  'gpt-4o-mini': {
    name: 'GPT-4o Mini',
    id: 'gpt-4o-mini',
    vision: true,
    capabilities: withCapabilities({ chat: true, tools: true, vision: true, automation: true, planning: true })
  },
  'gpt-4.1': {
    name: 'GPT-4.1',
    id: 'gpt-4.1',
    vision: true,
    capabilities: withCapabilities({ chat: true, tools: true, vision: true, automation: true, planning: true })
  },
  'gpt-5.1': {
    name: 'GPT-5.1',
    id: 'gpt-5.1',
    vision: true,
    capabilities: withCapabilities({ chat: true, tools: true, vision: true, automation: true, planning: true })
  },
  'gpt-5.2': {
    name: 'GPT-5.2',
    id: 'gpt-5.2',
    vision: true,
    capabilities: withCapabilities({ chat: true, tools: true, vision: true, automation: true, planning: true })
  },
  'gpt-5-mini': {
    name: 'GPT-5 Mini',
    id: 'gpt-5-mini',
    vision: true,
    capabilities: withCapabilities({ chat: true, tools: true, vision: true, automation: true, planning: true })
  },
  'gemini-2.5-pro': {
    name: 'Gemini 2.5 Pro',
    id: 'gemini-2.5-pro',
    vision: true,
    capabilities: withCapabilities({ chat: true, tools: true, vision: true, reasoning: true, planning: true })
  }
};

function canonicalizeModelKey(modelKey = '') {
  const normalized = String(modelKey || '').trim().toLowerCase();
  if (!normalized) return '';
  return LEGACY_MODEL_ALIASES[normalized] || normalized;
}

function inferReasoningCapability(modelId = '') {
  const id = String(modelId || '').toLowerCase();
  return /(^|[-_])(o1|o3)([-_]|$)/.test(id);
}

function inferCompletionCapability(modelId = '') {
  const id = String(modelId || '').toLowerCase();
  return id.includes('codex') || id.includes('fim') || id.includes('completion');
}

function inferToolCapability(modelId = '') {
  const id = String(modelId || '').toLowerCase();
  if (!id) return false;
  if (inferReasoningCapability(id) || inferCompletionCapability(id)) return false;
  return /(gpt|claude|gemini|grok)/i.test(id);
}

function inferCapabilities(modelId = '', partial = {}) {
  const vision = partial.vision ?? inferVisionCapability(modelId);
  const reasoning = partial.reasoning ?? inferReasoningCapability(modelId);
  const completion = partial.completion ?? inferCompletionCapability(modelId);
  const tools = partial.tools ?? inferToolCapability(modelId);
  const chat = partial.chat ?? !completion;
  return withCapabilities({
    chat,
    tools,
    vision,
    reasoning,
    completion,
    automation: partial.automation ?? (chat && tools),
    planning: partial.planning ?? (chat && (tools || reasoning))
  });
}

function listCapabilities(modelEntry = {}) {
  return Object.entries(modelEntry.capabilities || {})
    .filter(([, enabled]) => !!enabled)
    .map(([name]) => name)
    .sort();
}

function categorizeModel(modelEntry = {}) {
  const capabilities = modelEntry.capabilities || DEFAULT_CAPABILITIES;
  if (capabilities.completion) {
    return { key: 'completion', label: 'Code Completion', selectable: false };
  }
  if (capabilities.tools && capabilities.vision) {
    return { key: 'agentic-vision', label: 'Agentic Vision', selectable: true };
  }
  if (capabilities.reasoning && !capabilities.tools) {
    return { key: 'reasoning-planning', label: 'Reasoning / Planning', selectable: true };
  }
  return { key: 'standard-chat', label: 'Standard Chat', selectable: true };
}

function inferVisionCapability(modelId = '') {
  const id = String(modelId || '').toLowerCase();
  if (!id) return false;
  if (/\bo1\b|\bo3-mini\b|\bo1-mini\b/.test(id)) return false;
  if (id.includes('vision')) return true;
  if (id.includes('gpt-4') || id.includes('claude')) return true;
  return false;
}

function requestJson(hostname, requestPath, headers = {}, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path: requestPath,
      method: 'GET',
      headers,
      timeout: timeoutMs
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP_${res.statusCode}`));
        }
        try {
          resolve(JSON.parse(body || '{}'));
        } catch {
          reject(new Error('Invalid JSON response'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    req.end();
  });
}

function createCopilotModelRegistry({ likuHome, modelPrefFile, runtimeStateFile, initialProvider = 'copilot' }) {
  const dynamicCopilotModels = {};
  let copilotModelDiscoveryAttempted = false;
  let currentCopilotModel = 'gpt-4o';
  let currentProvider = initialProvider;
  const resolvedRuntimeStateFile = runtimeStateFile || path.join(likuHome, 'copilot-runtime-state.json');
  let currentModelMetadata = {
    modelId: currentCopilotModel,
    provider: currentProvider,
    modelVersion: COPILOT_MODELS[currentCopilotModel]?.id || null,
    capabilities: listCapabilities(COPILOT_MODELS[currentCopilotModel]),
    lastUpdated: new Date().toISOString()
  };
  let runtimeSelection = {
    requestedModel: currentCopilotModel,
    runtimeModel: null,
    endpointHost: null,
    actualModelId: null,
    lastValidated: null,
    validatedFallbacks: {}
  };

  function modelRegistry() {
    return { ...COPILOT_MODELS, ...dynamicCopilotModels };
  }

  function normalizeModelKeyFromId(modelId) {
    const raw = canonicalizeModelKey(modelId);
    if (!raw) return '';
    return raw.replace(/-20\d{6}$/g, '');
  }

  function refreshCurrentModelMetadata() {
    const selected = modelRegistry()[currentCopilotModel];
    currentModelMetadata = {
      modelId: currentCopilotModel,
      provider: currentProvider,
      modelVersion: selected?.id || null,
      capabilities: listCapabilities(selected),
      lastUpdated: new Date().toISOString()
    };
  }

  function upsertDynamicCopilotModel(entry) {
    if (!entry || !entry.id) return;
    if (entry.modelPickerEnabled === false) return;
    if (entry.chatCompletionsSupported === false) return;
    if (entry.type && entry.type !== 'chat') return;
    const idLower = String(entry.id).toLowerCase();
    if (idLower.includes('embedding') || idLower.includes('ada-002') || idLower.startsWith('oswe-')) {
      return;
    }
    if (!/(gpt|claude|gemini|\bo1\b|\bo3\b|grok)/i.test(idLower)) {
      return;
    }
    const key = normalizeModelKeyFromId(entry.id);
    if (!key) return;
    if (COPILOT_MODELS[key]) return;
    const capabilities = inferCapabilities(entry.id, {
      vision: entry.vision,
      chat: entry.chat,
      tools: entry.tools,
      reasoning: entry.reasoning,
      completion: entry.completion,
      automation: entry.automation,
      planning: entry.planning
    });
    dynamicCopilotModels[key] = {
      name: entry.name || entry.id,
      id: entry.id,
      vision: capabilities.vision,
      capabilities
    };
  }

  function saveModelPreference() {
    try {
      if (!fs.existsSync(likuHome)) {
        fs.mkdirSync(likuHome, { recursive: true, mode: 0o700 });
      }
      fs.writeFileSync(
        modelPrefFile,
        JSON.stringify({ copilotModel: currentCopilotModel, savedAt: new Date().toISOString() }),
        { mode: 0o600 }
      );
    } catch (error) {
      console.warn('[AI] Could not save model preference:', error.message);
    }
  }

  function saveRuntimeState() {
    try {
      if (!fs.existsSync(likuHome)) {
        fs.mkdirSync(likuHome, { recursive: true, mode: 0o700 });
      }
      fs.writeFileSync(resolvedRuntimeStateFile, JSON.stringify(runtimeSelection), { mode: 0o600 });
    } catch (error) {
      console.warn('[AI] Could not save Copilot runtime state:', error.message);
    }
  }

  function loadRuntimeState() {
    try {
      if (!fs.existsSync(resolvedRuntimeStateFile)) {
        return;
      }
      const parsed = JSON.parse(fs.readFileSync(resolvedRuntimeStateFile, 'utf-8'));
      const validatedFallbacks = parsed?.validatedFallbacks && typeof parsed.validatedFallbacks === 'object'
        ? Object.fromEntries(
            Object.entries(parsed.validatedFallbacks)
              .map(([key, value]) => [canonicalizeModelKey(key), canonicalizeModelKey(value)])
              .filter(([key, value]) => key && value)
          )
        : {};

      runtimeSelection = {
        requestedModel: canonicalizeModelKey(parsed?.requestedModel || currentCopilotModel || '') || currentCopilotModel,
        runtimeModel: parsed?.runtimeModel ? canonicalizeModelKey(parsed.runtimeModel) : null,
        endpointHost: parsed?.endpointHost ? String(parsed.endpointHost).trim() : null,
        actualModelId: parsed?.actualModelId ? String(parsed.actualModelId).trim() : null,
        lastValidated: parsed?.lastValidated ? String(parsed.lastValidated).trim() : null,
        validatedFallbacks
      };
    } catch (error) {
      console.warn('[AI] Could not load Copilot runtime state:', error.message);
    }
  }

  function loadModelPreference() {
    try {
      if (!fs.existsSync(modelPrefFile)) {
        return;
      }
      const parsed = JSON.parse(fs.readFileSync(modelPrefFile, 'utf-8'));
      const preferred = canonicalizeModelKey(parsed?.copilotModel);
      if (!preferred) return;

      const registry = modelRegistry();
      if (registry[preferred]) {
        currentCopilotModel = preferred;
        refreshCurrentModelMetadata();
        return;
      }

      upsertDynamicCopilotModel({
        id: preferred,
        name: preferred,
        vision: inferVisionCapability(preferred),
        capabilities: inferCapabilities(preferred)
      });
      if (modelRegistry()[preferred]) {
        currentCopilotModel = preferred;
        refreshCurrentModelMetadata();
      }
    } catch (error) {
      console.warn('[AI] Could not load model preference:', error.message);
    } finally {
      loadRuntimeState();
    }
  }

  function setProvider(provider) {
    currentProvider = provider;
    currentModelMetadata.provider = provider;
    currentModelMetadata.lastUpdated = new Date().toISOString();
  }

  function setCopilotModel(model) {
    const resolvedModel = canonicalizeModelKey(model);
    const registry = modelRegistry();
    if (resolvedModel && registry[resolvedModel] && categorizeModel(registry[resolvedModel]).selectable !== false) {
      currentCopilotModel = resolvedModel;
      refreshCurrentModelMetadata();
      saveModelPreference();
      runtimeSelection = {
        ...runtimeSelection,
        requestedModel: resolvedModel,
        runtimeModel: null,
        endpointHost: null,
        actualModelId: null,
        lastValidated: null
      };
      saveRuntimeState();
      return true;
    }
    return false;
  }

  function resolveCopilotModelKey(requestedModel) {
    const canonicalKey = canonicalizeModelKey(requestedModel);
    const registry = modelRegistry();
    if (canonicalKey && registry[canonicalKey]) {
      return canonicalKey;
    }
    return currentCopilotModel;
  }

  function getCopilotModels() {
    const groupedOrder = ['agentic-vision', 'reasoning-planning', 'standard-chat', 'completion'];
    return Object.entries(modelRegistry())
      .map(([key, value]) => {
        const category = categorizeModel(value);
        return {
          id: key,
          name: value.name,
          vision: !!value.vision,
          capabilities: { ...(value.capabilities || inferCapabilities(value.id || key, { vision: value.vision })) },
          capabilityList: listCapabilities(value),
          category: category.key,
          categoryLabel: category.label,
          selectable: category.selectable,
          current: key === currentCopilotModel
        };
      })
      .sort((left, right) => {
        const categoryDelta = groupedOrder.indexOf(left.category) - groupedOrder.indexOf(right.category);
        if (categoryDelta !== 0) return categoryDelta;
        if (left.current && !right.current) return -1;
        if (right.current && !left.current) return 1;
        return left.name.localeCompare(right.name);
      });
  }

  async function discoverCopilotModels({ force = false, loadCopilotTokenIfNeeded, exchangeForCopilotSession, getCopilotSessionToken, getSessionApiHost }) {
    if (copilotModelDiscoveryAttempted && !force) return getCopilotModels();
    copilotModelDiscoveryAttempted = true;

    if (!loadCopilotTokenIfNeeded()) {
      return getCopilotModels();
    }

    if (!getCopilotSessionToken()) {
      try {
        await exchangeForCopilotSession();
      } catch {
        return getCopilotModels();
      }
    }

    const headers = {
      Authorization: `Bearer ${getCopilotSessionToken()}`,
      Accept: 'application/json',
      'User-Agent': 'GithubCopilot/1.0.0',
      'Editor-Version': 'vscode/1.96.0',
      'Editor-Plugin-Version': 'copilot-chat/0.22.0',
      'Copilot-Integration-Id': 'vscode-chat'
    };

    const dynamicHost = typeof getSessionApiHost === 'function' ? getSessionApiHost() : null;
    const candidates = [
      ...(dynamicHost ? [{ host: dynamicHost, path: '/models' }] : []),
      { host: 'api.individual.githubcopilot.com', path: '/models' },
      { host: 'api.githubcopilot.com', path: '/models' }
    ];

    for (const endpoint of candidates) {
      try {
        const payload = await requestJson(endpoint.host, endpoint.path, headers, 8000);
        const rows = Array.isArray(payload?.data)
          ? payload.data
          : Array.isArray(payload?.models)
            ? payload.models
            : [];

        if (!rows.length) continue;

        for (const row of rows) {
          if (!row) continue;
          const id = String(row.id || row.model || '').trim();
          if (!id) continue;
          const capabilities = Array.isArray(row.capabilities)
            ? row.capabilities.map((capability) => String(capability).toLowerCase())
            : [];
          upsertDynamicCopilotModel({
            id,
            name: row.display_name || row.name || id,
            vision: capabilities.includes('vision') ? true : inferVisionCapability(id),
            chat: capabilities.includes('chat') || capabilities.length === 0,
            tools: capabilities.includes('tools') || capabilities.includes('tool-calling') || capabilities.includes('function-calling'),
            reasoning: capabilities.includes('reasoning') || inferReasoningCapability(id),
            completion: capabilities.includes('completion') || inferCompletionCapability(id),
            automation: capabilities.includes('automation'),
            planning: capabilities.includes('planning') || inferReasoningCapability(id),
            type: row.capabilities?.type || null,
            modelPickerEnabled: row.model_picker_enabled !== false,
            chatCompletionsSupported: Array.isArray(row.supported_endpoints)
              ? row.supported_endpoints.some((endpoint) => String(endpoint).includes('chat/completions'))
              : true
          });
        }
      } catch {
      }
    }

    return getCopilotModels();
  }

  function getModelMetadata(sessionTokenPresent = false) {
    return {
      ...currentModelMetadata,
      requestedModel: runtimeSelection.requestedModel,
      runtimeModel: runtimeSelection.runtimeModel,
      runtimeEndpointHost: runtimeSelection.endpointHost,
      sessionToken: sessionTokenPresent ? 'present' : 'absent'
    };
  }

  function getRuntimeSelection() {
    return {
      ...runtimeSelection,
      validatedFallbacks: { ...runtimeSelection.validatedFallbacks }
    };
  }

  function rememberValidatedChatFallback(requestedModel, runtimeModel) {
    const requestedKey = canonicalizeModelKey(requestedModel);
    const runtimeKey = canonicalizeModelKey(runtimeModel);
    if (!requestedKey || !runtimeKey) return;
    runtimeSelection.validatedFallbacks = {
      ...runtimeSelection.validatedFallbacks,
      [requestedKey]: runtimeKey
    };
    saveRuntimeState();
  }

  function getValidatedChatFallback(requestedModel) {
    const requestedKey = canonicalizeModelKey(requestedModel);
    if (!requestedKey) return null;
    return runtimeSelection.validatedFallbacks[requestedKey] || null;
  }

  function recordRuntimeSelection({ requestedModel, runtimeModel, endpointHost, actualModelId }) {
    runtimeSelection = {
      ...runtimeSelection,
      requestedModel: requestedModel ? canonicalizeModelKey(requestedModel) : runtimeSelection.requestedModel,
      runtimeModel: runtimeModel ? canonicalizeModelKey(runtimeModel) : null,
      endpointHost: endpointHost ? String(endpointHost).trim() : null,
      actualModelId: actualModelId ? String(actualModelId).trim() : null,
      lastValidated: new Date().toISOString()
    };
    saveRuntimeState();
  }

  function getCurrentCopilotModel() {
    return currentCopilotModel;
  }

  return {
    COPILOT_MODELS,
    discoverCopilotModels,
    getCopilotModels,
    getCurrentCopilotModel,
    getModelMetadata,
    getRuntimeSelection,
    getValidatedChatFallback,
    loadModelPreference,
    modelRegistry,
    recordRuntimeSelection,
    rememberValidatedChatFallback,
    resolveCopilotModelKey,
    setCopilotModel,
    setProvider
  };
}

module.exports = {
  COPILOT_MODELS,
  createCopilotModelRegistry
};
