#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveTradingViewAutomationLaunchContract,
  summarizeTradingViewAutomationLaunchContract,
  buildTradingViewAutomationLaunchPreconditionMessage
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'launch-contract.js'));
const {
  buildTradingViewAutomationWrapperContractPreset
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'launch-contract-presets.js'));

const forcedExitTimer = setTimeout(() => {
  console.error('FAIL test-tradingview-launch-contract timed out');
  process.exit(1);
}, 30000);
if (typeof forcedExitTimer.unref === 'function') {
  forcedExitTimer.unref();
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
  }
}

test('resolveTradingViewAutomationLaunchContract reports not-configured when no contract env is present', () => {
  const contract = resolveTradingViewAutomationLaunchContract({
    env: {},
    cwd: process.cwd()
  });

  assert.strictEqual(contract.status, 'not-configured');
  assert.strictEqual(contract.configured, false);
  assert.strictEqual(contract.valid, false);
  assert(/no explicit tradingview automation launcher\/wrapper contract is configured/i.test(String(contract.likelyMeaning || '')));
});

test('resolveTradingViewAutomationLaunchContract accepts explicit env-field command contracts', () => {
  const contract = resolveTradingViewAutomationLaunchContract({
    env: {
      LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_COMMAND: 'powershell.exe',
      LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_ARGS: '["-NoProfile","-ExecutionPolicy","Bypass","-File","C:\\\\tools\\\\launch-tv.ps1"]',
      LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_CDP_PORT: '9333',
      LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_PROCESS_NAMES: 'TradingView,TradingView.exe'
    },
    cwd: process.cwd()
  });

  assert.strictEqual(contract.status, 'configured');
  assert.strictEqual(contract.configured, true);
  assert.strictEqual(contract.expected.cdpPort, 9333);
  assert.strictEqual(contract.expected.rendererAccessibility, true);
  assert.deepStrictEqual(contract.expected.processNames, ['TradingView', 'TradingView.exe']);
  assert(/powershell\.exe/i.test(String(contract.invocationPreview || '')));

  const summary = summarizeTradingViewAutomationLaunchContract(contract);
  assert(summary, 'expected contract summary');
  assert.strictEqual(summary.status, 'configured');
  assert.strictEqual(summary.expected.cdpPort, 9333);
});

test('resolveTradingViewAutomationLaunchContract fails closed on invalid args env', () => {
  const contract = resolveTradingViewAutomationLaunchContract({
    env: {
      LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_COMMAND: 'powershell.exe',
      LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_ARGS: '-NoProfile -File launch-tv.ps1'
    },
    cwd: process.cwd()
  });

  assert.strictEqual(contract.status, 'invalid');
  assert(/json array/i.test(String(contract.error || '')));
});

test('resolveTradingViewAutomationLaunchContract validates contract files and relative wrapper paths', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-tv-launch-contract-'));
  const wrapperPath = path.join(tempDir, 'launch-tv.cmd');
  const contractPath = path.join(tempDir, 'launch-contract.json');
  fs.writeFileSync(wrapperPath, '@echo off\r\nexit /b 0\r\n', 'utf8');
  fs.writeFileSync(contractPath, JSON.stringify({
    kind: 'command',
    displayName: 'Local TradingView wrapper',
    command: '.\\launch-tv.cmd',
    args: ['--remote-debugging-port=9222', '--force-renderer-accessibility'],
    workdir: tempDir,
    expected: {
      cdpPort: 9222,
      rendererAccessibility: true,
      processNames: ['TradingView.exe']
    }
  }, null, 2), 'utf8');

  const contract = resolveTradingViewAutomationLaunchContract({
    env: {
      LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_CONTRACT_FILE: contractPath
    },
    cwd: process.cwd()
  });

  assert.strictEqual(contract.status, 'configured');
  assert.strictEqual(contract.displayName, 'Local TradingView wrapper');
  assert.strictEqual(contract.resolvedCommand, wrapperPath);
  assert.strictEqual(contract.resolvedWorkdir, tempDir);
  assert(contract.warnings.some((warning) => /loaded from/i.test(String(warning || ''))));
});

test('buildTradingViewAutomationLaunchPreconditionMessage prioritizes configured contracts over install-only capability guidance', () => {
  const contract = resolveTradingViewAutomationLaunchContract({
    env: {
      LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_COMMAND: 'powershell.exe',
      LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_ARGS: '["-File","launch-tv.ps1"]'
    },
    cwd: process.cwd()
  });

  const message = buildTradingViewAutomationLaunchPreconditionMessage({
    scenarioId: 'pine-editor',
    launchProfile: {
      likelyMeaning: 'TradingView is running in the normal interactive launch profile. No process command line exposes --remote-debugging-port, so Pine renderer proof is unavailable.'
    },
    launchCapability: {
      likelyMeaning: 'This TradingView install exposes a packaged AppID launch target that the automation wrapper can use for an automation-ready relaunch with remote debugging and renderer accessibility.'
    },
    launchContract: contract
  });

  assert(/pine-editor requires an automation-ready tradingview launch profile/i.test(message));
  assert(/configured and expects cdp port 9222/i.test(message));
  assert(!/no explicit tradingview automation launcher\/wrapper contract is configured/i.test(message));
  assert(!/shell\/appid launch target/i.test(message));
});

test('buildTradingViewAutomationWrapperContractPreset emits a graceful restart wrapper contract by default', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const contract = buildTradingViewAutomationWrapperContractPreset({
    repoRoot,
    cdpPort: 9444,
    closeTimeoutMs: 12000,
    launchSettleMs: 1000
  });

  assert.strictEqual(contract.kind, 'command');
  assert.strictEqual(contract.workdir, repoRoot);
  assert.strictEqual(contract.command, path.join(repoRoot, 'scripts', 'launch-tradingview-automation.ps1'));
  assert.deepStrictEqual(contract.expected, {
    cdpPort: 9444,
    rendererAccessibility: true,
    processNames: ['TradingView', 'TradingView.exe']
  });
  assert(contract.args.includes('-ForceRendererAccessibility'));
  assert(contract.args.includes('-CloseTimeoutMs'));
  assert(contract.args.includes('12000'));
  assert(!contract.args.includes('-AllowForceKillExisting'));
  assert(!contract.args.includes('-ExecutablePath'));
  assert(!contract.args.includes('-AppUserModelId'));
});

test('buildTradingViewAutomationWrapperContractPreset can target an explicit executable and opt into force-kill', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const executablePath = path.join(repoRoot, 'tmp', 'TradingView.exe');
  const contract = buildTradingViewAutomationWrapperContractPreset({
    repoRoot,
    cwd: repoRoot,
    executablePath: '.\\tmp\\TradingView.exe',
    allowForceKillExisting: true
  });

  assert(contract.args.includes('-AllowForceKillExisting'));
  const executableFlagIndex = contract.args.indexOf('-ExecutablePath');
  assert(executableFlagIndex >= 0, 'expected -ExecutablePath to be emitted');
  assert.strictEqual(contract.args[executableFlagIndex + 1], executablePath);
  assert(/force-kill/i.test(contract.displayName));
});

test('buildTradingViewAutomationWrapperContractPreset can pin a packaged AppUserModelId', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const contract = buildTradingViewAutomationWrapperContractPreset({
    repoRoot,
    appUserModelId: 'TradingView.Desktop_n534cwy3pjxzj!TradingView.Desktop'
  });

  const appUserModelIdFlagIndex = contract.args.indexOf('-AppUserModelId');
  assert(appUserModelIdFlagIndex >= 0, 'expected -AppUserModelId to be emitted');
  assert.strictEqual(contract.args[appUserModelIdFlagIndex + 1], 'TradingView.Desktop_n534cwy3pjxzj!TradingView.Desktop');
  assert(!contract.args.includes('-ExecutablePath'));
});

clearTimeout(forcedExitTimer);
console.log(`\nTradingView launch-contract tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
