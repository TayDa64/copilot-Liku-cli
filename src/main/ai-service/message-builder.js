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
          '- Rule: If goalStatus is achieved and user intent is acknowledgement/chit-chat, do not propose actions or screenshots.'
        ].join('\n');
        messages.push({ role: 'system', content: continuity });
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