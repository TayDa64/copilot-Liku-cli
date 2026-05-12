#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveTradingViewAutomationLaunchContract
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'launch-contract.js'));
const {
  buildTradingViewAutomationLaunchSpawnSpec,
  attemptTradingViewAutomationRelaunch,
  summarizeTradingViewAutomationRelaunch
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'launch-executor.js'));

const forcedExitTimer = setTimeout(() => {
  console.error('FAIL test-tradingview-launch-executor timed out');
  process.exit(1);
}, 30000);
if (typeof forcedExitTimer.unref === 'function') {
  forcedExitTimer.unref();
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
  }
}

function createTempContract(commandFileName, extension, extra = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-tv-launch-executor-'));
  const commandPath = path.join(tempDir, `${commandFileName}${extension}`);
  fs.writeFileSync(commandPath, extension === '.cmd'
    ? '@echo off\r\nexit /b 0\r\n'
    : 'Write-Output "ok"\r\n', 'utf8');

  const contract = resolveTradingViewAutomationLaunchContract({
    contract: {
      kind: 'command',
      displayName: extra.displayName || 'Local TradingView wrapper',
      command: commandPath,
      args: extra.args || ['--remote-debugging-port=9333', '--force-renderer-accessibility'],
      workdir: tempDir,
      expected: {
        cdpPort: extra.cdpPort || 9333,
        rendererAccessibility: extra.rendererAccessibility !== false,
        processNames: extra.processNames || ['TradingView.exe']
      }
    },
    cwd: process.cwd()
  });

  return { tempDir, commandPath, contract };
}

function buildInteractiveLaunchProfile(expectedPort = 9333, runningPid = 111) {
  return {
    inspectionAvailable: true,
    running: true,
    profile: 'interactive-no-cdp',
    automationReady: false,
    reason: 'remote-debugging-port-not-configured',
    likelyMeaning: 'TradingView is running in the normal interactive launch profile.',
    expectedCdpPort: expectedPort,
    effectivePort: 0,
    processCount: 1,
    runningPids: [runningPid],
    remoteDebuggingConfigured: false,
    remoteDebuggingPorts: [],
    rendererAccessibilityConfigured: false,
    listenerActive: false,
    listenerPorts: [],
    packagedExecutable: false,
    warnings: [],
    processes: [{
      pid: runningPid,
      name: 'TradingView.exe',
      mainWindowTitle: 'Interactive TradingView'
    }]
  };
}

function buildAutomationReadyLaunchProfile(expectedPort = 9333, runningPid = 222, rendererAccessibilityConfigured = true) {
  return {
    inspectionAvailable: true,
    running: true,
    profile: 'automation-ready',
    automationReady: true,
    reason: null,
    likelyMeaning: 'TradingView is running with a live remote debugging endpoint.',
    expectedCdpPort: expectedPort,
    effectivePort: expectedPort,
    processCount: 1,
    runningPids: [runningPid],
    remoteDebuggingConfigured: true,
    remoteDebuggingPorts: [expectedPort],
    rendererAccessibilityConfigured,
    listenerActive: true,
    listenerPorts: [expectedPort],
    packagedExecutable: false,
    warnings: [],
    processes: [{
      pid: runningPid,
      name: 'TradingView.exe',
      mainWindowTitle: 'Automation-ready TradingView'
    }]
  };
}

async function main() {
  await test('buildTradingViewAutomationLaunchSpawnSpec wraps .cmd contracts through cmd.exe', async () => {
    const { tempDir, commandPath, contract } = createTempContract('launch-tv', '.cmd');
    const spec = buildTradingViewAutomationLaunchSpawnSpec(contract, {
      env: { TEST_MARKER: '1' }
    });

    assert.strictEqual(spec.mode, 'cmd-wrapper');
    assert(/cmd\.exe$/i.test(String(spec.file || '')), `expected cmd.exe launcher, got ${spec.file}`);
    assert.strictEqual(spec.cwd, tempDir);
    assert.strictEqual(spec.env.TEST_MARKER, '1');
    assert.strictEqual(spec.env.LIKU_TRADINGVIEW_CDP_PORT, '9333');
    assert(spec.args[3].includes(commandPath), 'expected cmd invocation to include wrapper path');
  });

  await test('buildTradingViewAutomationLaunchSpawnSpec wraps .ps1 contracts through powershell.exe', async () => {
    const { tempDir, commandPath, contract } = createTempContract('launch-tv', '.ps1');
    const wrapperStatusFile = path.join(tempDir, 'wrapper-status.json');
    const spec = buildTradingViewAutomationLaunchSpawnSpec(contract, {
      wrapperStatusFile
    });

    assert.strictEqual(spec.mode, 'powershell-wrapper');
    assert(/powershell\.exe$/i.test(String(spec.file || '')));
    assert.strictEqual(spec.cwd, tempDir);
    assert.deepStrictEqual(spec.args.slice(0, 4), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File']);
    assert.strictEqual(spec.args[4], commandPath);
    assert(spec.args.includes('--remote-debugging-port=9333'));
    assert(spec.args.includes('--force-renderer-accessibility'));
    assert.deepStrictEqual(spec.args.slice(-2), ['-StatusFile', wrapperStatusFile]);
  });

  await test('attemptTradingViewAutomationRelaunch succeeds once the wrapper produces an automation-ready session', async () => {
    const contract = resolveTradingViewAutomationLaunchContract({
      env: {
        LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_COMMAND: 'powershell.exe',
        LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_ARGS: '["-File","launch-tv.ps1"]',
        LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_CDP_PORT: '9333',
        LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_PROCESS_NAMES: 'TradingView.exe'
      },
      cwd: process.cwd()
    });

    let currentMs = 0;
    let detectCalls = 0;
    const child = {
      pid: 9001,
      unrefCalled: false,
      unref() {
        this.unrefCalled = true;
      }
    };

    const result = await attemptTradingViewAutomationRelaunch({
      launchContract: contract,
      launchProfile: buildInteractiveLaunchProfile(9333, 111),
      timeoutMs: 5000,
      pollIntervalMs: 500,
      startupDelayMs: 0,
      now: () => currentMs,
      sleep: async (ms) => {
        currentMs += ms;
      },
      spawn: (file, args, options) => {
        assert(/powershell\.exe$/i.test(String(file || '')));
        assert(Array.isArray(args));
        assert.strictEqual(options.detached, true);
        return child;
      },
      detectTradingViewLaunchProfile: async (options = {}) => {
        detectCalls += 1;
        assert.strictEqual(options.expectedCdpPort, 9333);
        assert.deepStrictEqual(options.processNames, ['TradingView.exe']);
        return detectCalls >= 2
          ? buildAutomationReadyLaunchProfile(9333, 222, true)
          : buildInteractiveLaunchProfile(9333, 111);
      }
    });

    assert.strictEqual(child.unrefCalled, true);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, 'automation-ready');
    assert.deepStrictEqual(result.readiness.newRunningPids, [222]);
    const summary = summarizeTradingViewAutomationRelaunch(result);
    assert(summary, 'expected summarized relaunch result');
    assert.strictEqual(summary.success, true);
    assert.strictEqual(summary.launcher.pid, 9001);
    assert.strictEqual(summary.readiness.pollCount, 2);
  });

  await test('attemptTradingViewAutomationRelaunch fails closed when automation-ready is observed without renderer accessibility', async () => {
    const contract = resolveTradingViewAutomationLaunchContract({
      env: {
        LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_COMMAND: 'powershell.exe',
        LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_ARGS: '["-File","launch-tv.ps1"]',
        LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_CDP_PORT: '9222',
        LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_PROCESS_NAMES: 'TradingView.exe'
      },
      cwd: process.cwd()
    });

    let currentMs = 0;
    const result = await attemptTradingViewAutomationRelaunch({
      launchContract: contract,
      launchProfile: buildInteractiveLaunchProfile(9222, 111),
      timeoutMs: 1200,
      pollIntervalMs: 400,
      startupDelayMs: 0,
      now: () => currentMs,
      sleep: async (ms) => {
        currentMs += ms;
      },
      spawn: () => ({
        pid: 1234,
        unref() {}
      }),
      detectTradingViewLaunchProfile: async () => buildAutomationReadyLaunchProfile(9222, 222, false)
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, 'contract-mismatch');
    assert.strictEqual(result.readiness.mismatchReason, 'renderer-accessibility-not-observed');
    assert(/never matched/i.test(String(result.message || '')));
  });

  await test('attemptTradingViewAutomationRelaunch reports invalid contracts without spawning', async () => {
    const invalidContract = resolveTradingViewAutomationLaunchContract({
      env: {
        LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_COMMAND: 'powershell.exe',
        LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_ARGS: '-NoProfile -File launch-tv.ps1'
      },
      cwd: process.cwd()
    });

    let spawnCalled = false;
    const result = await attemptTradingViewAutomationRelaunch({
      launchContract: invalidContract,
      launchProfile: buildInteractiveLaunchProfile(9222, 111),
      spawn: () => {
        spawnCalled = true;
        throw new Error('spawn should not be called');
      }
    });

    assert.strictEqual(spawnCalled, false);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, 'contract-invalid');
    assert(/json array/i.test(String(result.error || '')));
  });

  await test('attemptTradingViewAutomationRelaunch reports wrapper-failed when the wrapper status file records a bounded failure', async () => {
    const contract = resolveTradingViewAutomationLaunchContract({
      env: {
        LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_COMMAND: 'powershell.exe',
        LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_ARGS: '["-File","launch-tv.ps1"]',
        LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_CDP_PORT: '9222',
        LIKU_TRADINGVIEW_AUTOMATION_LAUNCH_PROCESS_NAMES: 'TradingView.exe'
      },
      cwd: process.cwd()
    });
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-tv-launch-wrapper-status-'));
    const wrapperStatusFile = path.join(tempDir, 'wrapper-status.json');
    fs.writeFileSync(wrapperStatusFile, JSON.stringify({
      status: 'failed',
      phase: 'closing-existing',
      message: 'TradingView did not exit gracefully within the configured timeout.',
      remainingProcessIds: [111],
      updatedAt: '2026-05-10T22:15:00.000Z'
    }, null, 2), 'utf8');

    let detectCalled = false;
    const result = await attemptTradingViewAutomationRelaunch({
      launchContract: contract,
      launchProfile: buildInteractiveLaunchProfile(9222, 111),
      startupDelayMs: 0,
      wrapperStatusFile,
      spawn: () => ({
        pid: 4567,
        unref() {}
      }),
      detectTradingViewLaunchProfile: async () => {
        detectCalled = true;
        return buildInteractiveLaunchProfile(9222, 111);
      }
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, 'wrapper-failed');
    assert.strictEqual(result.readiness.pollCount, 0);
    assert.strictEqual(result.wrapperStatus.status, 'failed');
    assert.strictEqual(detectCalled, false);
    assert(/close\/restart failure/i.test(String(result.message || '')));
  });

  clearTimeout(forcedExitTimer);
  console.log(`\nTradingView launch-executor tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  clearTimeout(forcedExitTimer);
  console.error('FAIL tradingview launch-executor tests');
  console.error(error.stack || error.message);
  process.exit(1);
});
