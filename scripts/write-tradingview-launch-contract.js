#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const {
  buildTradingViewAutomationWrapperContractPreset
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'launch-contract-presets.js'));

function getArgValue(flagName) {
  const index = process.argv.indexOf(flagName);
  if (index >= 0 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return null;
}

function hasFlag(flagName) {
  return process.argv.includes(flagName);
}

function printUsage() {
  console.log(`Write a local TradingView automation launch contract

Usage:
  node scripts/write-tradingview-launch-contract.js [options]

Options:
  --out <path>               Output contract path
                             Default: artifacts/tmp/tradingview-automation-launch-contract.local.json
  --cdp-port <port>          Expected CDP port (default: 9222)
  --close-timeout-ms <ms>    Graceful close timeout (default: 10000)
  --launch-settle-ms <ms>    Launch settle delay after Start-Process (default: 750)
  --executable-path <path>   Explicit TradingView executable/build to launch
  --app-user-model-id <id>   Explicit packaged TradingView AppUserModelId to activate
  --allow-force-kill         Allow the wrapper to force-kill TradingView if graceful close times out
  --display-name <name>      Override contract display name
  --help                     Show this help text
`);
}

function main() {
  if (hasFlag('--help')) {
    printUsage();
    return 0;
  }

  const outPath = path.resolve(
    process.cwd(),
    getArgValue('--out') || path.join('artifacts', 'tmp', 'tradingview-automation-launch-contract.local.json')
  );
  const executablePath = getArgValue('--executable-path') || '';
  const appUserModelId = getArgValue('--app-user-model-id') || '';

  const contract = buildTradingViewAutomationWrapperContractPreset({
    repoRoot: path.resolve(__dirname, '..'),
    cdpPort: getArgValue('--cdp-port') || 9222,
    closeTimeoutMs: getArgValue('--close-timeout-ms') || 10000,
    launchSettleMs: getArgValue('--launch-settle-ms') || 750,
    executablePath,
    appUserModelId,
    allowForceKillExisting: hasFlag('--allow-force-kill'),
    displayName: getArgValue('--display-name') || ''
  });
  const executableFlagIndex = contract.args.indexOf('-ExecutablePath');
  const resolvedExecutablePath = executableFlagIndex >= 0 ? contract.args[executableFlagIndex + 1] || '' : '';
  const appUserModelIdFlagIndex = contract.args.indexOf('-AppUserModelId');
  const resolvedAppUserModelId = appUserModelIdFlagIndex >= 0 ? contract.args[appUserModelIdFlagIndex + 1] || '' : '';

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(contract, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({
    filePath: outPath,
    displayName: contract.displayName,
    command: contract.command,
    args: contract.args,
    expected: contract.expected,
    executablePath: resolvedExecutablePath || executablePath,
    appUserModelId: resolvedAppUserModelId || appUserModelId,
    nextEnv: {
      LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_CONTRACT_FILE: outPath
    }
  }, null, 2));

  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
