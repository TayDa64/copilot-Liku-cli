const BROWSER_PROCESS_NAMES = new Set(['msedge', 'chrome', 'firefox', 'brave', 'opera', 'iexplore', 'safari']);
const LOW_UIA_PROCESS_HINTS = new Set(['tradingview', 'electron', 'slack', 'discord', 'teams']);

function isScreenLikeCaptureMode(captureMode) {
  const normalized = String(captureMode || '').trim().toLowerCase();
  return normalized === 'screen'
    || normalized === 'fullscreen-fallback'
    || normalized.startsWith('screen-')
    || normalized.includes('fullscreen');
}

function isLikelyLowUiaChartContext({ capability, foreground, userMessage }) {
  const mode = String(capability?.mode || '').trim().toLowerCase();
  const processName = String(foreground?.processName || '').trim().toLowerCase();
  const title = String(foreground?.title || '').trim().toLowerCase();
  const text = String(userMessage || '').trim().toLowerCase();
  return mode === 'visual-first-low-uia'
    || /tradingview|chart|ticker|candlestick|pine/.test(processName)
    || /tradingview|chart|ticker|candlestick|pine/.test(title)
    || /tradingview|chart|ticker|candlestick|pine/.test(text);
}

function inferPineEvidenceRequestKind(userMessage = '') {
  const text = String(userMessage || '').trim().toLowerCase();
  if (!text) return null;
  if (!/pine|tradingview/.test(text)) return null;

  if (text.includes('500 line')
    || text.includes('500 lines')
    || text.includes('line count')
    || text.includes('line budget')
    || text.includes('script length')
    || (/\blines?\b/.test(text) && /\b(limit|max|maximum|cap|capped|budget)\b/.test(text))) {
    return 'line-budget';
  }

  if (/\b(diagnostic|diagnostics|warning|warnings|compiler errors|compile errors|error list|read errors|check diagnostics)\b/.test(text)) {
    return 'diagnostics';
  }

  if (/\b(compile result|compile status|compiler status|compilation result|build result|no errors|compiled successfully|compile summary|summarize compile|summarize compiler)\b/.test(text)) {
    return 'compile-result';
  }

  if (/\b(status|output)\b/.test(text) && /pine editor|pine/.test(text)) {
    return 'generic-status';
  }

  if (/\b(version history|revision|revisions|provenance|history|versions)\b/.test(text)
    && /\b(latest|top|visible|recent|metadata|summary|summarize|details)\b/.test(text)) {
    return 'provenance-summary';
  }

  return null;
}

function inferDrawingRequestKind(userMessage = '') {
  const text = String(userMessage || '').trim().toLowerCase();
  if (!text) return null;
  if (!/tradingview|drawing|drawings|trend\s*line|fibonacci|fib|object tree|ray|pitchfork|rectangle|ellipse|path|polyline|anchored text|anchored vwap/.test(text)) {
    return null;
  }

  const asksSurfaceAccess = /\b(open|show|focus|switch|search|find|object tree|drawing tools?|drawings toolbar)\b/.test(text);
  const asksPlacement = /\b(draw|place|position|anchor|set\b.*trend|plot\b.*trend)\b/.test(text)
    && /\b(trend\s*line|ray|pitchfork|fibonacci|fib|rectangle|ellipse|path|polyline|drawing)\b/.test(text);

  if (asksPlacement) return 'placement-request';
  if (asksSurfaceAccess) return 'surface-access';
  return null;
}

function buildPineEvidenceConstraint({ foreground, userMessage }) {
  const requestKind = inferPineEvidenceRequestKind(userMessage);
  if (!requestKind) return '';

  const processName = String(foreground?.processName || '').trim().toLowerCase();
  const title = String(foreground?.title || '').trim().toLowerCase();
  if (processName && processName !== 'tradingview' && !/tradingview/.test(title) && !/tradingview/.test(String(userMessage || '').toLowerCase())) {
    return '';
  }

  const lines = [
    '## Pine Evidence Bounds',
    `- requestKind: ${requestKind}`,
    '- Rule: Prefer visible Pine Editor compiler/diagnostic text over screenshot interpretation for Pine compile and diagnostics requests.',
    '- Rule: Summarize only what the visible Pine text proves.'
  ];

  if (requestKind === 'compile-result') {
    lines.push('- Rule: Treat `compile success`, `no errors`, or similar status text as compiler/editor evidence only, not proof of runtime correctness, strategy validity, profitability, or market insight.');
  }

  if (requestKind === 'diagnostics') {
    lines.push('- Rule: Surface visible compiler errors and warnings as bounded diagnostics evidence; do not infer hidden causes or chart-state effects unless the visible text states them.');
  }

  if (requestKind === 'line-budget') {
    lines.push('- Rule: Pine scripts are capped at 500 lines in TradingView. Treat visible line-count hints as bounded editor evidence, and prefer targeted edits over full rewrites when the budget is tight.');
  }

  if (requestKind === 'provenance-summary') {
    lines.push('- Rule: Treat Pine Version History as bounded provenance evidence only; summarize only the top visible revision labels, relative times, and other metadata that are directly visible.');
    lines.push('- Rule: When possible, structure the summary into compact visible fields such as latest visible revision label, latest visible relative time, visible revision count, and visible recency signal.');
    lines.push('- Rule: Do not infer hidden diffs, full script history, authorship, or runtime/chart behavior from the visible revision list alone.');
  }

  lines.push('- Rule: If the user asks for Pine runtime or strategy diagnosis, mention Pine execution-model caveats such as realtime rollback, confirmed vs unconfirmed bars, and indicator vs strategy recalculation differences before inferring behavior from compile status alone.');
  return lines.join('\n');
}

function inferTradingViewDrawingRequestKind(userMessage = '') {
  const text = String(userMessage || '').trim().toLowerCase();
  if (!text || !/tradingview/.test(text)) return null;
  if (!/\bdraw|drawing|drawings|trend line|trendline|ray|pitchfork|fibonacci|fib|brush|rectangle|ellipse|path|polyline|object tree\b/.test(text)) {
    return null;
  }

  const asksSurfaceAccess = /\b(open|show|focus|search|find|object tree|drawing tools|drawing toolbar|drawings toolbar)\b/.test(text);
  const asksPrecisePlacement = /\b(draw|place|position|anchor|put)\b/.test(text)
    && /\b(on|onto|between|from|to|at|through)\b/.test(text)
    && !asksSurfaceAccess;

  if (asksPrecisePlacement) return 'precise-placement';
  if (asksSurfaceAccess) return 'surface-access';
  return 'general-drawing';
}

function buildTradingViewDrawingConstraint({ foreground, userMessage }) {
  const requestKind = inferTradingViewDrawingRequestKind(userMessage);
  if (!requestKind) return '';

  const processName = String(foreground?.processName || '').trim().toLowerCase();
  const title = String(foreground?.title || '').trim().toLowerCase();
  if (processName && processName !== 'tradingview' && !/tradingview/.test(title) && !/tradingview/.test(String(userMessage || '').toLowerCase())) {
    return '';
  }

  const lines = [
    '## Drawing Capability Bounds',
    `- requestKind: ${requestKind}`,
    '- Rule: Distinguish TradingView drawing surface access from precise chart-object placement.',
    '- Rule: Do not claim a TradingView drawing was placed precisely unless a deterministic verified placement workflow actually established the anchors.'
  ];

  if (requestKind === 'precise-placement') {
    lines.push('- Rule: For exact trendline or anchor placement requests, use a safe surface workflow or explicitly refuse precise-placement claims when the evidence does not directly verify the anchors.');
  } else {
    lines.push('- Rule: Tool-surface access is acceptable to automate when verified, but that does not by itself prove chart-object placement.');
  }

  return lines.join('\n');
}

function buildDrawingEvidenceConstraint({ foreground, latestVisual, userMessage }) {
  const requestKind = inferDrawingRequestKind(userMessage);
  if (!requestKind) return '';

  const processName = String(foreground?.processName || '').trim().toLowerCase();
  const title = String(foreground?.title || '').trim().toLowerCase();
  const messageText = String(userMessage || '').toLowerCase();
  if (processName && processName !== 'tradingview' && !/tradingview/.test(title) && !/tradingview/.test(messageText)) {
    return '';
  }

  const captureMode = String(latestVisual?.captureMode || latestVisual?.scope || '').trim() || 'unknown';
  const captureTrusted = typeof latestVisual?.captureTrusted === 'boolean'
    ? latestVisual.captureTrusted
    : !isScreenLikeCaptureMode(captureMode);

  const lines = [
    '## Drawing Capability Bounds',
    `- requestKind: ${requestKind}`,
    '- Rule: Distinguish TradingView drawing surface access from precise chart-object placement.',
    '- Rule: Opening drawing tools, drawing search, or Object Tree can be automated and verified as UI-surface transitions.',
    '- Rule: Do not claim a trendline or other chart object was placed precisely unless deterministic placement evidence is directly verified.'
  ];

  if (!captureTrusted || isScreenLikeCaptureMode(captureMode)) {
    lines.push('- Rule: With screenshot-only or degraded visual evidence, placement confidence is bounded. Use a safe surface workflow or explicitly refuse precise-placement claims.');
  } else {
    lines.push('- Rule: Even with trusted capture, treat exact anchor placement as uncertain unless a deterministic verified placement workflow confirms it.');
  }

  return lines.join('\n');
}

function buildCurrentTurnVisualEvidenceConstraint({ latestVisual, capability, foreground, userMessage }) {
  if (!latestVisual || typeof latestVisual !== 'object') return '';

  const captureMode = String(latestVisual.captureMode || latestVisual.scope || '').trim() || 'unknown';
  const captureTrusted = typeof latestVisual.captureTrusted === 'boolean'
    ? latestVisual.captureTrusted
    : !isScreenLikeCaptureMode(captureMode);
  const lowUiaChartContext = isLikelyLowUiaChartContext({ capability, foreground, userMessage });
  const activeApp = String(foreground?.title || foreground?.processName || '').trim();

  const lines = [
    '## Current Visual Evidence Bounds',
    `- captureMode: ${captureMode}`,
    `- captureTrusted: ${captureTrusted ? 'yes' : 'no'}`
  ];

  if (activeApp) {
    lines.push(`- activeApp: ${activeApp}`);
  }

  if (!captureTrusted || isScreenLikeCaptureMode(captureMode)) {
    lines.push('- evidenceQuality: degraded-mixed-desktop');
    lines.push('- Rule: Treat the current screenshot as degraded mixed-desktop evidence, not a trusted target-window capture.');
    lines.push('- Rule: Distinguish directly visible facts in the image from interpretive hypotheses or trading ideas.');
    if (lowUiaChartContext) {
      lines.push('- Rule: For TradingView or other low-UIA chart apps, do not claim precise indicator values, exact trendline coordinates, or exact support/resistance numbers unless they are directly legible in the screenshot or supplied by a stronger evidence path.');
    }
    lines.push('- Rule: If a detail is not directly legible, state uncertainty explicitly and offer bounded next steps.');
    return lines.join('\n');
  }

  lines.push('- evidenceQuality: trusted-target-window');
  lines.push('- Rule: Describe directly visible facts from the current screenshot first, then clearly separate any interpretation or trading hypothesis.');
  if (lowUiaChartContext) {
    lines.push('- Rule: Even with trusted capture, only state precise chart indicator values when they are directly legible in the screenshot or supported by a stronger evidence path.');
  }
  return lines.join('\n');
}

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
    const { extraSystemMessages = [], skillsContext = '', memoryContext = '', sessionIntentContext = '', chatContinuityContext = '' } = options || {};
    let currentForeground = null;
    let activeAppCapability = null;

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
      if (typeof chatContinuityContext === 'string' && chatContinuityContext.trim()) {
        messages.push({ role: 'system', content: `## Recent Action Continuity\n${chatContinuityContext.trim()}` });
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
      if (typeof getForegroundWindowInfo === 'function') {
        currentForeground = await getForegroundWindowInfo();
      }
      const watcherSnapshot = watcher && typeof watcher.getCapabilitySnapshot === 'function'
        ? watcher.getCapabilitySnapshot()
        : null;
      activeAppCapability = classifyActiveAppCapability({ foreground: currentForeground, watcherSnapshot, browserState });
      if (activeAppCapability) {
        const capabilityBlock = [
          '## Active App Capability',
          `- mode: ${activeAppCapability.mode}`,
          `- confidence: ${activeAppCapability.confidence}`,
          `- rationale: ${activeAppCapability.rationale}`,
          `- activeWindowElementCount: ${Number(activeAppCapability.inventory?.activeWindowElementCount || 0)}`,
          `- interactiveElementCount: ${Number(activeAppCapability.inventory?.interactiveElementCount || 0)}`,
          `- namedInteractiveElementCount: ${Number(activeAppCapability.inventory?.namedInteractiveElementCount || 0)}`,
          ...(Array.isArray(activeAppCapability.directives) ? activeAppCapability.directives.map((line) => `- directive: ${line}`) : [])
          ,...(Array.isArray(activeAppCapability.responseShape) ? activeAppCapability.responseShape.map((line) => `- answer-shape: ${line}`) : [])
        ].join('\n');
        messages.push({ role: 'system', content: capabilityBlock });
      }
    } catch {}

    getRecentConversationHistory(maxHistory).forEach((msg) => {
      messages.push(msg);
    });

    const latestVisual = includeVisual ? getLatestVisualContext() : null;

    try {
      const visualEvidenceConstraint = buildCurrentTurnVisualEvidenceConstraint({
        latestVisual,
        capability: activeAppCapability,
        foreground: currentForeground,
        userMessage
      });
      if (visualEvidenceConstraint) {
        messages.push({ role: 'system', content: visualEvidenceConstraint });
      }
    } catch {}

    try {
      const pineEvidenceConstraint = buildPineEvidenceConstraint({
        foreground: currentForeground,
        userMessage
      });
      if (pineEvidenceConstraint) {
        messages.push({ role: 'system', content: pineEvidenceConstraint });
      }
    } catch {}

    try {
      const drawingConstraint = buildTradingViewDrawingConstraint({
        foreground: currentForeground,
        userMessage
      });
      if (drawingConstraint) {
        messages.push({ role: 'system', content: drawingConstraint });
      }
    } catch {}

    try {
      const drawingEvidenceConstraint = buildDrawingEvidenceConstraint({
        foreground: currentForeground,
        latestVisual,
        userMessage
      });
      if (drawingEvidenceConstraint) {
        messages.push({ role: 'system', content: drawingEvidenceConstraint });
      }
    } catch {}

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
