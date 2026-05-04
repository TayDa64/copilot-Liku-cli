const {
  registerTradingViewTool
} = require('../tools/tradingview-tool');

function registerTradingViewRegistryBootstrap(deps = {}) {
  return registerTradingViewTool(deps);
}

module.exports = {
  registerTradingViewRegistryBootstrap
};
