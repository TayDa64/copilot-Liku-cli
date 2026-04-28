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

module.exports = {
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
