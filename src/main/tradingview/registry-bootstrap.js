const {
  detectTradingViewDomainActionRisk
} = require('../tools/tradingview-tool');
const {
  applyTradingViewReliabilityRewrites
} = require('./rewrite-runner');

function registerTradingViewRegistryBootstrap(deps = {}) {
  const {
    registerToolRewrites,
    registerToolRiskAssessor
  } = deps;

  if (typeof registerToolRewrites !== 'function') {
    throw new Error('registerTradingViewRegistryBootstrap requires registerToolRewrites');
  }
  if (typeof registerToolRiskAssessor !== 'function') {
    throw new Error('registerTradingViewRegistryBootstrap requires registerToolRiskAssessor');
  }

  const rewriteEntry = registerToolRewrites('tradingview', applyTradingViewReliabilityRewrites, -1);
  const riskEntry = registerToolRiskAssessor('tradingview', ({ riskTextToCheck, ActionRiskLevel, action }) => (
    detectTradingViewDomainActionRisk(riskTextToCheck, ActionRiskLevel, {
      actionType: action?.type
    })
  ), -1);

  return {
    rewriteEntry,
    riskEntry
  };
}

module.exports = {
  registerTradingViewRegistryBootstrap
};
