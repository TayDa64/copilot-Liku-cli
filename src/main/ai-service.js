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

// Shared UI watcher for live UI context (set by index.js after starting)
let uiWatcher = null;
let semanticDomSnapshot = null;
let semanticDomUpdatedAt = 0;
const SEMANTIC_DOM_MAX_DEPTH = 4;
const SEMANTIC_DOM_MAX_NODES = 120;
const SEMANTIC_DOM_MAX_CHARS = 3500;
const SEMANTIC_DOM_MAX_AGE_MS = 5000;

/**
 * Set the shared UI watcher instance (called from index.js)
 */
function setUIWatcher(watcher) {
  uiWatcher = watcher;
  console.log('[AI-SERVICE] UI Watcher connected');
}

function getUIWatcher() {
  return uiWatcher;
}

function setSemanticDOMSnapshot(tree) {
  semanticDomSnapshot = tree || null;
  semanticDomUpdatedAt = Date.now();
}

function clearSemanticDOMSnapshot() {
  semanticDomSnapshot = null;
  semanticDomUpdatedAt = 0;
}

function pruneSemanticTree(root) {
  const results = [];

  function walk(node, depth = 0) {
    if (!node || depth > SEMANTIC_DOM_MAX_DEPTH || results.length >= SEMANTIC_DOM_MAX_NODES) {
      return;
    }

    const bounds = node.bounds || {};
    const isInteractive = !!node.isClickable || !!node.isFocusable;
    const hasName = typeof node.name === 'string' && node.name.trim().length > 0;
    const hasValidBounds = [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
      && bounds.width > 0
      && bounds.height > 0;

    if ((isInteractive || hasName) && hasValidBounds) {
      results.push({
        id: node.id || '',
        name: hasName ? node.name.trim().slice(0, 64) : '',
        role: node.role || 'Unknown',
        bounds: {
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
          width: Math.round(bounds.width),
          height: Math.round(bounds.height)
        },
        isClickable: !!node.isClickable,
        isFocusable: !!node.isFocusable
      });
    }

    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        if (results.length >= SEMANTIC_DOM_MAX_NODES) break;
        walk(child, depth + 1);
      }
    }
  }

  walk(root, 0);
  return results;
}

function getSemanticDOMContextText() {
  if (!semanticDomSnapshot || !semanticDomUpdatedAt) {
    return '';
  }

  if ((Date.now() - semanticDomUpdatedAt) > SEMANTIC_DOM_MAX_AGE_MS) {
    return '';
  }

  const nodes = pruneSemanticTree(semanticDomSnapshot);
  if (!nodes.length) {
    return '';
  }

  const lines = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const namePart = node.name ? ` \"${node.name}\"` : '';
    const idPart = node.id ? ` id=${node.id}` : '';
    const flags = [node.isClickable ? 'clickable' : null, node.isFocusable ? 'focusable' : null]
      .filter(Boolean)
      .join(',');
    const flagPart = flags ? ` [${flags}]` : '';
    lines.push(
      `- [${i + 1}] ${node.role}${namePart}${idPart} at (${node.bounds.x}, ${node.bounds.y}, ${node.bounds.width}, ${node.bounds.height})${flagPart}`
    );
  }

  let text = `\n\n## Semantic DOM (grounded accessibility tree)\n${lines.join('\n')}`;
  if (text.length > SEMANTIC_DOM_MAX_CHARS) {
    text = `${text.slice(0, SEMANTIC_DOM_MAX_CHARS)}\n... (truncated)`;
  }

  return text;
}

// ===== CONFIGURATION =====

// Available models for GitHub Copilot (based on Copilot CLI changelog)
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

// Runtime-discovered Copilot models (merged with static defaults above).
const dynamicCopilotModels = {};
let copilotModelDiscoveryAttempted = false;

function modelRegistry() {
  return { ...COPILOT_MODELS, ...dynamicCopilotModels };
}

function inferVisionCapability(modelId = '') {
  const id = String(modelId || '').toLowerCase();
  if (!id) return false;
  if (/\bo1\b|\bo3-mini\b|\bo1-mini\b/.test(id)) return false;
  if (id.includes('vision')) return true;
  // Most current GPT-4.x and Claude 4.x variants in Copilot support image input.
  if (id.includes('gpt-4') || id.includes('claude')) return true;
  return false;
}

function normalizeModelKeyFromId(modelId) {
  const raw = String(modelId || '').trim().toLowerCase();
  if (!raw) return '';
  // Drop date suffixes like -20250929 so picker ids stay stable.
  return raw.replace(/-20\d{6}$/g, '');
}

function upsertDynamicCopilotModel(entry) {
  if (!entry || !entry.id) return;
  const idLower = String(entry.id).toLowerCase();
  // Keep picker focused on chat-capable model families.
  if (idLower.includes('embedding') || idLower.includes('ada-002') || idLower.startsWith('oswe-')) {
    return;
  }
  if (!/(gpt|claude|gemini|\bo1\b|\bo3\b|grok)/i.test(idLower)) {
    return;
  }
  const key = normalizeModelKeyFromId(entry.id);
  if (!key) return;
  if (COPILOT_MODELS[key]) return; // Keep curated defaults authoritative.
  dynamicCopilotModels[key] = {
    name: entry.name || entry.id,
    id: entry.id,
    vision: entry.vision ?? inferVisionCapability(entry.id)
  };
}

// Default Copilot model
let currentCopilotModel = 'gpt-4o';

const AI_PROVIDERS = {
  copilot: {
    baseUrl: 'api.githubcopilot.com',
    path: '/chat/completions',
    model: 'gpt-4o',
    visionModel: 'gpt-4o'
  },
  openai: {
    baseUrl: 'api.openai.com',
    path: '/v1/chat/completions',
    model: 'gpt-4o',
    visionModel: 'gpt-4o'
  },
  anthropic: {
    baseUrl: 'api.anthropic.com',
    path: '/v1/messages',
    model: 'claude-sonnet-4-20250514',
    visionModel: 'claude-sonnet-4-20250514'
  },
  ollama: {
    baseUrl: 'localhost',
    port: 11434,
    path: '/api/chat',
    model: 'llama3.2-vision',
    visionModel: 'llama3.2-vision'
  }
};

// GitHub Copilot OAuth Configuration
const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';

// ===== TOOL DEFINITIONS FOR NATIVE FUNCTION CALLING =====
// These map directly to the action types the system already executes.
const LIKU_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'click_element',
      description: 'Click a UI element by its visible text or name (uses Windows UI Automation). Preferred over coordinate clicks.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The visible text/name of the element to click' },
          reason: { type: 'string', description: 'Why this click is needed' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description: 'Left click at pixel coordinates on screen. Use as fallback when click_element cannot find the target.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X pixel coordinate' },
          y: { type: 'number', description: 'Y pixel coordinate' },
          reason: { type: 'string', description: 'Why clicking here' }
        },
        required: ['x', 'y']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'double_click',
      description: 'Double click at pixel coordinates.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X pixel coordinate' },
          y: { type: 'number', description: 'Y pixel coordinate' }
        },
        required: ['x', 'y']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'right_click',
      description: 'Right click at pixel coordinates to open context menu.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X pixel coordinate' },
          y: { type: 'number', description: 'Y pixel coordinate' }
        },
        required: ['x', 'y']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'type_text',
      description: 'Type text into the currently focused input field.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The text to type' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'press_key',
      description: 'Press a key or keyboard shortcut (e.g., "enter", "ctrl+c", "win+r", "alt+tab").',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key combo string (e.g., "ctrl+s", "enter", "win+d")' },
          reason: { type: 'string', description: 'Why pressing this key' }
        },
        required: ['key']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'scroll',
      description: 'Scroll up or down.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
          amount: { type: 'number', description: 'Scroll amount (default 3)' }
        },
        required: ['direction']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'drag',
      description: 'Drag from one point to another.',
      parameters: {
        type: 'object',
        properties: {
          fromX: { type: 'number' }, fromY: { type: 'number' },
          toX: { type: 'number' }, toY: { type: 'number' }
        },
        required: ['fromX', 'fromY', 'toX', 'toY']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'wait',
      description: 'Wait for a specified number of milliseconds before the next action.',
      parameters: {
        type: 'object',
        properties: {
          ms: { type: 'number', description: 'Milliseconds to wait' }
        },
        required: ['ms']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description: 'Take a screenshot to see the current screen state. Use for verification or when elements are not in the UI tree.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Execute a shell command and return output. Preferred for any file/system operations.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          cwd: { type: 'string', description: 'Working directory (optional)' },
          shell: { type: 'string', enum: ['powershell', 'cmd', 'bash'], description: 'Shell to use (default: powershell on Windows)' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'focus_window',
      description: 'Bring a window to the foreground by its handle or title.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Partial window title to match' },
          windowHandle: { type: 'number', description: 'Window handle (hwnd)' }
        }
      }
    }
  }
];

/**
 * Convert tool_calls from API response into the action block format
 * that the existing executeActions pipeline expects.
 */
function toolCallsToActions(toolCalls) {
  return toolCalls.map(tc => {
    let args;
    try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
    const name = tc.function.name;

    // Map tool names back to existing action types
    switch (name) {
      case 'click_element':  return { type: 'click_element', ...args };
      case 'click':          return { type: 'click', ...args };
      case 'double_click':   return { type: 'double_click', ...args };
      case 'right_click':    return { type: 'right_click', ...args };
      case 'type_text':      return { type: 'type', ...args };
      case 'press_key':      return { type: 'key', key: args.key, reason: args.reason };
      case 'scroll':         return { type: 'scroll', ...args };
      case 'drag':           return { type: 'drag', ...args };
      case 'wait':           return { type: 'wait', ...args };
      case 'screenshot':     return { type: 'screenshot' };
      case 'run_command':    return { type: 'run_command', ...args };
      case 'focus_window':
        if (args.title) return { type: 'bring_window_to_front', title: args.title };
        return { type: 'focus_window', windowHandle: args.windowHandle };
      default:               return { type: name, ...args };
    }
  });
}

// Current configuration
let currentProvider = 'copilot'; // Default to GitHub Copilot
let apiKeys = {
  copilot: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '',     // OAuth token
  copilotSession: '',  // Copilot session token (exchanged from OAuth)
  openai: process.env.OPENAI_API_KEY || '',
  anthropic: process.env.ANTHROPIC_API_KEY || ''
};

// Model metadata tracking
let currentModelMetadata = {
  modelId: currentCopilotModel,
  provider: currentProvider,
  modelVersion: modelRegistry()[currentCopilotModel]?.id || null,
  capabilities: modelRegistry()[currentCopilotModel]?.vision ? ['vision', 'text'] : ['text'],
  lastUpdated: new Date().toISOString()
};

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

// Token persistence path — lives inside ~/.liku-cli/ alongside Electron userData
const LIKU_HOME = path.join(os.homedir(), '.liku-cli');
const TOKEN_FILE = path.join(LIKU_HOME, 'copilot-token.json');

// OAuth state
let oauthInProgress = false;
let oauthCallback = null;

// Conversation history for context
let conversationHistory = [];
const MAX_HISTORY = 20;
const HISTORY_FILE = path.join(LIKU_HOME, 'conversation-history.json');
const MODEL_PREF_FILE = path.join(LIKU_HOME, 'model-preference.json');

// Lightweight browser continuity state (in-memory for this process).
let browserSessionState = {
  url: null,
  title: null,
  goalStatus: 'unknown', // unknown | in_progress | achieved | needs_attention
  lastStrategy: null,
  lastUserIntent: null,
  lastUpdated: null
};

function getBrowserSessionState() {
  return { ...browserSessionState };
}

function updateBrowserSessionState(patch = {}) {
  browserSessionState = {
    ...browserSessionState,
    ...patch,
    lastUpdated: new Date().toISOString()
  };
}

function resetBrowserSessionState() {
  browserSessionState = {
    url: null,
    title: null,
    goalStatus: 'unknown',
    lastStrategy: null,
    lastUserIntent: null,
    lastUpdated: new Date().toISOString()
  };
}

/**
 * Load conversation history from disk (survives process restarts)
 */
function loadConversationHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
      if (Array.isArray(data)) {
        conversationHistory = data.slice(-MAX_HISTORY * 2);
        console.log(`[AI] Restored ${conversationHistory.length} history entries from disk`);
      }
    }
  } catch (e) {
    console.warn('[AI] Could not load conversation history:', e.message);
  }
}

/**
 * Persist conversation history to disk
 */
function saveConversationHistory() {
  try {
    if (!fs.existsSync(LIKU_HOME)) {
      fs.mkdirSync(LIKU_HOME, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(conversationHistory.slice(-MAX_HISTORY * 2)), { mode: 0o600 });
  } catch (e) {
    console.warn('[AI] Could not save conversation history:', e.message);
  }
}

function saveModelPreference() {
  try {
    if (!fs.existsSync(LIKU_HOME)) {
      fs.mkdirSync(LIKU_HOME, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(
      MODEL_PREF_FILE,
      JSON.stringify({ copilotModel: currentCopilotModel, savedAt: new Date().toISOString() }),
      { mode: 0o600 }
    );
  } catch (e) {
    console.warn('[AI] Could not save model preference:', e.message);
  }
}

function loadModelPreference() {
  try {
    if (!fs.existsSync(MODEL_PREF_FILE)) {
      return;
    }
    const parsed = JSON.parse(fs.readFileSync(MODEL_PREF_FILE, 'utf-8'));
    const preferred = String(parsed?.copilotModel || '').trim().toLowerCase();
    if (!preferred) return;

    const registry = modelRegistry();
    if (registry[preferred]) {
      currentCopilotModel = preferred;
      refreshCurrentModelMetadata();
      return;
    }

    // If preference was saved as raw model id, register it dynamically and restore it.
    upsertDynamicCopilotModel({ id: preferred, name: preferred, vision: inferVisionCapability(preferred) });
    if (modelRegistry()[preferred]) {
      currentCopilotModel = preferred;
      refreshCurrentModelMetadata();
    }
  } catch (e) {
    console.warn('[AI] Could not load model preference:', e.message);
  }
}

// Restore history on module load
loadConversationHistory();
loadModelPreference();

// Visual context for AI awareness
let visualContextBuffer = [];
const MAX_VISUAL_CONTEXT = 5;

// ===== SYSTEM PROMPT =====
// Generate platform-specific context dynamically
function getPlatformContext() {
  if (PLATFORM === 'win32') {
    return `
## Platform: Windows ${OS_VERSION}

### Windows-Specific Keyboard Shortcuts (USE THESE!)
- **Open new terminal**: \`win+x\` then \`i\` (opens Windows Terminal) OR \`win+r\` then type \`wt\` then \`enter\`
- **Open Run dialog**: \`win+r\`
- **Open Start menu/Search**: \`win\` (Windows key alone)
- **Switch windows**: \`alt+tab\`
- **Show desktop**: \`win+d\`
- **File Explorer**: \`win+e\`
- **Settings**: \`win+i\`
- **Lock screen**: \`win+l\`
- **Clipboard history**: \`win+v\`
- **Screenshot**: \`win+shift+s\`

### Windows Terminal Shortcuts
- (Windows Terminal only) **New tab**: \`ctrl+shift+t\`
- (Windows Terminal only) **Close tab**: \`ctrl+shift+w\`
- **Split pane**: \`alt+shift+d\`

### Browser Tab Shortcuts (Edge/Chrome)
- **New tab**: \`ctrl+t\`
- **Close tab**: \`ctrl+w\`
- **Reopen closed tab**: \`ctrl+shift+t\`
- **Close window**: \`ctrl+shift+w\`

### Browser Automation Policy (Robust)
When the user asks to **use an existing browser window/tab** (Edge/Chrome), prefer **in-window control** (focus + keys) instead of launching processes.

- **DO NOT** use PowerShell COM \`SendKeys\` or \`Start-Process msedge\` / \`microsoft-edge:\` to control an existing tab. These are unreliable and may open new windows/tabs unexpectedly.
- **DO** use Liku actions: \`bring_window_to_front\` / \`focus_window\` + \`key\` + \`type\` + \`wait\`.
- **Chain the whole flow in one action block** so focus is maintained; avoid pausing for manual validation.

**Reliable recipes:**
- **Open a new tab in the existing Edge/Chrome window**:
  1) bring window to front
  2) wait 300–800ms
  3) \`ctrl+t\`
  4) wait 200–500ms
- **Navigate the current tab to a URL**:
  1) \`ctrl+l\` (address bar)
  2) wait 150–300ms
  3) type full URL (prefer \`https://...\`)
  4) \`enter\`
  5) wait 2000–5000ms (page load)
- **Self-heal if text drops/mis-types**: \`ctrl+l\` → \`ctrl+a\` → type again → \`enter\` (add waits)
- **YouTube search (keyboard-first)**: press \`/\` to focus search → type query → \`enter\` → wait

**Verification guidance:**
- If unsure whether the right window/tab is active, take a quick \`screenshot\` and proceed only when the browser is clearly focused.
- Validate major state changes (after focus, after navigation, after submitting search). If validation fails, retry focus + navigation (bounded retries).

### Opening a URL (Deterministic)
When the user asks to **open a website** and they do **NOT** require using an existing browser tab/window, prefer a direct OS open. This is more reliable than focus + typing.

- Use \`run_command\` (PowerShell): \`Start-Process "https://example.com"\`
- Then take a \`screenshot\` to verify the page opened.

### VS Code Integrated Browser (Simple Browser)
If the user explicitly asks for a **Microsoft integrated browser** / **VS Code integrated browser** / **Simple Browser**:
1) \`bring_window_to_front\` with \`processName: "code"\`
2) wait 300–800ms
3) \`ctrl+shift+p\` (Command Palette)
4) wait 200–400ms
5) type \`Simple Browser: Show\`
6) \`enter\`
7) wait 500–1000ms
8) type the full URL (\`https://...\`)
9) \`enter\`
10) wait 2000–5000ms, then \`screenshot\`

### Focus Rule (CRITICAL)
Before sending keyboard shortcuts, make sure the intended app window is focused.
If the overlay/chat has focus, shortcuts like \`ctrl+w\` / \`ctrl+shift+w\` may close the overlay instead of the target app.

### Target Verification (CRITICAL)
- For any action that affects a specific app (especially browsers), **verify the active window is correct before executing**.
- Prefer this sequence:
  1) Bring the target window to front (e.g., Edge)
  2) Confirm active window (title/process)
  3) Only then send keys/clicks
- If unsure, take a screenshot for confirmation.

### Browser Tab Targeting (Edge/Chrome)
- You generally **cannot safely close a specific tab by title** unless you first make that tab active.
- Prefer:
  1) Focus Edge/Chrome window
  2) Activate the tab by clicking its title in the tab strip (UIA or coordinate click)
  3) Then close tab with \`ctrl+w\`
- If the tab title is not discoverable via UI Automation, use keyboard strategies:
  - \`ctrl+1..8\` switch to tab 1..8, \`ctrl+9\` switches to last tab
  - \`ctrl+tab\` / \`ctrl+shift+tab\` cycle tabs (add waits)

### IMPORTANT: On Windows, NEVER use:
- \`cmd+space\` (that's macOS Spotlight)
- \`ctrl+alt+t\` (that's Linux terminal shortcut)`;
  } else if (PLATFORM === 'darwin') {
    return `
## Platform: macOS ${OS_VERSION}

### macOS-Specific Keyboard Shortcuts
- **Open terminal**: \`cmd+space\` then type "Terminal" then \`enter\`
- **Spotlight search**: \`cmd+space\`
- **Switch windows**: \`cmd+tab\`
- **Switch windows same app**: \`cmd+\`\`
- **Show desktop**: \`f11\` or \`cmd+mission control\`
- **Finder**: \`cmd+shift+g\`
- **Force quit**: \`cmd+option+esc\`
- **Screenshot**: \`cmd+shift+4\``;
  } else {
    return `
## Platform: Linux ${OS_VERSION}

### Linux-Specific Keyboard Shortcuts
- **Open terminal**: \`ctrl+alt+t\` (most distros)
- **Application menu**: \`super\` (Windows key)
- **Switch windows**: \`alt+tab\`
- **Show desktop**: \`super+d\`
- **File manager**: \`super+e\`
- **Screenshot**: \`print\` or \`shift+print\``;
  }
}

const SYSTEM_PROMPT = `You are Liku, an intelligent AGENTIC AI assistant integrated into a desktop overlay system with visual screen awareness AND the ability to control the user's computer.

${getPlatformContext()}

## LIVE UI AWARENESS (CRITICAL - READ THIS!)

The user will provide a **Live UI State** section in their messages. This section lists visible UI elements detected on the screen.
Format: \`- [Index] Type: "Name" at (x, y)\`

⚠️ **HOW TO USE LIVE UI STATE:**
1. **Identify Elements**: Use the numeric [Index] or Name to identify elements.
2. **Clicking**: To click an element from the list, PREFER using its coordinates provided in the entry:
   - Example Entry: \`- [42] Button: "Submit" at (500, 300)\`
   - Action: \`{"type": "click", "x": 500, "y": 300, "reason": "Click Submit button [42]"}\`
   - Alternatively: \`{"type": "click_element", "text": "Submit"}\` works if the name is unique.
3. **Context**: Group elements by their Window header to understand which application they belong to.

⚠️ **DO NOT REQUEST SCREENSHOTS** to find standard UI elements - check the Live UI State first.

### Visual Honesty Rule (CRITICAL)
- If you do NOT have a screenshot AND the user did NOT provide a Live UI State list, you MUST NOT claim you can see any windows/panels/elements.
- In that situation, either use keyboard-only deterministic steps (e.g., Command Palette workflows) or ask the user to run \`/capture\`.

**TO LIST ELEMENTS**: Read the Live UI State section and list what's there (e.g., "I see a 'Save' button at index [15]").

## Your Core Capabilities

1. **Screen Vision**: When the user captures their screen, you receive it as an image. Use this for spatial/visual tasks. For element-based tasks, the Live UI State is sufficient.

2. **SEMANTIC ELEMENT ACTIONS**: You can interact with UI elements by their text/name:
   - \`{"type": "click_element", "text": "Submit", "reason": "Click Submit button"}\` - Finds and clicks element by text

3. **Grid Coordinate System**: The screen has a dot grid overlay:
   - **Columns**: Letters A, B, C, D... (left to right), spacing 100px
   - **Rows**: Numbers 0, 1, 2, 3... (top to bottom), spacing 100px
   - **Start**: Grid is centered, so A0 is at (50, 50)
   - **Fine Grid**: Sub-labels like C3.12 refer to 25px subcells inside C3

4. **SYSTEM CONTROL - AGENTIC ACTIONS**: You can execute actions on the user's computer:
   - **Click**: Click at coordinates (use click_element when possible!)
   - **Type**: Type text into focused fields
   - **Press Keys**: Press keyboard shortcuts (platform-specific - see above!)
   - **Scroll**: Scroll up/down
   - **Drag**: Drag from one point to another

## ACTION FORMAT - CRITICAL

When the user asks you to DO something, respond with a JSON action block:

\`\`\`json
{
  "thought": "Brief explanation of what I'm about to do",
  "actions": [
    {"type": "key", "key": "win+x", "reason": "Open Windows power menu"},
    {"type": "wait", "ms": 300},
    {"type": "key", "key": "i", "reason": "Select Terminal option"}
  ],
  "verification": "A new Windows Terminal window should open"
}
\`\`\`

### Action Types:
- \`{"type": "click_element", "text": "<button text>"}\` - **PREFERRED**: Click element by text (uses Windows UI Automation)
- \`{"type": "find_element", "text": "<search text>"}\` - Find element and return its info
- \`{"type": "get_text", "text": "<window or control hint>"}\` - Read visible text from matching UI element/window
- \`{"type": "click", "x": <number>, "y": <number>}\` - Left click at pixel coordinates (use as fallback)
- \`{"type": "double_click", "x": <number>, "y": <number>}\` - Double click
- \`{"type": "right_click", "x": <number>, "y": <number>}\` - Right click
- \`{"type": "type", "text": "<string>"}\` - Type text (types into currently focused element)
- \`{"type": "key", "key": "<key combo>"}\` - Press key (e.g., "enter", "ctrl+c", "win+r", "alt+tab")
- \`{"type": "scroll", "direction": "up|down", "amount": <number>}\` - Scroll
- \`{"type": "drag", "fromX": <n>, "fromY": <n>, "toX": <n>, "toY": <n>}\` - Drag
- \`{"type": "wait", "ms": <number>}\` - Wait milliseconds (IMPORTANT: add waits between multi-step actions!)
- \`{"type": "screenshot"}\` - Take screenshot to verify result
- \`{"type": "focus_window", "windowHandle": <number>}\` - Bring a window to the foreground (use if target is in background)
- \`{"type": "bring_window_to_front", "title": "<partial title>", "processName": "<required when known>"}\` - Bring matching app to foreground. **MUST include processName when you know it** (e.g., \"msedge\", \"code\", \"explorer\"); use title only as a fallback. For regex title use \`title: "re:<pattern>"\`.
- \`{"type": "send_window_to_back", "title": "<partial title>", "processName": "<optional>"}\` - Push matching window behind others without activating
- \`{"type": "minimize_window", "title": "<partial title>", "processName": "<optional>"}\` - Minimize a specific window
- \`{"type": "restore_window", "title": "<partial title>", "processName": "<optional>"}\` - Restore a minimized window
- \`{"type": "run_command", "command": "<shell command>", "cwd": "<optional path>", "shell": "powershell|cmd|bash"}\` - **PREFERRED FOR SHELL TASKS**: Execute shell command directly and return output (timeout: 30s)

### Grid to Pixel Conversion:
- A0 → (50, 50), B0 → (150, 50), C0 → (250, 50)
- A1 → (50, 150), B1 → (150, 150), C1 → (250, 150)
- Formula: x = 50 + col_index * 100, y = 50 + row_index * 100
- Fine labels: C3.12 = x: 12.5 + (2*4+1)*25 = 237.5, y: 12.5 + (3*4+2)*25 = 362.5

## Response Guidelines

**For OBSERVATION requests** (what's at C3, describe the screen):
- Respond with natural language describing what you see
- Be specific about UI elements, text, buttons

**For ACKNOWLEDGEMENT / CHIT-CHAT messages** (e.g., "thanks", "outstanding work", "great"):
- Respond briefly in natural language.
- Do NOT output JSON action blocks.
- Do NOT request screenshots.

**For ACTION requests** (click here, type this, open that):
- **YOU MUST respond with the JSON action block — NEVER respond with only a plan or description**
- **NEVER say "Let me proceed" or "I will click" without including the actual \`\`\`json action block**
- **If the user says "proceed" or "do it", output the JSON actions immediately — do not ask again**
- Use PLATFORM-SPECIFIC shortcuts (see above!)
- Prefer \`click_element\` over coordinate clicks when targeting named UI elements
- Add \`wait\` actions between steps that need UI to update
- Add verification step to confirm success
- For low-risk deterministic tasks (e.g., open app, open URL, save file), provide the COMPLETE end-to-end action sequence in ONE JSON block (do not stop after only step 1).
- Only split into partial "step 1" plans when the task is genuinely ambiguous or high-risk.
- **If an element is NOT in the Live UI State**: first try a non-visual fallback (window focus, keyboard navigation, search/type) and only request \`{"type": "screenshot"}\` as a LAST resort when those fail or the user explicitly asks for visual verification.
- **If user asks about popup/dialog options**: do NOT ask for screenshot first. Try 
  1) focus target window, 
  2) \`find_element\`/\`get_text\` for dialog text and common buttons, 
  3) only then request screenshot as last resort.
- **If user asks to choose/play/select the "top/highest/best/most" result**: do NOT ask for screenshot first. Use non-visual strategies in this order:
  1) apply site-native sort/filter controls,
  2) use URL/query + \`run_command\` to resolve ranking from structured page data when possible,
  3) perform deterministic selection action,
  4) request screenshot only if all non-visual attempts fail.
- **Continuity rule**: if the active page title or recent action output indicates the requested browser objective is already achieved, acknowledge completion and avoid proposing additional screenshot steps.
- **If you need to interact with web content inside an app** (like VS Code panels, browser tabs): Use keyboard shortcuts or coordinate-based clicks since web UI may not appear in UIA tree

**Common Task Patterns**:
${PLATFORM === 'win32' ? `
- **Run shell commands**: Use \`run_command\` action - e.g., \`{"type": "run_command", "command": "Get-Process | Select-Object -First 5"}\`
- **List files**: \`{"type": "run_command", "command": "dir", "cwd": "C:\\\\Users"}\` or \`{"type": "run_command", "command": "Get-ChildItem"}\`
- **Open terminal GUI**: Use \`win+x\` then \`i\` (or \`win+r\` → type "wt" → \`enter\`) - only if user wants visible terminal
- **Open application**: Use \`win\` key, type app name, press \`enter\`
- **Save file**: \`ctrl+s\`
- **Copy/Paste**: \`ctrl+c\` / \`ctrl+v\`` : PLATFORM === 'darwin' ? `
- **Run shell commands**: Use \`run_command\` action - e.g., \`{"type": "run_command", "command": "ls -la", "shell": "bash"}\`
- **Open terminal GUI**: \`cmd+space\`, type "Terminal", \`enter\` - only if user wants visible terminal
- **Open application**: \`cmd+space\`, type app name, \`enter\`
- **Save file**: \`cmd+s\`
- **Copy/Paste**: \`cmd+c\` / \`cmd+v\`` : `
- **Run shell commands**: Use \`run_command\` action - e.g., \`{"type": "run_command", "command": "ls -la", "shell": "bash"}\`
- **Open terminal GUI**: \`ctrl+alt+t\` - only if user wants visible terminal
- **Open application**: \`super\` key, type name, \`enter\`
- **Save file**: \`ctrl+s\`
- **Copy/Paste**: \`ctrl+c\` / \`ctrl+v\``}

Be precise, use platform-correct shortcuts, and execute actions confidently!

## CRITICAL RULES
1. **NEVER describe actions without executing them.** If the user asks you to click/type/open something, output the JSON action block.
2. **NEVER say "Let me proceed" or "I'll do this now" without the JSON block.** Words without actions are useless.
3. **If user says "proceed" or "go ahead", output the JSON actions IMMEDIATELY.**
4. **For window switching**: when using 
  \`bring_window_to_front\` / \`send_window_to_back\` / \`minimize_window\` / \`restore_window\`, you **MUST include \`processName\` when you know it** (e.g., \"msedge\", \"code\"). Title-only matching is a fallback.
5. **When you can't find an element in Live UI State, first use non-visual fallback actions; request screenshot only as last resort.** Don't give up.
6. **One response = one action block.** Don't split actions across multiple messages unless the user asks you to wait.`;

/**
 * Set the AI provider
 */
function setProvider(provider) {
  if (AI_PROVIDERS[provider]) {
    currentProvider = provider;
    currentModelMetadata.provider = provider;
    currentModelMetadata.lastUpdated = new Date().toISOString();
    return true;
  }
  return false;
}

/**
 * Set API key for a provider
 */
function setApiKey(provider, key) {
  if (apiKeys.hasOwnProperty(provider)) {
    apiKeys[provider] = key;
    return true;
  }
  return false;
}

/**
 * Set the Copilot model
 */
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

/**
 * Resolve a requested Copilot model key to a valid configured key.
 */
function resolveCopilotModelKey(requestedModel) {
  const registry = modelRegistry();
  if (requestedModel && registry[requestedModel]) {
    return requestedModel;
  }
  return currentCopilotModel;
}

/**
 * Get available Copilot models
 */
function getCopilotModels() {
  return Object.entries(modelRegistry()).map(([key, value]) => ({
    id: key,
    name: value.name,
    vision: value.vision,
    current: key === currentCopilotModel
  }));
}

function loadCopilotTokenIfNeeded() {
  if (apiKeys.copilot) return true;
  return loadCopilotToken();
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
      res.on('data', chunk => body += chunk);
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

async function discoverCopilotModels(force = false) {
  if (copilotModelDiscoveryAttempted && !force) return getCopilotModels();
  copilotModelDiscoveryAttempted = true;

  if (!loadCopilotTokenIfNeeded()) {
    return getCopilotModels();
  }

  if (!apiKeys.copilotSession) {
    try {
      await exchangeForCopilotSession();
    } catch {
      return getCopilotModels();
    }
  }

  const headers = {
    'Authorization': `Bearer ${apiKeys.copilotSession}`,
    'Accept': 'application/json',
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
        const capabilities = Array.isArray(row.capabilities) ? row.capabilities.map(c => String(c).toLowerCase()) : [];
        upsertDynamicCopilotModel({
          id,
          name: row.display_name || row.name || id,
          vision: capabilities.includes('vision') ? true : inferVisionCapability(id)
        });
      }
    } catch {
      // Best-effort discovery; ignore endpoint-specific failures.
    }
  }

  return getCopilotModels();
}

/**
 * Get current model metadata
 */
function getModelMetadata() {
  return {
    ...currentModelMetadata,
    sessionToken: apiKeys.copilotSession ? 'present' : 'absent'
  };
}

/**
 * Get current Copilot model
 */
function getCurrentCopilotModel() {
  return currentCopilotModel;
}

/**
 * Add visual context (screenshot data) as a typed VisualFrame
 * @param {Object} imageData - Raw image data with dataURL, width, height, etc.
 */
function addVisualContext(imageData) {
  const { createVisualFrame } = require('../shared/inspect-types');
  const frame = createVisualFrame(imageData);
  frame.addedAt = Date.now();
  visualContextBuffer.push(frame);

  // Keep only recent visual context
  while (visualContextBuffer.length > MAX_VISUAL_CONTEXT) {
    visualContextBuffer.shift();
  }
}

/**
 * Get the latest visual context
 */
function getLatestVisualContext() {
  return visualContextBuffer.length > 0 
    ? visualContextBuffer[visualContextBuffer.length - 1] 
    : null;
}

/**
 * Clear visual context
 */
function clearVisualContext() {
  visualContextBuffer = [];
}

/**
 * Build messages array for API call
 */
async function buildMessages(userMessage, includeVisual = false, options = {}) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  const { extraSystemMessages = [] } = options || {};

  // Preference injection (Gemini-aligned): inject only the rules that apply to the
  // active app/window, falling back to a small global summary.
  try {
    let prefText = '';
    if (typeof systemAutomation.getForegroundWindowInfo === 'function') {
      const fg = await systemAutomation.getForegroundWindowInfo();
      if (fg && fg.success && fg.processName) {
        prefText = preferences.getPreferencesSystemContextForApp(fg.processName);
      }
    }
    if (!prefText) {
      prefText = preferences.getPreferencesSystemContext();
    }
    if (prefText && prefText.trim()) {
      messages.push({ role: 'system', content: prefText.trim() });
    }
  } catch {}

  // Extra system steering (e.g., policy violations / regeneration instructions)
  try {
    if (Array.isArray(extraSystemMessages)) {
      for (const msg of extraSystemMessages) {
        if (typeof msg === 'string' && msg.trim()) {
          messages.push({ role: 'system', content: msg.trim() });
        }
      }
    }
  } catch {}

  // Explicit browser continuity state to reduce drift between turns.
  try {
    const state = getBrowserSessionState();
    if (state.lastUpdated) {
      const continuity = [
        '## Browser Session State',
        `- url: ${state.url || 'unknown'}`,
        `- title: ${state.title || 'unknown'}`,
        `- goalStatus: ${state.goalStatus || 'unknown'}`,
        `- lastStrategy: ${state.lastStrategy || 'none'}`,
        `- lastUserIntent: ${state.lastUserIntent || 'none'}`,
        '- Rule: If goalStatus is achieved and user intent is acknowledgement/chit-chat, do not propose actions or screenshots.'
      ].join('\n');
      messages.push({ role: 'system', content: continuity });
    }
  } catch {}

  // Add conversation history
  conversationHistory.slice(-MAX_HISTORY).forEach(msg => {
    messages.push(msg);
  });

  // Build user message with optional visual and inspect context
  const latestVisual = includeVisual ? getLatestVisualContext() : null;
  
  // Get inspect context if inspect mode is active
  let inspectContextText = '';
  try {
    const inspect = getInspectService();
    if (inspect.isInspectModeActive()) {
      const inspectContext = inspect.generateAIContext();
      if (inspectContext.regions && inspectContext.regions.length > 0) {
        inspectContextText = `\n\n## Detected UI Regions (Inspect Mode)
${inspectContext.regions.slice(0, 20).map((r, i) => 
  `${i + 1}. **${r.label || 'Unknown'}** (${r.role}) at (${r.center.x}, ${r.center.y}) - confidence: ${Math.round(r.confidence * 100)}%`
).join('\n')}

**Note**: Use the coordinates provided above for precise targeting. If confidence is below 70%, verify with user before clicking.`;
        
        // Add window context if available
        if (inspectContext.windowContext) {
          inspectContextText += `\n\n## Active Window
- App: ${inspectContext.windowContext.appName || 'Unknown'}
- Title: ${inspectContext.windowContext.windowTitle || 'Unknown'}
- Scale Factor: ${inspectContext.windowContext.scaleFactor || 1}`;
        }
      }
    }
  } catch (e) {
    console.warn('[AI] Could not get inspect context:', e.message);
  }
  
  // Get live UI context from the UI watcher (always-on mirror)
  let liveUIContextText = '';
  try {
    const watcher = getUIWatcher();
    if (watcher && watcher.isPolling) {
      const uiContext = watcher.getContextForAI();
      if (uiContext && uiContext.trim()) {
        // Frame the context as trustworthy real-time data
        liveUIContextText = `\n\n---\n🔴 **LIVE UI STATE** (auto-refreshed every 400ms - TRUST THIS DATA!)\n${uiContext}\n---`;
        console.log('[AI] Including live UI context from watcher (', uiContext.split('\n').length, 'lines)');
      }
    } else {
      console.log('[AI] UI Watcher not available or not running (watcher:', !!watcher, ', polling:', watcher?.isPolling, ')');
    }
  } catch (e) {
    console.warn('[AI] Could not get live UI context:', e.message);
  }

  const semanticDOMContextText = getSemanticDOMContextText();
  
  const enhancedMessage = inspectContextText || liveUIContextText || semanticDOMContextText
    ? `${userMessage}${inspectContextText}${liveUIContextText}${semanticDOMContextText}` 
    : userMessage;

  if (latestVisual && (currentProvider === 'copilot' || currentProvider === 'openai')) {
    // OpenAI/Copilot vision format (both use same API format)
    console.log('[AI] Including visual context in message (provider:', currentProvider, ')');
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: enhancedMessage },
        {
          type: 'image_url',
          image_url: {
            url: latestVisual.dataURL,
            detail: 'high'
          }
        }
      ]
    });
  } else if (latestVisual && currentProvider === 'anthropic') {
    // Anthropic vision format
    const base64Data = latestVisual.dataURL.replace(/^data:image\/\w+;base64,/, '');
    messages.push({
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: base64Data
          }
        },
        { type: 'text', text: enhancedMessage }
      ]
    });
  } else if (latestVisual && currentProvider === 'ollama') {
    // Ollama vision format
    const base64Data = latestVisual.dataURL.replace(/^data:image\/\w+;base64,/, '');
    messages.push({
      role: 'user',
      content: enhancedMessage,
      images: [base64Data]
    });
  } else {
    messages.push({
      role: 'user',
      content: enhancedMessage
    });
  }

  return messages;
}

function isCoordinateInteractionAction(action) {
  if (!action || typeof action !== 'object') return false;
  const raw = String(action.type || '').toLowerCase();
  const t = raw === 'press_key' || raw === 'presskey'
    ? 'key'
    : raw === 'type_text' || raw === 'typetext'
      ? 'type'
      : raw;
  const coordinateTypes = new Set(['click', 'double_click', 'right_click', 'drag', 'move_mouse']);
  if (!coordinateTypes.has(t)) return false;
  const hasXY = Number.isFinite(Number(action.x)) && Number.isFinite(Number(action.y));
  const hasFromTo = Number.isFinite(Number(action.fromX)) && Number.isFinite(Number(action.fromY))
    && Number.isFinite(Number(action.toX)) && Number.isFinite(Number(action.toY));
  return hasXY || hasFromTo;
}

function checkNegativePolicies(actionData, negativePolicies = []) {
  const actions = actionData?.actions;
  if (!Array.isArray(actions) || !Array.isArray(negativePolicies) || negativePolicies.length === 0) {
    return { ok: true, violations: [] };
  }

  const violations = [];

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const raw = String(action?.type || '').toLowerCase();
    const actionType = raw === 'press_key' || raw === 'presskey'
      ? 'key'
      : raw === 'type_text' || raw === 'typetext'
        ? 'type'
        : raw;

    for (const policy of negativePolicies) {
      if (!policy || typeof policy !== 'object') continue;

      const intent = policy.intent ? String(policy.intent).trim().toLowerCase() : '';
      if (intent && intent !== actionType) {
        continue;
      }

      const forbiddenTypes = Array.isArray(policy.forbiddenActionTypes)
        ? policy.forbiddenActionTypes.map(x => String(x).trim().toLowerCase()).filter(Boolean)
        : [];
      if (forbiddenTypes.length && forbiddenTypes.includes(actionType)) {
        violations.push({
          policy,
          actionIndex: i,
          action,
          reason: policy.reason || `Action type "${actionType}" is forbidden by user policy`
        });
        continue;
      }

      const forbiddenMethod = policy.forbiddenMethod ? String(policy.forbiddenMethod).trim().toLowerCase() : '';
      if (!forbiddenMethod) continue;

      if (['click_coordinates', 'coordinate_click', 'coordinates', 'coord_click'].includes(forbiddenMethod)) {
        if (isCoordinateInteractionAction(action)) {
          violations.push({
            policy,
            actionIndex: i,
            action,
            reason: policy.reason || 'Coordinate-based interactions are forbidden by user policy'
          });
        }
      }

      if (['simulated_keystrokes', 'type_simulated_keystrokes'].includes(forbiddenMethod)) {
        if (actionType === 'type') {
          violations.push({
            policy,
            actionIndex: i,
            action,
            reason: policy.reason || 'Simulated typing is forbidden by user policy'
          });
        }
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

function isClickLikeActionType(actionType) {
  const t = String(actionType || '').toLowerCase();
  return ['click', 'double_click', 'right_click', 'click_element'].includes(t);
}

function checkActionPolicies(actionData, actionPolicies = []) {
  const actions = actionData?.actions;
  if (!Array.isArray(actions) || !Array.isArray(actionPolicies) || actionPolicies.length === 0) {
    return { ok: true, violations: [] };
  }

  const violations = [];

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const raw = String(action?.type || '').toLowerCase();
    const actionType = raw === 'press_key' || raw === 'presskey'
      ? 'key'
      : raw === 'type_text' || raw === 'typetext'
        ? 'type'
        : raw;

    for (const policy of actionPolicies) {
      if (!policy || typeof policy !== 'object') continue;
      const intent = String(policy.intent || '').trim().toLowerCase();
      if (!intent) continue;

      const applies =
        (intent === 'click_element' && isClickLikeActionType(actionType)) ||
        (intent === 'click' && isClickLikeActionType(actionType)) ||
        (intent === actionType);
      if (!applies) continue;

      const matchPref = String(policy.matchPreference || '').trim().toLowerCase();
      const preferredMethod = String(policy.preferredMethod || '').trim().toLowerCase();

      if (intent === 'click_element' && isClickLikeActionType(actionType)) {
        if (actionType !== 'click_element') {
          violations.push({
            policy,
            actionIndex: i,
            action,
            reason:
              policy.reason ||
              'User prefers click_element for click intents in this app (no coordinate clicks or generic click types)'
          });
          continue;
        }

        if (matchPref === 'exact_text' || matchPref === 'exact') {
          const exact = action?.exact === true;
          const text = typeof action?.text === 'string' ? action.text.trim() : '';
          if (!text || !exact) {
            violations.push({
              policy,
              actionIndex: i,
              action,
              reason:
                policy.reason ||
                'User prefers exact_text matching for click_element in this app (set exact=true and provide text)'
            });
            continue;
          }
        }

        if (preferredMethod && preferredMethod !== 'click_element') {
          violations.push({
            policy,
            actionIndex: i,
            action,
            reason: policy.reason || `User prefers method=${preferredMethod} for click_element in this app`
          });
          continue;
        }
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

function formatActionPolicyViolationSystemMessage(processName, violations) {
  const app = processName ? String(processName) : 'unknown-app';
  const lines = [];
  lines.push('POLICY ENFORCEMENT: The previous action plan is REJECTED.');
  lines.push(`Active app: ${app}`);
  lines.push('Reason(s):');
  for (const v of violations.slice(0, 6)) {
    const idx = typeof v.actionIndex === 'number' ? v.actionIndex : -1;
    const t = v.action?.type ? String(v.action.type) : 'unknown';
    lines.push(`- Action[${idx}] type=${t}: ${v.reason}`);
  }
  lines.push('You MUST regenerate a compliant plan.');
  lines.push('Hard requirements:');
  lines.push('- If the user prefers exact_text clicks: use click_element with exact=true and a concrete text label.');
  lines.push('- Do not replace click_element with coordinate clicks for this app.');
  lines.push('- Respond ONLY with a JSON code block (```json ... ```): { thought, actions, verification }.');
  return lines.join('\n');
}

function formatNegativePolicyViolationSystemMessage(processName, violations) {
  const app = processName ? String(processName) : 'unknown-app';
  const lines = [];
  lines.push(`POLICY ENFORCEMENT: The previous action plan is REJECTED.`);
  lines.push(`Active app: ${app}`);
  lines.push('Reason(s):');
  for (const v of violations.slice(0, 6)) {
    const idx = typeof v.actionIndex === 'number' ? v.actionIndex : -1;
    const t = v.action?.type ? String(v.action.type) : 'unknown';
    lines.push(`- Action[${idx}] type=${t}: ${v.reason}`);
  }
  lines.push('You MUST regenerate a compliant plan.');
  lines.push('Hard requirements:');
  lines.push('- Do not use forbidden methods for this app.');
  lines.push('- Prefer UIA/semantic actions (e.g., click_element) over coordinate clicks.');
  lines.push('- Respond ONLY with a JSON code block (```json ... ```): { thought, actions, verification }.');
  return lines.join('\n');
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
        } catch (e) {
          reject(new Error('Invalid response from GitHub'));
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Poll GitHub for access token after user authorizes
 */
function pollForToken(deviceCode, interval) {
  const poll = () => {
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
          const result = JSON.parse(body);
          
          if (result.access_token) {
            // Success!
            console.log('[COPILOT] OAuth successful!');
            apiKeys.copilot = result.access_token;
            saveCopilotToken(result.access_token);
            oauthInProgress = false;
            
            if (oauthCallback) {
              oauthCallback({ success: true, message: 'GitHub Copilot authenticated!' });
              oauthCallback = null;
            }
          } else if (result.error === 'authorization_pending') {
            // User hasn't authorized yet, keep polling
            setTimeout(poll, interval * 1000);
          } else if (result.error === 'slow_down') {
            // Rate limited, slow down
            setTimeout(poll, (interval + 5) * 1000);
          } else if (result.error === 'expired_token') {
            oauthInProgress = false;
            if (oauthCallback) {
              oauthCallback({ success: false, message: 'Authorization expired. Try /login again.' });
              oauthCallback = null;
            }
          } else {
            oauthInProgress = false;
            if (oauthCallback) {
              oauthCallback({ success: false, message: result.error_description || 'OAuth failed' });
              oauthCallback = null;
            }
          }
        } catch (e) {
          // Parse error, retry
          setTimeout(poll, interval * 1000);
        }
      });
    });

    req.on('error', () => setTimeout(poll, interval * 1000));
    req.write(data);
    req.end();
  };

  setTimeout(poll, interval * 1000);
}

/**
 * Exchange OAuth token for Copilot session token
 * Required because the OAuth token alone can't call Copilot API directly
 */
function exchangeForCopilotSession() {
  return new Promise((resolve, reject) => {
    if (!apiKeys.copilot) {
      return reject(new Error('No OAuth token available'));
    }

    console.log('[Copilot] Exchanging OAuth token for session token...');
    console.log('[Copilot] OAuth token prefix:', apiKeys.copilot.substring(0, 10) + '...');

    // First try the Copilot internal endpoint
    const options = {
      hostname: 'api.github.com',
      path: '/copilot_internal/v2/token',
      method: 'GET',
      headers: {
        'Authorization': `token ${apiKeys.copilot}`,
        'Accept': 'application/json',
        'User-Agent': 'GithubCopilot/1.155.0',
        'Editor-Version': 'vscode/1.96.0',
        'Editor-Plugin-Version': 'copilot-chat/0.22.0'
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        console.log('[Copilot] Token exchange response:', res.statusCode);
        console.log('[Copilot] Response body preview:', body.substring(0, 200));
        
        if (res.statusCode === 401 || res.statusCode === 403) {
          console.log('[Copilot] Token exchange got', res.statusCode, '- will use OAuth token directly');
          apiKeys.copilotSession = apiKeys.copilot;
          return resolve(apiKeys.copilot);
        }
        
        try {
          const result = JSON.parse(body);
          if (result.token) {
            apiKeys.copilotSession = result.token;
            console.log('[Copilot] Session token obtained successfully, expires:', result.expires_at);
            console.log('[Copilot] Session token prefix:', result.token.substring(0, 15) + '...');
            resolve(result.token);
          } else if (result.message) {
            console.log('[Copilot] API message:', result.message);
            apiKeys.copilotSession = apiKeys.copilot;
            resolve(apiKeys.copilot);
          } else {
            console.log('[Copilot] Unexpected response format, using OAuth token');
            apiKeys.copilotSession = apiKeys.copilot;
            resolve(apiKeys.copilot);
          }
        } catch (e) {
          console.log('[Copilot] Token exchange parse error:', e.message);
          apiKeys.copilotSession = apiKeys.copilot;
          resolve(apiKeys.copilot);
        }
      });
    });

    req.on('error', (e) => {
      console.log('[Copilot] Token exchange network error:', e.message);
      apiKeys.copilotSession = apiKeys.copilot;
      resolve(apiKeys.copilot);
    });
    
    req.end();
  });
}

/**
 * Call GitHub Copilot API
 * Uses session token (not OAuth token) - exchanges if needed
 */
async function callCopilot(messages, modelOverride = null, requestOptions = {}) {
  // Ensure we have OAuth token
  if (!loadCopilotTokenIfNeeded()) {
    throw new Error('Not authenticated. Use /login to authenticate with GitHub Copilot.');
  }

  // Exchange for session token if we don't have one
  if (!apiKeys.copilotSession) {
    try {
      await exchangeForCopilotSession();
    } catch (e) {
      throw new Error(`Session token exchange failed: ${e.message}`);
    }
  }

  // Best effort: discover any newly available Copilot models for /model picker.
  discoverCopilotModels().catch(() => {});

  return new Promise((resolve, reject) => {
    const hasVision = messages.some(m => Array.isArray(m.content));
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

      // Structured outputs (OpenAI-compatible) for strict JSON schema.
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

    // Try multiple endpoint formats
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
      
      // CRITICAL: Add vision header for image requests
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
    let response;
    let effectiveModel = currentCopilotModel;
    
    // Build fallback chain: current provider first, then remaining in priority order
    const fallbackChain = [currentProvider, ...PROVIDER_FALLBACK_ORDER.filter(p => p !== currentProvider)];
    let lastError = null;
    let usedProvider = currentProvider;

    for (const provider of fallbackChain) {
      try {
        switch (provider) {
          case 'copilot':
            if (!apiKeys.copilot) {
              if (!loadCopilotToken()) {
                throw new Error('Not authenticated with GitHub Copilot.');
              }
            }
            effectiveModel = resolveCopilotModelKey(model);
            const availableModels = modelRegistry();
            if (includeVisualContext && availableModels[effectiveModel] && !availableModels[effectiveModel].vision) {
              const visionFallback = AI_PROVIDERS.copilot.visionModel || 'gpt-4o';
              console.log(`[AI] Model ${effectiveModel} lacks vision, upgrading to ${visionFallback} for visual context`);
              effectiveModel = visionFallback;
            }
            response = await callCopilot(messages, effectiveModel);
            break;
          case 'openai':
            if (!apiKeys.openai) throw new Error('OpenAI API key not set.');
            response = await callOpenAI(messages);
            break;
          case 'anthropic':
            if (!apiKeys.anthropic) throw new Error('Anthropic API key not set.');
            response = await callAnthropic(messages);
            break;
          case 'ollama':
          default:
            response = await callOllama(messages);
            break;
        }
        usedProvider = provider;
        if (usedProvider !== currentProvider) {
          console.log(`[AI] Fallback: ${currentProvider} failed, succeeded with ${usedProvider}`);
        }
        break; // success — exit fallback loop
      } catch (providerErr) {
        lastError = providerErr;
        console.warn(`[AI] Provider ${provider} failed: ${providerErr.message}`);
        continue; // try next provider
      }
    }

    if (!response) {
      throw lastError || new Error('All AI providers failed.');
    }

    // Auto-continuation for truncated responses
    let fullResponse = response;
    let continuationCount = 0;
    
    while (detectTruncation(fullResponse) && continuationCount < maxContinuations) {
      continuationCount++;
      console.log(`[AI] Response appears truncated, continuing (${continuationCount}/${maxContinuations})...`);
      
      // Add partial response to history temporarily
      conversationHistory.push({ role: 'assistant', content: fullResponse });
      
      // Build continuation request
      const continueMessages = await buildMessages('Continue from where you left off. Do not repeat what you already said.', false);
      
      try {
        let continuation;
        switch (currentProvider) {
          case 'copilot':
            continuation = await callCopilot(continueMessages, effectiveModel);
            break;
          case 'openai':
            continuation = await callOpenAI(continueMessages);
            break;
          case 'anthropic':
            continuation = await callAnthropic(continueMessages);
            break;
          case 'ollama':
          default:
            continuation = await callOllama(continueMessages);
        }
        
        // Append continuation
        fullResponse += '\n' + continuation;
        
        // Update history with combined response
        conversationHistory.pop(); // Remove partial
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
        const forced = await callCopilot(forcedMessages, effectiveModel);
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
            let regenerated;
            switch (usedProvider) {
              case 'copilot':
                regenerated = await callCopilot(regenMessages, effectiveModel);
                break;
              case 'openai':
                regenerated = await callOpenAI(regenMessages);
                break;
              case 'anthropic':
                regenerated = await callAnthropic(regenMessages);
                break;
              case 'ollama':
              default:
                regenerated = await callOllama(regenMessages);
                break;
            }

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
    conversationHistory.push({ role: 'user', content: enhancedMessage });
    conversationHistory.push({ role: 'assistant', content: response });

    // Trim history if too long
    while (conversationHistory.length > MAX_HISTORY * 2) {
      conversationHistory.shift();
    }

    // Persist to disk for session continuity
    saveConversationHistory();

    return {
      success: true,
      message: response,
      provider: usedProvider,
      model: effectiveModel,
      modelVersion: modelRegistry()[effectiveModel]?.id || null,
      hasVisualContext: includeVisualContext && visualContextBuffer.length > 0
    };

  } catch (error) {
    return {
      success: false,
      error: error.message,
      provider: currentProvider,
      model: resolveCopilotModelKey(model)
    };
  }
}

function extractJsonObjectFromText(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const s = text.trim();
  const fence = s.match(/```json\s*([\s\S]*?)\s*```/i);
  const candidate = fence ? fence[1] : s;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = candidate.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

function sanitizePreferencePatch(patch) {
  const safe = {};
  if (!patch || typeof patch !== 'object') return safe;

  // Accept either:
  // - new format: { newRules: [ { type: 'negative'|'action', ... } ] }
  // - legacy wrapper: { newRules: { negativePolicies, actionPolicies } }
  // - direct patch: { negativePolicies, actionPolicies }
  const source = patch && patch.newRules !== undefined ? patch.newRules : patch;

  if (Array.isArray(source)) {
    const negativePolicies = [];
    const actionPolicies = [];

    for (const rule of source) {
      if (!rule || typeof rule !== 'object') continue;
      const type = String(rule.type || '').trim().toLowerCase();

      if (type === 'negative') {
        const out = {};
        if (rule.intent) out.intent = String(rule.intent);
        if (rule.forbiddenActionType) out.forbiddenActionTypes = [String(rule.forbiddenActionType)];
        if (Array.isArray(rule.forbiddenActionTypes)) out.forbiddenActionTypes = rule.forbiddenActionTypes.map(x => String(x));
        if (rule.forbiddenMethod) out.forbiddenMethod = String(rule.forbiddenMethod);
        if (rule.reason) out.reason = String(rule.reason);
        if (Object.keys(out).length) negativePolicies.push(out);
      }

      if (type === 'action') {
        const out = {};
        if (rule.intent) out.intent = String(rule.intent);
        if (rule.preferredMethod) out.preferredMethod = String(rule.preferredMethod);
        if (rule.matchPreference) out.matchPreference = String(rule.matchPreference);
        if (rule.reason) out.reason = String(rule.reason);
        if (Object.keys(out).length) actionPolicies.push(out);
      }
    }

    if (negativePolicies.length) safe.negativePolicies = negativePolicies;
    if (actionPolicies.length) safe.actionPolicies = actionPolicies;
    return safe;
  }

  const unwrapped = source && typeof source === 'object' ? source : patch;

  if (Array.isArray(unwrapped.negativePolicies)) {
    safe.negativePolicies = unwrapped.negativePolicies
      .filter(p => p && typeof p === 'object')
      .map(p => {
        const out = {};
        if (p.intent) out.intent = String(p.intent);
        if (p.forbiddenActionType) out.forbiddenActionTypes = [String(p.forbiddenActionType)];
        if (Array.isArray(p.forbiddenActionTypes)) out.forbiddenActionTypes = p.forbiddenActionTypes.map(x => String(x));
        if (p.forbiddenMethod) out.forbiddenMethod = String(p.forbiddenMethod);
        if (p.reason) out.reason = String(p.reason);
        return out;
      })
      .filter(p => Object.keys(p).length > 0);
  }

  if (Array.isArray(unwrapped.actionPolicies)) {
    safe.actionPolicies = unwrapped.actionPolicies
      .filter(p => p && typeof p === 'object')
      .map(p => {
        const out = {};
        if (p.intent) out.intent = String(p.intent);
        if (Array.isArray(p.preferredActionTypes)) out.preferredActionTypes = p.preferredActionTypes.map(x => String(x));
        if (p.preferredMethod) out.preferredMethod = String(p.preferredMethod);
        if (p.matchPreference) out.matchPreference = String(p.matchPreference);
        if (p.reason) out.reason = String(p.reason);
        return out;
      })
      .filter(p => Object.keys(p).length > 0);
  }

  return safe;
}

function validatePreferenceParserPayload(payload) {
  if (!payload || typeof payload !== 'object') return 'Output must be an object';
  const rules = payload.newRules;
  if (!Array.isArray(rules) || rules.length === 0) return 'newRules must be a non-empty array';

  let sawAny = false;
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') return 'newRules entries must be objects';
    const type = String(rule.type || '').trim().toLowerCase();
    if (type !== 'negative' && type !== 'action') return 'newRules.type must be "negative" or "action"';
    sawAny = true;

    if (type === 'negative') {
      const hasForbiddenMethod = typeof rule.forbiddenMethod === 'string' && rule.forbiddenMethod.trim();
      const hasForbiddenActionType = typeof rule.forbiddenActionType === 'string' && rule.forbiddenActionType.trim();
      const hasForbiddenActionTypes = Array.isArray(rule.forbiddenActionTypes) && rule.forbiddenActionTypes.length > 0;
      if (!hasForbiddenMethod && !hasForbiddenActionType && !hasForbiddenActionTypes) {
        return 'negative rules must include forbiddenMethod or forbiddenActionType(s)';
      }
    }

    if (type === 'action') {
      const hasIntent = typeof rule.intent === 'string' && rule.intent.trim();
      if (!hasIntent) return 'action rules must include intent';
      const hasPreferredMethod = typeof rule.preferredMethod === 'string' && rule.preferredMethod.trim();
      const hasMatchPreference = typeof rule.matchPreference === 'string' && rule.matchPreference.trim();
      if (!hasPreferredMethod || !hasMatchPreference) {
        return 'action rules must include preferredMethod and matchPreference';
      }
    }
  }

  if (!sawAny) return 'Must include at least one rule';
  return null;
}

async function parsePreferenceCorrection(naturalLanguage, context = {}) {
  const correction = String(naturalLanguage || '').trim();
  if (!correction) return { success: false, error: 'Missing correction text' };

  const processName = context.processName ? String(context.processName) : '';
  const title = context.title ? String(context.title) : '';

  const parserSystem = [
    'You are Preference Parser for a UI automation agent.',
    'Convert the user\'s natural-language correction into a JSON patch for the app-specific preferences store.',
    '',
    'Return STRICT JSON only (no markdown, no commentary).',
    'You MUST return an object with a top-level key "newRules" that is an ARRAY of rule objects.',
    'Each rule MUST include: type = "negative" OR "action".',
    '',
    'For type="negative" rules:',
    '- forbiddenMethod: string (e.g., click_coordinates, simulated_keystrokes)',
    '- forbiddenActionType: string (single) OR forbiddenActionTypes: string[] (e.g., ["click","drag","type"])',
    '- intent: optional string to scope by action type',
    '- reason: string',
    '',
    'For type="action" rules:',
    '- intent: REQUIRED string (e.g., "click_element", "type")',
    '- preferredMethod: REQUIRED string (e.g., "click_element")',
    '- matchPreference: REQUIRED string (e.g., "exact_text")',
    '- reason: string',
    '',
    'If the correction is about forbidding coordinate clicks, emit a type="negative" rule with forbiddenMethod="click_coordinates".',
    'If the correction is about avoiding simulated typing, emit a type="negative" rule with forbiddenMethod="simulated_keystrokes" and/or forbiddenActionTypes including "type".',
    'If the correction is about exact element matching for clicks, emit a type="action" rule with intent="click_element", preferredMethod="click_element", matchPreference="exact_text".'
  ].join('\n');

  const user = [
    `app.processName=${processName || 'unknown'}`,
    title ? `app.title=${title}` : null,
    `correction=${correction}`
  ].filter(Boolean).join('\n');

  const messages = [
    { role: 'system', content: parserSystem },
    { role: 'user', content: user }
  ];

  const structuredResponseFormat = {
    type: 'json_schema',
    json_schema: {
      name: 'preference_parser_patch',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['newRules'],
        properties: {
          newRules: {
            type: 'array',
            minItems: 1,
            items: {
              oneOf: [
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['type'],
                  properties: {
                    type: { const: 'negative' },
                    intent: { type: 'string' },
                    forbiddenMethod: { type: 'string' },
                    forbiddenActionType: { type: 'string' },
                    forbiddenActionTypes: { type: 'array', items: { type: 'string' }, minItems: 1 },
                    reason: { type: 'string' }
                  },
                  anyOf: [
                    { required: ['forbiddenMethod'] },
                    { required: ['forbiddenActionType'] },
                    { required: ['forbiddenActionTypes'] }
                  ]
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['type', 'intent', 'preferredMethod', 'matchPreference'],
                  properties: {
                    type: { const: 'action' },
                    intent: { type: 'string' },
                    preferredMethod: { type: 'string' },
                    matchPreference: { type: 'string' },
                    reason: { type: 'string' }
                  }
                }
              ]
            }
          }
        }
      }
    }
  };

  let raw;
  let parsed = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      switch (currentProvider) {
        case 'copilot':
          if (!apiKeys.copilot) {
            if (!loadCopilotToken()) throw new Error('Not authenticated with GitHub Copilot.');
          }
          raw = await callCopilot(messages, 'gpt-4o-mini', {
            enableTools: false,
            response_format: structuredResponseFormat,
            temperature: 0.2,
            max_tokens: 1200
          });
          break;
        case 'openai':
          // OpenAI call path currently does not support structured outputs here; fall back to text+extract.
          if (!apiKeys.openai) throw new Error('OpenAI API key not set.');
          raw = await callOpenAI(messages);
          break;
        case 'anthropic':
          if (!apiKeys.anthropic) throw new Error('Anthropic API key not set.');
          raw = await callAnthropic(messages);
          break;
        case 'ollama':
        default:
          raw = await callOllama(messages);
          break;
      }
    } catch (e) {
      lastError = e.message;
      // If structured output fields are rejected by the endpoint, retry once without them.
      if (currentProvider === 'copilot' && attempt === 1 && /API_ERROR_400|Invalid|unknown|response_format/i.test(lastError || '')) {
        try {
          raw = await callCopilot(messages, 'gpt-4o-mini', { enableTools: false, temperature: 0.2, max_tokens: 1200 });
        } catch (e2) {
          lastError = e2.message;
          continue;
        }
      } else {
        continue;
      }
    }

    parsed = extractJsonObjectFromText(raw);
    if (!parsed) {
      lastError = 'Preference Parser returned non-JSON output';
      messages[0] = { role: 'system', content: parserSystem + `\n\nYour last output was invalid: ${lastError}. Return valid JSON ONLY.` };
      continue;
    }

    const schemaError = validatePreferenceParserPayload(parsed);
    if (schemaError) {
      lastError = schemaError;
      messages[0] = { role: 'system', content: parserSystem + `\n\nYour last output failed validation: ${schemaError}. Return valid JSON ONLY.` };
      continue;
    }

    break;
  }

  if (!parsed) {
    return { success: false, error: lastError || 'Preference Parser failed', raw: raw || null };
  }

  const patch = sanitizePreferencePatch(parsed);
  const hasNegative = Array.isArray(patch.negativePolicies) && patch.negativePolicies.length > 0;
  const hasAction = Array.isArray(patch.actionPolicies) && patch.actionPolicies.length > 0;
  if (!hasNegative && !hasAction) {
    return { success: false, error: 'Preference Parser produced no usable policies', raw, parsed };
  }

  return { success: true, patch, raw, parsed };
}

/**
 * Handle slash commands
 */
function handleCommand(command) {
  function tokenize(input) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    let quoteChar = null;
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if ((ch === '"' || ch === "'") && (!inQuotes || ch === quoteChar)) {
        if (!inQuotes) {
          inQuotes = true;
          quoteChar = ch;
        } else {
          inQuotes = false;
          quoteChar = null;
        }
        continue;
      }
      if (!inQuotes && /\s/.test(ch)) {
        if (cur) out.push(cur);
        cur = '';
        continue;
      }
      cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }

  function normalizeModelKey(raw) {
    if (!raw) return '';
    let s = String(raw).trim();
    // Allow "id - Display Name" by stripping the display portion.
    const dashIdx = s.indexOf(' - ');
    if (dashIdx > 0) s = s.slice(0, dashIdx);
    // Common copy-paste variants
    s = s.replace(/^→\s*/, '').trim();
    const lowered = s.toLowerCase();
    if (modelRegistry()[lowered]) {
      return lowered;
    }
    // Accept raw provider model ids (e.g. claude-sonnet-4.5-20250929)
    for (const [key, def] of Object.entries(modelRegistry())) {
      if (String(def?.id || '').toLowerCase() === lowered) {
        return key;
      }
    }
    return lowered;
  }

  const parts = tokenize(String(command || '').trim());
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
      return { type: 'info', message: `Current provider: ${currentProvider}\nAvailable: ${Object.keys(AI_PROVIDERS).join(', ')}` };

    case '/setkey':
      if (parts[1] && parts[2]) {
        if (setApiKey(parts[1], parts[2])) {
          return { type: 'system', message: `API key set for ${parts[1]}.` };
        }
      }
      return { type: 'error', message: 'Usage: /setkey <provider> <key>' };

    case '/clear':
      conversationHistory = [];
      clearVisualContext();
      resetBrowserSessionState();
      saveConversationHistory();
      return { type: 'system', message: 'Conversation, visual context, and browser session state cleared.' };

    case '/vision':
      if (parts[1] === 'on') {
        return { type: 'info', message: 'Visual context will be included in next message. Use the capture button first.' };
      } else if (parts[1] === 'off') {
        clearVisualContext();
        return { type: 'system', message: 'Visual context cleared.' };
      }
      return { type: 'info', message: `Visual context buffer: ${visualContextBuffer.length} image(s)` };

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
            return { type: 'system', message: `Captured visual context (buffer: ${visualContextBuffer.length})` };
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
          const cur = modelRegistry()[currentCopilotModel];
          return {
            type: 'info',
            message: `Current model: ${cur?.name || currentCopilotModel} (${currentCopilotModel})`
          };
        } else {
          requested = parts.slice(1).join(' ');
        }

        const model = normalizeModelKey(requested);
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
        const active = modelRegistry()[currentCopilotModel];
        return {
          type: 'info',
          message: `Current model: ${active?.name || currentCopilotModel}\n\nAvailable models:\n${list}\n\nUse /model <id> to switch (you can also paste "id - display name")`
        };
      }

    case '/status':
      loadCopilotTokenIfNeeded();
      const status = getStatus();
      return {
        type: 'info',
        message: `Provider: ${status.provider}\nModel: ${modelRegistry()[currentCopilotModel]?.name || currentCopilotModel}\nCopilot: ${status.hasCopilotKey ? 'Authenticated' : 'Not authenticated'}\nOpenAI: ${status.hasOpenAIKey ? 'Key set' : 'No key'}\nAnthropic: ${status.hasAnthropicKey ? 'Key set' : 'No key'}\nHistory: ${status.historyLength} messages\nVisual: ${status.visualContextCount} captures`
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
    provider: currentProvider,
    model: currentCopilotModel,
    modelName: registry[currentCopilotModel]?.name || currentCopilotModel,
    hasCopilotKey: !!apiKeys.copilot,
    hasApiKey: currentProvider === 'copilot' ? !!apiKeys.copilot : 
               currentProvider === 'openai' ? !!apiKeys.openai :
               currentProvider === 'anthropic' ? !!apiKeys.anthropic : true,
    hasOpenAIKey: !!apiKeys.openai,
    hasAnthropicKey: !!apiKeys.anthropic,
    historyLength: conversationHistory.length,
    visualContextCount: visualContextBuffer.length,
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

/**
 * Parse AI response to extract actions
 * @param {string} aiResponse - The AI's response text
 * @returns {Object|null} Parsed action object or null if no actions
 */
function parseActions(aiResponse) {
  return systemAutomation.parseAIActions(aiResponse);
}

/**
 * Check if AI response contains actions
 * @param {string} aiResponse - The AI's response text  
 * @returns {boolean}
 */
function hasActions(aiResponse) {
  const parsed = parseActions(aiResponse);
  return parsed && parsed.actions && parsed.actions.length > 0;
}

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
  patch.url = urlFromResults || urlFromActions || browserSessionState.url;

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
