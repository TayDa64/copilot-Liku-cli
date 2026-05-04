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

module.exports = {
  TRADINGVIEW_TOOL_NAME,
  TRADINGVIEW_TOOL_PRIORITY,
  registerTradingViewTool,
  createTradingViewSystemContractProvider,
  registerTradingViewSystemContracts,
  createTradingViewObservationProvider,
  registerTradingViewObservationProvider,
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
