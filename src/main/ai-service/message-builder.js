const BROWSER_PROCESS_NAMES = new Set(['msedge', 'chrome', 'firefox', 'brave', 'opera', 'iexplore', 'safari']);
const LOW_UIA_PROCESS_HINTS = new Set(['tradingview', 'electron', 'slack', 'discord', 'teams']);

function classifyActiveAppCapability({ foreground, watcherSnapshot, browserState }) {
  const processName = String(foreground?.processName || watcherSnapshot?.activeWindow?.processName || '').toLowerCase();
  const title = String(foreground?.title || watcherSnapshot?.activeWindow?.title || '').toLowerCase();
  const activeWindowElementCount = Number(watcherSnapshot?.activeWindowElementCount || 0);
  const namedInteractiveElementCount = Number(watcherSnapshot?.namedInteractiveElementCount || 0);
  const interactiveElementCount = Number(watcherSnapshot?.interactiveElementCount || 0);
  const browserUrl = String(browserState?.url || '').trim();

  if (BROWSER_PROCESS_NAMES.has(processName) || (!processName && browserUrl)) {
    return {
      mode: 'browser',
      confidence: 'high',
      rationale: 'Foreground app matches a browser process or active browser session state exists.',
      inventory: {
        activeWindowElementCount,
        interactiveElementCount,
        namedInteractiveElementCount
      },
      directives: [
        'Treat this as a browser-capable surface.',
        'Prefer browser-specific navigation and recovery rules over generic desktop-app assumptions.'
      ],
      responseShape: [
        'If the user asks what controls are available, distinguish browser-native controls from generic desktop/window controls.',
        'Do not describe desktop UIA coverage as if it were the same as webpage DOM coverage.'
      ]
    };
  }

  const lowUiSignal = activeWindowElementCount <= 8 && namedInteractiveElementCount <= 2;
  const likelyLowUiaApp = LOW_UIA_PROCESS_HINTS.has(processName)
    || /tradingview|chart|workspace|electron/i.test(title)
    || (interactiveElementCount <= 3 && lowUiSignal);

  if (likelyLowUiaApp) {
    return {
      mode: 'visual-first-low-uia',
      confidence: (LOW_UIA_PROCESS_HINTS.has(processName) || /tradingview/i.test(title)) ? 'high' : 'medium',
      rationale: 'Foreground app looks like a Chromium/Electron or otherwise low-UIA surface with sparse named controls.',
      inventory: {
        activeWindowElementCount,
        interactiveElementCount,
        namedInteractiveElementCount
      },
      directives: [
        'Do not over-claim named controls from Live UI State when the active window exposes sparse UIA signal.',
        'Prefer screenshot-grounded observation plus keyboard/window actions for this app.',
        'If the user asks what controls are available, separate direct UIA controls from visually visible controls.'
      ],
      responseShape: [
        'Answer with three buckets when relevant: direct UIA controls, reliable keyboard/window controls, and visible but screenshot-only controls.',
        'If namedInteractiveElementCount is very low, explicitly say the visible app surface is only partially exposed to UIA.'
      ]
    };
  }

  if (namedInteractiveElementCount >= 5 || interactiveElementCount >= 8 || activeWindowElementCount >= 20) {
    return {
      mode: 'uia-rich',
      confidence: 'medium',
      rationale: 'Foreground app exposes a healthy amount of named or interactive UIA elements.',
      inventory: {
        activeWindowElementCount,
        interactiveElementCount,
        namedInteractiveElementCount
      },
      directives: [
        'Prefer semantic UIA actions such as click_element, find_element, get_text, and set_value when applicable.',
        'Use Live UI State as the primary control inventory before falling back to screenshot reasoning.'
      ],
      responseShape: [
        'When the user asks about controls, mention the direct UIA controls first.',
        'Prefer find_element or get_text before claiming no controls are available.'
      ]
    };
  }

  return {
    mode: 'keyboard-window-first',
    confidence: 'low',
    rationale: 'Foreground app is not clearly browser or UIA-rich, and the current evidence is limited.',
    inventory: {
      activeWindowElementCount,
      interactiveElementCount,
      namedInteractiveElementCount
    },
    directives: [
      'Prefer reliable window management and keyboard actions first.',
      'Use screenshots for observation tasks when Live UI State is sparse or ambiguous.'
    ],
    responseShape: [
      'Be explicit that direct element-level control is uncertain from current evidence.',
      'Describe reliable keyboard/window controls separately from anything that is only visually observed.'
    ]
  };
}

function createMessageBuilder(dependencies) {
  const {
    getBrowserSessionState,
    getCurrentProvider,
    getForegroundWindowInfo,
    getInspectService,
    getLatestVisualContext,
    getPreferencesSystemContext,
    getPreferencesSystemContextForApp,
    getRecentConversationHistory,
    getSemanticDOMContextText,
    getUIWatcher,
    maxHistory,
    systemPrompt
  } = dependencies;

  async function buildMessages(userMessage, includeVisual = false, options = {}) {
    const messages = [{ role: 'system', content: systemPrompt }];
    const { extraSystemMessages = [], skillsContext = '', memoryContext = '', sessionIntentContext = '' } = options || {};

    try {
      let prefText = '';
      if (typeof getForegroundWindowInfo === 'function') {
        const fg = await getForegroundWindowInfo();
        if (fg && fg.success && fg.processName) {
          prefText = getPreferencesSystemContextForApp(fg.processName);
        }
      }
      if (!prefText) {
        prefText = getPreferencesSystemContext();
      }
      if (prefText && prefText.trim()) {
        messages.push({ role: 'system', content: prefText.trim() });
      }
    } catch {}

    try {
      if (Array.isArray(extraSystemMessages)) {
        for (const msg of extraSystemMessages) {
          if (typeof msg === 'string' && msg.trim()) {
            messages.push({ role: 'system', content: msg.trim() });
          }
        }
      }
    } catch {}

    // Inject skills context with a dedicated section header for model clarity
    try {
      if (typeof skillsContext === 'string' && skillsContext.trim()) {
        messages.push({ role: 'system', content: `## Relevant Skills\n${skillsContext.trim()}` });
      }
    } catch {}

    // Inject memory context with a dedicated section header for model clarity
    try {
      if (typeof memoryContext === 'string' && memoryContext.trim()) {
        messages.push({ role: 'system', content: `## Working Memory\n${memoryContext.trim()}` });
      }
    } catch {}

    try {
      if (typeof sessionIntentContext === 'string' && sessionIntentContext.trim()) {
        messages.push({ role: 'system', content: `## Session Constraints\n${sessionIntentContext.trim()}` });
      }
    } catch {}

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
          `- lastAttemptedUrl: ${state.lastAttemptedUrl || 'none'}`,
          `- attemptedUrls: ${Array.isArray(state.attemptedUrls) && state.attemptedUrls.length ? state.attemptedUrls.join(', ') : 'none'}`,
          `- navigationAttemptCount: ${Number.isFinite(Number(state.navigationAttemptCount)) ? Number(state.navigationAttemptCount) : 0}`,
          `- recoveryMode: ${state.recoveryMode || 'direct'}`,
          `- recoveryQuery: ${state.recoveryQuery || 'none'}`,
          '- Rule: If goalStatus is achieved and user intent is acknowledgement/chit-chat, do not propose actions or screenshots.'
        ].join('\n');
        messages.push({ role: 'system', content: continuity });
      }
    } catch {}

    try {
      const watcher = getUIWatcher();
      const browserState = getBrowserSessionState();
      let foreground = null;
      if (typeof getForegroundWindowInfo === 'function') {
        foreground = await getForegroundWindowInfo();
      }
      const watcherSnapshot = watcher && typeof watcher.getCapabilitySnapshot === 'function'
        ? watcher.getCapabilitySnapshot()
        : null;
      const capability = classifyActiveAppCapability({ foreground, watcherSnapshot, browserState });
      if (capability) {
        const capabilityBlock = [
          '## Active App Capability',
          `- mode: ${capability.mode}`,
          `- confidence: ${capability.confidence}`,
          `- rationale: ${capability.rationale}`,
          `- activeWindowElementCount: ${Number(capability.inventory?.activeWindowElementCount || 0)}`,
          `- interactiveElementCount: ${Number(capability.inventory?.interactiveElementCount || 0)}`,
          `- namedInteractiveElementCount: ${Number(capability.inventory?.namedInteractiveElementCount || 0)}`,
          ...(Array.isArray(capability.directives) ? capability.directives.map((line) => `- directive: ${line}`) : [])
          ,...(Array.isArray(capability.responseShape) ? capability.responseShape.map((line) => `- answer-shape: ${line}`) : [])
        ].join('\n');
        messages.push({ role: 'system', content: capabilityBlock });
      }
    } catch {}

    getRecentConversationHistory(maxHistory).forEach((msg) => {
      messages.push(msg);
    });

    const latestVisual = includeVisual ? getLatestVisualContext() : null;

    let inspectContextText = '';
    try {
      const inspect = getInspectService();
      if (inspect.isInspectModeActive()) {
        const inspectContext = inspect.generateAIContext();
        if (inspectContext.regions && inspectContext.regions.length > 0) {
          inspectContextText = `\n\n## Detected UI Regions (Inspect Mode)\n${inspectContext.regions.slice(0, 20).map((region, index) =>
            `${index + 1}. **${region.label || 'Unknown'}** (${region.role}) at (${region.center.x}, ${region.center.y}) - confidence: ${Math.round(region.confidence * 100)}%`
          ).join('\n')}\n\n**Note**: Use the coordinates provided above for precise targeting. If confidence is below 70%, verify with user before clicking.`;

          if (inspectContext.windowContext) {
            inspectContextText += `\n\n## Active Window\n- App: ${inspectContext.windowContext.appName || 'Unknown'}\n- Title: ${inspectContext.windowContext.windowTitle || 'Unknown'}\n- Scale Factor: ${inspectContext.windowContext.scaleFactor || 1}`;
          }
        }
      }
    } catch (error) {
      console.warn('[AI] Could not get inspect context:', error.message);
    }

    let liveUIContextText = '';
    try {
      const watcher = getUIWatcher();
      if (watcher && watcher.isPolling) {
        const uiContext = watcher.getContextForAI();
        if (uiContext && uiContext.trim()) {
          liveUIContextText = `\n\n---\n🔴 **LIVE UI STATE** (auto-refreshed every 400ms - TRUST THIS DATA!)\n${uiContext}\n---`;
          if (process.env.LIKU_CHAT_TRANSCRIPT_QUIET !== '1') {
            console.log('[AI] Including live UI context from watcher (', uiContext.split('\n').length, 'lines)');
          }
        }
      } else if (process.env.LIKU_CHAT_TRANSCRIPT_QUIET !== '1') {
        console.log('[AI] UI Watcher not available or not running (watcher:', !!watcher, ', polling:', watcher?.isPolling, ')');
      }
    } catch (error) {
      console.warn('[AI] Could not get live UI context:', error.message);
    }

    const semanticDOMContextText = getSemanticDOMContextText();
    const enhancedMessage = inspectContextText || liveUIContextText || semanticDOMContextText
      ? `${userMessage}${inspectContextText}${liveUIContextText}${semanticDOMContextText}`
      : userMessage;

    if (latestVisual && (getCurrentProvider() === 'copilot' || getCurrentProvider() === 'openai')) {
      console.log('[AI] Including visual context in message (provider:', getCurrentProvider(), ')');
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
    } else if (latestVisual && getCurrentProvider() === 'anthropic') {
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
    } else if (latestVisual && getCurrentProvider() === 'ollama') {
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

  return {
    buildMessages
  };
}

module.exports = {
  createMessageBuilder
};