const fs = require('fs');
const https = require('https');

const COPILOT_MODELS = {
  'gpt-5.4': { name: 'GPT-5.4', id: 'gpt-5.4', vision: false },
  'claude-sonnet-4.5': { name: 'Claude Sonnet 4.5', id: 'claude-sonnet-4.5-20250929', vision: true },
  'claude-sonnet-4': { name: 'Claude Sonnet 4', id: 'claude-sonnet-4-20250514', vision: true },
  'claude-opus-4.5': { name: 'Claude Opus 4.5', id: 'claude-opus-4.5', vision: true },
  'claude-haiku-4.5': { name: 'Claude Haiku 4.5', id: 'claude-haiku-4.5', vision: true },
  'gpt-4o': { name: 'GPT-4o', id: 'gpt-4o', vision: true },
  'gpt-4o-mini': { name: 'GPT-4o Mini', id: 'gpt-4o-mini', vision: true },
  'gpt-4.1': { name: 'GPT-4.1', id: 'gpt-4.1', vision: true },
  'o1': { name: 'o1', id: 'o1', vision: false },
  'o1-mini': { name: 'o1 Mini', id: 'o1-mini', vision: false },
  'o3-mini': { name: 'o3 Mini', id: 'o3-mini', vision: false }
};

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

function createCopilotModelRegistry({ likuHome, modelPrefFile, initialProvider = 'copilot' }) {
  const dynamicCopilotModels = {};
  let copilotModelDiscoveryAttempted = false;
  let currentCopilotModel = 'gpt-4o';
  let currentProvider = initialProvider;
  let currentModelMetadata = {
    modelId: currentCopilotModel,
    provider: currentProvider,
    modelVersion: COPILOT_MODELS[currentCopilotModel]?.id || null,
    capabilities: COPILOT_MODELS[currentCopilotModel]?.vision ? ['vision', 'text'] : ['text'],
    lastUpdated: new Date().toISOString()
  };

  function modelRegistry() {
    return { ...COPILOT_MODELS, ...dynamicCopilotModels };
  }

  function inferVisionCapability(modelId = '') {
    const id = String(modelId || '').toLowerCase();
    if (!id) return false;
    if (/\bo1\b|\bo3-mini\b|\bo1-mini\b/.test(id)) return false;
    if (id.includes('vision')) return true;
    if (id.includes('gpt-4') || id.includes('claude')) return true;
    return false;
  }

  function normalizeModelKeyFromId(modelId) {
    const raw = String(modelId || '').trim().toLowerCase();
    if (!raw) return '';
    return raw.replace(/-20\d{6}$/g, '');
  }

  function refreshCurrentModelMetadata() {
    const selected = modelRegistry()[currentCopilotModel];
    currentModelMetadata = {
      modelId: currentCopilotModel,
      provider: currentProvider,
      modelVersion: selected?.id || null,
      capabilities: selected?.vision ? ['vision', 'text'] : ['text'],
      lastUpdated: new Date().toISOString()
    };
  }

  function upsertDynamicCopilotModel(entry) {
    if (!entry || !entry.id) return;
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
    dynamicCopilotModels[key] = {
      name: entry.name || entry.id,
      id: entry.id,
      vision: entry.vision ?? inferVisionCapability(entry.id)
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

  function loadModelPreference() {
    try {
      if (!fs.existsSync(modelPrefFile)) {
        return;
      }
      const parsed = JSON.parse(fs.readFileSync(modelPrefFile, 'utf-8'));
      const preferred = String(parsed?.copilotModel || '').trim().toLowerCase();
      if (!preferred) return;

      const registry = modelRegistry();
      if (registry[preferred]) {
        currentCopilotModel = preferred;
        refreshCurrentModelMetadata();
        return;
      }

      upsertDynamicCopilotModel({ id: preferred, name: preferred, vision: inferVisionCapability(preferred) });
      if (modelRegistry()[preferred]) {
        currentCopilotModel = preferred;
        refreshCurrentModelMetadata();
      }
    } catch (error) {
      console.warn('[AI] Could not load model preference:', error.message);
    }
  }

  function setProvider(provider) {
    currentProvider = provider;
    currentModelMetadata.provider = provider;
    currentModelMetadata.lastUpdated = new Date().toISOString();
  }

  function setCopilotModel(model) {
    const registry = modelRegistry();
    if (registry[model]) {
      currentCopilotModel = model;
      refreshCurrentModelMetadata();
      saveModelPreference();
      return true;
    }
    return false;
  }

  function resolveCopilotModelKey(requestedModel) {
    const registry = modelRegistry();
    if (requestedModel && registry[requestedModel]) {
      return requestedModel;
    }
    return currentCopilotModel;
  }

  function getCopilotModels() {
    return Object.entries(modelRegistry()).map(([key, value]) => ({
      id: key,
      name: value.name,
      vision: value.vision,
      current: key === currentCopilotModel
    }));
  }

  async function discoverCopilotModels({ force = false, loadCopilotTokenIfNeeded, exchangeForCopilotSession, getCopilotSessionToken }) {
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

    const candidates = [
      { host: 'api.githubcopilot.com', path: '/models' },
      { host: 'copilot-proxy.githubusercontent.com', path: '/v1/models' }
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
          const capabilities = Array.isArray(row.capabilities) ? row.capabilities.map((capability) => String(capability).toLowerCase()) : [];
          upsertDynamicCopilotModel({
            id,
            name: row.display_name || row.name || id,
            vision: capabilities.includes('vision') ? true : inferVisionCapability(id)
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
      sessionToken: sessionTokenPresent ? 'present' : 'absent'
    };
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
    loadModelPreference,
    modelRegistry,
    resolveCopilotModelKey,
    setCopilotModel,
    setProvider
  };
}

module.exports = {
  COPILOT_MODELS,
  createCopilotModelRegistry
};
