function mergeAction(baseAction, overrides) {
  if (!overrides || typeof overrides !== 'object') return baseAction;
  return {
    ...baseAction,
    ...overrides,
    verify: overrides.verify === undefined ? baseAction.verify : overrides.verify,
    verifyTarget: overrides.verifyTarget === undefined ? baseAction.verifyTarget : overrides.verifyTarget,
    tradingViewShortcut: overrides.tradingViewShortcut === undefined ? baseAction.tradingViewShortcut : overrides.tradingViewShortcut,
    searchSurfaceContract: overrides.searchSurfaceContract === undefined ? baseAction.searchSurfaceContract : overrides.searchSurfaceContract
  };
}

function buildSearchSurfaceSelectionContract(config = {}) {
  const actions = Array.isArray(config.prefixActions) ? [...config.prefixActions] : [];
  const metadata = config.metadata && typeof config.metadata === 'object'
    ? { ...config.metadata }
    : null;

  if (config.openerAction) {
    actions.push(mergeAction(config.openerAction, metadata ? { searchSurfaceContract: metadata } : null));
  }

  if (Number.isFinite(Number(config.openerWaitMs))) {
    actions.push({ type: 'wait', ms: Number(config.openerWaitMs) });
  }

  if (String(config.query || '').trim()) {
    actions.push(mergeAction({
      type: 'type',
      text: String(config.query).trim(),
      reason: config.queryReason || `Type ${String(config.query).trim()} into the active search surface`,
      searchSurfaceContract: metadata
    }, config.queryActionOverrides));
  }

  if (Number.isFinite(Number(config.queryWaitMs))) {
    actions.push({ type: 'wait', ms: Number(config.queryWaitMs) });
  }

  if (String(config.selectionText || '').trim()) {
    actions.push(mergeAction({
      type: 'click_element',
      text: String(config.selectionText).trim(),
      exact: config.selectionExact === true,
      controlType: config.selectionControlType || '',
      reason: config.selectionReason || `Select ${String(config.selectionText).trim()} from the visible search results`,
      verify: config.selectionVerify,
      verifyTarget: config.selectionVerifyTarget,
      searchSurfaceContract: metadata
    }, config.selectionActionOverrides));
  }

  if (Number.isFinite(Number(config.selectionWaitMs))) {
    actions.push({ type: 'wait', ms: Number(config.selectionWaitMs) });
  }

  return actions;
}

module.exports = {
  buildSearchSurfaceSelectionContract
};