const {
  buildOpenApplicationActions,
  buildProcessCandidatesFromAppName,
  buildTitleHintsFromAppName,
  buildVerifyTargetHintFromAppName,
  resolveNormalizedAppIdentity
} = require('../tradingview/app-profile');
const {
  detectTradingViewDomainActionRisk,
  extractTradingViewObservationKeywords,
  inferTradingViewTradingMode,
  inferTradingViewObservationSpec,
  isTradingViewTargetHint
} = require('../tradingview/verification');
const {
  maybeRewriteTradingViewIndicatorWorkflow
} = require('../tradingview/indicator-workflows');
const {
  maybeRewriteTradingViewAlertWorkflow
} = require('../tradingview/alert-workflows');
const {
  maybeRewriteTradingViewTimeframeWorkflow,
  maybeRewriteTradingViewSymbolWorkflow,
  maybeRewriteTradingViewWatchlistWorkflow
} = require('../tradingview/chart-verification');
const {
  maybeRewriteTradingViewDrawingWorkflow
} = require('../tradingview/drawing-workflows');
const {
  buildTradingViewPineResumePrerequisites,
  maybeRewriteTradingViewPineWorkflow,
  containsPineScriptPayloadText,
  sanitizePineScriptText
} = require('../tradingview/pine-workflows');
const {
  detectRequestedPineVersion,
  normalizePineScriptSource,
  buildPineScriptState,
  persistPineScriptState
} = require('../tradingview/pine-script-state');
const {
  maybeRewriteTradingViewPaperWorkflow
} = require('../tradingview/paper-workflows');
const {
  maybeRewriteTradingViewDomWorkflow
} = require('../tradingview/dom-workflows');
const {
  isTradingViewPineContextEligible
} = require('../ai-service/execution-context');

const TRADINGVIEW_TOOL_NAME = 'tradingview';
const TRADINGVIEW_TOOL_PRIORITY = -1;

function applyTradingViewReliabilityRewrites(actions, context = {}) {
  const userMessage = typeof context.userMessage === 'string' ? context.userMessage : '';
  const registerRewrite = typeof context.registerRewrite === 'function'
    ? context.registerRewrite
    : null;

  const maybeRegister = (rewriter, category, reason, beforeActions, afterActions) => {
    if (!registerRewrite) return;
    registerRewrite(rewriter, category, reason, beforeActions, afterActions);
  };

  const tradingViewTimeframeRewrite = maybeRewriteTradingViewTimeframeWorkflow(actions, { userMessage });
  if (tradingViewTimeframeRewrite) {
    maybeRegister('maybeRewriteTradingViewTimeframeWorkflow', 'tradingview-timeframe', 'matched TradingView timeframe reliability workflow', actions, tradingViewTimeframeRewrite);
    return tradingViewTimeframeRewrite;
  }

  const tradingViewSymbolRewrite = maybeRewriteTradingViewSymbolWorkflow(actions, { userMessage });
  if (tradingViewSymbolRewrite) {
    maybeRegister('maybeRewriteTradingViewSymbolWorkflow', 'tradingview-symbol', 'matched TradingView symbol reliability workflow', actions, tradingViewSymbolRewrite);
    return tradingViewSymbolRewrite;
  }

  const tradingViewWatchlistRewrite = maybeRewriteTradingViewWatchlistWorkflow(actions, { userMessage });
  if (tradingViewWatchlistRewrite) {
    maybeRegister('maybeRewriteTradingViewWatchlistWorkflow', 'tradingview-watchlist', 'matched TradingView watchlist reliability workflow', actions, tradingViewWatchlistRewrite);
    return tradingViewWatchlistRewrite;
  }

  const tradingViewDrawingRewrite = maybeRewriteTradingViewDrawingWorkflow(actions, { userMessage });
  if (tradingViewDrawingRewrite) {
    maybeRegister('maybeRewriteTradingViewDrawingWorkflow', 'tradingview-drawing', 'matched TradingView drawing reliability workflow', actions, tradingViewDrawingRewrite);
    return tradingViewDrawingRewrite;
  }

  const tradingViewPineRewrite = maybeRewriteTradingViewPineWorkflow(actions, {
    ...context,
    userMessage
  });
  if (tradingViewPineRewrite) {
    maybeRegister('maybeRewriteTradingViewPineWorkflow', 'tradingview-pine', 'matched TradingView Pine reliability workflow', actions, tradingViewPineRewrite);
    return tradingViewPineRewrite;
  }

  const tradingViewPaperRewrite = maybeRewriteTradingViewPaperWorkflow(actions, { userMessage });
  if (tradingViewPaperRewrite) {
    maybeRegister('maybeRewriteTradingViewPaperWorkflow', 'tradingview-paper', 'matched TradingView Paper Trading reliability workflow', actions, tradingViewPaperRewrite);
    return tradingViewPaperRewrite;
  }

  const tradingViewDomRewrite = maybeRewriteTradingViewDomWorkflow(actions, { userMessage });
  if (tradingViewDomRewrite) {
    maybeRegister('maybeRewriteTradingViewDomWorkflow', 'tradingview-dom', 'matched TradingView DOM reliability workflow', actions, tradingViewDomRewrite);
    return tradingViewDomRewrite;
  }

  const tradingViewIndicatorRewrite = maybeRewriteTradingViewIndicatorWorkflow(actions, { userMessage });
  if (tradingViewIndicatorRewrite) {
    maybeRegister('maybeRewriteTradingViewIndicatorWorkflow', 'tradingview-indicator', 'matched TradingView indicator reliability workflow', actions, tradingViewIndicatorRewrite);
    return tradingViewIndicatorRewrite;
  }

  const tradingViewAlertRewrite = maybeRewriteTradingViewAlertWorkflow(actions, { userMessage });
  if (tradingViewAlertRewrite) {
    maybeRegister('maybeRewriteTradingViewAlertWorkflow', 'tradingview-alert', 'matched TradingView alert reliability workflow', actions, tradingViewAlertRewrite);
    return tradingViewAlertRewrite;
  }

  return actions;
}

function assessTradingViewRisk({ riskTextToCheck, ActionRiskLevel, action } = {}) {
  return detectTradingViewDomainActionRisk(riskTextToCheck, ActionRiskLevel, {
    actionType: action?.type
  });
}

function registerTradingViewTool(deps = {}) {
  const {
    registerToolRewrites,
    registerToolRiskAssessor
  } = deps;

  if (typeof registerToolRewrites !== 'function') {
    throw new Error('registerTradingViewTool requires registerToolRewrites');
  }
  if (typeof registerToolRiskAssessor !== 'function') {
    throw new Error('registerTradingViewTool requires registerToolRiskAssessor');
  }

  const rewriteEntry = registerToolRewrites(TRADINGVIEW_TOOL_NAME, applyTradingViewReliabilityRewrites, TRADINGVIEW_TOOL_PRIORITY);
  const riskEntry = registerToolRiskAssessor(TRADINGVIEW_TOOL_NAME, assessTradingViewRisk, TRADINGVIEW_TOOL_PRIORITY);

  return {
    toolName: TRADINGVIEW_TOOL_NAME,
    priority: TRADINGVIEW_TOOL_PRIORITY,
    rewriteEntry,
    riskEntry
  };
}

function createTradingViewSystemContractProvider(deps = {}) {
  const {
    buildTradingViewPineAuthoringSystemContract
  } = deps;

  if (typeof buildTradingViewPineAuthoringSystemContract !== 'function') {
    throw new Error('createTradingViewSystemContractProvider requires buildTradingViewPineAuthoringSystemContract');
  }

  return function tradingViewSystemContractProvider(context = {}) {
    if (!isTradingViewPineContextEligible(context.executionContextEnvelope)) {
      return [];
    }

    const contract = buildTradingViewPineAuthoringSystemContract(context.userMessage);
    return contract ? [contract] : [];
  };
}

function registerTradingViewSystemContracts(deps = {}) {
  const {
    registerSystemContractProvider
  } = deps;

  if (typeof registerSystemContractProvider !== 'function') {
    throw new Error('registerTradingViewSystemContracts requires registerSystemContractProvider');
  }

  const provider = createTradingViewSystemContractProvider(deps);
  const systemContractEntry = registerSystemContractProvider(TRADINGVIEW_TOOL_NAME, provider, TRADINGVIEW_TOOL_PRIORITY);

  return {
    toolName: TRADINGVIEW_TOOL_NAME,
    priority: TRADINGVIEW_TOOL_PRIORITY,
    systemContractEntry
  };
}

function createTradingViewObservationProvider() {
  return {
    toolName: TRADINGVIEW_TOOL_NAME,
    buildVerifyTargetHint: buildVerifyTargetHintFromAppName,
    extractObservationKeywords: extractTradingViewObservationKeywords,
    inferTradingMode: inferTradingViewTradingMode,
    inferObservationSpec: inferTradingViewObservationSpec,
    isTargetHint: isTradingViewTargetHint,
    matchesContext(context = {}) {
      const haystack = [
        context.userMessage,
        context.actionData?.thought,
        context.actionData?.verification,
        context.focusRecoveryTarget?.title,
        context.focusRecoveryTarget?.processName
      ].map((value) => String(value || '')).join(' ');
      return /tradingview|trading\s+view/i.test(haystack)
        || isTradingViewTargetHint(context.verifyTarget || context.inferredTarget || null);
    }
  };
}

function normalizeTradingViewDecisionSurface(surface = '') {
  const normalized = String(surface || '').trim().toLowerCase();
  if (!normalized) return null;

  switch (normalized) {
    case 'pine-editor':
    case 'editor-active':
    case 'editor-ready':
      return 'tradingview/pine-editor';
    case 'quick-search':
    case 'input-surface-open':
      return 'tradingview/quick-search';
    case 'symbol-search':
      return 'tradingview/symbol-search';
    case 'chart':
    case 'chart-state':
      return 'tradingview/chart';
    default:
      return normalized.startsWith('tradingview/')
        ? normalized
        : `tradingview/${normalized}`;
  }
}

function summarizeTradingViewShortcut(shortcut = {}) {
  if (!shortcut || typeof shortcut !== 'object') return null;
  const id = String(shortcut.id || '').trim().toLowerCase();
  const surface = String(shortcut.surface || '').trim().toLowerCase();
  const appName = String(shortcut.appName || '').trim();
  if (!id && !surface && !appName) return null;
  return {
    id: id || null,
    surface: surface || null,
    appName: appName || null
  };
}

function summarizeTradingViewSearchSurfaceContract(contract = {}) {
  if (!contract || typeof contract !== 'object') return null;
  const id = String(contract.id || '').trim().toLowerCase();
  const route = String(contract.route || '').trim().toLowerCase();
  const surface = String(contract.surface || contract.target || '').trim().toLowerCase();
  const appName = String(contract.appName || '').trim();
  if (!id && !route && !surface && !appName) return null;
  return {
    id: id || null,
    route: route || null,
    surface: surface || null,
    appName: appName || null,
    requiresCommandSurface: contract.requiresCommandSurface === true
  };
}

function summarizeTradingViewDecisionObservation(observationCheckpoint = {}) {
  if (!observationCheckpoint || typeof observationCheckpoint !== 'object') return null;
  const verifyTarget = String(
    observationCheckpoint.verifyTarget?.target
    || observationCheckpoint.verifyTarget?.surface
    || observationCheckpoint.verifyTarget
    || ''
  ).trim().toLowerCase();
  const summary = {
    classification: String(observationCheckpoint.classification || '').trim().toLowerCase() || null,
    verifyKind: String(observationCheckpoint.verifyKind || '').trim().toLowerCase() || null,
    verifyTarget: verifyTarget || null,
    verified: observationCheckpoint.verified === true,
    matchReason: String(observationCheckpoint.matchReason || '').trim() || null,
    hostSurfaceMatched: observationCheckpoint.hostSurfaceMatched === true,
    hostSurfaceAnchor: String(observationCheckpoint.hostSurfaceAnchor || '').trim() || null,
    watcherSurfaceMatched: observationCheckpoint.watcherSurfaceMatched === true,
    watcherSurfaceAnchor: String(observationCheckpoint.watcherSurfaceAnchor || '').trim() || null,
    editorActiveMatched: observationCheckpoint.editorActiveMatched === true,
    recoveredBy: String(observationCheckpoint.recoveredBy || '').trim() || null
  };

  return Object.values(summary).some((value) => value !== null && value !== false)
    ? summary
    : null;
}

function inferTradingViewDecisionSurface(context = {}) {
  const action = context.action || {};
  const observationCheckpoint = context.observationCheckpoint || context.result?.observationCheckpoint || null;
  const shortcutId = String(action?.tradingViewShortcut?.id || '').trim().toLowerCase();
  const shortcutSurface = String(action?.tradingViewShortcut?.surface || '').trim().toLowerCase();
  const route = String(action?.searchSurfaceContract?.route || '').trim().toLowerCase();
  const contractId = String(action?.searchSurfaceContract?.id || '').trim().toLowerCase();
  const verifyTarget = String(
    action?.verify?.target
    || context.checkpointSpec?.verifyTarget
    || observationCheckpoint?.verifyTarget?.target
    || observationCheckpoint?.verifyTarget?.surface
    || observationCheckpoint?.verifyTarget
    || ''
  ).trim().toLowerCase();
  const classification = String(
    context.checkpointSpec?.classification
    || observationCheckpoint?.classification
    || ''
  ).trim().toLowerCase();

  if (verifyTarget === 'pine-editor' || classification === 'editor-active') {
    return 'tradingview/pine-editor';
  }
  if (shortcutId === 'symbol-search' || shortcutSurface === 'symbol-search') {
    return 'tradingview/symbol-search';
  }
  if (route === 'quick-search') {
    return contractId === 'open-pine-editor'
      ? 'tradingview/command-quick-search'
      : 'tradingview/quick-search';
  }
  if (String(action?.reason || '').trim() && /chart/i.test(String(action.reason))) {
    return 'tradingview/chart';
  }
  if (verifyTarget) {
    return normalizeTradingViewDecisionSurface(verifyTarget);
  }
  if (classification) {
    return normalizeTradingViewDecisionSurface(classification);
  }
  return 'tradingview/main-window';
}

function createTradingViewDecisionTraceContributor() {
  return {
    toolName: TRADINGVIEW_TOOL_NAME,
    matchesContext(context = {}) {
      const haystack = [
        context.userMessage,
        context.actionData?.thought,
        context.actionData?.verification,
        context.action?.reason,
        context.action?.verify?.target,
        context.action?.searchSurfaceContract?.appName,
        context.action?.tradingViewShortcut?.appName,
        context.focusRecoveryTarget?.title,
        context.focusRecoveryTarget?.processName,
        context.observationCheckpoint?.appName,
        context.observationCheckpoint?.verifyTarget?.target,
        context.observationCheckpoint?.verifyTarget?.surface,
        context.observationCheckpoint?.verifyTarget
      ].map((value) => String(value || '')).join(' ');

      return /tradingview|trading\s+view/i.test(haystack)
        || isTradingViewTargetHint(context.verifyTarget || context.inferredTarget || null);
    },
    enrich({ context = {} } = {}) {
      const action = context.action || {};
      const observationCheckpoint = context.observationCheckpoint || context.result?.observationCheckpoint || null;
      const shortcut = summarizeTradingViewShortcut(action.tradingViewShortcut);
      const searchSurfaceContract = summarizeTradingViewSearchSurfaceContract(action.searchSurfaceContract);
      const observation = summarizeTradingViewDecisionObservation(observationCheckpoint);
      const quickSearchRecovery = context.quickSearchRecovery || context.result?.quickSearchRecovery || null;
      const pineEditorRecovery = context.pineEditorRecovery || context.result?.pineEditorRecovery || null;
      const domainData = {};

      if (shortcut) domainData.shortcut = shortcut;
      if (searchSurfaceContract) domainData.searchSurfaceContract = searchSurfaceContract;
      if (observation) domainData.observation = observation;
      if (quickSearchRecovery) domainData.quickSearchRecovery = quickSearchRecovery;
      if (pineEditorRecovery) domainData.pineEditorRecovery = pineEditorRecovery;

      return {
        domain: 'tradingview',
        expectedSurface: inferTradingViewDecisionSurface(context),
        domainData: Object.keys(domainData).length
          ? { tradingview: domainData }
          : null,
        tags: [
          'tradingview',
          inferTradingViewDecisionSurface(context)
        ]
      };
    }
  };
}

function registerTradingViewObservationProvider(deps = {}) {
  const {
    registerObservationProvider
  } = deps;

  if (typeof registerObservationProvider !== 'function') {
    throw new Error('registerTradingViewObservationProvider requires registerObservationProvider');
  }

  const provider = createTradingViewObservationProvider();
  const observationProviderEntry = registerObservationProvider(TRADINGVIEW_TOOL_NAME, provider, TRADINGVIEW_TOOL_PRIORITY);

  return {
    toolName: TRADINGVIEW_TOOL_NAME,
    priority: TRADINGVIEW_TOOL_PRIORITY,
    observationProviderEntry
  };
}

function registerTradingViewDecisionTraceContributor(deps = {}) {
  const {
    registerDecisionTraceContributor
  } = deps;

  if (typeof registerDecisionTraceContributor !== 'function') {
    throw new Error('registerTradingViewDecisionTraceContributor requires registerDecisionTraceContributor');
  }

  const contributor = createTradingViewDecisionTraceContributor();
  const decisionTraceContributorEntry = registerDecisionTraceContributor(TRADINGVIEW_TOOL_NAME, contributor, TRADINGVIEW_TOOL_PRIORITY);

  return {
    toolName: TRADINGVIEW_TOOL_NAME,
    priority: TRADINGVIEW_TOOL_PRIORITY,
    decisionTraceContributorEntry
  };
}

function registerTradingViewPineLifecycleHooks(deps = {}) {
  const {
    registerLifecycleHooks,
    lifecycleHooks
  } = deps;

  if (typeof registerLifecycleHooks !== 'function') {
    throw new Error('registerTradingViewPineLifecycleHooks requires registerLifecycleHooks');
  }
  if (!lifecycleHooks || typeof lifecycleHooks !== 'object') {
    throw new Error('registerTradingViewPineLifecycleHooks requires lifecycleHooks');
  }

  const lifecycleHookEntry = registerLifecycleHooks(TRADINGVIEW_TOOL_NAME, lifecycleHooks, TRADINGVIEW_TOOL_PRIORITY);

  return {
    toolName: TRADINGVIEW_TOOL_NAME,
    priority: TRADINGVIEW_TOOL_PRIORITY,
    lifecycleHookEntry
  };
}

module.exports = {
  TRADINGVIEW_TOOL_NAME,
  TRADINGVIEW_TOOL_PRIORITY,
  registerTradingViewTool,
  createTradingViewSystemContractProvider,
  registerTradingViewSystemContracts,
  createTradingViewObservationProvider,
  registerTradingViewObservationProvider,
  createTradingViewDecisionTraceContributor,
  registerTradingViewDecisionTraceContributor,
  registerTradingViewPineLifecycleHooks,
  applyTradingViewReliabilityRewrites,
  assessTradingViewRisk,
  buildOpenApplicationActions,
  buildProcessCandidatesFromAppName,
  buildTitleHintsFromAppName,
  buildVerifyTargetHintFromAppName,
  resolveNormalizedAppIdentity,
  detectTradingViewDomainActionRisk,
  extractTradingViewObservationKeywords,
  inferTradingViewTradingMode,
  inferTradingViewObservationSpec,
  isTradingViewTargetHint,
  maybeRewriteTradingViewIndicatorWorkflow,
  maybeRewriteTradingViewAlertWorkflow,
  maybeRewriteTradingViewTimeframeWorkflow,
  maybeRewriteTradingViewSymbolWorkflow,
  maybeRewriteTradingViewWatchlistWorkflow,
  maybeRewriteTradingViewDrawingWorkflow,
  buildTradingViewPineResumePrerequisites,
  maybeRewriteTradingViewPineWorkflow,
  containsPineScriptPayloadText,
  sanitizePineScriptText,
  detectRequestedPineVersion,
  normalizePineScriptSource,
  buildPineScriptState,
  persistPineScriptState,
  maybeRewriteTradingViewPaperWorkflow,
  maybeRewriteTradingViewDomWorkflow
};
