#!/usr/bin/env node

const path = require('path');

const {
  detectTradingViewLaunchProfile,
  summarizeTradingViewLaunchProfile
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'launch-profile.js'));
const {
  detectTradingViewLaunchCapability,
  summarizeTradingViewLaunchCapability,
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'launch-capability.js'));
const {
  resolveTradingViewAutomationLaunchContract,
  summarizeTradingViewAutomationLaunchContract,
  buildTradingViewAutomationLaunchPreconditionMessage
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'launch-contract.js'));

async function main() {
  const [launchProfile, launchCapability] = await Promise.all([
    detectTradingViewLaunchProfile(),
    detectTradingViewLaunchCapability()
  ]);
  const launchContract = resolveTradingViewAutomationLaunchContract();

  const summarizedLaunchProfile = summarizeTradingViewLaunchProfile(launchProfile);
  const summarizedLaunchCapability = summarizeTradingViewLaunchCapability(launchCapability);
  const summarizedLaunchContract = summarizeTradingViewAutomationLaunchContract(launchContract);

  const payload = {
    launchProfile: summarizedLaunchProfile,
    launchCapability: summarizedLaunchCapability,
    launchContract: summarizedLaunchContract,
    pineEditorPreconditionMessage: buildTradingViewAutomationLaunchPreconditionMessage({
      scenarioId: 'pine-editor',
      launchProfile: summarizedLaunchProfile,
      launchCapability: summarizedLaunchCapability,
      launchContract: summarizedLaunchContract
    })
  };

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
