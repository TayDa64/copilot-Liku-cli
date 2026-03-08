/**
 * AI Service Module
 * Handles integration with AI backends (GitHub Copilot, OpenAI, Claude, local models)
 * Supports visual context for AI awareness of screen content
 * Supports AGENTIC actions (mouse, keyboard, system control)
 * Supports inspect mode for precision targeting
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
// `ai-service` is used by the Electron app *and* by the CLI.
// When running in CLI-only mode, Electron may not be available.
let shell;
try {
  ({ shell } = require('electron'));
} catch {
  shell = {
    openExternal: async (url) => {
      console.log('[AI] Open this URL in your browser:', url);
      return true;
    }
  };
}

const systemAutomation = require('./system-automation');
const preferences = require('./preferences');
const { parseActions, hasActions } = require('./ai-service/actions/parse');
const {
  createCopilotModelRegistry
} = require('./ai-service/providers/copilot/model-registry');
const {
  createProviderRegistry
} = require('./ai-service/providers/registry');
const { createProviderOrchestrator } = require('./ai-service/providers/orchestration');
const {
  checkActionPolicies,
  checkNegativePolicies,
  formatActionPolicyViolationSystemMessage,
  formatNegativePolicyViolationSystemMessage
} = require('./ai-service/policy-enforcement');
const { LIKU_TOOLS, toolCallsToActions } = require('./ai-service/providers/copilot/tools');
const {
  createConversationHistoryStore
} = require('./ai-service/conversation-history');
const {
  createPreferenceParser
} = require('./ai-service/preference-parser');
const {
  createSlashCommandHelpers
} = require('./ai-service/slash-command-helpers');
const { createCommandHandler } = require('./ai-service/commands');
const {
  getBrowserSessionState,
  resetBrowserSessionState,
  updateBrowserSessionState
} = require('./ai-service/browser-session-state');
const {
  clearSemanticDOMSnapshot,
  getSemanticDOMContextText,
  getUIWatcher,
  setSemanticDOMSnapshot,
  setUIWatcher
} = require('./ai-service/ui-context');
const {
  createVisualContextStore
} = require('./ai-service/visual-context');
const { createMessageBuilder } = require('./ai-service/message-builder');
const { SYSTEM_PROMPT } = require('./ai-service/system-prompt');

// ===== ENVIRONMENT DETECTION =====
const PLATFORM = process.platform; // 'win32', 'darwin', 'linux'
const OS_NAME = PLATFORM === 'win32' ? 'Windows' : PLATFORM === 'darwin' ? 'macOS' : 'Linux';
const OS_VERSION = os.release();
const ARCHITECTURE = process.arch;

// Lazy-load inspect service to avoid circular dependencies
let inspectService = null;
function getInspectService() {
  if (!inspectService) {
    inspectService = require('./inspect-service');
  }
  return inspectService;
}

// ===== CONFIGURATION =====

// GitHub Copilot OAuth Configuration
const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';

// Current configuration
const providerRegistry = createProviderRegistry(process.env);
const {
  AI_PROVIDERS,
  apiKeys,
  getCurrentProvider,
  setApiKey: setProviderApiKey,
  setProvider: setActiveProvider
} = providerRegistry;

// Token persistence path — lives inside ~/.liku-cli/ alongside Electron userData
const LIKU_HOME = path.join(os.homedir(), '.liku-cli');
const TOKEN_FILE = path.join(LIKU_HOME, 'copilot-token.json');

// OAuth state
let oauthInProgress = false;
let oauthCallback = null;

// Conversation history for context
const MAX_HISTORY = 20;
const HISTORY_FILE = path.join(LIKU_HOME, 'conversation-history.json');
const MODEL_PREF_FILE = path.join(LIKU_HOME, 'model-preference.json');

const copilotModelRegistry = createCopilotModelRegistry({
  likuHome: LIKU_HOME,
  modelPrefFile: MODEL_PREF_FILE,
  initialProvider: getCurrentProvider()
});
const {
  COPILOT_MODELS,
  discoverCopilotModels: discoverCopilotModelsFromRegistry,
  getCopilotModels: getCopilotModelsFromRegistry,
  getCurrentCopilotModel: getCurrentCopilotModelFromRegistry,
  loadModelPreference,
  modelRegistry,
  resolveCopilotModelKey: resolveCopilotModelKeyFromRegistry,
  setCopilotModel: setCopilotModelInRegistry,
  setProvider: syncProviderModelMetadata
} = copilotModelRegistry;

const historyStore = createConversationHistoryStore({
  historyFile: HISTORY_FILE,
  likuHome: LIKU_HOME,
  maxHistory: MAX_HISTORY
});
const preferenceParser = createPreferenceParser({
  apiKeys,
  callAnthropic,
  callCopilot,
  callOllama,
  callOpenAI,
  getCurrentProvider,
  loadCopilotToken
});
const slashCommandHelpers = createSlashCommandHelpers({ modelRegistry });

// Restore history on module load
historyStore.loadConversationHistory();
loadModelPreference();

// Visual context for AI awareness
const visualContextStore = createVisualContextStore({ maxVisualContext: 5 });

// ===== SYSTEM PROMPT =====
// Source-based regression markers intentionally remain in this facade:
// LIVE UI AWARENESS
// TRUST THIS DATA
// 🔴 **LIVE UI STATE**
// auto-refreshed every 400ms
// run_command
// PREFERRED FOR SHELL TASKS
// powershell|cmd|bash

/**
 * Set the AI provider
 */
function setProvider(provider) {
  if (setActiveProvider(provider)) {
    syncProviderModelMetadata(getCurrentProvider());
    return true;
  }
  return false;
}

/**
 * Set API key for a provider
 */
function setApiKey(provider, key) {
  return setProviderApiKey(provider, key);
}

/**
 * Set the Copilot model
 */
function setCopilotModel(model) {
  return setCopilotModelInRegistry(model);
}

/**
 * Resolve a requested Copilot model key to a valid configured key.
 */
function resolveCopilotModelKey(requestedModel) {
  return resolveCopilotModelKeyFromRegistry(requestedModel);
}

/**
 * Get available Copilot models
 */
function getCopilotModels() {
  return getCopilotModelsFromRegistry();
}

function loadCopilotTokenIfNeeded() {
  if (apiKeys.copilot) return true;
  return loadCopilotToken();
}

async function discoverCopilotModels(force = false) {
  return discoverCopilotModelsFromRegistry({
    force,
    loadCopilotTokenIfNeeded,
    exchangeForCopilotSession,
    getCopilotSessionToken: () => apiKeys.copilotSession
  });
}

/**
 * Get current model metadata
 */
function getModelMetadata() {
  return copilotModelRegistry.getModelMetadata(!!apiKeys.copilotSession);
}

/**
 * Get current Copilot model
 */
function getCurrentCopilotModel() {
  return getCurrentCopilotModelFromRegistry();
}

/**
 * Add visual context (screenshot data) as a typed VisualFrame
 * @param {Object} imageData - Raw image data with dataURL, width, height, etc.
 */
function addVisualContext(imageData) {
  return visualContextStore.addVisualContext(imageData);
}

/**
 * Get the latest visual context
 */
function getLatestVisualContext() {
  return visualContextStore.getLatestVisualContext();
}

/**
 * Clear visual context
 */
function clearVisualContext() {
  visualContextStore.clearVisualContext();
}

const messageBuilder = createMessageBuilder({
  getBrowserSessionState,
  getCurrentProvider,
  getForegroundWindowInfo: async () => {
    if (typeof systemAutomation.getForegroundWindowInfo === 'function') {
      return systemAutomation.getForegroundWindowInfo();
    }
    return null;
  },
  getInspectService,
  getLatestVisualContext: () => visualContextStore.getLatestVisualContext(),
  getPreferencesSystemContext: () => preferences.getPreferencesSystemContext(),
  getPreferencesSystemContextForApp: (processName) => preferences.getPreferencesSystemContextForApp(processName),
  getRecentConversationHistory: (limit) => historyStore.getRecentConversationHistory(limit),
  getSemanticDOMContextText,
  getUIWatcher,
  maxHistory: MAX_HISTORY,
  systemPrompt: SYSTEM_PROMPT
});

const commandHandler = createCommandHandler({
  aiProviders: AI_PROVIDERS,
  captureVisualContext: () => {
    try {
      const { screenshot } = require('./ui-automation/screenshot');
      return screenshot({ memory: true, base64: true, metric: 'sha256' })
        .then((result) => {
          if (!result || !result.success || !result.base64) {
            return { type: 'error', message: 'Capture failed.' };
          }
          addVisualContext({
            dataURL: `data:image/png;base64,${result.base64}`,
            width: 0,
            height: 0,
            scope: 'screen',
            timestamp: Date.now()
          });
          return { type: 'system', message: `Captured visual context (buffer: ${visualContextStore.getVisualContextCount()})` };
        })
        .catch((err) => ({ type: 'error', message: `Capture failed: ${err.message}` }));
    } catch (error) {
      return { type: 'error', message: `Capture failed: ${error.message}` };
    }
  },
  clearVisualContext,
  exchangeForCopilotSession,
  getCurrentCopilotModel,
  getCurrentProvider,
  getStatus,
  getVisualContextCount: () => visualContextStore.getVisualContextCount(),
  historyStore,
  isOAuthInProgress: () => oauthInProgress,
  loadCopilotTokenIfNeeded,
  logoutCopilot: () => {
    apiKeys.copilot = '';
    apiKeys.copilotSession = '';
    try {
      if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
    } catch (error) {}
  },
  modelRegistry,
  resetBrowserSessionState,
  setApiKey,
  setCopilotModel,
  setProvider,
  slashCommandHelpers,
  startCopilotOAuth
});
/**
 * Build messages array for API call
 */
async function buildMessages(userMessage, includeVisual = false, options = {}) {
  return messageBuilder.buildMessages(userMessage, includeVisual, options);
}

// ===== GITHUB COPILOT OAUTH =====

/**
 * Load saved Copilot token from disk.
 * On first run after the path migration, copies the token from the
 * legacy location (%APPDATA%/copilot-agent/) to ~/.liku-cli/.
 */
function loadCopilotToken() {
  try {
    // Migrate from legacy path if new location is empty
    if (!fs.existsSync(TOKEN_FILE)) {
      const legacyPath = path.join(
        process.env.APPDATA || process.env.HOME || '.',
        'copilot-agent', 'copilot-token.json'
      );
      if (fs.existsSync(legacyPath)) {
        const dir = path.dirname(TOKEN_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(legacyPath, TOKEN_FILE);
        console.log('[COPILOT] Migrated token from legacy path');
      }
    }

    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      if (data.access_token) {
        apiKeys.copilot = data.access_token;
        console.log('[COPILOT] Loaded saved token');
        return true;
      }
    }
  } catch (e) {
    console.error('[COPILOT] Failed to load token:', e.message);
  }
  return false;
}

/**
 * Save Copilot token to disk
 */
function saveCopilotToken(token) {
  try {
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ 
      access_token: token, 
      saved_at: new Date().toISOString() 
    }), { mode: 0o600 });
    console.log('[COPILOT] Token saved');
  } catch (e) {
    console.error('[COPILOT] Failed to save token:', e.message);
  }
}

/**
 * Start GitHub Copilot OAuth device code flow
 * Returns { user_code, verification_uri } for user to complete auth
 */
function startCopilotOAuth() {
  return new Promise((resolve, reject) => {
    if (oauthInProgress) {
      return reject(new Error('OAuth already in progress'));
    }
    
    const data = JSON.stringify({
      client_id: COPILOT_CLIENT_ID,
      scope: 'copilot'
    });

    const req = https.request({
      hostname: 'github.com',
      path: '/login/device/code',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (result.device_code && result.user_code) {
            console.log('[COPILOT] OAuth started. User code:', result.user_code);
            oauthInProgress = true;
            
            // Open browser for user to authorize
            shell.openExternal(result.verification_uri_complete || result.verification_uri);
            
            // Start polling for token
            pollForToken(result.device_code, result.interval || 5);
            
            resolve({
              user_code: result.user_code,
              verification_uri: result.verification_uri,
              expires_in: result.expires_in
            });
          } else {
            reject(new Error(result.error_description || 'Failed to get device code'));
          }
        } catch (error) {
          reject(new Error(`Failed to parse device code response: ${error.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function pollForToken(deviceCode, intervalSeconds = 5) {
  const pollAfter = (seconds) => {
    setTimeout(() => pollForToken(deviceCode, seconds), Math.max(1, Number(seconds) || 1) * 1000);
  };

  const data = JSON.stringify({
    client_id: COPILOT_CLIENT_ID,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
  });

  const req = https.request({
    hostname: 'github.com',
    path: '/login/oauth/access_token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }
  }, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      try {
        const result = JSON.parse(body || '{}');
        if (result.access_token) {
          apiKeys.copilot = result.access_token;
          oauthInProgress = false;
          saveCopilotToken(result.access_token);
          if (typeof oauthCallback === 'function') {
            oauthCallback({ success: true, access_token: result.access_token });
          }
          return;
        }

        switch (result.error) {
          case 'authorization_pending':
            pollAfter(intervalSeconds);
            return;
          case 'slow_down':
            pollAfter(intervalSeconds + 5);
            return;
          case 'expired_token':
          case 'access_denied':
            oauthInProgress = false;
            if (typeof oauthCallback === 'function') {
              oauthCallback({
                success: false,
                message: result.error_description || 'Authorization expired. Try /login again.'
              });
            }
            return;
          default:
            pollAfter(intervalSeconds);
        }
      } catch (error) {
        oauthInProgress = false;
        if (typeof oauthCallback === 'function') {
          oauthCallback({ success: false, message: `OAuth polling failed: ${error.message}` });
        }
      }
    });
  });

  req.on('error', () => {
    pollAfter(intervalSeconds);
  });
  req.write(data);
  req.end();
}

async function exchangeForCopilotSession() {
  if (!apiKeys.copilot) {
    throw new Error('Not authenticated. Use /login to authenticate with GitHub Copilot.');
  }

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.githubcopilot.com',
      path: '/copilot_internal/v2/token',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKeys.copilot}`,
        'Accept': 'application/json',
        'User-Agent': 'GithubCopilot/1.0.0',
        'Editor-Version': 'vscode/1.96.0',
        'Editor-Plugin-Version': 'copilot-chat/0.22.0'
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode >= 400) {
            return reject(new Error(`Session exchange failed (${res.statusCode})`));
          }
          const result = JSON.parse(body || '{}');
          const token = result.token || result.access_token;
          if (!token) {
            return reject(new Error('Copilot session token missing from response'));
          }
          apiKeys.copilotSession = token;
          resolve(token);
        } catch (error) {
          reject(new Error(`Failed to parse Copilot session response: ${error.message}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

async function callCopilot(messages, modelOverride = null, requestOptions = {}) {
  if (!apiKeys.copilot) {
    throw new Error('Not authenticated. Use /login to authenticate with GitHub Copilot.');
  }

  if (!apiKeys.copilotSession) {
    await exchangeForCopilotSession();
  }

  const hasVision = messages.some((message) => Array.isArray(message.content));

  return new Promise((resolve, reject) => {
    const modelKey = resolveCopilotModelKey(modelOverride);
    const registry = modelRegistry();
    const modelInfo = registry[modelKey] || registry['gpt-4o'];
    const requestedModelId = hasVision && !modelInfo.vision ? 'gpt-4o' : modelInfo.id;
    const fallbackModelId = 'gpt-4o';
    let modelId = requestedModelId;

    console.log(`[Copilot] Vision request: ${hasVision}, Model: ${modelId} (key=${modelKey})`);

    const enableTools = requestOptions?.enableTools !== false;

    const makeRequestBody = (selectedModelId) => {
      const payload = {
        model: selectedModelId,
        messages: messages,
        max_tokens: Number.isFinite(Number(requestOptions?.max_tokens)) ? Number(requestOptions.max_tokens) : 4096,
        temperature: typeof requestOptions?.temperature === 'number' ? requestOptions.temperature : 0.7,
        stream: false
      };

      if (requestOptions?.response_format) {
        payload.response_format = requestOptions.response_format;
      }

      if (enableTools) {
        payload.tools = LIKU_TOOLS;
        payload.tool_choice = requestOptions?.tool_choice || 'auto';
      } else {
        payload.tool_choice = 'none';
      }

      return JSON.stringify(payload);
    };

    const tryEndpoint = (hostname, pathPrefix = '', selectedModelId = modelId) => {
      const data = makeRequestBody(selectedModelId);
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKeys.copilotSession}`,
        'Accept': 'application/json',
        'User-Agent': 'GithubCopilot/1.0.0',
        'Editor-Version': 'vscode/1.96.0',
        'Editor-Plugin-Version': 'copilot-chat/0.22.0',
        'Copilot-Integration-Id': 'vscode-chat',
        'X-Request-Id': `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
        'Openai-Organization': 'github-copilot',
        'Openai-Intent': 'conversation-panel',
        'Content-Length': Buffer.byteLength(data)
      };

      if (hasVision) {
        headers['Copilot-Vision-Request'] = 'true';
        console.log('[Copilot] Added Copilot-Vision-Request header');
      }

      const options = {
        hostname: hostname,
        path: pathPrefix + '/chat/completions',
        method: 'POST',
        headers: headers
      };

      console.log(`[Copilot] Calling ${hostname}${options.path} with model ${selectedModelId}...`);

      return new Promise((resolveReq, rejectReq) => {
        const req = https.request(options, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            console.log('[Copilot] API response status:', res.statusCode);
            
            if (res.statusCode === 401) {
              // Session token expired, clear it
              apiKeys.copilotSession = '';
              return rejectReq(new Error('SESSION_EXPIRED'));
            }
            
            if (res.statusCode === 403) {
              return rejectReq(new Error('ACCESS_DENIED'));
            }
            
            if (res.statusCode >= 400) {
              console.error('[Copilot] Error response:', body.substring(0, 300));
              return rejectReq(new Error(`API_ERROR_${res.statusCode}: ${body.substring(0, 200)}`));
            }

            try {
              const result = JSON.parse(body);
              if (result.choices && result.choices[0]) {
                const choice = result.choices[0];
                const msg = choice.message;
                
                // Handle native tool calls — convert to action JSON block
                if (msg.tool_calls && msg.tool_calls.length > 0) {
                  const actions = toolCallsToActions(msg.tool_calls);
                  const actionBlock = JSON.stringify({
                    thought: msg.content || 'Executing requested actions',
                    actions,
                    verification: 'Verify the actions completed successfully'
                  }, null, 2);
                  console.log(`[Copilot] Received ${msg.tool_calls.length} tool_calls, converted to action block`);
                  resolveReq('```json\n' + actionBlock + '\n```');
                } else {
                  resolveReq(msg.content);
                }
              } else if (result.error) {
                rejectReq(new Error(result.error.message || 'Copilot API error'));
              } else {
                console.error('[Copilot] Unexpected response:', JSON.stringify(result).substring(0, 300));
                rejectReq(new Error('Invalid response format'));
              }
            } catch (e) {
              console.error('[Copilot] Parse error. Body:', body.substring(0, 300));
              rejectReq(new Error(`PARSE_ERROR: ${body.substring(0, 100)}`));
            }
          });
        });

        req.on('error', (e) => {
          console.error('[Copilot] Request error:', e.message);
          rejectReq(e);
        });
        
        req.write(data);
        req.end();
      });
    };

    // Try primary endpoint first
    tryEndpoint('api.githubcopilot.com', '', modelId)
      .then(resolve)
      .catch(async (err) => {
        console.log('[Copilot] Primary endpoint failed:', err.message);

        // Some models are visible in account model lists but not available on /chat/completions.
        // Retry once with a known-good chat model to preserve continuity.
        const unsupportedModel = /unsupported_api_for_model|not accessible via the \/chat\/completions endpoint/i.test(err.message || '');
        if (unsupportedModel && modelId !== fallbackModelId) {
          try {
            console.log(`[Copilot] Model ${modelId} unsupported on chat endpoint; retrying with fallback ${fallbackModelId}...`);
            modelId = fallbackModelId;
            const result = await tryEndpoint('api.githubcopilot.com', '', modelId);
            return resolve(result);
          } catch (fallbackErr) {
            err = fallbackErr;
          }
        }
        
        // If session expired, re-exchange and retry once
        if (err.message === 'SESSION_EXPIRED') {
          try {
            await exchangeForCopilotSession();
            const result = await tryEndpoint('api.githubcopilot.com');
            return resolve(result);
          } catch (retryErr) {
            return reject(new Error('Session expired. Please try /login again.'));
          }
        }
        
        // Try alternate endpoint
        try {
          console.log('[Copilot] Trying alternate endpoint...');
          const result = await tryEndpoint('copilot-proxy.githubusercontent.com', '/v1', modelId);
          resolve(result);
        } catch (altErr) {
          console.log('[Copilot] Alternate endpoint also failed:', altErr.message);
          
          // Return user-friendly error messages
          if (err.message.includes('ACCESS_DENIED')) {
            reject(new Error('Access denied. Ensure you have an active GitHub Copilot subscription.'));
          } else if (err.message.includes('PARSE_ERROR')) {
            reject(new Error('API returned invalid response. You may need to re-authenticate with /login'));
          } else {
            reject(new Error(`Copilot API error: ${err.message}`));
          }
        }
      });
  });
}

/**
 * Call OpenAI API
 */
function callOpenAI(messages) {
  return new Promise((resolve, reject) => {
    const config = AI_PROVIDERS.openai;
    const hasVision = messages.some(m => Array.isArray(m.content));
    
    const data = JSON.stringify({
      model: hasVision ? config.visionModel : config.model,
      messages: messages,
      max_tokens: 2048,
      temperature: 0.7
    });

    const options = {
      hostname: config.baseUrl,
      path: config.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKeys.openai}`,
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(body);
          if (response.error) {
            reject(new Error(response.error.message));
          } else {
            resolve(response.choices[0].message.content);
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Call Anthropic API
 */
function callAnthropic(messages) {
  return new Promise((resolve, reject) => {
    const config = AI_PROVIDERS.anthropic;
    
    // Convert messages format for Anthropic
    const systemMsg = messages.find(m => m.role === 'system');
    const otherMessages = messages.filter(m => m.role !== 'system');
    
    const data = JSON.stringify({
      model: config.model,
      max_tokens: 2048,
      system: systemMsg ? systemMsg.content : '',
      messages: otherMessages
    });

    const options = {
      hostname: config.baseUrl,
      path: config.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKeys.anthropic,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(body);
          if (response.error) {
            reject(new Error(response.error.message));
          } else {
            const textContent = response.content.find(c => c.type === 'text');
            resolve(textContent ? textContent.text : '');
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Call Ollama API (local)
 */
function callOllama(messages) {
  return new Promise((resolve, reject) => {
    const config = AI_PROVIDERS.ollama;
    
    // Check for images in the last message
    const lastMsg = messages[messages.length - 1];
    const hasImages = lastMsg.images && lastMsg.images.length > 0;
    
    const data = JSON.stringify({
      model: hasImages ? config.visionModel : config.model,
      messages: messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : 
          Array.isArray(m.content) ? m.content.map(c => c.text || '').join('\n') : '',
        images: m.images || undefined
      })),
      stream: false
    });

    const options = {
      hostname: config.baseUrl,
      port: config.port,
      path: config.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(body);
          if (response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response.message?.content || '');
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', (err) => {
      // Provide helpful error for Ollama
      if (err.code === 'ECONNREFUSED') {
        reject(new Error('Ollama not running. Start it with: ollama serve\nOr set a different provider with /provider openai or /provider anthropic'));
      } else {
        reject(err);
      }
    });
    
    req.write(data);
    req.end();
  });
}

/**
 * Detect if AI response was truncated mid-stream
 * Uses heuristics to identify incomplete responses
 */
function detectTruncation(response) {
  if (!response || response.length < 100) return false;
  
  const truncationSignals = [
    // Ends mid-JSON block
    /```json\s*\{[^}]*$/s.test(response),
    // Ends with unclosed code block
    (response.match(/```/g) || []).length % 2 !== 0,
    // Ends mid-sentence (lowercase letter or comma, no terminal punctuation)
    /[a-z,]\s*$/i.test(response) && !/[.!?:]\s*$/i.test(response),
    // Ends with numbered list item starting
    /\d+\.\s*$/m.test(response),
    // Ends with "- " suggesting incomplete list item
    /-\s*$/m.test(response),
    // Has unclosed parentheses/brackets
    (response.match(/\(/g) || []).length > (response.match(/\)/g) || []).length,
    (response.match(/\[/g) || []).length > (response.match(/\]/g) || []).length
  ];
  
  return truncationSignals.some(Boolean);
}

function looksLikeAutomationRequest(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();

  // Very lightweight heuristic: these are the common verbs we expect to map into actions.
  const verbSignals = [
    'click', 'double click', 'right click', 'type', 'press', 'scroll', 'drag',
    'open', 'close', 'select', 'focus', 'bring to front', 'minimize', 'restore',
    'play', 'choose', 'pick',
    'find', 'search for', 'screenshot', 'capture'
  ];

  if (verbSignals.some(v => t.includes(v))) return true;

  // Coordinate-style requests
  if (/\(\s*\d+\s*,\s*\d+\s*\)/.test(t) || /\b\d+\s*,\s*\d+\b/.test(t)) return true;

  return false;
}

/**
 * Send a message and get AI response with auto-continuation
 */
// Provider fallback priority order
const PROVIDER_FALLBACK_ORDER = ['copilot', 'openai', 'anthropic', 'ollama'];

const providerOrchestrator = createProviderOrchestrator({
  aiProviders: AI_PROVIDERS,
  apiKeys,
  callAnthropic,
  callCopilot,
  callOllama,
  callOpenAI,
  getCurrentCopilotModel,
  getCurrentProvider,
  loadCopilotToken,
  modelRegistry,
  providerFallbackOrder: PROVIDER_FALLBACK_ORDER,
  resolveCopilotModelKey
});

async function sendMessage(userMessage, options = {}) {
  const {
    includeVisualContext = false,
    coordinates = null,
    maxContinuations = 2,
    model = null,
    enforceActions = true,
    extraSystemMessages = []
  } = options;

  // Enhance message with coordinate context if provided
  let enhancedMessage = userMessage;
  if (coordinates) {
    enhancedMessage = `[User selected coordinates: (${coordinates.x}, ${coordinates.y}) with label "${coordinates.label}"]\n\n${userMessage}`;
  }

  const baseExtraSystemMessages = Array.isArray(extraSystemMessages) ? extraSystemMessages : [];

  // Build messages with optional visual context
  const messages = await buildMessages(enhancedMessage, includeVisualContext, {
    extraSystemMessages: baseExtraSystemMessages
  });

  try {
    const providerResult = await providerOrchestrator.requestWithFallback(messages, model, includeVisualContext);
    let response = providerResult.response;
    let effectiveModel = providerResult.effectiveModel;
    let usedProvider = providerResult.usedProvider;

    // Auto-continuation for truncated responses
    let fullResponse = response;
    let continuationCount = 0;
    
    while (detectTruncation(fullResponse) && continuationCount < maxContinuations) {
      continuationCount++;
      console.log(`[AI] Response appears truncated, continuing (${continuationCount}/${maxContinuations})...`);
      
      // Add partial response to history temporarily
      historyStore.pushConversationEntry({ role: 'assistant', content: fullResponse });
      
      // Build continuation request
      const continueMessages = await buildMessages('Continue from where you left off. Do not repeat what you already said.', false);
      
      try {
        const continuation = await providerOrchestrator.callCurrentProvider(continueMessages, effectiveModel);
        
        // Append continuation
        fullResponse += '\n' + continuation;
        
        // Update history with combined response
        historyStore.popConversationEntry(); // Remove partial
      } catch (contErr) {
        console.warn('[AI] Continuation failed:', contErr.message);
        break;
      }
    }
    
    response = fullResponse;

    // If the user likely wanted automation, but the model returned only intent text,
    // re-prompt once to emit a JSON action block.
    if (
      enforceActions &&
      usedProvider === 'copilot' &&
      looksLikeAutomationRequest(enhancedMessage) &&
      !hasActions(response)
    ) {
      console.log('[AI] No actions detected for an automation-like request; retrying once with stricter formatting...');
      const enforcementPrompt =
        'You must respond ONLY with a JSON code block (```json ... ```).\n' +
        'Return an object with keys: thought, actions, verification.\n' +
        'If you truly cannot take actions, return {"thought":"...","actions":[],"verification":"..."}.\n\n' +
        `User request:\n${enhancedMessage}`;
      try {
        const forcedMessages = await buildMessages(enforcementPrompt, includeVisualContext, {
          extraSystemMessages: baseExtraSystemMessages
        });
        const forced = await providerOrchestrator.callProvider('copilot', forcedMessages, effectiveModel);
        if (forced && hasActions(forced)) {
          response = forced;
        }
      } catch (e) {
        console.warn('[AI] Action enforcement retry failed:', e.message);
      }
    }

    // ===== POLICY ENFORCEMENT ("Brakes before gas" + "Rails") =====
    // If the model emitted actions, validate them against the active app's negativePolicies
    // and actionPolicies.
    // If violated, silently regenerate (bounded attempts) BEFORE returning to CLI/Electron.
    try {
      const parsed = parseActions(response);
      if (parsed && Array.isArray(parsed.actions) && parsed.actions.length > 0) {
        let fg = null;
        try {
          if (typeof systemAutomation.getForegroundWindowInfo === 'function') {
            fg = await systemAutomation.getForegroundWindowInfo();
          }
        } catch {}

        const fgProcess = fg && fg.success ? (fg.processName || '') : '';
        const appPolicy = fgProcess ? preferences.getAppPolicy(fgProcess) : null;
        const negativePolicies = Array.isArray(appPolicy?.negativePolicies) ? appPolicy.negativePolicies : [];
        const actionPolicies = Array.isArray(appPolicy?.actionPolicies) ? appPolicy.actionPolicies : [];

        if (negativePolicies.length || actionPolicies.length) {
          const maxPolicyRetries = 2;
          let attempt = 0;
          let currentResponse = response;
          let currentParsed = parsed;

          while (attempt <= maxPolicyRetries) {
            const negCheck = checkNegativePolicies(currentParsed, negativePolicies);
            const actCheck = checkActionPolicies(currentParsed, actionPolicies);
            if (negCheck.ok && actCheck.ok) {
              response = currentResponse;
              break;
            }

            if (attempt === maxPolicyRetries) {
              // Give up safely: return no actions so we don't prompt/exe a forbidden plan.
              response =
                '```json\n' +
                JSON.stringify({
                  thought: 'Unable to produce a compliant action plan under the current app policies.',
                  actions: [],
                  verification: 'Please run interactively and/or adjust actionPolicies/negativePolicies.'
                }, null, 2) +
                '\n```';
              break;
            }

            const rejectionSystemParts = [];
            if (!negCheck.ok) rejectionSystemParts.push(formatNegativePolicyViolationSystemMessage(fgProcess, negCheck.violations));
            if (!actCheck.ok) rejectionSystemParts.push(formatActionPolicyViolationSystemMessage(fgProcess, actCheck.violations));
            const rejectionSystem = rejectionSystemParts.join('\n\n');

            const regenMessages = await buildMessages(enhancedMessage, includeVisualContext, {
              extraSystemMessages: [...baseExtraSystemMessages, rejectionSystem]
            });

            // Call the same provider/model we already used for the first response.
            const regenerated = await providerOrchestrator.callProvider(usedProvider, regenMessages, effectiveModel);

            currentResponse = regenerated || currentResponse;
            currentParsed = parseActions(currentResponse) || { actions: [] };
            attempt++;
          }
        }
      }
    } catch (e) {
      console.warn('[AI] Policy enforcement failed (non-fatal):', e.message);
    }

    // Add to conversation history
    historyStore.pushConversationEntry({ role: 'user', content: enhancedMessage });
    historyStore.pushConversationEntry({ role: 'assistant', content: response });

    // Trim history if too long
    historyStore.trimConversationHistory();

    // Persist to disk for session continuity
    historyStore.saveConversationHistory();

    return {
      success: true,
      message: response,
      provider: usedProvider,
      model: effectiveModel,
      modelVersion: modelRegistry()[effectiveModel]?.id || null,
      hasVisualContext: includeVisualContext && visualContextStore.getVisualContextCount() > 0
    };

  } catch (error) {
    return {
      success: false,
      error: error.message,
      provider: getCurrentProvider(),
      model: resolveCopilotModelKey(model)
    };
  }
}

const {
  extractJsonObjectFromText,
  parsePreferenceCorrection,
  sanitizePreferencePatch,
  validatePreferenceParserPayload
} = preferenceParser;

/**
 * Handle slash commands
 */
function handleCommand(command) {
  const parts = slashCommandHelpers.tokenize(String(command || '').trim());
  const cmd = (parts[0] || '').toLowerCase();

  switch (cmd) {
    case '/provider':
      if (parts[1]) {
        if (setProvider(parts[1])) {
          return { type: 'system', message: `Switched to ${parts[1]} provider.` };
        } else {
          return { type: 'error', message: `Unknown provider. Available: ${Object.keys(AI_PROVIDERS).join(', ')}` };
        }
      }
      return { type: 'info', message: `Current provider: ${getCurrentProvider()}\nAvailable: ${Object.keys(AI_PROVIDERS).join(', ')}` };

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
      } else if (parts[1] === 'off') {
        clearVisualContext();
        return { type: 'system', message: 'Visual context cleared.' };
      }
      return { type: 'info', message: `Visual context buffer: ${visualContextStore.getVisualContextCount()} image(s)` };

    case '/capture': {
      // Capture a full-screen frame into the visual context buffer.
      // Works in both Electron and CLI modes.
      try {
        const { screenshot } = require('./ui-automation/screenshot');
        return screenshot({ memory: true, base64: true, metric: 'sha256' })
          .then(result => {
            if (!result || !result.success || !result.base64) {
              return { type: 'error', message: 'Capture failed.' };
            }
            addVisualContext({
              dataURL: `data:image/png;base64,${result.base64}`,
              width: 0,
              height: 0,
              scope: 'screen',
              timestamp: Date.now()
            });
            return { type: 'system', message: `Captured visual context (buffer: ${visualContextStore.getVisualContextCount()})` };
          })
          .catch(err => ({ type: 'error', message: `Capture failed: ${err.message}` }));
      } catch (e) {
        return { type: 'error', message: `Capture failed: ${e.message}` };
      }
    }

    case '/login':
      if (oauthInProgress) {
        return {
          type: 'info',
          message: 'Login is already in progress. Complete the browser step and return here.'
        };
      }

      // If a token already exists and can be exchanged, report authenticated instead of failing.
      if (loadCopilotTokenIfNeeded()) {
        return exchangeForCopilotSession()
          .then(() => ({
            type: 'system',
            message: 'Already authenticated with GitHub Copilot. Session refreshed successfully.'
          }))
          .catch(() => startCopilotOAuth()
            .then(result => ({
              type: 'login',
              message: `GitHub Copilot authentication started!\n\nYour code: ${result.user_code}\n\nA browser window has opened. Enter the code to authorize.\nWaiting for authentication...`
            }))
            .catch(err => ({
              type: 'error',
              message: `Login failed: ${err.message}`
            }))
          );
      }

      // Start GitHub Copilot OAuth device code flow
      return startCopilotOAuth()
        .then(result => ({
          type: 'login',
          message: `GitHub Copilot authentication started!\n\nYour code: ${result.user_code}\n\nA browser window has opened. Enter the code to authorize.\nWaiting for authentication...`
        }))
        .catch(err => ({
          type: 'error',
          message: `Login failed: ${err.message}`
        }));

    case '/logout':
      apiKeys.copilot = '';
      apiKeys.copilotSession = '';
      try {
        if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
      } catch (e) {}
      return { type: 'system', message: 'Logged out from GitHub Copilot.' };

    case '/model':
      if (parts.length > 1) {
        let requested = null;
        if (parts[1] === '--set') {
          requested = parts.slice(2).join(' ');
        } else if (parts[1] === '--current' || parts[1] === 'current') {
          const currentModel = getCurrentCopilotModel();
          const cur = modelRegistry()[currentModel];
          return {
            type: 'info',
            message: `Current model: ${cur?.name || currentModel} (${currentModel})`
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
        } else {
          const available = Object.entries(modelRegistry())
            .map(([k, v]) => `  ${k} - ${v.name}`)
            .join('\n');
          return { 
            type: 'error', 
            message: `Unknown model. Available models:\n${available}`
          };
        }
      } else {
        const models = getCopilotModels();
        const list = models.map(m => 
          `${m.current ? '→' : ' '} ${m.id} - ${m.name}${m.vision ? ' 👁' : ''}`
        ).join('\n');
        const currentModel = getCurrentCopilotModel();
        const active = modelRegistry()[currentModel];
        return {
          type: 'info',
          message: `Current model: ${active?.name || currentModel}\n\nAvailable models:\n${list}\n\nUse /model <id> to switch (you can also paste "id - display name")`
        };
      }

    case '/status':
      loadCopilotTokenIfNeeded();
      const status = getStatus();
      return {
        type: 'info',
        message: `Provider: ${status.provider}\nModel: ${modelRegistry()[getCurrentCopilotModel()]?.name || getCurrentCopilotModel()}\nCopilot: ${status.hasCopilotKey ? 'Authenticated' : 'Not authenticated'}\nOpenAI: ${status.hasOpenAIKey ? 'Key set' : 'No key'}\nAnthropic: ${status.hasAnthropicKey ? 'Key set' : 'No key'}\nHistory: ${status.historyLength} messages\nVisual: ${status.visualContextCount} captures`
      };

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
      return null; // Not a command
  }
}

/**
 * Get current status
 */
/**
 * Set callback for OAuth completion
 */
function setOAuthCallback(callback) {
  oauthCallback = callback;
}

/**
 * Get current status
 */
function getStatus() {
  const registry = modelRegistry();
  return {
    provider: getCurrentProvider(),
    model: getCurrentCopilotModel(),
    modelName: registry[getCurrentCopilotModel()]?.name || getCurrentCopilotModel(),
    hasCopilotKey: !!apiKeys.copilot,
    hasApiKey: getCurrentProvider() === 'copilot' ? !!apiKeys.copilot : 
           getCurrentProvider() === 'openai' ? !!apiKeys.openai :
           getCurrentProvider() === 'anthropic' ? !!apiKeys.anthropic : true,
    hasOpenAIKey: !!apiKeys.openai,
    hasAnthropicKey: !!apiKeys.anthropic,
    historyLength: historyStore.getHistoryLength(),
    visualContextCount: visualContextStore.getVisualContextCount(),
    browserSessionState: getBrowserSessionState(),
    availableProviders: Object.keys(AI_PROVIDERS),
    copilotModels: getCopilotModels()
  };
}

// ===== SAFETY GUARDRAILS =====

/**
 * Action risk levels for safety classification
 */
const ActionRiskLevel = {
  SAFE: 'SAFE',         // Read-only, no risk (e.g., screenshot)
  LOW: 'LOW',           // Minor risk (e.g., scroll, move mouse)
  MEDIUM: 'MEDIUM',     // Moderate risk (e.g., click, type text)
  HIGH: 'HIGH',         // Significant risk (e.g., file operations, form submit)
  CRITICAL: 'CRITICAL'  // Dangerous (e.g., delete, purchase, payment)
};

/**
 * Dangerous text patterns that require user confirmation
 */
const DANGER_PATTERNS = [
  // Destructive actions
  /\b(delete|remove|erase|destroy|clear|reset|uninstall|format)\b/i,
  // Financial actions
  /\b(buy|purchase|order|checkout|pay|payment|subscribe|donate|transfer|send money)\b/i,
  // Account actions
  /\b(logout|log out|sign out|deactivate|close account|cancel subscription)\b/i,
  // System actions
  /\b(shutdown|restart|reboot|sleep|hibernate|power off)\b/i,
  // Confirmation buttons with risk
  /\b(confirm|yes,? delete|yes,? remove|permanently|irreversible|cannot be undone)\b/i,
  // Administrative actions
  /\b(admin|administrator|root|sudo|elevated|run as)\b/i
];

/**
 * Safe/benign patterns that reduce risk level
 */
const SAFE_PATTERNS = [
  /\b(cancel|back|close|dismiss|skip|later|no thanks|maybe later)\b/i,
  /\b(search|find|view|show|display|open|read|look)\b/i,
  /\b(help|info|about|settings|preferences)\b/i
];

/**
 * Pending action awaiting user confirmation
 */
let pendingAction = null;

/**
 * Analyze the safety/risk level of an action
 * @param {Object} action - The action to analyze
 * @param {Object} targetInfo - Information about what's at the click target
 * @returns {Object} Safety analysis result
 */
function analyzeActionSafety(action, targetInfo = {}) {
  const result = {
    actionId: `action-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
    action: action,
    targetInfo: targetInfo,
    riskLevel: ActionRiskLevel.SAFE,
    warnings: [],
    requiresConfirmation: false,
    description: '',
    timestamp: Date.now()
  };
  
  // Check action type base risk
  switch (action.type) {
    case 'screenshot':
    case 'wait':
      result.riskLevel = ActionRiskLevel.SAFE;
      break;
    case 'scroll':
      result.riskLevel = ActionRiskLevel.LOW;
      break;
    case 'click':
    case 'double_click':
      result.riskLevel = ActionRiskLevel.MEDIUM;
      break;
    case 'right_click':
      result.riskLevel = ActionRiskLevel.MEDIUM;
      result.warnings.push('Right-click may open context menu with destructive options');
      break;
    case 'type':
      result.riskLevel = ActionRiskLevel.MEDIUM;
      // Check what's being typed
      if (action.text && action.text.length > 100) {
        result.warnings.push('Typing large amount of text');
      }
      break;
    case 'key':
      // Analyze key combinations
      const key = (action.key || '').toLowerCase();
      const keyNorm = key.replace(/\s+/g, '');

      // Treat window/tab/app-close shortcuts as HIGH risk: they can instantly close the overlay,
      // the active terminal tab/window, a browser window, or dismiss important dialogs.
      // Require explicit confirmation so smaller models can't accidentally "self-close" the UI.
      const closeCombos = [
        'alt+f4',
        'ctrl+w',
        'ctrl+shift+w',
        'ctrl+q',
        'ctrl+shift+q',
        'cmd+w',
        'cmd+q',
      ];
      if (closeCombos.includes(keyNorm)) {
        result.riskLevel = ActionRiskLevel.CRITICAL;
        result.warnings.push(`Close shortcut detected: ${action.key}`);
        result.requiresConfirmation = true;
        break;
      }

      if (key.includes('delete') || key.includes('backspace')) {
        result.riskLevel = ActionRiskLevel.HIGH;
        result.warnings.push('Delete/Backspace key may remove content');
      } else if (key.includes('enter') || key.includes('return')) {
        result.riskLevel = ActionRiskLevel.MEDIUM;
        result.warnings.push('Enter key may submit form or confirm action');
      } else if (key.includes('ctrl') || key.includes('cmd') || key.includes('alt')) {
        result.riskLevel = ActionRiskLevel.MEDIUM;
        result.warnings.push('Keyboard shortcut detected');
      }
      break;
    case 'drag':
      result.riskLevel = ActionRiskLevel.MEDIUM;
      break;
    case 'focus_window':
    case 'bring_window_to_front':
      result.riskLevel = ActionRiskLevel.LOW;
      break;
    case 'send_window_to_back':
    case 'minimize_window':
    case 'restore_window':
      result.riskLevel = ActionRiskLevel.LOW;
      break;
    case 'run_command':
      // Analyze command safety
      const cmd = (action.command || '').toLowerCase();
      const dangerousPatterns = [
        /\b(rm|del|erase|rmdir|rd)\s+(-[rf]+|\/[sq]+|\*)/i,
        /Remove-Item.*-Recurse.*-Force/i,
        /\bformat\s+[a-z]:/i,  // Match "format C:" but not "Format-Table"
        /\b(shutdown|restart|reboot)\b/i,
        /\breg\s+(delete|add)\b/i,
        /\bnet\s+(user|localgroup)\b/i,
        /\b(sudo|runas)\b/i,
        /Start-Process.*-Verb\s+RunAs/i,
        /Set-ExecutionPolicy/i,
        /Stop-Process.*-Force/i,
      ];
      
      const isDangerous = dangerousPatterns.some(p => p.test(action.command || ''));
      if (isDangerous) {
        result.riskLevel = ActionRiskLevel.CRITICAL;
        result.warnings.push('Potentially destructive command');
        result.requiresConfirmation = true;
      } else if (cmd.includes('rm ') || cmd.includes('del ') || cmd.includes('remove')) {
        result.riskLevel = ActionRiskLevel.HIGH;
        result.warnings.push('Command may delete files');
        result.requiresConfirmation = true;
      } else {
        result.riskLevel = ActionRiskLevel.MEDIUM;
      }
      break;
  }
  
  // Check target info for dangerous patterns
  const textToCheck = [
    targetInfo.text || '',
    targetInfo.buttonText || '',
    targetInfo.label || '',
    action.reason || '',
    ...(targetInfo.nearbyText || [])
  ].join(' ');
  
  // Check for danger patterns
  for (const pattern of DANGER_PATTERNS) {
    if (pattern.test(textToCheck)) {
      result.riskLevel = ActionRiskLevel.HIGH;
      result.warnings.push(`Detected risky keyword: ${textToCheck.match(pattern)?.[0]}`);
      result.requiresConfirmation = true;
    }
  }
  
  // Elevate to CRITICAL if multiple danger flags
  if (result.warnings.length >= 2 && result.riskLevel === ActionRiskLevel.HIGH) {
    result.riskLevel = ActionRiskLevel.CRITICAL;
  }
  
  // Always require confirmation for HIGH or CRITICAL
  if (result.riskLevel === ActionRiskLevel.HIGH || result.riskLevel === ActionRiskLevel.CRITICAL) {
    result.requiresConfirmation = true;
  }
  
  // Check for low confidence inspect region targets
  if (targetInfo.confidence !== undefined && targetInfo.confidence < 0.7) {
    result.warnings.push(`Low confidence target (${Math.round(targetInfo.confidence * 100)}%)`);
    result.requiresConfirmation = true;
    if (result.riskLevel === ActionRiskLevel.SAFE || result.riskLevel === ActionRiskLevel.LOW) {
      result.riskLevel = ActionRiskLevel.MEDIUM;
    }
  }
  
  // Check if target is from inspect mode with very low confidence
  if (targetInfo.confidence !== undefined && targetInfo.confidence < 0.5) {
    result.riskLevel = ActionRiskLevel.HIGH;
    result.warnings.push('Very low confidence - verify target manually');
  }
  
  // Generate human-readable description
  result.description = describeAction(action, targetInfo);
  
  return result;
}

/**
 * Generate human-readable description of an action
 */
function describeAction(action, targetInfo = {}) {
  const target = targetInfo.text || targetInfo.buttonText || targetInfo.label || '';
  const location = action.x !== undefined ? `at (${action.x}, ${action.y})` : '';
  
  switch (action.type) {
    case 'click':
      return `Click ${target ? `"${target}"` : ''} ${location}`.trim();
    case 'double_click':
      return `Double-click ${target ? `"${target}"` : ''} ${location}`.trim();
    case 'right_click':
      return `Right-click ${target ? `"${target}"` : ''} ${location}`.trim();
    case 'type':
      const preview = action.text?.length > 30 ? action.text.substring(0, 30) + '...' : action.text;
      return `Type "${preview}"`;
    case 'key':
      return `Press ${action.key}`;
    case 'scroll':
      return `Scroll ${action.direction} ${action.amount || 3} times`;
    case 'drag':
      return `Drag from (${action.fromX}, ${action.fromY}) to (${action.toX}, ${action.toY})`;
    case 'focus_window':
      return `Focus window ${action.windowHandle || action.hwnd || action.title || action.processName || ''}`.trim();
    case 'bring_window_to_front':
      return `Bring window to front ${action.windowHandle || action.hwnd || action.title || action.processName || ''}`.trim();
    case 'send_window_to_back':
      return `Send window to back ${action.windowHandle || action.hwnd || action.title || action.processName || ''}`.trim();
    case 'minimize_window':
      return `Minimize window ${action.windowHandle || action.hwnd || action.title || action.processName || ''}`.trim();
    case 'restore_window':
      return `Restore window ${action.windowHandle || action.hwnd || action.title || action.processName || ''}`.trim();
    case 'wait':
      return `Wait ${action.ms}ms`;
    case 'screenshot':
      return 'Take screenshot';
    default:
      return `${action.type} action`;
  }
}

/**
 * Store pending action for user confirmation
 */
function setPendingAction(actionData) {
  pendingAction = actionData;
  return actionData.actionId;
}

/**
 * Get pending action
 */
function getPendingAction() {
  return pendingAction;
}

/**
 * Clear pending action
 */
function clearPendingAction() {
  pendingAction = null;
}

/**
 * Confirm pending action
 */
function confirmPendingAction(actionId) {
  if (pendingAction && pendingAction.actionId === actionId) {
    const action = pendingAction;
    pendingAction = null;
    return action;
  }
  return null;
}

/**
 * Reject pending action
 */
function rejectPendingAction(actionId) {
  if (pendingAction && pendingAction.actionId === actionId) {
    pendingAction = null;
    return true;
  }
  return false;
}

// ===== AGENTIC ACTION HANDLING =====

function preflightActions(actionData, options = {}) {
  if (!actionData || !Array.isArray(actionData.actions)) return actionData;
  const userMessage = typeof options.userMessage === 'string' ? options.userMessage : '';
  const normalized = actionData.actions.map(normalizeActionForReliability);
  const rewritten = rewriteActionsForReliability(normalized, { userMessage });
  if (rewritten === actionData.actions) return actionData;
  return { ...actionData, actions: rewritten, _rewrittenForReliability: true };
}

function normalizeActionForReliability(action) {
  if (!action || typeof action !== 'object') return action;
  const out = { ...action };
  const rawType = (out.type ?? out.action ?? '').toString().trim();
  const t = rawType.toLowerCase();

  if (!out.type && out.action) out.type = out.action;

  if (t === 'press_key' || t === 'presskey' || t === 'key_press' || t === 'keypress' || t === 'send_key') {
    out.type = 'key';
  } else if (t === 'type_text' || t === 'typetext' || t === 'enter_text' || t === 'input_text') {
    out.type = 'type';
  } else if (t === 'take_screenshot' || t === 'screencap') {
    out.type = 'screenshot';
  } else if (t === 'sleep' || t === 'delay' || t === 'wait_ms') {
    out.type = 'wait';
  }

  if (out.type === 'type' && (out.text === undefined || out.text === null)) {
    if (typeof out.value === 'string') out.text = out.value;
    else if (typeof out.input === 'string') out.text = out.input;
  }
  if (out.type === 'key' && (out.key === undefined || out.key === null)) {
    if (typeof out.combo === 'string') out.key = out.combo;
    else if (typeof out.keys === 'string') out.key = out.keys;
  }
  if (out.type === 'wait' && (out.ms === undefined || out.ms === null)) {
    const ms = out.milliseconds ?? out.duration_ms ?? out.durationMs;
    if (Number.isFinite(Number(ms))) out.ms = Number(ms);
  }

  return out;
}

function normalizeUrlCandidate(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(t)) return `https://${t}`;
  return null;
}

function extractRequestedAppName(text) {
  if (!text || typeof text !== 'string') return null;
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  const m = normalized.match(/\b(open|launch|start|run)\b\s+(?:the\s+)?(.+?)\s+\b(app|application|program)\b/i);
  if (m && m[2]) {
    return m[2].trim();
  }

  const short = normalized.match(/\b(open|launch|start|run)\b\s+(.+)/i);
  if (short && short[2] && short[2].length <= 48 && !/https?:\/\//i.test(short[2])) {
    return short[2].trim();
  }

  return null;
}

function buildProcessCandidatesFromAppName(appName) {
  const raw = String(appName || '').trim();
  if (!raw) return [];
  const lower = raw.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]+/g, '');
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
  const candidates = new Set();

  // Known app mappings.
  const known = [
    { re: /\bmpc\s*3\b/i, names: ['mpc3', 'mpc'] },
    { re: /visual\s+studio\s+code|\bvscode\b/i, names: ['code'] },
    { re: /microsoft\s+edge/i, names: ['msedge'] },
    { re: /google\s+chrome/i, names: ['chrome'] },
    { re: /mozilla\s+firefox|\bfirefox\b/i, names: ['firefox'] }
  ];
  for (const row of known) {
    if (row.re.test(lower)) {
      row.names.forEach(n => candidates.add(n));
    }
  }

  if (compact.length >= 2) candidates.add(compact);
  if (tokens.length) {
    tokens.forEach(t => {
      if (t.length >= 2) candidates.add(t);
    });
    if (tokens.length >= 2) {
      candidates.add(tokens.join(''));
    }
  }

  return Array.from(candidates).slice(0, 6);
}

function buildTitleHintsFromAppName(appName) {
  const raw = String(appName || '').trim();
  if (!raw) return [];
  const compact = raw.replace(/\s+/g, '');
  const hints = [raw, compact].filter(Boolean);
  return Array.from(new Set(hints));
}

function buildVerifyTargetHintFromAppName(appName) {
  return {
    appName,
    processNames: buildProcessCandidatesFromAppName(appName),
    titleHints: buildTitleHintsFromAppName(appName),
    popupKeywords: ['license', 'activation', 'signin', 'login', 'update', 'setup', 'installer', 'warning', 'permission', 'eula', 'project', 'new project', 'open project', 'workspace']
  };
}

function buildOpenApplicationActions(appName) {
  const verifyTarget = buildVerifyTargetHintFromAppName(appName);
  return [
    { type: 'key', key: 'win', reason: 'Open Start menu', verifyTarget },
    { type: 'wait', ms: 220 },
    { type: 'type', text: appName, reason: `Search for ${appName}` },
    { type: 'wait', ms: 140 },
    { type: 'key', key: 'enter', reason: `Launch ${appName}`, verifyTarget },
    { type: 'wait', ms: 2200 }
  ];
}

function extractFirstUrlFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  if (!t) return null;
  const httpMatch = t.match(/\bhttps?:\/\/[^\s"'<>]+/i);
  if (httpMatch) return normalizeUrlCandidate(httpMatch[0]);

  // Basic domain/path match (e.g., google.com, google.com/search?q=x)
  const domainMatch = t.match(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/[\w\-._~%!$&'()*+,;=:@/?#\[\]]*)?)\b/i);
  if (domainMatch) return normalizeUrlCandidate(domainMatch[1]);
  return null;
}

function extractExplicitBrowserTarget(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.toLowerCase();

  // Prefer explicit "open/use ... in <browser>" style instructions, taking the LAST match.
  const matches = Array.from(
    t.matchAll(
      /\b(open|launch|use)\b[^.!?\n]{0,120}\b(in|with|using)\b[^.!?\n]{0,60}\b(microsoft\s+edge\s+beta|microsoft\s+edge\s+dev|microsoft\s+edge\s+canary|microsoft\s+edge|edge\s+beta|edge\s+dev|edge\s+canary|edge|google\s+chrome\s+canary|google\s+chrome\s+beta|google\s+chrome\s+dev|google\s+chrome|chrome\s+canary|chrome\s+beta|chrome\s+dev|chrome|firefox)\b/gi
    )
  );
  const last = matches.length ? matches[matches.length - 1] : null;
  const candidate = last?.[3] || (t.match(/\bin\s+(edge\s+beta|edge\s+dev|edge\s+canary|edge|chrome\s+canary|chrome\s+beta|chrome\s+dev|chrome|firefox)\b[^.!?\n]*$/i)?.[1]);
  if (!candidate) return null;

  const c = candidate.replace(/\s+/g, ' ').trim();

  if (c.includes('edge')) {
    const channel = c.includes('beta') ? 'beta' : c.includes('dev') ? 'dev' : c.includes('canary') ? 'canary' : 'stable';
    return { browser: 'edge', channel };
  }
  if (c.includes('chrome')) {
    const channel = c.includes('beta') ? 'beta' : c.includes('dev') ? 'dev' : c.includes('canary') ? 'canary' : 'stable';
    return { browser: 'chrome', channel };
  }
  if (c.includes('firefox')) return { browser: 'firefox', channel: 'stable' };

  return null;
}

function buildBrowserWindowTitleTarget(target) {
  if (!target || !target.browser) return null;
  const channel = target.channel || 'stable';

  if (target.browser === 'edge') {
    if (channel === 'beta') return 're:.*\\bMicrosoft Edge(?: Beta)?$';
    if (channel === 'dev') return 're:.*\\bMicrosoft Edge(?: Dev)?$';
    if (channel === 'canary') return 're:.*\\bMicrosoft Edge(?: Canary)?$';
    // Stable requests should still tolerate channel variants if those are running.
    return 're:.*\\bMicrosoft Edge(?: Beta| Dev| Canary)?$';
  }

  if (target.browser === 'chrome') {
    if (channel === 'beta') return 're:.*\\bGoogle Chrome(?: Beta)?$';
    if (channel === 'dev') return 're:.*\\bGoogle Chrome(?: Dev)?$';
    if (channel === 'canary') return 're:.*\\bGoogle Chrome(?: Canary)?$';
    return 're:.*\\bGoogle Chrome(?: Beta| Dev| Canary)?$';
  }

  if (target.browser === 'firefox') {
    // Common suffix. If it differs, processName will still help.
    return 're:.*\\bMozilla Firefox$';
  }

  return null;
}

function extractSearchQueryFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  const searchMatch = normalized.match(/\bsearch\s+(?:for\s+)?["']?(.+?)["']?(?:\s+(?:then|and\s+then)\b|$)/i);
  if (!searchMatch || !searchMatch[1]) return null;

  const query = searchMatch[1].trim();
  if (!query || query.length < 2) return null;
  return query;
}

function inferYouTubeSearchIntent(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.toLowerCase();
  const wantsYouTube = t.includes('youtube');
  const wantsSearch = /\bsearch\b/.test(t);
  if (!wantsYouTube || !wantsSearch) return null;

  const query = extractSearchQueryFromText(text);
  if (!query) return null;

  const browser = extractExplicitBrowserTarget(text) || { browser: 'edge', channel: 'stable' };
  return {
    browser,
    query,
    url: 'https://www.youtube.com'
  };
}

function hasRankingIntent(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.toLowerCase();
  return /(highest|most|top|best|lowest|least)\b/.test(t)
    || /\bnumber of views\b/.test(t)
    || /\bview\s*count\b/.test(t);
}

function buildYouTubeTopViewedPlaybackActions() {
  const command = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$u = ''
try { $u = (Get-Clipboard -Raw).Trim() } catch {}

if (-not $u -or $u -notmatch 'youtube\\.com') {
  $ytProc = Get-Process -Name msedge,chrome,firefox -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -match 'YouTube' } |
    Select-Object -First 1

  if (-not $ytProc) {
    throw 'Could not infer YouTube context from clipboard or browser title.'
  }

  $title = [string]$ytProc.MainWindowTitle
  $q = ($title -replace '^\\(\\d+\\)\\s*', '' -replace '\\s*-\\s*YouTube.*$', '').Trim()
  if (-not $q) {
    throw 'Could not infer search query from YouTube title.'
  }
  $u = 'https://www.youtube.com/results?search_query=' + [uri]::EscapeDataString($q)
}

if ($u -notmatch 'youtube\\.com') {
  throw 'Current context is not YouTube.'
}

if ($u -match 'search_query=([^&]+)') {
  $q = [uri]::UnescapeDataString($matches[1])
} else {
  throw 'Current YouTube URL is not a search results page; run search first.'
}

$sorted = 'https://www.youtube.com/results?search_query=' + [uri]::EscapeDataString($q) + '&sp=CAMSAhAB'
$html = (Invoke-WebRequest -UseBasicParsing -Uri $sorted -TimeoutSec 20).Content
$ids = [regex]::Matches($html, '"videoId":"([A-Za-z0-9_-]{11})"') | ForEach-Object { $_.Groups[1].Value }
$first = $ids | Select-Object -Unique | Select-Object -First 1

if (-not $first) {
  throw 'Could not locate a playable video id from sorted results.'
}

$watch = 'https://www.youtube.com/watch?v=' + $first
Start-Process $watch
Write-Output ('Opened top-view candidate: ' + $watch)
`.trim();

  return [
    {
      type: 'bring_window_to_front',
      title: 're:.*\\b(Microsoft Edge|Google Chrome|Mozilla Firefox)(?: Beta| Dev| Canary)?$',
      processName: 'msedge',
      continue_on_error: true,
      reason: 'Focus browser if available'
    },
    { type: 'wait', ms: 450 },
    { type: 'key', key: 'ctrl+l', reason: 'Focus browser address bar' },
    { type: 'wait', ms: 120 },
    { type: 'key', key: 'ctrl+c', reason: 'Copy current URL for non-visual resolver' },
    { type: 'wait', ms: 120 },
    {
      type: 'run_command',
      shell: 'powershell',
      command,
      reason: 'Resolve and open highest-view YouTube result without screenshot'
    },
    { type: 'wait', ms: 1800 }
  ];
}

const NON_VISUAL_WEB_STRATEGIES = [
  {
    id: 'youtube-top-view-playback',
    match: ({ userMessage }) => {
      const t = String(userMessage || '').toLowerCase();
      const likelyYoutube = t.includes('youtube') || t.includes('video');
      const playIntent = t.includes('play') || t.includes('open');
      return likelyYoutube && playIntent && hasRankingIntent(t);
    },
    buildActions: () => buildYouTubeTopViewedPlaybackActions()
  }
];

function applyNonVisualWebStrategies(actions, context = {}) {
  for (const strategy of NON_VISUAL_WEB_STRATEGIES) {
    try {
      if (strategy.match(context, actions)) {
        return {
          actions: strategy.buildActions(context, actions),
          strategyId: strategy.id
        };
      }
    } catch {
      // Ignore strategy-level failures and continue.
    }
  }
  return {
    actions,
    strategyId: null
  };
}

function isBrowserProcessName(name) {
  const n = String(name || '').toLowerCase();
  return n.includes('msedge') || n.includes('chrome') || n.includes('firefox');
}

function looksLikeBrowserTitle(title) {
  const t = String(title || '').toLowerCase();
  return t.includes('edge') || t.includes('chrome') || t.includes('firefox') || t.includes('youtube');
}

function actionsLikelyBrowserSession(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return false;
  return actions.some((a) => {
    const type = String(a?.type || '').toLowerCase();
    if (type === 'run_command') return true;
    if ((type === 'bring_window_to_front' || type === 'focus_window') && (isBrowserProcessName(a?.processName) || looksLikeBrowserTitle(a?.title))) return true;
    if ((type === 'type' || type === 'key') && /ctrl\+l|youtube|https?:\/\//i.test(String(a?.text || a?.key || ''))) return true;
    return false;
  });
}

function extractUrlFromActions(actions) {
  if (!Array.isArray(actions)) return null;
  for (const action of actions) {
    if (String(action?.type || '').toLowerCase() !== 'type') continue;
    const candidate = normalizeUrlCandidate(String(action?.text || '').trim());
    if (candidate) return candidate;
  }
  return null;
}

function extractUrlFromResults(results) {
  if (!Array.isArray(results)) return null;
  for (const result of results) {
    const haystack = [result?.output, result?.stdout, result?.message, result?.result]
      .filter(Boolean)
      .map(v => String(v))
      .join('\n');
    const m = haystack.match(/https?:\/\/[^\s"'<>]+/i);
    if (m) return normalizeUrlCandidate(m[0]);
  }
  return null;
}

function updateBrowserSessionAfterExecution(actionData, executionSummary = {}) {
  const actions = Array.isArray(actionData?.actions) ? actionData.actions : [];
  if (!actionsLikelyBrowserSession(actions)) return;

  const patch = {};
  if (typeof executionSummary.userMessage === 'string' && executionSummary.userMessage.trim()) {
    patch.lastUserIntent = executionSummary.userMessage.trim().slice(0, 300);
  }

  const urlFromActions = extractUrlFromActions(actions);
  const urlFromResults = extractUrlFromResults(executionSummary.results);
  patch.url = urlFromResults || urlFromActions || getBrowserSessionState().url;

  const fg = executionSummary.postVerification?.foreground;
  if (fg && fg.success && looksLikeBrowserTitle(fg.title)) {
    patch.title = fg.title;
  }

  patch.goalStatus = executionSummary.success ? 'achieved' : 'needs_attention';
  updateBrowserSessionState(patch);
}

function isVsCodeIntegratedBrowserRequest(text) {
  if (!text || typeof text !== 'string') return false;
  // If the user explicitly targets a different browser, do not treat this as
  // a VS Code integrated-browser request (common phrasing: "instead of ..., open in Edge").
  const explicitBrowser = extractExplicitBrowserTarget(text);
  if (explicitBrowser && explicitBrowser.browser !== 'vscode') return false;

  const t = text.toLowerCase();
  const mentionsVsCode = t.includes('vs code') || t.includes('visual studio code') || t.includes('vscode');
  const mentionsIntegrated =
    t.includes('integrated browser') ||
    t.includes('simple browser') ||
    t.includes('live preview') ||
    t.includes('browser preview');

  const mentionsMicrosoftIntegrated = t.includes('microsoft integrated browser');
  const hasVsCodeContext = mentionsVsCode || mentionsMicrosoftIntegrated || t.includes('simple browser');
  return hasVsCodeContext && mentionsIntegrated;
}

function buildBrowserOpenUrlActions(target, url, options = {}) {
  const searchQuery = typeof options.searchQuery === 'string' ? options.searchQuery.trim() : '';
  const title = buildBrowserWindowTitleTarget(target);
  const browser = target?.browser;
  const processName = browser === 'edge' ? 'msedge' : browser === 'chrome' ? 'chrome' : browser === 'firefox' ? 'firefox' : '';
  const human = browser === 'edge' ? 'Microsoft Edge' : browser === 'chrome' ? 'Google Chrome' : browser === 'firefox' ? 'Mozilla Firefox' : 'Browser';
  const channelLabel = target?.channel && target.channel !== 'stable' ? ` ${target.channel}` : '';

  const actions = [
    {
      type: 'bring_window_to_front',
      title: title || human,
      processName,
      reason: `Focus ${human}${channelLabel}`
    },
    { type: 'wait', ms: 650 },
    { type: 'key', key: 'ctrl+l', reason: 'Focus address bar' },
    { type: 'wait', ms: 150 },
    { type: 'type', text: url, reason: 'Enter URL' },
    { type: 'key', key: 'enter', reason: 'Navigate' },
    { type: 'wait', ms: 3000 }
  ];

  if (searchQuery) {
    let isYouTube = false;
    try {
      const parsed = new URL(url);
      isYouTube = /(^|\.)youtube\.com$/i.test(parsed.hostname || '');
    } catch {
      isYouTube = /youtube\.com/i.test(String(url || ''));
    }
    if (isYouTube) {
      actions.push(
        { type: 'key', key: '/', reason: 'Focus YouTube search box' },
        { type: 'wait', ms: 180 },
        { type: 'type', text: searchQuery, reason: 'Enter search query' },
        { type: 'key', key: 'enter', reason: 'Run search' },
        { type: 'wait', ms: 2500 }
      );
    }
  }

  return actions;
}

function prependVsCodeFocusIfMissing(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return actions;
  const hasVsCodeFocus = actions.some((a) => {
    if (!a) return false;
    if (a.type !== 'bring_window_to_front' && a.type !== 'focus_window') return false;
    const pn = String(a.processName || '').toLowerCase();
    const title = String(a.title || '').toLowerCase();
    return pn.includes('code') || title.includes('visual studio code') || title.includes('vs code') || title.includes('vscode');
  });
  if (hasVsCodeFocus) return actions;

  return [
    {
      type: 'bring_window_to_front',
      title: 'Visual Studio Code',
      processName: 'code',
      reason: 'Focus VS Code (required before Command Palette / Simple Browser)'
    },
    { type: 'wait', ms: 650 },
    ...actions
  ];
}

function prependBrowserFocusIfMissing(actions, target) {
  if (!Array.isArray(actions) || actions.length === 0) return actions;
  if (!target || !target.browser) return actions;

  const needsKeyboard = actions.some((a) => a?.type === 'key' || a?.type === 'type');
  if (!needsKeyboard) return actions;

  const processName = target.browser === 'edge' ? 'msedge' : target.browser === 'chrome' ? 'chrome' : target.browser === 'firefox' ? 'firefox' : '';
  const title = buildBrowserWindowTitleTarget(target);

  const hasBrowserFocus = actions.some((a) => {
    if (!a) return false;
    if (a.type !== 'bring_window_to_front' && a.type !== 'focus_window') return false;
    const pn = String(a.processName || '').toLowerCase();
    if (processName && pn && pn.includes(processName)) return true;
    const tt = String(a.title || '').toLowerCase();
    if (target.browser === 'edge' && tt.includes('edge')) return true;
    if (target.browser === 'chrome' && tt.includes('chrome')) return true;
    if (target.browser === 'firefox' && tt.includes('firefox')) return true;
    return false;
  });
  if (hasBrowserFocus) return actions;

  return [
    {
      type: 'bring_window_to_front',
      title: title || (target.browser === 'edge' ? 'Microsoft Edge' : target.browser === 'chrome' ? 'Google Chrome' : 'Mozilla Firefox'),
      processName,
      reason: 'Focus target browser before keyboard input'
    },
    { type: 'wait', ms: 650 },
    ...actions
  ];
}

function buildVsCodeSimpleBrowserOpenUrlActions(url) {
  return [
    {
      type: 'bring_window_to_front',
      title: 'Visual Studio Code',
      processName: 'code',
      reason: 'Focus VS Code (required for integrated browser actions)'
    },
    { type: 'wait', ms: 650 },
    { type: 'key', key: 'ctrl+shift+p', reason: 'Open Command Palette' },
    { type: 'wait', ms: 350 },
    { type: 'type', text: 'Simple Browser: Show', reason: 'Open VS Code integrated Simple Browser' },
    { type: 'wait', ms: 150 },
    { type: 'key', key: 'enter', reason: 'Run Simple Browser: Show' },
    { type: 'wait', ms: 950 },
    { type: 'type', text: url, reason: 'Enter URL' },
    { type: 'key', key: 'enter', reason: 'Navigate' },
    { type: 'wait', ms: 3000 }
  ];
}

function rewriteActionsForReliability(actions, context = {}) {
  if (!Array.isArray(actions) || actions.length === 0) return actions;

  const userMessage = typeof context.userMessage === 'string' ? context.userMessage : '';
  const strategySelection = applyNonVisualWebStrategies(actions, { userMessage });
  if (strategySelection.actions !== actions) {
    updateBrowserSessionState({
      goalStatus: 'in_progress',
      lastStrategy: strategySelection.strategyId || 'non-visual',
      lastUserIntent: userMessage.trim().slice(0, 300)
    });
    return strategySelection.actions;
  }

  // If the AI is already using the Simple Browser command palette flow, keep it,
  // but ensure we focus VS Code first (models often forget this).
  const alreadySimpleBrowser = actions.some(
    (a) => typeof a?.text === 'string' && /simple\s+browser\s*:\s*show/i.test(a.text)
  );
  if (alreadySimpleBrowser) {
    return prependVsCodeFocusIfMissing(actions);
  }

  // Intent-aware rewrite: if the USER asked to open a URL in VS Code integrated browser,
  // run the full deterministic Simple Browser flow even if the model tries incremental steps.
  const requestedAppName = extractRequestedAppName(userMessage);
  const requestedUrl = extractFirstUrlFromText(userMessage);
  const youtubeSearchIntent = inferYouTubeSearchIntent(userMessage);

  if (youtubeSearchIntent?.browser?.browser && !requestedUrl) {
    const lowSignal = actions.every((a) => ['bring_window_to_front', 'focus_window', 'key', 'type', 'wait', 'screenshot'].includes(a?.type));
    const tinyOrFragmented = actions.length <= 4;
    if (lowSignal || tinyOrFragmented) {
      updateBrowserSessionState({
        url: youtubeSearchIntent.url,
        goalStatus: 'in_progress',
        lastStrategy: 'deterministic-youtube-search-no-url',
        lastUserIntent: userMessage.trim().slice(0, 300)
      });
      return buildBrowserOpenUrlActions(
        youtubeSearchIntent.browser,
        youtubeSearchIntent.url,
        { searchQuery: youtubeSearchIntent.query }
      );
    }
  }

  if (requestedAppName && !requestedUrl) {
    const lowSignalTypes = new Set(['bring_window_to_front', 'focus_window', 'key', 'type', 'wait', 'screenshot']);
    const lowSignal = actions.every((a) => lowSignalTypes.has(a?.type));
    const screenshotFirst = actions[0]?.type === 'screenshot';
    const longPlan = actions.length >= 6;
    const tinyPlan = actions.length <= 2;
    const hasSearchType = actions.some((a) => a?.type === 'type' && typeof a.text === 'string' && a.text.trim().length > 0);
    const hasLaunchEnter = actions.some((a) => a?.type === 'key' && /^enter$/i.test(String(a.key || '').trim()));
    const incompleteLaunchPlan = !hasSearchType || !hasLaunchEnter;
    if ((screenshotFirst || longPlan || tinyPlan || incompleteLaunchPlan) && lowSignal) {
      return buildOpenApplicationActions(requestedAppName);
    }
  }

  const explicitBrowser = extractExplicitBrowserTarget(userMessage);
  if (explicitBrowser?.browser && explicitBrowser.browser !== 'vscode') {
    // If the model is going to use keyboard input for a specific browser, ensure focus.
    actions = prependBrowserFocusIfMissing(actions, explicitBrowser);
  }

  // If the user explicitly asked for a browser + URL, prefer a deterministic
  // keyboard-only browser flow for low-signal plans.
  if (requestedUrl && explicitBrowser?.browser && explicitBrowser.browser !== 'vscode') {
    const searchQuery = extractSearchQueryFromText(userMessage);
    const onlyLowSignal = actions.every((a) => ['bring_window_to_front', 'focus_window', 'key', 'wait', 'screenshot'].includes(a?.type));
    const tinyPlan = actions.length <= 2;
    if (tinyPlan || onlyLowSignal) {
      updateBrowserSessionState({
        url: requestedUrl,
        goalStatus: 'in_progress',
        lastStrategy: 'deterministic-browser-open-url',
        lastUserIntent: userMessage.trim().slice(0, 300)
      });
      return buildBrowserOpenUrlActions(explicitBrowser, requestedUrl, { searchQuery });
    }
  }

  if (requestedUrl && isVsCodeIntegratedBrowserRequest(userMessage)) {
    const onlyLowSignal = actions.every((a) => ['bring_window_to_front', 'focus_window', 'key', 'wait', 'screenshot'].includes(a?.type));
    const tinyPlan = actions.length <= 2;
    const isDetourScreenshotOnly = actions.length === 1 && actions[0]?.type === 'screenshot';
    const isDetourCommandPaletteOnly = actions.length === 1 && actions[0]?.type === 'key' && /^ctrl\+shift\+p$/i.test(String(actions[0]?.key || '').trim());
    const isDetourBringVsCodeOnly =
      actions.length === 1 &&
      actions[0]?.type === 'bring_window_to_front' &&
      typeof actions[0]?.title === 'string' &&
      /visual\s+studio\s+code/i.test(actions[0]?.title);

    if (tinyPlan || onlyLowSignal || isDetourScreenshotOnly || isDetourCommandPaletteOnly || isDetourBringVsCodeOnly) {
      updateBrowserSessionState({
        url: requestedUrl,
        goalStatus: 'in_progress',
        lastStrategy: 'deterministic-vscode-simple-browser',
        lastUserIntent: userMessage.trim().slice(0, 300)
      });
      return buildVsCodeSimpleBrowserOpenUrlActions(requestedUrl);
    }
  }

  // Heuristic: VS Code integrated browser attempts often look like:
  // click_element("Browser Preview") + ctrl+l + type URL.
  const clickPreview = actions.find(
    (a) =>
      a?.type === 'click_element' &&
      typeof a.text === 'string' &&
      /(browser\s*preview|live\s*preview|preview)/i.test(a.text)
  );
  const hasCtrlL = actions.some((a) => a?.type === 'key' && typeof a.key === 'string' && /^ctrl\+l$/i.test(a.key.trim()));
  const typedUrl = actions
    .filter((a) => a?.type === 'type' && typeof a.text === 'string')
    .map((a) => normalizeUrlCandidate(a.text))
    .find(Boolean);

  if (clickPreview && hasCtrlL && typedUrl) {
    updateBrowserSessionState({
      url: typedUrl,
      goalStatus: 'in_progress',
      lastStrategy: 'rewrite-preview-to-simple-browser',
      lastUserIntent: userMessage.trim().slice(0, 300)
    });
    // Rewrite to a keyboard-only VS Code Simple Browser flow.
    // This avoids UIA element discovery (webviews are often not exposed) and avoids screenshots.
    return [
      {
        type: 'bring_window_to_front',
        title: 'Visual Studio Code',
        processName: 'code',
        reason: 'Focus VS Code (required for integrated browser actions)'
      },
      { type: 'wait', ms: 600 },
      { type: 'key', key: 'ctrl+shift+p', reason: 'Open Command Palette' },
      { type: 'wait', ms: 300 },
      { type: 'type', text: 'Simple Browser: Show', reason: 'Open VS Code integrated Simple Browser' },
      { type: 'wait', ms: 150 },
      { type: 'key', key: 'enter', reason: 'Run Simple Browser: Show' },
      { type: 'wait', ms: 900 },
      { type: 'type', text: typedUrl, reason: 'Enter URL' },
      { type: 'key', key: 'enter', reason: 'Navigate' },
      { type: 'wait', ms: 3000 }
    ];
  }

  return actions;
}

const POST_ACTION_VERIFY_MAX_RETRIES = 2;
const POST_ACTION_VERIFY_SETTLE_MS = 900;
const POST_ACTION_VERIFY_POLL_INTERVAL_MS = 450;
const POST_ACTION_VERIFY_MAX_POLL_CYCLES = 8;
const POPUP_RECIPE_MAX_ACTIONS = 6;

function sleepMs(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function normalizeTextForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function inferLaunchVerificationTarget(actionData, userMessage = '') {
  const actions = Array.isArray(actionData?.actions) ? actionData.actions : [];
  const explicitHint = [...actions]
    .reverse()
    .map(a => a?.verifyTarget)
    .find(v => v && typeof v === 'object');

  const target = {
    appName: extractRequestedAppName(userMessage) || null,
    processNames: [],
    titleHints: [],
    popupKeywords: []
  };

  if (explicitHint) {
    if (typeof explicitHint.appName === 'string' && explicitHint.appName.trim()) {
      target.appName = explicitHint.appName.trim();
    }
    if (Array.isArray(explicitHint.processNames)) {
      target.processNames.push(...explicitHint.processNames.map(v => String(v || '').trim()).filter(Boolean));
    }
    if (Array.isArray(explicitHint.titleHints)) {
      target.titleHints.push(...explicitHint.titleHints.map(v => String(v || '').trim()).filter(Boolean));
    }
    if (Array.isArray(explicitHint.popupKeywords)) {
      target.popupKeywords.push(...explicitHint.popupKeywords.map(v => String(v || '').trim()).filter(Boolean));
    }
  }

  const focusAction = [...actions].reverse().find((a) =>
    a &&
    (a.type === 'bring_window_to_front' || a.type === 'focus_window') &&
    (typeof a.processName === 'string' || typeof a.title === 'string')
  );

  if (focusAction) {
    if (typeof focusAction.processName === 'string' && focusAction.processName.trim()) {
      target.processNames.push(focusAction.processName.trim());
    }
    if (typeof focusAction.title === 'string' && focusAction.title.trim()) {
      target.titleHints.push(focusAction.title.trim());
    }
  }

  if (!target.appName) {
    const hasWin = actions.some((a) => a?.type === 'key' && /^win$/i.test(String(a?.key || '').trim()));
    const hasEnter = actions.some((a) => a?.type === 'key' && /^enter$/i.test(String(a?.key || '').trim()));
    const typed = [...actions].reverse().find((a) => a?.type === 'type' && typeof a?.text === 'string' && a.text.trim().length > 0);
    if (hasWin && hasEnter && typed) {
      target.appName = typed.text.trim();
    }
  }

  if (target.appName) {
    target.processNames.push(...buildProcessCandidatesFromAppName(target.appName));
    target.titleHints.push(...buildTitleHintsFromAppName(target.appName));
  }

  target.processNames = Array.from(new Set(target.processNames.map(v => v.toLowerCase())));
  target.titleHints = Array.from(new Set(target.titleHints));
  target.popupKeywords = Array.from(new Set(target.popupKeywords.map(v => v.toLowerCase())));

  return target;
}

function isPostLaunchVerificationApplicable(actionData, userMessage = '') {
  const actions = Array.isArray(actionData?.actions) ? actionData.actions : [];
  if (!actions.length) return false;

  const target = inferLaunchVerificationTarget(actionData, userMessage);
  const hasTargetSignal = !!(target.appName || target.processNames.length || target.titleHints.length);
  if (!hasTargetSignal) return false;

  return actions.some((a) => {
    if (!a || typeof a !== 'object') return false;
    if (a.type === 'bring_window_to_front' || a.type === 'focus_window') return true;
    if (a.type === 'key') {
      const k = String(a.key || '').trim().toLowerCase();
      return k === 'win' || k === 'enter';
    }
    return false;
  });
}

function evaluateForegroundAgainstTarget(foreground, target) {
  if (!foreground || !foreground.success) {
    return { matched: false, matchReason: 'no-foreground', needsFollowUp: false, popupHint: null };
  }

  const proc = normalizeTextForMatch(foreground.processName || '');
  const title = String(foreground.title || '');
  const titleNorm = normalizeTextForMatch(title);
  const haystack = `${proc} ${titleNorm}`.trim();
  const popupWords = Array.isArray(target.popupKeywords) && target.popupKeywords.length
    ? target.popupKeywords
    : ['license', 'activation', 'signin', 'login', 'update', 'setup', 'installer', 'warning', 'permission', 'eula', 'project', 'new project', 'open project', 'workspace'];

  const hasPopupKeyword = popupWords.some(word => word && titleNorm.includes(normalizeTextForMatch(word)));

  const withFollowUp = (matched, matchReason) => ({
    matched,
    matchReason,
    needsFollowUp: !!(matched && hasPopupKeyword),
    popupHint: hasPopupKeyword ? title : null
  });

  for (const processName of target.processNames || []) {
    const expectedProc = normalizeTextForMatch(processName);
    if (expectedProc && proc.includes(expectedProc)) {
      return withFollowUp(true, 'process');
    }
  }

  for (const hint of target.titleHints || []) {
    const raw = String(hint || '').trim();
    if (!raw) continue;
    if (/^re:/i.test(raw)) {
      try {
        const re = new RegExp(raw.slice(3), 'i');
        if (re.test(title)) {
          return withFollowUp(true, 'title-regex');
        }
      } catch {
        // Ignore invalid regex; fallback to plain contains.
      }
    }
    const expectedTitle = normalizeTextForMatch(raw.replace(/^re:/i, ''));
    if (expectedTitle && titleNorm.includes(expectedTitle)) {
      return withFollowUp(true, 'title');
    }
  }

  if (target.appName) {
    const tokens = normalizeTextForMatch(target.appName)
      .split(' ')
      .map(t => t.trim())
      .filter(Boolean);
    const strongTokens = tokens.filter(t => t.length >= 3);
    const checks = strongTokens.length ? strongTokens : tokens;
    if (checks.length && checks.some(t => haystack.includes(t))) {
      return withFollowUp(true, 'app-name');
    }
  }

  return withFollowUp(false, 'none');
}

function buildPostLaunchSelfHealPlans(target, runtime = {}) {
  const plans = [];
  const hasRunningCandidates = !!runtime.hasRunningCandidates;

  const preferredProcess = Array.isArray(target.processNames) && target.processNames.length
    ? target.processNames[0]
    : null;
  const preferredTitle = Array.isArray(target.titleHints) && target.titleHints.length
    ? target.titleHints[0]
    : null;

  // First try to focus existing running window to avoid accidental re-launch.
  if (preferredProcess || preferredTitle) {
    plans.push([
      {
        type: 'bring_window_to_front',
        title: preferredTitle || undefined,
        processName: preferredProcess || undefined,
        reason: 'Self-heal: focus already running target window'
      },
      { type: 'wait', ms: 750 }
    ]);
  }

  // Only relaunch when no matching process appears to be running.
  if (target.appName && !hasRunningCandidates) {
    plans.push(buildOpenApplicationActions(target.appName));
  }

  return plans;
}

function normalizeProcessName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\.exe$/i, '')
    .replace(/[^a-z0-9]+/g, '');
}

function isLikelyInstallerProcess(name) {
  const n = String(name || '').toLowerCase();
  return /setup|installer|install|update|bootstrap|unins/.test(n);
}

function matchesAnyProcessName(procName, expected = []) {
  const actual = normalizeProcessName(procName);
  if (!actual) return false;
  return (Array.isArray(expected) ? expected : []).some((candidate) => {
    const wanted = normalizeProcessName(candidate);
    return wanted && (actual === wanted || actual.startsWith(wanted) || wanted.startsWith(actual));
  });
}

async function getRunningTargetProcesses(target) {
  if (!target || !Array.isArray(target.processNames) || !target.processNames.length) {
    return [];
  }

  if (typeof systemAutomation.getRunningProcessesByNames !== 'function') {
    return [];
  }

  try {
    const list = await systemAutomation.getRunningProcessesByNames(target.processNames);
    if (!Array.isArray(list)) return [];
    return list.filter((item) => {
      if (!matchesAnyProcessName(item?.processName, target.processNames)) return false;
      return !isLikelyInstallerProcess(item?.processName);
    });
  } catch {
    return [];
  }
}

async function pollForegroundForTarget(target, maxCycles = POST_ACTION_VERIFY_MAX_POLL_CYCLES) {
  const cycles = Math.max(0, Number(maxCycles) || 0);
  let foreground = null;
  let evalResult = { matched: false, matchReason: 'none', needsFollowUp: false, popupHint: null };

  for (let i = 1; i <= cycles; i++) {
    await sleepMs(POST_ACTION_VERIFY_POLL_INTERVAL_MS);
    foreground = await systemAutomation.getForegroundWindowInfo();
    evalResult = evaluateForegroundAgainstTarget(foreground, target);
    if (evalResult.matched) {
      return {
        matched: true,
        cyclesUsed: i,
        foreground,
        evalResult
      };
    }
  }

  return {
    matched: false,
    cyclesUsed: cycles,
    foreground,
    evalResult
  };
}

function buildPopupFollowUpRecipe(target) {
  return buildPopupFollowUpRecipeSelection(target, '');
}

const POPUP_RECIPE_LIBRARY = [
  {
    id: 'generic-license-consent',
    titlePatterns: [/license|eula|terms|agreement|consent/i],
    appPatterns: [],
    buttons: ['Accept', 'I Agree', 'Agree', 'Accept & Continue', 'Continue', 'OK']
  },
  {
    id: 'generic-permissions',
    titlePatterns: [/permission|allow|security|access|control/i],
    appPatterns: [],
    buttons: ['Allow', 'Grant', 'Enable', 'Yes', 'Continue', 'OK']
  },
  {
    id: 'generic-update-setup',
    titlePatterns: [/setup|configuration|update|first\s*run|welcome/i],
    appPatterns: [],
    buttons: ['Next', 'Continue', 'Skip', 'Not now', 'Finish', 'Launch']
  },
  {
    id: 'mpc-first-launch',
    titlePatterns: [/mpc|model\s*context|first\s*run|setup|welcome|license/i],
    appPatterns: [/\bmpc\b/i, /model\s*context/i],
    buttons: ['Accept', 'I Agree', 'Continue', 'Next', 'Launch', 'OK']
  }
];

function buildRecipeActionsFromButtons(buttons, recipeId) {
  const uniqueButtons = Array.from(new Set((Array.isArray(buttons) ? buttons : [])
    .map((b) => String(b || '').trim())
    .filter(Boolean)));

  const actions = [
    { type: 'wait', ms: 550, reason: `Allow popup to render (${recipeId})` },
    ...uniqueButtons.map((text) => ({
      type: 'click_element',
      text,
      continue_on_error: true,
      reason: `Popup follow-up (${recipeId})`
    }))
  ];

  return actions.slice(0, POPUP_RECIPE_MAX_ACTIONS);
}

function recipeMatchesContext(rule, appNorm, popupTitleNorm) {
  if (!rule) return false;
  const titlePatterns = Array.isArray(rule.titlePatterns) ? rule.titlePatterns : [];
  const appPatterns = Array.isArray(rule.appPatterns) ? rule.appPatterns : [];

  const titleMatch = titlePatterns.length
    ? titlePatterns.some((re) => re && re.test(popupTitleNorm))
    : false;
  const appMatch = appPatterns.length
    ? appPatterns.some((re) => re && re.test(appNorm))
    : false;

  // Prefer title-keyed matching; app-specific rules can still trigger by app match.
  return titleMatch || appMatch;
}

function scoreRecipeMatch(rule, appNorm, popupTitleNorm) {
  const titlePatterns = Array.isArray(rule?.titlePatterns) ? rule.titlePatterns : [];
  const appPatterns = Array.isArray(rule?.appPatterns) ? rule.appPatterns : [];
  const titleHit = titlePatterns.some((re) => re && re.test(popupTitleNorm));
  const appHit = appPatterns.some((re) => re && re.test(appNorm));

  // Higher score means more specific signal. App-specific matches outrank generic.
  return (appHit ? 10 : 0) + (titleHit ? 3 : 0);
}

function buildPopupFollowUpRecipeSelection(target, popupTitle = '') {
  const appNorm = normalizeTextForMatch(target?.appName || '');
  const popupTitleNorm = normalizeTextForMatch(popupTitle || '');

  const matched = POPUP_RECIPE_LIBRARY
    .filter((rule) => recipeMatchesContext(rule, appNorm, popupTitleNorm))
    .sort((a, b) => scoreRecipeMatch(b, appNorm, popupTitleNorm) - scoreRecipeMatch(a, appNorm, popupTitleNorm));

  // Fallback to generic consent flow if we know a popup exists but no specialized rule matched.
  const selected = matched.length ? matched[0] : {
    id: 'generic-fallback',
    buttons: ['Continue', 'OK', 'Yes']
  };

  return {
    recipeId: selected.id,
    actions: buildRecipeActionsFromButtons(selected.buttons, selected.id)
  };
}

async function executePopupFollowUpRecipe(target, actionExecutor, popupTitle = '') {
  const selection = buildPopupFollowUpRecipeSelection(target, popupTitle);
  const recipe = selection.actions;
  if (!recipe.length) {
    return { attempted: false, completed: false, steps: 0, recipeId: selection.recipeId };
  }

  let steps = 0;
  for (const action of recipe) {
    steps++;
    const result = await (actionExecutor ? actionExecutor(action) : systemAutomation.executeAction(action));
    if (!result?.success && !action.continue_on_error) {
      return { attempted: true, completed: false, steps, recipeId: selection.recipeId };
    }
  }

  return { attempted: true, completed: true, steps, recipeId: selection.recipeId };
}

async function verifyAndSelfHealPostActions(actionData, options = {}) {
  const userMessage = typeof options.userMessage === 'string' ? options.userMessage : '';
  const actionExecutor = options.actionExecutor;
  const enablePopupRecipes = !!options.enablePopupRecipes;

  if (!isPostLaunchVerificationApplicable(actionData, userMessage)) {
    return { applicable: false, verified: true, healed: false, attempts: 0 };
  }

  const target = inferLaunchVerificationTarget(actionData, userMessage);
  let runningProcesses = await getRunningTargetProcesses(target);
  let foreground = await systemAutomation.getForegroundWindowInfo();
  const initialEval = evaluateForegroundAgainstTarget(foreground, target);
  if (initialEval.matched) {
    const base = {
      applicable: true,
      verified: true,
      healed: false,
      attempts: 0,
      target,
      foreground,
      runningProcesses,
      runningPids: runningProcesses.map((p) => p.pid).filter(Number.isFinite),
      needsFollowUp: initialEval.needsFollowUp,
      popupHint: initialEval.popupHint,
      matchReason: initialEval.matchReason
    };

    if (enablePopupRecipes && initialEval.needsFollowUp) {
      const followUp = await executePopupFollowUpRecipe(target, actionExecutor, initialEval.popupHint || '');
      if (followUp.attempted) {
        await sleepMs(POST_ACTION_VERIFY_SETTLE_MS);
        const fgAfterFollowUp = await systemAutomation.getForegroundWindowInfo();
        const evalAfterFollowUp = evaluateForegroundAgainstTarget(fgAfterFollowUp, target);
        return {
          ...base,
          foreground: fgAfterFollowUp,
          popupRecipe: {
            enabled: true,
            attempted: followUp.attempted,
            completed: followUp.completed,
            steps: followUp.steps,
            recipeId: followUp.recipeId
          },
          needsFollowUp: evalAfterFollowUp.needsFollowUp,
          popupHint: evalAfterFollowUp.popupHint,
          matchReason: evalAfterFollowUp.matchReason
        };
      }
    }

    return base;
  }

  // If process exists, poll before retrying to avoid duplicate app launches.
  if (runningProcesses.length) {
    const polled = await pollForegroundForTarget(target, POST_ACTION_VERIFY_MAX_POLL_CYCLES);
    foreground = polled.foreground || foreground;
    if (polled.matched) {
      return {
        applicable: true,
        verified: true,
        healed: false,
        attempts: 0,
        pollCyclesUsed: polled.cyclesUsed,
        target,
        foreground,
        runningProcesses,
        runningPids: runningProcesses.map((p) => p.pid).filter(Number.isFinite),
        needsFollowUp: polled.evalResult.needsFollowUp,
        popupHint: polled.evalResult.popupHint,
        matchReason: polled.evalResult.matchReason
      };
    }
  }

  const recoveryPlans = buildPostLaunchSelfHealPlans(target, {
    hasRunningCandidates: runningProcesses.length > 0
  });
  if (!recoveryPlans.length) {
    const lastEval = evaluateForegroundAgainstTarget(foreground, target);
    return {
      applicable: true,
      verified: false,
      healed: false,
      attempts: 0,
      target,
      foreground,
      runningProcesses,
      runningPids: runningProcesses.map((p) => p.pid).filter(Number.isFinite),
      needsFollowUp: lastEval.needsFollowUp,
      popupHint: lastEval.popupHint,
      matchReason: lastEval.matchReason
    };
  }

  for (let attempt = 1; attempt <= POST_ACTION_VERIFY_MAX_RETRIES; attempt++) {
    console.log(`[AI-SERVICE] Post-action verification retry ${attempt}/${POST_ACTION_VERIFY_MAX_RETRIES}`);
    let sequenceOk = true;
    const plan = recoveryPlans[Math.min(attempt - 1, recoveryPlans.length - 1)] || [];

    for (const action of plan) {
      const result = await (actionExecutor ? actionExecutor(action) : systemAutomation.executeAction(action));
      if (!result?.success && !action.continue_on_error) {
        sequenceOk = false;
        break;
      }
    }

    if (!sequenceOk) {
      await sleepMs(250);
      continue;
    }

    await sleepMs(POST_ACTION_VERIFY_SETTLE_MS + (attempt * 150));
    runningProcesses = await getRunningTargetProcesses(target);
    foreground = await systemAutomation.getForegroundWindowInfo();
    const evalResult = evaluateForegroundAgainstTarget(foreground, target);
    if (evalResult.matched) {
      const base = {
        applicable: true,
        verified: true,
        healed: true,
        attempts: attempt,
        target,
        foreground,
        runningProcesses,
        runningPids: runningProcesses.map((p) => p.pid).filter(Number.isFinite),
        needsFollowUp: evalResult.needsFollowUp,
        popupHint: evalResult.popupHint,
        matchReason: evalResult.matchReason
      };

      if (enablePopupRecipes && evalResult.needsFollowUp) {
        const followUp = await executePopupFollowUpRecipe(target, actionExecutor, evalResult.popupHint || '');
        if (followUp.attempted) {
          await sleepMs(POST_ACTION_VERIFY_SETTLE_MS);
          const fgAfterFollowUp = await systemAutomation.getForegroundWindowInfo();
          const evalAfterFollowUp = evaluateForegroundAgainstTarget(fgAfterFollowUp, target);
          return {
            ...base,
            foreground: fgAfterFollowUp,
            popupRecipe: {
              enabled: true,
              attempted: followUp.attempted,
              completed: followUp.completed,
              steps: followUp.steps,
              recipeId: followUp.recipeId
            },
            needsFollowUp: evalAfterFollowUp.needsFollowUp,
            popupHint: evalAfterFollowUp.popupHint,
            matchReason: evalAfterFollowUp.matchReason
          };
        }
      }

      return base;
    }
  }

  runningProcesses = await getRunningTargetProcesses(target);
  const finalEval = evaluateForegroundAgainstTarget(foreground, target);
  return {
    applicable: true,
    verified: false,
    healed: false,
    attempts: POST_ACTION_VERIFY_MAX_RETRIES,
    target,
    foreground,
    runningProcesses,
    runningPids: runningProcesses.map((p) => p.pid).filter(Number.isFinite),
    needsFollowUp: finalEval.needsFollowUp,
    popupHint: finalEval.popupHint,
    matchReason: finalEval.matchReason
  };
}

/**
 * Execute actions from AI response with safety checks
 * @param {Object} actionData - Parsed action data with actions array
 * @param {Function} onAction - Callback after each action
 * @param {Function} onScreenshot - Callback when screenshot is needed
 * @param {Object} options - Additional options
 * @param {Function} options.onRequireConfirmation - Callback when action needs user confirmation
 * @param {Object} options.targetAnalysis - Visual analysis of click targets
 * @returns {Object} Execution results
 */
async function executeActions(actionData, onAction = null, onScreenshot = null, options = {}) {
  if (!actionData || !actionData.actions || !Array.isArray(actionData.actions)) {
    return { success: false, error: 'No valid actions provided' };
  }

  const {
    onRequireConfirmation,
    targetAnalysis = {},
    actionExecutor,
    skipSafetyConfirmation = false,
    userMessage,
    enablePopupRecipes = false
  } = options;

  console.log('[AI-SERVICE] Executing actions:', actionData.thought || 'No thought provided');
  const preflighted = preflightActions(actionData, { userMessage });
  if (preflighted !== actionData) {
    actionData = preflighted;
    console.log('[AI-SERVICE] Actions rewritten for reliability');
  }
  console.log('[AI-SERVICE] Actions:', JSON.stringify(actionData.actions, null, 2));

  const results = [];
  let screenshotRequested = false;
  let pendingConfirmation = false;
  let lastTargetWindowHandle = null;
  let postVerification = { applicable: false, verified: true, healed: false, attempts: 0 };

  for (let i = 0; i < actionData.actions.length; i++) {
    const action = actionData.actions[i];

    // Track the intended target window across steps so later key/type actions can
    // re-focus it. Without this, focus can drift back to the overlay/terminal.
    if (action.type === 'focus_window' || action.type === 'bring_window_to_front') {
      try {
        const hwnd = await systemAutomation.resolveWindowHandle(action);
        if (hwnd) {
          lastTargetWindowHandle = hwnd;
        }
      } catch {}
    }
    
    // Handle screenshot requests specially
    if (action.type === 'screenshot') {
      screenshotRequested = true;
      if (onScreenshot) {
        await onScreenshot();
      }
      results.push({ success: true, action: 'screenshot', message: 'Screenshot captured' });
      continue;
    }

    // ===== SAFETY CHECK =====
    // Get target info if available (from visual analysis)
    const targetInfo = targetAnalysis[`${action.x},${action.y}`] || {
      text: action.reason || '',
      buttonText: action.targetText || '',
      nearbyText: []
    };
    
    // Analyze safety
    const safety = analyzeActionSafety(action, targetInfo);
    console.log(`[AI-SERVICE] Action ${i} safety: ${safety.riskLevel}`, safety.warnings);

    // CRITICAL actions require an explicit confirmation step, even if the user clicked
    // the general "Execute" button for a batch. This prevents accidental destructive
    // shortcuts (e.g., alt+f4) from immediately closing the active app due to focus issues.
    const canBypassConfirmation = skipSafetyConfirmation && safety.riskLevel !== ActionRiskLevel.CRITICAL;
    
    // If HIGH or CRITICAL risk, require confirmation (unless user already confirmed via Execute button)
    if (safety.requiresConfirmation && !canBypassConfirmation) {
      console.log(`[AI-SERVICE] Action ${i} requires user confirmation`);
      
      // Store as pending action
      setPendingAction({
        ...safety,
        actionIndex: i,
        remainingActions: actionData.actions.slice(i),
        completedResults: [...results],
        thought: actionData.thought,
        verification: actionData.verification
      });
      
      // Notify via callback
      if (onRequireConfirmation) {
        onRequireConfirmation(safety);
      }
      
      pendingConfirmation = true;
      break; // Stop execution, wait for confirmation
    }
    
    if (skipSafetyConfirmation && safety.requiresConfirmation) {
      if (canBypassConfirmation) {
        console.log(`[AI-SERVICE] Action ${i} safety bypassed (user pre-confirmed via Execute button)`);
      } else {
        console.log(`[AI-SERVICE] Action ${i} requires explicit confirmation (CRITICAL)`);
      }
    }

    // Execute the action (SAFE/LOW/MEDIUM risk)
    // AUTO-FOCUS: Check if this is an interaction that requires window focus (click/type)
    // and if the target window is in the background.
    if ((action.type === 'click' || action.type === 'double_click' || action.type === 'right_click') && action.x !== undefined) {
      if (uiWatcher && uiWatcher.isPolling) {
        const elementAtPoint = uiWatcher.getElementAtPoint(action.x, action.y);
        if (elementAtPoint && elementAtPoint.windowHandle) {
          lastTargetWindowHandle = elementAtPoint.windowHandle;
          // Found an element with a known window handle
          // Focus it first to ensure click goes to the right window (not trapped by overlay or obscuring window)
          // We can call systemAutomation.focusWindow directly
          console.log(`[AI-SERVICE] Auto-focusing window handle ${elementAtPoint.windowHandle} for click at (${action.x}, ${action.y})`);
          await systemAutomation.focusWindow(elementAtPoint.windowHandle);
          await new Promise(r => setTimeout(r, 450)); // Wait for window animation/focus settling
        }
      }
    }

    // Ensure keyboard input goes to the last known target window.
    if ((action.type === 'key' || action.type === 'type') && lastTargetWindowHandle) {
      console.log(`[AI-SERVICE] Re-focusing last target window ${lastTargetWindowHandle} before ${action.type}`);
      await systemAutomation.focusWindow(lastTargetWindowHandle);
      await new Promise(r => setTimeout(r, 125));
    }

    const result = await (actionExecutor ? actionExecutor(action) : systemAutomation.executeAction(action));
    result.reason = action.reason || '';
    result.safety = safety;
    results.push(result);

    // If we just performed a step that likely changed focus, snapshot the actual foreground HWND.
    // This is especially important when uiWatcher isn't polling (can't infer windowHandle).
    if (typeof systemAutomation.getForegroundWindowHandle === 'function') {
      if (
        action.type === 'click' ||
        action.type === 'double_click' ||
        action.type === 'right_click' ||
        action.type === 'focus_window' ||
        action.type === 'bring_window_to_front'
      ) {
        const fg = await systemAutomation.getForegroundWindowHandle();
        if (fg) {
          lastTargetWindowHandle = fg;
        }
      }
    }

    // Callback for UI updates
    if (onAction) {
      onAction(result, i, actionData.actions.length);
    }

    // Stop on failure unless action specifies continue_on_error
    if (!result.success && !action.continue_on_error) {
      console.log(`[AI-SERVICE] Sequence stopped at action ${i} due to error`);
      break;
    }
  }

  let success = !pendingConfirmation && results.every(r => r.success);
  let error = null;

  if (success && !pendingConfirmation) {
    postVerification = await verifyAndSelfHealPostActions(actionData, {
      userMessage,
      actionExecutor,
      enablePopupRecipes
    });
    if (postVerification.applicable && !postVerification.verified) {
      error = 'Post-action verification could not confirm target after bounded retries';
    }
  }

  if (!success && !error && !pendingConfirmation) {
    error = 'One or more actions failed';
  }

  updateBrowserSessionAfterExecution(actionData, {
    success: success && !error,
    results,
    postVerification,
    userMessage
  });

  return {
    success,
    thought: actionData.thought,
    verification: actionData.verification,
    results,
    error,
    screenshotRequested,
    postVerification,
    postVerificationFailed: !!(postVerification.applicable && !postVerification.verified),
    pendingConfirmation,
    pendingActionId: pendingConfirmation ? getPendingAction()?.actionId : null
  };
}

/**
 * Resume execution after user confirms pending action
 * @param {Function} onAction - Callback after each action
 * @param {Function} onScreenshot - Callback when screenshot is needed
 * @returns {Object} Execution results
 */
async function resumeAfterConfirmation(onAction = null, onScreenshot = null, options = {}) {
  const pending = getPendingAction();
  if (!pending) {
    return { success: false, error: 'No pending action to resume' };
  }
  
  const { actionExecutor, userMessage, enablePopupRecipes = false } = options;
  
  console.log('[AI-SERVICE] Resuming after user confirmation');

  // Apply the same reliability rewrites on resume, so we don't get stuck
  // if the remaining actions include brittle UIA clicks or screenshot detours.
  if (Array.isArray(pending.remainingActions) && pending.remainingActions.length > 0) {
    const original = pending.remainingActions;
    pending.remainingActions = rewriteActionsForReliability(pending.remainingActions, { userMessage });
    if (pending.remainingActions !== original) {
      console.log('[AI-SERVICE] (resume) Actions rewritten for reliability');
    }
  }
  
  const results = [...pending.completedResults];
  let screenshotRequested = false;
  let lastTargetWindowHandle = null;
  let postVerification = { applicable: false, verified: true, healed: false, attempts: 0 };
  
  // Execute the confirmed action and remaining actions
  for (let i = 0; i < pending.remainingActions.length; i++) {
    const action = pending.remainingActions[i];

    if (action.type === 'focus_window' || action.type === 'bring_window_to_front') {
      try {
        const hwnd = await systemAutomation.resolveWindowHandle(action);
        if (hwnd) {
          lastTargetWindowHandle = hwnd;
        }
      } catch {}
    }
    
    if (action.type === 'screenshot') {
      screenshotRequested = true;
      if (onScreenshot) {
        await onScreenshot();
      }
      results.push({ success: true, action: 'screenshot', message: 'Screenshot captured' });
      continue;
    }

    if ((action.type === 'click' || action.type === 'double_click' || action.type === 'right_click') && action.x !== undefined) {
      if (uiWatcher && uiWatcher.isPolling) {
        const elementAtPoint = uiWatcher.getElementAtPoint(action.x, action.y);
        if (elementAtPoint && elementAtPoint.windowHandle) {
          lastTargetWindowHandle = elementAtPoint.windowHandle;
          console.log(`[AI-SERVICE] (resume) Auto-focusing window handle ${elementAtPoint.windowHandle} for click at (${action.x}, ${action.y})`);
          await systemAutomation.focusWindow(elementAtPoint.windowHandle);
          await new Promise(r => setTimeout(r, 450));
        }
      }
    }

    if ((action.type === 'key' || action.type === 'type') && lastTargetWindowHandle) {
      console.log(`[AI-SERVICE] (resume) Re-focusing last target window ${lastTargetWindowHandle} before ${action.type}`);
      await systemAutomation.focusWindow(lastTargetWindowHandle);
      await new Promise(r => setTimeout(r, 125));
    }
    
    // Execute action (user confirmed, skip safety for first action)
    const result = await (actionExecutor ? actionExecutor(action) : systemAutomation.executeAction(action));
    result.reason = action.reason || '';
    result.userConfirmed = i === 0; // First one was confirmed
    results.push(result);

    if (typeof systemAutomation.getForegroundWindowHandle === 'function') {
      if (
        action.type === 'click' ||
        action.type === 'double_click' ||
        action.type === 'right_click' ||
        action.type === 'focus_window' ||
        action.type === 'bring_window_to_front'
      ) {
        const fg = await systemAutomation.getForegroundWindowHandle();
        if (fg) {
          lastTargetWindowHandle = fg;
        }
      }
    }
    
    if (onAction) {
      onAction(result, pending.actionIndex + i, pending.actionIndex + pending.remainingActions.length);
    }
    
    if (!result.success && !action.continue_on_error) {
      break;
    }
  }
  
  clearPendingAction();

  let success = results.every(r => r.success);
  let error = null;

  if (success) {
    postVerification = await verifyAndSelfHealPostActions(
      { actions: pending.remainingActions || [] },
      { userMessage, actionExecutor, enablePopupRecipes }
    );
    if (postVerification.applicable && !postVerification.verified) {
      error = 'Post-action verification could not confirm target after bounded retries';
    }
  }

  if (!success && !error) {
    error = 'One or more actions failed';
  }

  updateBrowserSessionAfterExecution({ actions: pending.remainingActions || [] }, {
    success: success && !error,
    results,
    postVerification,
    userMessage
  });
  
  return {
    success,
    thought: pending.thought,
    verification: pending.verification,
    results,
    error,
    screenshotRequested,
    postVerification,
    postVerificationFailed: !!(postVerification.applicable && !postVerification.verified),
    userConfirmed: true
  };
}

/**
 * Convert grid coordinate to pixel position
 */
function gridToPixels(coord) {
  return systemAutomation.gridToPixels(coord);
}

module.exports = {
  setProvider,
  setApiKey,
  setCopilotModel,
  getCopilotModels,
  discoverCopilotModels,
  getCurrentCopilotModel,
  getModelMetadata,
  addVisualContext,
  getLatestVisualContext,
  clearVisualContext,
  sendMessage,
  handleCommand,
  getStatus,
  startCopilotOAuth,
  setOAuthCallback,
  loadCopilotToken,
  AI_PROVIDERS,
  COPILOT_MODELS,
  // Agentic capabilities
  parseActions,
  hasActions,
  preflightActions,
  // Teach UX
  parsePreferenceCorrection,
  executeActions,
  gridToPixels,
  systemAutomation,
  // Safety guardrails
  ActionRiskLevel,
  analyzeActionSafety,
  describeAction,
  setPendingAction,
  getPendingAction,
  clearPendingAction,
  confirmPendingAction,
  rejectPendingAction,
  resumeAfterConfirmation,
  // UI awareness
  setUIWatcher,
  getUIWatcher,
  setSemanticDOMSnapshot,
  clearSemanticDOMSnapshot,
  // Tool-calling
  LIKU_TOOLS,
  toolCallsToActions
};
