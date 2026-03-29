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

function isQuietChatTranscript() {
  return process.env.LIKU_CHAT_TRANSCRIPT_QUIET === '1';
}

function chatDebugLog(...args) {
  if (!isQuietChatTranscript()) {
    console.log(...args);
  }
}

// `ai-service` is used by the Electron app *and* by the CLI.
// When running in CLI-only mode, Electron may not be available.
let shell;
try {
  ({ shell } = require('electron'));
} catch {
  shell = {
    openExternal: async (url) => {
      chatDebugLog('[AI] Open this URL in your browser:', url);
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
  checkNegativePolicies,
  formatActionPolicyViolationSystemMessage,
  formatNegativePolicyViolationSystemMessage
} = require('./ai-service/policy-enforcement');
const { LIKU_TOOLS, toolCallsToActions, getToolDefinitions } = require('./ai-service/providers/copilot/tools');
const { parseCopilotChatResponse } = require('./ai-service/providers/copilot/chat-response');
const { shouldAutoContinueResponse } = require('./ai-service/response-heuristics');
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
  clearChatContinuityState,
  formatChatContinuityContext,
  clearSessionIntentState,
  formatSessionIntentContext,
  formatSessionIntentSummary,
  getChatContinuityState,
  getSessionIntentState,
  ingestUserIntentState,
  recordChatContinuityTurn
} = require('./session-intent-state');
const {
  buildOpenApplicationActions,
  buildProcessCandidatesFromAppName,
  buildTitleHintsFromAppName,
  buildVerifyTargetHintFromAppName,
  resolveNormalizedAppIdentity
} = require('./tradingview/app-profile');
const {
  detectTradingViewDomainActionRisk,
  extractTradingViewObservationKeywords,
  inferTradingViewTradingMode,
  inferTradingViewObservationSpec,
  isTradingViewTargetHint
} = require('./tradingview/verification');
const {
  maybeRewriteTradingViewIndicatorWorkflow
} = require('./tradingview/indicator-workflows');
const {
  maybeRewriteTradingViewAlertWorkflow
} = require('./tradingview/alert-workflows');
const {
  maybeRewriteTradingViewTimeframeWorkflow,
  maybeRewriteTradingViewSymbolWorkflow,
  maybeRewriteTradingViewWatchlistWorkflow
} = require('./tradingview/chart-verification');
const {
  maybeRewriteTradingViewDrawingWorkflow
} = require('./tradingview/drawing-workflows');
const {
  buildTradingViewPineResumePrerequisites,
  maybeRewriteTradingViewPineWorkflow
} = require('./tradingview/pine-workflows');
const {
  maybeRewriteTradingViewPaperWorkflow
} = require('./tradingview/paper-workflows');
const {
  maybeRewriteTradingViewDomWorkflow
} = require('./tradingview/dom-workflows');
const {
  createObservationCheckpointRuntime
} = require('./ai-service/observation-checkpoints');
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
const skillRouter = require('./memory/skill-router');
const memoryStore = require('./memory/memory-store');
const reflectionTrigger = require('./telemetry/reflection-trigger');
const { runPreToolUseHook, runPostToolUseHook } = require('./tools/hook-runner');

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

let lastSkillSelection = {
  ids: [],
  query: '',
  currentProcessName: null,
  currentWindowTitle: null,
  currentWindowKind: null,
  currentUrlHost: null,
  selectedAt: 0
};

// ===== CONFIGURATION =====

// GitHub Copilot OAuth Configuration
const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const GITHUB_API_HOST = 'api.github.com';
const COPILOT_CHAT_HOST = 'api.individual.githubcopilot.com';
const COPILOT_ALT_CHAT_HOST = 'copilot-proxy.githubusercontent.com';
const COPILOT_TOKEN_PATH = '/copilot_internal/v2/token';
const COPILOT_CHAT_PATH = '/chat/completions';
let preferredCopilotChatHost = COPILOT_CHAT_HOST;
let sessionApiHost = null; // Populated from session token endpoints.api

// Current configuration
const providerRegistry = createProviderRegistry(process.env);
const {
  AI_PROVIDERS,
  apiKeys,
  getCurrentProvider,
  setApiKey: setProviderApiKey,
  setProvider: setActiveProvider
} = providerRegistry;

// Token persistence path — lives inside ~/.liku/
const { LIKU_HOME, ensureLikuStructure, migrateIfNeeded } = require('../shared/liku-home');

// Bootstrap home directory on module load
ensureLikuStructure();
migrateIfNeeded();
const TOKEN_FILE = path.join(LIKU_HOME, 'copilot-token.json');

// OAuth state
let oauthInProgress = false;
let oauthCallback = null;

// Conversation history for context
const MAX_HISTORY = 20;
const HISTORY_FILE = path.join(LIKU_HOME, 'conversation-history.json');
const MODEL_PREF_FILE = path.join(LIKU_HOME, 'model-preference.json');
const MODEL_RUNTIME_FILE = path.join(LIKU_HOME, 'copilot-runtime-state.json');

const copilotModelRegistry = createCopilotModelRegistry({
  likuHome: LIKU_HOME,
  modelPrefFile: MODEL_PREF_FILE,
  runtimeStateFile: MODEL_RUNTIME_FILE,
  initialProvider: getCurrentProvider()
});
const {
  COPILOT_MODELS,
  discoverCopilotModels: discoverCopilotModelsFromRegistry,
  getCopilotModels: getCopilotModelsFromRegistry,
  getCurrentCopilotModel: getCurrentCopilotModelFromRegistry,
  getRuntimeSelection,
  getValidatedChatFallback,
  loadModelPreference,
  modelRegistry,
  recordRuntimeSelection,
  rememberValidatedChatFallback,
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
    getCopilotSessionToken: () => apiKeys.copilotSession,
    getSessionApiHost: () => sessionApiHost
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
  clearChatContinuityState,
  exchangeForCopilotSession,
  getCopilotModels,
  getChatContinuityState,
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
  clearSessionIntentState,
  getSessionIntentState,
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
  const mergedOptions = { ...(options || {}) };
  try {
    const sessionState = getSessionIntentState({ cwd: process.cwd() });
    if (!(typeof mergedOptions.sessionIntentContext === 'string' && mergedOptions.sessionIntentContext.trim())) {
      mergedOptions.sessionIntentContext = formatSessionIntentContext(sessionState) || '';
    }
    if (!(typeof mergedOptions.chatContinuityContext === 'string' && mergedOptions.chatContinuityContext.trim())) {
      mergedOptions.chatContinuityContext = formatChatContinuityContext(sessionState, { userMessage }) || '';
    }
  } catch {}
  return messageBuilder.buildMessages(userMessage, includeVisual, mergedOptions);
}

function getCopilotModelCapabilities(modelKey) {
  const entry = modelRegistry()[modelKey] || {};
  return entry.capabilities || {
    chat: true,
    tools: !!entry.vision,
    vision: !!entry.vision,
    reasoning: /^o(1|3)/i.test(String(entry.id || modelKey || '')),
    completion: false,
    automation: !!entry.vision,
    planning: !!entry.vision || /^o(1|3)/i.test(String(entry.id || modelKey || ''))
  };
}

function supportsCopilotCapability(modelKey, capability) {
  return !!getCopilotModelCapabilities(modelKey)[capability];
}

function parseInlineIntentTags(userMessage) {
  const detectedTags = [];
  const tagPattern = /\((vs code|browser|plan|research)\)/ig;
  const cleanedMessage = String(userMessage || '')
    .replace(tagPattern, (_match, tag) => {
      detectedTags.push(String(tag || '').trim().toLowerCase());
      return ' ';
    })
    .replace(/\s{2,}/g, ' ')
    .trim();

  const extraSystemMessages = [];
  if (detectedTags.includes('vs code')) {
    extraSystemMessages.push('CONTEXT DIRECTIVE: Focus on VS Code workspace tasks, file edits, and editor-safe operations.');
  }
  if (detectedTags.includes('browser')) {
    extraSystemMessages.push('CONTEXT DIRECTIVE: Treat this as a browser automation task. Verify the browser window before sending input.');
  }
  if (detectedTags.includes('research')) {
    extraSystemMessages.push('CONTEXT DIRECTIVE: Answer in research mode. Prefer findings and options. Avoid executable action plans unless explicitly requested.');
  }
  if (detectedTags.includes('plan')) {
    extraSystemMessages.push('CONTEXT DIRECTIVE: Respond in plan mode. Prefer numbered steps, assumptions, and validation notes. Avoid executable action plans unless explicitly requested.');
  }

  return {
    cleanedMessage: cleanedMessage || String(userMessage || ''),
    tags: detectedTags,
    extraSystemMessages
  };
}

function prevalidateActionTarget(action) {
  if (!action || action.x === undefined || action.y === undefined) {
    return { success: true };
  }

  const watcher = getUIWatcher();
  if (!watcher || !watcher.isPolling || typeof watcher.getElementAtPoint !== 'function') {
    return { success: true };
  }

  const liveElement = watcher.getElementAtPoint(action.x, action.y);
  if (!liveElement) {
    return {
      success: false,
      error: `No live UI element was found at (${action.x}, ${action.y}). Refresh context and retry.`
    };
  }

  const expectedTerms = [action.targetLabel, action.targetText]
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase())
    .filter(Boolean);

  if (expectedTerms.length > 0) {
    const liveText = Object.values(liveElement)
      .filter((value) => typeof value === 'string')
      .join(' ')
      .toLowerCase();
    const hasExpectedMatch = expectedTerms.some((term) => liveText.includes(term));
    if (!hasExpectedMatch) {
      return {
        success: false,
        error: `Live UI target at (${action.x}, ${action.y}) does not match the expected control. Refresh context before executing.`
      };
    }
  }

  return { success: true, liveElement };
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
        chatDebugLog('[COPILOT] Migrated token from legacy path');
      }
    }

    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      if (data.access_token) {
        apiKeys.copilot = data.access_token;
        chatDebugLog('[COPILOT] Loaded saved token');
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
    chatDebugLog('[COPILOT] Token saved');
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
            chatDebugLog('[COPILOT] OAuth started. User code:', result.user_code);
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
      hostname: GITHUB_API_HOST,
      path: COPILOT_TOKEN_PATH,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKeys.copilot}`,
        'Accept': 'application/json',
        'User-Agent': 'GithubCopilot/1.0.0',
        'Editor-Version': 'vscode/1.96.0',
        'Editor-Plugin-Version': 'copilot-chat/0.22.0',
        'X-GitHub-Api-Version': '2024-12-15'
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode >= 400) {
            const detail = String(body || '').trim().slice(0, 200);
            return reject(new Error(`Session exchange failed (${res.statusCode})${detail ? `: ${detail}` : ''}`));
          }
          const result = JSON.parse(body || '{}');
          const token = result.token || result.access_token;
          if (!token) {
            return reject(new Error('Copilot session token missing from response'));
          }
          apiKeys.copilotSession = token;

          // Use the API host from the session response if available
          if (result.endpoints && result.endpoints.api) {
            try {
              const apiUrl = new URL(result.endpoints.api);
              sessionApiHost = apiUrl.hostname;
              preferredCopilotChatHost = sessionApiHost;
              chatDebugLog(`[Copilot] Using session API host: ${sessionApiHost}`);
            } catch { /* ignore malformed URL */ }
          }

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
  const modelKey = resolveCopilotModelKey(modelOverride);
  const registry = modelRegistry();
  const modelInfo = registry[modelKey] || registry['gpt-4o'];
  const modelName = modelInfo?.name || modelKey || 'selected model';
  const enableTools = requestOptions?.enableTools !== false;
  const requireTools = requestOptions?.requireTools === true;

  if (hasVision && !supportsCopilotCapability(modelKey, 'vision')) {
    throw new Error(`Capability Error: Model '${modelName}' does not support visual context. Choose an Agentic Vision model.`);
  }

  if (enableTools && requireTools && !supportsCopilotCapability(modelKey, 'tools')) {
    throw new Error(`Capability Error: Model '${modelName}' does not support tools or automation actions.`);
  }

  return new Promise((resolve, reject) => {
    const fallbackModelKey = 'gpt-4o';
    let activeModelKey = modelKey;
    let modelId = modelInfo.id;

    const resolveModelKeyFromId = (selectedModelId, preferredKey = activeModelKey) => {
      const normalizedId = String(selectedModelId || '').trim().toLowerCase();
      if (!normalizedId) return preferredKey;
      for (const [key, value] of Object.entries(registry)) {
        if (String(key).toLowerCase() === normalizedId || String(value?.id || '').toLowerCase() === normalizedId) {
          return key;
        }
      }
      return preferredKey;
    };

    chatDebugLog(`[Copilot] Vision request: ${hasVision}, Model: ${modelId} (key=${modelKey})`);
    const toolsEnabledForModel = enableTools && supportsCopilotCapability(activeModelKey, 'tools');
    if (enableTools && !toolsEnabledForModel) {
      chatDebugLog(`[Copilot] Model ${activeModelKey} does not advertise tool support; sending plain chat request.`);
    }

    const isReasoningModel = supportsCopilotCapability(activeModelKey, 'reasoning');

    const makeRequestBody = (selectedModelId) => {
      const payload = {
        model: selectedModelId,
        messages: messages,
        max_tokens: Number.isFinite(Number(requestOptions?.max_tokens)) ? Number(requestOptions.max_tokens) : 4096,
        stream: true
      };

      // Reasoning models (o1, o3-mini) reject temperature/top_p/top_k — strip them
      if (!isReasoningModel) {
        payload.temperature = typeof requestOptions?.temperature === 'number' ? requestOptions.temperature : 0.7;
        if (typeof requestOptions?.top_p === 'number') {
          payload.top_p = requestOptions.top_p;
        }
      }

      if (requestOptions?.response_format) {
        payload.response_format = requestOptions.response_format;
      }

      if (toolsEnabledForModel) {
        payload.tools = getToolDefinitions();
        payload.tool_choice = requestOptions?.tool_choice || 'auto';
      }

      return JSON.stringify(payload);
    };

    const tryEndpoint = (hostname, pathPrefix = '', selectedModelId = modelId) => {
      const data = makeRequestBody(selectedModelId);
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKeys.copilotSession}`,
        'Accept': 'text/event-stream, application/json',
        'User-Agent': 'GithubCopilot/1.0.0',
        'Editor-Version': 'vscode/1.96.0',
        'Editor-Plugin-Version': 'copilot-chat/0.22.0',
        'Copilot-Integration-Id': 'vscode-chat',
        'X-Request-Id': `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
        'Openai-Organization': 'github-copilot',
        'OpenAI-Intent': 'conversation-panel',
        'X-GitHub-Api-Version': '2025-05-01',
        'Content-Length': Buffer.byteLength(data)
      };

      if (hasVision) {
        headers['Copilot-Vision-Request'] = 'true';
        chatDebugLog('[Copilot] Added Copilot-Vision-Request header');
      }

      const options = {
        hostname: hostname,
        path: pathPrefix + COPILOT_CHAT_PATH,
        method: 'POST',
        headers: headers,
        timeout: 30000
      };

      chatDebugLog(`[Copilot] Calling ${hostname}${options.path} with model ${selectedModelId}...`);

      return new Promise((resolveReq, rejectReq) => {
        const req = https.request(options, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            chatDebugLog('[Copilot] API response status:', res.statusCode);
            
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
              const parsed = parseCopilotChatResponse(body, res.headers || {});
              if (parsed.toolCalls && parsed.toolCalls.length > 0) {
                  const actions = toolCallsToActions(parsed.toolCalls);
                  const actionBlock = JSON.stringify({
                    thought: parsed.content || 'Executing requested actions',
                    actions,
                    verification: 'Verify the actions completed successfully'
                  }, null, 2);
                  const runtimeModelKey = resolveModelKeyFromId(selectedModelId, activeModelKey);
                  recordRuntimeSelection({
                    requestedModel: modelKey,
                    runtimeModel: runtimeModelKey,
                    endpointHost: hostname,
                    actualModelId: selectedModelId
                  });
                  chatDebugLog(`[Copilot] Received ${parsed.toolCalls.length} tool_calls, converted to action block`);
                  resolveReq({
                    content: '```json\n' + actionBlock + '\n```',
                    effectiveModel: runtimeModelKey,
                    requestedModel: modelKey,
                    actualModelId: selectedModelId,
                    endpointHost: hostname
                  });
              } else {
                const runtimeModelKey = resolveModelKeyFromId(selectedModelId, activeModelKey);
                recordRuntimeSelection({
                  requestedModel: modelKey,
                  runtimeModel: runtimeModelKey,
                  endpointHost: hostname,
                  actualModelId: selectedModelId
                });
                resolveReq({
                  content: parsed.content,
                  effectiveModel: runtimeModelKey,
                  requestedModel: modelKey,
                  actualModelId: selectedModelId,
                  endpointHost: hostname
                });
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

        req.on('timeout', () => {
          req.destroy(new Error('REQUEST_TIMEOUT'));
        });
        
        req.write(data);
        req.end();
      });
    };

    const primaryHost = sessionApiHost || preferredCopilotChatHost;
    const alternateHost = primaryHost === COPILOT_CHAT_HOST ? COPILOT_ALT_CHAT_HOST : COPILOT_CHAT_HOST;

    tryEndpoint(primaryHost, '', modelId)
      .then((result) => {
        preferredCopilotChatHost = primaryHost;
        resolve(result);
      })
      .catch(async (err) => {
        chatDebugLog('[Copilot] Primary endpoint failed:', err.message);

        const unsupportedModel = /unsupported_api_for_model|not accessible via the \/chat\/completions endpoint|not available|not supported|model_not_supported/i.test(err.message || '');
        if (unsupportedModel) {
          return reject(new Error(`Selected Copilot model '${modelName}' is not available on the chat endpoint. Choose a different model.`));
        }
        
        // If session expired, re-exchange and retry once
        if (err.message === 'SESSION_EXPIRED') {
          try {
            await exchangeForCopilotSession();
            const result = await tryEndpoint(primaryHost, '', modelId);
            return resolve(result);
          } catch (retryErr) {
            return reject(new Error('Session expired. Please try /login again.'));
          }
        }
        
        // Try alternate endpoint
        try {
          chatDebugLog('[Copilot] Trying alternate endpoint...');
          const result = await tryEndpoint(alternateHost, '', modelId);
          preferredCopilotChatHost = alternateHost;
          resolve(result);
        } catch (altErr) {
          chatDebugLog('[Copilot] Alternate endpoint also failed:', altErr.message);
          
          // Return user-friendly error messages
          if (err.message.includes('ACCESS_DENIED')) {
            reject(new Error('Access denied. Ensure you have an active GitHub Copilot subscription.'));
          } else if (err.message.includes('PARSE_ERROR')) {
            reject(new Error('API returned invalid response. You may need to re-authenticate with /login'));
          } else if (err.message.includes('REQUEST_TIMEOUT')) {
            reject(new Error('Copilot API timed out. Check connectivity and try again.'));
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
function callOpenAI(messages, requestOptions) {
  return new Promise((resolve, reject) => {
    const config = AI_PROVIDERS.openai;
    const hasVision = messages.some(m => Array.isArray(m.content));
    
    const data = JSON.stringify({
      model: hasVision ? config.visionModel : config.model,
      messages: messages,
      max_tokens: 2048,
      temperature: (requestOptions && requestOptions.temperature !== undefined) ? requestOptions.temperature : 0.7,
      ...(requestOptions && requestOptions.top_p !== undefined ? { top_p: requestOptions.top_p } : {})
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
function callAnthropic(messages, requestOptions) {
  return new Promise((resolve, reject) => {
    const config = AI_PROVIDERS.anthropic;
    
    // Convert messages format for Anthropic
    const systemMsg = messages.find(m => m.role === 'system');
    const otherMessages = messages.filter(m => m.role !== 'system');
    
    const data = JSON.stringify({
      model: config.model,
      max_tokens: 2048,
      system: systemMsg ? systemMsg.content : '',
      messages: otherMessages,
      ...(requestOptions && requestOptions.temperature !== undefined ? { temperature: requestOptions.temperature } : {}),
      ...(requestOptions && requestOptions.top_p !== undefined ? { top_p: requestOptions.top_p } : {})
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
function callOllama(messages, requestOptions) {
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
      stream: false,
      ...(requestOptions && requestOptions.temperature !== undefined ? { options: { temperature: requestOptions.temperature } } : {})
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

// Stop-words excluded from keyword extraction
const STOP_WORDS = new Set(['the','a','an','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','shall','should','may','might','can','could','to','of','in','for',
  'on','with','at','by','from','as','into','through','during','before','after','above','below','and',
  'but','or','not','no','so','if','then','than','too','very','just','about','up','out','it','its','i','my','me']);

/**
 * Extract meaningful keywords from a text string for memory tagging.
 */
function extractKeywords(text) {
  if (!text) return [];
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 10);
}

/**
 * Detect if AI response was truncated mid-stream
 * Uses heuristics to identify incomplete responses
 */
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

  const parsedTags = parseInlineIntentTags(userMessage);
  const tagSet = new Set(parsedTags.tags);
  const effectiveEnforceActions = enforceActions && !tagSet.has('research') && !tagSet.has('plan');

  // Enhance message with coordinate context if provided
  let enhancedMessage = parsedTags.cleanedMessage;
  if (coordinates) {
    enhancedMessage = `[User selected coordinates: (${coordinates.x}, ${coordinates.y}) with label "${coordinates.label}"]\n\n${parsedTags.cleanedMessage}`;
  }

  const baseExtraSystemMessages = [
    ...(Array.isArray(extraSystemMessages) ? extraSystemMessages : []),
    ...parsedTags.extraSystemMessages
  ];

  // Fetch relevant skills (Phase 4 — Semantic Skill Router)
  let skillsContextText = '';
  let selectedSkillIds = [];
  let currentProcessName = null;
  let currentWindowTitle = null;
  let currentWindowKind = null;
  let currentUrlHost = null;
  try {
    const fg = await systemAutomation.getForegroundWindowInfo();
    if (fg && fg.success && fg.processName) {
      currentProcessName = fg.processName;
      currentWindowTitle = fg.title || null;
      currentWindowKind = fg.windowKind || null;
    }
  } catch {}
  try {
    currentUrlHost = skillRouter.extractHost(getBrowserSessionState().url || '');
  } catch {}
  try {
    const skillSelection = skillRouter.getRelevantSkillsSelection(enhancedMessage, {
      currentProcessName,
      currentWindowTitle,
      currentWindowKind,
      currentUrlHost,
      limit: 3
    });
    skillsContextText = skillSelection.text || '';
    selectedSkillIds = Array.isArray(skillSelection.ids) ? skillSelection.ids : [];
    lastSkillSelection = {
      ids: selectedSkillIds,
      query: enhancedMessage,
      currentProcessName,
      currentWindowTitle,
      currentWindowKind,
      currentUrlHost,
      selectedAt: Date.now()
    };
  } catch (err) {
    console.warn('[AI] Skill router error (non-fatal):', err.message);
    lastSkillSelection = {
      ids: [],
      query: enhancedMessage,
      currentProcessName,
      currentWindowTitle,
      currentWindowKind,
      currentUrlHost,
      selectedAt: Date.now()
    };
  }

  // Fetch relevant memory notes (Phase 1 — Agentic Memory)
  let memoryContextText = '';
  try {
    memoryContextText = memoryStore.getMemoryContext(enhancedMessage) || '';
  } catch (err) {
    console.warn('[AI] Memory store error (non-fatal):', err.message);
  }

  let sessionIntentContextText = '';
  let chatContinuityContextText = '';
  try {
    ingestUserIntentState(enhancedMessage, { cwd: process.cwd() });
    const sessionState = getSessionIntentState({ cwd: process.cwd() });
    sessionIntentContextText = formatSessionIntentContext(sessionState) || '';
    chatContinuityContextText = formatChatContinuityContext(sessionState, { userMessage: enhancedMessage }) || '';
  } catch (err) {
    console.warn('[AI] Session intent state error (non-fatal):', err.message);
  }

  // Build messages with explicit skills/memory context params
  const messages = await buildMessages(enhancedMessage, includeVisualContext, {
    extraSystemMessages: baseExtraSystemMessages,
    skillsContext: skillsContextText,
    memoryContext: memoryContextText,
    sessionIntentContext: sessionIntentContextText,
    chatContinuityContext: chatContinuityContextText
  });

  try {
    const providerResult = await providerOrchestrator.requestWithFallback(messages, model, {
      includeVisualContext,
      requiresAutomation: looksLikeAutomationRequest(enhancedMessage) || tagSet.has('browser'),
      preferPlanning: tagSet.has('plan') || tagSet.has('vs code'),
      requiresTools: looksLikeAutomationRequest(enhancedMessage),
      tags: parsedTags.tags,
      phase: 'execution'
    });
    let response = providerResult.response;
    let effectiveModel = providerResult.effectiveModel;
    const requestedModel = providerResult.requestedModel || providerResult.effectiveModel;
    const providerMetadata = providerResult.providerMetadata || null;
    let usedProvider = providerResult.usedProvider;

    // Auto-continuation for truncated responses
    let fullResponse = response;
    let continuationCount = 0;
    
    while (shouldAutoContinueResponse(fullResponse, hasActions(fullResponse)) && continuationCount < maxContinuations) {
      continuationCount++;
      chatDebugLog(`[AI] Response appears truncated, continuing (${continuationCount}/${maxContinuations})...`);
      
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
      effectiveEnforceActions &&
      usedProvider === 'copilot' &&
      looksLikeAutomationRequest(enhancedMessage) &&
      !hasActions(response)
    ) {
      chatDebugLog('[AI] No actions detected for an automation-like request; retrying once with stricter formatting...');
      const enforcementPrompt =
        'You must respond ONLY with a JSON code block (```json ... ```).\n' +
        'Return an object with keys: thought, actions, verification.\n' +
        'If you truly cannot take actions, return {"thought":"...","actions":[],"verification":"..."}.\n\n' +
        `User request:\n${enhancedMessage}`;
      try {
        const forcedMessages = await buildMessages(enforcementPrompt, includeVisualContext, {
          extraSystemMessages: baseExtraSystemMessages
        });
        const forcedRaw = await providerOrchestrator.callProvider('copilot', forcedMessages, effectiveModel);
        const forced = (forcedRaw && typeof forcedRaw === 'object' && typeof forcedRaw.content === 'string')
          ? forcedRaw.content : forcedRaw;
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

            // callProvider returns an object for copilot ({ content, ... }) or a string for others.
            const regenText = (regenerated && typeof regenerated === 'object' && typeof regenerated.content === 'string')
              ? regenerated.content
              : (typeof regenerated === 'string' ? regenerated : null);
            currentResponse = regenText || currentResponse;
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
      requestedModel,
      modelVersion: modelRegistry()[effectiveModel]?.id || null,
      endpointHost: providerMetadata?.endpointHost || null,
      routingNote: providerMetadata?.routing?.message || null,
      routing: providerMetadata?.routing || null,
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
  const delegatedCommandResult = commandHandler.handleCommand(command);

  if (delegatedCommandResult) {
    return delegatedCommandResult;
  }

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
      clearSessionIntentState({ cwd: process.cwd() });
      clearChatContinuityState({ cwd: process.cwd() });
      historyStore.saveConversationHistory();
      return { type: 'system', message: 'Conversation, visual context, browser session state, session intent state, and chat continuity state cleared.' };

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
      const runtimeModelLabel = status.runtimeModelName || 'not yet validated';
      const runtimeHostLabel = status.runtimeEndpointHost || 'not yet validated';
      return {
        type: 'info',
        message: `Provider: ${status.provider}\nConfigured model: ${status.configuredModelName} (${status.configuredModel})\nRequested model: ${status.requestedModel}\nRuntime model: ${runtimeModelLabel}${status.runtimeModel ? ` (${status.runtimeModel})` : ''}\nRuntime endpoint: ${runtimeHostLabel}\nCopilot: ${status.hasCopilotKey ? 'Authenticated' : 'Not authenticated'}\nOpenAI: ${status.hasOpenAIKey ? 'Key set' : 'No key'}\nAnthropic: ${status.hasAnthropicKey ? 'Key set' : 'No key'}\nHistory: ${status.historyLength} messages\nVisual: ${status.visualContextCount} captures`
      };

    case '/state':
      if (parts[1] === 'clear') {
        clearSessionIntentState({ cwd: process.cwd() });
        return { type: 'system', message: 'Session intent state cleared.' };
      }
      return {
        type: 'info',
        message: formatSessionIntentSummary(getSessionIntentState({ cwd: process.cwd() }))
      };

    case '/memory': {
      if (parts[1] === 'clear') {
        const notesMap = memoryStore.listNotes();
        let removed = 0;
        for (const id of Object.keys(notesMap)) {
          memoryStore.removeNote(id);
          removed++;
        }
        return { type: 'system', message: `Cleared ${removed} memory note(s).` };
      }
      if (parts[1] === 'search' && parts[2]) {
        const query = parts.slice(2).join(' ');
        const notes = memoryStore.getRelevantNotes(query, 5);
        if (notes.length === 0) {
          return { type: 'info', message: `No memory notes match "${query}".` };
        }
        const list = notes.map(n => `  [${n.type}] ${n.content.slice(0, 80)}${n.content.length > 80 ? '...' : ''}`).join('\n');
        return { type: 'info', message: `Memory notes matching "${query}":\n${list}` };
      }
      // Default: list recent notes
      const notesMap = memoryStore.listNotes();
      const allNotes = Object.entries(notesMap);
      if (allNotes.length === 0) {
        return { type: 'info', message: 'No memory notes yet. Notes are created automatically from task outcomes and reflections.' };
      }
      const recent = allNotes.slice(-10);
      const list = recent.map(([id, n]) => `  ${id} [${n.type}] ${(n.content || '').slice(0, 60)}${(n.content || '').length > 60 ? '...' : ''}`).join('\n');
      return { type: 'info', message: `Memory (${allNotes.length} total, showing last ${recent.length}):\n${list}\n\nUse /memory search <query> to find specific notes, /memory clear to reset.` };
    }

    case '/skills': {
      const skills = skillRouter.listSkills();
      const entries = Object.entries(skills);
      if (entries.length === 0) {
        return { type: 'info', message: 'No skills registered. Skills are learned procedures that load automatically when relevant.' };
      }
      const list = entries.map(([id, s]) =>
        `  ${id} — keywords: [${(s.keywords || []).join(', ')}] — used: ${s.useCount || 0}x`
      ).join('\n');
      return { type: 'info', message: `Registered skills (${entries.length}):\n${list}` };
    }

    case '/tools': {
      const toolRegistry = require('./tools/tool-registry');
      const tools = toolRegistry.listTools();
      const entries = Object.entries(tools);
      if (entries.length === 0) {
        return { type: 'info', message: 'No dynamic tools registered. Tools can be proposed by the AI and require user approval before execution.' };
      }
      if (parts[1] === 'approve' && parts[2]) {
        const result = toolRegistry.approveTool(parts[2]);
        return result.success
          ? { type: 'system', message: `Tool '${parts[2]}' approved for execution.` }
          : { type: 'error', message: result.error };
      }
      if (parts[1] === 'revoke' && parts[2]) {
        const result = toolRegistry.revokeTool(parts[2]);
        return result.success
          ? { type: 'system', message: `Tool '${parts[2]}' approval revoked.` }
          : { type: 'error', message: result.error };
      }
      const list = entries.map(([name, t]) =>
        `  ${name} — ${t.description || 'no description'} — ${t.approved ? '✓ approved' : '✗ unapproved'} — invocations: ${t.invocations || 0}`
      ).join('\n');
      return { type: 'info', message: `Dynamic tools (${entries.length}):\n${list}\n\nUse /tools approve <name> or /tools revoke <name> to manage.` };
    }

    case '/rmodel': {
      // N6: Set reflection model override
      if (parts[1]) {
        if (parts[1].toLowerCase() === 'off' || parts[1].toLowerCase() === 'clear') {
          setReflectionModel(null);
          return { type: 'system', message: 'Reflection model cleared. Reflection will use the default model.' };
        }
        setReflectionModel(parts[1]);
        return { type: 'system', message: `Reflection model set to ${parts[1]}. Self-correction passes will use this model.` };
      }
      const current = getReflectionModel();
      return { type: 'info', message: `Reflection model: ${current || '(default — same as chat model)'}\nUse /rmodel <model> to set, /rmodel off to clear.` };
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
/memory [search <query>|clear] - View/search/clear long-term memory
/skills - List learned skills
/tools [approve|revoke <name>] - Manage dynamic tools
/rmodel [model|off] - Set reflection model for self-correction
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
  const configuredModel = getCurrentCopilotModel();
  const runtime = getRuntimeSelection();
  return {
    provider: getCurrentProvider(),
    model: configuredModel,
    modelName: registry[configuredModel]?.name || configuredModel,
    configuredModel,
    configuredModelName: registry[configuredModel]?.name || configuredModel,
    requestedModel: runtime.requestedModel || configuredModel,
    runtimeModel: runtime.runtimeModel,
    runtimeModelName: runtime.runtimeModel ? (registry[runtime.runtimeModel]?.name || runtime.runtimeModel) : null,
    runtimeEndpointHost: runtime.endpointHost,
    runtimeActualModelId: runtime.actualModelId,
    runtimeLastValidated: runtime.lastValidated,
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
  // Confirmation text with explicitly destructive/irreversible context
  /\b(yes,?\s*(delete|remove|reset|uninstall)|confirm\s+(delete|remove|reset|purchase|payment|transfer|subscription)|permanently|irreversible|cannot be undone)\b/i,
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
    blockExecution: false,
    blockReason: null,
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
    case 'grep_repo':
    case 'semantic_search_repo':
    case 'pgrep_process':
      result.riskLevel = ActionRiskLevel.SAFE;
      break;
  }
  
  // Check target info for dangerous patterns
  const textToCheck = [
    targetInfo.text || '',
    targetInfo.buttonText || '',
    targetInfo.label || '',
    action.reason || '',
    targetInfo.userMessage || '',
    ...(targetInfo.nearbyText || [])
  ].join(' ');

  const benignEnterIntent = action?.type === 'key'
    && /(enter|return)/i.test(String(action?.key || ''))
    && /\b(time\s*frame|timeframe|chart|symbol|watchlist|indicator|search|open|focus|switch|selector|tab|5m|1m|15m|30m|1h|4h|1d)\b/i.test(textToCheck)
    && !/\b(delete|remove|purchase|payment|transfer|permanent|irreversible|shutdown|restart|unsubscribe|close account)\b/i.test(textToCheck);

  const tradingDomainRisk = detectTradingViewDomainActionRisk(textToCheck, ActionRiskLevel, {
    actionType: action?.type
  });
  if (tradingDomainRisk) {
    result.riskLevel = tradingDomainRisk.riskLevel;
    result.warnings.push(tradingDomainRisk.warning);
    result.requiresConfirmation = !!tradingDomainRisk.requiresConfirmation;
    result.blockExecution = !!tradingDomainRisk.blockExecution;
    result.blockReason = tradingDomainRisk.blockReason || result.blockReason;
    if (tradingDomainRisk.tradingMode) {
      result.tradingMode = tradingDomainRisk.tradingMode;
    }
  }
  
  // Check for danger patterns
  for (const pattern of DANGER_PATTERNS) {
    if (pattern.test(textToCheck)) {
      if (benignEnterIntent && /confirm/i.test(String(textToCheck.match(pattern)?.[0] || ''))) {
        continue;
      }
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
    case 'grep_repo':
      return `Search repo for "${action.pattern || action.query || ''}"`.trim();
    case 'semantic_search_repo':
      return `Semantic repo search for "${action.query || action.pattern || ''}"`.trim();
    case 'pgrep_process':
      return `Search running processes for "${action.query || action.name || action.pattern || ''}"`.trim();
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
    pendingAction = {
      ...pendingAction,
      confirmed: true,
      confirmedAt: Date.now()
    };
    return pendingAction;
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

function normalizeIntentForRecovery(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\bcontinue\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isExplicitSearchIntent(text) {
  return /\b(search|google|look up|lookup|find out|status|latest|current|news|results?)\b/i.test(String(text || ''));
}

function extractSearchTermsFromUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    const parts = `${parsed.hostname} ${parsed.pathname}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter((value) => value.length >= 2 && !['https', 'http', 'www', 'com', 'net', 'org'].includes(value));
    return Array.from(new Set(parts)).slice(0, 6);
  } catch {
    return [];
  }
}

function buildBrowserRecoverySearchQuery(userMessage, attemptedUrls = []) {
  const userTerms = String(userMessage || '')
    .toLowerCase()
    .replace(/https?:\/\/[^\s]+/g, ' ')
    .replace(/\b(in|on|with|using|via|browser|edge|chrome|firefox|tab|window|navigate|navigation|open|go|to|continue|retry|please|find|way)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((value) => value.length >= 2);
  const urlTerms = attemptedUrls.flatMap(extractSearchTermsFromUrl);
  const terms = Array.from(new Set([...userTerms, ...urlTerms])).slice(0, 8);
  if (terms.length === 0) return 'official site current status';
  const suffix = terms.includes('status') || terms.includes('latest') || terms.includes('current')
    ? []
    : ['official', 'status'];
  return [...terms, ...suffix].join(' ').trim();
}

function buildGoogleSearchUrl(query) {
  return `https://www.google.com/search?q=${encodeURIComponent(String(query || '').trim())}`;
}

function looksLikeSearchResultsPage(state = {}) {
  const url = String(state.url || '').toLowerCase();
  const title = String(state.title || '').toLowerCase();
  return /google\.[a-z.]+\/search\?q=/.test(url)
    || /\bgoogle\s+search\b/.test(title)
    || /\bsearch results\b/.test(title);
}

function looksLikeBrowserErrorPage(state = {}) {
  const url = String(state.url || '').toLowerCase();
  const title = String(state.title || '').toLowerCase();
  const combined = `${url} ${title}`;
  return /\/404\b/.test(url)
    || /\b404\b/.test(title)
    || /err_[a-z_]+/.test(combined)
    || /dns[_\s-]?probe|name[_\s-]?not[_\s-]?resolved/.test(combined)
    || /site can.?t be reached|can.?t reach this page|not found|page not found/.test(combined)
    || String(state.goalStatus || '').toLowerCase() === 'needs_discovery';
}

function getBrowserRecoverySnapshot(userMessage = '') {
  const state = getBrowserSessionState();
  const goalStatus = String(state.goalStatus || 'unknown').toLowerCase();
  const recoveryMode = String(state.recoveryMode || 'direct').toLowerCase();
  const navigationAttemptCount = Number(state.navigationAttemptCount || 0);
  const searchResultsPage = looksLikeSearchResultsPage(state);
  const errorPage = looksLikeBrowserErrorPage(state);

  let phase = 'direct-navigation';
  if (goalStatus === 'achieved') {
    phase = 'achieved';
  } else if (searchResultsPage || recoveryMode === 'searching') {
    phase = 'result-selection';
  } else if (errorPage || recoveryMode === 'search') {
    phase = 'discovery-search';
  } else if (navigationAttemptCount >= 2 && !isExplicitSearchIntent(userMessage)) {
    phase = 'discovery-search';
  }

  let directive = '';
  if (phase === 'discovery-search') {
    directive = [
      'BROWSER RECOVERY DIRECTIVE: The current browser state indicates direct navigation is not resolving the goal.',
      'Do not guess another destination URL and do not retry the same failed URL.',
      'Switch to discovery: open the Google recovery search if results are not already visible, then capture or inspect the results page.'
    ].join(' ');
  } else if (phase === 'result-selection') {
    directive = [
      'BROWSER RECOVERY DIRECTIVE: You are in result-selection mode on a search results page.',
      'Do not guess another URL from memory.',
      'Use visible evidence from the screenshot, live UI, or semantic DOM to select a result.',
      'Prefer click_element with concrete result text; only navigate directly if the destination URL is visibly present in the current context.'
    ].join(' ');
  } else if (phase === 'achieved') {
    directive = 'BROWSER RECOVERY DIRECTIVE: The browser goal appears satisfied. Do not propose more navigation unless the user asks for another step.';
  }

  return {
    phase,
    directive,
    state,
    searchResultsPage,
    errorPage,
    navigationAttemptCount
  };
}

function buildBrowserSearchActions(target, query) {
  const normalizedQuery = String(query || '').trim();
  const searchUrl = buildGoogleSearchUrl(normalizedQuery);
  return buildBrowserOpenUrlActions(target, searchUrl, { searchQuery: '' }).concat([
    { type: 'screenshot', reason: `Capture Google results for ${normalizedQuery}` }
  ]);
}

function planContainsGoogleSearch(actions) {
  return Array.isArray(actions) && actions.some((action) =>
    action?.type === 'type' && typeof action?.text === 'string' && /google\.[a-z.]+\/search/i.test(action.text)
  );
}

function planContainsDirectUrl(actions) {
  return Array.isArray(actions) && actions.some((action) => {
    if (action?.type !== 'type' || typeof action?.text !== 'string') return false;
    const candidate = normalizeUrlCandidate(action.text);
    return !!(candidate && !/google\.[a-z.]+\/search/i.test(candidate));
  });
}

function maybeBuildBrowserRecoverySearchFallback(actions, userMessage) {
  const state = getBrowserSessionState();
  const currentIntent = normalizeIntentForRecovery(userMessage);
  const sameIntent = currentIntent && currentIntent === normalizeIntentForRecovery(state.lastUserIntent || '');
  const recoveryReady = sameIntent && (Number(state.navigationAttemptCount || 0) >= 2 || state.recoveryMode === 'search');
  if (!recoveryReady) return null;
  if (isExplicitSearchIntent(userMessage)) return null;
  if (planContainsGoogleSearch(actions)) return null;
  if (!planContainsDirectUrl(actions)) return null;

  const explicitBrowser = extractExplicitBrowserTarget(userMessage) || { browser: 'edge', channel: 'stable' };
  const recoveryQuery = state.recoveryQuery || buildBrowserRecoverySearchQuery(userMessage, state.attemptedUrls || []);
  if (!recoveryQuery) return null;

  updateBrowserSessionState({
    recoveryMode: 'searching',
    recoveryQuery,
    goalStatus: 'searching',
    lastStrategy: 'recovery-google-search',
    lastUserIntent: String(userMessage || '').trim().slice(0, 300)
  });
  return buildBrowserSearchActions(explicitBrowser, recoveryQuery);
}

function sanitizeRequestedAppCandidate(candidate) {
  if (!candidate || typeof candidate !== 'string') return null;
  let normalized = candidate.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  normalized = normalized.replace(/^[`'"(\[]+|[`'"),.!?\]]+$/g, '').trim();
  normalized = normalized.replace(/\s+(?:and|then)\s+(?:tell|show|analy[sz]e|give|capture|take|inspect|look|summari[sz]e|draw|visuali[sz]e|use|what)\b.*$/i, '').trim();
  normalized = normalized.replace(/\s*[,;:!?].*$/, '').trim();

  if (!normalized) return null;
  if (/^(?:in|on|at|with|while|when|since|because|already|currently|right\s+now)\b/i.test(normalized)) {
    return null;
  }
  if (normalized.length > 64) return null;
  return normalized;
}

function extractRequestedAppName(text) {
  if (!text || typeof text !== 'string') return null;
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  // Reject when the sentence is about interacting with web content, not launching an app
  const webContentRe = /\b(website|web\s*site|link|results|search\s*results|page|tab|url|button|menu|element)\b/i;
  const appSurfaceRe = /\b(dialog|panel|timeframe|time\s+frame|watchlist|symbol|chart|create\s+alert|new\s+alert|alert\s+dialog|indicator(?:\s+search)?|study\s+search|indicators?\s+menu|open\s+indicators|quick\s+search|command\s+palette|pine\s+editor|pine\s+logs|pine\s+profiler|profiler|pine\s+version\s+history|version\s+history|dom|depth\s+of\s+market|paper\s+trading|drawing\s+tools?|object(?:\s+|-)tree|trading\s+panel)\b/i;

  const intentPatterns = [
    /^(?:please\s+|hey\s+|ok(?:ay)?\s+|first\s+|then\s+)*(open|launch|start|run)\b\s+(?:the\s+)?(.+?)\s+\b(app|application|program|software)\b(?:[.!?]|$)/i,
    /^(?:please\s+|hey\s+|ok(?:ay)?\s+|first\s+|then\s+)*(open|launch|start|run)\b\s+(?:the\s+)?(.+)$/i,
    /^(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:first\s+|then\s+)*(open|launch|start|run)\b\s+(?:the\s+)?(.+?)(?:\s+\b(app|application|program|software)\b)?(?:[.!?]|$)/i,
    /^(?:i\s+need\s+to|need\s+to|i\s+want\s+to|want\s+to|help\s+me|let'?s|lets|try\s+to|trying\s+to|go\s+ahead\s+and)\s+(open|launch|start|run)\b\s+(?:the\s+)?(.+?)(?:\s+\b(app|application|program|software)\b)?(?:[.!?]|$)/i
  ];

  for (const pattern of intentPatterns) {
    const match = normalized.match(pattern);
    const rawCandidate = match?.[2];
    if (!rawCandidate || /https?:\/\//i.test(rawCandidate)) continue;
    const candidate = sanitizeRequestedAppCandidate(rawCandidate);
    if (!candidate) continue;
    if (webContentRe.test(candidate)) continue;
    if (appSurfaceRe.test(candidate)) continue;
    return candidate;
  }

  return null;
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

/**
 * Smart browser click resolution.
 *
 * When a coordinate-based click targets a browser window and the AI's context
 * (thought/reason) contains a recognisable URL or link text, this function
 * replaces the imprecise coordinate click with a deterministic strategy:
 *
 *  Strategy 1 — Address-bar navigation (URL detected)
 *    Ctrl+L → type URL → Enter.  100 % reliable when the target URL is known.
 *
 *  Strategy 2 — UIA element lookup (link text detected, no URL)
 *    findElementByText → click element center.  Uses Windows UI Automation
 *    accessibility tree for pixel-perfect targeting.
 *
 *  Strategy 3 — Ctrl+F find-on-page refinement (fallback)
 *    Ctrl+F → type text → Enter → Escape.  Scrolls the matching text into
 *    the viewport, then performs the original coordinate click (now more
 *    likely to land on the element).
 *
 * @param {Object}  action        The click action (must have x, y, reason)
 * @param {Object}  actionData    Full actionData (thought available)
 * @param {number}  windowHandle  The last known target window handle
 * @param {Function} [actionExecutor]  Optional custom executor
 * @returns {Promise<{handled:boolean, result?:Object}>}
 */
async function trySmartBrowserClick(action, actionData, windowHandle, actionExecutor) {
  // Only applies to left-click with reason text
  if (action.type !== 'click' || action.x === undefined || action.button === 'right') {
    return { handled: false };
  }

  const reason = String(action.reason || '');
  const thought = String(actionData?.thought || '');
  const combinedContext = `${thought} ${reason}`;

  // Quick heuristic: reason should mention a link / navigate / open context
  const isLinkClick = /\blink\b|\bnav\b|\bwebsite\b|\bopen\b|\bhref\b|\burl\b/i.test(combinedContext);
  if (!isLinkClick) return { handled: false };

  // Determine if target window is a browser
  let isBrowserTarget = false;
  if (windowHandle) {
    try {
      const fgInfo = await systemAutomation.getForegroundWindowInfo();
      if (fgInfo?.success) {
        isBrowserTarget = isBrowserProcessName(fgInfo.processName) || looksLikeBrowserTitle(fgInfo.title);
      }
    } catch { /* ignore */ }
  }
  if (!isBrowserTarget) {
    // Also check watcher cache
    const watcher = getUIWatcher();
    if (watcher && watcher.cache?.activeWindow) {
      const aw = watcher.cache.activeWindow;
      isBrowserTarget = isBrowserProcessName(aw.processName) || looksLikeBrowserTitle(aw.title);
    }
  }
  if (!isBrowserTarget) return { handled: false };

  const exec = async (a) => (actionExecutor ? actionExecutor(a) : systemAutomation.executeAction(a));

  // ---------- Strategy 1: URL detected → address-bar navigation ----------
  const urlMatch = combinedContext.match(/https?:\/\/[^\s"'<>)]+/i);
  if (urlMatch) {
    let url = urlMatch[0].replace(/[.,;:!?)]+$/, ''); // strip trailing punctuation
    console.log(`[AI-SERVICE] Smart browser click → address-bar navigation: ${url}`);

    await systemAutomation.focusWindow(windowHandle);
    await new Promise(r => setTimeout(r, 200));

    // Ctrl+L → select address bar
    await exec({ type: 'key', key: 'ctrl+l', reason: 'Focus address bar' });
    await new Promise(r => setTimeout(r, 350));

    // Type URL
    await exec({ type: 'type', text: url });
    await new Promise(r => setTimeout(r, 200));

    // Enter
    await exec({ type: 'key', key: 'enter', reason: 'Navigate to URL' });

    return {
      handled: true,
      result: {
        success: true,
        action: 'click',
        message: `Smart browser navigation to ${url} (address bar)`,
        strategy: 'address-bar',
        originalCoords: { x: action.x, y: action.y }
      }
    };
  }

  // ---------- Strategy 2: link text → UIA element lookup ----------
  const textMatch = reason.match(/['"]([^'"]{3,80})['"]/);
  if (textMatch) {
    const linkText = textMatch[1];
    console.log(`[AI-SERVICE] Smart browser click → UIA lookup: "${linkText}"`);
    try {
      const found = await systemAutomation.findElementByText(linkText, { controlType: '' });
      if (found?.element?.Bounds) {
        const { CenterX, CenterY } = found.element.Bounds;
        console.log(`[AI-SERVICE] UIA found "${linkText}" at (${CenterX}, ${CenterY})`);
        await systemAutomation.focusWindow(windowHandle);
        await new Promise(r => setTimeout(r, 150));
        const clickResult = await exec({ type: 'click', x: CenterX, y: CenterY });
        return {
          handled: true,
          result: {
            success: clickResult.success !== false,
            action: 'click',
            message: `Clicked "${linkText}" via UIA at (${CenterX}, ${CenterY})`,
            strategy: 'uia-element',
            originalCoords: { x: action.x, y: action.y },
            resolvedCoords: { x: CenterX, y: CenterY }
          }
        };
      }
    } catch (e) {
      console.log(`[AI-SERVICE] UIA lookup failed: ${e.message}`);
    }
  }

  // ---------- Strategy 3: Ctrl+F find on page, then coordinate click ----------
  const searchTextMatch = reason.match(/['"]([^'"]{3,60})['"]/);
  if (searchTextMatch) {
    const searchText = searchTextMatch[1];
    console.log(`[AI-SERVICE] Smart browser click → Ctrl+F refinement: "${searchText}"`);

    await systemAutomation.focusWindow(windowHandle);
    await new Promise(r => setTimeout(r, 200));

    // Open find bar
    await exec({ type: 'key', key: 'ctrl+f', reason: 'Open find bar' });
    await new Promise(r => setTimeout(r, 400));

    // Type search text (this scrolls matching text into viewport)
    await exec({ type: 'type', text: searchText });
    await new Promise(r => setTimeout(r, 500));

    // Close find bar to restore normal interaction
    await exec({ type: 'key', key: 'escape', reason: 'Close find bar' });
    await new Promise(r => setTimeout(r, 300));

    // Now proceed with original coordinate click (text is now in viewport)
    // Fall through to let the caller execute the original coordinate click
    console.log(`[AI-SERVICE] Ctrl+F scrolled text into view, proceeding with coordinate click`);
  }

  return { handled: false };
}

function actionsLikelyBrowserSession(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return false;
  return actions.some((a) => {
    const type = String(a?.type || '').toLowerCase();
    // run_command only indicates a browser session when the command targets a browser
    if (type === 'run_command') {
      const cmd = String(a?.command || '').toLowerCase();
      return /\b(msedge|chrome|firefox|brave|vivaldi|opera|microsoft-edge:)\b/i.test(cmd);
    }
    if ((type === 'bring_window_to_front' || type === 'focus_window') && (isBrowserProcessName(a?.processName) || looksLikeBrowserTitle(a?.title))) return true;
    if ((type === 'type' || type === 'key') && /ctrl\+l|youtube|https?:\/\//i.test(String(a?.text || a?.key || ''))) return true;
    return false;
  });
}

function actionsLikelyConcreteAppObservationPlan(actions, requestedAppName) {
  if (!Array.isArray(actions) || actions.length === 0 || !requestedAppName) return false;

  const allowedTypes = new Set(['focus_window', 'bring_window_to_front', 'wait', 'screenshot']);
  const onlyObservationTypes = actions.every((action) => allowedTypes.has(String(action?.type || '').toLowerCase()));
  if (!onlyObservationTypes) return false;
  if (!actions.some((action) => String(action?.type || '').toLowerCase() === 'screenshot')) return false;

  const normalizedIdentity = resolveNormalizedAppIdentity(requestedAppName);
  const expectedProcessNames = new Set((normalizedIdentity?.processNames || []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean));
  const expectedTitleHints = (normalizedIdentity?.titleHints || []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);

  return actions.some((action) => {
    const type = String(action?.type || '').toLowerCase();
    if (type !== 'focus_window' && type !== 'bring_window_to_front') return false;

    const explicitWindowHandle = Number(action?.windowHandle || action?.hwnd || action?.targetWindowHandle || 0) || 0;
    if (explicitWindowHandle > 0) return true;

    const verifyTarget = action?.verifyTarget;
    if (verifyTarget && normalizedIdentity?.appName === 'TradingView' && isTradingViewTargetHint(verifyTarget)) {
      return true;
    }

    const processName = String(action?.processName || '').trim().toLowerCase();
    if (processName && Array.from(expectedProcessNames).some((candidate) => processName === candidate || processName.includes(candidate))) {
      return true;
    }

    const title = String(action?.title || action?.windowTitle || '').trim().toLowerCase();
    if (title && expectedTitleHints.some((hint) => title.includes(hint))) {
      return true;
    }

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

  const previousState = getBrowserSessionState();
  const patch = {};
  const currentIntent = typeof executionSummary.userMessage === 'string' && executionSummary.userMessage.trim()
    ? executionSummary.userMessage.trim().slice(0, 300)
    : null;
  if (currentIntent) {
    patch.lastUserIntent = currentIntent;
  }

  const urlFromActions = extractUrlFromActions(actions);
  const urlFromResults = extractUrlFromResults(executionSummary.results);
  patch.url = urlFromResults || urlFromActions || getBrowserSessionState().url;

  const fg = executionSummary.postVerification?.foreground;
  if (fg && fg.success && looksLikeBrowserTitle(fg.title)) {
    patch.title = fg.title;
  }

  const navigationUrl = urlFromActions;
  const previousIntent = normalizeIntentForRecovery(previousState.lastUserIntent || '');
  const sameIntent = !!(currentIntent && previousIntent && normalizeIntentForRecovery(currentIntent) === previousIntent);
  if (navigationUrl) {
    const isSearchUrl = /google\.[a-z.]+\/search/i.test(navigationUrl);
    patch.lastAttemptedUrl = navigationUrl;
    if (isSearchUrl) {
      patch.recoveryMode = executionSummary.success ? 'searching' : 'search';
    } else {
      const attemptedUrls = sameIntent ? [...(Array.isArray(previousState.attemptedUrls) ? previousState.attemptedUrls : [])] : [];
      attemptedUrls.push(navigationUrl);
      patch.attemptedUrls = Array.from(new Set(attemptedUrls)).slice(-6);
      patch.navigationAttemptCount = sameIntent ? Number(previousState.navigationAttemptCount || 0) + 1 : 1;

      if (!isExplicitSearchIntent(currentIntent || '') && Number(patch.navigationAttemptCount || 0) >= 2) {
        patch.recoveryMode = 'search';
        patch.recoveryQuery = buildBrowserRecoverySearchQuery(currentIntent || '', patch.attemptedUrls || []);
      } else if (!sameIntent) {
        patch.recoveryMode = 'direct';
        patch.recoveryQuery = null;
      }
    }
  } else if (!sameIntent && currentIntent) {
    patch.lastAttemptedUrl = null;
    patch.attemptedUrls = [];
    patch.navigationAttemptCount = 0;
    patch.recoveryMode = 'direct';
    patch.recoveryQuery = null;
  }

  patch.goalStatus = executionSummary.success ? 'achieved' : 'needs_attention';
  if (patch.recoveryMode === 'search') {
    patch.goalStatus = 'needs_discovery';
  } else if (patch.recoveryMode === 'searching') {
    patch.goalStatus = 'searching';
  }
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

  const tradingViewTimeframeRewrite = maybeRewriteTradingViewTimeframeWorkflow(actions, { userMessage });
  if (tradingViewTimeframeRewrite) {
    return tradingViewTimeframeRewrite;
  }

  const tradingViewSymbolRewrite = maybeRewriteTradingViewSymbolWorkflow(actions, { userMessage });
  if (tradingViewSymbolRewrite) {
    return tradingViewSymbolRewrite;
  }

  const tradingViewWatchlistRewrite = maybeRewriteTradingViewWatchlistWorkflow(actions, { userMessage });
  if (tradingViewWatchlistRewrite) {
    return tradingViewWatchlistRewrite;
  }

  const tradingViewDrawingRewrite = maybeRewriteTradingViewDrawingWorkflow(actions, { userMessage });
  if (tradingViewDrawingRewrite) {
    return tradingViewDrawingRewrite;
  }

  const tradingViewPineRewrite = maybeRewriteTradingViewPineWorkflow(actions, { userMessage });
  if (tradingViewPineRewrite) {
    return tradingViewPineRewrite;
  }

  const tradingViewPaperRewrite = maybeRewriteTradingViewPaperWorkflow(actions, { userMessage });
  if (tradingViewPaperRewrite) {
    return tradingViewPaperRewrite;
  }

  const tradingViewDomRewrite = maybeRewriteTradingViewDomWorkflow(actions, { userMessage });
  if (tradingViewDomRewrite) {
    return tradingViewDomRewrite;
  }

  const tradingViewIndicatorRewrite = maybeRewriteTradingViewIndicatorWorkflow(actions, { userMessage });
  if (tradingViewIndicatorRewrite) {
    return tradingViewIndicatorRewrite;
  }

  const tradingViewAlertRewrite = maybeRewriteTradingViewAlertWorkflow(actions, { userMessage });
  if (tradingViewAlertRewrite) {
    return tradingViewAlertRewrite;
  }

  // ── Redundant-search elimination ──────────────────────────────
  // If the plan contains a Google search URL followed by direct URL navigation,
  // the search is redundant — strip it and go straight to the destination.
  actions = eliminateRedundantSearch(actions);

  const recoveryFallback = maybeBuildBrowserRecoverySearchFallback(actions, userMessage);
  if (recoveryFallback) {
    return recoveryFallback;
  }

  const strategySelection = applyNonVisualWebStrategies(actions, { userMessage });
  if (strategySelection.actions !== actions) {
    updateBrowserSessionState({
      goalStatus: 'in_progress',
      lastStrategy: strategySelection.strategyId || 'non-visual',
      lastUserIntent: userMessage.trim().slice(0, 300)
    });
    return strategySelection.actions;
  }

  const requestedUrl = extractFirstUrlFromText(userMessage);
  const explicitBrowser = extractExplicitBrowserTarget(userMessage);
  const explicitlyMentionsRealBrowser = /\b(edge|microsoft\s+edge|chrome|google\s+chrome|firefox)\b/i.test(userMessage);

  const alreadySimpleBrowser = actions.some(
    (a) => typeof a?.text === 'string' && /simple\s+browser\s*:\s*show/i.test(a.text)
  );
  if (alreadySimpleBrowser && requestedUrl && ((explicitBrowser?.browser && explicitBrowser.browser !== 'vscode') || explicitlyMentionsRealBrowser)) {
    const browserTarget = explicitBrowser?.browser && explicitBrowser.browser !== 'vscode'
      ? explicitBrowser
      : { browser: /firefox/i.test(userMessage) ? 'firefox' : /chrome/i.test(userMessage) ? 'chrome' : 'edge', channel: 'stable' };
    updateBrowserSessionState({
      url: requestedUrl,
      goalStatus: 'in_progress',
      lastStrategy: 'rewrite-simple-browser-to-explicit-browser',
      lastUserIntent: userMessage.trim().slice(0, 300)
    });
    return buildBrowserOpenUrlActions(browserTarget, requestedUrl);
  }

  // If the AI is already using the Simple Browser command palette flow, keep it,
  // but ensure we focus VS Code first (models often forget this).
  if (alreadySimpleBrowser) {
    return prependVsCodeFocusIfMissing(actions);
  }

  // Intent-aware rewrite: if the USER asked to open a URL in VS Code integrated browser,
  // run the full deterministic Simple Browser flow even if the model tries incremental steps.
  const requestedAppName = extractRequestedAppName(userMessage);
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
    const hasExplicitVerificationContract = actions.some((a) => a?.verify && typeof a.verify === 'object' && String(a.verify.kind || '').trim());
    if (hasExplicitVerificationContract) {
      return actions;
    }

    if (actionsLikelyConcreteAppObservationPlan(actions, requestedAppName)) {
      return actions;
    }

    // If the AI's plan already targets a browser window, preserve it — the model
    // is interacting with an open browser, not trying to launch a new application.
    if (actionsLikelyBrowserSession(actions)) {
      return actions;
    }

    // If the AI chose run_command to launch an app, the Start menu approach is
    // more reliable (handles special chars like #, elevation, detached processes, etc.).
    // Only preserve run_command if it's clearly a *discovery* command (Get-ChildItem,
    // Test-Path, if exist, Get-Process, etc.) — anything else gets rewritten.
    const discoveryRe = /\b(Get-ChildItem|Test-Path|Get-Process|Get-Item|Resolve-Path|Where-Object|Select-Object|dir\b|if\s+exist)\b/i;
    const onlyRunCommands = actions.every((a) => a?.type === 'run_command' || a?.type === 'wait');
    const hasNonDiscoveryCommand = actions.some((a) => {
      if (a?.type !== 'run_command') return false;
      const cmd = String(a?.command || '');
      return !discoveryRe.test(cmd);
    });
    if (onlyRunCommands && hasNonDiscoveryCommand) {
      console.log(`[AI-SERVICE] Rewriting run_command app launch to Start menu approach for "${requestedAppName}"`);
      return buildOpenApplicationActions(requestedAppName);
    }

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

/**
 * Detect and eliminate redundant Google search steps when the same plan
 * also contains a direct URL navigation. Example anti-pattern:
 *   type "https://www.google.com/search?q=apple.com" → enter → wait →
 *   ctrl+l → type "https://www.apple.com" → enter
 * The search adds ~6 unnecessary steps. Strip them, keep the direct navigation.
 */
function eliminateRedundantSearch(actions) {
  if (!Array.isArray(actions) || actions.length < 6) return actions;

  // Find indices of `type` actions that contain a Google search URL
  const googleSearchIndices = [];
  // Find indices of `type` actions that contain a direct destination URL (not Google)
  const directUrlIndices = [];

  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (a?.type !== 'type' || typeof a?.text !== 'string') continue;
    const text = a.text.trim();
    if (/^https?:\/\/(www\.)?google\.[a-z.]+\/search/i.test(text) ||
        /^https?:\/\/(www\.)?google\.[a-z.]+.*[?&]q=/i.test(text)) {
      googleSearchIndices.push(i);
    } else if (/^https?:\/\//i.test(text) && !/google\./i.test(text)) {
      directUrlIndices.push(i);
    }
  }

  // Only optimize when there's both a search AND a later direct URL
  if (googleSearchIndices.length === 0 || directUrlIndices.length === 0) return actions;
  const firstSearch = googleSearchIndices[0];
  const lastDirect = directUrlIndices[directUrlIndices.length - 1];
  if (lastDirect <= firstSearch) return actions;

  // Find the ctrl+l that precedes the direct URL (the "focus address bar" step)
  let ctrlLBeforeDirect = -1;
  for (let i = lastDirect - 1; i >= 0; i--) {
    if (actions[i]?.type === 'key' && /^ctrl\+l$/i.test(String(actions[i]?.key || '').trim())) {
      ctrlLBeforeDirect = i;
      break;
    }
    // Don't look back past the search section
    if (i <= firstSearch) break;
  }
  if (ctrlLBeforeDirect < 0) return actions;

  // Strip everything from the search type action to just before the ctrl+l for the direct URL.
  // Keep: actions before the search, the ctrl+l + direct URL navigation, and anything after.
  const before = actions.slice(0, firstSearch);
  const after = actions.slice(ctrlLBeforeDirect);

  // Remove any leading waits from 'after' since the search wait is no longer needed
  // (the ctrl+l itself handles focus)
  console.log(`[AI-SERVICE] Eliminated redundant Google search (${ctrlLBeforeDirect - firstSearch} steps stripped)`);
  return [...before, ...after];
}

const POST_ACTION_VERIFY_MAX_RETRIES = 2;
const POST_ACTION_VERIFY_SETTLE_MS = 900;
const POST_ACTION_VERIFY_POLL_INTERVAL_MS = 450;
const POST_ACTION_VERIFY_MAX_POLL_CYCLES = 8;
const POPUP_RECIPE_MAX_ACTIONS = 6;
const FOCUS_VERIFY_SETTLE_MS = 250;
const FOCUS_VERIFY_MAX_RETRIES = 2;
const KEY_CHECKPOINT_SETTLE_MS = 240;
const KEY_CHECKPOINT_TIMEOUT_MS = 1400;
const KEY_CHECKPOINT_MAX_POLLS = 2;

function sleepMs(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function normalizeTextForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function mergeUniqueKeywords(...groups) {
  return Array.from(new Set(groups
    .flat()
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)));
}

function summarizeForegroundSignature(foreground) {
  if (!foreground || !foreground.success) return null;
  return {
    hwnd: Number(foreground.hwnd || 0) || 0,
    title: String(foreground.title || '').trim(),
    processName: String(foreground.processName || '').trim().toLowerCase(),
    windowKind: String(foreground.windowKind || '').trim().toLowerCase(),
    isTopmost: !!foreground.isTopmost,
    isToolWindow: !!foreground.isToolWindow,
    isMinimized: !!foreground.isMinimized,
    isMaximized: !!foreground.isMaximized
  };
}

function didForegroundObservationChange(beforeForeground, afterForeground) {
  const before = summarizeForegroundSignature(beforeForeground);
  const after = summarizeForegroundSignature(afterForeground);
  if (!before || !after) return false;

  return before.hwnd !== after.hwnd
    || before.title !== after.title
    || before.processName !== after.processName
    || before.windowKind !== after.windowKind
    || before.isTopmost !== after.isTopmost
    || before.isToolWindow !== after.isToolWindow
    || before.isMinimized !== after.isMinimized
    || before.isMaximized !== after.isMaximized;
}

function inferLaunchVerificationTarget(actionData, userMessage = '') {
  const actions = Array.isArray(actionData?.actions) ? actionData.actions : [];
  const explicitHint = [...actions]
    .reverse()
    .map(a => a?.verifyTarget)
    .find(v => v && typeof v === 'object');

  const target = {
    appName: extractRequestedAppName(userMessage) || null,
    requestedAppName: null,
    launchQuery: null,
    processNames: [],
    titleHints: [],
    popupKeywords: []
  };

  if (explicitHint) {
    if (typeof explicitHint.appName === 'string' && explicitHint.appName.trim()) {
      target.appName = explicitHint.appName.trim();
    }
    if (typeof explicitHint.requestedAppName === 'string' && explicitHint.requestedAppName.trim()) {
      target.requestedAppName = explicitHint.requestedAppName.trim();
    }
    if (typeof explicitHint.launchQuery === 'string' && explicitHint.launchQuery.trim()) {
      target.launchQuery = explicitHint.launchQuery.trim();
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
    const normalizedIdentity = resolveNormalizedAppIdentity(target.appName);
    if (normalizedIdentity) {
      target.requestedAppName = target.requestedAppName || normalizedIdentity.requestedName;
      target.appName = normalizedIdentity.appName;
      target.launchQuery = target.launchQuery || normalizedIdentity.launchQuery;
      target.processNames.push(...normalizedIdentity.processNames);
      target.titleHints.push(...normalizedIdentity.titleHints);
      target.popupKeywords.push(...normalizedIdentity.popupKeywords);
    }
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

const observationCheckpointRuntime = createObservationCheckpointRuntime({
  systemAutomation,
  getUIWatcher,
  sleepMs,
  evaluateForegroundAgainstTarget,
  inferLaunchVerificationTarget,
  buildVerifyTargetHintFromAppName,
  extractTradingViewObservationKeywords,
  inferTradingViewTradingMode,
  inferTradingViewObservationSpec,
  isTradingViewTargetHint,
  keyCheckpointSettleMs: KEY_CHECKPOINT_SETTLE_MS,
  keyCheckpointTimeoutMs: KEY_CHECKPOINT_TIMEOUT_MS,
  keyCheckpointMaxPolls: KEY_CHECKPOINT_MAX_POLLS
});

const {
  inferKeyObservationCheckpoint,
  verifyKeyObservationCheckpoint
} = observationCheckpointRuntime;

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
    plans.push(buildOpenApplicationActions(target.launchQuery || target.appName));
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

async function verifyForegroundFocus(expectedWindowHandle, options = {}) {
  const expectedHwnd = Number(expectedWindowHandle || 0);
  if (!expectedHwnd) {
    return {
      applicable: false,
      verified: true,
      drifted: false,
      attempts: 0,
      expectedWindowHandle: 0,
      attemptedRestore: false,
      attemptedRefocus: false,
      foreground: null,
      reason: 'no-expected-window'
    };
  }

  const recoveryTarget = options.recoveryTarget && typeof options.recoveryTarget === 'object'
    ? options.recoveryTarget
    : null;

  let foreground = await systemAutomation.getForegroundWindowInfo();
  if (Number(foreground?.hwnd || 0) === expectedHwnd) {
    return {
      applicable: true,
      verified: true,
      drifted: false,
      attempts: 0,
      expectedWindowHandle: expectedHwnd,
      attemptedRestore: false,
      attemptedRefocus: false,
      foreground,
      reason: 'foreground-matched'
    };
  }

  let attemptedRestore = false;
  for (let attempt = 1; attempt <= FOCUS_VERIFY_MAX_RETRIES; attempt++) {
    if (recoveryTarget && (recoveryTarget.title || recoveryTarget.processName)) {
      attemptedRestore = true;
      await systemAutomation.executeAction({
        type: 'restore_window',
        title: recoveryTarget.title || undefined,
        processName: recoveryTarget.processName || undefined,
        continue_on_error: true,
        reason: 'Focus verification self-heal: restore target window'
      });
    }
    await systemAutomation.focusWindow(expectedHwnd);
    await sleepMs(FOCUS_VERIFY_SETTLE_MS + (attempt * 75));
    foreground = await systemAutomation.getForegroundWindowInfo();
    if (Number(foreground?.hwnd || 0) === expectedHwnd) {
      return {
        applicable: true,
        verified: true,
        drifted: true,
        attempts: attempt,
        expectedWindowHandle: expectedHwnd,
        attemptedRestore,
        attemptedRefocus: true,
        foreground,
        reason: 'refocused-target-window'
      };
    }
  }

  return {
    applicable: true,
    verified: false,
    drifted: true,
    attempts: FOCUS_VERIFY_MAX_RETRIES,
    expectedWindowHandle: expectedHwnd,
    attemptedRestore,
    attemptedRefocus: true,
    foreground,
    reason: 'focus-drift-persisted'
  };
}

function buildFocusTargetHint(action = {}) {
  const target = {
    appName: null,
    processNames: [],
    titleHints: []
  };

  if (action?.verifyTarget && typeof action.verifyTarget === 'object') {
    const explicit = action.verifyTarget;
    if (typeof explicit.appName === 'string' && explicit.appName.trim()) {
      target.appName = explicit.appName.trim();
    }
    if (Array.isArray(explicit.processNames)) {
      target.processNames.push(...explicit.processNames.map((value) => String(value || '').trim()).filter(Boolean));
    }
    if (Array.isArray(explicit.titleHints)) {
      target.titleHints.push(...explicit.titleHints.map((value) => String(value || '').trim()).filter(Boolean));
    }
  }

  if (typeof action?.processName === 'string' && action.processName.trim()) {
    target.processNames.push(action.processName.trim());
  }
  if (typeof action?.title === 'string' && action.title.trim()) {
    target.titleHints.push(action.title.trim());
  }
  if (typeof action?.windowTitle === 'string' && action.windowTitle.trim()) {
    target.titleHints.push(action.windowTitle.trim());
  }

  target.processNames = Array.from(new Set(target.processNames.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)));
  target.titleHints = Array.from(new Set(target.titleHints.map((value) => String(value || '').trim()).filter(Boolean)));

  return target;
}

function classifyActionFocusTargetResult(action = {}, result = {}) {
  const focusTarget = result?.focusTarget && typeof result.focusTarget === 'object'
    ? result.focusTarget
    : null;
  if (!focusTarget) return null;

  const requestedWindowHandle = Number(focusTarget.requestedWindowHandle || result.requestedWindowHandle || action.windowHandle || action.hwnd || 0) || 0;
  const actualForegroundHandle = Number(focusTarget.actualForegroundHandle || result.actualForegroundHandle || 0) || 0;
  const actualForeground = focusTarget.actualForeground || result.actualForeground || null;

  if (!requestedWindowHandle && !actualForegroundHandle) return null;
  if (requestedWindowHandle && actualForegroundHandle && requestedWindowHandle === actualForegroundHandle) {
    return {
      outcome: 'exact',
      accepted: true,
      targetWindowHandle: requestedWindowHandle,
      foreground: actualForeground,
      matchReason: 'hwnd-exact'
    };
  }

  const target = buildFocusTargetHint(action);
  const foregroundMatch = actualForeground
    ? evaluateForegroundAgainstTarget(actualForeground, target)
    : { matched: false, matchReason: 'no-foreground' };
  const tradingViewLikeTarget = isTradingViewTargetHint(action?.verifyTarget || target)
    || normalizeTextForMatch(action?.processName || '').includes('tradingview')
    || normalizeTextForMatch(action?.title || action?.windowTitle || '').includes('tradingview');

  if (actualForegroundHandle && foregroundMatch.matched && tradingViewLikeTarget) {
    return {
      outcome: 'recovered',
      accepted: true,
      targetWindowHandle: actualForegroundHandle,
      foreground: actualForeground,
      matchReason: foregroundMatch.matchReason || 'target-family-match'
    };
  }

  return {
    outcome: 'mismatch',
    accepted: false,
    targetWindowHandle: requestedWindowHandle || null,
    foreground: actualForeground,
    matchReason: foregroundMatch.matchReason || 'foreground-mismatch'
  };
}

function buildWindowProfileFromForeground(foreground, fallbackProfile = null) {
  if (!foreground || !foreground.success) return fallbackProfile;
  return {
    processName: foreground.processName || fallbackProfile?.processName || undefined,
    className: foreground.className || fallbackProfile?.className || undefined,
    windowKind: foreground.windowKind || fallbackProfile?.windowKind || undefined,
    title: foreground.title || fallbackProfile?.title || undefined
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
function buildScreenshotCaptureRequest(action, lastTargetWindowHandle = null, options = {}) {
  const requestedScope = String(action?.scope || '').trim().toLowerCase();
  const region = action?.region && typeof action.region === 'object' ? action.region : null;
  const explicitWindowHandle = Number(action?.windowHandle || action?.hwnd || action?.targetWindowHandle || 0) || 0;
  const inferredWindowHandle = explicitWindowHandle || (Number(lastTargetWindowHandle || 0) || 0);
  const windowProfile = options?.windowProfile && typeof options.windowProfile === 'object'
    ? options.windowProfile
    : null;

  let scope = 'screen';
  if (region) {
    scope = 'region';
  } else if (['active-window', 'window'].includes(requestedScope)) {
    scope = 'window';
  } else if (requestedScope === 'screen') {
    scope = 'screen';
  } else if (inferredWindowHandle) {
    scope = 'window';
  }

  return {
    scope,
    region: region || undefined,
    windowHandle: inferredWindowHandle || undefined,
    targetWindowHandle: inferredWindowHandle || undefined,
    reason: action?.reason || '',
    processName: String(windowProfile?.processName || '').trim() || undefined,
    className: String(windowProfile?.className || '').trim() || undefined,
    windowKind: String(windowProfile?.windowKind || '').trim() || undefined,
    windowTitle: String(windowProfile?.title || windowProfile?.windowTitle || '').trim() || undefined,
    capturePurpose: String(options?.capturePurpose || '').trim() || undefined,
    approvalPauseRefresh: options?.approvalPauseRefresh === true
  };
}

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
  let lastTargetWindowProfile = null;
  let focusRecoveryTarget = null;
  let postVerification = { applicable: false, verified: true, healed: false, attempts: 0 };
  const observationCheckpoints = [];

  for (let i = 0; i < actionData.actions.length; i++) {
    const action = actionData.actions[i];
    const actionWindowHandle = Number(action?.windowHandle || action?.hwnd || action?.targetWindowHandle || 0) || 0;
    if (actionWindowHandle > 0) {
      lastTargetWindowHandle = actionWindowHandle;
    }
    if (action?.processName || action?.className || action?.windowKind || action?.title || action?.windowTitle) {
      lastTargetWindowProfile = {
        processName: action.processName || lastTargetWindowProfile?.processName || undefined,
        className: action.className || lastTargetWindowProfile?.className || undefined,
        windowKind: action.windowKind || lastTargetWindowProfile?.windowKind || undefined,
        title: action.title || action.windowTitle || lastTargetWindowProfile?.title || undefined
      };
    }

    // Track the intended target window across steps so later key/type actions can
    // re-focus it. Without this, focus can drift back to the overlay/terminal.
    if (action.type === 'focus_window' || action.type === 'bring_window_to_front') {
      try {
        const hwnd = await systemAutomation.resolveWindowHandle(action);
        if (hwnd) {
          lastTargetWindowHandle = hwnd;
          lastTargetWindowProfile = {
            processName: action.processName || lastTargetWindowProfile?.processName || undefined,
            className: action.className || lastTargetWindowProfile?.className || undefined,
            windowKind: action.windowKind || lastTargetWindowProfile?.windowKind || undefined,
            title: action.title || action.windowTitle || lastTargetWindowProfile?.title || undefined
          };
          focusRecoveryTarget = {
            title: action.title || undefined,
            processName: action.processName || undefined
          };
        }
      } catch {}
    }

    if (action.type === 'restore_window') {
      lastTargetWindowProfile = {
        processName: action.processName || lastTargetWindowProfile?.processName || undefined,
        className: action.className || lastTargetWindowProfile?.className || undefined,
        windowKind: action.windowKind || lastTargetWindowProfile?.windowKind || undefined,
        title: action.title || action.windowTitle || lastTargetWindowProfile?.title || undefined
      };
      focusRecoveryTarget = {
        title: action.title || undefined,
        processName: action.processName || undefined
      };
    }
    
    // Handle screenshot requests specially
    if (action.type === 'screenshot') {
      screenshotRequested = true;
      if (onScreenshot) {
        await onScreenshot(buildScreenshotCaptureRequest(action, lastTargetWindowHandle, {
          windowProfile: lastTargetWindowProfile
        }));
      }
      results.push({ success: true, action: 'screenshot', message: 'Screenshot captured' });
      continue;
    }

    // ===== SAFETY CHECK =====
    // Get target info if available (from visual analysis)
    const targetInfo = {
      ...(targetAnalysis[`${action.x},${action.y}`] || {}),
      text: targetAnalysis[`${action.x},${action.y}`]?.text || action.reason || '',
      buttonText: targetAnalysis[`${action.x},${action.y}`]?.buttonText || action.targetText || '',
      nearbyText: Array.isArray(targetAnalysis[`${action.x},${action.y}`]?.nearbyText)
        ? targetAnalysis[`${action.x},${action.y}`].nearbyText
        : [],
      userMessage: options.userMessage || actionData.userMessage || ''
    };
    
    // Analyze safety
    const safety = analyzeActionSafety(action, targetInfo);
    console.log(`[AI-SERVICE] Action ${i} safety: ${safety.riskLevel}`, safety.warnings);

    if (safety.blockExecution) {
      const blockedResult = {
        success: false,
        action: action.type,
        error: safety.blockReason || 'Action blocked by advisory-only safety rail',
        reason: action.reason || '',
        safety,
        blockedByPolicy: true
      };
      results.push(blockedResult);
      if (onAction) {
        onAction(blockedResult, i, actionData.actions.length);
      }
      break;
    }

    // CRITICAL actions require an explicit confirmation step, even if the user clicked
    // the general "Execute" button for a batch. This prevents accidental destructive
    // shortcuts (e.g., alt+f4) from immediately closing the active app due to focus issues.
    const canBypassConfirmation = skipSafetyConfirmation && safety.riskLevel !== ActionRiskLevel.CRITICAL;
    
    // If HIGH or CRITICAL risk, require confirmation (unless user already confirmed via Execute button)
    if (safety.requiresConfirmation && !canBypassConfirmation) {
      console.log(`[AI-SERVICE] Action ${i} requires user confirmation`);
      let approvalPauseCapture = null;
      const approvalCaptureWindowHandle = Number(
        action?.windowHandle || action?.hwnd || action?.targetWindowHandle || lastTargetWindowHandle || 0
      ) || 0;
      if (onScreenshot && approvalCaptureWindowHandle > 0) {
        const approvalCaptureRequest = buildScreenshotCaptureRequest(
          {
            ...action,
            scope: 'window',
            reason: action?.reason || 'Refresh non-disruptive evidence while waiting for user confirmation.'
          },
          approvalCaptureWindowHandle,
          {
            windowProfile: lastTargetWindowProfile,
            capturePurpose: 'approval-pause-refresh',
            approvalPauseRefresh: true
          }
        );

        try {
          await onScreenshot(approvalCaptureRequest);
          screenshotRequested = true;
          approvalPauseCapture = {
            requested: true,
            capturePurpose: 'approval-pause-refresh',
            scope: approvalCaptureRequest.scope,
            windowHandle: approvalCaptureRequest.windowHandle || null
          };
        } catch (captureError) {
          approvalPauseCapture = {
            requested: true,
            capturePurpose: 'approval-pause-refresh',
            scope: approvalCaptureRequest.scope,
            windowHandle: approvalCaptureRequest.windowHandle || null,
            error: String(captureError?.message || captureError || '')
          };
        }
      }
      
      const resumePrerequisites = buildTradingViewPineResumePrerequisites(actionData.actions, i, {
        lastTargetWindowProfile
      });

      // Store as pending action
      setPendingAction({
        ...safety,
        actionIndex: i,
        remainingActions: actionData.actions.slice(i),
        completedResults: [...results],
        thought: actionData.thought,
        verification: actionData.verification,
        userMessage: options.userMessage || actionData.userMessage || '',
        lastTargetWindowHandle,
        lastTargetWindowProfile,
        resumePrerequisites,
        approvalPauseCapture
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
      const prevalidation = prevalidateActionTarget(action);
      if (!prevalidation.success) {
        const blockedResult = {
          success: false,
          action: action.type,
          error: prevalidation.error,
          reason: action.reason || '',
          safety
        };
        results.push(blockedResult);
        if (onAction) {
          onAction(blockedResult, i, actionData.actions.length);
        }
        break;
      }

      const watcher = getUIWatcher();
      if (watcher && watcher.isPolling) {
        const elementAtPoint = watcher.getElementAtPoint(action.x, action.y);
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

    // Ensure focus-sensitive input goes to the last known target window.
    if ((action.type === 'key' || action.type === 'type' || action.type === 'click_element') && lastTargetWindowHandle) {
      console.log(`[AI-SERVICE] Re-focusing last target window ${lastTargetWindowHandle} before ${action.type}`);
      await systemAutomation.focusWindow(lastTargetWindowHandle);
      await new Promise(r => setTimeout(r, 125));
    }

    // Smart browser click: when clicking in a browser, try URL navigation or UIA before
    // falling back to imprecise coordinate clicks estimated from screenshots.
    if (action.type === 'click' && action.x !== undefined && lastTargetWindowHandle) {
      const smart = await trySmartBrowserClick(action, actionData, lastTargetWindowHandle, actionExecutor);
      if (smart.handled) {
        const smartResult = smart.result;
        smartResult.reason = action.reason || '';
        smartResult.safety = safety;
        results.push(smartResult);
        if (onAction) onAction(smartResult, i, actionData.actions.length);
        if (!smartResult.success && !action.continue_on_error) {
          console.log(`[AI-SERVICE] Smart browser click failed at action ${i}`);
          break;
        }
        continue;
      }
    }

    const checkpointSpec = inferKeyObservationCheckpoint(action, actionData, i, {
      userMessage,
      focusRecoveryTarget
    });
    const checkpointBeforeForeground = checkpointSpec?.applicable
      ? await systemAutomation.getForegroundWindowInfo()
      : null;

    const result = await (actionExecutor ? actionExecutor(action) : systemAutomation.executeAction(action));
    result.reason = action.reason || '';
    result.safety = safety;

    if (result.success && (action.type === 'focus_window' || action.type === 'bring_window_to_front')) {
      const classifiedFocus = classifyActionFocusTargetResult(action, result);
      if (classifiedFocus) {
        result.focusTarget = {
          ...(result.focusTarget || {}),
          outcome: classifiedFocus.outcome,
          accepted: classifiedFocus.accepted,
          matchReason: classifiedFocus.matchReason
        };
        if (classifiedFocus.accepted) {
          if (classifiedFocus.targetWindowHandle) {
            lastTargetWindowHandle = classifiedFocus.targetWindowHandle;
          }
          lastTargetWindowProfile = buildWindowProfileFromForeground(classifiedFocus.foreground, lastTargetWindowProfile);
          focusRecoveryTarget = {
            title: classifiedFocus.foreground?.title || focusRecoveryTarget?.title || action.title || undefined,
            processName: classifiedFocus.foreground?.processName || focusRecoveryTarget?.processName || action.processName || undefined
          };
        }
      }
    }

    results.push(result);

    if (result.success && checkpointSpec?.applicable) {
      const observationCheckpoint = await verifyKeyObservationCheckpoint(checkpointSpec, checkpointBeforeForeground, {
        expectedWindowHandle: lastTargetWindowHandle
      });
      result.observationCheckpoint = observationCheckpoint;
      observationCheckpoints.push({
        ...observationCheckpoint,
        actionIndex: i,
        key: String(action.key || '')
      });

      if (observationCheckpoint.foreground?.success) {
        const observedHwnd = Number(observationCheckpoint.foreground.hwnd || 0) || 0;
        if (observedHwnd) {
          lastTargetWindowHandle = observedHwnd;
        }
        lastTargetWindowProfile = {
          processName: observationCheckpoint.foreground.processName || lastTargetWindowProfile?.processName || undefined,
          className: observationCheckpoint.foreground.className || lastTargetWindowProfile?.className || undefined,
          windowKind: observationCheckpoint.foreground.windowKind || lastTargetWindowProfile?.windowKind || undefined,
          title: observationCheckpoint.foreground.title || lastTargetWindowProfile?.title || undefined
        };
        focusRecoveryTarget = {
          title: observationCheckpoint.foreground.title || focusRecoveryTarget?.title || undefined,
          processName: observationCheckpoint.foreground.processName || focusRecoveryTarget?.processName || undefined
        };
      }

      if (!observationCheckpoint.verified) {
        result.success = false;
        result.error = observationCheckpoint.error;
      }
    }

    // If we just performed a step that likely changed focus, snapshot the actual foreground HWND.
    // This is especially important when uiWatcher isn't polling (can't infer windowHandle).
    if (typeof systemAutomation.getForegroundWindowHandle === 'function') {
      if (
        action.type === 'click' ||
        action.type === 'double_click' ||
        action.type === 'right_click'
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
  let focusVerification = {
    applicable: false,
    verified: true,
    drifted: false,
    attempts: 0,
    expectedWindowHandle: Number(lastTargetWindowHandle || 0) || 0
  };

  if (success && !pendingConfirmation) {
    focusVerification = await verifyForegroundFocus(lastTargetWindowHandle, {
      recoveryTarget: focusRecoveryTarget
    });
    if (focusVerification.applicable && !focusVerification.verified) {
      success = false;
      error = 'Focus verification could not keep the target window in the foreground';
    }
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

  // ===== COGNITIVE FEEDBACK LOOP =====
  // Write episodic memory + evaluate for reflection (non-fatal wrapping)
  let reflectionApplied = null;
  if (!pendingConfirmation) {
    try {
      const failedActions = results.filter(r => !r.success);
      const actionSummary = (actionData.actions || []).map(a => ({
        type: a.type,
        ...(a.text ? { text: a.text } : {}),
        ...(a.key ? { key: a.key } : {})
      }));

      // Write episodic memory note for significant outcomes
      const outcomeLabel = (success && !error) ? 'success' : 'failure';
      memoryStore.addNote({
        type: 'episodic',
        content: `Task ${outcomeLabel}: ${actionData.thought || userMessage || 'action sequence'}` +
          (error ? ` — ${error}` : ''),
        context: userMessage || actionData.thought || '',
        keywords: extractKeywords(userMessage || actionData.thought || ''),
        tags: ['execution', outcomeLabel],
        source: { type: 'execution', timestamp: new Date().toISOString(), outcome: outcomeLabel }
      });

      // AWM — Agent Workflow Memory: extract reusable procedures from successful multi-step sequences
      const MIN_STEPS_FOR_PROCEDURE = 3;
      if (outcomeLabel === 'success' && actionSummary.length >= MIN_STEPS_FOR_PROCEDURE) {
        // Quality gate: skip saving skills that are just roundabout URL navigation
        // (e.g., Google search → wait → navigate to destination URL).
        const hasGoogleSearchStep = actionSummary.some(a =>
          a.type === 'type' && typeof a.text === 'string' &&
          /google\.[a-z.]+\/search|google\.[a-z.]+.*[?&]q=/i.test(a.text)
        );
        const hasDirectUrlStep = actionSummary.some(a =>
          a.type === 'type' && typeof a.text === 'string' &&
          /^https?:\/\//i.test(a.text.trim()) && !/google\./i.test(a.text)
        );
        if (hasGoogleSearchStep && hasDirectUrlStep) {
          console.log('[AI-SERVICE] AWM: Skipping skill extraction — redundant search-then-navigate pattern');
        } else {
        try {
          const stepDescriptions = actionSummary.map((a, i) =>
            `${i + 1}. ${a.type}${a.text ? `: "${a.text}"` : ''}${a.key ? `: ${a.key}` : ''}`
          ).join('\n');
          const procedureContent = `Procedure: ${actionData.thought || userMessage || 'multi-step sequence'}\n\nSteps:\n${stepDescriptions}`;
          const procedureKeywords = extractKeywords(actionData.thought || userMessage || '');

          // Write procedural memory note for future retrieval
          memoryStore.addNote({
            type: 'procedural',
            content: procedureContent,
            context: userMessage || actionData.thought || '',
            keywords: procedureKeywords,
            tags: ['procedure', 'awm', 'success'],
            source: { type: 'awm-extraction', timestamp: new Date().toISOString(), stepCount: actionSummary.length }
          });

          // Auto-register as a skill if it has a clear intent (thought field)
          if (actionData.thought && actionData.thought.length > 10) {
            // PreToolUse gate — ensure skill creation is permitted by hook policy
            const hookGate = runPreToolUseHook('awm_create_skill', { thought: actionData.thought, stepCount: actionSummary.length });
            if (hookGate.denied) {
              console.log(`[AI-SERVICE] AWM: Skill creation denied by PreToolUse hook: ${hookGate.reason}`);
            } else {
              const normalizedSkillApp = resolveNormalizedAppIdentity(
                postVerification?.target?.appName
                || postVerification?.target?.requestedAppName
                || extractRequestedAppName(userMessage || actionData.thought || '')
                || ''
              );
              const learnedSkill = skillRouter.upsertLearnedSkill({
                idHint: `awm-${Date.now().toString(36)}`,
                keywords: procedureKeywords,
                tags: ['awm', 'auto-generated'],
                scope: {
                  processNames: Array.from(new Set([
                    postVerification?.foreground?.processName || '',
                    ...((normalizedSkillApp?.processNames) || [])
                  ].filter(Boolean))),
                  windowTitles: Array.from(new Set([
                    postVerification?.foreground?.title || '',
                    ...((normalizedSkillApp?.titleHints) || [])
                  ].filter(Boolean))),
                  kind: postVerification?.foreground?.windowKind || null,
                  domains: [skillRouter.extractHost(getBrowserSessionState().url || '') || ''].filter(Boolean)
                },
                content: `# ${actionData.thought}\n\n${procedureContent}\n\n_Auto-extracted from successful execution on ${new Date().toISOString()}_`
              });
              if (learnedSkill.promoted) {
                console.log(`[AI-SERVICE] AWM: Promoted learned skill "${learnedSkill.id}" (${actionSummary.length} steps)`);
              } else {
                console.log(`[AI-SERVICE] AWM: Learned candidate skill "${learnedSkill.id}" awaiting another grounded success`);
              }
            }
          }
        } catch (awmErr) {
          console.warn('[AI-SERVICE] AWM extraction error (non-fatal):', awmErr.message);
        }
        } // end quality gate else
      }

      // Evaluate for reflection trigger (RLVR feedback loop) — bounded to MAX_REFLECTION_ITERATIONS
      const MAX_REFLECTION_ITERATIONS = 2;
      if (failedActions.length > 0) {
        let reflectionIteration = 0;
        let evaluation = reflectionTrigger.evaluateOutcome({
          task: actionData.thought || userMessage || 'action sequence',
          phase: 'execution',
          outcome: 'failure',
          actions: actionSummary,
          context: {
            error,
            failedCount: failedActions.length,
            totalCount: results.length,
            selectedSkillIds: lastSkillSelection.ids,
            currentProcessName: postVerification?.foreground?.processName || lastSkillSelection.currentProcessName || null,
            currentWindowTitle: postVerification?.foreground?.title || lastSkillSelection.currentWindowTitle || null,
            currentWindowKind: postVerification?.foreground?.windowKind || lastSkillSelection.currentWindowKind || null,
            currentUrlHost: skillRouter.extractHost(getBrowserSessionState().url || '') || lastSkillSelection.currentUrlHost || null,
            runningPids: Array.isArray(postVerification?.runningPids) ? postVerification.runningPids : []
          }
        });

        while (evaluation.shouldReflect && reflectionIteration < MAX_REFLECTION_ITERATIONS) {
          reflectionIteration++;
          console.log(`[AI-SERVICE] Reflection triggered (iteration ${reflectionIteration}/${MAX_REFLECTION_ITERATIONS}): ${evaluation.reason}`);
          const reflectionMessages = reflectionTrigger.buildReflectionMessages(evaluation.failures);

          try {
            const reflectionResult = await providerOrchestrator.requestWithFallback(
              reflectionMessages,
              reflectionModelOverride, // N6: use reasoning model for reflection when configured
              { phase: 'reflection' }
            );

            if (reflectionResult && reflectionResult.response) {
              reflectionApplied = reflectionTrigger.applyReflectionResult(reflectionResult.response);
              console.log(`[AI-SERVICE] Reflection result (iteration ${reflectionIteration}): ${reflectionApplied.action} — ${reflectionApplied.detail}`);
              // PostToolUse audit for reflection pass
              try {
                runPostToolUseHook('reflection_pass', { iteration: reflectionIteration, reason: evaluation.reason }, {
                  success: !!reflectionApplied.applied,
                  result: reflectionApplied.action
                });
              } catch (_) { /* audit is non-fatal */ }
              // If reflection applied a concrete action, stop iterating
              if (reflectionApplied.applied) break;
            }
          } catch (reflErr) {
            console.warn('[AI-SERVICE] Reflection AI call failed (non-fatal):', reflErr.message);
            break;
          }

          // Re-evaluate — if still above threshold, loop will continue
          if (reflectionIteration < MAX_REFLECTION_ITERATIONS) {
            evaluation = reflectionTrigger.evaluateOutcome({
              task: actionData.thought || userMessage || 'action sequence',
              phase: 'reflection',
              outcome: 'failure',
              actions: actionSummary,
              context: {
                error,
                reflectionIteration,
                selectedSkillIds: lastSkillSelection.ids,
                currentProcessName: postVerification?.foreground?.processName || lastSkillSelection.currentProcessName || null,
                currentWindowTitle: postVerification?.foreground?.title || lastSkillSelection.currentWindowTitle || null,
                currentWindowKind: postVerification?.foreground?.windowKind || lastSkillSelection.currentWindowKind || null,
                currentUrlHost: skillRouter.extractHost(getBrowserSessionState().url || '') || lastSkillSelection.currentUrlHost || null,
                runningPids: Array.isArray(postVerification?.runningPids) ? postVerification.runningPids : []
              }
            });
          }
        }

        if (reflectionIteration >= MAX_REFLECTION_ITERATIONS && !reflectionApplied?.applied) {
          console.warn(`[AI-SERVICE] Reflection exhausted after ${MAX_REFLECTION_ITERATIONS} iterations without resolution`);
        }
      }

      if (Array.isArray(lastSkillSelection.ids) && lastSkillSelection.ids.length > 0) {
        const skillOutcome = skillRouter.recordSkillOutcome(lastSkillSelection.ids, outcomeLabel, {
          currentProcessName: postVerification?.foreground?.processName || lastSkillSelection.currentProcessName || null,
          currentWindowTitle: postVerification?.foreground?.title || lastSkillSelection.currentWindowTitle || null,
          currentWindowKind: postVerification?.foreground?.windowKind || lastSkillSelection.currentWindowKind || null,
          currentUrlHost: skillRouter.extractHost(getBrowserSessionState().url || '') || lastSkillSelection.currentUrlHost || null,
          runningPids: Array.isArray(postVerification?.runningPids) ? postVerification.runningPids : [],
          query: userMessage || actionData.thought || ''
        });
        if (Array.isArray(skillOutcome.quarantined) && skillOutcome.quarantined.length > 0) {
          console.warn(`[AI-SERVICE] Quarantined stale skills after grounded failures: ${skillOutcome.quarantined.join(', ')}`);
        }
      }
    } catch (cogErr) {
      console.warn('[AI-SERVICE] Cognitive feedback loop error (non-fatal):', cogErr.message);
    }
  }

  return {
    success,
    thought: actionData.thought,
    verification: actionData.verification,
    results,
    error,
    screenshotRequested,
    observationCheckpoints,
    focusVerification,
    postVerification,
    postVerificationFailed: !!(postVerification.applicable && !postVerification.verified),
    pendingConfirmation,
    pendingActionId: pendingConfirmation ? getPendingAction()?.actionId : null,
    approvalPauseCapture: pendingConfirmation ? getPendingAction()?.approvalPauseCapture || null : null,
    reflectionApplied
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
  let lastTargetWindowHandle = Number(pending.lastTargetWindowHandle || 0) || null;
  let lastTargetWindowProfile = pending.lastTargetWindowProfile && typeof pending.lastTargetWindowProfile === 'object'
    ? { ...pending.lastTargetWindowProfile }
    : null;
  let focusRecoveryTarget = null;
  let postVerification = { applicable: false, verified: true, healed: false, attempts: 0 };
  const observationCheckpoints = [];
  const resumePrerequisites = Array.isArray(pending.resumePrerequisites)
    ? pending.resumePrerequisites.filter((action) => action && typeof action === 'object')
    : [];
  const actionsToResume = resumePrerequisites.concat(Array.isArray(pending.remainingActions) ? pending.remainingActions : []);
  
  // Execute the confirmed action and remaining actions
  for (let i = 0; i < actionsToResume.length; i++) {
    const action = actionsToResume[i];

    if (action.type === 'focus_window' || action.type === 'bring_window_to_front') {
      try {
        const hwnd = await systemAutomation.resolveWindowHandle(action);
        if (hwnd) {
          lastTargetWindowHandle = hwnd;
          lastTargetWindowProfile = {
            processName: action.processName || lastTargetWindowProfile?.processName || undefined,
            className: action.className || lastTargetWindowProfile?.className || undefined,
            windowKind: action.windowKind || lastTargetWindowProfile?.windowKind || undefined,
            title: action.title || action.windowTitle || lastTargetWindowProfile?.title || undefined
          };
          focusRecoveryTarget = {
            title: action.title || undefined,
            processName: action.processName || undefined
          };
        }
      } catch {}
    }

    if (action.type === 'restore_window') {
      lastTargetWindowProfile = {
        processName: action.processName || lastTargetWindowProfile?.processName || undefined,
        className: action.className || lastTargetWindowProfile?.className || undefined,
        windowKind: action.windowKind || lastTargetWindowProfile?.windowKind || undefined,
        title: action.title || action.windowTitle || lastTargetWindowProfile?.title || undefined
      };
      focusRecoveryTarget = {
        title: action.title || undefined,
        processName: action.processName || undefined
      };
    }
    
    if (action.type === 'screenshot') {
      screenshotRequested = true;
      if (onScreenshot) {
        await onScreenshot(buildScreenshotCaptureRequest(action, lastTargetWindowHandle, {
          windowProfile: lastTargetWindowProfile
        }));
      }
      results.push({ success: true, action: 'screenshot', message: 'Screenshot captured' });
      continue;
    }

    const resumeSafety = analyzeActionSafety(action, {
      text: action.reason || '',
      buttonText: action.targetText || '',
      nearbyText: [],
      userMessage: options.userMessage || pending?.userMessage || ''
    });
    if (resumeSafety.blockExecution) {
      const blockedResult = {
        success: false,
        action: action.type,
        error: resumeSafety.blockReason || 'Action blocked by advisory-only safety rail',
        reason: action.reason || '',
        userConfirmed: resumePrerequisites.length === 0 && i === 0,
        safety: resumeSafety,
        blockedByPolicy: true
      };
      results.push(blockedResult);
      if (onAction) {
        onAction(blockedResult, i, actionsToResume.length);
      }
      break;
    }

    if ((action.type === 'click' || action.type === 'double_click' || action.type === 'right_click') && action.x !== undefined) {
      const prevalidation = prevalidateActionTarget(action);
      if (!prevalidation.success) {
        const blockedResult = {
          success: false,
          action: action.type,
          error: prevalidation.error,
          reason: action.reason || '',
          userConfirmed: resumePrerequisites.length === 0 && i === 0
        };
        results.push(blockedResult);
        if (onAction) {
          onAction(blockedResult, i, actionsToResume.length);
        }
        break;
      }

      const watcherResume = getUIWatcher();
      if (watcherResume && watcherResume.isPolling) {
        const elementAtPoint = watcherResume.getElementAtPoint(action.x, action.y);
        if (elementAtPoint && elementAtPoint.windowHandle) {
          lastTargetWindowHandle = elementAtPoint.windowHandle;
          console.log(`[AI-SERVICE] (resume) Auto-focusing window handle ${elementAtPoint.windowHandle} for click at (${action.x}, ${action.y})`);
          await systemAutomation.focusWindow(elementAtPoint.windowHandle);
          await new Promise(r => setTimeout(r, 450));
        }
      }
    }

    if ((action.type === 'key' || action.type === 'type' || action.type === 'click_element') && lastTargetWindowHandle) {
      console.log(`[AI-SERVICE] (resume) Re-focusing last target window ${lastTargetWindowHandle} before ${action.type}`);
      await systemAutomation.focusWindow(lastTargetWindowHandle);
      await new Promise(r => setTimeout(r, 125));
    }

    // Smart browser click: same as main loop — try URL navigation / UIA before coordinate click.
    if (action.type === 'click' && action.x !== undefined && lastTargetWindowHandle) {
      const resumeActionData = { thought: pending.thought, verification: pending.verification };
      const smart = await trySmartBrowserClick(action, resumeActionData, lastTargetWindowHandle, actionExecutor);
      if (smart.handled) {
        const smartResult = smart.result;
        smartResult.reason = action.reason || '';
        smartResult.userConfirmed = resumePrerequisites.length === 0 && i === 0;
        results.push(smartResult);
        if (onAction) onAction(smartResult, pending.actionIndex + i, pending.actionIndex + actionsToResume.length);
        if (!smartResult.success && !action.continue_on_error) break;
        continue;
      }
    }
    
    // Execute action (user confirmed, skip safety for first action)
    const resumeActionData = {
      thought: pending.thought,
      verification: pending.verification,
      actions: actionsToResume
    };
    const checkpointSpec = inferKeyObservationCheckpoint(action, resumeActionData, i, {
      userMessage,
      focusRecoveryTarget
    });
    const checkpointBeforeForeground = checkpointSpec?.applicable
      ? await systemAutomation.getForegroundWindowInfo()
      : null;

    const result = await (actionExecutor ? actionExecutor(action) : systemAutomation.executeAction(action));
    result.reason = action.reason || '';
    result.userConfirmed = resumePrerequisites.length === 0 && i === 0;

    if (result.success && (action.type === 'focus_window' || action.type === 'bring_window_to_front')) {
      const classifiedFocus = classifyActionFocusTargetResult(action, result);
      if (classifiedFocus) {
        result.focusTarget = {
          ...(result.focusTarget || {}),
          outcome: classifiedFocus.outcome,
          accepted: classifiedFocus.accepted,
          matchReason: classifiedFocus.matchReason
        };
        if (classifiedFocus.accepted) {
          if (classifiedFocus.targetWindowHandle) {
            lastTargetWindowHandle = classifiedFocus.targetWindowHandle;
          }
          lastTargetWindowProfile = buildWindowProfileFromForeground(classifiedFocus.foreground, lastTargetWindowProfile);
          focusRecoveryTarget = {
            title: classifiedFocus.foreground?.title || focusRecoveryTarget?.title || action.title || undefined,
            processName: classifiedFocus.foreground?.processName || focusRecoveryTarget?.processName || action.processName || undefined
          };
        }
      }
    }

    results.push(result);

    if (result.success && checkpointSpec?.applicable) {
      const observationCheckpoint = await verifyKeyObservationCheckpoint(checkpointSpec, checkpointBeforeForeground, {
        expectedWindowHandle: lastTargetWindowHandle
      });
      result.observationCheckpoint = observationCheckpoint;
      observationCheckpoints.push({
        ...observationCheckpoint,
        actionIndex: pending.actionIndex + i,
        key: String(action.key || '')
      });

      if (observationCheckpoint.foreground?.success) {
        const observedHwnd = Number(observationCheckpoint.foreground.hwnd || 0) || 0;
        if (observedHwnd) {
          lastTargetWindowHandle = observedHwnd;
        }
        lastTargetWindowProfile = {
          processName: observationCheckpoint.foreground.processName || lastTargetWindowProfile?.processName || undefined,
          className: observationCheckpoint.foreground.className || lastTargetWindowProfile?.className || undefined,
          windowKind: observationCheckpoint.foreground.windowKind || lastTargetWindowProfile?.windowKind || undefined,
          title: observationCheckpoint.foreground.title || lastTargetWindowProfile?.title || undefined
        };
        focusRecoveryTarget = {
          title: observationCheckpoint.foreground.title || focusRecoveryTarget?.title || undefined,
          processName: observationCheckpoint.foreground.processName || focusRecoveryTarget?.processName || undefined
        };
      }

      if (!observationCheckpoint.verified) {
        result.success = false;
        result.error = observationCheckpoint.error;
      }
    }

    if (typeof systemAutomation.getForegroundWindowHandle === 'function') {
      if (
        action.type === 'click' ||
        action.type === 'double_click' ||
        action.type === 'right_click'
      ) {
        const fg = await systemAutomation.getForegroundWindowHandle();
        if (fg) {
          lastTargetWindowHandle = fg;
        }
      }
    }
    
    if (onAction) {
      onAction(result, pending.actionIndex + i, pending.actionIndex + actionsToResume.length);
    }
    
    if (!result.success && !action.continue_on_error) {
      break;
    }
  }
  
  clearPendingAction();

  let success = results.every(r => r.success);
  let error = null;
  let focusVerification = {
    applicable: false,
    verified: true,
    drifted: false,
    attempts: 0,
    expectedWindowHandle: Number(lastTargetWindowHandle || 0) || 0
  };

  if (success) {
    focusVerification = await verifyForegroundFocus(lastTargetWindowHandle, {
      recoveryTarget: focusRecoveryTarget
    });
    if (focusVerification.applicable && !focusVerification.verified) {
      success = false;
      error = 'Focus verification could not keep the target window in the foreground';
    }
    postVerification = await verifyAndSelfHealPostActions(
      { actions: actionsToResume },
      { userMessage, actionExecutor, enablePopupRecipes }
    );
    if (postVerification.applicable && !postVerification.verified) {
      error = 'Post-action verification could not confirm target after bounded retries';
    }
  }

  if (!success && !error) {
    error = 'One or more actions failed';
  }

  updateBrowserSessionAfterExecution({ actions: actionsToResume }, {
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
    observationCheckpoints,
    focusVerification,
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

// ─── Session Persistence (N4) ──────────────────────────────

/**
 * Reflection model override (N6). When set, reflection passes
 * use this model instead of the default/action model.
 * Prefer a reasoning model (o1, o3-mini) for self-correction.
 */
let reflectionModelOverride = null;

function setReflectionModel(modelKey) {
  reflectionModelOverride = modelKey || null;
}

function getReflectionModel() {
  return reflectionModelOverride;
}

/**
 * Save an episodic memory note summarizing the current session.
 * Called on chat exit. Extracts user messages from recent history
 * as a lightweight session summary — no AI call needed.
 */
function saveSessionNote() {
  try {
    const history = historyStore.getRecentConversationHistory(20);
    const userMessages = history
      .filter(m => m.role === 'user')
      .map(m => (m.content || '').slice(0, 120));
    if (userMessages.length === 0) return null;

    const summary = userMessages.join(' | ');
    const keywords = extractTopKeywords(userMessages.join(' '), 8);

    return memoryStore.addNote({
      type: 'episodic',
      content: `Session summary (${new Date().toISOString().slice(0, 10)}): ${summary}`,
      context: { source: 'session-exit', messageCount: history.length },
      keywords,
      tags: ['session', 'episodic'],
      source: { type: 'session', timestamp: new Date().toISOString() }
    });
  } catch (err) {
    console.warn('[AI] saveSessionNote error (non-fatal):', err.message);
    return null;
  }
}

/**
 * Extract the N most frequent meaningful words from text.
 */
function extractTopKeywords(text, n) {
  const stop = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'were',
    'been', 'have', 'has', 'had', 'not', 'but', 'what', 'all', 'can', 'will', 'one', 'her', 'his',
    'they', 'its', 'any', 'which', 'would', 'there', 'their', 'said', 'each', 'she', 'how', 'use',
    'could', 'into', 'than', 'other', 'some', 'these', 'then', 'just', 'about', 'also', 'more']);
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !stop.has(w));
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, n).map(e => e[0]);
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
  rewriteActionsForReliability,
  getBrowserRecoverySnapshot,
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
  toolCallsToActions,
  getToolDefinitions,
  // Cognitive layer (v0.0.15)
  memoryStore,
  skillRouter,
  getChatContinuityState,
  getSessionIntentState,
  clearChatContinuityState,
  ingestUserIntentState,
  recordChatContinuityTurn,
  // Session persistence (N4)
  saveSessionNote,
  // Cross-model reflection (N6)
  setReflectionModel,
  getReflectionModel
};
