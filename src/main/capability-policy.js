const { classifyBackgroundCapability } = require('./background-capture');
const { inferTradingViewTradingMode } = require('./tradingview/verification');
const { listTradingViewShortcuts } = require('./tradingview/shortcut-profile');

const BROWSER_PROCESS_NAMES = new Set(['msedge', 'chrome', 'firefox', 'brave', 'opera', 'iexplore', 'safari']);
const LOW_UIA_PROCESS_HINTS = new Set(['tradingview', 'electron', 'slack', 'discord', 'teams']);
const SURFACE_CLASSES = ['browser', 'uia-rich', 'visual-first-low-uia', 'keyboard-window-first'];

function normalizeLowerText(value) {
  return String(value || '').trim().toLowerCase();
}

function isScreenLikeCaptureMode(captureMode) {
  const normalized = normalizeLowerText(captureMode);
  return normalized === 'screen'
    || normalized === 'fullscreen-fallback'
    || normalized.startsWith('screen-')
    || normalized.includes('fullscreen');
}

function normalizeForegroundWindow(foreground = {}) {
  if (!foreground || typeof foreground !== 'object') return null;
  const candidate = foreground.success === false ? null : foreground;
  if (!candidate) return null;

  return {
    hwnd: Number(candidate.hwnd || candidate.windowHandle || 0) || 0,
    title: String(candidate.title || candidate.windowTitle || '').trim(),
    processName: normalizeLowerText(candidate.processName),
    className: normalizeLowerText(candidate.className),
    windowKind: normalizeLowerText(candidate.windowKind),
    isMinimized: candidate.isMinimized === true,
    isTopmost: candidate.isTopmost === true
  };
}

function buildSurfacePolicyDefaults(surfaceClass) {
  switch (surfaceClass) {
    case 'browser':
      return {
        preferredChannels: ['browser-native', 'semantic-uia'],
        allowedChannels: ['browser-native', 'semantic-uia', 'keyboard-window', 'coordinate'],
        forbiddenChannels: [],
        defaultConfirmationPosture: 'standard',
        claimBoundStrictness: 'standard',
        directives: [
          'Treat this as a browser-capable surface.',
          'Prefer browser-specific navigation and recovery rules over generic desktop-app assumptions.'
        ],
        responseShape: [
          'If the user asks what controls are available, distinguish browser-native controls from generic desktop/window controls.',
          'Do not describe desktop UIA coverage as if it were the same as webpage DOM coverage.'
        ],
        enforcement: {
          preferSemanticActions: true,
          discourageCoordinateOnlyPlans: true,
          avoidPrecisePlacementClaims: false
        }
      };
    case 'uia-rich':
      return {
        preferredChannels: ['semantic-uia'],
        allowedChannels: ['semantic-uia', 'keyboard-window', 'coordinate'],
        forbiddenChannels: [],
        defaultConfirmationPosture: 'standard',
        claimBoundStrictness: 'standard',
        directives: [
          'Prefer semantic UIA actions such as click_element, find_element, get_text, and set_value when applicable.',
          'Use Live UI State as the primary control inventory before falling back to screenshot reasoning.'
        ],
        responseShape: [
          'When the user asks about controls, mention the direct UIA controls first.',
          'Prefer find_element or get_text before claiming no controls are available.'
        ],
        enforcement: {
          preferSemanticActions: true,
          discourageCoordinateOnlyPlans: true,
          avoidPrecisePlacementClaims: false
        }
      };
    case 'visual-first-low-uia':
      return {
        preferredChannels: ['keyboard-window', 'observation'],
        allowedChannels: ['keyboard-window', 'observation', 'limited-semantic-uia', 'coordinate'],
        forbiddenChannels: ['precise-placement'],
        defaultConfirmationPosture: 'evidence-first',
        claimBoundStrictness: 'high',
        directives: [
          'Do not over-claim named controls from Live UI State when the active window exposes sparse UIA signal.',
          'Prefer screenshot-grounded observation plus keyboard/window actions for this app.',
          'If the user asks what controls are available, separate direct UIA controls from visually visible controls.'
        ],
        responseShape: [
          'Answer with three buckets when relevant: direct UIA controls, reliable keyboard/window controls, and visible but screenshot-only controls.',
          'If namedInteractiveElementCount is very low, explicitly say the visible app surface is only partially exposed to UIA.'
        ],
        enforcement: {
          preferSemanticActions: false,
          discourageCoordinateOnlyPlans: false,
          avoidPrecisePlacementClaims: true
        }
      };
    case 'keyboard-window-first':
    default:
      return {
        preferredChannels: ['keyboard-window'],
        allowedChannels: ['keyboard-window', 'observation', 'coordinate'],
        forbiddenChannels: [],
        defaultConfirmationPosture: 'standard',
        claimBoundStrictness: 'elevated',
        directives: [
          'Prefer reliable window management and keyboard actions first.',
          'Use screenshots for observation tasks when Live UI State is sparse or ambiguous.'
        ],
        responseShape: [
          'Be explicit that direct element-level control is uncertain from current evidence.',
          'Describe reliable keyboard/window controls separately from anything that is only visually observed.'
        ],
        enforcement: {
          preferSemanticActions: false,
          discourageCoordinateOnlyPlans: false,
          avoidPrecisePlacementClaims: false
        }
      };
  }
}

function classifyBackgroundSupportLevel(evidence = {}) {
  const capability = String(evidence.backgroundCaptureCapability || '').trim().toLowerCase();
  if (capability === 'supported') return 'supported';
  if (capability === 'degraded') return 'degraded';
  return 'unsupported';
}

function buildCapabilityDimensions(surfaceClass, evidence = {}) {
  const backgroundSupport = classifyBackgroundSupportLevel(evidence);

  switch (surfaceClass) {
    case 'browser':
      return {
        semanticControl: 'supported',
        keyboardControl: 'supported',
        trustworthyBackgroundCapture: backgroundSupport,
        precisePlacement: 'bounded',
        boundedTextExtraction: 'supported',
        approvalTimeRecovery: backgroundSupport === 'supported' ? 'supported' : (backgroundSupport === 'degraded' ? 'degraded' : 'limited')
      };
    case 'uia-rich':
      return {
        semanticControl: 'supported',
        keyboardControl: 'supported',
        trustworthyBackgroundCapture: backgroundSupport,
        precisePlacement: 'bounded',
        boundedTextExtraction: 'supported',
        approvalTimeRecovery: backgroundSupport === 'supported' ? 'supported' : (backgroundSupport === 'degraded' ? 'degraded' : 'limited')
      };
    case 'visual-first-low-uia':
      return {
        semanticControl: 'limited',
        keyboardControl: 'supported',
        trustworthyBackgroundCapture: backgroundSupport,
        precisePlacement: 'unsupported',
        boundedTextExtraction: 'limited',
        approvalTimeRecovery: backgroundSupport === 'supported' ? 'degraded' : (backgroundSupport === 'degraded' ? 'degraded' : 'limited')
      };
    case 'keyboard-window-first':
    default:
      return {
        semanticControl: 'limited',
        keyboardControl: 'supported',
        trustworthyBackgroundCapture: backgroundSupport,
        precisePlacement: 'bounded',
        boundedTextExtraction: 'limited',
        approvalTimeRecovery: backgroundSupport === 'supported' ? 'supported' : 'limited'
      };
  }
}

function summarizeTradingViewShortcutPolicy() {
  const shortcuts = listTradingViewShortcuts();
  const stableDefaultIds = [];
  const customizableIds = [];
  const paperTestOnlyIds = [];

  for (const shortcut of shortcuts) {
    if (shortcut.category === 'stable-default') stableDefaultIds.push(shortcut.id);
    if (shortcut.category === 'customizable') customizableIds.push(shortcut.id);
    if (shortcut.safety === 'paper-test-only') paperTestOnlyIds.push(shortcut.id);
  }

  return {
    stableDefaultIds,
    customizableIds,
    paperTestOnlyIds
  };
}

function classifyActiveAppCapability({ foreground, watcherSnapshot, browserState }) {
  const normalizedForeground = normalizeForegroundWindow(foreground);
  const activeWindow = watcherSnapshot?.activeWindow || {};
  const processName = normalizeLowerText(normalizedForeground?.processName || activeWindow.processName);
  const title = normalizeLowerText(normalizedForeground?.title || activeWindow.title);
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
      ...buildSurfacePolicyDefaults('browser')
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
      ...buildSurfacePolicyDefaults('visual-first-low-uia')
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
      ...buildSurfacePolicyDefaults('uia-rich')
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
    ...buildSurfacePolicyDefaults('keyboard-window-first')
  };
}

function inferEvidenceState({ latestVisual, foreground }) {
  const normalizedForeground = normalizeForegroundWindow(foreground);
  const captureMode = String(latestVisual?.captureMode || latestVisual?.scope || '').trim() || 'unknown';
  const captureTrusted = typeof latestVisual?.captureTrusted === 'boolean'
    ? latestVisual.captureTrusted
    : (!latestVisual ? null : !isScreenLikeCaptureMode(captureMode));
  const captureCapability = String(latestVisual?.captureCapability || '').trim().toLowerCase()
    || (captureTrusted === false ? 'degraded' : (captureTrusted === true ? 'supported' : 'unknown'));

  const backgroundCapture = normalizedForeground?.hwnd
    ? classifyBackgroundCapability({
      targetWindowHandle: normalizedForeground.hwnd,
      windowProfile: normalizedForeground
    })
    : { supported: false, capability: 'unsupported', reason: 'No active foreground HWND available.' };

  let quality = 'no-visual-context';
  if (captureTrusted === true) {
    quality = 'trusted-target-window';
  } else if (latestVisual) {
    quality = 'degraded-mixed-desktop';
  }

  return {
    captureMode,
    captureTrusted,
    captureCapability,
    quality,
    backgroundCaptureCapability: backgroundCapture.capability,
    backgroundCaptureSupported: backgroundCapture.supported,
    backgroundCaptureReason: backgroundCapture.reason || null,
    degradedReason: latestVisual?.captureDegradedReason || null
  };
}

function inferAppOverlay(normalizedForeground = {}, context = {}) {
  const haystack = [normalizedForeground.processName, normalizedForeground.title]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');

  if (/tradingview|trading\s+view/.test(haystack)) {
    const tradingMode = inferTradingViewTradingMode({
      textSignals: [context.userMessage, normalizedForeground.title, normalizedForeground.processName].filter(Boolean).join(' ')
    });
    const shortcutPolicy = summarizeTradingViewShortcutPolicy();

    return {
      appId: 'tradingview',
      overlays: ['tradingview'],
      tradingMode,
      shortcutPolicy,
      directives: [
        'TradingView inherits visual-first-low-uia defaults and adds chart-evidence honesty bounds.',
        'Treat exact drawing placement, chart-object anchors, and trading-domain shortcuts as bounded unless a deterministic verified workflow proves them.',
        'Stable TradingView defaults can be used only on verified surfaces; customizable shortcuts stay user-confirmed, and paper-test-only shortcuts remain bounded to advisory-safe flows.'
      ],
      responseShape: [
        'For TradingView, separate verified UI-surface access from bounded chart interpretation or precise placement claims.'
      ],
      enforcement: {
        avoidPrecisePlacementClaims: true,
        discourageCoordinateOnlyPlans: false,
        preferSemanticActions: false
      }
    };
  }

  return {
    appId: normalizedForeground?.processName || 'unknown-app',
    overlays: [],
    tradingMode: { mode: 'unknown', confidence: 'low', evidence: [] },
    shortcutPolicy: null,
    directives: [],
    responseShape: [],
    enforcement: {}
  };
}

function mergeUniqueStrings(...groups) {
  return Array.from(new Set(groups
    .flat()
    .map((value) => String(value || '').trim())
    .filter(Boolean)));
}

function buildCapabilityPolicySnapshot({ foreground, watcherSnapshot, browserState, latestVisual, appPolicy, userMessage } = {}) {
  const normalizedForeground = normalizeForegroundWindow(foreground);
  const surface = classifyActiveAppCapability({
    foreground: normalizedForeground,
    watcherSnapshot,
    browserState
  });
  const evidence = inferEvidenceState({ latestVisual, foreground: normalizedForeground });
  const overlay = inferAppOverlay(normalizedForeground, { userMessage });
  const supports = buildCapabilityDimensions(surface.mode, evidence);

  const userPolicy = appPolicy && typeof appPolicy === 'object'
    ? {
      executionMode: String(appPolicy.executionMode || '').trim().toLowerCase() || 'prompt',
      hasActionPolicies: Array.isArray(appPolicy.actionPolicies) && appPolicy.actionPolicies.length > 0,
      hasNegativePolicies: Array.isArray(appPolicy.negativePolicies) && appPolicy.negativePolicies.length > 0
    }
    : null;

  return {
    surfaceClass: surface.mode,
    surface,
    foreground: normalizedForeground,
    evidence,
    supports,
    appId: overlay.appId,
    overlays: overlay.overlays,
    tradingMode: overlay.tradingMode,
    shortcutPolicy: overlay.shortcutPolicy,
    channels: {
      preferred: surface.preferredChannels,
      allowed: surface.allowedChannels,
      forbidden: surface.forbiddenChannels
    },
    approval: {
      defaultConfirmationPosture: surface.defaultConfirmationPosture
    },
    claimBounds: {
      strictness: evidence.captureTrusted === false && surface.mode === 'visual-first-low-uia'
        ? 'very-high'
        : surface.claimBoundStrictness,
      requireExplicitDegradedEvidence: evidence.captureTrusted === false || isScreenLikeCaptureMode(evidence.captureMode),
      separateVerifiedFromInferred: true
    },
    enforcement: {
      ...surface.enforcement,
      ...overlay.enforcement
    },
    guidance: {
      directives: mergeUniqueStrings(surface.directives, overlay.directives),
      responseShape: mergeUniqueStrings(surface.responseShape, overlay.responseShape)
    },
    inventory: surface.inventory,
    rationale: surface.rationale,
    confidence: surface.confidence,
    userPolicy
  };
}

function buildCapabilityPolicySystemMessage(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return '';

  const lines = [
    '## Active App Capability',
    '- policySource: capability-policy-matrix',
    `- surfaceClass: ${snapshot.surfaceClass || 'unknown'}`,
    `- mode: ${snapshot.surface?.mode || snapshot.surfaceClass || 'unknown'}`,
    `- confidence: ${snapshot.confidence || snapshot.surface?.confidence || 'unknown'}`,
    `- rationale: ${snapshot.rationale || snapshot.surface?.rationale || 'unknown'}`,
    `- appId: ${snapshot.appId || 'unknown-app'}`,
    `- activeWindowElementCount: ${Number(snapshot.inventory?.activeWindowElementCount || 0)}`,
    `- interactiveElementCount: ${Number(snapshot.inventory?.interactiveElementCount || 0)}`,
    `- namedInteractiveElementCount: ${Number(snapshot.inventory?.namedInteractiveElementCount || 0)}`,
    `- preferredChannels: ${(snapshot.channels?.preferred || []).join(', ') || 'none'}`,
    `- allowedChannels: ${(snapshot.channels?.allowed || []).join(', ') || 'none'}`,
    `- forbiddenChannels: ${(snapshot.channels?.forbidden || []).join(', ') || 'none'}`,
    `- semanticControl: ${snapshot.supports?.semanticControl || 'unknown'}`,
    `- keyboardControl: ${snapshot.supports?.keyboardControl || 'unknown'}`,
    `- trustworthyBackgroundCapture: ${snapshot.supports?.trustworthyBackgroundCapture || 'unknown'}`,
    `- precisePlacement: ${snapshot.supports?.precisePlacement || 'unknown'}`,
    `- boundedTextExtraction: ${snapshot.supports?.boundedTextExtraction || 'unknown'}`,
    `- approvalTimeRecovery: ${snapshot.supports?.approvalTimeRecovery || 'unknown'}`,
    `- defaultConfirmationPosture: ${snapshot.approval?.defaultConfirmationPosture || 'standard'}`,
    `- claimBoundStrictness: ${snapshot.claimBounds?.strictness || 'standard'}`,
    `- captureMode: ${snapshot.evidence?.captureMode || 'unknown'}`,
    `- captureTrusted: ${snapshot.evidence?.captureTrusted === true ? 'yes' : snapshot.evidence?.captureTrusted === false ? 'no' : 'unknown'}`,
    `- captureCapability: ${snapshot.evidence?.captureCapability || 'unknown'}`,
    `- backgroundCaptureCapability: ${snapshot.evidence?.backgroundCaptureCapability || 'unknown'}`,
    ...(Array.isArray(snapshot.overlays) && snapshot.overlays.length ? [`- overlays: ${snapshot.overlays.join(', ')}`] : []),
    ...(snapshot.appId === 'tradingview'
      ? [
        `- tradingModeHint: ${snapshot.tradingMode?.mode || 'unknown'}`,
        `- tradingViewStableShortcuts: ${(snapshot.shortcutPolicy?.stableDefaultIds || []).join(', ') || 'none'}`,
        `- tradingViewCustomizableShortcuts: ${(snapshot.shortcutPolicy?.customizableIds || []).join(', ') || 'none'}`,
        `- tradingViewPaperTestOnlyShortcuts: ${(snapshot.shortcutPolicy?.paperTestOnlyIds || []).join(', ') || 'none'}`
      ]
      : []),
    ...(snapshot.userPolicy?.hasActionPolicies || snapshot.userPolicy?.hasNegativePolicies
      ? [`- userPolicyOverride: actionPolicies=${snapshot.userPolicy?.hasActionPolicies ? 'yes' : 'no'}, negativePolicies=${snapshot.userPolicy?.hasNegativePolicies ? 'yes' : 'no'}`]
      : []),
    ...((snapshot.guidance?.directives || []).map((line) => `- directive: ${line}`)),
    ...((snapshot.guidance?.responseShape || []).map((line) => `- answer-shape: ${line}`))
  ];

  return lines.join('\n');
}

module.exports = {
  SURFACE_CLASSES,
  buildCapabilityPolicySnapshot,
  buildCapabilityPolicySystemMessage,
  classifyActiveAppCapability,
  isScreenLikeCaptureMode,
  normalizeForegroundWindow
};